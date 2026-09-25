import { cleanText } from "./shared.js";
import { findWalletCandidates } from "./address-utils.js";

// Sanctions screening for Crypto Intelligence: checks the analysed address and
// every counterparty in the returned transaction sample against sanctioned
// digital-currency addresses (currently the OFAC SDN list, refreshed by
// tools/update_sanctions.py into sanctions-crypto.json). Bump whenever the
// screening output SHAPE changes.
const SANCTIONS_VERSION = "sanctions-screening-v1-ofac-sdn";

const SANCTIONS_CACHE_TTL_MS = 30 * 60 * 1000;
const SANCTIONS_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const SANCTIONS_FETCH_TIMEOUT_MS = 8000;
const SANCTIONS_RETRY_BACKOFF_MS = 60 * 1000;
const MAX_REPORTED_MATCHES = 40;
const MAX_TX_IDS_PER_MATCH = 5;

const SANCTIONS_EVM_CHAINS = new Set(["ethereum", "bsc", "polygon", "arbitrum", "base"]);

const SCOPE_NOTE =
  "A match means this exact address string appears on a sanctions list; it is not a compliance determination. " +
  "No match does NOT mean an address is safe: coverage is limited to the listed source(s), and only the " +
  "counterparties visible in the recent transaction sample returned for this analysis were screened " +
  "(direct relationships only, no indirect exposure).";

const WALLET_SCOPE_NOTE =
  "Wallet strings were extracted from the report text and checksum-validated, which proves only that they are " +
  "well-formed. A list match means this exact string appears on a sanctions list; it says nothing about who " +
  "published or controls it. No match does NOT mean an address is safe: coverage is limited to the listed " +
  "source(s) and only strings present in this report were screened.";
const MAX_REPORT_WALLETS = 40;
const REPORT_WALLET_FIELDS = [
  "executive_assessment", "source_coverage", "identity_alias_findings", "network_associations",
  "content_narrative", "activity_timeline", "locations_travel_signals", "financial_crypto_indicators",
  "ct_relevance", "analytical_gaps"
];

let sanctionsCache = { loadedAt: 0, state: null };
let sanctionsRetryAfter = 0;
let sanctionsLastError = "";

function chainFamily(chain) {
  if (chain === "bitcoin") return "bitcoin";
  if (chain === "tron") return "tron";
  if (SANCTIONS_EVM_CHAINS.has(chain)) return "evm";
  return "other";
}

function normalizeSanctionsAddress(family, address) {
  const value = String(address || "").trim();
  if (!value) return "";
  if (family === "evm") return value.toLowerCase();
  if (family === "bitcoin" && /^bc1/i.test(value)) return value.toLowerCase();
  return value;
}

function indexKey(family, address) {
  return family + ":" + normalizeSanctionsAddress(family, address);
}

function buildSanctionsIndex(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.addresses) || !Array.isArray(payload.entities)) {
    throw new Error("Sanctions data has an unexpected shape.");
  }
  const index = new Map();
  for (const item of payload.addresses) {
    if (!item || typeof item.a !== "string" || typeof item.f !== "string") continue;
    index.set(indexKey(item.f, item.a), item);
  }
  return index;
}

function sanctionsMeta(payload) {
  const sources = Array.isArray(payload?.sources) ? payload.sources : [];
  return {
    retrieved_at: cleanText(payload?.retrieved_at, 40),
    address_count: Array.isArray(payload?.addresses) ? payload.addresses.length : 0,
    sources: sources.map(source => ({
      id: cleanText(source?.id, 40),
      name: cleanText(source?.name, 160),
      published: cleanText(source?.published, 20)
    }))
  };
}

