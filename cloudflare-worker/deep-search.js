import {
  GEMINI_URL,
  jsonResponse,
  cleanText,
  normalizeUsername,
  isAllowedUser,
  gateCall,
  parseEventDate,
  extractGeminiText,
  sha256
} from "./shared.js";
import { createSourcePreviews } from "./source-preview.js";

const DEEP_SEARCH_MAX_QUERIES = 24;
const DEEP_SEARCH_RESULTS_PER_QUERY = 30;
const DEEP_SEARCH_MAX_EVIDENCE = 48;
const DEEP_SEARCH_CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const DEEP_SEARCH_MODEL = "gemini-3.5-flash-lite";
export const DEEP_SEARCH_VERSION = "deep-search-v7-source-previews";

// There is no period selector any more -- the analyst's own question is the
// only source of a time window. The planner LLM (see PLAN_SCHEMA's
// detected_period below) reads the question and decides one of three modes:
// "global" (no period stated -- search as far back as the sources below can
// usefully go), "relative" (a duration like "last 3 months"), or "absolute"
// (a specific past range like "in 2019" or "since January 2023").
// GDELT's real-time monitoring is only reliably dense from around this date;
// earlier coverage exists but thins out, so "global" mode uses this as its
// practical historical floor rather than an arbitrary/unbounded one.
const GDELT_ARCHIVE_START = new Date("2017-01-01T00:00:00Z");
// Fallback when the planner's detected_period is missing or malformed.
const DEEP_SEARCH_DEFAULT_RELATIVE_DAYS = 90;
// Safety cap on any single absolute/relative window, so a malformed or
// adversarial date pair from the planner can never blow up chunk math.
const DEEP_SEARCH_MAX_WINDOW_DAYS = 3650;

function isoDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function clampDate(date, minDate, maxDate) {
  if (date.getTime() < minDate.getTime()) return minDate;
  if (date.getTime() > maxDate.getTime()) return maxDate;
  return date;
}

// Pure function turning the planner's detected_period into a concrete
// {mode, startDt, endDt, label} search window every downstream fetcher
// (Google/ACLED after:/before:, GDELT startdatetime/enddatetime, the CT
// Atlas comparison cutoff) uses as its single source of truth.
function resolveSearchWindow(plan, now = new Date()) {
  const detected = plan?.detected_period && typeof plan.detected_period === "object" ? plan.detected_period : {};
  const mode = ["global", "relative", "absolute"].includes(detected.mode) ? detected.mode : "relative";
  const label = cleanText(detected.explanation, 200);

  if (mode === "global") {
    return { mode: "global", startDt: GDELT_ARCHIVE_START, endDt: now,
      label: label || "Global search -- no period stated, searched as far back as available sources go" };
  }

  if (mode === "absolute") {
    const start = new Date(detected.start_date);
    const endRaw = detected.end_date ? new Date(detected.end_date) : now;
    if (!Number.isNaN(start.getTime())) {
      const endDt = Number.isNaN(endRaw.getTime()) ? now : clampDate(endRaw, start, now);
      const minStart = new Date(endDt.getTime() - DEEP_SEARCH_MAX_WINDOW_DAYS * 86400000);
      const startDt = clampDate(start, minStart, endDt);
      return { mode: "absolute", startDt, endDt,
        label: label || `${isoDateOnly(startDt)} to ${isoDateOnly(endDt)}` };
    }
    // Malformed dates from the planner: fall through to the relative default below.
  }

  const days = Math.min(DEEP_SEARCH_MAX_WINDOW_DAYS, Math.max(1, Math.round(Number(detected.relative_days)) || DEEP_SEARCH_DEFAULT_RELATIVE_DAYS));
  return { mode: "relative", startDt: new Date(now.getTime() - days * 86400000), endDt: now,
    label: label || `Last ${days} days` };
}

function windowSpanDays(window) {
  return Math.max(1, Math.round((window.endDt.getTime() - window.startDt.getTime()) / 86400000));
}

// A zero-result report can mean two very different things: genuinely no
// open-source coverage exists, or every single search request was rejected
// by a provider (Google News/GDELT rate-limiting or blocking Cloudflare's
// shared egress IPs, a known transient condition -- see the v5.12/v5.19
// incidents). Telling these apart matters: the first is a real finding, the
// second is not evidence of anything and should never be read as "no
// coverage exists".
function isLikelyTransientFetchIssue(waves) {
  return waves.length > 0 && waves.every(wave => !wave.ok);
}

// Used to re-query a sparse priority language through Google News' broader
// US-hosted edition instead of its own country/language edition -- these can
// carry different indexes even for the same native-script query text. This
// is a genuine no-op for English itself, since LANGUAGE_LOCALES.en already
// IS en-US/US/US:en: the "rescue" would just resend the identical request.
// English gets its own distinct fallback (the UK edition) so a sparse or
// transiently-failed English wave still has a real second, different query
// to fall back on instead of silently retrying nothing.
const SEARCH_FALLBACK_LOCALE = Object.freeze({ hl: "en-US", gl: "US", ceid: "US:en" });
const ENGLISH_SEARCH_FALLBACK_LOCALE = Object.freeze({ hl: "en-GB", gl: "GB", ceid: "GB:en" });
const GDELT_DOC_URL = "https://api.gdeltproject.org/api/v2/doc/doc";
// GDELT's own 429 response states its limit explicitly: "one [request] every
// 5 seconds". A previous version queried GDELT once PER language, in
// concurrent batches of 3 with only a 250ms pause between batches -- multiple
// simultaneous requests, several times faster than GDELT's stated minimum
// interval, so it reliably 429'd on almost every attempt (confirmed directly
// against the live API, independent of Cloudflare's own egress IPs). GDELT is
// now queried exactly ONCE per Deep Search, with no per-language sourcelang
// filter, and the response is split back into a virtual per-language wave
// using each article's own reported language (see
// GDELT_LANGUAGE_NAME_TO_CODE / splitGdeltRowsByLanguage below) so every
// downstream consumer (diagnostics, evidence building) still sees one wave
// per language, unaware that only a single real fetch produced them all.
// Raised from 75 to GDELT's documented per-query ceiling: a single
// "timespan=365d" query only ever returns its top N results across the
// WHOLE window, so a low cap was quietly starving long-period questions.
// See gdeltChunkRanges() below for how long periods now also get split into
// several date-range queries instead of one query straining to cover a year.
const GDELT_GLOBAL_RESULTS_CAP = 250;
// Long periods (e.g. 365 or 730 days) get split into this many sequential
// date-range GDELT queries instead of one "timespan=Nd" query -- GDELT
// caps each query's results regardless of window length, so one query for
// a whole year (or two) only ever surfaces its top ~250 hits across the
// entire window. Capped at 5 (not more) to keep the added latency (each
// chunk needs GDELT's own ~5s spacing) and Cloudflare subrequest budget
// bounded -- see MAX_SEARCH_SUBREQUESTS below.
const GDELT_MAX_CHUNKS = 5;
const GDELT_CHUNK_THRESHOLD_DAYS = 90;
const GDELT_CHUNK_SPACING_MS = 6000;
const GDELT_LANGUAGE_FILTERS = Object.freeze({
  en: "english", fr: "french", ar: "arabic", de: "german",
  es: "spanish", it: "italian", tr: "turkish", ru: "russian",
  fa: "persian", ur: "urdu", he: "hebrew", ps: "pashto"
});
const GDELT_LANGUAGE_NAME_TO_CODE = Object.freeze(
  Object.fromEntries(Object.entries(GDELT_LANGUAGE_FILTERS).map(([code, name]) => [name, code]))
);

// ACLED (Armed Conflict Location & Event Data Project) is added as one MORE
// evidence source, not a replacement for anything above. ACLED's own
// event-level data API requires a paid licence CT Atlas does not hold
// (confirmed directly against the live API: valid authentication, but
// /api/acled/read returns 403 "Access denied" -- an account/licensing
// restriction, not a code issue), so this instead surfaces ACLED's own public
// reporting the same way collector.py already does for the main map: via a
// single Google News query restricted to acleddata.com, once per Deep Search
// (ACLED publishes in English regardless of the requested geography, so one
// English-anchored query covers it -- no need to repeat per language).
const ACLED_SITE_FILTER = "site:acleddata.com";

function acledNewsUrl(query, window) {
  const bufferedEnd = new Date(window.endDt.getTime() + 86400000);
  const term = `${cleanText(query, 200)} ${ACLED_SITE_FILTER} after:${isoDateOnly(window.startDt)} before:${isoDateOnly(bufferedEnd)}`;
  return "https://news.google.com/rss/search?" + new URLSearchParams({
    q: term, hl: "en-US", gl: "US", ceid: "US:en"
  }).toString();
}

