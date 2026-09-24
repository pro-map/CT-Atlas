import {
  GEMINI_URL,
  cleanText,
  normalizeUsername,
  isAllowedUser,
  jsonResponse,
  gateCall,
  extractGeminiText
} from "./shared.js";
import {
  SOCIAL_AGENT_CLIENT_VERSION,
  isSocialAgentConfigured,
  runSocialAgent
} from "./social-agent-client.js";

const SOCIAL_INTEL_VERSION = "socmint-v3-adk-agent-first";
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
        add(item?.url || item?.retrieved_url || item?.uri, item?.title, item?.snippet, "url_context");
      }
    }
    if (step?.type === "model_output") {
      for (const part of Array.isArray(step.content) ? step.content : []) {
        for (const annotation of Array.isArray(part?.annotations) ? part.annotations : []) {
          if (annotation?.type === "url_citation") {
            add(annotation?.url || annotation?.uri, annotation?.title, "", "citation");
          }
        }
      }
    }
  }
  return Array.from(byUrl.values()).slice(0,100);
}

function normalizeAgentSources(raw, query) {
  const items = [];
  const seen = new Set();
  const add = (url, title = "", kind = "agent_public_source") => {
    const safe = safePublicUrl(url);
    if (!safe || seen.has(safe)) return;
    seen.add(safe);
    items.push({
      url: safe,
      title: cleanText(title, 300),
      snippet: "",
      kind: cleanText(kind, 60) || "agent_public_source"
    });
  };

  for (const item of Array.isArray(raw?.sources) ? raw.sources : []) {
    add(item?.url, item?.title, item?.kind);
  }
  for (const url of query.urls || []) add(url, "", "analyst_supplied");
  return items.slice(0, 100);
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

function uniqueModels(values) {
  const out = [];
  for (const value of values) {
    const model = cleanText(value, 100);
    if (model && !out.includes(model)) out.push(model);
  }
  return out;
}

function socmintModels(env, useSearch) {
  if (useSearch) {
    return uniqueModels([
      env.GEMINI_SOCMINT_SEARCH_MODEL,
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash"
    ]);
  }
  return uniqueModels([
    env.GEMINI_SOCMINT_MODEL,
    env.GEMINI_MODEL,
    "gemini-3.5-flash-lite",
    "gemini-2.5-flash-lite"
  ]);
}

function geminiFailure(response, detail, model, useSearch) {
  const error = new Error(`Gemini SOCMINT request failed (${response.status}) on ${model}.`);
  error.status = response.status;
  error.model = model;
  error.useSearch = useSearch;
  error.retry_after_seconds = Number(response.headers.get("Retry-After") || 0) || null;
  error.detail = cleanText(detail, 1600);
  error.quota = response.status === 429 || /quota|rate limit|too_many_requests/i.test(error.detail);
  error.unsupported = [400,403,404].includes(response.status) &&
    /not available|unsupported|not supported|permission|access/i.test(error.detail);
  return error;
}

async function geminiSocmintOnce(env, query, useSearch, model) {
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
      max_output_tokens: 12000
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
    const detail = await response.text();
    throw geminiFailure(response, detail, model, useSearch);
  }

  const payload = await response.json();
  const rawText = await extractGeminiText(payload);
  const normalized = rawText.trim().replace(/^\`\`\`(?:json)?\s*/i,"").replace(/\s*\`\`\`$/i,"");
  let parsed;
  try {
    parsed = JSON.parse(normalized);
  } catch (_) {
    const error = new Error("Gemini returned a SOCMINT response that could not be parsed.");
    error.status = 502;
    error.model = model;
    throw error;
  }
  return { parsed, payload, model };
}

async function geminiSocmint(env, query, useSearch) {
  const models = socmintModels(env, useSearch);
  let lastError = null;

  for (const model of models) {
    try {
      return await geminiSocmintOnce(env, query, useSearch, model);
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);

      // Try another model when the current model is unavailable, unsupported,
      // temporarily rate-limited or the project has exhausted that model's quota.
      if ([400,403,404,429,500,502,503,504].includes(status)) continue;
      throw error;
    }
  }

  throw lastError || new Error("No SOCMINT Gemini model was available.");
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

  const agentConfigured = isSocialAgentConfigured(env);
  if (!agentConfigured && !env.GEMINI_API_KEY) {
    return jsonResponse({ error: "Neither the SOCMINT ADK agent nor Gemini fallback is configured." }, 503, env);
  }

  const query = sanitizeRequest(body);
  if (!query.target && !query.usernames.length && !query.keywords.length && !query.urls.length) {
    return jsonResponse({ error: "Enter a target, username, keyword or public URL." }, 400, env);
  }
  if (query.mode === "urls_only" && !query.urls.length) {
    return jsonResponse({ error: "Analyze URLs mode requires at least one public URL." }, 400, env);
  }

  if (agentConfigured) {
    try {
      const agentResult = await runSocialAgent(env, username, query);
      const sources = normalizeAgentSources(agentResult.report, query);
      const report = normalizeReport(
        agentResult.report,
        query,
        sources,
        "ADK · " + cleanText(agentResult.meta?.agent_version || SOCIAL_AGENT_CLIENT_VERSION, 80),
        "adk_agent"
      );
      report.agent_meta = {
        agent: true,
        client_version: SOCIAL_AGENT_CLIENT_VERSION,
        agent_version: cleanText(agentResult.meta?.agent_version, 80),
        investigation_id: cleanText(agentResult.meta?.session_id, 100),
        event_count: Number(agentResult.meta?.event_count || 0),
        max_llm_calls: Number(agentResult.meta?.max_llm_calls || 0)
      };
      await persistReport(env, username, report);
      return jsonResponse({ ok: true, report, agent: true }, 200, env);
    } catch (error) {
      const status = Number(error?.status || 0);
      if (status === 429 || /QUOTA/.test(String(error?.code || ""))) {
        return jsonResponse({
          error: "The SOCMINT ADK agent reached its Gemini quota. Retry later; previous reports remain available.",
          code: "SOCMINT_AGENT_QUOTA_EXHAUSTED",
          retry_after_seconds: error?.retry_after_seconds || null
        }, 429, env);
      }
      console.error("SOCMINT ADK agent failed; using Gemini fallback when available.", {
        code: error?.code,
        status,
        message: cleanText(error?.message, 500)
      });
      if (!env.GEMINI_API_KEY) {
        return jsonResponse({
          error: "The SOCMINT ADK agent is temporarily unavailable and no Gemini fallback is configured.",
          code: "SOCMINT_AGENT_UNAVAILABLE"
        }, 503, env);
      }
    }
  }

  let result;
  let discoveryMode = query.mode === "discover" ? "google_search+url_context" : "url_context";
  try {
    result = await geminiSocmint(env, query, query.mode === "discover");
  } catch (error) {
    const status = Number(error?.status || 0);

    if (query.mode === "discover" && query.urls.length && [400,403,404,429,500,502,503,504].includes(status)) {
      // Search grounding can be unavailable or quota-limited on free projects.
      // Preserve usefulness by analyzing analyst-supplied public URLs instead.
      try {
        discoveryMode = "url_context_fallback";
        result = await geminiSocmint(env, query, false);
      } catch (fallbackError) {
        const fallbackStatus = Number(fallbackError?.status || 0);
        if (fallbackError?.quota || fallbackStatus === 429) {
          return jsonResponse({
            error: "Gemini free-tier quota is currently exhausted. The SOCMINT query was not lost. Retry later, or reduce the number of URLs. Public-web discovery uses Gemini 2.5 Flash-Lite when available; URL-only analysis uses the lightest available model.",
            code: "SOCMINT_QUOTA_EXHAUSTED",
            retry_after_seconds: fallbackError?.retry_after_seconds || error?.retry_after_seconds || null
          }, 429, env);
        }
        return jsonResponse({
          error: cleanText(fallbackError?.message || "SOCMINT URL analysis is temporarily unavailable.", 700),
          code: "SOCMINT_URL_ANALYSIS_UNAVAILABLE"
        }, fallbackStatus >= 400 && fallbackStatus < 600 ? fallbackStatus : 502, env);
      }
    } else if (query.mode === "discover" && !query.urls.length) {
      if (error?.quota || status === 429) {
        return jsonResponse({
          error: "The free public-web SOCMINT search quota is currently exhausted. Retry later, or add known public URLs and use Analyze URLs. CT Atlas now uses Gemini 2.5 Flash-Lite first for free grounded discovery when that model is available to the API project.",
          code: "SOCMINT_SEARCH_QUOTA_EXHAUSTED",
          retry_after_seconds: error?.retry_after_seconds || null
        }, 429, env);
      }
      if ([400,403,404].includes(status)) {
        return jsonResponse({
          error: "Public-web discovery is not available for this Gemini API project. Add known public URLs and use Analyze URLs. Gemini 3.x Google Search grounding is not available on the API Free Tier; CT Atlas will use Gemini 2.5 Flash-Lite for discovery when Google grants this project access to that model.",
          code: "SOCMINT_DISCOVERY_UNAVAILABLE"
        }, 424, env);
      }
      return jsonResponse({
        error: "Public-web SOCMINT discovery is temporarily unavailable. Retry later or provide public URLs for direct analysis.",
        code: "SOCMINT_DISCOVERY_TEMPORARY"
      }, 503, env);
    } else {
      if (error?.quota || status === 429) {
        return jsonResponse({
          error: "Gemini free-tier quota is currently exhausted. Retry later; the SOCMINT workspace and previous reports remain available.",
          code: "SOCMINT_QUOTA_EXHAUSTED",
          retry_after_seconds: error?.retry_after_seconds || null
        }, 429, env);
      }
      return jsonResponse({
        error: cleanText(error?.message || "SOCMINT generation failed.", 700),
        code: "SOCMINT_GENERATION_FAILED"
      }, status >= 400 && status < 600 ? status : 502, env);
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
  SOCIAL_AGENT_CLIENT_VERSION,
  SOCIAL_SCHEMA,
  sanitizeRequest,
  extractToolSources,
  handleSocialInvestigate,
  handleSocialWorkspace
};
