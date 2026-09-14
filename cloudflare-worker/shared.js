const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const ALLOWED_PERIODS = new Set([7, 30, 90, 180]);
const MAX_EVENTS_CURRENT = 80;
const MAX_EVENTS_PREVIOUS = 60;
const CACHE_TTL_MS = 8 * 60 * 60 * 1000;
const REPORT_COOLDOWN_MS = 20 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
// CT Atlas AI ("quick ask"): a single fast Gemini call, not the heavy
// multi-source Deep Search / Report Generator pipeline, so it gets its own,
// much more generous quota rather than sharing the 5/day report-gate limit.
const QUICK_ASK_COOLDOWN_MS = 3 * 1000;
const QUICK_ASK_DAILY_LIMIT = 60;
const QUICK_ASK_GLOBAL_DAILY_LIMIT = 800;
// In-app "Send Feedback": evaluation ratings and one-off issue reports,
// emailed directly to the CT Atlas owner (never shown in the UI) rather than
// stored. A separate, lightweight quota since this is just a relay, not an
// AI call.
const FEEDBACK_COOLDOWN_MS = 30 * 1000;
const FEEDBACK_DAILY_LIMIT = 20;
const FEEDBACK_GLOBAL_DAILY_LIMIT = 200;
// Bump whenever the report SHAPE changes (new fields, schema, citation
// rules) so an existing cache entry from before the change is never served
// as-is -- folded into the cache key in index.js's /report handler.
const REPORT_GENERATOR_VERSION = "report-v3-hub-severity-not-volume";

const USER_PASSWORD_HASHES = Object.freeze({
  "group-i-1": "73b888d49521429ac698cda951475bd0f6d16fc01821c3f527f8bfd3fa612b36",
  "group-i-2": "82beedc71b740984031f2c8f1c06c3bd8eabd9bfcf9efe6e2261a4580066e8d3",
  "group-i-3": "6b037fadbaa6a6933fb8a662257646b001b29c3a3cda5caef57bd11925a5701e",
  "group-i-4": "75b0708f31cf68a1ad50bb9d426d891401a5e722a6b8731fe5200f1d75caab74",
  "group-i-5": "f5a58623f390a1b152ac8950cd0914055114fa7b1bfe0e15c35fd48cb066b10b",
  "group-i-6": "b43b773a5ec3194d878e662cd611571d38a6baeb1611222608e5e69d5f4266a5",
  "group-i-7": "fc4bd24ea1b1437c67ce076d15a36ba148fed82d44cd96e532b8c28ac8de1765",
  "group-i-8": "295da608e659c3950cb8776ec145bdb6f3fc7dab5519ad49e30db6fd60023141",
  "group-i-9": "64c92799eae33fb86e4329f43cee6e6b7c0120fa6edfd1d8cd786f2d14ede02b",
  "group-i-10": "454cac06f14cb79e546d644b1e2576b4e141e2f6917a43bc43b062cf67dc6cbd",
  "group-p-1": "93cbf70eef3baab340976ad537077afb5c38dce7c5ffe964d54dac648edff968",
  "group-p-2": "d24a9c21b53df643a7778674dbdf1826265b1f5b77e14b6821f336795d4b3ab8",
  "group-p-3": "cf13d1814c71f7cdbb90b6559aee12184bd1aeaff92a4ad9e2b96ca7b9895280",
  "group-p-4": "85b8d0b0c2d862c7b6e874e223bf5360fd28a44019326726210948db4511b167",
  "group-p-5": "29b970c5a82b74d24070d78b4f9ca0d5c7113a879eca580a257e81a35aefc186",
  "group-p-6": "e8a2245e69cc63f55e3b141ebaca289dc4f173f5c749372a8bb9318043811003",
  "group-p-7": "7ef18ab77ed8627e1fadca823f8b163515752e568b5c3c85846fcd955c1b5f2c",
  "group-p-8": "035f5d60182c6bbdf31aab6a39cecc44a2c066db9f1bf546730b53b21dfe2c41",
  "group-p-9": "b8e8d43141df6e7a76a9db469a8eab54628a549406e065d1b4128c2881978544",
  "group-p-10": "e6c95500fec415b85667a95429ffbdc6b691a707ca89bade0881e60a07014933",
  "group-s-1": "9ccc578509bdea17f0212cb37a99bed3cbfb42cf7d1c157f0a0ab005b76dd1bf",
  "group-s-2": "d81738545bc7e21533bea9d9419433be8fe4de084c64075ec62c40e556f59b53",
  "group-s-3": "d7de141b33a926541943fcaa483951ae4e5303960b629c940f384f7d52cdb3fb",
  "group-s-4": "b152bdd07ba8c232943eb73b5fcda859cf1f1621bcc754fc84956b7557cc782e",
  "group-s-5": "814c7c21d08e70773ffc03941250006562cdc753df326d10772cfdaaa07c07c3",
  "group-s-6": "c092a04684cacc72c079a86d0ff3f64eda5a4233e2023a7a4509aa0e78c97acd",
  "group-s-7": "6e5b35be120ebaaa86f957abbbd0475ab4ec15965751dac4149e2ea9ee0e5ba0",
  "group-s-8": "063bc0425b83c89430482bcfd08f954cebea9281d08cd222db64a0a47319f4df",
  "group-s-9": "b86b4935ca24fedcf6b96a05133f858cd5a8b659c78cf680c32db3fe369c0dcf",
  "group-s-10": "a4dd7ccbb89e2f7c10ad6d40feeae20df386e78ba815f2cbf6f29b98f7d45e51",
  "admin": "a7cdf5d0586b392473dd0cd08c9ba833240006a8a7310bf9bc8bf1aefdfaeadb"
});
const LEGACY_ALLOWED_USERS = new Set(Object.keys(USER_PASSWORD_HASHES));