async function fetchAcledWave(query, window) {
  const item = { language: "en", query, variant: "acled", engine: "acled" };
  try {
    const response = await fetch(acledNewsUrl(query, window), {
      headers: { "User-Agent": "Mozilla/5.0 CT-Atlas-Deep-Search/5.0" },
      cf: { cacheTtl: 300, cacheEverything: true },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) return { query: item, ok: false, status: response.status, rows: [] };
    const xml = await response.text();
    if (!/<rss[\s>]/i.test(xml) || !/<channel[\s>]/i.test(xml)) {
      return { query: item, ok: false, status: response.status, error: "Search provider returned non-RSS content", rows: [] };
    }
    const rows = parseRss(xml, item, -2, false).map(row => ({ ...row, search_engine: "acled" }));
    return { query: item, ok: true, status: response.status, rows };
  } catch (error) {
    return { query: item, ok: false, status: 0, error: cleanText(error?.message, 180), rows: [] };
  }
}

// Bing News search (bing.com/news/search?format=rss) is added as a rescue
// channel alongside Google's own native-locale rescue, triggered by the
// SAME sparsity condition -- so on a normal day where Google News works
// fine, this costs nothing. It exists specifically for the case seen live in
// production: Google News rejecting every single request from Cloudflare's
// shared egress IPs (HTTP 503) while working normally from any other
// network -- Bing is a genuinely independent path, unaffected by that.
// Unlike Google (`when:Nd`) or GDELT (`timespan`/date-range), Bing's RSS
// search has no documented arbitrary historical-range parameter -- it
// reflects current/recent coverage regardless of the requested period, so
// it helps most for recent questions and cannot substitute for GDELT on a
// genuinely old (e.g. one-year-old) question.
// Bing's own RSS response states its results may only be used "for
// personal, non-commercial" purposes -- flagged explicitly to the site
// owner, who confirmed proceeding anyway for this internal analytical tool.
const BING_NEWS_SEARCH_URL = "https://www.bing.com/news/search";
const BING_MARKET_BY_LANGUAGE = Object.freeze({
  en: "en-US", fr: "fr-FR", ar: "ar-SA", de: "de-DE", es: "es-ES", it: "it-IT",
  tr: "tr-TR", ru: "ru-RU", fa: "fa-IR", ur: "ur-PK", he: "he-IL", ps: "ps-AF"
});
const BING_RESCUE_SPACING_MS = 400;

function bingNewsUrl(query, language) {
  const market = BING_MARKET_BY_LANGUAGE[language] || "en-US";
  return BING_NEWS_SEARCH_URL + "?" + new URLSearchParams({
    q: cleanText(query, 200), format: "rss", mkt: market
  }).toString();
}

// Bing's RSS <link> is a tracking redirect (bing.com/news/apiclick.aspx?...
// &url=<encoded real article URL>&...); extract the real URL so citations
// and dedup work against the actual source, not a Bing redirect link.
function extractBingRealUrl(bingLink) {
  try {
    const real = new URL(bingLink).searchParams.get("url");
    return real ? decodeURIComponent(real) : bingLink;
  } catch (_) {
    return bingLink;
  }
}

function parseBingRss(xml, language, query) {
  const items = String(xml || "").match(/<item\b[\s\S]*?<\/item>/gi) || [];
  const rows = [];
  for (const item of items.slice(0, DEEP_SEARCH_RESULTS_PER_QUERY)) {
    const title = cleanText(tagValue(item, "title"), 500);
    const url = cleanText(extractBingRealUrl(tagValue(item, "link")), 1200);
    if (!title || !url) continue;
    const summary = stripHtml(tagValue(item, "description"));
    const sourceMatch = item.match(/<News:Source>([\s\S]*?)<\/News:Source>/i);
    const source = cleanText(sourceMatch ? decodeXml(sourceMatch[1]) : "", 140);
    const publishedRaw = cleanText(tagValue(item, "pubDate"), 100);
    const publishedDate = publishedRaw ? new Date(publishedRaw) : null;
    rows.push({
      title, summary, source: source || "Bing News source", url,
      published: publishedDate && !Number.isNaN(publishedDate.getTime()) ? publishedDate.toISOString() : "",
      language, query_index: -3, query_variant: "bing-rescue", search_query: query,
      search_engine: "bing", fallback_locale: false
    });
  }
  return rows;
}

async function fetchBingWave(query, language) {
  const item = { language, query, variant: "bing-rescue", engine: "bing" };
  try {
    const response = await fetch(bingNewsUrl(query, language), {
      headers: { "User-Agent": "Mozilla/5.0 CT-Atlas-Deep-Search/5.0" },
      cf: { cacheTtl: 300, cacheEverything: true },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) return { query: item, ok: false, status: response.status, rows: [] };
    const xml = await response.text();
    if (!/<rss[\s>]/i.test(xml) || !/<channel[\s>]/i.test(xml)) {
      return { query: item, ok: false, status: response.status, error: "Search provider returned non-RSS content", rows: [] };
    }
    return { query: item, ok: true, status: response.status, rows: parseBingRss(xml, language, query) };
  } catch (error) {
    return { query: item, ok: false, status: 0, error: cleanText(error?.message, 180), rows: [] };
  }
}

const LANGUAGE_LOCALES = Object.freeze({
  en: { label: "English", hl: "en-US", gl: "US", ceid: "US:en" },
  fr: { label: "French", hl: "fr", gl: "FR", ceid: "FR:fr" },
  ar: { label: "Arabic", hl: "ar", gl: "SA", ceid: "SA:ar" },
  de: { label: "German", hl: "de", gl: "DE", ceid: "DE:de" },
  es: { label: "Spanish", hl: "es", gl: "ES", ceid: "ES:es" },
  it: { label: "Italian", hl: "it", gl: "IT", ceid: "IT:it" },
  tr: { label: "Turkish", hl: "tr", gl: "TR", ceid: "TR:tr" },
  ru: { label: "Russian", hl: "ru", gl: "RU", ceid: "RU:ru" },
  fa: { label: "Dari / Persian", hl: "fa", gl: "AF", ceid: "AF:fa" },
  ur: { label: "Urdu", hl: "ur", gl: "PK", ceid: "PK:ur" },
  he: { label: "Hebrew", hl: "he", gl: "IL", ceid: "IL:he" },
  ps: { label: "Pashto", hl: "ps", gl: "AF", ceid: "AF:ps" }
});

const DEEP_SEARCH_LANGUAGE_CODES = Object.freeze(Object.keys(LANGUAGE_LOCALES));


const COUNTRY_LANGUAGE_PRIORITY = Object.freeze([
  { pattern: /\b(?:afghanistan|afghan)\b/i, languages: ["fa", "ps", "ur"] },
  { pattern: /\b(?:pakistan|pakistani)\b/i, languages: ["ur"] },
  { pattern: /\b(?:iran|iranian)\b/i, languages: ["fa"] },
  { pattern: /\b(?:france|french)\b/i, languages: ["fr"] },
  { pattern: /\b(?:germany|german)\b/i, languages: ["de"] },
  { pattern: /\b(?:spain|spanish)\b/i, languages: ["es"] },
  { pattern: /\b(?:italy|italian)\b/i, languages: ["it"] },
  { pattern: /\b(?:turkey|türkiye|turkiye|turkish)\b/i, languages: ["tr"] },
  { pattern: /\b(?:russia|russian)\b/i, languages: ["ru"] },
  { pattern: /\b(?:israel|israeli)\b/i, languages: ["he", "ar"] },
  { pattern: /\b(?:palestine|palestinian|gaza|west bank)\b/i, languages: ["ar", "he"] },
  { pattern: /\b(?:iraq|iraqi|syria|syrian|lebanon|lebanese|jordan|jordanian|saudi arabia|saudi|yemen|yemeni|oman|omani|qatar|qatari|united arab emirates|uae|bahrain|bahraini|kuwait|kuwaiti|egypt|egyptian|libya|libyan|tunisia|tunisian|algeria|algerian|morocco|moroccan|sudan|sudanese|mauritania|mauritanian)\b/i, languages: ["ar"] }
]);

// English and French are always searched with priority: they are the two
// languages CT Atlas analysts read directly, and they are searched first no
// matter which country the question is about.
const ALWAYS_PRIORITY_LANGUAGES = Object.freeze(["en", "fr"]);
const PRIORITY_LANGUAGE_CAP = 5;
// GDELT is now a small number of global fetches (see GDELT_MAX_CHUNKS above),
// so this only caps how many languages the shared result gets attributed
// across for diagnostics -- it no longer multiplies the real request count.
const GDELT_LANGUAGE_CAP = 5;
// 24 base Google + up to 5 native-locale Google rescues + up to
// GDELT_MAX_CHUNKS GDELT date-range queries + 1 ACLED query + up to
// PRIORITY_LANGUAGE_CAP Bing rescues (only fired when Google came up sparse
// for that language, same trigger as the Google rescue above).
const MAX_SEARCH_SUBREQUESTS = DEEP_SEARCH_MAX_QUERIES + PRIORITY_LANGUAGE_CAP + GDELT_MAX_CHUNKS + 1 + PRIORITY_LANGUAGE_CAP;

function detectCountryLanguages(question) {
  const text = String(question || "");
  const out = [];
  const add = code => {
    if (DEEP_SEARCH_LANGUAGE_CODES.includes(code) && !out.includes(code)) out.push(code);
  };
  for (const rule of COUNTRY_LANGUAGE_PRIORITY) {
    if (rule.pattern.test(text)) rule.languages.forEach(add);
  }
  return out;
}

// Combines the always-on languages, the languages detected from country names
// in the question, and the languages the planner LLM itself proposed, capped
// so the retrieval budget stays well under Cloudflare's subrequest ceiling.
function resolvePriorityLanguages(question, plannerLanguages = []) {
  const merged = [...ALWAYS_PRIORITY_LANGUAGES, ...detectCountryLanguages(question), ...plannerLanguages]
    .filter(code => DEEP_SEARCH_LANGUAGE_CODES.includes(code));
  return [...new Set(merged)].slice(0, PRIORITY_LANGUAGE_CAP);
}

// Generic administrative/legal/news-cycle words that show up across almost
// any security or political topic without distinguishing what the analyst
// actually asked about. Left in the OR group unchecked, a word like "ban" or
// "enforcement" matches any unrelated story that happens to mention some
// other ban or enforcement action (e.g. an Afghanistan opium-ban question
// pulling in stories about education or media bans instead).
const GDELT_GENERIC_STOPWORDS = new Set([
  "ban","bans","banned","banning","enforcement","enforce","enforced","enforcing",
  "decree","decrees","policy","policies","law","laws","order","orders","rule","rules",
  "regulation","regulations","restriction","restrictions","government","authorities",
  "official","officials","statement","announcement","announced","celebration","celebrate",
  "anniversary","power","years","year","return","meeting","visit","international","national",
  "world","global","political"
]);

function broadGdeltQuery(plan) {
  const primary = cleanText(plan?.queries?.find(item => item.language === "en" && item.variant === "primary")?.query || "", 220);
  const secondary = cleanText(plan?.queries?.find(item => item.language === "en" && item.variant === "secondary")?.query || "", 220);
  const stop = new Set(["the","and","for","with","from","into","over","under","about","information","data","report","reports","latest","recent"]);
  const tokens = value => (String(value || "").toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || []).filter(t => !stop.has(t));
  const p = tokens(primary), q = tokens(secondary), qset = new Set(q);
  const shared = p.filter(t => qset.has(t));
  const head = shared[0] || p[0] || q[0] || "";
  if (!head) return "";

  // Actively filter out stories the planner flagged as likely-unrelated,
  // on top of whichever OR-group is used below (AI-supplied or heuristic).
  const excludeTerms = (Array.isArray(plan?.gdelt_exclude_terms) ? plan.gdelt_exclude_terms : [])
    .filter(term => term && term !== head);
  const excludeSuffix = excludeTerms.length ? " " + excludeTerms.slice(0, 5).map(t => `-${t}`).join(" ") : "";

  // Prefer the planner LLM's own judgment of which words most specifically
  // identify THIS request over the static heuristic below: it already
  // reasoned about the analyst's exact topic (whatever it is — narcotics,
  // financing, maritime piracy, cyber...) and can name the truly
  // distinguishing terms far better than any fixed stoplist we maintain,
  // which can only ever anticipate topics we've already seen fail.
  const aiTerms = (Array.isArray(plan?.gdelt_broad_terms) ? plan.gdelt_broad_terms : [])
    .filter(term => term && term !== head);
  if (aiTerms.length >= 2) {
    return `${head} (${aiTerms.slice(0, 5).join(" OR ")})${excludeSuffix}`;
  }

  // Fallback heuristic for when the planner didn't return usable broad terms.
  // Interleave primary/secondary tokens instead of exhausting primary first,
  // so a secondary-only topic noun (e.g. "methamphetamine") isn't crowded
  // out by primary's own words, then push generic words to the back so the
  // OR group favours specific topic nouns over administrative filler.
  const interleaved = [];
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i]) interleaved.push(p[i]);
    if (q[i]) interleaved.push(q[i]);
  }
  const seen = new Set([head]);
  const candidates = [];
  for (const token of interleaved) {
    if (!token || seen.has(token)) continue;
    seen.add(token);
    candidates.push(token);
  }
  candidates.sort((a, b) =>
    (GDELT_GENERIC_STOPWORDS.has(a) ? 1 : 0) - (GDELT_GENERIC_STOPWORDS.has(b) ? 1 : 0));
  const rest = candidates.slice(0, 4);

  return (rest.length ? `${head} (${rest.join(" OR ")})` : head) + excludeSuffix;
}

