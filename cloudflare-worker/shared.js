const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const ALLOWED_PERIODS = new Set([1, 7, 30, 90, 180]);
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
const REPORT_GENERATOR_VERSION = "report-v11-illustration";

// One roster secret, {"username":"sha256(password)"}, validated; throws on any problem.
function parseAuthRoster(raw, name) {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object.`);
  }

  const rawEntries = Object.entries(parsed);
  if (!rawEntries.length) {
    throw new Error(`${name} contains no users.`);
  }

  const entries = rawEntries.map(([username, hash]) => [
    normalizeUsername(username),
    String(hash || "").trim().toLowerCase()
  ]);
  const seen = new Set();

  for (const [username, hash] of entries) {
    if (
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(username) ||
      !/^[a-f0-9]{64}$/.test(hash)
    ) {
      throw new Error(`${name} contains an invalid username or SHA-256 hash.`);
    }
    if (seen.has(username)) {
      throw new Error(`${name} contains duplicate usernames.`);
    }
    seen.add(username);
  }

  return Object.fromEntries(entries);
}

function authUsersFromEnv(env) {
  const raw = String(env?.AUTH_USERS_JSON || "").trim();
  if (!raw) {
    console.error("AUTH_USERS_JSON is missing; rejecting all logins.");
    return Object.freeze({});
  }

  let users;
  try {
    users = parseAuthRoster(raw, "AUTH_USERS_JSON");
  } catch (error) {
    console.error("Invalid AUTH_USERS_JSON; rejecting all logins.", error);
    return Object.freeze({});
  }

  // Accounts added later live in a second secret: a Cloudflare secret cannot
  // be read back, so adding users never needs the first one. A username that
  // AUTH_USERS_JSON already holds keeps the password it has there, and a
  // broken second secret never locks out the first one's users.
  const extraRaw = String(env?.AUTH_USERS_EXTRA_JSON || "").trim();
  if (extraRaw) {
    try {
      for (const [username, hash] of Object.entries(parseAuthRoster(extraRaw, "AUTH_USERS_EXTRA_JSON"))) {
        if (!Object.hasOwn(users, username)) users[username] = hash;
      }
    } catch (error) {
      console.error("Invalid AUTH_USERS_EXTRA_JSON; its users are ignored.", error);
    }
  }

  return Object.freeze(users);
}

function getAllowedUsers(env) {
  return new Set(Object.keys(authUsersFromEnv(env)));
}

const REPORT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    analysis: { type: "string" }
  },
  required: ["title", "analysis"]
};

const SYSTEM_INSTRUCTION = `
You are producing an on-demand counter-terrorism criminal-intelligence
assessment from a deduplicated OSINT event database, supplemented by a wider
background-reporting corpus.

Write approximately 1,000-1,350 words in professional analytical English.
This is an ASSESSMENT, not a digest of events: explain what the pattern of
activity means, why it is likely happening, how developments connect, and
what they imply -- while staying strictly grounded in the supplied data.

Use these headings exactly, in this order:
EXECUTIVE ASSESSMENT
KEY DEVELOPMENTS
GEOGRAPHIC PATTERNS
TACTICS / MODUS OPERANDI
COUNTER-TERRORISM RESPONSE
SIGNIFICANT CHANGES
ANALYTICAL INTERPRETATION
STRATEGIC CONTEXT
OUTLOOK / WATCHPOINTS
SOURCE / CONFIDENCE NOTES

The selection block lists the analyst's filters (region or country, topic,
actor_group, period). Keep the whole assessment within them; when an
actor_group is selected, the report is about that group's activity.

EXECUTIVE ASSESSMENT: 3-5 sentences giving the bottom line up front -- the
most important judgements about the threat picture, not a list of events.

ANALYTICAL INTERPRETATION is the core added value of this report. Where the
data supports it, cover: the likely drivers and enabling conditions behind
the observed activity; links between developments (same actor, network,
corridor or target set; action and reaction between attacks and CT
operations); what the activity suggests about actors' intent, capability and
adaptation; and at least one plausible alternative explanation for the main
pattern. Express every judgement with estimative language (almost certainly,
likely, roughly even chance, unlikely) and an explicit confidence level (low,
moderate or high confidence), cite the records each judgement rests on, and
keep what the records show visibly separate from what you assess.

STRATEGIC CONTEXT: situate the CT picture in its wider political, security
and geopolitical setting, drawing on background_context items. If
background_context.items is empty, keep this section to 2-3 sentences based
only on the priority events and state that no wider context corpus was
available for this report.

OUTLOOK / WATCHPOINTS: name concrete indicators that would confirm or
contradict the main judgements above.

