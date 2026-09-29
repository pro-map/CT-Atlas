// Retrieval from the ct-atlas-background-articles D1 corpus (binding
// BACKGROUND_DB): reporting that is NOT on the map -- other outlets' reports
// on map incidents, candidates the map's selection judged out of scope, and
// commentary removed from the map -- used to give the Report Generator wider
// context than the curated events alone. Everything here degrades to "no
// context" rather than failing a report: a missing binding, an empty corpus
// or a D1 error all return { available: false, items: [] }.
import { cleanText } from "./shared.js";

const MAX_RELATED_ITEMS = 24;
const MAX_THEMATIC_ITEMS = 24;
const MAX_CONTEXT_ITEMS = 40;
const RELATED_PER_INCIDENT = 2;
// D1 allows at most 100 bound parameters per statement.
const MAX_INCIDENT_IDS = 90;
const MAX_SEARCH_COUNTRIES = 6;
const MAX_SEARCH_ACTORS = 6;

const UNATTRIBUTED_ACTOR = /^(unknown|unidentified|unattributed|unclaimed|none|n\/a|other|various|multiple)\b/i;

const COLUMNS = `ba.url, ba.kind, ba.title, ba.summary, ba.source, ba.published, ba.collected_at,
  ba.country, ba.actor_group, ba.parent_incident_id, ba.ai_relevance_reason`;

function topValues(values, limit) {
  const counts = new Map();
  for (const value of values) {
    const key = cleanText(value, 80);
    if (key.length < 3) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value]) => value);
}

function backgroundSearchTerms(events) {
  const list = Array.isArray(events) ? events : [];
  return {
    countries: topValues(list.map(e => e?.country), MAX_SEARCH_COUNTRIES),
    actors: topValues(
      list.map(e => e?.actor_group).filter(value => value && !UNATTRIBUTED_ACTOR.test(String(value).trim())),
      MAX_SEARCH_ACTORS
    )
  };
}

// FTS5 phrase syntax: each term is wrapped in double quotes (a literal
// phrase, so hyphens, colons and operator words inside it are inert), with
// any embedded double quote doubled.
function ftsQuery(terms) {
  const phrases = [...new Set(terms.map(term => cleanText(term, 80)).filter(Boolean))]
    .map(term => `"${term.replace(/"/g, '""')}"`);
  return phrases.join(" OR ");
}

function contextDate(row) {
  return cleanText(row?.published || row?.collected_at || "", 40);
}

async function relatedArticles(db, events) {
  const incidentIds = [...new Set(
    events.map(e => cleanText(e?.incident_id, 80)).filter(Boolean)
  )].slice(0, MAX_INCIDENT_IDS);
  if (!incidentIds.length) return [];

  const placeholders = incidentIds.map(() => "?").join(",");
  const sql = `SELECT * FROM (
      SELECT ${COLUMNS},
        ROW_NUMBER() OVER (PARTITION BY ba.parent_incident_id ORDER BY ba.published DESC) AS rn
      FROM background_articles AS ba
      WHERE ba.kind = 'related_article' AND ba.parent_incident_id IN (${placeholders})
    ) WHERE rn <= ${RELATED_PER_INCIDENT}
    ORDER BY published DESC
    LIMIT ${MAX_RELATED_ITEMS}`;
  const result = await db.prepare(sql).bind(...incidentIds).all();
  return result?.results || [];
}

async function thematicArticles(db, events, start, end) {
  const { countries, actors } = backgroundSearchTerms(events);
  const match = ftsQuery([...countries, ...actors]);
  if (!match) return [];

  const sql = `SELECT ${COLUMNS}
    FROM background_articles_fts
    JOIN background_articles AS ba ON ba.rowid = background_articles_fts.rowid
    WHERE background_articles_fts MATCH ?
      AND COALESCE(ba.published, ba.collected_at) >= ?
      AND COALESCE(ba.published, ba.collected_at) <= ?
      AND ba.kind != 'related_article'
    ORDER BY background_articles_fts.rank
    LIMIT ${MAX_THEMATIC_ITEMS}`;
  const result = await db.prepare(sql).bind(match, start.toISOString(), end.toISOString()).all();
  return result?.results || [];
}

function toContextItems(rows, events) {
  const sourceIdByIncident = new Map();
  for (const event of events) {
    const incident = cleanText(event?.incident_id, 80);
    if (incident && event?.source_id && !sourceIdByIncident.has(incident)) {
      sourceIdByIncident.set(incident, event.source_id);
    }
  }
  const eventTitles = new Set(events.map(e => cleanText(e?.title, 280).toLowerCase()).filter(Boolean));

  const seen = new Set();
  const items = [];
  for (const row of rows) {
    const url = cleanText(row?.url, 1200);
    const title = cleanText(row?.title, 240);
    if (!url || !title || seen.has(url) || eventTitles.has(title.toLowerCase())) continue;
    seen.add(url);

    const kind = cleanText(row.kind, 40) || "rejected_candidate";
    const item = {
      context_id: `C${String(items.length + 1).padStart(2, "0")}`,
      kind,
      title,
      summary: cleanText(row.summary, 320),
      source: cleanText(row.source, 100),
      date: contextDate(row),
      country: cleanText(row.country, 80),
      actor_group: cleanText(row.actor_group, 100),
      // Synthetic keys (e.g. "gemini-review:<fingerprint>") are not links.
      url: /^https?:\/\//i.test(url) ? url : ""
    };
    if (kind === "related_article") {
      item.covers_source_id = sourceIdByIncident.get(cleanText(row.parent_incident_id, 80)) || "";
    } else {
      item.map_exclusion_reason = cleanText(row.ai_relevance_reason, 180);
    }
    items.push(item);
    if (items.length >= MAX_CONTEXT_ITEMS) break;
  }
  return items;
}

async function fetchBackgroundContext(env, { events, start, end }) {
  const db = env?.BACKGROUND_DB;
  if (!db || typeof db.prepare !== "function") return { available: false, items: [] };

  const list = Array.isArray(events) ? events : [];
  try {
    const [related, thematic] = await Promise.all([
      relatedArticles(db, list),
      thematicArticles(db, list, start, end)
    ]);
    return { available: true, items: toContextItems([...related, ...thematic], list) };
  } catch (error) {
    console.error("Background corpus query failed", error);
    return { available: false, items: [] };
  }
}

export {
  fetchBackgroundContext,
  backgroundSearchTerms,
  ftsQuery,
  toContextItems,
  MAX_CONTEXT_ITEMS
};