function authUsersFromEnv(env) {
  const raw = String(env?.AUTH_USERS_JSON || "").trim();
  if (!raw) return USER_PASSWORD_HASHES;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("AUTH_USERS_JSON must be a JSON object.");
    }
    const entries = Object.entries(parsed)
      .map(([username, hash]) => [
        normalizeUsername(username),
        String(hash || "").trim().toLowerCase()
      ])
      .filter(([username, hash]) =>
        /^[a-z0-9][a-z0-9._-]{0,63}$/.test(username) &&
        /^[a-f0-9]{64}$/.test(hash)
      );
    if (!entries.length) throw new Error("AUTH_USERS_JSON contains no valid users.");
    return Object.freeze(Object.fromEntries(entries));
  } catch (error) {
    console.error("Invalid AUTH_USERS_JSON; rejecting all logins.", error);
    return Object.freeze({});
  }
}

function getAllowedUsers(env) {
  return new Set(Object.keys(authUsersFromEnv(env)));
}

const ALLOWED_USERS = LEGACY_ALLOWED_USERS;

const REPORT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    analysis: { type: "string" }
  },
  required: ["title", "analysis"]
};

const SYSTEM_INSTRUCTION = `
You are producing an on-demand counter-terrorism criminal-analysis report
from a deduplicated OSINT event database.

Write approximately 650-900 words in professional analytical English.

Use these headings exactly:
EXECUTIVE ASSESSMENT
KEY DEVELOPMENTS
GEOGRAPHIC PATTERNS
TACTICS / MODUS OPERANDI
COUNTER-TERRORISM RESPONSE
SIGNIFICANT CHANGES
OUTLOOK / WATCHPOINTS
SOURCE / CONFIDENCE NOTES

When a comparison period is supplied, focus on WHAT CHANGED between the current
period and the immediately preceding equivalent period. Distinguish reporting
volume from evidence of an actual operational change whenever possible.

HUB / HOTSPOT RULE (critical -- this has been a real error in past reports):
in GEOGRAPHIC PATTERNS, never call a country or region a "hub", an "emerging
hotspot", or otherwise newly significant merely because it has a high
event_count or article count. Reporting volume can rise simply because a
country's press produces a lot of routine wire copy (many short items about
the same court case, minor detentions, or a story simply getting picked up
and translated by many outlets) -- none of that reflects real operational
activity on the ground. A location only qualifies as a hub/hotspot when
top_countries_by_attack_ct_action_activity shows a genuinely high count of
Attacks or Counter Terrorism Action events specifically -- actual attacks,
armed clashes, or offensive/combat counter-terrorism operations (raids,
sieges, captures). A high count of plain "Arrests" (routine, no-combat
custody) does NOT by itself make somewhere a hub, even at high volume --
only a large-scale, combat-linked operation (already classified as Counter
Terrorism Action) counts. When you cite a country as significant, name
whether that significance comes from attacks it suffered, combat CT
operations conducted there, or something else -- never leave it ambiguous
whether you mean "lots of attacks happened here" versus "lots of articles
were written about here".

Prioritise concrete countries, regions, cities, attacks, offensive/combat
counter-terrorism operations, clashes, disrupted plots, weapons/explosives,
terrorist financing, CBRN, cyber and emerging-technology developments when
materially relevant to the selected topic.

Do not invent facts, casualty figures, attribution, coordination, causes or
predictions. Preserve uncertainty. Use only the supplied records and statistics.
The outlook may identify watchpoints but must not make unsupported forecasts.

CITATION RULES (this is how the analyst checks the report against real
sources and catches hallucination -- follow exactly):
- Every priority_events record carries a source_id like "S01". Cite it
  in brackets immediately after the claim it supports, exactly like
  [S01] or [S01, S07]. Never invent a source_id that was not supplied.
- Every factual sentence or bullet in EXECUTIVE ASSESSMENT, KEY
  DEVELOPMENTS, GEOGRAPHIC PATTERNS, TACTICS / MODUS OPERANDI,
  COUNTER-TERRORISM RESPONSE and SIGNIFICANT CHANGES must carry at least
  one citation. A sentence with no citation is read as your own
  unsupported inference, not a database fact -- avoid that.
- In SOURCE / CONFIDENCE NOTES, briefly state the overall reliability of
  this report: how many independent records it draws on, whether key
  claims rest on a single source or are corroborated by several
  (each record's source_count says how many outlets reported it), and
  name any specific claim above that is weakly supported (single-source,
  low relevance score, or otherwise uncertain). If the underlying data is
  thin for the requested topic/period, say so plainly instead of padding
  the report with speculation.
`;

