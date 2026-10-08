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

const DATABASE_QUERY_VERSION = "database-query-v3-standalone-threat-topics";
// Everything the database holds today fits (180 days, ~4-5k events); the cap
// only guards against a runaway response if the database grows a lot.
const MAX_DATABASE_RESULTS = 8000;

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

  return jsonResponse({
    version: DATABASE_QUERY_VERSION,
    scope: databaseFiltersLabel(filters),
    database_version: cleanText(db?.last_updated || db?.updated_at || "unknown", 100),
    database_total: all.length,
    total: matched.length,
    truncated: matched.length > MAX_DATABASE_RESULTS,
    groups,
    events: matched.slice(0, MAX_DATABASE_RESULTS).map((item, index) => databaseEventRow(item.event, index))
  }, 200, env);
}

export { handleDatabaseEvents, databaseEventRow, DATABASE_QUERY_VERSION, MAX_DATABASE_RESULTS };

