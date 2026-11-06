import { jsonResponse, cleanText } from "./shared.js";
import { sanctionsHealth } from "./sanctions.js";

// Live status behind the "Health status" button of the Crypto tab. /health only
// says what is configured; this actually reaches each dependency from the Worker,
// so a dead provider shows up as such. Public like /health: it returns statuses,
// latencies and version strings only -- never keys, URLs or error text containing a secret.
const HEALTH_STATUS_VERSION = "health-status-v1";

const PROBE_TIMEOUT_MS = 7000;
const SLOW_MS = 3500;
const CACHE_OK_MS = 60 * 1000;
// A failure is cached only briefly so a transient one does not stay on screen for a minute.
const CACHE_DOWN_MS = 10 * 1000;
const FORCE_REFRESH_MIN_AGE_MS = 5 * 1000;

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
// an overloaded provider is worth seeing.
async function timedProbe(run, secrets = []) {
  const started = Date.now();
  try {
    const detail = (await run()) || {};
    const latency = Date.now() - started;
    return {
      ...detail,
      status: detail.status || (latency > SLOW_MS ? "degraded" : "operational"),
      latency_ms: latency
    };
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return {
      status: "down",
      latency_ms: Date.now() - started,
      error: cleanText(timedOut ? "Timed out after " + Math.round(PROBE_TIMEOUT_MS / 1000) + "s" : redact(error?.message || "Request failed", secrets), 160)
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

// Credentials that are present but deliberately not exercised (each call would
// spend quota): reported as "configured", never as "operational".
function credentialOnly(value) {
  return { status: String(value || "").trim() ? "configured" : "not_configured" };
}

async function buildHealthStatus(env, versions = {}) {
  const [bitcoin, evm, tron, sanctions] = await Promise.all([
    probeBitcoin(),
    probeEvm(env),
    probeTron(env),
    probeSanctions(env)
  ]);
  return {
    ok: true,
    version: HEALTH_STATUS_VERSION,
    generated_at: new Date().toISOString(),
    versions: Object.fromEntries(Object.entries(versions).map(([key, value]) => [cleanText(key, 40), cleanText(value, 80)])),
    components: {
      worker: { status: "operational" },
      bitcoin, evm, tron, sanctions,
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
