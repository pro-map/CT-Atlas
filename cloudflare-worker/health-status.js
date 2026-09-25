import { jsonResponse, cleanText } from "./shared.js";
import { sanctionsHealth } from "./sanctions.js";

// Live status behind the "Health status" button of the Crypto, Social and Facial
// tabs. /health only says what is configured; this actually reaches each
// dependency from the Worker, so a dead provider or a sleeping/broken Cloud Run
// service shows up as such. Public like /health: it returns statuses, latencies
// and version strings only -- never keys, URLs or error text containing a secret.
const HEALTH_STATUS_VERSION = "health-status-v1";

const PROBE_TIMEOUT_MS = 7000;
const SLOW_MS = 3500;
const CACHE_MS = 60 * 1000;

let statusCache = { at: 0, body: null };

function resetHealthStatusCache() {
  statusCache = { at: 0, body: null };
}

function redact(text, secrets) {
  let value = String(text || "");
  for (const secret of secrets) {
    if (secret && String(secret).length >= 6) value = value.split(String(secret)).join("[redacted]");
  }
  return value;
}

// Runs one probe. The probe returns extra fields (and may set its own `status`,
// e.g. "degraded"); a throw becomes "down". Latency above SLOW_MS is "degraded":
// a Cloud Run cold start or an overloaded provider is worth seeing.
async function timedProbe(run, secrets = []) {
  const started = Date.now();
  try {
    const detail = (await run()) || {};
    const latency = Date.now() - started;
    return { ...detail, status: detail.status || (latency > SLOW_MS ? "degraded" : "operational"), latency_ms: latency };
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return {
      status: "down",
      latency_ms: Date.now() - started,
      error: cleanText(timedOut ? "Timed out" : redact(error?.message || "Request failed", secrets), 160)
    };
  }
}

async function probeFetch(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (!response.ok) throw new Error("HTTP " + response.status);
  return response;
}

function notConfigured() {
  return { status: "not_configured" };
}

function httpsBase(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:" ? url.toString().replace(/\/+$/, "") : "";
  } catch (_) {
    return "";
  }
}

// Only plain true/false facts from a service's own /health (collector flags).
function booleanFlags(source) {
  const flags = {};
  for (const [key, value] of Object.entries(source && typeof source === "object" ? source : {})) {
    if (typeof value === "boolean") flags[cleanText(key, 60)] = value;
  }
  return flags;
}

function probeBitcoin() {
  return timedProbe(async () => {
    const height = Number(await (await probeFetch("https://blockstream.info/api/blocks/tip/height")).text());
    if (!Number.isFinite(height) || height <= 0) throw new Error("Unexpected Blockstream response");
    return { block_height: height };
  });
}

function probeEvm(env) {
  const key = String(env?.ETHERSCAN_API_KEY || "");
  if (!key) return notConfigured();
  return timedProbe(async () => {
    const url = "https://api.etherscan.io/v2/api?" + new URLSearchParams({
      chainid: "1", module: "proxy", action: "eth_blockNumber", apikey: key
    });
    const payload = await (await probeFetch(url)).json();
    const block = parseInt(payload?.result, 16);
    if (!Number.isFinite(block)) throw new Error(cleanText(payload?.result || payload?.message || "Unexpected Etherscan response", 120));
    return { block_height: block };
  }, [key]);
}

function probeTron(env) {
  const key = String(env?.TRONGRID_API_KEY || "");
  if (!key) return notConfigured();
  return timedProbe(async () => {
    const payload = await (await probeFetch("https://api.trongrid.io/wallet/getnowblock", {
      method: "POST",
      headers: { "TRON-PRO-API-KEY": key, "Content-Type": "application/json", Accept: "application/json" },
      body: "{}"
    })).json();
    const block = Number(payload?.block_header?.raw_data?.number);
    if (!Number.isFinite(block)) throw new Error("Unexpected TronGrid response");
    return { block_height: block };
  }, [key]);
}

async function probeSanctions(env) {
  const started = Date.now();
  const health = await sanctionsHealth(env);
  const status = health.status === "ok" ? "operational" : health.status === "stale" ? "degraded" : "down";
  return {
    status,
    latency_ms: Date.now() - started,
    address_count: health.address_count,
    published: health.published,
    retrieved_at: health.retrieved_at,
    ...(health.reason ? { error: cleanText(health.reason, 160) } : {})
  };
}

function probeAgent(env) {
  const base = httpsBase(env?.SOCMINT_AGENT_URL);
  if (!base || !String(env?.SOCMINT_AGENT_SHARED_SECRET || "").trim()) return notConfigured();
  return timedProbe(async () => {
    const payload = await (await probeFetch(base + "/health")).json();
    if (!payload?.ok) throw new Error("Agent reported not ok");
    return {
      version: cleanText(payload.version, 80),
      model: cleanText(payload.model, 80),
      search_provider: cleanText(payload.search_provider, 40),
      collectors: booleanFlags(payload.social_sources)
    };
  }, [base]);
}

function probeVisual(env) {
  const base = httpsBase(env?.VISUAL_INTEL_URL);
  if (!base || !String(env?.VISUAL_INTEL_SHARED_SECRET || "").trim()) return notConfigured();
  return timedProbe(async () => {
    const payload = await (await probeFetch(base + "/health")).json();
    if (!payload?.ok) throw new Error("Service reported not ok");
    return {
      version: cleanText(payload.version, 80),
      face_detection: cleanText(payload.face_detection, 60),
      ocr: cleanText(payload.ocr, 60),
      identity_recognition: payload.identity_recognition === true
    };
  }, [base]);
}

// Credentials that are present but deliberately not exercised (each call would
// spend quota): reported as "configured", never as "operational".
function credentialOnly(value) {
  return { status: String(value || "").trim() ? "configured" : "not_configured" };
}

async function buildHealthStatus(env, versions = {}) {
  const [bitcoin, evm, tron, sanctions, agent, visual] = await Promise.all([
    probeBitcoin(),
    probeEvm(env),
    probeTron(env),
    probeSanctions(env),
    probeAgent(env),
    probeVisual(env)
  ]);
  return {
    ok: true,
    version: HEALTH_STATUS_VERSION,
    generated_at: new Date().toISOString(),
    versions: Object.fromEntries(Object.entries(versions).map(([key, value]) => [cleanText(key, 40), cleanText(value, 80)])),
    components: {
      worker: { status: "operational" },
      bitcoin, evm, tron, sanctions, agent, visual,
      brave: credentialOnly(env?.BRAVE_SEARCH_API_KEY),
      gemini: credentialOnly(env?.GEMINI_API_KEY)
    }
  };
}

async function handleHealthStatus(env, versions = {}, now = Date.now()) {
  if (statusCache.body && now - statusCache.at < CACHE_MS) {
    return jsonResponse({ ...statusCache.body, cached: true, age_seconds: Math.round((now - statusCache.at) / 1000) }, 200, env);
  }
  const body = await buildHealthStatus(env, versions);
  statusCache = { at: now, body };
  return jsonResponse({ ...body, cached: false, age_seconds: 0 }, 200, env);
}

export {
  HEALTH_STATUS_VERSION,
  buildHealthStatus,
  handleHealthStatus,
  resetHealthStatusCache
};