// Loads (and caches per isolate) the sanctions data. Never throws: the caller
// must be able to tell "screened, no match" from "could not screen" -- an
// unavailable list must surface as status "unavailable", never as a clean pass.
async function loadSanctions(env, now = Date.now()) {
  if (sanctionsCache.state && now - sanctionsCache.loadedAt < SANCTIONS_CACHE_TTL_MS) return sanctionsCache.state;

  const url = String(env?.SANCTIONS_URL || "").trim();
  if (!url) {
    return { status: "unavailable", reason: "SANCTIONS_URL is not configured.", index: null, meta: null };
  }

  // After a failed fetch, do not make every analysis wait on another timeout.
  if (now < sanctionsRetryAfter) return failedLoadState(sanctionsLastError);

  try {
    const response = await fetch(url, {
      cf: { cacheTtl: 900, cacheEverything: true },
      signal: AbortSignal.timeout(SANCTIONS_FETCH_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const payload = await response.json();
    const index = buildSanctionsIndex(payload);
    const meta = sanctionsMeta(payload);
    const retrieved = Date.parse(meta.retrieved_at);
    const stale = !Number.isFinite(retrieved) || now - retrieved > SANCTIONS_STALE_AFTER_MS;
    sanctionsCache = { loadedAt: now, state: { status: stale ? "stale" : "ok", index, meta, entities: payload.entities } };
    sanctionsRetryAfter = 0;
    return sanctionsCache.state;
  } catch (error) {
    sanctionsLastError = cleanText(error?.message || "Sanctions list could not be loaded.", 200);
    sanctionsRetryAfter = now + SANCTIONS_RETRY_BACKOFF_MS;
    return failedLoadState(sanctionsLastError);
  }
}

// Keep serving the last good copy rather than dropping screening because of one
// failed refresh -- but say so. With no good copy the result is "unavailable".
function failedLoadState(reason) {
  if (sanctionsCache.state && sanctionsCache.state.index) {
    return { ...sanctionsCache.state, status: "stale", reason: "Refresh failed (" + reason + "); using the last successfully loaded list." };
  }
  return { status: "unavailable", reason, index: null, meta: null };
}

function resetSanctionsCache() {
  sanctionsCache = { loadedAt: 0, state: null };
  sanctionsRetryAfter = 0;
  sanctionsLastError = "";
}

// Compact status for /health and the live smoke test: proves the Worker can
// actually load the list (not merely that a URL is configured).
async function sanctionsHealth(env) {
  const state = await loadSanctions(env);
  return {
    status: state.status,
    address_count: state.meta ? state.meta.address_count : 0,
    retrieved_at: state.meta ? state.meta.retrieved_at : "",
    published: state.meta?.sources?.[0]?.published || "",
    ...(state.reason ? { reason: state.reason } : {})
  };
}

function describeEntities(item, entities) {
  return (item.e || [])
    .map(position => entities[position])
    .filter(Boolean)
    .map(entity => ({
      id: cleanText(entity.id, 24),
      name: cleanText(entity.name, 200),
      programs: (Array.isArray(entity.programs) ? entity.programs : []).slice(0, 12).map(p => cleanText(p, 40)),
      terrorism: Boolean(entity.terrorism),
      list: cleanText(entity.list, 24)
    }));
}

// Keyed by the normalised address so the same EVM wallet seen as both
// checksummed and lowercase is one counterparty, not two.
// "NAME [PROG1, PROG2]; NAME2 [PROG]" -- the listing, stated as a listing only.
function summarizeEntities(entities) {
  return entities
    .map(entity => entity.name + (entity.programs.length ? " [" + entity.programs.join(", ") + "]" : ""))
    .join("; ");
}

function collectCounterparties(analysis, family) {
  const found = new Map();
  const add = (address, row) => {
    const value = String(address || "").trim();
    if (!value) return;
    const key = indexKey(family, value);
    const entry = found.get(key) || { address: value, in_count: 0, out_count: 0, tx_ids: [], first_seen: "", last_seen: "" };
    if (row) {
      const direction = String(row.direction || "").toUpperCase();
      if (direction === "IN") entry.in_count++;
      else if (direction === "OUT") entry.out_count++;
      const time = String(row.time || "");
      if (time && (!entry.first_seen || time < entry.first_seen)) entry.first_seen = time;
      if (time && (!entry.last_seen || time > entry.last_seen)) entry.last_seen = time;
      const id = cleanText(row.id, 180);
      if (id && entry.tx_ids.length < MAX_TX_IDS_PER_MATCH && !entry.tx_ids.includes(id)) entry.tx_ids.push(id);
    }
    found.set(key, entry);
  };

  for (const row of Array.isArray(analysis?.transactions) ? analysis.transactions : []) {
    for (const counterparty of Array.isArray(row?.counterparties) ? row.counterparties : []) add(counterparty, row);
  }

  // Single-transaction lookups carry their parties directly.
  const tx = analysis?.transaction;
  if (analysis?.kind === "transaction" && tx && typeof tx === "object") {
    for (const address of [
      ...(Array.isArray(tx.input_addresses) ? tx.input_addresses : []),
      ...(Array.isArray(tx.output_addresses) ? tx.output_addresses : []),
      tx.from, tx.to, tx.owner_address, tx.to_address
    ]) add(address, null);
  }

  return found;
}

function screenAnalysis(analysis, state, now = Date.now()) {
  const base = {
    version: SANCTIONS_VERSION,
    status: state?.status || "unavailable",
    checked_at: new Date(now).toISOString(),
    hit: false,
    seed_match: null,
    counterparty_matches: [],
    counterparties_checked: 0,
    list: state?.meta || null,
    scope_note: SCOPE_NOTE
  };
  if (state?.reason) base.reason = state.reason;
  if (!state?.index) return base;

  const family = chainFamily(analysis?.chain);
  const entities = Array.isArray(state.entities) ? state.entities : [];

  if (analysis?.kind === "address" && analysis?.query) {
    const seed = state.index.get(indexKey(family, analysis.query));
    if (seed) {
      const seedEntities = describeEntities(seed, entities);
      base.seed_match = {
        address: cleanText(analysis.query, 180),
        currency: cleanText(seed.c, 12),
        entities: seedEntities,
        summary: summarizeEntities(seedEntities)
      };
    }
  }

  const counterparties = collectCounterparties(analysis, family);
  base.counterparties_checked = counterparties.size;

  const seedKey = analysis?.kind === "address" ? indexKey(family, analysis.query) : "";
  for (const entry of counterparties.values()) {
    const key = indexKey(family, entry.address);
    if (key === seedKey) continue;
    const item = state.index.get(key);
    if (!item) continue;
    const matchEntities = describeEntities(item, entities);
    base.counterparty_matches.push({
      address: cleanText(entry.address, 180),
      currency: cleanText(item.c, 12),
      entities: matchEntities,
      summary: summarizeEntities(matchEntities),
      received_from_count: entry.in_count,
      sent_to_count: entry.out_count,
      first_seen: entry.first_seen,
      last_seen: entry.last_seen,
      tx_ids: entry.tx_ids
    });
  }

  base.counterparty_matches.sort((a, b) =>
    (b.received_from_count + b.sent_to_count) - (a.received_from_count + a.sent_to_count)
  );
  base.counterparty_matches = base.counterparty_matches.slice(0, MAX_REPORTED_MATCHES);
  base.hit = Boolean(base.seed_match) || base.counterparty_matches.length > 0;
  return base;
}

// Text of a SOCMINT report that may carry wallet strings. The analyst's own
// query (report.query) and the source list are deliberately excluded: only what
// the investigation reports as observed is screened.
function reportWalletText(report) {
  const parts = REPORT_WALLET_FIELDS.map(key => report?.[key]);
  for (const item of Array.isArray(report?.key_findings) ? report.key_findings : []) parts.push(item?.finding, item?.basis);
  for (const item of Array.isArray(report?.entities) ? report.entities : []) parts.push(item?.value, item?.basis);
  for (const item of Array.isArray(report?.watchpoints) ? report.watchpoints : []) parts.push(item?.issue, item?.indicator);
  return parts.filter(Boolean).join("\n");
}

// Screens wallet strings found in a SOCMINT report. Same honesty rule as
// screenAnalysis: status says whether screening actually ran, and "listed:false"
// is only meaningful when status is ok/stale.
function screenReportWallets(report, state, now = Date.now()) {
  const candidates = findWalletCandidates(reportWalletText(report)).slice(0, MAX_REPORT_WALLETS);
  const entities = Array.isArray(state?.entities) ? state.entities : [];
  const screened = Boolean(state?.index);
  const wallets = candidates.map(candidate => {
    const item = screened ? state.index.get(indexKey(candidate.family, candidate.address)) : null;
    const entry = {
      address: cleanText(candidate.address, 180),
      family: candidate.family,
      screened,
      listed: Boolean(item)
    };
    if (item) {
      const matched = describeEntities(item, entities);
      entry.currency = cleanText(item.c, 12);
      entry.entities = matched;
      entry.summary = summarizeEntities(matched);
    }
    return entry;
  });
  wallets.sort((a, b) => Number(b.listed) - Number(a.listed));
  return {
    version: SANCTIONS_VERSION,
    status: state?.status || "unavailable",
    checked_at: new Date(now).toISOString(),
    hit: wallets.some(wallet => wallet.listed),
    wallets_found: wallets.length,
    wallets,
    list: state?.meta || null,
    scope_note: WALLET_SCOPE_NOTE,
    ...(state?.reason ? { reason: state.reason } : {})
  };
}

function sanctionsObservation(screening) {
  if (!screening?.hit) return "";
  const parts = [];
  if (screening.seed_match) {
    parts.push("SANCTIONS MATCH: the analysed address itself is listed (" + screening.seed_match.summary + ").");
  }
  if (screening.counterparty_matches.length) {
    parts.push(
      "SANCTIONS EXPOSURE: " + screening.counterparty_matches.length +
      " counterparty address(es) in this sample are listed (" +
      screening.counterparty_matches.slice(0, 3).map(match => match.summary).join(" | ") + ")."
    );
  }
  return parts.join(" ");
}

export {
  SANCTIONS_VERSION,
  chainFamily,
  normalizeSanctionsAddress,
  buildSanctionsIndex,
  loadSanctions,
  sanctionsHealth,
  resetSanctionsCache,
  screenAnalysis,
  screenReportWallets,
  sanctionsObservation
};