When a comparison period is supplied, focus on WHAT CHANGED between the current
period and the immediately preceding equivalent period. Distinguish reporting volume from evidence of an actual operational change.
ARTICLES measure reporting; records measure developments; distinct incident_id
values measure operational cases. Never use record/article counts as a proxy
for attack counts.

HUB / HOTSPOT RULE (critical -- this has been a real error in past reports):
in GEOGRAPHIC PATTERNS, never call a country or region a "hub", an "emerging
hotspot", or otherwise newly significant merely because it has a high
event_count or article count. Reporting volume can rise simply because a
country's press produces a lot of routine wire copy (many short items about
the same court case, minor detentions, or a story simply getting picked up
and translated by many outlets) -- none of that reflects real operational
activity on the ground. A location only qualifies as a hub/hotspot when
top_countries_by_incident_activity shows genuinely high DISTINCT operational
incident counts. unique_attacks counts only incident IDs whose current record
was explicitly classified primary_event_type=ATTACK and is_attack=true.
Attempted attacks, disrupted plots, CT operations, arrests and judicial cases
are separate measures. reporting_records is collection/reporting volume only
and MUST NEVER be treated as attack frequency or threat intensity. When you cite a country as significant, name
whether that significance comes from attacks it suffered, combat CT
operations conducted there, or something else -- never leave it ambiguous
whether you mean "lots of attacks happened here" versus "lots of articles
were written about here".

Prioritise concrete countries, regions, cities, attacks, offensive/combat
counter-terrorism operations, clashes, disrupted plots, weapons/explosives,
terrorist financing, CBRN, cyber and emerging-technology developments when
materially relevant to the selected topic.

Do not invent facts, casualty figures, attribution, coordination, causes or
predictions. Preserve uncertainty. Use only the supplied records, statistics
and background context. Interpretation is expected, but every assessment
must be traceable to cited data and labelled with its confidence; the
outlook may identify watchpoints but must not make unsupported forecasts.

BACKGROUND CONTEXT RULES:
- background_context.items are NOT verified map events. Each has a kind:
  related_article = another outlet's report on an incident already in
  priority_events (covers_source_id names it): use it for corroboration,
  extra detail, or to flag differing accounts.
  rejected_candidate / historical_review = reporting the map's selection
  judged outside its operational CT scope (map_exclusion_reason says why,
  e.g. interstate diplomacy, state military conflict, ordinary crime): use
  it only as background context, never as a CT incident.
  removed_event = commentary or analysis pieces: cite them only as the view
  of commentators ("analysts argue ... [C04]"), never as established fact.
  archived_incident = a CT incident report that passed the map's own
  selection but is not one of priority_events (e.g. older than the map's
  180-day window, or found later by the archive enrichment; incident_note
  says what it reports): cite it as that outlet's reporting ("X reported
  ... [C05]"). When covers_source_id names a record, it is one more report
  of that same incident: corroboration of it, never a second incident.
- Never count context items in incident, attack, arrest or operation
  figures, and never let context alone establish that an attack happened.
- Ignore context items that are irrelevant to the selected region and topic.

CITATION RULES (this is how the analyst checks the report against real
sources and catches hallucination -- follow exactly):
- Every priority_events record carries a source_id like "S01"; every
  background_context item carries a context_id like "C01". Cite them in
  brackets immediately after the claim they support, exactly like [S01],
  [S01, S07] or [S03, C02]. Never invent an id that was not supplied.
- Every factual sentence or bullet in EXECUTIVE ASSESSMENT, KEY
  DEVELOPMENTS, GEOGRAPHIC PATTERNS, TACTICS / MODUS OPERANDI,
  COUNTER-TERRORISM RESPONSE, SIGNIFICANT CHANGES, ANALYTICAL
  INTERPRETATION and STRATEGIC CONTEXT must carry at least one citation. A
  sentence with no citation is read as your own unsupported inference, not
  a database fact -- avoid that.
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
  return String(env?.AUTH_USERS_JSON || "").trim() ? "secret" : "secret-missing";
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
    report_generator_requests: 0,
    deep_search_requests: 0,
    reports_generated: 0,
    cached_reports: 0,
    blocked_report_requests: 0,
    quick_ask_requests: 0,
    blockchain_searches: 0,
    facial_extractions: 0,
    facial_searches: 0,
    darkweb_searches: 0,
    ip_lookups: 0,
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

// Same aliases as the map's CATEGORY_ALIASES, from the database's side: the
// map labels piracy "Maritime Security" and folds the two legacy digital
// categories into "Online / Cyber / AI", so a topic picked in the Database
// panel must match those records too.
const TOPIC_ALIASES = Object.freeze({
  "maritime security": "maritime piracy",
  "online radicalization / cyberterrorism": "online / cyber / ai",
  "disinformation / emerging technologies / ai": "online / cyber / ai"
});

