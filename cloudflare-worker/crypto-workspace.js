import {
  cleanText,
  normalizeUsername,
  isAllowedUser,
  jsonResponse,
  gateCall
} from "./shared.js";

const CRYPTO_WORKSPACE_VERSION = "crypto-workspace-v1";

function safeUrl(value) {
  const text = cleanText(value, 1200);
  return /^https:\/\//i.test(text) ? text : "";
}

function safeConfidence(value) {
  const level = cleanText(value, 16).toUpperCase();
  return ["HIGH","MEDIUM","LOW"].includes(level) ? level : "LOW";
}

function safeCategory(value) {
  const category = cleanText(value, 48).toUpperCase();
  const allowed = new Set([
    "CT WATCHLIST","SANCTIONS","DARKNET","MIXER","EXCHANGE","BRIDGE","DEX",
    "GAMBLING","SCAM/FRAUD","SERVICE","PERSON/ALIAS","ORGANIZATION",
    "DONATION CAMPAIGN","UNKNOWN SERVICE","OTHER"
  ]);
  return allowed.has(category) ? category : "OTHER";
}

function safeChain(value) {
  const chain = cleanText(value, 24).toLowerCase();
  return ["bitcoin","ethereum","bsc","polygon","arbitrum","base","tron"].includes(chain) ? chain : "";
}

function safeAddress(value) {
  return cleanText(value, 180);
}

