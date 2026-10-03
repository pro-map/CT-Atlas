import { cleanText, gateCall, isAllowedUser, sha256 } from "./shared.js";

export const DARKWEB_VERSION = "darkweb-v2-recursive-watch";
const TYPES = new Set(["pdf", "video", "audio", "image", "page"]);

export function onionUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) return "";
    if (!/^[a-z2-7]{56}\.onion$/.test(url.hostname) || url.href.length > 2000) return "";
    url.hash = "";
    return url.href;
  } catch { return ""; }
}

function reply(body, status, env) {
  const origin = env.__requestOrigin || "";
  const allowed = [env.ALLOWED_ORIGIN, ...String(env.EXTRA_ALLOWED_ORIGINS || "").split(",")].map(x => String(x || "").trim());
  return new Response(JSON.stringify(body), { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store, private",
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : (env.ALLOWED_ORIGIN || "*"),
    "Vary": "Origin", "X-Content-Type-Options": "nosniff"
  }});
}

async function collectorAuth(request, env) {
  const configured = String(env.DARKWEB_INGEST_TOKEN || "");
  if (configured.length < 32) return false;
  const supplied = request.headers.get("Authorization") || "";
  // Hash fixed-length representations rather than compare a secret prefix.
  return await sha256(supplied) === await sha256("Bearer " + configured);
}

export async function handleDarkweb(request, env) {
  const path = new URL(request.url).pathname;
  const collector = ["/darkweb/collector-config", "/darkweb/ingest"].includes(path);
  let username = "";
  if (collector) {
    if (!await collectorAuth(request, env)) return reply({ error: "Collector authentication required." }, 401, env);
  } else {
    const token = cleanText(request.headers.get("X-Session-Token"), 160);
    if (!token) return reply({ error: "Authenticated session required." }, 401, env);
    const response = await gateCall(env, "/session-get", { session_token: token });
    const session = await response.json().catch(() => ({}));
    username = String(session.username || "");
    if (!response.ok || !isAllowedUser(username, env)) return reply({ error: "Session expired." }, 401, env);
  }

  if (["/darkweb/feed", "/darkweb/collector-config"].includes(path) && request.method === "GET") {
    const response = await gateCall(env, "/darkweb-state", { username });
    const state = await response.json();
    if (collector) return reply({ version: DARKWEB_VERSION, outlets: state.outlets.filter(o => o.enabled) }, 200, env);
    return reply({ ...state, version: DARKWEB_VERSION, admin: username === "admin",
      collector_configured: String(env.DARKWEB_INGEST_TOKEN || "").length >= 32 }, response.status, env);
  }
  if (request.method !== "POST" || !["/darkweb/outlet", "/darkweb/ingest", "/darkweb/seen"].includes(path)) {
    return reply({ error: "Unsupported Dark Web operation." }, 405, env);
  }
  if (path === "/darkweb/outlet" && username !== "admin") return reply({ error: "Admin access required." }, 403, env);
  // Bound the actual body, including chunked requests with no Content-Length.
  const reader = request.body?.getReader();
  const chunks = []; let size = 0;
  if (!reader) return reply({ error: "JSON body required." }, 400, env);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 128000) { await reader.cancel(); return reply({ error: "Payload too large." }, 413, env); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let body;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return reply({ error: "Invalid JSON." }, 400, env); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return reply({ error: "JSON object required." }, 400, env);

  if (path === "/darkweb/outlet") {
    const url = onionUrl(body.url), name = cleanText(body.name, 100);
    if (!url || !name) return reply({ error: "A name and a valid v3 .onion URL are required." }, 400, env);
    const id = (await sha256(url)).slice(0, 32);
    const keywords = String(body.keywords || "").split(",").map(x => cleanText(x, 60)).filter(Boolean).slice(0, 10);
    const response = await gateCall(env, "/darkweb-outlet-save", { outlet: { id, name, url, enabled: body.enabled !== false, keywords } });
    return reply(await response.json(), response.status, env);
  }
  if (path === "/darkweb/seen") {
    // Mark only up to the snapshot the analyst actually viewed, never unseen newer arrivals.
    const seenAt = Date.parse(body.through || "");
    if (!Number.isFinite(seenAt) || seenAt > Date.now()) return reply({ error: "Valid snapshot time required." }, 400, env);
    const response = await gateCall(env, "/darkweb-seen", { username, through: new Date(seenAt).toISOString() });
    return reply(await response.json(), response.status, env);
  }

  const stateResponse = await gateCall(env, "/darkweb-state", {});
  const state = await stateResponse.json();
  const outlet = state.outlets.find(o => o.id === body.outlet_id && o.enabled);
  if (!outlet) return reply({ error: "Unknown or disabled outlet." }, 400, env);
  if (!Array.isArray(body.items) || body.items.length > 100) return reply({ error: "At most 100 items per scan." }, 400, env);
  const items = [];
  for (const raw of body.items) {
    const url = onionUrl(raw?.url);
    if (!url || new URL(url).hostname !== new URL(outlet.url).hostname) return reply({ error: "Item URL must belong to its registered outlet." }, 400, env);
    const title = cleanText(raw.title, 300) || new URL(url).pathname;
    const excerpt = cleanText(raw.excerpt, 600);
    const sourcePage = onionUrl(raw.source_page);
    items.push({ excerpt, source_page: sourcePage && new URL(sourcePage).hostname === new URL(outlet.url).hostname ? sourcePage : "", id: await sha256(outlet.id + "\n" + url), outlet_id: outlet.id, url, title,
      type: TYPES.has(raw.type) ? raw.type : "page", sha256: /^[a-f0-9]{64}$/i.test(raw.sha256 || "") ? raw.sha256.toLowerCase() : "",
      acquired: raw.acquired === true && /^[a-f0-9]{64}$/i.test(raw.sha256 || ""),
      bytes: Number.isSafeInteger(raw.bytes) && raw.bytes >= 0 ? raw.bytes : null,
      keyword_matches: outlet.keywords.filter(k => (title + " " + excerpt).toLowerCase().includes(k.toLowerCase()))
    });
  }
  const count = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 100000) : 0;
  const coverage = { pages_scanned: count(body.pages_scanned), pending_pages: count(body.pending_pages), failed_pages: count(body.failed_pages) };
  const response = await gateCall(env, "/darkweb-ingest", { ...coverage,
    outlet_id: outlet.id, items, scan_ok: body.scan_ok === true,
    scan_complete: body.scan_complete === true && coverage.pending_pages === 0 && coverage.failed_pages === 0, truncated: body.truncated === true,
    // Store an error code only: errors may contain URLs, credentials or proxy details.
    error: body.scan_ok === true ? "" : "collection_failed"
  });
  return reply(await response.json(), response.status, env);
}
