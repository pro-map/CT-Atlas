import {
ALLOWED_PERIODS,
REPORT_GENERATOR_VERSION,
MAX_EVENTS_CURRENT,
MAX_EVENTS_PREVIOUS,
CACHE_TTL_MS,
SESSION_TTL_MS,
USER_PASSWORD_HASHES,
corsHeaders,
jsonResponse,
cleanText,
normalizeUsername,
isAllowedUser,
sha256,
gateCall,
matchesRegion,
matchesTopic,
parseEventDate,
priority,
stats,
compactEvent,
citationMetrics,
callGemini
} from "./shared.js";
import { handleDeepSearch, DEEP_SEARCH_VERSION } from "./deep-search.js";
import { handleQuickAsk, QUICK_ASK_VERSION } from "./quick-ask.js";
import { handleFeedback, FEEDBACK_VERSION } from "./feedback.js";
import { handleQuiz } from "./quiz.js";
export default {
async fetch(request, env, ctx) {
// A fresh per-request copy, never a mutation of the shared env object --
// concurrent requests in the same isolate must never see each other's
// Origin. See corsHeaders() in shared.js for how this is consumed.
env = { ...env, __requestOrigin: request.headers.get("Origin") || "" };
const url = new URL(request.url);
if (request.method === "OPTIONS") {
return new Response(null, { status: 204, headers: corsHeaders(env) });
}
if (url.pathname === "/health" && request.method === "GET") {
return jsonResponse({ ok: true, service: "ct-report-generator", version: "5.28", deep_search: true, deep_search_version: DEEP_SEARCH_VERSION, report_generator_version: REPORT_GENERATOR_VERSION, quick_ask_version: QUICK_ASK_VERSION, feedback_version: FEEDBACK_VERSION, quiz_tracking: true, quiz_protocol: 2, model: "gemini-3.5-flash-lite" }, 200, env);
}
if (url.pathname === "/auth-login" && request.method === "POST") {
let authBody;
try { authBody = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON request." }, 400, env); }
const username = normalizeUsername(authBody.username);
const password = String(authBody.password || "");
if (!isAllowedUser(username) || !password) return jsonResponse({ error: "Incorrect username or password." }, 401, env);
const passwordHash = await sha256(password);
if (USER_PASSWORD_HASHES[username] !== passwordHash) return jsonResponse({ error: "Incorrect username or password." }, 401, env);
const sessionResponse = await gateCall(env, "/session-create", { username, ttl_ms: SESSION_TTL_MS });
const session = await sessionResponse.json();
if (!sessionResponse.ok || !session?.session_token) return jsonResponse({ error: "Unable to create session." }, 503, env);
return jsonResponse({ ok: true, username, session_token: session.session_token, expires_at: session.expires_at }, 200, env);
}
if (url.pathname === "/login" && request.method === "POST") {
let loginBody;
try { loginBody = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON request." }, 400, env); }
const username = normalizeUsername(loginBody.username);
const token = cleanText(request.headers.get("X-Session-Token"), 160);
if (!isAllowedUser(username)) return jsonResponse({ error: "Unknown user." }, 400, env);
if (!token) return jsonResponse({ error: "Authenticated session required." }, 401, env);
const sessionResponse = await gateCall(env, "/session-get", { session_token: token });
const session = await sessionResponse.json();
if (!sessionResponse.ok || session?.username !== username) return jsonResponse({ error: "Unauthorized session." }, 401, env);
const rawIp = request.headers.get("CF-Connecting-IP") || "";
const ipHash = rawIp ? await sha256(rawIp) : "";
const auditResponse = await gateCall(env, "/login-record", { username, client_time: cleanText(loginBody.client_time, 64), user_agent: cleanText(loginBody.user_agent, 320), country: cleanText(request.cf?.country, 16), ip_hash: ipHash });
return jsonResponse({ ok: auditResponse.ok }, auditResponse.ok ? 200 : 503, env);
}
if (url.pathname === "/login-stats" && request.method === "GET") {
const supplied = request.headers.get("X-Admin-Log-Key") || "";
if (!env.ADMIN_LOG_KEY || supplied !== env.ADMIN_LOG_KEY) return jsonResponse({ error: "Unauthorized" }, 401, env);
const statsResponse = await gateCall(env, "/login-stats", {});
return jsonResponse(await statsResponse.json(), statsResponse.status, env);
}
if (url.pathname === "/usage-record" && request.method === "POST") {
let usageBody;
try { usageBody = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON request." }, 400, env); }
const username = normalizeUsername(usageBody.username);
const action = cleanText(usageBody.action, 64);
const token = cleanText(request.headers.get("X-Session-Token"), 160);
if (!isAllowedUser(username)) return jsonResponse({ error: "Unknown user." }, 400, env);
if (!token) return jsonResponse({ error: "Authenticated session required." }, 401, env);
const sessionResponse = await gateCall(env, "/session-get", { session_token: token });
const session = await sessionResponse.json();
if (!sessionResponse.ok || session?.username !== username) return jsonResponse({ error: "Unauthorized session." }, 401, env);
if (!["map_search", "event_list_search"].includes(action)) return jsonResponse({ error: "Unsupported usage action." }, 400, env);
const recordResponse = await gateCall(env, "/usage-record", { username, action });
return jsonResponse(await recordResponse.json(), recordResponse.status, env);
}
if (url.pathname === "/usage-stats" && request.method === "GET") {
const token = cleanText(request.headers.get("X-Session-Token"), 160);
if (!token) return jsonResponse({ error: "Admin session required." }, 401, env);
const sessionResponse = await gateCall(env, "/session-get", { session_token: token });
const session = await sessionResponse.json();
if (!sessionResponse.ok || session?.username !== "admin") return jsonResponse({ error: "Admin access required." }, 403, env);
const period = cleanText(url.searchParams.get("period") || "today", 16);
if (!["today", "7", "30", "all"].includes(period)) return jsonResponse({ error: "Unsupported statistics period." }, 400, env);
const statsResponse = await gateCall(env, "/usage-stats", { period });
return jsonResponse(await statsResponse.json(), statsResponse.status, env);
}
if (["/quiz-answer", "/quiz-state"].includes(url.pathname)) return handleQuiz(request, env);
if (url.pathname === "/deep-search" && request.method === "POST") {
return handleDeepSearch(request, env, ctx);
}
if (url.pathname === "/quick-ask" && request.method === "POST") {
return handleQuickAsk(request, env);
}
if (url.pathname === "/feedback" && request.method === "POST") {
return handleFeedback(request, env);
}
if (url.pathname !== "/report" || request.method !== "POST") return jsonResponse({ error: "Not found" }, 404, env);
let body;
try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON request." }, 400, env); }
const region = cleanText(body.region || "GLOBAL", 100) || "GLOBAL";
const topic = cleanText(body.topic || "ALL", 120) || "ALL";
const periodDays = Number(body.period_days || 30);
const compare = body.compare !== false;
const username = normalizeUsername(body.user_id);
const token = cleanText(request.headers.get("X-Session-Token"), 160);
if (!username) return jsonResponse({ error: "Missing user identifier." }, 400, env);
if (!isAllowedUser(username)) return jsonResponse({ error: "Unknown user." }, 400, env);
if (!ALLOWED_PERIODS.has(periodDays)) return jsonResponse({ error: "Unsupported period." }, 400, env);
if (!token) return jsonResponse({ error: "Authenticated session required. Please sign in again." }, 401, env);
const sessionResponse = await gateCall(env, "/session-get", { session_token: token });
const session = await sessionResponse.json();
if (!sessionResponse.ok || session?.username !== username) return jsonResponse({ error: "Unauthorized session." }, 401, env);
const dbResponse = await fetch(env.EVENTS_URL, { cf: { cacheTtl: 60, cacheEverything: true } });
if (!dbResponse.ok) return jsonResponse({ error: "Unable to read current events database." }, 503, env);
const db = await dbResponse.json();
const allEvents = Array.isArray(db) ? db : (Array.isArray(db.events) ? db.events : []);
const databaseVersion = cleanText(db.updated_at || db.generated_at || db.last_updated || "unknown", 100);
const cacheKey = await sha256(JSON.stringify({ region, topic, periodDays, compare, databaseVersion, version: REPORT_GENERATOR_VERSION }));
const permitResponse = await gateCall(env, "/acquire", { username });
const permit = await permitResponse.json();
if (!permitResponse.ok || !permit?.permit_id) return jsonResponse({ error: permit?.error || "Report capacity temporarily unavailable.", retry_after_seconds: permit?.retry_after_seconds || 20 }, permitResponse.status || 429, env);
const permitId = permit.permit_id;
try {
const cachedResponse = await gateCall(env, "/cache-get", { cacheKey });
const cached = await cachedResponse.json();
if (cached?.hit && cached?.report) {
const commitResponse = await gateCall(env, "/commit-report", { permitId, username });
if (!commitResponse.ok) {
const commitError = await commitResponse.json().catch(()=>({}));
throw new Error(commitError?.error || "Unable to finalize report allowance.");
}
await gateCall(env, "/usage-increment", { username, metrics: { cached_reports: 1 } });
return jsonResponse({ ...cached.report, cached: true }, 200, env);
}
const now = new Date();
const currentStart = new Date(now.getTime() - periodDays * 86400000);
const previousStart = new Date(currentStart.getTime() - periodDays * 86400000);
const matching = allEvents.filter(e => matchesRegion(e, region) && matchesTopic(e, topic));
const current = [], previous = [];
for (const event of matching) {
const dt = parseEventDate(event);
if (!dt) continue;
if (dt >= currentStart && dt <= now) current.push(event);
else if (compare && dt >= previousStart && dt < currentStart) previous.push(event);
}
if (!current.length) return jsonResponse({ error: "No matching events found for the selected current period." }, 422, env);
current.sort((a,b)=>priority(b)-priority(a)); previous.sort((a,b)=>priority(b)-priority(a));
// Assign a sequential source_id (S01, S02...) to every event handed to
// Gemini, in the same [Sxx] convention Deep Search already uses, so the
// model can cite a specific record instead of writing unsupported prose --
// and so the response can carry back a real, clickable sources list plus a
// citation-coverage metric instead of a plain block of text.
let sourceSeq = 0;
const withSourceId = event => ({ ...compactEvent(event), source_id: `S${String(++sourceSeq).padStart(2, "0")}` });
const currentSourced = current.slice(0, MAX_EVENTS_CURRENT).map(withSourceId);
const previousSourced = compare ? previous.slice(0, MAX_EVENTS_PREVIOUS).map(withSourceId) : [];
const allSourced = [...currentSourced, ...previousSourced];
const dataset = { selection: { region, topic, period_days: periodDays, compare }, database_version: databaseVersion, current_period: { start: currentStart.toISOString(), end: now.toISOString(), stats: stats(current), priority_events: currentSourced }, comparison_period: compare ? { start: previousStart.toISOString(), end: currentStart.toISOString(), stats: stats(previous), priority_events: previousSourced } : null };
const generated = await callGemini(env, dataset);
const meta = `${region === "GLOBAL" ? "Global" : region} · ${topic === "ALL" ? "All CT activity" : topic} · last ${periodDays} days${compare ? " vs previous equivalent period" : ""} · generated ${new Date().toISOString()}`;
const analysisText = String(generated.analysis || "").trim();
const grounding = citationMetrics(analysisText, allSourced.map(e => e.source_id));
const sources = allSourced.map(e => ({ id: e.source_id, title: e.title, source: e.source, url: e.url, date: e.date, country: e.country, source_count: e.source_count, relevance: e.relevance }));
const report = { title: cleanText(generated.title || `CT Analytical Report — ${region}`, 180), analysis: analysisText, meta, database_version: databaseVersion, generated_at: new Date().toISOString(), sources, grounding };
await gateCall(env, "/cache-put", { cacheKey, report, expires_at: Date.now() + CACHE_TTL_MS });
const commitResponse = await gateCall(env, "/commit-report", { permitId, username });
if (!commitResponse.ok) {
const commitError = await commitResponse.json().catch(()=>({}));
throw new Error(commitError?.error || "Unable to finalize report allowance.");
}
await gateCall(env, "/usage-increment", { username, metrics: { reports_generated: 1 } });
return jsonResponse({ ...report, cached: false }, 200, env);
} catch (error) {
console.error(error);
const status = Number(error?.code) === 429 ? 429 : 503;
return jsonResponse({ error: cleanText(error?.message || "Report generation failed.", 300), ...(status === 429 ? { retry_after_seconds: 300 } : {}) }, status, env);
} finally { ctx.waitUntil(gateCall(env, "/release", { permitId, username })); }
}
};
export { ReportGate } from "./report-gate.js";