function canonicalTopic(value) {
  const key = String(value || "").trim().toLowerCase();
  return TOPIC_ALIASES[key] || key;
}

function matchesTopic(event, topic) {
  if (!topic || topic === "ALL") return true;
  const wanted = canonicalTopic(topic);
  if (wanted === "radnuc") {
    return eventCategories(event).some(category => canonicalTopic(category) === "cbrn")
      && Array.isArray(event.cbrn_subgroups) && event.cbrn_subgroups.includes("RADNUC")
      && event.actor_scope !== "STATE_ONLY";
  }
  return eventCategories(event).some(category => canonicalTopic(category) === wanted);
}

// Mirrors the map's eventActorGroup(): an event with no named group belongs to
// the "Unspecified / no named group" bucket, which is itself selectable.
const UNSPECIFIED_GROUP_LABEL = "Unspecified / no named group";

function eventActorGroup(event) {
  return cleanText(event?.actor_group, 100) || UNSPECIFIED_GROUP_LABEL;
}

function matchesGroup(event, group) {
  if (!group || group === "ALL") return true;
  return eventActorGroup(event).toLowerCase() === String(group).trim().toLowerCase();
}

// Event ids are NOT unique: until October 2026 the collector derived them from
// a Latin-only normalised title plus the date, so every non-Latin headline of a
// day shared one id (dozens of events). New events get unique ids, but the old
// ones keep theirs until the 180-day retention drops them (spring 2027).
// Anything that joins two copies of the same event (map <-> Database list,
// external article <-> database evidence) must use this key instead; the map
// page builds the identical key (eventMatchKey).
function eventUniqueKey(event) {
  const time = Date.parse(String(event?.published || ""));
  return [
    cleanText(event?.id, 120),
    Number.isFinite(time) ? time : "",
    cleanText(event?.title, 120)
  ].join("|");
}

// "Same story" -- one rule for Deep Search's evidence, the archive context of
// the Report Generator and Atlas AI, and the archive itself
// (tools/archive_dedup.py, locked to this file by tests/same_story_cases.json):
// within 5 days, the same link, the same normalised title, or titles sharing
// 4+ significant words with a Jaccard similarity >= 0.62 or a containment
// >= 0.78 (Jaccard >= 0.8 when neither headline has letter case) -- unless
// their counts differ (6 vs 49 killed) or they name different places or people
// (Tyumen vs Chuvashia resident, Hamburg vs Munich station). When in doubt the
// rule keeps two stories: a spare copy costs less than a lost incident.
const SAME_STORY_WINDOW_DAYS = 5;
const TITLE_STOPWORDS = new Set(("the a an and or of to in on at for from with after over into as by is are was were be " +
  "says said new latest report reports update updates").split(" "));
// Latin accents, and the Arabic short vowels and hamza marks outlets write
// or leave out (أفغانستان / افغانستان).
const ACCENTS = /[\u0300-\u036f\u064b-\u065f\u0670]/g;

function normalizeTitle(value) {
  return String(value || "").normalize("NFKD").replace(ACCENTS, "")
    .toLowerCase().replace(/https?:\/\/\S+/g, " ")
    // \p{M} keeps the vowel signs and viramas of Indic scripts inside their words.
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .split(/\s+/).filter(token => token && !TITLE_STOPWORDS.has(token)).join(" ");
}

// Deep Search compares hundreds of headlines pairwise: each title is
// normalised once per isolate, not once per comparison. Bounded so a
// long-lived isolate never accumulates every headline it has seen.
const STORY_CACHE_LIMIT = 5000;
const normalizedTitles = new Map();
const titleTokenSets = new Map();

function remember(cache, key, compute) {
  let value = cache.get(key);
  if (value === undefined) {
    if (cache.size >= STORY_CACHE_LIMIT) cache.clear();
    value = compute();
    cache.set(key, value);
  }
  return value;
}

function cachedNormalizedTitle(value) {
  const key = String(value || "");
  return remember(normalizedTitles, key, () => normalizeTitle(key));
}

