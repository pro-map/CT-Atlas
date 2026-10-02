// Retrieval from the ct-atlas-background-articles D1 corpus (binding
// BACKGROUND_DB): reporting that is NOT on the map -- other outlets' reports
// on map incidents, candidates the map's selection judged out of scope, and
// commentary removed from the map -- used to give the Report Generator wider
// context than the curated events alone. Everything here degrades to "no
// context" rather than failing a report: a missing binding, an empty corpus
// or a D1 error all return { available: false, items: [] }.
import { cleanText, isSameStory } from "./shared.js";

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

// Reviews Gemini scored 0 have no counter-terrorism content at all; the sync
// no longer stores them (tools/archive_dedup.py) and never serves the old ones.
const NOT_NOISE = "COALESCE(ba.ai_relevance_score, 1) <> 0";

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
      AND ${NOT_NOISE}
    ORDER BY background_articles_fts.rank
    LIMIT ${MAX_THEMATIC_ITEMS}`;
  const result = await db.prepare(sql).bind(match, start.toISOString(), end.toISOString()).all();
  return result?.results || [];
}

// One item per story: a row that tells the same story as an event already in
// the prompt, or as an item already kept, would read as independent
// corroboration of it.
function toContextItems(rows, events) {
  const list = Array.isArray(events) ? events : [];
  const sourceIdByIncident = new Map();
  for (const event of list) {
    const incident = cleanText(event?.incident_id, 80);
    if (incident && event?.source_id && !sourceIdByIncident.has(incident)) {
      sourceIdByIncident.set(incident, event.source_id);
    }
  }
  const stories = [];
  for (const event of list) {
    const date = event?.date || event?.published || "";
    const url = cleanText(event?.url, 1200);
    for (const title of new Set([event?.title, event?.original_title])) {
      if (title) stories.push({ title: cleanText(title, 280), url, date });
    }
  }

  const items = [];
  for (const row of rows) {
    const url = cleanText(row?.url, 1200);
    const title = cleanText(row?.title, 240);
    if (!url || !title) continue;
    const story = { title, url, date: contextDate(row) };
    if (stories.some(other => isSameStory(story, other))) continue;
    stories.push(story);

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

// ---- Deep Search ---------------------------------------------------------
// Deep Search's own planner already names the request's English anchor
// (usually the geography or actor) and a few broad topic terms; the corpus is
// searched with the anchor required and any topic term, so a question about
// Djibouti maritime incidents needs "djibouti" plus e.g. "piracy" or "vessel".
// Only rows with a real article URL are returned: Deep Search evidence must
// be openable and verifiable, which rules out synthetic historical reviews.
const MAX_DEEP_SEARCH_CORPUS_ROWS = 30;

function phrase(term) {
  return `"${cleanText(term, 80).replace(/"/g, '""')}"`;
}

function deepSearchCorpusQuery(plan) {
  const anchor = cleanText(plan?.anchors?.en, 80);
  const list = value => (Array.isArray(value) ? value : []).map(term => cleanText(term, 80)).filter(Boolean);
  const broad = list(plan?.gdelt_broad_terms).filter(term => term !== anchor);
  const exclude = list(plan?.gdelt_exclude_terms);

  let query = "";
  if (anchor && broad.length) query = `${phrase(anchor)} AND (${broad.map(phrase).join(" OR ")})`;
  else if (anchor) query = phrase(anchor);
  else if (broad.length >= 2) query = broad.map(phrase).join(" OR ");
  if (query && exclude.length) query += ` NOT (${exclude.map(phrase).join(" OR ")})`;
  return query;
}

function isoOrEmpty(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : "";
}

