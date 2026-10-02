// The picture illustrating a Report Generator or Deep Search report: the best
// share image among the articles the report actually cites, with a title.
//
// A report only names its candidates (illustrationCandidates: the cited
// sources, most cited first); the page then asks /report-illustration for the
// picture in a request of its own. Finding it costs 3-6 subrequests an article
// (most links are Google News redirects that must be resolved first), which
// Deep Search, close to Cloudflare's 50 per invocation, cannot spare.
import { cleanText, jsonResponse, gateCall, normalizeUsername, isAllowedUser } from "./shared.js";
import {
  isSafePublicUrl,
  fetchSafe,
  readLimitedText,
  fetchArticleImage,
  createImageToken,
  PREVIEW_USER_AGENT
} from "./source-preview.js";

const REPORT_ILLUSTRATION_VERSION = "report-illustration-v1";
const MAX_CANDIDATES = 6;
// Articles inspected at once; the next ones only when none of these has a
// usable picture.
const CANDIDATE_BATCH = 3;
// Under the image token's 24 h, so a cached answer never points at an
// expired token. "No picture" is remembered for less.
const ILLUSTRATION_CACHE_TTL_MS = 20 * 60 * 60 * 1000;
const NO_ILLUSTRATION_CACHE_TTL_MS = 2 * 60 * 60 * 1000;

const GOOGLE_NEWS_HOST = "news.google.com";
const GOOGLE_NEWS_BATCH_URL = "https://news.google.com/_/DotsSplashUi/data/batchexecute";
// The article page carries the signature the decoder needs at its very end.
const GOOGLE_NEWS_PAGE_LIMIT = 2000000;
// Skips the consent interstitial Google shows visitors from the EU.
const GOOGLE_CONSENT_COOKIE = "CONSENT=YES+cb; SOCS=CAI";

// Smallest share image worth showing, and the widest/tallest proportions that
// are still a photo rather than a banner, a strip or a logo block.
const MIN_IMAGE_WIDTH = 400;
const MIN_IMAGE_HEIGHT = 200;
const MAX_ASPECT = 3;
const MIN_ASPECT = 0.5;
const LARGE_IMAGE_WIDTH = 800;
// Aggregators' own artwork (Google News answers its redirect links with its logo).
const GENERIC_IMAGE_HOST = /(^|\.)(googleusercontent\.com|gstatic\.com|google\.com|news\.google\.com)$/i;
// Site artwork, judged on the file name only: "/sites/default/files/..." is
// where Drupal keeps real photos.
const GENERIC_IMAGE_FILE = /(logo|placeholder|default|favicon|apple-touch-icon|sprite|avatar|blank|no[-_]?image|fallback|share[-_]?image)/i;
const NOT_A_PHOTO = /\.(svg|ico|gif)$/i;

const SOURCE_ID = /^[SC]\d{2,3}$/;

// ---------------------------------------------------------------- candidates

// How many times the analysis cites each source id ([S03], [S01, C04] ...).
function citationCounts(analysis) {
  const counts = new Map();
  for (const match of String(analysis || "").matchAll(/\[([SC]\d{2,3}(?:\s*,\s*[SC]\d{2,3})*)\]/g)) {
    for (const id of match[1].match(/[SC]\d{2,3}/g) || []) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

// The articles a report is built on, best illustration candidates first: the
// cited ones, most cited first, then in the report's own order (relevance).
// A report that cites nothing offers its first sources instead.
function illustrationCandidates(sources, analysis, max = MAX_CANDIDATES) {
  const counts = citationCounts(analysis);
  const usable = (Array.isArray(sources) ? sources : [])
    .map((source, index) => ({ source, index, citations: counts.get(cleanText(source?.id, 8)) || 0 }))
    .filter(({ source }) => SOURCE_ID.test(cleanText(source?.id, 8)) && isSafePublicUrl(cleanText(source?.url, 1500)));
  const cited = usable.filter(item => item.citations > 0);
  const chosen = (cited.length ? cited : usable)
    .sort((a, b) => b.citations - a.citations || a.index - b.index)
    .slice(0, max);
  return chosen.map(({ source, citations }) => ({
    id: cleanText(source.id, 8),
    title: cleanText(source.title, 300),
    source: cleanText(source.source, 160),
    url: cleanText(source.url, 1500),
    date: cleanText(source.date || source.published, 40),
    citations
  }));
}

function parseCandidates(value) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(value) ? value : []) {
    const url = cleanText(item?.url, 1500);
    if (!isSafePublicUrl(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({
      id: SOURCE_ID.test(cleanText(item?.id, 8)) ? cleanText(item.id, 8) : "",
      title: cleanText(item?.title, 300),
      source: cleanText(item?.source, 160),
      url,
      date: cleanText(item?.date, 40),
      citations: Math.max(0, Math.min(99, Number.parseInt(item?.citations, 10) || 0))
    });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

// ---------------------------------------------------------------- Google News links

function googleNewsArticleId(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.hostname.toLowerCase() !== GOOGLE_NEWS_HOST) return "";
    const match = url.pathname.match(/\/(?:rss\/)?(?:articles|read)\/([A-Za-z0-9_-]{20,})/);
    return match ? match[1] : "";
  } catch (_) {
    return "";
  }
}

// The address inside Google's batchexecute answer for a "garturlreq".
function parseDecodedUrl(text) {
  for (const line of String(text || "").replace(/^\)\]\}'/, "").split("\n")) {
    if (!line.trim().startsWith("[")) continue;
    let rows;
    try { rows = JSON.parse(line); } catch (_) { continue; }
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!Array.isArray(row) || row[0] !== "wrb.fr" || typeof row[2] !== "string") continue;
      try {
        const inner = JSON.parse(row[2]);
        if (inner?.[0] === "garturlres" && typeof inner[1] === "string") return inner[1];
      } catch (_) {}
    }
  }
  return "";
}

