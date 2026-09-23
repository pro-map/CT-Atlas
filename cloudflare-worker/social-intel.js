import {
  GEMINI_URL,
  cleanText,
  normalizeUsername,
  isAllowedUser,
  jsonResponse,
  gateCall,
  extractGeminiText
} from "./shared.js";

const SOCIAL_INTEL_VERSION = "socmint-v1-public-web-report";
const SOCIAL_REPORT_LIMIT = 50;

const SOCIAL_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    executive_assessment: { type: "string" },
    source_coverage: { type: "string" },
    identity_alias_findings: { type: "string" },
    network_associations: { type: "string" },
    content_narrative: { type: "string" },
    activity_timeline: { type: "string" },
    locations_travel_signals: { type: "string" },
    financial_crypto_indicators: { type: "string" },
    ct_relevance: { type: "string" },
    key_findings: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        properties: {
          finding: { type: "string" },
          confidence: { type: "string", enum: ["HIGH","MEDIUM","LOW"] },
          basis: { type: "string" },
          source_urls: { type: "array", maxItems: 8, items: { type: "string" } }
        },
        required: ["finding","confidence","basis","source_urls"]
      }
    },
    entities: {
      type: "array",
      maxItems: 60,
      items: {
        type: "object",
        properties: {
          type: { type: "string" },
          value: { type: "string" },
          platform: { type: "string" },
          confidence: { type: "string", enum: ["HIGH","MEDIUM","LOW"] },
          basis: { type: "string" },
          source_urls: { type: "array", maxItems: 8, items: { type: "string" } }
        },
        required: ["type","value","platform","confidence","basis","source_urls"]
      }
    },
    analytical_gaps: { type: "string" },
    watchpoints: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        properties: {
          issue: { type: "string" },
          indicator: { type: "string" }
        },
        required: ["issue","indicator"]
      }
    }
  },
  required: [
    "title","executive_assessment","source_coverage","identity_alias_findings",
    "network_associations","content_narrative","activity_timeline",
    "locations_travel_signals","financial_crypto_indicators","ct_relevance",
    "key_findings","entities","analytical_gaps","watchpoints"
  ]
};

const SOCIAL_SYSTEM = `
You are CT Atlas SOCMINT, a senior counter-terrorism open-source social-media
analyst. Produce an evidence-led SOCMINT assessment using only public web
information retrieved by the enabled tools and URLs supplied by the analyst.

STRICT EVIDENCE RULES
- Do not claim access to private accounts, closed groups, private messages,
  subscriber-only data, platform backend data, deleted content, IP addresses,
  device identifiers or non-public law-enforcement information.
- Never invent posts, handles, identities, relationships, locations, dates,
  wallet addresses or quotations.
- A common username, profile image, language, follower overlap, shared channel
  or repeated content does NOT by itself establish common ownership or identity.
- Distinguish OBSERVATION from ASSESSMENT. Use confidence HIGH/MEDIUM/LOW for
  analytical links and explain the basis.
- Where public evidence is insufficient, say so explicitly.
- Do not infer protected personal characteristics.
- For extremist/terrorist content, describe and assess it; do not reproduce
  propaganda unnecessarily and do not provide amplification instructions.

ANALYTICAL PRIORITIES
1. Identity and alias resolution, with explicit uncertainty.
2. Account/channel/network associations and cross-platform links.
3. Narrative, propaganda, recruitment, facilitation or operational themes.
4. Temporal changes and activity patterns.
5. Geographic references and travel indicators when genuinely supported.
6. Publicly exposed crypto wallets, donation requests or financial indicators.
7. Links to named terrorist organizations, facilitators, events or criminal
   activity only where supported by public sources.
8. Concrete analytical gaps and watch indicators.

REPORT STANDARD
- Produce a substantive professional SOCMINT report, not a list of search hits.
- Executive assessment must explain what the evidence means.
- Every key finding must include confidence, analytical basis and supporting
  public URLs when available.
- Source coverage must state platforms/sources actually observed and important
  limitations such as unavailable or inaccessible pages.
- If Google Search finds third-party reporting about a social account, clearly
  distinguish that from directly observing the account itself.
- Keep the report useful for international police cooperation and cross-border
  analytical support without implying that CT Atlas is an official INTERPOL
  database or that a match is confirmed.
`;

function safePublicUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (!["https:","http:"].includes(url.protocol)) return "";
    if (url.username || url.password) return "";
    const host = url.hostname.toLowerCase();
    if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return "";
    if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(host)) return "";
    const m = host.match(/^172\.(\d+)\./);
    if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return "";
    return url.toString();
  } catch (_) {
    return "";
  }
}

function listText(value, maxItems=30, maxLen=120) {
  if (Array.isArray(value)) {
    return value.map(x => cleanText(x, maxLen)).filter(Boolean).slice(0,maxItems);
  }
  return String(value || "")
    .split(/[\n,;]+/)
    .map(x => cleanText(x, maxLen))
    .filter(Boolean)
    .slice(0,maxItems);
}

function sanitizeRequest(body) {
  const urls = listText(body.urls, 20, 1500).map(safePublicUrl).filter(Boolean);
  const platforms = listText(body.platforms, 12, 40);
  const mode = cleanText(body.mode, 24).toLowerCase() === "urls_only" ? "urls_only" : "discover";
  const dateFrom = cleanText(body.date_from, 16);
  const dateTo = cleanText(body.date_to, 16);
  return {
    target: cleanText(body.target, 400),
    usernames: listText(body.usernames, 40, 160),
    platforms,
    keywords: listText(body.keywords, 40, 160),
    urls,
    countries_regions: listText(body.countries_regions, 20, 120),
    languages: listText(body.languages, 20, 60),
    date_from: /^\d{4}-\d{2}-\d{2}$/.test(dateFrom) ? dateFrom : "",
    date_to: /^\d{4}-\d{2}-\d{2}$/.test(dateTo) ? dateTo : "",
    objective: cleanText(body.objective, 1500),
    mode
  };
}

function extractToolSources(payload) {
  const byUrl = new Map();
  const add = (url,title="",snippet="",kind="") => {
    const safe = safePublicUrl(url);
    if (!safe) return;
    const prev = byUrl.get(safe) || {};
    byUrl.set(safe, {
      url: safe,
      title: cleanText(title || prev.title, 300),
      snippet: cleanText(snippet || prev.snippet, 700),
      kind: cleanText(kind || prev.kind, 40)
    });
  };

  for (const step of Array.isArray(payload?.steps) ? payload.steps : []) {
    if (step?.type === "google_search_result") {
      for (const item of Array.isArray(step.result) ? step.result : []) {
        add(item?.url, item?.title, item?.snippet, "google_search");
      }
    }
    if (step?.type === "url_context_result") {
      for (const item of Array.isArray(step.result) ? step.result : []) {
        add(item?.url, item?.title, item?.snippet, "url_context");
      }
    }
    if (step?.type === "model_output") {
      for (const part of Array.isArray(step.content) ? step.content : []) {
        for (const annotation of Array.isArray(part?.annotations) ? part.annotations : []) {
          if (annotation?.type === "url_citation") {
            add(annotation?.url, annotation?.title, "", "citation");
          }
        }
      }
    }
  }
  return Array.from(byUrl.values()).slice(0,100);
}

