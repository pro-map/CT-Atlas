import { jsonResponse, cleanText } from "./shared.js";
import { sanctionsHealth } from "./sanctions.js";

// Live status behind the "Health status" button of the Crypto, Social and Facial
// tabs. /health only says what is configured; this actually reaches each
// dependency from the Worker, so a dead provider or a sleeping/broken Cloud Run
// service shows up as such. Public like /health: it returns statuses, latencies
// and version strings only -- never keys, URLs or error text containing a secret.
const HEALTH_STATUS_VERSION = "health-status-v1";

const PROBE_TIMEOUT_MS = 7000;
// Cloud Run services (SOCMINT agent, Facial) scale to zero when idle: the first
// request after a quiet period pays a container cold start of several seconds.
// That is slow, not down, so they get a much longer timeout.
const COLD_START_TIMEOUT_MS = 25000;
const SLOW_MS = 3500;
const CACHE_OK_MS = 60 * 1000;
// A failure is cached only briefly so a transient one (or a service that has just
// woken up) does not stay on screen for a minute.
const CACHE_DOWN_MS = 10 * 1000;
const FORCE_REFRESH_MIN_AGE_MS = 5 * 1000;
const COLD_START_NOTE = "Slow response: likely a cold start after inactivity (the service scales to zero when idle).";

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
async function timedProbe(run, secrets = [], { coldStart = false } = {}) {
  const started = Date.now();
  try {
    const detail = (await run()) || {};
    const latency = Date.now() - started;
    const slow = latency > SLOW_MS;
    return {
      ...detail,
      status: detail.status || (slow ? "degraded" : "operational"),
      latency_ms: latency,
      ...(slow && coldStart ? { note: COLD_START_NOTE } : {})
    };
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    const limit = coldStart ? COLD_START_TIMEOUT_MS : PROBE_TIMEOUT_MS;
    return {
      status: "down",
      latency_ms: Date.now() - started,
      error: cleanText(timedOut ? "Timed out after " + Math.round(limit / 1000) + "s" : redact(error?.message || "Request failed", secrets), 160)
    };
  }
}

async function probeFetch(url, init = {}, timeoutMs = PROBE_TIMEOUT_MS) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
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
    const payload = await (await probeFetch(base + "/health", {}, COLD_START_TIMEOUT_MS)).json();
    if (!payload?.ok) throw new Error("Agent reported not ok");
    return {
      version: cleanText(payload.version, 80),
      model: cleanText(payload.model, 80),
      search_provider: cleanText(payload.search_provider, 40),
      collectors: booleanFlags(payload.social_sources)
    };
  }, [base], { coldStart: true });
}

function probeVisual(env) {
  const base = httpsBase(env?.VISUAL_INTEL_URL);
  if (!base || !String(env?.VISUAL_INTEL_SHARED_SECRET || "").trim()) return notConfigured();
  return timedProbe(async () => {
    const payload = await (await probeFetch(base + "/health", {}, COLD_START_TIMEOUT_MS)).json();
    if (!payload?.ok) throw new Error("Service reported not ok");
    return {
      version: cleanText(payload.version, 80),
      face_detection: cleanText(payload.face_detection, 60),
      ocr: cleanText(payload.ocr, 60),
      identity_recognition: payload.identity_recognition === true
    };
  }, [base], { coldStart: true });
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

function hasFailure(body) {
  return Object.values(body?.components || {}).some(component => component?.status === "down");
}

// `force` (the panel's REFRESH button) bypasses the cache, but not more often than
// every few seconds: the endpoint is public and each run spends provider quota.
async function handleHealthStatus(env, versions = {}, now = Date.now(), { force = false } = {}) {
  if (statusCache.body) {
    const age = now - statusCache.at;
    const ttl = hasFailure(statusCache.body) ? CACHE_DOWN_MS : CACHE_OK_MS;
    const fresh = age < ttl && !(force && age >= FORCE_REFRESH_MIN_AGE_MS);
    if (fresh) {
      return jsonResponse({ ...statusCache.body, cached: true, age_seconds: Math.round(age / 1000) }, 200, env);
    }
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