// The outlet's own address for a news.google.com redirect link (its page holds
// a signature, which Google's decoder endpoint exchanges for the address), the
// link itself when it is not a Google News one, "" when it cannot be resolved.
async function resolveArticleUrl(value) {
  const id = googleNewsArticleId(value);
  if (!id) return value;
  const headers = { "User-Agent": PREVIEW_USER_AGENT, "Cookie": GOOGLE_CONSENT_COOKIE };
  try {
    const page = await fetchSafe(`https://${GOOGLE_NEWS_HOST}/rss/articles/${id}?hl=en-US&gl=US&ceid=US:en`, {
      headers: { ...headers, "Accept": "text/html" }
    });
    if (!page.ok) return "";
    const html = await readLimitedText(page, GOOGLE_NEWS_PAGE_LIMIT);
    const signature = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
    const timestamp = Number(html.match(/data-n-a-ts="(\d+)"/)?.[1]);
    if (!signature || !timestamp) return "";
    const request = JSON.stringify([
      "garturlreq",
      [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1],
        "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
      id, timestamp, signature
    ]);
    const answer = await fetchSafe(GOOGLE_NEWS_BATCH_URL, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: "f.req=" + encodeURIComponent(JSON.stringify([[["Fbv4je", request, null, "generic"]]]))
    });
    if (!answer.ok) return "";
    const decoded = parseDecodedUrl(await readLimitedText(answer, 200000));
    return isSafePublicUrl(decoded) && !googleNewsArticleId(decoded) ? decoded : "";
  } catch (error) {
    console.warn("Google News link not resolved", cleanText(error?.message, 160));
    return "";
  }
}

// ---------------------------------------------------------------- choosing the picture

// Whether a share image is a photo worth showing: not an aggregator's or a
// site's artwork, not an icon, and (when the page declares its size) large
// enough and of a photo's proportions.
function imageVerdict(image) {
  let url;
  try { url = new URL(String(image?.url || "")); } catch (_) { return { ok: false, reason: "no image" }; }
  if (GENERIC_IMAGE_HOST.test(url.hostname)) return { ok: false, reason: "aggregator artwork" };
  const file = decodeURIComponent(url.pathname.split("/").pop() || "");
  if (NOT_A_PHOTO.test(file)) return { ok: false, reason: "not a photo" };
  if (GENERIC_IMAGE_FILE.test(file)) return { ok: false, reason: "site artwork" };
  const width = Number(image.width) || 0;
  const height = Number(image.height) || 0;
  if ((width && width < MIN_IMAGE_WIDTH) || (height && height < MIN_IMAGE_HEIGHT)) return { ok: false, reason: "too small" };
  if (width && height && (width / height > MAX_ASPECT || width / height < MIN_ASPECT)) {
    return { ok: false, reason: "banner proportions" };
  }
  return { ok: true, large: width >= LARGE_IMAGE_WIDTH };
}

// The photo's title is the cited article's English headline from the report
// (what the picture illustrates, in the report's language). The page's own
// caption, often the headline in the outlet's language, travels along for
// the image's alt text.
function photoTitle(image, candidate) {
  const headline = cleanText(candidate?.title, 300) || cleanText(image?.title, 300);
  const caption = cleanText(image?.alt, 300);
  return { title: headline, photo_caption: caption && caption !== headline ? caption : "" };
}