// Reflects the actual request's Origin when it's on the allowlist (the main
// site plus any mirror hosted elsewhere for networks that block the main
// domain -- see EXTRA_ALLOWED_ORIGINS), otherwise falls back to the primary
// ALLOWED_ORIGIN. env.__requestOrigin is set once per request in index.js's
// fetch() via a fresh {...env} copy (never by mutating the shared env
// object), so concurrent requests in the same isolate can never see each
// other's origin.
function corsHeaders(env) {
  const requestOrigin = env.__requestOrigin || "";
  const allowlist = [env.ALLOWED_ORIGIN, ...String(env.EXTRA_ALLOWED_ORIGINS || "").split(",")]
    .map(v => String(v || "").trim())
    .filter(Boolean);
  const origin = allowlist.includes(requestOrigin) ? requestOrigin : (env.ALLOWED_ORIGIN || "*");
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST,OPTIONS,GET",
    "Access-Control-Allow-Headers": "Content-Type,X-Session-Token",
    "Vary": "Origin",
    "Content-Type": "application/json; charset=utf-8"
  };
}

function jsonResponse(body, status, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(env)
  });
}

function cleanText(value, max = 700) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeUsername(value) {
  return cleanText(value, 64).toLowerCase();
}

function isAllowedUser(username, env) {
  return getAllowedUsers(env).has(normalizeUsername(username));
}

function passwordHashForUser(username, env) {
  return authUsersFromEnv(env)[normalizeUsername(username)] || "";
}

function authMode(env) {
  return String(env?.AUTH_USERS_JSON || "").trim() ? "secret" : "legacy-fallback";
}