// Unicode-aware tokeniser (unlike the ASCII-only one above) so this works
// across every CT Atlas script: Arabic, Persian, Pashto, Hebrew, Russian...
function tokenizeUnicode(value) {
  return String(value || "").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu) || [];
}

// For each language, find a token shared between its own primary and
// secondary query — almost always the requested geography or named actor,
// since both queries describe the same request. Search engines match
// loosely enough that a query about "Afghanistan heroin" can still surface
// an unrelated domestic heroin story with no Afghanistan connection at all;
// this anchor lets retrieveNews demand the request's own subject actually
// appear in a candidate article before trusting it as evidence. Only a
// language where primary and secondary genuinely share a token gets an
// anchor — anything else is left unfiltered rather than risk a bad guess.
function computeLanguageAnchors(plan) {
  const anchors = {};
  for (const language of DEEP_SEARCH_LANGUAGE_CODES) {
    // Prefer the planner's own explicit anchor for this language: it is
    // required by the schema and doesn't depend on primary/secondary
    // happening to repeat the same word, unlike the fallback below — the
    // fallback exists only for plans sanitized without going through the
    // normal LLM schema (e.g. tests, or a future planner response missing
    // this field despite being required).
    const explicit = plan?.anchors?.[language];
    if (explicit) { anchors[language] = explicit; continue; }
    const primary = plan?.queries?.find(item => item.language === language && item.variant === "primary")?.query || "";
    const secondary = plan?.queries?.find(item => item.language === language && item.variant === "secondary")?.query || "";
    const pTokens = tokenizeUnicode(primary);
    const qTokens = new Set(tokenizeUnicode(secondary));
    const shared = pTokens.find(token => qTokens.has(token));
    if (shared) anchors[language] = shared;
  }
  return anchors;
}

function filterByAnchor(rows, anchors) {
  return rows.filter(row => {
    const anchor = anchors[row.language];
    if (!anchor) return true;
    return `${row.title || ""} ${row.summary || ""}`.toLowerCase().includes(anchor);
  });
}

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    interpreted_request: { type: "string" },
    detected_period: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["global", "relative", "absolute"] },
        relative_days: { type: "integer" },
        start_date: { type: "string" },
        end_date: { type: "string" },
        explanation: { type: "string" }
      },
      required: ["mode", "explanation"]
    },
    priority_languages: { type: "array", items: { type: "string", enum: [...DEEP_SEARCH_LANGUAGE_CODES] } },
    gdelt_broad_terms: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 5 },
    gdelt_exclude_terms: { type: "array", items: { type: "string" }, maxItems: 5 },
    queries: {
      type: "object",
      properties: Object.fromEntries(
        DEEP_SEARCH_LANGUAGE_CODES.map(code => [code, {
          type: "object",
          properties: {
            primary: { type: "string" },
            secondary: { type: "string" },
            anchor: { type: "string" }
          },
          required: ["primary", "secondary", "anchor"]
        }])
      ),
      required: [...DEEP_SEARCH_LANGUAGE_CODES]
    }
  },
  required: ["interpreted_request", "detected_period", "queries"]
};

const REPORT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    analysis: { type: "string" }
  },
  required: ["title", "analysis"]
};