async function searchCorpusForDeepSearch(env, { plan, start, end, searchQuery }) {
  const db = env?.BACKGROUND_DB;
  if (!db || typeof db.prepare !== "function") return { available: false, rows: [] };
  const match = deepSearchCorpusQuery(plan);
  if (!match) return { available: true, rows: [] };

  try {
    const sql = `SELECT ${COLUMNS}, ba.original_language
      FROM background_articles_fts
      JOIN background_articles AS ba ON ba.rowid = background_articles_fts.rowid
      WHERE background_articles_fts MATCH ?
        AND ba.url LIKE 'http%'
        AND COALESCE(ba.published, ba.collected_at) >= ?
        AND COALESCE(ba.published, ba.collected_at) <= ?
        AND ${NOT_NOISE}
      ORDER BY background_articles_fts.rank
      LIMIT ${MAX_DEEP_SEARCH_CORPUS_ROWS}`;
    const result = await db.prepare(sql).bind(match, start.toISOString(), end.toISOString()).all();
    const rows = (result?.results || []).map(row => {
      const kind = cleanText(row.kind, 40);
      return {
        title: cleanText(row.title, 500),
        summary: cleanText(row.summary, 650),
        source: cleanText(row.source, 140) || "CT Atlas archive",
        url: cleanText(row.url, 1200),
        published: isoOrEmpty(row.published || row.collected_at),
        // Rejected candidates and removed events were normalised to English by
        // the collector; related articles keep their outlet's own headline.
        language: kind === "related_article" ? (cleanText(row.original_language, 8).toLowerCase() || "en") : "en",
        query_index: -1,
        query_variant: "ct-atlas-corpus",
        search_query: cleanText(searchQuery, 280),
        search_engine: "ct_atlas_corpus",
        fallback_locale: false,
        corpus_kind: kind
      };
    }).filter(row => row.title && row.url);
    return { available: true, rows, query: match };
  } catch (error) {
    console.error("Background corpus Deep Search query failed", error);
    return { available: false, rows: [] };
  }
}

// ---- Atlas AI (Quick Ask) ----------------------------------------------
// Question-driven: the question's own significant words (any of them) within
// the analyst's period, best full-text matches first. Kept small -- Atlas AI
// is a single fast answer, not a report.
const MAX_QUESTION_CONTEXT_ITEMS = 8;
const QUESTION_TERM_MIN_LENGTH = 4;
const MAX_QUESTION_TERMS = 8;

function questionCorpusQuery(tokens) {
  const terms = [...new Set((Array.isArray(tokens) ? tokens : [])
    .map(token => cleanText(token, 40))
    .filter(token => token.length >= QUESTION_TERM_MIN_LENGTH))]
    .slice(0, MAX_QUESTION_TERMS);
  return ftsQuery(terms);
}

// events: the database records already in the answer's prompt, so an archive
// row repeating one of them is not sent a second time.
async function searchCorpusForQuestion(env, { tokens, start, end, events = [] }) {
  const db = env?.BACKGROUND_DB;
  if (!db || typeof db.prepare !== "function") return { available: false, items: [] };
  const match = questionCorpusQuery(tokens);
  if (!match) return { available: true, items: [] };

  try {
    const sql = `SELECT ${COLUMNS}
      FROM background_articles_fts
      JOIN background_articles AS ba ON ba.rowid = background_articles_fts.rowid
      WHERE background_articles_fts MATCH ?
        AND COALESCE(ba.published, ba.collected_at) >= ?
        AND COALESCE(ba.published, ba.collected_at) <= ?
        AND ${NOT_NOISE}
      ORDER BY background_articles_fts.rank
      LIMIT ${MAX_QUESTION_CONTEXT_ITEMS}`;
    const result = await db.prepare(sql).bind(match, start.toISOString(), end.toISOString()).all();
    return { available: true, items: toContextItems(result?.results || [], events) };
  } catch (error) {
    console.error("Background corpus question query failed", error);
    return { available: false, items: [] };
  }
}

// One-row summary kept by tools/sync_background_corpus.py (corpus_stats), so
// reading the archive's size costs one row, not a count over the whole table.
async function corpusStats(env) {
  const db = env?.BACKGROUND_DB;
  if (!db || typeof db.prepare !== "function") return { available: false };
  try {
    const row = await db.prepare("SELECT total, by_kind, updated_at FROM corpus_stats WHERE id = 1").first();
    if (!row) return { available: false };
    let byKind = {};
    try { byKind = JSON.parse(row.by_kind || "{}"); } catch (_) {}
    return { available: true, total: Number(row.total) || 0, by_kind: byKind, updated_at: cleanText(row.updated_at, 40) };
  } catch (error) {
    console.error("Background corpus stats query failed", error);
    return { available: false };
  }
}

export {
  corpusStats,
  fetchBackgroundContext,
  backgroundSearchTerms,
  ftsQuery,
  toContextItems,
  MAX_CONTEXT_ITEMS,
  deepSearchCorpusQuery,
  searchCorpusForDeepSearch,
  questionCorpusQuery,
  searchCorpusForQuestion
};