function normalizeReport(raw, query, toolSources, model, discoveryMode) {
  const safeUrls = new Set(toolSources.map(s => s.url));
  for (const url of query.urls) safeUrls.add(url);

  const sourceUrls = value => listText(value, 8, 1500)
    .map(safePublicUrl)
    .filter(url => url && safeUrls.has(url));

  const conf = value => {
    const v = cleanText(value, 16).toUpperCase();
    return ["HIGH","MEDIUM","LOW"].includes(v) ? v : "LOW";
  };

  return {
    id: crypto.randomUUID(),
    version: SOCIAL_INTEL_VERSION,
    generated_at: new Date().toISOString(),
    model: cleanText(model, 80),
    discovery_mode: discoveryMode,
    query,
    title: cleanText(raw?.title || "CT Atlas SOCMINT Assessment", 220),
    executive_assessment: cleanText(raw?.executive_assessment, 8000),
    source_coverage: cleanText(raw?.source_coverage, 5000),
    identity_alias_findings: cleanText(raw?.identity_alias_findings, 7000),
    network_associations: cleanText(raw?.network_associations, 7000),
    content_narrative: cleanText(raw?.content_narrative, 7000),
    activity_timeline: cleanText(raw?.activity_timeline, 7000),
    locations_travel_signals: cleanText(raw?.locations_travel_signals, 6000),
    financial_crypto_indicators: cleanText(raw?.financial_crypto_indicators, 6000),
    ct_relevance: cleanText(raw?.ct_relevance, 7000),
    key_findings: Array.isArray(raw?.key_findings) ? raw.key_findings.slice(0,12).map(x => ({
      finding: cleanText(x?.finding, 1800),
      confidence: conf(x?.confidence),
      basis: cleanText(x?.basis, 2400),
      source_urls: sourceUrls(x?.source_urls)
    })).filter(x => x.finding) : [],
    entities: Array.isArray(raw?.entities) ? raw.entities.slice(0,60).map(x => ({
      type: cleanText(x?.type, 60).toUpperCase(),
      value: cleanText(x?.value, 300),
      platform: cleanText(x?.platform, 80),
      confidence: conf(x?.confidence),
      basis: cleanText(x?.basis, 1800),
      source_urls: sourceUrls(x?.source_urls)
    })).filter(x => x.value) : [],
    analytical_gaps: cleanText(raw?.analytical_gaps, 5000),
    watchpoints: Array.isArray(raw?.watchpoints) ? raw.watchpoints.slice(0,10).map(x => ({
      issue: cleanText(x?.issue, 1000),
      indicator: cleanText(x?.indicator, 1400)
    })).filter(x => x.issue) : [],
    sources: toolSources
  };
}

async function authenticate(request, env, username) {
  const token = cleanText(request.headers.get("X-Session-Token"), 160);
  if (!token) return { error: "Authenticated session required.", status: 401 };
  const response = await gateCall(env, "/session-get", { session_token: token });
  const session = await response.json().catch(() => ({}));
  if (!response.ok || session?.username !== username) {
    return { error: "Unauthorized session.", status: 401 };
  }
  return { ok: true };
}