const PLAN_INSTRUCTION = `
You are the query-planning component of CT Atlas Deep Search, an authorised
multilingual OSINT research tool.

There is no separate period selector -- the analyst's free-text question is
the ONLY signal for what time window to search. The input gives you today's
date; use it to resolve relative or absolute periods into concrete dates.
Set detected_period exactly as follows:

- mode "global": the question states or implies NO period at all (e.g. "what
  is Daesh", "who is active in the Sahel", a general/background question).
  This is the DEFAULT when no time cue is present -- it means search as far
  back as available sources go, not just the recent past. Do not default to
  "relative" just because a question sounds current; only pick "relative" or
  "absolute" when the question actually contains a real time cue.
- mode "relative": the question names a DURATION relative to now ("last 3
  months", "recently", "this week", "over the past year"). Set relative_days
  to the best integer estimate (e.g. "last 3 months" -> 90, "recently"/
  "recent" with no further qualifier -> 60, "this week" -> 7, "the past
  year" -> 365). Prefer a slightly wider estimate over a narrower one when
  genuinely unsure.
- mode "absolute": the question names a SPECIFIC past date, range or year
  ("in 2019", "since January 2023", "between March and June 2022", "on 10
  April 2026"). Set start_date and end_date as ISO dates (YYYY-MM-DD). A
  single named year means start_date = that year's Jan 1 and end_date = that
  year's Dec 31 (never today, unless the year is the current year, in which
  case end_date = today). "Since <date>" means end_date = today. A single
  named day means start_date = end_date = that day.

Always set explanation to one short, human-readable sentence describing the
window you chose (e.g. "Last 90 days", "Global search across all available
history", "January to December 2019") -- this is shown directly to the
analyst, so it must be accurate and specific.

Interpret the analyst's exact free-text request and create EXACTLY TWO concise
Google News search queries in EACH of the 12 CT Atlas search languages (24 planned
queries total). Every Deep Search must search ALL 12 languages.

MANDATORY 12-LANGUAGE COVERAGE:
- en: English
- fr: French
- ar: Arabic
- de: German
- es: Spanish
- it: Italian
- tr: Turkish
- ru: Russian
- fa: Dari / Persian
- ur: Urdu
- he: Hebrew
- ps: Pashto

QUESTION ANALYSIS (do this before writing any query):
- Identify the core geography, actors and the underlying category of activity
  (terrorism, organised crime, narcotics, trafficking, financing, weapons,
  cybercrime, etc.).
- Identify well-established, directly relevant associated terms, synonyms,
  known actor/group names, methods or evidence types that an expert OSINT
  analyst would also search even when not explicitly named in the question —
  for example a question about maritime piracy off a given coast should also
  consider "hijacking", "hostage" or "ransom" as associated terms where
  relevant.
- Only use associated terms that are well-known and directly relevant. Do not
  invent specific group names, events or claims that are not either stated by
  the analyst or extremely well-established for the requested subject.
- If the request has many facets (for example: cultivation, manufacture of a
  second substance, trafficking routes for each substance, enforcement
  decrees, laboratory destruction, seizures — six-plus distinct facets),
  do NOT try to cram all of them into two queries. Split the facets into two
  groups (see QUERY DESIGN RULES) and accept that some minor facets will only
  be covered indirectly or by the broader term set, not named individually.

QUERY DESIGN RULES — RECALL IS THE PRIORITY, NOT COMPLETENESS:
- Google News RSS matches queries as AND-of-terms: every extra term you add
  MULTIPLIES how narrow the search becomes, and past about 6 terms real
  queries commonly return ZERO results even when good reporting exists. A
  short query that finds real articles is far more useful than a detailed
  query that finds nothing.
- HARD LIMIT: 3 to 6 meaningful search terms or short phrases per query,
  including geography. Never exceed 6. When in doubt, use fewer, not more.
- Silently correct obvious spelling mistakes in the analyst request before making
  search terms.
- NEVER turn the analyst's whole request into one long sentence-like query,
  and never chain more than 2-3 concepts together.
- primary = the single broadest, most central subject (usually just geography +
  the main activity/commodity, e.g. "Afghanistan opium cultivation ban").
- secondary = ONE complementary facet or action/evidence dimension (e.g.
  routes/trafficking, or laboratory seizures) — not every remaining facet at
  once. Pick whichever second facet is most central to the request; it is
  fine and expected to leave minor facets uncovered by name.
- When a request names two parallel items (e.g. two drug types, two actor
  groups), prefer covering the more prominent one by name and referring to
  the other only if it fits within the term limit — do not AND both together
  with everything else.
- For EVERY language also return anchor: the single most important
  geography/country/actor name this request is actually about, written in
  that language's own script (e.g. "Afghanistan" in English, "Afganistán" in
  Spanish, "أفغانستان" in Arabic). This is used afterward to verify a
  retrieved article is actually about the right subject, so it must be a
  real, distinctive name — not a generic word — and it must always be
  present even if your secondary query for that language does not happen to
  repeat it (secondary is allowed to focus on a facet without repeating the
  geography by name; anchor is not optional and stands in for it).
- Keep the same information need in all 12 languages using natural local terms,
  respecting the same strict term limit in every language.
- Preserve precise geography and named actors. Do not drift into unrelated places.
- Adjacent countries are acceptable only for directly relevant routes, networks,
  seizures, cross-border operations or comparisons requested by the analyst.
- Use at most one or two synonyms where they clearly improve recall; do not
  overload the query with every possible synonym or associated term from the
  analysis above — that analysis is there to help you CHOOSE the single best
  terms, not to add more of them.
- Prefer short, keyword-style terms over fluent grammatical sentences for
  languages with typically sparse news indexing (fa, ur, he, ps): a handful of
  natural local keywords matches published reporting better than a full phrase.

For narcotics research, split complex requests sensibly: one query may cover
cultivation/production/laboratories, the second trafficking/seizures/enforcement —
but still pick only 3-6 of the strongest terms for EACH query. Do not list every
word from both buckets in the same query.

If the analyst asks about narcotics, organised crime, smuggling, weapons,
cybercrime or another adjacent security topic, search it directly even when no
terrorism nexus is stated.

Set priority_languages to up to five supported languages: always include "en"
and "fr", plus up to three languages used locally in the requested countries
OR REGION. Recognise country names in any language, and also reason about
REGIONS the same way — a request does not have to name a single country for
you to know which of the 12 languages are locally relevant. For example:
Afghanistan -> fa, ps, ur; Egypt or another Arabic-speaking country -> ar;
Iran -> fa; Pakistan -> ur; Israel/Palestine -> he, ar; the Sahel or Francophone
West Africa (Mali, Niger, Burkina Faso, Chad, Mauritania) -> fr, ar; the
Maghreb -> ar, fr; the Horn of Africa -> ar; the Levant -> ar; the Balkans ->
tr; the Caucasus or Central Asia -> ru. Arabic and every other required
language remain part of the full 12-language search regardless of
priority_languages.

Set gdelt_broad_terms to 3-5 English keywords for a SEPARATE, wider fallback
search used only when the main per-language searches come back too sparse.
These must be the single most specific, topic-defining nouns for this exact
request (commodities, methods, technologies, specific named actors/groups) —
the words that could NOT plausibly appear in an unrelated story about the
same country or actor. Deliberately EXCLUDE generic administrative, legal or
news-cycle words even if they appear in your own queries above (for example:
ban, enforcement, decree, policy, law, restriction, government, official,
statement, anniversary, celebration) — those are generic enough to match
unrelated stories (e.g. a different kind of ban) and would dilute this
fallback search's precision. When the request itself is narrow enough that
your primary/secondary terms are already maximally specific, gdelt_broad_terms
can simply repeat the strongest 3-5 of them.

Set gdelt_exclude_terms to 0-5 English keywords that would actively signal an
UNRELATED story if present, to actively filter the same fallback search — for
example, for a request specifically about a country's own narcotics trade,
you might exclude neighbouring countries' unrelated domestic crime stories by
naming their most distinctive keywords if your queries make that risk
concrete. Leave this empty rather than guessing when no such risk is obvious.

Return only the structured search plan. For every language key, return both
"primary" and "secondary". Do not answer the analyst's question yet.
`;

const REPORT_INSTRUCTION = `
You are CT Atlas Deep Search. Produce a professional OSINT analytical report that
answers the analyst's exact question from the supplied retrieved evidence only.

STRICT SCOPE:
- Stay tightly focused on the requested geography, actors, commodities and time
  period. Do not drift to unrelated countries merely because they appear in
  background reporting.
- A neighbouring country may be discussed only when it directly evidences a
  requested route, network, seizure, enforcement action or comparison.

EVIDENCE RULES:
- Use ONLY the supplied evidence records. Do not rely on outside knowledge.
- Every factual paragraph or bullet must contain one or more source citations
  exactly like [S01] or [S01, S04].
- Never cite a source ID that is not supplied.
- Preserve allegations and uncertainty. Do not turn claims into facts.
- If sources conflict, state the conflict and cite both sides.
- Do not invent quantities, identities, locations, attribution, motives, routes,
  chronology or trends.
- Search-result snippets can be incomplete; do not infer beyond them.
- If the evidence is insufficient for a requested point, say so explicitly.

FORMAT:
Use plain report text inside the "analysis" field, with real newline characters.
Do NOT put JSON, Markdown code fences, triple backticks or a second title/analysis
object inside the analysis field.

Use these headings when relevant:
EXECUTIVE ASSESSMENT
PRODUCTION / CULTIVATION
TRAFFICKING NETWORKS / ROUTES
ENFORCEMENT / DECREES
LABORATORY DESTRUCTION / SEIZURES
KEY EVENTS / FINDINGS
POTENTIAL CT ATLAS GAPS
SOURCE / CONFIDENCE NOTES

Use concise bullets beneath headings when that improves readability. Do not force
headings that are irrelevant.

The field atlas_status is an approximate machine comparison against CT Atlas.
"potential_gap" means only that no sufficiently similar map event was
automatically matched; it is not proof that CT Atlas missed the event.
`;

function decodeXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripHtml(value) {
  return cleanText(decodeXml(String(value || "").replace(/<[^>]+>/g, " ")), 1000);
}

function tagValue(xml, tag) {
  const match = String(xml || "").match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeXml(match[1]).trim() : "";
}

function parseRss(xml, queryMeta, queryIndex, fallbackLocale = false) {
  const items = String(xml || "").match(/<item\b[\s\S]*?<\/item>/gi) || [];
  const rows = [];
  for (const item of items.slice(0, DEEP_SEARCH_RESULTS_PER_QUERY)) {
    const sourceMatch = item.match(/<source(?:\s[^>]*)?>([\s\S]*?)<\/source>/i);
    const source = cleanText(sourceMatch ? decodeXml(sourceMatch[1]) : "", 140);
    let title = cleanText(tagValue(item, "title"), 500);
    if (source && title.toLowerCase().endsWith((" - " + source).toLowerCase())) {
      title = title.slice(0, -(source.length + 3)).trim();
    }
    const url = cleanText(tagValue(item, "link"), 1200);
    const summary = stripHtml(tagValue(item, "description"));
    const publishedRaw = cleanText(tagValue(item, "pubDate"), 100);
    const publishedDate = publishedRaw ? new Date(publishedRaw) : null;
    if (!title || !url) continue;
    rows.push({
      title, summary, source: source || "Google News source", url,
      published: publishedDate && !Number.isNaN(publishedDate.getTime()) ? publishedDate.toISOString() : "",
      language: queryMeta.language,
      query_index: queryIndex,
      query_variant: queryMeta.variant || "primary",
      search_query: queryMeta.query,
      search_engine: "google_news",
      fallback_locale: Boolean(fallbackLocale)
    });
  }
  return rows;
}

function normalizeTitle(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(the|a|an|and|or|of|to|in|on|at|for|from|with|after|over|into|as|by|is|are|was|were|be|says|said|new|latest|report|reports|update|updates)\b/g, " ")
    .replace(/\s+/g, " ").trim();
}

function titleTokens(value) {
  return new Set(normalizeTitle(value).split(" ").filter(token => token.length >= 3));
}

function tokenSimilarity(a, b) {
  const aa = titleTokens(a), bb = titleTokens(b);
  if (!aa.size || !bb.size) return { jaccard: 0, containment: 0, shared: 0 };
  let shared = 0;
  for (const token of aa) if (bb.has(token)) shared++;
  const union = aa.size + bb.size - shared;
  return { jaccard: union ? shared / union : 0, containment: shared / Math.min(aa.size, bb.size), shared };
}

function dateDistanceDays(a, b) {
  const ad = a ? new Date(a) : null, bd = b ? new Date(b) : null;
  if (!ad || !bd || Number.isNaN(ad.getTime()) || Number.isNaN(bd.getTime())) return null;
  return Math.abs(ad.getTime() - bd.getTime()) / 86400000;
}