function sanitizeLabel(label) {
  return {
    id: cleanText(label?.id || crypto.randomUUID(), 80),
    chain: safeChain(label?.chain),
    address: safeAddress(label?.address),
    name: cleanText(label?.name, 120),
    category: safeCategory(label?.category),
    confidence: safeConfidence(label?.confidence),
    source_type: cleanText(label?.source_type, 60),
    source_title: cleanText(label?.source_title, 240),
    source_url: safeUrl(label?.source_url),
    notes: cleanText(label?.notes, 1200),
    created_at: cleanText(label?.created_at, 64) || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

function sanitizeWatch(item) {
  const thresholds = item?.thresholds || {};
  return {
    id: cleanText(item?.id || crypto.randomUUID(), 80),
    chain: safeChain(item?.chain),
    address: safeAddress(item?.address),
    label: cleanText(item?.label, 120),
    enabled: item?.enabled !== false,
    categories: Array.isArray(item?.categories)
      ? item.categories.map(safeCategory).slice(0, 20)
      : [],
    thresholds: {
      min_amount: Number.isFinite(Number(thresholds.min_amount)) ? Math.max(0, Number(thresholds.min_amount)) : null,
      aggregate_24h: Number.isFinite(Number(thresholds.aggregate_24h)) ? Math.max(0, Number(thresholds.aggregate_24h)) : null,
      velocity_24h: Number.isFinite(Number(thresholds.velocity_24h)) ? Math.max(1, Math.min(10000, Number(thresholds.velocity_24h))) : null,
      dormant_days: Number.isFinite(Number(thresholds.dormant_days)) ? Math.max(1, Math.min(3650, Number(thresholds.dormant_days))) : null
    },
    last_snapshot: item?.last_snapshot && typeof item.last_snapshot === "object"
      ? {
          checked_at: cleanText(item.last_snapshot.checked_at, 64),
          newest_tx_id: cleanText(item.last_snapshot.newest_tx_id, 180),
          newest_tx_time: cleanText(item.last_snapshot.newest_tx_time, 64),
          tx_count: Number(item.last_snapshot.tx_count || 0),
          aggregate_value: Number(item.last_snapshot.aggregate_value || 0)
        }
      : null,
    created_at: cleanText(item?.created_at, 64) || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

function sanitizeCase(item) {
  return {
    id: cleanText(item?.id || crypto.randomUUID(), 80),
    name: cleanText(item?.name, 160),
    description: cleanText(item?.description, 1600),
    status: ["OPEN","PAUSED","CLOSED"].includes(cleanText(item?.status, 16).toUpperCase())
      ? cleanText(item.status, 16).toUpperCase()
      : "OPEN",
    chain: safeChain(item?.chain),
    seed_addresses: Array.isArray(item?.seed_addresses)
      ? item.seed_addresses.map(safeAddress).filter(Boolean).slice(0, 50)
      : [],
    saved_paths: Array.isArray(item?.saved_paths)
      ? item.saved_paths.slice(0, 100).map(path => ({
          id: cleanText(path?.id || crypto.randomUUID(), 80),
          name: cleanText(path?.name, 120),
          nodes: Array.isArray(path?.nodes) ? path.nodes.map(safeAddress).filter(Boolean).slice(0, 12) : [],
          created_at: cleanText(path?.created_at, 64) || new Date().toISOString()
        }))
      : [],
    notes: Array.isArray(item?.notes)
      ? item.notes.slice(0, 200).map(note => ({
          id: cleanText(note?.id || crypto.randomUUID(), 80),
          text: cleanText(note?.text, 1800),
          created_at: cleanText(note?.created_at, 64) || new Date().toISOString()
        }))
      : [],
    created_at: cleanText(item?.created_at, 64) || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

function sanitizeAlert(item) {
  return {
    id: cleanText(item?.id || crypto.randomUUID(), 80),
    watch_id: cleanText(item?.watch_id, 80),
    chain: safeChain(item?.chain),
    address: safeAddress(item?.address),
    type: cleanText(item?.type, 64).toUpperCase(),
    severity: ["HIGH","MEDIUM","LOW"].includes(cleanText(item?.severity, 16).toUpperCase())
      ? cleanText(item.severity, 16).toUpperCase()
      : "LOW",
    title: cleanText(item?.title, 180),
    detail: cleanText(item?.detail, 1200),
    tx_id: cleanText(item?.tx_id, 180),
    created_at: cleanText(item?.created_at, 64) || new Date().toISOString(),
    acknowledged: item?.acknowledged === true
  };
}

function sanitizeWorkspace(raw, username) {
  return {
    version: CRYPTO_WORKSPACE_VERSION,
    username,
    labels: Array.isArray(raw?.labels) ? raw.labels.slice(0, 1000).map(sanitizeLabel).filter(x => x.chain && x.address) : [],
    watchlist: Array.isArray(raw?.watchlist) ? raw.watchlist.slice(0, 300).map(sanitizeWatch).filter(x => x.chain && x.address) : [],
    cases: Array.isArray(raw?.cases) ? raw.cases.slice(0, 100).map(sanitizeCase).filter(x => x.name) : [],
    alerts: Array.isArray(raw?.alerts) ? raw.alerts.slice(0, 1000).map(sanitizeAlert) : [],
    updated_at: new Date().toISOString()
  };
}

async function authenticate(request, env, username) {
  const token = cleanText(request.headers.get("X-Session-Token"), 160);
  if (!token) return { error: "Authenticated session required.", status: 401 };
  const sessionResponse = await gateCall(env, "/session-get", { session_token: token });
  const session = await sessionResponse.json().catch(() => ({}));
  if (!sessionResponse.ok || session?.username !== username) {
    return { error: "Unauthorized session.", status: 401 };
  }
  return { ok: true };
}

async function handleCryptoWorkspace(request, env) {
  let body = {};
  if (request.method !== "GET") {
    try { body = await request.json(); }
    catch { return jsonResponse({ error: "Invalid JSON request." }, 400, env); }
  }

  const url = new URL(request.url);
  const username = normalizeUsername(
    request.method === "GET" ? url.searchParams.get("user_id") : body.user_id
  );
  if (!username || !isAllowedUser(username, env)) {
    return jsonResponse({ error: "Unknown user." }, 400, env);
  }

  const auth = await authenticate(request, env, username);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status, env);

  if (request.method === "GET") {
    const response = await gateCall(env, "/crypto-workspace-get", { username });
    const payload = await response.json().catch(() => ({}));
    return jsonResponse(payload, response.status, env);
  }

  if (request.method === "POST") {
    const workspace = sanitizeWorkspace(body.workspace || {}, username);
    const response = await gateCall(env, "/crypto-workspace-put", { username, workspace });
    const payload = await response.json().catch(() => ({}));
    return jsonResponse(payload, response.status, env);
  }

  return jsonResponse({ error: "Unsupported method." }, 405, env);
}

export {
  CRYPTO_WORKSPACE_VERSION,
  sanitizeWorkspace,
  handleCryptoWorkspace
};