// The best of the inspected articles' pictures: the most cited article whose
// picture passed imageVerdict, a large picture before an unknown or smaller
// one, then the report's order. A picture two different articles share is a
// site's default artwork, never a photo of either story.
function chooseIllustration(results) {
  const counts = new Map();
  for (const result of results) {
    if (result?.image?.url) counts.set(result.image.url, (counts.get(result.image.url) || 0) + 1);
  }
  const valid = results
    .map((result, order) => ({ ...result, order, verdict: imageVerdict(result?.image) }))
    .filter(result => result.image && result.verdict.ok && counts.get(result.image.url) === 1);
  valid.sort((a, b) =>
    b.candidate.citations - a.candidate.citations ||
    Number(b.verdict.large) - Number(a.verdict.large) ||
    a.order - b.order);
  return valid[0] || null;
}

async function inspectCandidate(candidate) {
  const articleUrl = await resolveArticleUrl(candidate.url);
  if (!articleUrl) return { candidate, image: null };
  return { candidate, image: await fetchArticleImage(articleUrl) };
}

async function findIllustration(candidates, inspect = inspectCandidate) {
  const results = [];
  for (let start = 0; start < candidates.length; start += CANDIDATE_BATCH) {
    const batch = candidates.slice(start, start + CANDIDATE_BATCH);
    results.push(...await Promise.all(batch.map(candidate => inspect(candidate).catch(() => ({ candidate, image: null })))));
    const best = chooseIllustration(results);
    if (best) return best;
  }
  return null;
}

// ---------------------------------------------------------------- endpoint

async function authenticate(request, body, env) {
  const username = normalizeUsername(body.user_id);
  const token = cleanText(request.headers.get("X-Session-Token"), 160);
  if (!username || !isAllowedUser(username, env)) return jsonResponse({ error: "Unknown or missing user." }, 400, env);
  if (!token) return jsonResponse({ error: "Authenticated session required. Please sign in again." }, 401, env);
  const sessionResponse = await gateCall(env, "/session-get", { session_token: token });
  const session = await sessionResponse.json().catch(() => ({}));
  if (!sessionResponse.ok || session?.username !== username) return jsonResponse({ error: "Unauthorized session." }, 401, env);
  return null;
}

async function cacheKeyFor(candidates) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(candidates.map(c => c.url).join("\n")));
  return "illustration:" + [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function handleReportIllustration(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON request." }, 400, env); }
  const authError = await authenticate(request, body, env);
  if (authError) return authError;

  const candidates = parseCandidates(body.candidates);
  if (!candidates.length) {
    return jsonResponse({ version: REPORT_ILLUSTRATION_VERSION, illustration: null, reason: "no article to illustrate" }, 200, env);
  }
  const cacheKey = await cacheKeyFor(candidates);
  const cached = await gateCall(env, "/cache-get", { cacheKey }).then(r => r.json()).catch(() => ({}));
  if (cached?.hit && cached.report) return jsonResponse({ ...cached.report, cached: true }, 200, env);

  const best = await findIllustration(candidates);
  let payload = { version: REPORT_ILLUSTRATION_VERSION, illustration: null, reason: "no usable picture in the cited articles" };
  if (best) {
    const imagePath = await createImageToken(env, best.image.url, {
      source_id: best.candidate.id, title: best.candidate.title, source: best.candidate.source,
      article_url: best.image.article_url
    });
    if (imagePath) {
      payload = {
        version: REPORT_ILLUSTRATION_VERSION,
        illustration: {
          image_path: imagePath,
          ...photoTitle(best.image, best.candidate),
          headline: best.candidate.title,
          source: best.candidate.source || best.image.site,
          source_id: best.candidate.id,
          article_url: best.image.article_url,
          date: best.candidate.date
        }
      };
    }
  }
  const ttl = payload.illustration ? ILLUSTRATION_CACHE_TTL_MS : NO_ILLUSTRATION_CACHE_TTL_MS;
  await gateCall(env, "/cache-put", { cacheKey, report: payload, expires_at: Date.now() + ttl }).catch(() => {});
  return jsonResponse(payload, 200, env);
}

export {
  REPORT_ILLUSTRATION_VERSION,
  MAX_CANDIDATES,
  citationCounts,
  illustrationCandidates,
  parseCandidates,
  googleNewsArticleId,
  parseDecodedUrl,
  resolveArticleUrl,
  imageVerdict,
  photoTitle,
  chooseIllustration,
  findIllustration,
  handleReportIllustration
};