function deduplicateRows(rows) {
  const sorted = [...rows].sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0));
  const clusters = [];
  for (const row of sorted) {
    const normalized = normalizeTitle(row.title);
    let match = null;
    for (const candidate of clusters) {
      const gap = dateDistanceDays(row.published, candidate.published);
      if (gap !== null && gap > 5) continue;
      if (row.url && candidate.url && row.url === candidate.url) { match = candidate; break; }
      if (normalized && normalized === candidate._normalized) { match = candidate; break; }
      const sim = tokenSimilarity(row.title, candidate.title);
      if (sim.shared >= 4 && (sim.jaccard >= 0.62 || sim.containment >= 0.78)) { match = candidate; break; }
    }
    if (!match) {
      clusters.push({ ...row, _normalized: normalized, sources: [{ source: row.source, url: row.url, language: row.language, published: row.published, search_engine: row.search_engine || "google_news" }] });
    } else {
      if (!match.sources.some(item => item.url === row.url)) {
        match.sources.push({ source: row.source, url: row.url, language: row.language, published: row.published, search_engine: row.search_engine || "google_news" });
      }
      if ((row.summary || "").length > (match.summary || "").length) match.summary = row.summary;
    }
  }
  return clusters.map(({ _normalized, ...row }) => row);
}

function googleNewsUrl(query, locale, window) {
  const bufferedEnd = new Date(window.endDt.getTime() + 86400000);
  const term = `${cleanText(query, 200)} after:${isoDateOnly(window.startDt)} before:${isoDateOnly(bufferedEnd)}`;
  return "https://news.google.com/rss/search?" + new URLSearchParams({
    q: term, hl: locale.hl, gl: locale.gl, ceid: locale.ceid
  }).toString();
}

async function callGeminiJson(env, instruction, input, schema, maxOutputTokens) {
  const response = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "x-goog-api-key": env.GEMINI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: DEEP_SEARCH_MODEL,
      input,
      system_instruction: instruction,
      store: false,
      response_format: { type: "text", mime_type: "application/json", schema },
      generation_config: { max_output_tokens: maxOutputTokens, thinking_level: "minimal" }
    })
  });
  if (response.status === 429) {
    const error = new Error("Gemini quota/capacity temporarily unavailable for Deep Search (429). Please retry later.");
    error.code = 429; throw error;
  }
  if (!response.ok) throw new Error(`Gemini Deep Search error ${response.status}: ${cleanText(await response.text(), 600)}`);
  const payload = await response.json();
  const raw = (await extractGeminiText(payload)).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  return JSON.parse(raw);
}

function sanitizePlan(plan, fallbackQuestion) {
  const queries = [];
  const raw = plan?.queries && typeof plan.queries === "object" && !Array.isArray(plan.queries)
    ? plan.queries
    : {};

  const missing = [];
  const anchors = {};
  for (const language of DEEP_SEARCH_LANGUAGE_CODES) {
    const item = raw[language];
    const primary = cleanText(item?.primary, 220);
    const secondary = cleanText(item?.secondary, 220);
    if (!primary || !secondary) {
      missing.push(language);
      continue;
    }
    queries.push({ language, query: primary, variant: "primary" });
    queries.push({ language, query: secondary, variant: "secondary" });
    const anchor = cleanText(item?.anchor, 80).toLowerCase();
    if (anchor.length >= 3) anchors[language] = anchor;
  }

  if (missing.length) {
    throw new Error(
      "Deep Search planner did not return two usable queries for every required language: " +
      missing.join(", ")
    );
  }

  const sanitizeTermList = list => (Array.isArray(list) ? list : [])
    .flatMap(term => String(term || "").toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || [])
    .filter((term, index, arr) => arr.indexOf(term) === index)
    .slice(0, 5);

  // Only lightly cleaned here -- resolveSearchWindow() is the authoritative
  // validator and safely falls back to a sane default if this is missing or
  // malformed (e.g. an unparsable start_date), so no need to duplicate that
  // defensiveness here.
  const detectedPeriod = plan?.detected_period && typeof plan.detected_period === "object"
    ? {
        mode: cleanText(plan.detected_period.mode, 20),
        relative_days: Number(plan.detected_period.relative_days) || undefined,
        start_date: cleanText(plan.detected_period.start_date, 20),
        end_date: cleanText(plan.detected_period.end_date, 20),
        explanation: cleanText(plan.detected_period.explanation, 200)
      }
    : {};

  return {
    interpreted_request: cleanText(plan?.interpreted_request || fallbackQuestion, 700),
    detected_period: detectedPeriod,
    priority_languages: (Array.isArray(plan?.priority_languages) ? plan.priority_languages : []).filter(code => DEEP_SEARCH_LANGUAGE_CODES.includes(code)).slice(0, PRIORITY_LANGUAGE_CAP),
    gdelt_broad_terms: sanitizeTermList(plan?.gdelt_broad_terms),
    gdelt_exclude_terms: sanitizeTermList(plan?.gdelt_exclude_terms),
    anchors,
    queries: queries.slice(0, DEEP_SEARCH_MAX_QUERIES)
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Runs `worker` over `items` in small batches with a short pause between
// batches, instead of firing every request at once. Google News and GDELT
// both rate-limit/block bursty, simultaneous requests from shared Cloudflare
// egress IPs far more aggressively than gently-staggered ones.
async function runInBatches(items, batchSize, delayMs, worker) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    results.push(...await Promise.all(batch.map(worker)));
    if (i + batchSize < items.length) await sleep(delayMs);
  }
  return results;
}

