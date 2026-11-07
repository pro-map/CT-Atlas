import { cleanText, gateCall, gateRead } from "./shared.js";
import { EVM_CHAINS, BLOCKSTREAM_API, TRONGRID_API, etherscanUrl, tronHeaders, tronHistoryQuery } from "./crypto.js";
import { tronscanTagEnabled, tronscanTagRequest } from "./exchange-addresses.js";

// Answers from outside "which Crypto provider works right now, with the real keys?". Only the
// Worker holds the keys, so the cron asks each provider once and /health publishes the outcome.
// No route can start a run: a visitor reads the last result and causes no upstream call.
// Quota: at most 7 upstream calls an hour (Blockstream or Tronscan, 5 Etherscan chains, TronGrid), none of them Gemini.

// Public addresses, fixed so that a run says nothing about what anyone is investigating.
const PROBE_BITCOIN_ADDRESS = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const PROBE_EVM_ADDRESS = "0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae";
const PROBE_TRON_ADDRESS = "TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi";

const RUN_LIMITS = Object.freeze({
  budgetMs: 25000,
  callTimeoutMs: 8000,
  gateTimeoutMs: 5000,
  // Etherscan's Free tier allows 3 calls a second, and a real analysis may share that second.
  etherscanSpacingMs: 400
});
const HEALTH_READ_TIMEOUT_MS = 800;
const HEALTH_CACHE_MS = 60 * 1000;
const HEALTH_RETRY_MS = 15 * 1000;
// Past two missed runs a stored "ok" no longer says anything about right now.
const STALE_AFTER_MS = 130 * 60 * 1000;