function parisDayKey(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(timestamp));
  const get = type => parts.find(part => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function usageTemplate(username = "") {
  return {
    username,
    logins: 0,
    searches: 0,
    map_searches: 0,
    event_list_searches: 0,
    report_requests: 0,
    reports_generated: 0,
    cached_reports: 0,
    blocked_report_requests: 0,
    quick_ask_requests: 0,
    feedback_submissions: 0,
    quiz_answers: 0,
    quiz_correct: 0,
    quiz_incorrect: 0,
    last_activity: ""
  };
}

function parseEventDate(event) {
  for (const key of [
    "event_date","occurrence_date","occurred_at","incident_date","attack_date",
    "published_at","publication_date","published","pub_date","date","updated_at"
  ]) {
    if (!event?.[key]) continue;
    const date = new Date(event[key]);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function eventCategories(event) {
  const raw = event?.categories ?? (event?.category ? [event.category] : []);
  return Array.isArray(raw) ? raw.map(String) : [String(raw)];
}

function matchesTopic(event, topic) {
  if (!topic || topic === "ALL") return true;
  return eventCategories(event).includes(topic);
}

const REPORT_REGION_COUNTRY_CODES = Object.freeze({
  "REGION:AFRICA": new Set([
    "DZ","AO","BJ","BW","BF","BI","CV","CM","CF","TD","KM","CG","CD","CI","DJ","EG",
    "GQ","ER","SZ","ET","GA","GM","GH","GN","GW","KE","LS","LR","LY","MG","MW","ML",
    "MR","MU","MA","MZ","NA","NE","NG","RW","ST","SN","SC","SL","SO","ZA","SS","SD",
    "TZ","TG","TN","UG","EH","ZM","ZW"
  ]),
  "REGION:MENA": new Set([
    "DZ","BH","EG","IR","IQ","IL","JO","KW","LB","LY","MA","OM","PS","QA","SA","SY",
    "TN","TR","AE","YE"
  ]),
  "REGION:AMERICAS": new Set([
    "AI","AG","AR","AW","BS","BB","BZ","BM","BO","BQ","BR","CA","KY","CL","CO","CR",
    "CU","CW","DM","DO","EC","SV","FK","GF","GL","GD","GP","GT","GY","HT","HN","JM",
    "MQ","MX","MS","NI","PA","PY","PE","PR","BL","KN","LC","MF","PM","VC","SX","SR",
    "TT","TC","US","UY","VE","VG","VI"
  ]),
  "REGION:ASIA_SOUTH_PACIFIC": new Set([
    "AF","AU","BD","BT","BN","KH","CN","FJ","HK","IN","ID","JP","KI","KP","KR","KG",
    "LA","MO","MY","MV","MH","FM","MN","MM","NR","NP","NZ","PK","PW","PG","PH","SG",
    "SB","LK","TJ","TH","TL","TM","TV","TW","UZ","VU","VN","WS","TO"
  ]),
  "REGION:EUROPE": new Set([
    "AL","AD","AM","AT","AZ","BY","BE","BA","BG","HR","CY","CZ","DK","EE","FI","FR",
    "GE","DE","GR","HU","IS","IE","IT","XK","LV","LI","LT","LU","MT","MD","MC","ME",
    "NL","MK","NO","PL","PT","RO","RU","SM","RS","SK","SI","ES","SE","CH","TR","UA",
    "GB","VA"
  ])
});

const REPORT_COUNTRY_CODE_ALIASES = Object.freeze({
  "congo": "CG",
  "republic of the congo": "CG",
  "congo democratic rep": "CD",
  "democratic republic of the congo": "CD",
  "drc": "CD",
  "cote d ivoire": "CI",
  "ivory coast": "CI",
  "czech republic": "CZ",
  "czechia": "CZ",
  "viet nam": "VN",
  "vietnam": "VN",
  "swaziland": "SZ",
  "eswatini": "SZ",
  "turkey": "TR",
  "turkiye": "TR",
  "russia": "RU",
  "russian federation": "RU",
  "iran": "IR",
  "islamic republic of iran": "IR",
  "syria": "SY",
  "syrian arab republic": "SY",
  "laos": "LA",
  "moldova": "MD",
  "republic of moldova": "MD",
  "palestine": "PS",
  "state of palestine": "PS",
  "bolivia": "BO",
  "venezuela": "VE",
  "tanzania": "TZ",
  "united states": "US",
  "united states of america": "US",
  "usa": "US",
  "uk": "GB",
  "united kingdom": "GB",
  "great britain": "GB",
  "south korea": "KR",
  "republic of korea": "KR",
  "north korea": "KP",
  "democratic peoples republic of korea": "KP",
  "uae": "AE",
  "united arab emirates": "AE"
});

function foldRegionLabel(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function countryCodeForLabel(value) {
  return REPORT_COUNTRY_CODE_ALIASES[foldRegionLabel(value)] || "";
}

function matchesRegion(event, region) {
  const selected = String(region || "").trim().toUpperCase();
  if (!selected || selected === "GLOBAL") return true;

  const broadRegion = REPORT_REGION_COUNTRY_CODES[selected];
  if (broadRegion) {
    const countryCode = String(event?.country_code || event?.country_iso2 || event?.countryCode || event?.iso2 || "")
      .trim()
      .toUpperCase();
    if (countryCode && broadRegion.has(countryCode)) return true;

    const storedRegion = String(event?.region || "").trim().toUpperCase();
    const labelAliases = {
      "REGION:AFRICA": ["AFRICA", "SUB-SAHARAN AFRICA", "NORTH AFRICA"],
      "REGION:MENA": ["MENA", "MIDDLE EAST", "NORTH AFRICA", "MIDDLE EAST & NORTH AFRICA"],
      "REGION:AMERICAS": ["AMERICAS", "NORTH AMERICA", "CENTRAL AMERICA", "SOUTH AMERICA", "CARIBBEAN"],
      "REGION:ASIA_SOUTH_PACIFIC": ["ASIA", "SOUTH ASIA", "SOUTHEAST ASIA", "EAST ASIA", "ASIA PACIFIC", "OCEANIA", "SOUTH PACIFIC"],
      "REGION:EUROPE": ["EUROPE", "EASTERN EUROPE", "WESTERN EUROPE", "NORTHERN EUROPE", "SOUTHERN EUROPE"]
    };
    return (labelAliases[selected] || []).some(alias => storedRegion.includes(alias));
  }

  const target = foldRegionLabel(region);
  const selectedCode = countryCodeForLabel(region);
  const eventCode = String(event?.country_code || event?.country_iso2 || event?.countryCode || event?.iso2 || "")
    .trim()
    .toUpperCase();
  if (selectedCode && eventCode === selectedCode) return true;

  return [event?.country, event?.region, event?.city]
    .some(value => {
      const candidate = foldRegionLabel(value);
      return candidate === target || (
        selectedCode && countryCodeForLabel(value) === selectedCode
      );
    });
}

function compactEvent(event) {
  return {
    id: String(event.id || event._mapKey || ""),
    title: cleanText(event.title, 280),
    summary: cleanText(event.summary, 560),
    categories: eventCategories(event),
    country: cleanText(event.country, 80),
    region: cleanText(event.region, 100),
    city: cleanText(event.city, 100),
    actor_group: cleanText(event.actor_group, 100),
    date: parseEventDate(event)?.toISOString() || "",
    source: cleanText(event.source, 140),
    url: cleanText(event.url, 1200),
    source_count: Number(event.source_count || 1),
    relevance: Number(event.ai_relevance_score || 0)
  };
}

// Shared by both the Report Generator and Deep Search: counts how many
// factual paragraphs in the generated analysis actually carry a [Sxx] /
// [Sxx, Syy] citation pointing at a real supplied source id, versus how
// many read as a bare, uncited claim. This is the concrete anti-hallucination
// signal surfaced to the user -- a citation coverage below 100% means some
// factual statements in the report are not directly traceable to a source.
function citationMetrics(analysis, validIds) {
  const valid = new Set(validIds);
  const cited = new Set();
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

// Real "hub" activity per the analyst's own definition: sustained attacks or
// offensive/combat counter-terrorism operations (raids, clashes, captures).
// Deliberately excludes "Arrests" (plain, no-combat custody -- can be high in
// volume purely because a country's courts/police generate a lot of routine
// wire copy, without a single attack or clash happening) and every other
// category, so a country's rank can never be driven by reporting volume on
// financing, legal proceedings, CBRN or online-radicalization stories.
const HIGH_SEVERITY_HUB_CATEGORIES = new Set(["Attacks", "Counter Terrorism Action"]);

function stats(events) {
  const category = {};
  const totals = {};
  const highSeverity = {};
  const categoriesByCountry = {};
  for (const e of events) {
    const cats = eventCategories(e);
    for (const c of cats) category[c] = (category[c] || 0) + 1;
    const co = cleanText(e.country, 80);
    if (!co) continue;
    totals[co] = (totals[co] || 0) + 1;
    if (cats.some(c => HIGH_SEVERITY_HUB_CATEGORIES.has(c))) {
      highSeverity[co] = (highSeverity[co] || 0) + 1;
    }
    const byCat = categoriesByCountry[co] || (categoriesByCountry[co] = {});
    for (const c of cats) byCat[c] = (byCat[c] || 0) + 1;
  }
  // Ranked by ACTUAL attack/CT-action activity, never by raw event/article
  // volume -- see HIGH_SEVERITY_HUB_CATEGORIES above.
  const topCountries = Object.keys(totals)
    .sort((a, b) => (highSeverity[b] || 0) - (highSeverity[a] || 0) || totals[b] - totals[a])
    .slice(0, 10)
    .map(name => ({
      name,
      attacks_or_ct_action_events: highSeverity[name] || 0,
      total_events: totals[name],
      top_categories: Object.entries(categoriesByCountry[name])
        .sort((a, b) => b[1] - a[1]).slice(0, 3)
    }));
  return { event_count: events.length, categories: category, top_countries_by_attack_ct_action_activity: topCountries };
}

function priority(event) {
  const cats = eventCategories(event);
  let score = Number(event.ai_relevance_score || 0);
  if (cats.includes("Attacks")) score += 40;
  if (cats.includes("Counter Terrorism Action")) score += 35;
  if (cats.includes("Arrests")) score += 25;
  score += Math.min(20, Number(event.source_count || 1) * 3);
  return score;
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
}

async function gateCall(env, path, payload) {
  const id = env.REPORT_GATE.idFromName("global");
  const stub = env.REPORT_GATE.get(id);
  return stub.fetch("https://gate.internal" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

async function extractGeminiText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  if (Array.isArray(payload?.steps)) {
    const chunks = [];
    for (const step of payload.steps) {
      if (step?.type !== "model_output") continue;
      if (typeof step?.text === "string" && step.text.trim()) chunks.push(step.text);
      if (Array.isArray(step?.content)) {
        for (const part of step.content) {
          if (typeof part?.text === "string" && part.text.trim()) chunks.push(part.text);
        }
      }
    }
    if (chunks.length) return chunks.join("\n");
  }

  if (Array.isArray(payload?.outputs)) {
    const chunks = [];
    for (const item of payload.outputs) {
      if (typeof item?.text === "string" && item.text.trim()) chunks.push(item.text);
      if (Array.isArray(item?.content)) {
        for (const part of item.content) {
          if (typeof part?.text === "string" && part.text.trim()) chunks.push(part.text);
        }
      }
    }
    if (chunks.length) return chunks.join("\n");
  }

  if (Array.isArray(payload?.candidates)) {
    const parts = payload.candidates?.[0]?.content?.parts || [];
    const text = parts.map(part => part?.text || "").join("");
    if (text.trim()) return text;
  }

  const status = cleanText(payload?.status || "", 40);
  const detail = cleanText(
    payload?.error?.message ||
    payload?.failure_reason ||
    payload?.incomplete_details?.reason ||
    "",
    180
  );
  throw new Error(
    `Gemini returned no readable output${status ? ` (status: ${status})` : ""}${detail ? `: ${detail}` : "."}`
  );
}

async function callGemini(env, input) {
  const models = [];
  const primaryModel = env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  const fallbackModel = env.GEMINI_FALLBACK_MODEL || "gemini-3.6-flash";
  for (const model of [primaryModel, fallbackModel]) {
    if (model && !models.includes(model)) models.push(model);
  }

  let lastError = null;

  for (let attempt = 0; attempt < Math.max(3, models.length); attempt++) {
    const model = models[Math.min(attempt, models.length - 1)];
    const body = {
      model,
      input: "Produce the requested analytical report using only this JSON dataset:\n\n" + JSON.stringify(input),
      system_instruction: SYSTEM_INSTRUCTION,
      store: false,
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: REPORT_SCHEMA
      },
      generation_config: {
        max_output_tokens: 9000,
        thinking_level: "minimal"
      }
    };

    try {
      const response = await fetch(GEMINI_URL, {
        method: "POST",
        headers: {
          "x-goog-api-key": env.GEMINI_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });

      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`Gemini temporary error ${response.status} on ${model}`);
        await new Promise(r => setTimeout(r, (attempt + 1) * 2200));
        continue;
      }

      if (!response.ok) {
        throw new Error(`Gemini error ${response.status}: ${await response.text()}`);
      }

      const payload = await response.json();
      const status = String(payload?.status || "").toLowerCase();

      if (["failed", "cancelled"].includes(status)) {
        throw new Error(
          cleanText(payload?.error?.message || `Gemini interaction ${status}.`, 300)
        );
      }

      let raw;
      try {
        raw = await extractGeminiText(payload);
      } catch (error) {
        lastError = error;
        if (status === "incomplete" || attempt < 2) {
          await new Promise(r => setTimeout(r, (attempt + 1) * 1200));
          continue;
        }
        throw error;
      }

      const normalizedRaw = raw
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "");

      let parsed;
      try {
        parsed = JSON.parse(normalizedRaw);
      } catch (error) {
        lastError = new Error("Gemini returned text, but the report JSON could not be parsed.");
        console.error("Gemini JSON parse failure", {
          model,
          status: payload?.status,
          preview: normalizedRaw.slice(0, 500)
        });
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, (attempt + 1) * 1200));
          continue;
        }
        throw lastError;
      }

      if (!parsed?.analysis) {
        lastError = new Error("Gemini returned an empty report.");
        if (attempt < 2) continue;
        throw lastError;
      }

      return parsed;
    } catch (error) {
      lastError = error;
      if (attempt < 2 && /temporary|incomplete|no readable output|could not be parsed|empty report/i.test(String(error?.message || ""))) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 1200));
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error("Gemini request failed.");
}