async function fetchNewsWave(item, index, window, locale, fallbackLocale = false) {
  try {
    const response = await fetch(googleNewsUrl(item.query, locale, window), {
      headers: { "User-Agent": "Mozilla/5.0 CT-Atlas-Deep-Search/5.0" },
      cf: { cacheTtl: 300, cacheEverything: true },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      return { query: { ...item, fallback_locale: fallbackLocale }, ok: false, status: response.status, rows: [] };
    }
    const xml = await response.text();
    if (!/<rss[\s>]/i.test(xml) || !/<channel[\s>]/i.test(xml)) {
      return { query: { ...item, fallback_locale: fallbackLocale }, ok: false,
        status: response.status, error: "Search provider returned non-RSS content", rows: [] };
    }
    return {
      query: { ...item, fallback_locale: fallbackLocale },
      ok: true,
      status: response.status,
      rows: parseRss(xml, item, index, fallbackLocale)
    };
  } catch (error) {
    return {
      query: { ...item, fallback_locale: fallbackLocale },
      ok: false,
      status: 0,
      error: cleanText(error?.message, 180),
      rows: []
    };
  }
}

function gdeltDateTimeParam(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
}

// Always an explicit date range now -- no more relative "timespan=Nd" branch,
// since every search window (relative, absolute or global) already resolves
// to concrete startDt/endDt via resolveSearchWindow before any fetch happens.
function gdeltUrl(query, range) {
  const params = {
    query: cleanText(query, 280),
    mode: "artlist",
    format: "json",
    maxrecords: String(GDELT_GLOBAL_RESULTS_CAP),
    startdatetime: gdeltDateTimeParam(range.startDt),
    enddatetime: gdeltDateTimeParam(range.endDt)
  };
  return GDELT_DOC_URL + "?" + new URLSearchParams(params).toString();
}

// GDELT caps each query's results regardless of window length, so a single
// query for a long span only ever returns its top ~GDELT_GLOBAL_RESULTS_CAP
// hits across the WHOLE window. For spans longer than
// GDELT_CHUNK_THRESHOLD_DAYS, slice into up to GDELT_MAX_CHUNKS sequential
// date-range queries instead, each covering its own slice, so long/global
// searches get real depth across the whole window rather than one query
// straining to summarize years in ~250 results. Short spans (<= the
// threshold) are returned as a single un-sliced range so nothing changes for
// the common case.
function gdeltChunkRanges(startDt, endDt) {
  const totalDays = Math.max(1, Math.round((endDt.getTime() - startDt.getTime()) / 86400000));
  if (totalDays <= GDELT_CHUNK_THRESHOLD_DAYS) return [{ startDt, endDt }];
  const chunkCount = Math.min(GDELT_MAX_CHUNKS, Math.ceil(totalDays / GDELT_CHUNK_THRESHOLD_DAYS));
  const chunkMs = (endDt.getTime() - startDt.getTime()) / chunkCount;
  const ranges = [];
  for (let i = 0; i < chunkCount; i++) {
    ranges.push({
      endDt: new Date(endDt.getTime() - i * chunkMs),
      startDt: new Date(endDt.getTime() - (i + 1) * chunkMs)
    });
  }
  return ranges;
}

function parseGdeltDate(value) {
  const raw = String(value || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (digits.length >= 14) {
    const iso = `${digits.slice(0,4)}-${digits.slice(4,6)}-${digits.slice(6,8)}T${digits.slice(8,10)}:${digits.slice(10,12)}:${digits.slice(12,14)}Z`;
    const dt = new Date(iso);
    if (!Number.isNaN(dt.getTime())) return dt.toISOString();
  }
  const dt = raw ? new Date(raw) : null;
  return dt && !Number.isNaN(dt.getTime()) ? dt.toISOString() : "";
}

// GDELT's own article.language field is a full name ("English", "Arabic"...),
// not one of our 2-letter codes -- map it back so each row can be attributed
// to the right language without ever having asked GDELT to filter by one.
// An article in a language outside our 12 is dropped, matching how an
// unrecognized code is already filtered out everywhere else in this file.
function parseGdeltArticles(payload, query) {
  const articles = Array.isArray(payload?.articles) ? payload.articles : [];
  return articles.slice(0, GDELT_GLOBAL_RESULTS_CAP).map(article => {
    const title = cleanText(article?.title, 500);
    const url = cleanText(article?.url || article?.url_mobile, 1200);
    const language = GDELT_LANGUAGE_NAME_TO_CODE[cleanText(article?.language, 40).toLowerCase()];
    if (!title || !url || !language) return null;
    return {
      title,
      summary: "",
      source: cleanText(article?.domain || article?.sourcecountry || "GDELT source", 140),
      url,
      published: parseGdeltDate(article?.seendate),
      language,
      query_index: -1,
      query_variant: "gdelt-rescue",
      search_query: query,
      search_engine: "gdelt",
      fallback_locale: false
    };
  }).filter(Boolean);
}

// A single global GDELT fetch, with no sourcelang restriction: GDELT allows
// only about one request every 5 seconds (its own 429 response says so
// explicitly). `range` is always an explicit {startDt, endDt} date slice --
// see fetchGdeltChunked below, which is the only caller that ever issues more
// than one of these per Deep Search, always spaced GDELT_CHUNK_SPACING_MS apart.
async function fetchGdeltGlobalWave(query, range) {
  try {
    const response = await fetch(gdeltUrl(query, range), {
      headers: { "User-Agent": "Mozilla/5.0 CT-Atlas-Deep-Search/5.5" },
      cf: { cacheTtl: 300, cacheEverything: true },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      return { ok: false, status: response.status, rows: [] };
    }
    const payload = await response.json().catch(() => ({}));
    return { ok: true, status: response.status, rows: parseGdeltArticles(payload, query) };
  } catch (error) {
    return { ok: false, status: 0, error: cleanText(error?.message, 180), rows: [] };
  }
}

// Issues gdeltChunkRanges(startDt,endDt) sequential GDELT queries (1 for
// short spans, up to GDELT_MAX_CHUNKS for long/global ones), spaced
// GDELT_CHUNK_SPACING_MS apart to respect GDELT's ~1-request/5s limit, and
// merges them into one combined wave -- ok if AT LEAST one chunk succeeded
// (partial coverage is still real evidence), status/error from the last
// chunk attempted.
async function fetchGdeltChunked(query, startDt, endDt) {
  const ranges = gdeltChunkRanges(startDt, endDt);
  const rows = [];
  let anyOk = false, lastStatus = 0, lastError;
  for (let i = 0; i < ranges.length; i++) {
    const wave = await fetchGdeltGlobalWave(query, ranges[i]);
    if (wave.ok) anyOk = true;
    lastStatus = wave.status;
    lastError = wave.error;
    rows.push(...wave.rows);
    if (i < ranges.length - 1) await sleep(GDELT_CHUNK_SPACING_MS);
  }
  return { ok: anyOk, status: lastStatus, error: lastError, rows, chunks: ranges.length };
}

// Turns the one real GDELT fetch into a wave per language, so every
// downstream consumer (languageDiagnostics, evidence building) keeps working
// exactly as if GDELT had genuinely been queried once per language. Every
// language in `languages` gets a wave carrying the shared ok/status/error
// (so a 429 or success is visible per language too), with rows attributed
// only to the language they actually belong to.
function splitGdeltRowsByLanguage(globalWave, query, languages) {
  const byLanguage = new Map();
  for (const row of globalWave.rows) {
    if (!byLanguage.has(row.language)) byLanguage.set(row.language, []);
    byLanguage.get(row.language).push(row);
  }
  const relevant = [...new Set([...languages, ...byLanguage.keys()])]
    .filter(code => DEEP_SEARCH_LANGUAGE_CODES.includes(code))
    .slice(0, GDELT_LANGUAGE_CAP);
  return relevant.map(language => ({
    query: { language, query, variant: "gdelt-rescue", engine: "gdelt" },
    ok: globalWave.ok,
    status: globalWave.status,
    error: globalWave.error,
    rows: byLanguage.get(language) || []
  }));
}

async function retrieveNews(plan, window, priorityLanguages = []) {
  // Bound search well below Cloudflare's 50-subrequest-per-invocation ceiling.
  // A full handleDeepSearch call also makes ~9 NON-search subrequests
  // (session-get, acquire, cache-get, plan Gemini call, events.json fetch,
  // report Gemini call, cache-put, commit-report, release), so the search
  // phase must never approach 50 on its own:
  // 24 Google News + max 5 priority Google rescues + up to GDELT_MAX_CHUNKS(5)
  // GDELT calls (see fetchGdeltChunked) + 1 ACLED call (see fetchAcledWave) +
  // max 5 Bing rescues (see fetchBingWave) = max 38 total, kept under ~40 so
  // the whole invocation (search + the ~9 calls above) stays safely under
  // 50. Do NOT add per-wave retries here: retrying every failed wave once
  // can double the search subrequest count on exactly the runs where most
  // waves are failing, and has previously blown through Cloudflare's
  // subrequest ceiling and hard-crashed the whole invocation.
  // Sent in small staggered batches rather than all at once: Google News
  // rate-limits/blocks a burst of simultaneous identical-looking requests
  // from shared Cloudflare egress IPs far more readily than gently-paced ones.
  const anchors = computeLanguageAnchors(plan);
  const sortedQueries = [...plan.queries].sort((a, b) =>
    Number(priorityLanguages.includes(b.language)) - Number(priorityLanguages.includes(a.language)));
  const googleWaves = await runInBatches(
    sortedQueries.map((item, index) => ({ item, index })),
    6, 200,
    ({ item, index }) => fetchNewsWave(item, index, window, LANGUAGE_LOCALES[item.language], false)
  );
  for (const wave of googleWaves) wave.rows = filterByAnchor(wave.rows, anchors);

  const totals = Object.fromEntries(DEEP_SEARCH_LANGUAGE_CODES.map(code => [code, new Set()]));
  for (const wave of googleWaves) {
    for (const row of wave.rows) totals[wave.query.language].add(row.url);
  }

  // Country-relevant languages get one extra native-language query through the
  // stable en-US Google edition if the local edition returned fewer than 3 items.
  const priorityRescueItems = [];
  for (const language of priorityLanguages.slice(0, PRIORITY_LANGUAGE_CAP)) {
    if ((totals[language]?.size || 0) >= 3) continue;
    const candidate = plan.queries.find(item => item.language === language && item.variant === "primary")
      || plan.queries.find(item => item.language === language);
    if (candidate) priorityRescueItems.push({ ...candidate, variant: "priority-locale-rescue" });
  }
  const priorityRescueWaves = await Promise.all(
    priorityRescueItems.map((item, index) =>
      fetchNewsWave(item, googleWaves.length + index, window,
        item.language === "en" ? ENGLISH_SEARCH_FALLBACK_LOCALE : SEARCH_FALLBACK_LOCALE, true)
    )
  );
  for (const wave of priorityRescueWaves) wave.rows = filterByAnchor(wave.rows, anchors);

  const googleAll = [...googleWaves, ...priorityRescueWaves];
  const afterGoogle = Object.fromEntries(DEEP_SEARCH_LANGUAGE_CODES.map(code => [code, new Set()]));
  for (const wave of googleAll) {
    for (const row of wave.rows) afterGoogle[wave.query.language].add(row.url);
  }

  // Bing News rescue: same sparsity trigger and threshold as the Google
  // native-locale rescue above, so it only ever fires when Google itself
  // came up short for that language -- a healthy day costs nothing extra.
  // See the comment above BING_NEWS_SEARCH_URL for why this exists and its
  // terms-of-use caveat. Sequential with a light stagger since Bing's rate
  // limit (if any) is undocumented -- better to be a cautious citizen.
  const bingRescueItems = [];
  for (const language of priorityLanguages.slice(0, PRIORITY_LANGUAGE_CAP)) {
    if ((afterGoogle[language]?.size || 0) >= 3) continue;
    const candidate = plan.queries.find(item => item.language === language && item.variant === "primary")
      || plan.queries.find(item => item.language === language);
    if (candidate) bingRescueItems.push(candidate);
  }
  const bingWaves = [];
  for (let i = 0; i < bingRescueItems.length; i++) {
    const wave = await fetchBingWave(bingRescueItems[i].query, bingRescueItems[i].language);
    wave.rows = filterByAnchor(wave.rows, anchors);
    bingWaves.push(wave);
    if (i < bingRescueItems.length - 1) await sleep(BING_RESCUE_SPACING_MS);
  }

  // GDELT rescues priority languages first, then other sparse languages --
  // via fetchGdeltChunked, which issues 1 query for short periods or up to
  // GDELT_MAX_CHUNKS sequential date-range queries for long ones, never one
  // request per LANGUAGE: GDELT allows only about one request every 5
  // seconds, and firing several at once (as a previous version did)
  // reliably got every one of them 429'd.
  const gdeltQuery = broadGdeltQuery(plan);
  const sparse = DEEP_SEARCH_LANGUAGE_CODES.filter(code => (afterGoogle[code]?.size || 0) < 3);
  const gdeltAttributionLanguages = [...new Set([...priorityLanguages, ...sparse])]
    .filter(code => DEEP_SEARCH_LANGUAGE_CODES.includes(code))
    .slice(0, GDELT_LANGUAGE_CAP);
  let gdeltWaves = [];
  let gdeltRequests = 0;
  if (gdeltQuery) {
    const globalWave = await fetchGdeltChunked(gdeltQuery, window.startDt, window.endDt);
    gdeltRequests = globalWave.chunks || 1;
    globalWave.rows = filterByAnchor(globalWave.rows, anchors);
    gdeltWaves = splitGdeltRowsByLanguage(globalWave, gdeltQuery, gdeltAttributionLanguages);
  }

  // ACLED as an additional source: one single Google-News query scoped to
  // acleddata.com, anchored on the broadest English query from the plan.
  const acledQueryText = plan.queries.find(item => item.language === "en" && item.variant === "primary")?.query
    || plan.queries.find(item => item.language === "en")?.query
    || "";
  let acledWaves = [];
  let acledRequests = 0;
  if (acledQueryText) {
    acledRequests = 1;
    const acledWave = await fetchAcledWave(acledQueryText, window);
    acledWave.rows = filterByAnchor(acledWave.rows, anchors);
    acledWaves = [acledWave];
  }

  const waves = [...googleAll, ...bingWaves, ...gdeltWaves, ...acledWaves];
  return {
    waves,
    rows: waves.flatMap(item => item.rows),
    priority_languages: priorityLanguages,
    subrequest_budget: {
      google_news_requests: googleAll.length,
      bing_requests: bingWaves.length,
      gdelt_requests: gdeltRequests,
      acled_requests: acledRequests,
      search_requests: googleAll.length + bingWaves.length + gdeltRequests + acledRequests,
      max_search_requests: MAX_SEARCH_SUBREQUESTS
    }
  };
}

// The CT Atlas comparison window must cover at least the whole search
// window (plus a small buffer), never a hardcoded cap -- otherwise a long or
// global Deep Search would compare freshly retrieved older articles against
// a database window that stops short, mislabelling real CT Atlas matches
// beyond that as "potential gaps".
function candidateMapEvents(db, window) {
  const all = Array.isArray(db) ? db : (Array.isArray(db?.events) ? db.events : []);
  const cutoff = window.startDt.getTime() - (14 * 86400000);
  return all.filter(event => {
    const dt = parseEventDate(event);
    return !dt || dt.getTime() >= cutoff;
  }).map(event => {
    const dt = parseEventDate(event);
    return {
      id: String(event?.id || event?._mapKey || ""),
      title: cleanText(event?.title, 500),
      original_title: cleanText(event?.original_title, 500),
      url: cleanText(event?.url, 1200),
      published: dt ? dt.toISOString() : "",
      country: cleanText(event?.country, 100)
    };
  });
}

function compareWithAtlas(rows, mapEvents) {
  return rows.map(row => {
    let best = null, bestScore = 0;
    for (const event of mapEvents) {
      const gap = dateDistanceDays(row.published, event.published);
      if (gap !== null && gap > 7) continue;
      if (row.url && event.url && row.url === event.url) { best = event; bestScore = 1; break; }
      for (const candidateTitle of [event.title, event.original_title]) {
        if (!candidateTitle) continue;
        if (normalizeTitle(row.title) === normalizeTitle(candidateTitle)) { best = event; bestScore = 0.99; break; }
        const sim = tokenSimilarity(row.title, candidateTitle);
        const score = Math.max(sim.jaccard, sim.containment * 0.9);
        if (sim.shared >= 4 && score > bestScore) { best = event; bestScore = score; }
      }
      if (bestScore >= 0.90) break;
    }
    const matched = best && bestScore >= 0.64;
    return {
      ...row,
      atlas_status: matched ? "already_in_atlas" : "potential_gap",
      atlas_match_id: matched ? best.id : "",
      atlas_match_title: matched ? best.title : "",
      atlas_match_score: matched ? Math.round(bestScore * 100) : 0
    };
  });
}

function searchRelevance(row) {
  const query = cleanText(row.search_query, 220);
  if (!query) return 0;
  const combined = `${row.title || ""} ${row.summary || ""}`;
  const sim = tokenSimilarity(combined, query);
  return Math.min(30, (sim.containment * 22) + Math.min(8, sim.shared) * 1.4);
}

function evidencePriority(row) {
  let score = searchRelevance(row);
  const published = row.published ? new Date(row.published) : null;
  if (published && !Number.isNaN(published.getTime())) {
    const ageDays = Math.max(0, (Date.now() - published.getTime()) / 86400000);
    score += Math.max(0, 32 - ageDays * 0.35);
  }
  score += Math.min(18, (row.sources?.length || 1) * 4.5);
  if (row.atlas_status === "potential_gap") score += 3;
  if (row.search_engine === "acled" || /justice|interpol|europol|government|police|treasury|ministry|prosecut|united nations|unodc|customs|counter narcotics|interior/i.test(row.source || "")) score += 9;
  return score;
}

function buildEvidence(rows, priorityLanguages = []) {
  const ranked = [...rows].sort((a, b) => evidencePriority(b) - evidencePriority(a));
  const selected = [];
  const used = new Set();

  // English is a permanent priority language for retrieval, but until now it
  // only ever got the same flat 2-slot floor as any other priority language
  // further below -- so when another language simply had more or
  // better-ranked candidates, English could end up as a sliver of the final
  // evidence pack even when plenty of English material was actually
  // retrieved. Guarantee it at least a third of the eventual evidence count
  // instead, reserved from the top of its own ranking, before any other
  // language-diversity logic runs.
  const targetEvidenceTotal = Math.min(DEEP_SEARCH_MAX_EVIDENCE, ranked.length);
  const englishFloor = Math.ceil(targetEvidenceTotal / 3);
  let englishCount = 0;
  for (let i = 0; i < ranked.length && englishCount < englishFloor; i++) {
    if (ranked[i].language !== "en") continue;
    selected.push(ranked[i]);
    used.add(i);
    englishCount++;
  }

  // Protect two evidence slots per country-priority language when available.
  for (const language of priorityLanguages) {
    for (let take = 0; take < 2 && selected.length < DEEP_SEARCH_MAX_EVIDENCE; take++) {
      const index = ranked.findIndex((row, i) => !used.has(i) && row.language === language);
      if (index < 0) break;
      selected.push(ranked[index]);
      used.add(index);
    }
  }

  // Then preserve at least one item from every other language when available.
  for (const language of DEEP_SEARCH_LANGUAGE_CODES) {
    if (selected.some(row => row.language === language)) continue;
    const index = ranked.findIndex((row, i) => !used.has(i) && row.language === language);
    if (index >= 0 && selected.length < DEEP_SEARCH_MAX_EVIDENCE) {
      selected.push(ranked[index]);
      used.add(index);
    }
  }
  ranked.forEach((row, index) => {
    if (selected.length >= DEEP_SEARCH_MAX_EVIDENCE || used.has(index)) return;
    selected.push(row);
    used.add(index);
  });

  return selected.map((row, index) => ({
    id: `S${String(index + 1).padStart(2, "0")}`,
    title: cleanText(row.title, 420), summary: cleanText(row.summary, 650),
    source: cleanText(row.source, 140), url: cleanText(row.url, 1200),
    published: row.published, language: row.language,
    query_variant: row.query_variant || "primary",
    search_query: cleanText(row.search_query, 280),
    search_engine: row.search_engine || "google_news",
    fallback_locale: Boolean(row.fallback_locale),
    source_count: row.sources?.length || 1,
    additional_sources: (row.sources || []).slice(1, 5).map(source => ({
      source: cleanText(source.source, 140), url: cleanText(source.url, 1200),
      language: source.language, published: source.published,
      search_engine: source.search_engine || "google_news"
    })),
    atlas_status: row.atlas_status, atlas_match_id: row.atlas_match_id,
    atlas_match_title: row.atlas_match_title, atlas_match_score: row.atlas_match_score
  }));
}

function unwrapGeneratedReport(generated) {
  let title = cleanText(generated?.title || "", 180);
  let analysis = String(generated?.analysis || "").trim();

  for (let pass = 0; pass < 2; pass++) {
    const candidate = analysis.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    if (!(candidate.startsWith("{") && candidate.endsWith("}"))) break;
    try {
      const nested = JSON.parse(candidate);
      if (!nested || typeof nested !== "object" || !nested.analysis) break;
      title = cleanText(nested.title || title, 180);
      analysis = String(nested.analysis || "").trim();
    } catch (_) { break; }
  }

  if (!analysis.includes("\n") && /\\n/.test(analysis)) {
    analysis = analysis.replace(/\\n/g, "\n").replace(/\\"/g, '"');
  }
  analysis = analysis.replace(/^```(?:json|text|markdown)?\s*/i, "").replace(/\s*```$/i, "").trim();
  return { title, analysis };
}

function citationMetrics(analysis, evidence) {
  const valid = new Set(evidence.map(item => item.id)), cited = new Set();
  for (const match of String(analysis || "").matchAll(/\[(S\d{2})(?:,\s*S\d{2})*\]/g)) {
    const ids = match[0].match(/S\d{2}/g) || [];
    ids.forEach(id => { if (valid.has(id)) cited.add(id); });
  }
  const paragraphs = String(analysis || "").split(/\n+/).map(v => v.trim())
    .filter(v => v && !/^[A-Z][A-Z /&-]{4,}$/.test(v));
  const factual = paragraphs.filter(v => v.length >= 35);
  const grounded = factual.filter(v => /\[S\d{2}/.test(v));
  return {
    cited_source_ids: [...cited],
    citation_coverage_percent: factual.length ? Math.round(grounded.length / factual.length * 100) : 100,
    cited_sources: cited.size,
    factual_paragraphs: factual.length,
    cited_factual_paragraphs: grounded.length
  };
}

function languageDiagnostics(plan, retrieval, priorityLanguages = []) {
  const byLanguage = {};
  for (const code of DEEP_SEARCH_LANGUAGE_CODES) {
    byLanguage[code] = {
      code,
      name: LANGUAGE_LOCALES[code]?.label || code,
      query_count: 0,
      article_count: 0,
      successful_queries: 0,
      google_news_articles: 0,
      gdelt_articles: 0,
      acled_articles: 0,
      bing_articles: 0,
      priority: priorityLanguages.includes(code)
    };
  }
  for (const wave of retrieval.waves) {
    const code = wave.query.language;
    if (!byLanguage[code]) continue;
    byLanguage[code].query_count++;
    byLanguage[code].article_count += wave.rows.length;
    if (wave.ok) byLanguage[code].successful_queries++;
    const engine = wave.query.engine || (wave.query.variant === "gdelt-rescue" ? "gdelt" : "google_news");
    if (engine === "gdelt") byLanguage[code].gdelt_articles += wave.rows.length;
    else if (engine === "acled") byLanguage[code].acled_articles += wave.rows.length;
    else if (engine === "bing") byLanguage[code].bing_articles += wave.rows.length;
    else byLanguage[code].google_news_articles += wave.rows.length;
  }
  return Object.values(byLanguage);
}

async function authenticateDeepSearch(request, body, env) {
  const username = normalizeUsername(body.user_id || body.username);
  const token = cleanText(request.headers.get("X-Session-Token"), 160);
  if (!username || !isAllowedUser(username, env)) return { error: jsonResponse({ error: "Unknown or missing user." }, 400, env) };
  if (!token) return { error: jsonResponse({ error: "Authenticated session required. Please sign in again." }, 401, env) };
  const sessionResponse = await gateCall(env, "/session-get", { session_token: token });
  const session = await sessionResponse.json().catch(() => ({}));
  if (!sessionResponse.ok || session?.username !== username) return { error: jsonResponse({ error: "Unauthorized session." }, 401, env) };
  return { username };
}

export async function handleDeepSearch(request, env, ctx) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON request." }, 400, env); }

  const auth = await authenticateDeepSearch(request, body, env);
  if (auth.error) return auth.error;

  const question = cleanText(body.question, 1200);
  if (question.length < 8) return jsonResponse({ error: "Enter a more specific Deep Search question." }, 400, env);

  // No period is requested from the client any more -- the planner LLM reads
  // the period out of the question itself (see detected_period / resolveSearchWindow).
  // The cache key therefore only needs the question text: the resolved window
  // is a deterministic function of it, and the short cache TTL below means a
  // "relative" window (e.g. "last 30 days") never drifts meaningfully stale.
  const username = auth.username;
  const cacheKey = await sha256(JSON.stringify({
    question: question.toLowerCase(), version: DEEP_SEARCH_VERSION
  }));

  const permitResponse = await gateCall(env, "/acquire", { username, kind: "deep_search" });
  const permit = await permitResponse.json().catch(() => ({}));
  if (!permitResponse.ok || !permit?.permit_id) {
    return jsonResponse({
      error: permit?.error || "Deep Search capacity temporarily unavailable.",
      retry_after_seconds: permit?.retry_after_seconds || 20
    }, permitResponse.status || 429, env);
  }
  const permitId = permit.permit_id;

  try {
    const cachedResponse = await gateCall(env, "/cache-get", { cacheKey: "deep:" + cacheKey });
    const cached = await cachedResponse.json().catch(() => ({}));
    if (cached?.hit && cached?.report) {
      const commitResponse = await gateCall(env, "/commit-report", { permitId, username });
      if (!commitResponse.ok) throw new Error("Unable to finalize Deep Search allowance.");
      ctx?.waitUntil?.(gateCall(env, "/usage-increment", {
        username,
        metrics: { cached_reports: 1 }
      }).catch(error => console.error("Deep Search usage record failed", error)));
      return jsonResponse({ ...cached.report, cached: true }, 200, env);
    }

    const planRaw = await callGeminiJson(
      env, PLAN_INSTRUCTION,
      `Analyst question: ${question}\nToday's date: ${isoDateOnly(new Date())}.`,
      PLAN_SCHEMA, 6000
    );
    const plan = sanitizePlan(planRaw, question);
    if (!plan.queries.length) return jsonResponse({ error: "Deep Search could not create a usable multilingual search plan." }, 422, env);

    const window = resolveSearchWindow(plan);
    const detectedPeriod = {
      mode: window.mode,
      start: window.startDt.toISOString(),
      end: window.endDt.toISOString(),
      label: window.label
    };

    const priorityLanguages = resolvePriorityLanguages(question, plan.priority_languages || []);
    const retrieval = await retrieveNews(plan, window, priorityLanguages);
    const unique = deduplicateRows(retrieval.rows);
    const languagesSearched = languageDiagnostics(plan, retrieval, priorityLanguages);

    if (!unique.length) {
      // A zero-result report can mean two very different things: genuinely
      // no open-source coverage exists, or every single search request was
      // rejected by a provider (Google News/GDELT rate-limiting or blocking
      // Cloudflare's shared egress IPs, a known transient condition -- see
      // the v5.12/v5.19 incidents). Telling these apart matters: the first
      // is a real finding, the second is not evidence of anything and
      // should never be read as "no coverage exists".
      const likelyTransientFetchIssue = isLikelyTransientFetchIssue(retrieval.waves);
      return jsonResponse({
        error: likelyTransientFetchIssue
          ? "Deep Search's search providers (Google News/GDELT) failed or were rate-limited for every query in this search. This is a temporary infrastructure issue, not evidence that no coverage exists for this question -- please retry in a few minutes."
          : "Deep Search found no usable open-source reporting for this question and period.",
        likely_transient_fetch_issue: likelyTransientFetchIssue,
        detected_period: detectedPeriod,
        languages_searched: languagesSearched,
        search_queries: retrieval.waves.map(w => ({ ...w.query, ok: w.ok, status: w.status, result_count: w.rows.length }))
      }, 422, env);
    }

    let db = { events: [] }, databaseVersion = "unavailable";
    try {
      const dbResponse = await fetch(env.EVENTS_URL, { cf: { cacheTtl: 60, cacheEverything: true } });
      if (dbResponse.ok) {
        db = await dbResponse.json();
        databaseVersion = cleanText(db.updated_at || db.generated_at || db.last_updated || "unknown", 100);
      }
    } catch (_) {}

    const compared = compareWithAtlas(unique, candidateMapEvents(db, window));
    const evidence = buildEvidence(compared, priorityLanguages);
    const dataset = {
      analyst_question: question,
      interpreted_request: plan.interpreted_request,
      period: detectedPeriod.label,
      database_version: databaseVersion,
      language_search_coverage: languagesSearched,
      priority_languages: priorityLanguages,
      evidence,
      source_previews: sourcePreviews
    };

    const generatedRaw = await callGeminiJson(
      env, REPORT_INSTRUCTION,
      "Answer the analyst question using only this Deep Search evidence dataset:\n\n" + JSON.stringify(dataset),
      REPORT_SCHEMA, 9000
    );
    const generated = unwrapGeneratedReport(generatedRaw);
    if (!generated.analysis) throw new Error("Deep Search generated an empty analytical report.");

    const metrics = citationMetrics(generated.analysis, evidence);
    const gaps = evidence.filter(item => item.atlas_status === "potential_gap").length;
    const inAtlas = evidence.length - gaps;
    const successfulQueries = retrieval.waves.filter(item => item.ok).length;
    const citedSourceIds = new Set(metrics?.cited_source_ids || []);
    const previewCandidates = [...evidence].sort((a,b) =>
      (citedSourceIds.has(b.id) ? 1 : 0) - (citedSourceIds.has(a.id) ? 1 : 0) ||
      Number(b.source_count || 1) - Number(a.source_count || 1)
    );
    const sourcePreviews = await createSourcePreviews(env, previewCandidates, { maxImages: 2, maxAttempts: 2 });

    const report = {
      title: generated.title || "CT Atlas Deep Search",
      analysis: generated.analysis,
      question,
      interpreted_request: plan.interpreted_request,
      detected_period: detectedPeriod,
      generated_at: new Date().toISOString(),
      database_version: databaseVersion,
      model: DEEP_SEARCH_MODEL,
      version: DEEP_SEARCH_VERSION,
      languages_searched: languagesSearched,
      priority_languages: priorityLanguages,
      search_queries: retrieval.waves.map(w => ({
        language: w.query.language, query: w.query.query,
        variant: w.query.variant,
        engine: w.query.engine || (w.query.variant === "gdelt-rescue" ? "gdelt" : "google_news"),
        fallback_locale: Boolean(w.query.fallback_locale),
        error: w.error || "",
        ok: w.ok, status: w.status, result_count: w.rows.length
      })),
      retrieval: {
        queries_planned: plan.queries.length,
        queries_attempted: retrieval.waves.length,
        queries_successful: successfulQueries,
        articles_retrieved: retrieval.rows.length,
        unique_event_clusters: unique.length,
        evidence_events_used_for_analysis: evidence.length,
        matched_to_atlas: inAtlas,
        potential_atlas_gaps: gaps,
        google_news_articles: retrieval.rows.filter(row => row.search_engine === "google_news").length,
        gdelt_articles: retrieval.rows.filter(row => row.search_engine === "gdelt").length,
        acled_articles: retrieval.rows.filter(row => row.search_engine === "acled").length,
        bing_articles: retrieval.rows.filter(row => row.search_engine === "bing").length,
        search_subrequests: retrieval.subrequest_budget?.search_requests || retrieval.waves.length
      },
      grounding: {
        ...metrics,
        note: "Citation coverage measures visible source citation coverage; it is not a statistical probability of hallucination."
      },
      evidence
    };

    await gateCall(env, "/cache-put", {
      cacheKey: "deep:" + cacheKey, report,
      expires_at: Date.now() + DEEP_SEARCH_CACHE_TTL_MS
    });

    const commitResponse = await gateCall(env, "/commit-report", { permitId, username });
    if (!commitResponse.ok) {
      const commitError = await commitResponse.json().catch(() => ({}));
      throw new Error(commitError?.error || "Unable to finalize Deep Search allowance.");
    }

    ctx?.waitUntil?.(gateCall(env, "/usage-increment", {
      username,
      metrics: { reports_generated: 1 }
    }).catch(error => console.error("Deep Search usage record failed", error)));
    return jsonResponse({ ...report, cached: false }, 200, env);
  } catch (error) {
    console.error("Deep Search failure", error);
    const status = Number(error?.code) === 429 ? 429 : 503;
    return jsonResponse({
      error: cleanText(error?.message || "Deep Search failed.", 400),
      ...(status === 429 ? { retry_after_seconds: 300 } : {})
    }, status, env);
  } finally {
    ctx.waitUntil(gateCall(env, "/release", { permitId, username }));
  }
}