const MESSAGE_MAX = 120;
const MESSAGE_INPUT_MAX = 2000;
const REDACTED = "[redacted]";
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
// A last label that opens with a letter keeps "v1.2" and "3.5 per sec" out of it.
const HOST_RE = /\b(?:(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*[a-z0-9]|(?:\d{1,3}\.){3}\d{1,3})\b(?::\d+)?(?:[/?#]\S*)?/gi;
const HEADER_RE = /\b(?:(?:[a-z0-9]+-)+[a-z0-9]+|api[-_ ]?key|token|secret|password|authorization|cookie|host|accept|origin|referer|server|via)["']?\s*[:=]\s*["']?(?:bearer\s+)?[^\s"',;}]+/gi;
const QUERY_RE = /[?&]?\b[\w.%-]+=[^\s&]*(?:&[\w.%-]+=[^\s&]*)*/g;
const LONG_TOKEN_RE = /[A-Za-z0-9_+/=%-]{20,}/g;

// Key before rate: "OK-Missing/Invalid API Key, rate limit of 1/5sec applied" is a bad key. The
// plan pattern stays narrow because the shared-pool quota message also says "upgrade to API Pro".
const AUTH_RE = /(?:invalid|missing)\b.{0,12}api[- _]?key|api[- _]?key\s+(?:not exists?|does not exist|is (?:invalid|missing|required))|unauthori[sz]ed/i;
const PLAN_RE = /free api access is not supported|not supported for this chain|upgrade your api plan|api pro endpoint/i;
const RATE_RE = /rate limit|limit reached|too many requests|frequency limit/i;
// Etherscan's throttle on the calling IP, gone in 30 seconds. It says "invalid api key" but proves
// nothing about this Worker's key, so it is tested before AUTH_RE.
const IP_THROTTLE_RE = /too many invalid/i;

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// A firm bound: it holds even for a call that ignores its abort signal.
function withTimeout(work, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("Timed out"), { name: "TimeoutError" })), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Redacts before it cuts: cut first, the end of a key could survive as a harmless-looking fragment.
function sanitizeProviderMessage(text, secrets = []) {
  const keys = secrets.filter(Boolean).map(String);
  let value = cleanText(text, MESSAGE_INPUT_MAX);
  for (const key of keys) {
    // etherscanUrl() encodes through URLSearchParams, which differs from encodeURIComponent.
    for (const form of new Set([key, encodeURIComponent(key), new URLSearchParams({ key }).toString().slice(4)])) {
      value = value.replace(new RegExp(escapeRegExp(form), "gi"), REDACTED);
    }
  }
  value = value.replace(URL_RE, "").replace(HOST_RE, "").replace(HEADER_RE, REDACTED).replace(QUERY_RE, "").replace(LONG_TOKEN_RE, REDACTED);
  const lowered = keys.map(key => key.toLowerCase());
  value = value.replace(/[\w-]{6,}/g, word => lowered.some(key => key.includes(word.toLowerCase())) ? REDACTED : word);
  return cleanText(value, MESSAGE_MAX);
}

// What the provider said in words. Etherscan's status "1" result is data, not a message.
function providerText(payload) {
  if (!payload || typeof payload !== "object") return "";
  const fields = [payload.status === "1" ? "" : payload.result, payload.Error, payload.error, payload.message];
  return fields.find(field => typeof field === "string" && field.trim()) || "";
}

function classifyAnswer(check, http, payload) {
  const text = providerText(payload);
  if (IP_THROTTLE_RE.test(text)) return "rate_limited";
  if (AUTH_RE.test(text)) return "auth_failed";
  if (PLAN_RE.test(text)) return "plan_restricted";
  if (http === 429 || RATE_RE.test(text)) return "rate_limited";
  // A 403 page that is not JSON comes from the provider's firewall, not from a verdict on the key.
  if (check.keyed && (http === 401 || (http === 403 && payload))) return "auth_failed";
  if (http === 402) return "plan_restricted";
  return http >= 200 && http < 300 && check.answered(payload) ? "ok" : "unavailable";
}

function outcome(status, message = "") {
  return { status, checked_at: new Date().toISOString(), message };
}

function fallbackMessage(http, payload) {
  if (http >= 200 && http < 300) return payload ? "Unexpected response." : "The provider did not return JSON.";
  return "HTTP " + http;
}

// One attempt, unlike getJson: a retry would break the quota and hide the answer being measured.
async function readAnswer(check, fetcher, ms) {
  const response = await fetcher(check.url, { ...check.options, signal: AbortSignal.timeout(ms) });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { payload = null; }
  return { http: response.status, payload };
}

async function probeProvider(check, run) {
  const remaining = run.deadline - Date.now();
  if (remaining <= 0) return outcome("unavailable", "Not checked: the run ran out of time.");
  const ms = Math.min(run.callTimeoutMs, remaining);
  try {
    const { http, payload } = await withTimeout(readAnswer(check, run.fetcher, ms), ms);
    const status = classifyAnswer(check, http, payload);
    if (status === "ok") return outcome("ok");
    return outcome(status, sanitizeProviderMessage(providerText(payload), run.secrets) || fallbackMessage(http, payload));
  } catch (error) {
    // Fixed text: a network error's own message can quote the URL, and with it Etherscan's key.
    return outcome("unavailable", error?.name === "TimeoutError" ? "The provider did not answer in time." : "The provider could not be reached.");
  }
}

function blockstreamCheck() {
  return {
    id: "blockstream",
    url: BLOCKSTREAM_API + "/address/" + encodeURIComponent(PROBE_BITCOIN_ADDRESS),
    options: {},
    answered: payload => Boolean(payload?.chain_stats)
  };
}

function etherscanCheck(chain, env) {
  return {
    id: "etherscan_" + chain,
    keyed: true,
    url: etherscanUrl({ chainid: EVM_CHAINS[chain].chainid, module: "account", action: "balance", address: PROBE_EVM_ADDRESS, tag: "latest" }, env.ETHERSCAN_API_KEY),
    options: {},
    answered: payload => payload?.status === "1" && /^\d+$/.test(String(payload.result))
  };
}

// Not the account endpoint: that one returns every holding, 28 KB for this address.
function tronGridCheck(env) {
  return {
    id: "trongrid",
    keyed: true,
    url: TRONGRID_API + "/v1/accounts/" + encodeURIComponent(PROBE_TRON_ADDRESS) + "/transactions/trc20?" + tronHistoryQuery(1),
    options: { headers: tronHeaders(env) },
    answered: payload => Array.isArray(payload?.data)
  };
}

function tronscanCheck(env) {
  return {
    id: "tronscan",
    keyed: true,
    ...tronscanTagRequest(PROBE_TRON_ADDRESS, env),
    answered: payload => typeof payload?.publicTag === "string"
  };
}

// In sequence: five at once would trip the rate limit they are there to measure.
async function probeEtherscan(env, run) {
  const chains = Object.keys(EVM_CHAINS);
  if (!env.ETHERSCAN_API_KEY) return chains.map(chain => ["etherscan_" + chain, outcome("not_configured")]);
  const results = [];
  for (const chain of chains) {
    if (results.length) await pause(run.etherscanSpacingMs);
    const check = etherscanCheck(chain, env);
    results.push([check.id, await probeProvider(check, run)]);
  }
  return results;
}

function lastChecked(entry) {
  return entry && entry.status !== "not_configured" ? Date.parse(entry.checked_at) || 0 : 0;
}

async function probeProviders(env, previous, fetcher, limits) {
  const run = {
    ...limits,
    fetcher,
    deadline: Date.now() + limits.budgetMs,
    secrets: [env.ETHERSCAN_API_KEY, env.TRONGRID_API_KEY, env.TRONSCAN_API_KEY]
  };
  const ask = async check => [[check.id, await probeProvider(check, run)]];
  const known = previous?.providers || {};
  const tronscanOn = tronscanTagEnabled(env);
  // An eighth call would break the quota, so Tronscan takes turns with Blockstream, which needs
  // no key and is the one /health/status also reaches. The other keeps its last result.
  const tronscanTurn = tronscanOn && lastChecked(known.blockstream) > lastChecked(known.tronscan);
  const lists = await Promise.all([
    ask(tronscanTurn ? tronscanCheck(env) : blockstreamCheck()),
    probeEtherscan(env, run),
    env.TRONGRID_API_KEY ? ask(tronGridCheck(env)) : [["trongrid", outcome("not_configured")]]
  ]);
  const providers = Object.fromEntries(lists.flat());
  if (!tronscanOn) providers.tronscan = outcome("not_configured");
  else {
    const waiting = tronscanTurn ? "blockstream" : "tronscan";
    if (known[waiting]) providers[waiting] = known[waiting];
  }
  return providers;
}

async function gateJson(call, env, path, payload, ms) {
  return withTimeout((async () => {
    const response = await call(env, path, payload);
    if (!response.ok) throw new Error("The gate answered " + response.status);
    return response.json();
  })(), ms);
}

// The crypto monitor's cron, "17 */6 * * *": in that minute it spends the same keys.
function monitorRunsAt(ms) {
  const time = new Date(ms);
  return time.getUTCMinutes() === 17 && time.getUTCHours() % 6 === 0;
}

// Never rejects. Without a claim nothing goes upstream, so a gate failure cannot break the quota.
async function runCryptoProviderProbe(env, scheduledTime, { fetcher = fetch, ...overrides } = {}) {
  const limits = { ...RUN_LIMITS, ...overrides };
  try {
    const slot = Math.floor(Number(scheduledTime) / 60000) * 60000;
    const claim = await gateJson(gateCall, env, "/crypto-provider-status-claim", { slot, monitor_tick: monitorRunsAt(slot) }, limits.gateTimeoutMs);
    if (claim?.claimed !== true) return false;
    const providers = await probeProviders(env, claim.previous, fetcher, limits);
    await gateJson(gateCall, env, "/crypto-provider-status-put", { checked_at: new Date().toISOString(), providers }, limits.gateTimeoutMs);
    return true;
  } catch (error) {
    console.error("Crypto provider probe stopped", cleanText(error?.name, 40));
    return false;
  }
}

// /health is public and fetched on every page load, and until now it never touched the gate that
// also serves sessions. A value is kept, not a promise: Workers cannot share one across requests.
let healthCache = { at: 0, value: null };

function resetCryptoProviderStatusCache() {
  healthCache = { at: 0, value: null };
}

// Never rejects: a slow or broken gate costs /health one short wait, then an honest empty answer.
// gateRead, not gateCall: on a cold isolate gateCall can run the EU migration, which a public route
// must not start. Before that migration the record is simply absent, the same as no run yet.
async function readCryptoProviderStatus(env, now = Date.now()) {
  const cached = healthCache.value;
  if (cached && now - healthCache.at < (cached.read_failed ? HEALTH_RETRY_MS : HEALTH_CACHE_MS)) return cached;
  let value;
  try {
    const stored = await gateJson(gateRead, env, "/crypto-provider-status-get", {}, HEALTH_READ_TIMEOUT_MS);
    const checkedAt = stored?.checked_at || null;
    value = { checked_at: checkedAt, stale: now - Date.parse(checkedAt) > STALE_AFTER_MS, providers: stored?.providers || {} };
  } catch {
    value = { checked_at: null, stale: false, providers: {}, read_failed: true };
  }
  healthCache = { at: now, value };
  return value;
}

// Every other request passes straight through. For /health the read runs beside the route, not after it.
async function withCryptoProviderStatus(request, env, respond) {
  if (new URL(request.url).pathname !== "/health" || request.method !== "GET") return respond();
  const [response, status] = await Promise.all([respond(), readCryptoProviderStatus(env)]);
  const body = await response.json();
  return new Response(JSON.stringify({ ...body, crypto_provider_status: status }), { status: response.status, headers: response.headers });
}

export {
  PROBE_BITCOIN_ADDRESS,
  PROBE_EVM_ADDRESS,
  PROBE_TRON_ADDRESS,
  monitorRunsAt,
  sanitizeProviderMessage,
  runCryptoProviderProbe,
  readCryptoProviderStatus,
  resetCryptoProviderStatusCache,
  withCryptoProviderStatus
};
