// The Database panel's event list and exports: the Worker filters the whole
// events database (every category, not just the attacks the map shows) with
// exactly the place / category / group / period rules the Report Generator
// uses, so an exported list and a report on the same filters cover the same
// events -- and the browser never downloads the full database to do it.
import {
  cleanText,
  jsonResponse,
  gateCall,
  normalizeUsername,
  isAllowedUser,
  fetchEventsDatabase,
  parseEventDate,
  eventCategories,
  eventActorGroup,
  eventUniqueKey,
  matchesGroup,
  parseDatabaseFilters,
  matchesDatabaseFilters,
  databaseFiltersLabel
} from "./shared.js";

const DATABASE_QUERY_VERSION = "database-query-v5-unified-background";
// Everything the database holds today fits (180 days, ~4-5k events); the cap
// only guards against a runaway response if the database grows a lot.
const MAX_DATABASE_RESULTS = 8000;
const MAX_BACKGROUND_RESULTS = 8000; // Same export ceiling as operational rows.
const RADNUC_CATEGORY = "Radiological/Nuclear";
const BACKGROUND_SCOPE_SQL = `kind = 'radnuc_background'
  AND category = 'Radiological/Nuclear' AND primary_event_type = 'BACKGROUND_INFO'`;
// SQLite understands both ISO Z and +00:00 timestamps. Empty or invalid
// publication dates use the collection date, without a publisher location.
const BACKGROUND_DATE_SQL = "COALESCE(julianday(NULLIF(TRIM(published), '')), julianday(collected_at))";

function parisDayBounds(now) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  });
  const parts = date => Object.fromEntries(formatter.formatToParts(date)
    .filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
  const today = parts(now);
  const date = `${today.year}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}`;
  // Resolve each calendar midnight independently: Paris has 23- and 25-hour
  // days when daylight saving changes, so tomorrow is not always +24 hours.
  const midnight = wallTime => {
    let utcTime = wallTime;
    for (let attempt = 0; attempt < 3; attempt++) {
      const local = parts(new Date(utcTime));
      const represented = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
      const adjustment = represented - wallTime;
      if (!adjustment) break;
      utcTime -= adjustment;
    }
    return new Date(utcTime).toISOString();
  };
  return {
    date,
    start: midnight(Date.UTC(today.year, today.month - 1, today.day)),
    end: midnight(Date.UTC(today.year, today.month - 1, today.day + 1))
  };
}

function backgroundArticleRow(row, index = 0) {
  const url = cleanText(row.url, 1200);
  return {
    key: `bg-${index}`,
    match_key: `background:${url || index}`,
    id: `radnuc-background-${index}`,
    title: cleanText(row.title, 400),
    summary: cleanText(row.summary, 900),
    source: cleanText(row.source, 140),
    url: /^https?:\/\//i.test(url) ? url : "",
    published: cleanText(row.published, 40),
    collected_at: cleanText(row.collected_at, 40),
    original_language: cleanText(row.original_language, 12),
    kind: "radnuc_background",
    category: RADNUC_CATEGORY,
    categories: [RADNUC_CATEGORY],
    archive_only: true,
    excluded_from_map: true,
    primary_event_type: "BACKGROUND_INFO",
    location_precision: "unlocated",
    ai_relevance_score: null,
    source_count: 1,
    article_count: 1,
    latitude: null,
    longitude: null
  };
}

async function fetchRadnucBackground(env, filters, now) {
  const day = parisDayBounds(now);
  const empty = {
    available: false, included: false, total: 0, truncated: false,
    added_today_count: 0, today_date: day.date, items: []
  };
  // These records have no incident actor or event location. Showing them as
  // matching a country/group would invent evidence. Global All categories
  // and RadNuc lists include these records alongside operational records.
  if (filters.topic !== "ALL" && filters.topic !== RADNUC_CATEGORY) return { ...empty, reason: "category_filter" };
  if (filters.region !== "GLOBAL" || filters.actorGroup !== "ALL") return { ...empty, reason: "scope_filter" };
  const unavailable = { ...empty, included: true, reason: "unavailable" };
  const db = env.BACKGROUND_DB;
  if (!db?.prepare) return unavailable;

  const periodSql = filters.periodDays ? `${BACKGROUND_DATE_SQL} >= julianday(?) AND ${BACKGROUND_DATE_SQL} <= julianday(?)` : "1 = 1";
  const periodArgs = filters.periodDays
    ? [new Date(now.getTime() - filters.periodDays * 86400000).toISOString(), now.toISOString()]
    : [];
  // The collection-day count is independent of the publication filter: an
  // article saved today can have been published yesterday. Both date labels
  // are exposed so the UI can distinguish them.
  const countSql = `SELECT
    (SELECT COUNT(*) FROM background_articles WHERE ${BACKGROUND_SCOPE_SQL}
      AND ${periodSql}) AS total,
    (SELECT COUNT(*) FROM background_articles WHERE ${BACKGROUND_SCOPE_SQL}
      AND julianday(collected_at) >= julianday(?)
      AND julianday(collected_at) < julianday(?)) AS added_today_count`;
  const itemsSql = `SELECT title, summary, source, url, published, collected_at, original_language
    FROM background_articles WHERE ${BACKGROUND_SCOPE_SQL} AND ${periodSql}
    ORDER BY ${BACKGROUND_DATE_SQL} DESC, collected_at DESC, url
    LIMIT ${MAX_BACKGROUND_RESULTS}`;
  try {
    const [counts, rows] = await Promise.all([
      db.prepare(countSql).bind(...periodArgs, day.start, day.end).first(),
      db.prepare(itemsSql).bind(...periodArgs).all()
    ]);
    if (!counts || !Array.isArray(rows?.results) || rows.success === false) return unavailable;
    const total = Math.max(0, Number(counts.total) || 0);
    return {
      available: true, included: true, total,
      truncated: total > MAX_BACKGROUND_RESULTS,
      added_today_count: Math.max(0, Number(counts.added_today_count) || 0),
      today_date: day.date,
      items: rows.results.slice(0, MAX_BACKGROUND_RESULTS).map(backgroundArticleRow)
    };
  } catch (_) {
    // A temporary archive failure must not erase the event results or appear
    // to mean zero background articles exist.
    return unavailable;
  }
}