// Callers only read the returned set. Lengths count characters (code points),
// as tools/archive_dedup.py does.
function titleTokens(value) {
  const key = String(value || "");
  return remember(titleTokenSets, key,
    () => new Set(cachedNormalizedTitle(key).split(" ").filter(token => Array.from(token).length >= 3)));
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

// Opening words that name nothing ("Breaking:", "Eilmeldung:").
const GENERIC_OPENERS = new Set(("breaking urgent update updated exclusive watch video live latest flash alert analysis opinion " +
  "editorial explainer photos eilmeldung aktuell urgente ultima dernier derniere alerte info son dakika srochno").split(" "));
const NUMBER_WORDS = new Map(("one two three four five six seven eight nine ten eleven twelve thirteen fourteen " +
  "fifteen sixteen seventeen eighteen nineteen twenty").split(" ").map((word, index) => [word, String(index + 1)]));
// Mostly-capitalised headlines (Title Case, all caps) carry no case signal.
const TITLE_CASE_SHARE = 0.7;
// Donetsk / Volzhsky "Resident Detained for Justifying Terrorism" share 4 of
// 7 words: without a case signal that is not enough.
const NO_CASE_SIGNAL_MIN_JACCARD = 0.8;
// Zero code points of the decimal digit blocks headlines use (ASCII,
// Arabic-Indic, Persian, N'Ko, Indic scripts, Thai, Lao, Tibetan, Myanmar,
// Khmer, Mongolian, fullwidth); tools/archive_dedup.py maps the same blocks.
const DIGIT_ZEROS = [0x30, 0x660, 0x6F0, 0x7C0, 0x966, 0x9E6, 0xA66, 0xAE6, 0xB66, 0xBE6, 0xC66, 0xCE6,
  0xD66, 0xDE6, 0xE50, 0xED0, 0xF20, 0x1040, 0x1090, 0x17E0, 0x1810, 0xFF10];

// Decimal digits of the usual scripts as ASCII (Arabic 3 and Persian 3 are 3).
function asciiDigits(text) {
  return Array.from(String(text || ""), ch => {
    const code = ch.codePointAt(0);
    const zero = DIGIT_ZEROS.find(start => code >= start && code <= start + 9);
    return zero === undefined ? ch : String.fromCharCode(0x30 + code - zero);
  }).join("");
}
const IN_WORD_APOSTROPHE = /(?<=[\p{L}\p{N}])['\u2019\u02bc](?=[\p{L}\p{N}])/gu;

const firstChar = word => String.fromCodePoint(word.codePointAt(0));
const isUpper = ch => /\p{Lu}/u.test(ch);
const isLower = ch => /\p{Ll}/u.test(ch);
const charLength = word => Array.from(word).length;

// The headline's words, accents folded, in-word apostrophes removed
// (Sana'a -> Sanaa), original case kept.
function headlineWords(value) {
  return String(value || "").normalize("NFKD").replace(ACCENTS, "")
    .replace(/https?:\/\/\S+/g, " ").replace(IN_WORD_APOSTROPHE, "")
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// Capital letters mark names only in a sentence-case headline: not in a
// Title Case or all-caps one, nor in a script without case.
function hasCaseSignal(value) {
  const significant = headlineWords(value)
    .filter(word => charLength(word) >= 3 && !TITLE_STOPWORDS.has(word.toLowerCase()));
  const cased = significant.filter(word => isUpper(firstChar(word)) || isLower(firstChar(word)));
  if (!cased.length) return false;
  const capitalised = cased.filter(word => isUpper(firstChar(word))).length;
  return capitalised / cased.length < TITLE_CASE_SHARE;
}

function isNameWord(word) {
  const length = charLength(word);
  if (!isUpper(firstChar(word))) return false;
  return length >= 3 || (length === 2 && word === word.toUpperCase());
}

// The places and people a headline names: its capitalised significant words
// (two-letter acronyms such as KP included, the first word too unless it is a
// generic opener), lower-cased. None from a headline without a case signal.
function properNounTokens(value) {
  if (!hasCaseSignal(value)) return new Set();
  const names = new Set();
  headlineWords(value).forEach((word, position) => {
    const lowered = word.toLowerCase();
    if (!isNameWord(word) || TITLE_STOPWORDS.has(lowered)) return;
    if (position === 0 && GENERIC_OPENERS.has(lowered)) return;
    names.add(lowered);
  });
  return names;
}

function wordSpace(value) {
  const space = new Set(titleTokens(value));
  for (const word of headlineWords(value)) if (charLength(word) >= 2) space.add(word.toLowerCase());
  return space;
}

// A word of one headline found in the other: equal, or the same first five
// letters ("Somali" / "Somalia").
function sharesWord(word, words) {
  const chars = Array.from(word);
  for (const other of words) {
    if (other === word) return true;
    const otherChars = Array.from(other);
    if (chars.length >= 5 && otherChars.length >= 5 && otherChars.slice(0, 5).join("") === chars.slice(0, 5).join("")) return true;
  }
  return false;
}

// The headlines name different places or people ("...in Hamburg station" /
// "...in Munich station"): two stories. Each must name something the other
// lacks; when one has no case signal (a Title Case "Chuvashia Resident
// Sentenced..."), a name of the other missing from it is enough ("Tyumen
// resident sentenced...").
function namesDiffer(a, b) {
  const aSpace = wordSpace(a), bSpace = wordSpace(b);
  const onlyA = [...properNounTokens(a)].filter(word => !sharesWord(word, bSpace));
  const onlyB = [...properNounTokens(b)].filter(word => !sharesWord(word, aSpace));
  if (hasCaseSignal(a) && hasCaseSignal(b)) return onlyA.length > 0 && onlyB.length > 0;
  return onlyA.length > 0 || onlyB.length > 0;
}

// The counts a headline gives (digits, or English number words up to
// twenty), leading zeros dropped.
function titleCounts(value) {
  const text = String(value || "");
  const counts = new Set((asciiDigits(text).match(/[0-9]+/g) || []).map(digits => digits.replace(/^0+(?=.)/, "")));
  for (const word of normalizeTitle(text).split(" ")) if (NUMBER_WORDS.has(word)) counts.add(NUMBER_WORDS.get(word));
  return counts;
}

// Both headlines give counts and none is common: "6 terrorists killed" and
// "49 terrorists killed" are two operations.
function countsDiffer(a, b) {
  const aCounts = titleCounts(a), bCounts = titleCounts(b);
  if (!aCounts.size || !bCounts.size) return false;
  for (const count of aCounts) if (bCounts.has(count)) return false;
  return true;
}

// The shared-words part of the same-story rule. Without a case signal on
// either side (Title Case, all caps, a script without capitals) the names
// guard cannot work, so the shared words alone must be overwhelming.
function similarTitles(a, b) {
  const sim = tokenSimilarity(a, b);
  if (sim.shared < 4) return false;
  if (!hasCaseSignal(a) && !hasCaseSignal(b)) {
    if (sim.jaccard < NO_CASE_SIGNAL_MIN_JACCARD) return false;
  } else if (sim.jaccard < 0.62 && sim.containment < 0.78) {
    return false;
  }
  return !countsDiffer(a, b) && !namesDiffer(a, b);
}

// a, b: { title, url, date }; a missing date never rules a pair out.
function isSameStory(a, b) {
  const gap = dateDistanceDays(a?.date, b?.date);
  if (gap !== null && gap > SAME_STORY_WINDOW_DAYS) return false;
  if (a?.url && b?.url && a.url === b.url) return true;
  const normalized = cachedNormalizedTitle(a?.title);
  if (normalized && normalized === cachedNormalizedTitle(b?.title)) return true;
  return similarTitles(a?.title, b?.title);
}

// The Database panel's filters as sent by Atlas AI and Deep Search (the
// Report Generator reads the same fields but validates its own period).
// An unknown or missing period means "no period filter".
function parseDatabaseFilters(body) {
  const periodDays = Number(body?.period_days);
  return {
    region: cleanText(body?.region || "GLOBAL", 100) || "GLOBAL",
    topic: cleanText(body?.topic || "ALL", 120) || "ALL",
    actorGroup: cleanText(body?.actor_group || "ALL", 100) || "ALL",
    periodDays: ALLOWED_PERIODS.has(periodDays) ? periodDays : null
  };
}

function hasActiveDatabaseFilters(filters) {
  return filters.region !== "GLOBAL" || filters.topic !== "ALL" ||
    filters.actorGroup !== "ALL" || Boolean(filters.periodDays);
}

function matchesDatabaseFilters(event, filters, now = new Date(), { ignorePeriod = false } = {}) {
  if (!matchesRegion(event, filters.region) || !matchesTopic(event, filters.topic) ||
      !matchesGroup(event, filters.actorGroup)) return false;
  if (ignorePeriod || !filters.periodDays) return true;
  const date = parseEventDate(event);
  if (!date) return false;
  const time = date.getTime();
  return time <= now.getTime() && time >= now.getTime() - filters.periodDays * 86400000;
}

function databaseFiltersLabel(filters) {
  const parts = [
    filters.region === "GLOBAL" ? "Global" : filters.region.replace(/^REGION:/, "").replace(/_/g, " "),
    filters.topic === "ALL" ? "all categories" : filters.topic,
    filters.actorGroup === "ALL" ? "all groups" : filters.actorGroup,
    filters.periodDays ? (filters.periodDays === 1 ? "last 24 hours" : `last ${filters.periodDays} days`) : "any date"
  ];
  return parts.join(" · ");
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
    primary_event_type: cleanText(event.primary_event_type, 40),
    is_attack: event.is_attack === true,
    incident_id: cleanText(event.incident_id, 80),
    incident_anchor: cleanText(event.incident_anchor, 220),
    update_type: cleanText(event.update_type, 40),
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
// Ids are S01-S999 for event records and C01-C999 for background context
// items; reports can carry more than 99 sources (80 current + 60 previous).
function citationMetrics(analysis, validIds) {
  const valid = new Set(validIds);
  const cited = new Set();
  for (const match of String(analysis || "").matchAll(/\[([SC]\d{2,3})(?:,\s*[SC]\d{2,3})*\]/g)) {
    const ids = match[0].match(/[SC]\d{2,3}/g) || [];
    ids.forEach(id => { if (valid.has(id)) cited.add(id); });
  }
  const paragraphs = String(analysis || "").split(/\n+/).map(v => v.trim())
    .filter(v => v && !/^[A-Z][A-Z /&-]{4,}$/.test(v));
  const factual = paragraphs.filter(v => v.length >= 35);
  const grounded = factual.filter(v => /\[[SC]\d{2,3}/.test(v));
  return {
    cited_source_ids: [...cited],
    citation_coverage_percent: factual.length ? Math.round(grounded.length / factual.length * 100) : 100,
    cited_sources: cited.size,
    factual_paragraphs: factual.length,
    cited_factual_paragraphs: grounded.length
  };
}

function stats(events) {
  const category = {};
  const reportingRecords = {};
  const incidentSets = {};

  const bucket = (country, type) => {
    incidentSets[country] ||= {};
    incidentSets[country][type] ||= new Set();
    return incidentSets[country][type];
  };

  for (const e of events) {
    for (const c of eventCategories(e)) category[c] = (category[c] || 0) + 1;
    const country = cleanText(e.country, 80);
    if (!country) continue;

    reportingRecords[country] = (reportingRecords[country] || 0) + 1;
    const incidentId = cleanText(e.incident_id || e.id || e._mapKey || "", 100);
    if (!incidentId) continue;

    const primary = cleanText(e.primary_event_type || "OTHER_CT", 40).toUpperCase();
    if (e.is_attack === true && primary === "ATTACK") {
      bucket(country, "ATTACK").add(incidentId);
    } else {
      bucket(country, primary).add(incidentId);
    }
  }

  const count = (country, type) => incidentSets[country]?.[type]?.size || 0;
  const countries = Object.keys(reportingRecords)
    .sort((a, b) =>
      count(b, "ATTACK") - count(a, "ATTACK") ||
      count(b, "CT_OPERATION") - count(a, "CT_OPERATION") ||
      count(b, "DISRUPTED_PLOT") - count(a, "DISRUPTED_PLOT") ||
      a.localeCompare(b)
    )
    .slice(0, 10)
    .map(name => ({
      name,
      unique_attacks: count(name, "ATTACK"),
      attempted_attacks: count(name, "ATTEMPTED_ATTACK"),
      disrupted_plots: count(name, "DISRUPTED_PLOT"),
      unique_ct_operations: count(name, "CT_OPERATION"),
      arrest_cases: count(name, "ARREST"),
      judicial_cases: count(name, "JUDICIAL"),
      financing_cases: count(name, "FINANCING"),
      weapons_cases: count(name, "WEAPONS"),
      reporting_records: reportingRecords[name]
    }));

  return {
    record_count: events.length,
    categories: category,
    top_countries_by_incident_activity: countries
  };
}

function priority(event) {
  const cats = eventCategories(event);
  let score = Number(event.ai_relevance_score || 0);
  const primary = cleanText(event.primary_event_type || "", 40).toUpperCase();
  if (event.is_attack === true && primary === "ATTACK") score += 40;
  if (primary === "CT_OPERATION") score += 35;
  if (primary === "DISRUPTED_PLOT" || primary === "ATTEMPTED_ATTACK") score += 30;
  if (primary === "ARREST") score += 20;
  score += Math.min(20, Number(event.source_count || 1) * 3);
  return score;
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
}

let euGateMigrationPromise = null;

function reportGateStub(env, jurisdiction = "") {
  const namespace = jurisdiction && typeof env.REPORT_GATE?.jurisdiction === "function"
    ? env.REPORT_GATE.jurisdiction(jurisdiction)
    : env.REPORT_GATE;
  const id = namespace.idFromName("global");
  return namespace.get(id);
}

async function rawGateFetch(stub, path, payload = {}) {
  return stub.fetch("https://gate.internal" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

async function ensureEuGateMigrated(env) {
  if (typeof env.REPORT_GATE?.jurisdiction !== "function") return;
  if (euGateMigrationPromise) return euGateMigrationPromise;

  euGateMigrationPromise = (async () => {
    const euStub = reportGateStub(env, "eu");
    const statusResponse = await rawGateFetch(euStub, "/migration-status");
    const status = await statusResponse.json().catch(() => ({}));
    if (statusResponse.ok && status?.migrated) return;

    const legacyStub = reportGateStub(env);
    let startAfter = "";
    let imported = 0;

    for (let page = 0; page < 1000; page++) {
      const exportResponse = await rawGateFetch(legacyStub, "/migration-export", { start_after: startAfter });
      const exported = await exportResponse.json().catch(() => ({}));
      if (!exportResponse.ok || !exported?.ok) {
        throw new Error("Unable to export legacy CT Atlas Durable Object state.");
      }

      const entries = Array.isArray(exported.entries) ? exported.entries : [];
      if (entries.length) {
        const importResponse = await rawGateFetch(euStub, "/migration-import", { entries });
        const importedPayload = await importResponse.json().catch(() => ({}));
        if (!importResponse.ok || !importedPayload?.ok) {
          throw new Error("Unable to import CT Atlas state into EU Durable Object.");
        }
        imported += Number(importedPayload.imported || 0);
      }

      if (!exported.has_more || !exported.last_key || exported.last_key === startAfter) break;
      startAfter = exported.last_key;
    }

    const finalizeResponse = await rawGateFetch(euStub, "/migration-finalize", { imported });
    if (!finalizeResponse.ok) throw new Error("Unable to finalize CT Atlas EU Durable Object migration.");

    // Remove the legacy copy only after the EU object is fully populated and marked complete.
    const retireResponse = await rawGateFetch(legacyStub, "/migration-retire", {});
    if (!retireResponse.ok) {
      console.warn("CT Atlas EU migration completed, but legacy Durable Object retirement failed.");
    }
  })().catch(error => {
    euGateMigrationPromise = null;
    throw error;
  });

  return euGateMigrationPromise;
}

async function gateCall(env, path, payload) {
  await ensureEuGateMigrated(env);
  const stub = reportGateStub(env, typeof env.REPORT_GATE?.jurisdiction === "function" ? "eu" : "");
  return rawGateFetch(stub, path, payload);
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

const GEMINI_RETRY_BASE_DELAY_MS = 1000;
const GEMINI_RETRY_MAX_DELAY_MS = 8000;

function geminiRetryAfterMs(response) {
  const value = String(response?.headers?.get?.("retry-after") || "").trim();
  if (!value) return null;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  if (!Number.isFinite(delay)) return null;
  return Math.max(0, Math.min(GEMINI_RETRY_MAX_DELAY_MS, delay));
}

function geminiRetryDelayMs(attempt, response) {
  const retryAfter = geminiRetryAfterMs(response);
  if (retryAfter !== null) return retryAfter;
  const base = Math.min(GEMINI_RETRY_MAX_DELAY_MS, GEMINI_RETRY_BASE_DELAY_MS * (2 ** attempt));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

async function waitBeforeGeminiRetry(attempt, response, lastAttempt) {
  if (attempt >= lastAttempt) return;
  await new Promise(resolve => setTimeout(resolve, geminiRetryDelayMs(attempt, response)));
}

// The interactive features' last fallback. Gemini 3.1 Flash Lite has its own free
// quota (500 requests/day), separate from 3.5 Flash Lite (primary) and 3.6 Flash
// (first fallback, 20/day); the background jobs that share it stay under 400/day.
const GEMINI_SECOND_FALLBACK_MODEL = "gemini-3.1-flash-lite";

// Picks the model for each attempt of one Gemini request: the models take turns,
// and one that answered 429 (its quota is spent) is skipped while another remains.
function geminiModelRotation(models) {
  const order = models.filter((model, index) => model && models.indexOf(model) === index);
  const spent = new Set();
  let next = 0;
  return {
    next() {
      for (let step = 0; step < order.length; step++) {
        const index = (next + step) % order.length;
        if (!spent.has(order[index]) || spent.size >= order.length) {
          next = index + 1;
          return order[index];
        }
      }
      return order[0];
    },
    spent(model) {
      spent.add(model);
    }
  };
}

async function callGemini(env, input) {
  const primaryModel = env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  const defaultFallback = primaryModel === "gemini-3.6-flash"
    ? "gemini-3.5-flash-lite"
    : "gemini-3.6-flash";
  const fallbackModel = env.GEMINI_FALLBACK_MODEL || defaultFallback;
  const rotation = geminiModelRotation([
    primaryModel,
    fallbackModel,
    env.GEMINI_SECOND_FALLBACK_MODEL || GEMINI_SECOND_FALLBACK_MODEL
  ]);
  const maxAttempts = 5;
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const model = rotation.next();
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
        if (response.status === 429) rotation.spent(model);
        lastError = new Error(`Gemini temporary error ${response.status} on ${model}`);
        await waitBeforeGeminiRetry(attempt, response, maxAttempts - 1);
        continue;
      }

      if (!response.ok) {
        throw new Error(`Gemini error ${response.status}: ${await response.text()}`);
      }

      const payload = await response.json();
      const status = String(payload?.status || "").toLowerCase();
      if (["failed", "cancelled"].includes(status)) {
        throw new Error(cleanText(payload?.error?.message || `Gemini interaction ${status}.`, 300));
      }

      let raw;
      try {
        raw = await extractGeminiText(payload);
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts - 1 && (status === "incomplete" || /no readable output/i.test(String(error?.message || "")))) {
          await waitBeforeGeminiRetry(attempt, null, maxAttempts - 1);
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
        if (attempt < maxAttempts - 1) {
          await waitBeforeGeminiRetry(attempt, null, maxAttempts - 1);
          continue;
        }
        throw lastError;
      }

      if (!parsed?.analysis) {
        lastError = new Error("Gemini returned an empty report.");
        if (attempt < maxAttempts - 1) {
          await waitBeforeGeminiRetry(attempt, null, maxAttempts - 1);
          continue;
        }
        throw lastError;
      }
      return parsed;
    } catch (error) {
      lastError = error;
      const retryable = error instanceof TypeError ||
        /temporary|incomplete|no readable output|could not be parsed|empty report/i.test(String(error?.message || ""));
      if (attempt < maxAttempts - 1 && retryable) {
        await waitBeforeGeminiRetry(attempt, null, maxAttempts - 1);
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error("Gemini request failed.");
}
// Reads the events database for reports, Quick Ask and Deep Search. It prefers
// events-lite.json (only the event fields the Worker reads, ~64% smaller; built at
// publication time from the very events.json being deployed, so it is never older than
// it) and falls back to the full events.json when the lite file is not configured,
// missing, unreachable or unusable. Result: { ok, status, db, source }.
async function fetchEventsDatabase(env, { minVersion = "" } = {}) {
  const required = Date.parse(minVersion);
  const currentEnough = db => !Number.isFinite(required)
    || Date.parse(db?.last_updated || db?.updated_at || "") >= required;
  const normalOptions = { cf: { cacheTtl: 60, cacheEverything: true } };
  const freshOptions = { cache: "no-store", cf: { cacheTtl: 0, cacheEverything: true } };

  async function read(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) return { ok: false, status: response.status, db: null };
    const db = await response.json();
    const events = Array.isArray(db) ? db : db?.events;
    return { ok: Array.isArray(events) && events.length > 0, status: response.status, db };
  }
  async function load(url) {
    const result = await read(url, normalOptions);
    if (!result.ok || currentEnough(result.db)) return result;
    // The map has a newer published snapshot. A versioned URL bypasses both
    // the Worker cache and an upstream cache of the unversioned static file.
    const freshUrl = new URL(url);
    freshUrl.searchParams.set("ct_atlas_version", String(required));
    const fresh = await read(freshUrl.toString(), freshOptions);
    return currentEnough(fresh.db) ? fresh : { ok: false, status: 503, db: null };
  }

  if (env.EVENTS_LITE_URL) {
    try {
      const lite = await load(env.EVENTS_LITE_URL);
      if (lite.ok) return { ...lite, source: "lite" };
    } catch (_) { /* Fall through to the full database. */ }
  }
  try {
    const full = await load(env.EVENTS_URL);
    return { ...full, source: "full" };
  } catch (_) {
    return { ok: false, status: 503, db: null, source: "full" };
  }
}

export {
  GEMINI_URL,
  GEMINI_SECOND_FALLBACK_MODEL,
  geminiModelRotation,
  fetchEventsDatabase,
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
  matchesGroup,
  eventActorGroup,
  eventUniqueKey,
  normalizeTitle,
  titleTokens,
  tokenSimilarity,
  dateDistanceDays,
  isSameStory,
  UNSPECIFIED_GROUP_LABEL,
  parseDatabaseFilters,
  hasActiveDatabaseFilters,
  matchesDatabaseFilters,
  databaseFiltersLabel,
  matchesRegion,
  compactEvent,
  citationMetrics,
  stats,
  priority,
  sha256,
  gateCall,
  extractGeminiText,
  callGemini,
  waitBeforeGeminiRetry
};