export {
  GEMINI_URL,
  ALLOWED_PERIODS,
  REPORT_GENERATOR_VERSION,
  MAX_EVENTS_CURRENT,
  MAX_EVENTS_PREVIOUS,
  CACHE_TTL_MS,
  REPORT_COOLDOWN_MS,
  SESSION_TTL_MS,
  QUICK_ASK_COOLDOWN_MS,
  QUICK_ASK_DAILY_LIMIT,
  QUICK_ASK_GLOBAL_DAILY_LIMIT,
  FEEDBACK_COOLDOWN_MS,
  FEEDBACK_DAILY_LIMIT,
  FEEDBACK_GLOBAL_DAILY_LIMIT,
  USER_PASSWORD_HASHES,
  ALLOWED_USERS,
  getAllowedUsers,
  passwordHashForUser,
  authMode,
  REPORT_SCHEMA,
  SYSTEM_INSTRUCTION,
  corsHeaders,
  jsonResponse,
  cleanText,
  normalizeUsername,
  isAllowedUser,
  parisDayKey,
  usageTemplate,
  parseEventDate,
  eventCategories,
  matchesTopic,
  matchesRegion,
  compactEvent,
  citationMetrics,
  stats,
  priority,
  sha256,
  gateCall,
  extractGeminiText,
  callGemini
};
