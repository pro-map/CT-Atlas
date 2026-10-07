import { cleanText, isAllowedUser, gateCall, corsHeaders } from "./shared.js";

export const OSINT_INDUSTRIES_VERSION = "osint-industries-v1";
const SEARCH_URL = "https://api.osint.industries/v2/request";
const CREDITS_URL = "https://api.osint.industries/misc/credits";
export const SEARCH_TYPES = ["email", "phone", "username", "name", "wallet"];

function reply(body, status, env) {
  return new Response(JSON.stringify(body), { status, headers: {
    ...corsHeaders(env), "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff"
  } });
}

async function boundedJSON(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing JSON body");
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("JSON body too large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(buffer));
}

export function parseSearch(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !SEARCH_TYPES.includes(body.type)) return null;
  if (typeof body.query !== "string" || body.query.length > 320 || /[\r\n\x00-\x1f]/.test(body.query)) return null;
  let query = body.query.trim();
  if (body.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query)) return null;
  if (body.type === "phone") {
    query = query.replace(/[ ()\-.]/g, "");
    if (!/^\+[1-9]\d{6,14}$/.test(query)) return null;
  }
  if (body.type === "username") {
    query = query.replace(/^@/, "");
    if (!query || query.length > 100 || /[\s/\\:?#]/.test(query)) return null;
  }
  if (body.type === "name" && (query.length < 2 || query.length > 160)) return null;
  if (body.type === "wallet" && (!/^[a-zA-Z0-9:]+$/.test(query) || query.length < 20 || query.length > 160)) return null;
  if (!query || !/^[a-f0-9-]{36}$/i.test(String(body.request_id || ""))) return null;
  return { type: body.type, query, request_id: body.request_id, timeout: 60, exact_match: true, premium: false, premium_modules_only: false };
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}

// Preserve the provider's structured evidence, while never forwarding API credentials.
function withoutSecrets(value, apiKey) {
  if (typeof value === "string") return apiKey ? value.split(apiKey).join("[redacted]") : value;
  if (Array.isArray(value)) return value.map(item => withoutSecrets(item, apiKey));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(api[-_]?key|authorization|access_token|refresh_token)$/i.test(key))
    .map(([key, item]) => [key, withoutSecrets(item, apiKey)]));
}

function fieldValue(item) { return item && typeof item === "object" && Object.hasOwn(item, "value") ? item.value : item; }
function label(key) { return String(key).replace(/[_-]/g, " ").replace(/\b\w/g, char => char.toUpperCase()); }

export function normalizeResults(payload, apiKey = "") {
  const raw = withoutSecrets(payload, apiKey);
  const modules = Array.isArray(raw) ? raw : Array.isArray(raw?.results) ? raw.results : Array.isArray(raw?.data) ? raw.data : null;
  if (!modules || modules.some(item => !item || typeof item !== "object" || Array.isArray(item))) throw new Error("Unexpected provider response");
  const cards = [];
  modules.forEach((module, moduleIndex) => {
    const specs = Array.isArray(module.spec_format) ? module.spec_format : [];
    const fronts = Array.isArray(module.front_schemas) ? module.front_schemas : [];
    const count = Math.max(specs.length, fronts.length, 1);
    for (let profileIndex = 0; profileIndex < count; profileIndex++) {
      const spec = specs[profileIndex] || {}, front = fronts[profileIndex] || {};
      const fields = [];
      const add = (key, value, title) => {
        if (value !== null && value !== undefined && value !== "" && !["picture_url", "banner_url", "profile_url", "registered"].includes(key)) {
          fields.push({ label: cleanText(title || label(key), 100), value });
        }
      };
      for (const [key, value] of Object.entries(spec)) {
        if (key === "platform_variables") {
          for (const item of Array.isArray(value) ? value : []) add(item.key || "Detail", item.value, item.proper_key);
        } else add(key, fieldValue(value), value?.proper_key);
      }
      if (!fields.length) for (const [key, value] of Object.entries(front.body || {})) add(key, value);
      if (!fields.length && module.data && typeof module.data === "object") {
        for (const [key, value] of Object.entries(module.data)) add(key, value);
      }
      const statusText = String(module.status || "").toLowerCase();
      const registered = fieldValue(spec.registered) ?? module.data?.registered;
      const status = ["error", "timeout", "failed", "unavailable"].includes(statusText) ? "unavailable"
        : ["not_found", "not found", "notfound"].includes(statusText) || registered === false ? "not_found"
        : statusText === "found" || registered === true ? "found" : "unknown";
      const profileUrl = safeUrl(fieldValue(spec.profile_url) || front.profile_url || module.data?.profile_url);
      cards.push({ id: `${moduleIndex}-${profileIndex}`, module: cleanText(front.module || module.module || "Provider result", 100),
        status, provider_status: cleanText(module.status, 80), reliable_source: typeof module.reliable_source === "boolean" ? module.reliable_source : null,
        query: cleanText(module.query, 320), origin: cleanText(module.from, 400), profile_url: profileUrl,
        picture_url: safeUrl(fieldValue(spec.picture_url) || front.image),
        fields, evidence: count === 1 ? module : { module: module.module, status: module.status, query: module.query,
          from: module.from, reliable_source: module.reliable_source, spec_format: spec, front_schema: front } });
    }
  });
  return { cards, raw, modules_returned: modules.length, profiles_returned: cards.length,
    matches: cards.filter(card => card.status === "found").length,
    unavailable: cards.filter(card => card.status === "unavailable").length };
}

