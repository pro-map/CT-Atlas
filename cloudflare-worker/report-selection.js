// The events a Report Generator report is written from, chosen with the Report
// Generator's own rules: place, category and group, the period and the previous
// equivalent one, the highest-priority records first, and the statistics of each.
//
// The page builds this selection itself (index.html, generateCustomReport) from
// the events database it already loads for the Database panel, and sends it with
// the request. The Worker runs on Cloudflare's Free plan, 10 ms of CPU a request:
// parsing the database there costs 300-600 ms, so Cloudflare cut such requests
// (see database-query.js). The Worker only cleans what it receives
// (acceptReportSelection): every field capped, the source ids renumbered and the
// coverage note its own. A report written from an altered selection is only ever
// that analyst's: the cache key includes the selection itself.
import {
  cleanText,
  matchesRegion,
  matchesTopic,
  matchesGroup,
  parseEventDate,
  priority,
  stats,
  compactEvent,
  MAX_EVENTS_CURRENT,
  MAX_EVENTS_PREVIOUS
} from "./shared.js";
// The page imports this file and, through it, shared.js without a cache version (the Worker's
// bundler cannot resolve one): a browser can hold the previous shared.js for ten minutes after
// a deploy. Import only names shared.js has long exported; the Worker passes in anything newer
// (the coverage note below).

const DAY_MS = 86400000;
const MAX_CATEGORIES = 16;
const MAX_TOP_COUNTRIES = 10;
const COUNTRY_COUNT_FIELDS = ["unique_attacks", "attempted_attacks", "disrupted_plots", "unique_ct_operations",
  "arrest_cases", "financing_cases", "weapons_cases", "reporting_records"];

function periodBounds(periodDays, now) {
  const currentStart = new Date(now.getTime() - periodDays * DAY_MS);
  const previousStart = new Date(currentStart.getTime() - periodDays * DAY_MS);
  return { currentStart, previousStart };
}

// The selection as it travels: what readReportInput computed, in plain JSON.
function reportSelection(db, { region, topic, actorGroup, periodDays, compare }, now = new Date()) {
  const allEvents = Array.isArray(db) ? db : (Array.isArray(db?.events) ? db.events : []);
  const databaseVersion = cleanText(db?.updated_at || db?.generated_at || db?.last_updated || "unknown", 100);
  const { currentStart, previousStart } = periodBounds(periodDays, now);
  // Held reports await a second outlet: the map, the counts and reports all leave them out.
  const matching = allEvents.filter(e => e.held_for_corroboration !== true && matchesRegion(e, region)
    && matchesTopic(e, topic) && matchesGroup(e, actorGroup));
  const current = [], previous = [];
  for (const event of matching) {
    const dt = parseEventDate(event);
    if (!dt) continue;
    if (dt >= currentStart && dt <= now) current.push(event);
    else if (compare && dt >= previousStart && dt < currentStart) previous.push(event);
  }
  current.sort((a, b) => priority(b) - priority(a));
  previous.sort((a, b) => priority(b) - priority(a));
  const currentEvents = current.slice(0, MAX_EVENTS_CURRENT);
  return {
    database_version: databaseVersion,
    current_events: currentEvents.map(compactEvent),
    previous_events: compare ? previous.slice(0, MAX_EVENTS_PREVIOUS).map(compactEvent) : [],
    current_stats: stats(current),
    previous_stats: stats(previous),
    // The original-language headlines, for story matching against the archive only.
    story_titles: currentEvents.map(event => cleanText(event.original_title, 280))
  };
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(Math.floor(number), 1e7) : 0;
}

// Exactly compactEvent's fields, capped the same way.
function cleanEvent(event) {
  const value = event && typeof event === "object" ? event : {};
  const date = Date.parse(String(value.date || ""));
  const relevance = Number(value.relevance);
  return {
    id: cleanText(value.id, 120),
    title: cleanText(value.title, 280),
    summary: cleanText(value.summary, 560),
    categories: (Array.isArray(value.categories) ? value.categories : [])
      .map(category => cleanText(category, 60)).filter(Boolean).slice(0, 8),
    country: cleanText(value.country, 80),
    region: cleanText(value.region, 100),
    city: cleanText(value.city, 100),
    location_precision: cleanText(value.location_precision, 20),
    actor_group: cleanText(value.actor_group, 100),
    primary_event_type: cleanText(value.primary_event_type, 40),
    is_attack: value.is_attack === true,
    attack_update: value.attack_update === true,
    incident_id: cleanText(value.incident_id, 80),
    incident_anchor: cleanText(value.incident_anchor, 220),
    update_type: cleanText(value.update_type, 40),
    date: Number.isFinite(date) ? new Date(date).toISOString() : "",
    source: cleanText(value.source, 140),
    url: cleanText(value.url, 1200),
    source_count: Math.max(1, count(value.source_count) || 1),
    relevance: Number.isFinite(relevance) ? Math.max(0, Math.min(100, relevance)) : 0
  };
}

function cleanStats(value, coverageNote) {
  const stats = value && typeof value === "object" ? value : {};
  const categories = {};
  for (const [name, total] of Object.entries(stats.categories && typeof stats.categories === "object" ? stats.categories : {})
    .slice(0, MAX_CATEGORIES)) {
    const label = cleanText(name, 60);
    if (label) categories[label] = count(total);
  }
  const countries = (Array.isArray(stats.top_countries_by_incident_activity) ? stats.top_countries_by_incident_activity : [])
    .slice(0, MAX_TOP_COUNTRIES)
    .map(row => ({
      name: cleanText(row?.name, 80),
      ...Object.fromEntries(COUNTRY_COUNT_FIELDS.map(field => [field, count(row?.[field])]))
    }))
    .filter(row => row.name);
  return {
    record_count: count(stats.record_count),
    categories,
    top_countries_by_incident_activity: countries,
    // The Worker's own wording, never the page's.
    ...(stats.coverage_note && coverageNote ? { coverage_note: coverageNote } : {})
  };
}

// What the Worker writes a report from, built only from a selection it has cleaned:
// the same object for a selection the page sent and for one the Worker made itself.
function acceptReportSelection(selection, { periodDays, compare, coverageNote }, now = new Date()) {
  if (!selection || typeof selection !== "object" || !Array.isArray(selection.current_events)) return null;
  const { currentStart, previousStart } = periodBounds(periodDays, now);
  let sourceSeq = 0;
  const withSourceId = event => ({ ...cleanEvent(event), source_id: `S${String(++sourceSeq).padStart(2, "0")}` });
  const currentSourced = selection.current_events.slice(0, MAX_EVENTS_CURRENT).map(withSourceId);
  const previousSourced = compare && Array.isArray(selection.previous_events)
    ? selection.previous_events.slice(0, MAX_EVENTS_PREVIOUS).map(withSourceId) : [];
  const titles = Array.isArray(selection.story_titles) ? selection.story_titles : [];
  return {
    databaseVersion: cleanText(selection.database_version, 100) || "unknown",
    now, currentStart, previousStart, currentSourced, previousSourced,
    currentStats: cleanStats(selection.current_stats, coverageNote),
    previousStats: cleanStats(selection.previous_stats, coverageNote),
    storyEvents: currentSourced.map((event, index) => ({ ...event, original_title: cleanText(titles[index], 280) }))
  };
}

export { reportSelection, acceptReportSelection };