// Explicit fields -- the ones the list, the Excel export and the map export
// read -- never a copy of the whole event.
function databaseEventRow(event, index) {
  const date = parseEventDate(event);
  const number = value => (Number.isFinite(Number(value)) ? Number(value) : null);
  const url = cleanText(event.url, 1200);
  return {
    key: `db-${index}`,
    // Event ids are not unique (see eventUniqueKey): the page links a row to
    // its map marker by this key instead.
    match_key: eventUniqueKey(event),
    id: cleanText(event.id, 120),
    title: cleanText(event.title, 400),
    summary: cleanText(event.summary, 900),
    original_title: cleanText(event.original_title, 400),
    original_summary: cleanText(event.original_summary, 900),
    original_language: cleanText(event.original_language || event.collection_language, 12),
    published: date ? date.toISOString() : cleanText(event.published, 40),
    country: cleanText(event.country, 100),
    country_code: cleanText(event.country_code, 8),
    region: cleanText(event.region, 100),
    city: cleanText(event.city, 100),
    latitude: event.latitude == null ? null : number(event.latitude),
    longitude: event.longitude == null ? null : number(event.longitude),
    location_precision: cleanText(event.location_precision, 20),
    location_confidence: cleanText(event.location_confidence, 20),
    location_method: cleanText(event.location_method, 60),
    category: eventCategories(event)[0] || "",
    categories: eventCategories(event),
    reported_status: cleanText(event.reported_status, 20),
    category_review_required: event.category_review_required === true,
    cbrn_subgroups: Array.isArray(event.cbrn_subgroups) ? event.cbrn_subgroups.filter(value => value === "RADNUC") : [],
    actor_scope: cleanText(event.actor_scope, 20),
    actor_group: cleanText(event.actor_group, 100),
    primary_event_type: cleanText(event.primary_event_type, 40),
    is_attack: event.is_attack === true,
    ai_relevance_score: number(event.ai_relevance_score) || 0,
    ai_relevance_reason: cleanText(event.ai_relevance_reason, 300),
    source: cleanText(event.source, 140),
    source_count: number(event.source_count) || 1,
    article_count: number(event.article_count) || 1,
    url: /^https?:\/\//i.test(url) ? url : "",
    excluded_from_map: event.excluded_from_map === true
  };
}

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

async function handleDatabaseEvents(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON request." }, 400, env); }

  const authError = await authenticate(request, body, env);
  if (authError) return authError;

  const eventsDatabase = await fetchEventsDatabase(env, { minVersion: cleanText(body.min_database_version, 100) });
  if (!eventsDatabase.ok) return jsonResponse({ error: "Unable to read the events database." }, 503, env);
  const db = eventsDatabase.db;
  const all = Array.isArray(db) ? db : (Array.isArray(db?.events) ? db.events : []);

  const filters = parseDatabaseFilters(body);
  const now = new Date();

  // Group options are counted over the other filters (place, category,
  // period), so the dropdown always lists the groups present in that scope.
  const scoped = all.filter(event => matchesDatabaseFilters(event, { ...filters, actorGroup: "ALL" }, now));
  const groupCounts = new Map();
  for (const event of scoped) {
    const group = eventActorGroup(event);
    groupCounts.set(group, (groupCounts.get(group) || 0) + 1);
  }
  const groups = [...groupCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));

  const matched = scoped
    .filter(event => matchesGroup(event, filters.actorGroup))
    .map(event => ({ event, time: parseEventDate(event)?.getTime() || 0 }))
    .sort((a, b) => b.time - a.time);
  const backgroundArticles = await fetchRadnucBackground(env, filters, now);
  const operationalRows = matched.map((item, index) => databaseEventRow(item.event, index));
  const rows = [...operationalRows, ...backgroundArticles.items]
    .sort((a, b) => (Date.parse(b.published || b.collected_at) || 0) - (Date.parse(a.published || a.collected_at) || 0));
  const total = matched.length + backgroundArticles.total;

  return jsonResponse({
    version: DATABASE_QUERY_VERSION,
    scope: databaseFiltersLabel(filters),
    database_version: cleanText(db?.last_updated || db?.updated_at || "unknown", 100),
    database_total: all.length,
    total,
    operational_total: matched.length,
    incomplete: backgroundArticles.included && !backgroundArticles.available,
    truncated: total > MAX_DATABASE_RESULTS,
    groups,
    events: rows.slice(0, MAX_DATABASE_RESULTS),
    background_articles: backgroundArticles
  }, 200, env);
}

export { handleDatabaseEvents, databaseEventRow, backgroundArticleRow, fetchRadnucBackground, parisDayBounds,
  DATABASE_QUERY_VERSION, MAX_DATABASE_RESULTS, MAX_BACKGROUND_RESULTS };