function providerError(status) {
  if ([401, 403].includes(status)) return { error: "OSINT Industries did not accept the API credentials or account access. Ask the administrator to check the connection.", code: "PROVIDER_AUTH", status: 503 };
  if (status === 402) return { error: "The OSINT Industries account has insufficient search credits.", code: "NO_CREDITS", status: 402 };
  if (status === 429) return { error: "OSINT Industries is rate limited. Wait before submitting a new search.", code: "PROVIDER_RATE_LIMIT", status: 429 };
  if (status === 400) return { error: "OSINT Industries rejected this search. Check the identifier and your account's permitted search types.", code: "PROVIDER_INPUT", status: 400 };
  return { error: "OSINT Industries is temporarily unavailable. This search was not automatically retried; a submitted search may have used a credit.", code: "PROVIDER_UNAVAILABLE", status: 502 };
}

export async function handleOSINTIndustries(request, env) {
  const path = new URL(request.url).pathname;
  if (!((path === "/social-osint/status" && request.method === "GET") || (path === "/social-osint/search" && request.method === "POST"))) return reply({ error: "Unsupported Social operation." }, 405, env);
  let session;
  try {
    const token = cleanText(request.headers.get("X-Session-Token"), 160);
    if (!token) return reply({ error: "Authenticated session required." }, 401, env);
    const response = await gateCall(env, "/session-get", { session_token: token });
    session = await response.json();
    if (!response.ok || !isAllowedUser(session.username, env)) return reply({ error: "Session expired." }, 401, env);
  } catch { return reply({ error: "Session verification is unavailable." }, 503, env); }
  const apiKey = String(env.OSINT_INDUSTRIES_API_KEY || "").trim();
  if (path === "/social-osint/status") {
    const body = { version: OSINT_INDUSTRIES_VERSION, configured: Boolean(apiKey), types: SEARCH_TYPES, premium: false, credits: null };
    if (apiKey) {
      try {
        const response = await fetch(CREDITS_URL, { headers: { "api-key": apiKey, Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10000) });
        if (response.ok) {
          const data = await boundedJSON(response, 16384);
          const value = typeof data === "number" ? data : data?.credits ?? data?.remaining_credits ?? data?.remaining;
          if (value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0) body.credits = Number(value);
          body.connection = "verified";
        } else body.connection = [401, 403].includes(response.status) ? "rejected" : "unavailable";
      } catch { body.connection = "unavailable"; }
    } else body.connection = "not_configured";
    return reply(body, 200, env);
  }
  if (!apiKey) return reply({ error: "OSINT Industries is ready for integration. The administrator still needs to connect the API key.", code: "NOT_CONFIGURED" }, 503, env);
  let search;
  try { search = parseSearch(await boundedJSON(new Response(request.body), 2048)); } catch { /* Invalid input is never submitted. */ }
  if (!search) return reply({ error: "Enter one valid identifier. Phone numbers need a +country code; usernames should be handles, not URLs.", code: "INVALID_QUERY" }, 400, env);
  let reserved = false;
  try {
    const limit = await gateCall(env, "/osint-industries-limit", { username: session.username, request_id: search.request_id });
    if (!limit.ok) return reply(await limit.json(), limit.status, env);
    reserved = true;
    const { request_id, ...body } = search;
    const response = await fetch(SEARCH_URL, { method: "POST", headers: { "api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(75000) });
    if (!response.ok) { const failure = providerError(response.status); return reply(failure, failure.status, env); }
    const results = normalizeResults(await boundedJSON(response, 8 * 1024 * 1024), apiKey);
    return reply({ version: OSINT_INDUSTRIES_VERSION, provider: "OSINT Industries", type: search.type, query: search.query,
      searched_at: new Date().toISOString(), timeout_seconds: 60, premium: false, exact_match: true, ...results }, 200, env);
  } catch {
    return reply({ error: "The search could not be completed or its response was unreadable. It was not retried automatically; a submitted search may have used a credit.", code: "SEARCH_UNAVAILABLE" }, 502, env);
  } finally {
    if (reserved) await gateCall(env, "/osint-industries-limit", { username: session.username, request_id: search.request_id, release: true }).catch(() => {});
  }
}