async function geminiSocmint(env, query, useSearch) {
  const model = env.GEMINI_SOCMINT_MODEL || env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  const tools = [];
  if (useSearch) tools.push({ type: "google_search", search_types: ["web_search"] });
  if (query.urls.length) tools.push({ type: "url_context" });

  const input = [
    "Conduct the requested public-source SOCMINT investigation.",
    "Search parameters:",
    JSON.stringify(query),
    query.urls.length
      ? "Known public URLs supplied by the analyst must be examined when accessible."
      : "No known URLs were supplied by the analyst.",
    useSearch
      ? "Use public Google web search to discover relevant public material, including publicly indexed social-media pages and reliable reporting. Search across the requested platforms where publicly indexed."
      : "Do not claim web discovery beyond the supplied URLs.",
    "Return the structured SOCMINT assessment."
  ].join("\n\n");

  const body = {
    model,
    input,
    system_instruction: SOCIAL_SYSTEM,
    store: false,
    response_format: {
      type: "text",
      mime_type: "application/json",
      schema: SOCIAL_SCHEMA
    },
    generation_config: {
      max_output_tokens: 12000,
      thinking_level: "low"
    }
  };
  if (tools.length) body.tools = tools;

  const response = await fetch(GEMINI_URL, {
    method: "POST",
    headers: {
      "x-goog-api-key": env.GEMINI_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const detail = cleanText(await response.text(), 1200);
    const error = new Error(`Gemini SOCMINT error ${response.status}: ${detail}`);
    error.status = response.status;
    throw error;
  }

  const payload = await response.json();
  const rawText = await extractGeminiText(payload);
  const normalized = rawText.trim().replace(/^\`\`\`(?:json)?\s*/i,"").replace(/\s*\`\`\`$/i,"");
  const parsed = JSON.parse(normalized);
  return { parsed, payload, model };
}

async function persistReport(env, username, report) {
  const currentResponse = await gateCall(env, "/social-workspace-get", { username });
  const currentPayload = await currentResponse.json().catch(() => ({}));
  const workspace = currentPayload?.workspace && typeof currentPayload.workspace === "object"
    ? currentPayload.workspace
    : { version: SOCIAL_INTEL_VERSION, username, reports: [] };
  const reports = Array.isArray(workspace.reports) ? workspace.reports : [];
  reports.unshift(report);
  workspace.version = SOCIAL_INTEL_VERSION;
  workspace.username = username;
  workspace.reports = reports.slice(0, SOCIAL_REPORT_LIMIT);
  workspace.updated_at = new Date().toISOString();
  await gateCall(env, "/social-workspace-put", { username, workspace });
  await gateCall(env, "/usage-increment", { username, metrics: { social_intel_requests: 1 } });
}

async function handleSocialWorkspace(request, env) {
  const url = new URL(request.url);
  let body = {};
  if (request.method === "POST") {
    try { body = await request.json(); }
    catch { return jsonResponse({ error: "Invalid JSON request." }, 400, env); }
  }
  const username = normalizeUsername(
    request.method === "GET" ? url.searchParams.get("user_id") : body.user_id
  );
  if (!username || !isAllowedUser(username, env)) {
    return jsonResponse({ error: "Unknown user." }, 400, env);
  }
  const auth = await authenticate(request, env, username);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status, env);

  if (request.method === "GET") {
    const response = await gateCall(env, "/social-workspace-get", { username });
    return jsonResponse(await response.json().catch(() => ({})), response.status, env);
  }
  if (request.method === "POST") {
    const reportId = cleanText(body.report_id, 80);
    const response = await gateCall(env, "/social-report-delete", { username, report_id: reportId });
    return jsonResponse(await response.json().catch(() => ({})), response.status, env);
  }
  return jsonResponse({ error: "Unsupported method." }, 405, env);
}

async function handleSocialInvestigate(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "Invalid JSON request." }, 400, env); }

  const username = normalizeUsername(body.user_id);
  if (!username || !isAllowedUser(username, env)) {
    return jsonResponse({ error: "Unknown user." }, 400, env);
  }
  const auth = await authenticate(request, env, username);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status, env);
  if (!env.GEMINI_API_KEY) {
    return jsonResponse({ error: "Gemini API key is not configured." }, 503, env);
  }

  const query = sanitizeRequest(body);
  if (!query.target && !query.usernames.length && !query.keywords.length && !query.urls.length) {
    return jsonResponse({ error: "Enter a target, username, keyword or public URL." }, 400, env);
  }
  if (query.mode === "urls_only" && !query.urls.length) {
    return jsonResponse({ error: "Analyze URLs mode requires at least one public URL." }, 400, env);
  }

  let result;
  let discoveryMode = query.mode === "discover" ? "google_search+url_context" : "url_context";
  try {
    result = await geminiSocmint(env, query, query.mode === "discover");
  } catch (error) {
    const status = Number(error?.status || 0);
    if (query.mode === "discover" && query.urls.length && [400,403,404,429].includes(status)) {
      discoveryMode = "url_context_fallback";
      result = await geminiSocmint(env, query, false);
    } else if (query.mode === "discover" && !query.urls.length && [400,403,404].includes(status)) {
      return jsonResponse({
        error: "Public web discovery is not available with the current Gemini API tier/model. Add known public URLs and run Analyze URLs, or enable Google Search grounding for this API project.",
        code: "SOCMINT_DISCOVERY_UNAVAILABLE"
      }, 424, env);
    } else {
      return jsonResponse({ error: cleanText(error?.message || "SOCMINT generation failed.", 1200) }, status === 429 ? 429 : 502, env);
    }
  }

  const sources = extractToolSources(result.payload);
  for (const url of query.urls) {
    if (!sources.some(s => s.url === url)) sources.push({ url, title: "", snippet: "", kind: "analyst_supplied" });
  }
  const report = normalizeReport(result.parsed, query, sources, result.model, discoveryMode);
  await persistReport(env, username, report);
  return jsonResponse({ ok: true, report }, 200, env);
}

export {
  SOCIAL_INTEL_VERSION,
  SOCIAL_SCHEMA,
  sanitizeRequest,
  extractToolSources,
  handleSocialInvestigate,
  handleSocialWorkspace
};
