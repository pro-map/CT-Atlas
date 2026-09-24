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

const SOCIAL_INTEL_VERSION = "socmint-v4-adk-safe-fallback";
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

async function braveWorkerDiscovery(env, query) {
  const key = String(env?.BRAVE_SEARCH_API_KEY || "").trim();
  if (!key) return { provider: "disabled", sources: [] };

  const terms = [];
  if (query.target) terms.push(query.target);
  for (const value of (query.usernames || []).slice(0, 3)) terms.push(value);
  for (const value of (query.keywords || []).slice(0, 4)) terms.push(value);
  const base = terms.filter(Boolean).join(" ").trim();
  if (!base) return { provider: "brave", sources: [] };

  const platformSites = {
    LinkedIn: "site:linkedin.com",
    YouTube: "site:youtube.com",
    Telegram: "site:t.me",
    Reddit: "site:reddit.com",
    X: "site:x.com",
    Twitter: "site:x.com",
    Twitch: "site:twitch.tv",
    Tumblr: "site:tumblr.com",
    Facebook: "site:facebook.com",
    Instagram: "site:instagram.com",
    TikTok: "site:tiktok.com",
    VK: "site:vk.com",
    Bluesky: "site:bsky.app"
  };

  const queries = [];
  const requestedPlatforms = (query.platforms || []).slice(0, 4);
  for (const platform of requestedPlatforms) {
    const site = platformSites[platform];
    if (site) queries.push(`${base} ${site}`);
  }
  queries.push(base);

  const seenQuery = new Set();
  const seenUrl = new Set();
  const sources = [];
  for (const rawQuery of queries) {
    const q = cleanText(rawQuery, 450);
    if (!q || seenQuery.has(q) || sources.length >= 10) continue;
    seenQuery.add(q);
    try {
      const response = await fetch("https://api.search.brave.com/res/v1/web/search?" + new URLSearchParams({
        q,
        count: "6"
      }).toString(), {
        headers: {
          "Accept": "application/json",
          "X-Subscription-Token": key
        }
      });
      if (!response.ok) continue;
      const payload = await response.json().catch(() => ({}));
      for (const item of (payload?.web?.results || [])) {
        const url = safePublicUrl(item?.url);
        if (!url || seenUrl.has(url)) continue;
        seenUrl.add(url);
        sources.push({
          url,
          title: cleanText(item?.title, 300),
          snippet: cleanText(item?.description, 700),
          kind: "brave_search"
        });
        if (sources.length >= 10) break;
      }
    } catch (_) {
      // Discovery fallback is best-effort; the ADK/URL analysis path remains authoritative.
    }
  }
  return { provider: "brave", sources };
}

function htmlToEvidenceText(value) {
  return cleanText(
    String(value || "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;|&#34;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">"),
    14000
  );
}

async function fetchPublicEvidencePage(source) {
  const url = safePublicUrl(source?.url);
  if (!url) return { ...source, fetched: false, fetch_status: "invalid_url", evidence_text: "" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        "User-Agent": "CT-Atlas-Public-Research/1.0"
      }
    });
    const type = String(response.headers.get("Content-Type") || "").toLowerCase();
    const length = Number(response.headers.get("Content-Length") || 0);
    if (!response.ok) {
      return { ...source, fetched: false, fetch_status: "http_" + response.status, evidence_text: "" };
    }
    if (length > 2_000_000) {
      return { ...source, fetched: false, fetch_status: "too_large", evidence_text: "" };
    }
    if (!type.includes("text/") && !type.includes("html") && !type.includes("json")) {
      return { ...source, fetched: false, fetch_status: "non_text", evidence_text: "" };
    }
    const raw = (await response.text()).slice(0, 180000);
    const evidenceText = type.includes("html") ? htmlToEvidenceText(raw) : cleanText(raw, 14000);
    return {
      ...source,
      fetched: Boolean(evidenceText),
      fetch_status: evidenceText ? "observed_public_page" : "empty",
      observed_url: safePublicUrl(response.url) || url,
      evidence_text: evidenceText
    };
  } catch (error) {
    return {
      ...source,
      fetched: false,
      fetch_status: error?.name === "AbortError" ? "timeout" : "fetch_error",
      evidence_text: ""
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBraveEvidencePages(sources) {
  const selected = (Array.isArray(sources) ? sources : []).slice(0, 6);
  const results = [];
  for (const source of selected) {
    results.push(await fetchPublicEvidencePage(source));
  }
  for (const source of (Array.isArray(sources) ? sources : []).slice(6, 10)) {
    results.push({ ...source, fetched: false, fetch_status: "snippet_only", evidence_text: "" });
  }
  return results;
}

function sourceForReport(item) {
  return {
    url: safePublicUrl(item?.observed_url || item?.url),
    title: cleanText(item?.title, 300),
    snippet: cleanText(item?.snippet, 700),
    kind: item?.fetched ? "direct_public_page" : "search_result",
    observed_at: item?.fetched ? new Date().toISOString() : "",
    retrieval_status: cleanText(item?.fetch_status, 40)
  };
}

async function geminiEvidenceSynthesisOnce(env, query, evidence, model) {
  const evidencePack = evidence.map((item, index) => ({
    source_id: "S" + (index + 1),
    url: safePublicUrl(item?.observed_url || item?.url),
    title: cleanText(item?.title, 300),
    brave_snippet: cleanText(item?.snippet, 700),
    retrieval_status: cleanText(item?.fetch_status, 40),
    public_page_text: cleanText(item?.evidence_text, 12000)
  })).filter(item => item.url);

  const input = [
    "Produce the requested CT Atlas SOCMINT report from the evidence pack below.",
    "The evidence was discovered through independent Brave Search. Some pages were directly retrieved by CT Atlas; others may be search-index snippets only.",
    "Use ONLY the URLs and text/snippets in this evidence pack. Do not claim that a page was directly observed unless retrieval_status is observed_public_page.",
    "Do not mention internal agent failures in the executive assessment. Put limitations in source_coverage or analytical_gaps.",
    "Do not infer identity, affiliation, ownership, criminality or terrorist links beyond what the evidence supports.",
    "Analyst query:",
    JSON.stringify(query),
    "Evidence pack:",
    JSON.stringify(evidencePack)
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
      max_output_tokens: 10000
    }
  };

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
    throw geminiFailure(response, detail, model, false);
  }

  const payload = await response.json();
  const rawText = await extractGeminiText(payload);
  const normalized = rawText.trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/i,"");
  let parsed;
  try {
    parsed = JSON.parse(normalized);
  } catch (_) {
    const error = new Error("Gemini returned evidence synthesis that could not be parsed.");
    error.status = 502;
    error.model = model;
    throw error;
  }
  return { parsed, payload, model };
}

async function geminiEvidenceSynthesis(env, query, evidence) {
  const models = socmintModels(env, false);
  let lastError = null;
  for (const model of models) {
    try {
      return await geminiEvidenceSynthesisOnce(env, query, evidence, model);
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);
      if ([400,403,404,429,500,502,503,504].includes(status)) continue;
      throw error;
    }
  }
  throw lastError || new Error("No Gemini model was available for evidence synthesis.");
}

function buildDiscoveryOnlyReport(query, sources, agentFailure) {
  const count = sources.length;
  const directlyObserved = sources.filter(item => item?.kind === "direct_public_page").length;
  const platforms = (query.platforms || []).join(", ") || "public web";
  return {
    title: "CT Atlas SOCMINT Evidence Review",
    executive_assessment: count
      ? `Independent Brave discovery identified ${count} relevant public source(s). ${directlyObserved} source(s) were directly retrievable by CT Atlas. The available evidence is preserved for analyst review, but automated synthesis was unavailable; no unsupported identity, ownership, affiliation or wrongdoing conclusion has been drawn.`
      : "Independent public-web fallback did not identify usable sources for this query.",
    source_coverage: `Brave Search was used across ${platforms}. Directly retrieved pages are distinguished from search-index-only results. Search snippets are leads, not equivalent to direct observation.`,
    identity_alias_findings: "No identity attribution was made from search-index results alone.",
    network_associations: "No network association is asserted without corroborating public evidence.",
    content_narrative: "The collected public evidence is available in the source list, but automated synthesis was not available for this run.",
    activity_timeline: "No reliable timeline was established without completed evidence synthesis.",
    locations_travel_signals: "No location or travel conclusion was made without completed evidence synthesis.",
    financial_crypto_indicators: "No financial or crypto conclusion was made without completed evidence synthesis.",
    ct_relevance: "No CT relevance conclusion was made without completed evidence synthesis.",
    key_findings: [],
    entities: [],
    analytical_gaps: cleanText(
      "Automated evidence synthesis was unavailable. Technical detail: " +
      (agentFailure?.message || "No detailed model error was returned.") +
      " The source list remains available for direct analyst review.",
      4000
    ),
    watchpoints: count ? [{
      issue: "Complete evidence synthesis",
      indicator: "Review directly retrieved pages and rerun analysis when the synthesis model is available."
    }] : [],
    sources
  };
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

  let agentFailure = null;

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
      agentFailure = {
        status,
        code: cleanText(error?.code, 120),
        message: cleanText(error?.message, 700)
      };
      console.error("SOCMINT ADK agent failed.", agentFailure);

      if (!env.GEMINI_API_KEY) {
        return jsonResponse({
          error: "The SOCMINT ADK agent is temporarily unavailable and no Gemini fallback is configured.",
          code: "SOCMINT_AGENT_UNAVAILABLE",
          detail: agentFailure.message || null
        }, 503, env);
      }

      if (!query.urls.length) {
        const discovery = await braveWorkerDiscovery(env, query);
        if (discovery.sources.length) {
          const evidence = await fetchBraveEvidencePages(discovery.sources);
          const reportSources = evidence.map(sourceForReport).filter(item => item.url);
          const fallbackQuery = { ...query, mode: "urls_only", urls: reportSources.map(item => item.url).slice(0, 10) };
          try {
            const fallbackResult = await geminiEvidenceSynthesis(env, fallbackQuery, evidence);
            const report = normalizeReport(
              fallbackResult.parsed,
              fallbackQuery,
              reportSources,
              fallbackResult.model,
              "brave_worker+direct_fetch+gemini_synthesis"
            );
            report.agent_meta = {
              agent: false,
              fallback: true,
              fallback_stage: "evidence_synthesis",
              search_provider: "brave",
              directly_observed_sources: evidence.filter(item => item?.fetched).length,
              agent_failure: agentFailure
            };
            await persistReport(env, username, report);
            return jsonResponse({ ok: true, report, agent: false, fallback: "brave_evidence_synthesis" }, 200, env);
          } catch (synthesisError) {
            try {
              const fallbackResult = await geminiSocmint(env, fallbackQuery, false);
              const analyzedSources = extractToolSources(fallbackResult.payload);
              const merged = new Map();
              for (const source of [...reportSources, ...analyzedSources]) {
                if (source?.url) merged.set(source.url, { ...(merged.get(source.url) || {}), ...source });
              }
              const sources = Array.from(merged.values()).slice(0, 100);
              const report = normalizeReport(
                fallbackResult.parsed,
                fallbackQuery,
                sources,
                fallbackResult.model,
                "brave_worker+url_context_secondary_fallback"
              );
              report.agent_meta = {
                agent: false,
                fallback: true,
                fallback_stage: "url_context_secondary",
                search_provider: "brave",
                directly_observed_sources: evidence.filter(item => item?.fetched).length,
                agent_failure: agentFailure,
                synthesis_failure: cleanText(synthesisError?.message, 700)
              };
              await persistReport(env, username, report);
              return jsonResponse({ ok: true, report, agent: false, fallback: "brave_url_context_secondary" }, 200, env);
            } catch (fallbackError) {
              const report = normalizeReport(
                buildDiscoveryOnlyReport(query, reportSources, fallbackError),
                query,
                reportSources,
                "Brave evidence fallback",
                "brave_worker_evidence_only"
              );
              report.agent_meta = {
                agent: false,
                fallback: true,
                fallback_stage: "evidence_only",
                search_provider: "brave",
                directly_observed_sources: evidence.filter(item => item?.fetched).length,
                agent_failure: agentFailure,
                synthesis_failure: cleanText(synthesisError?.message, 700),
                analysis_failure: cleanText(fallbackError?.message, 700)
              };
              await persistReport(env, username, report);
              return jsonResponse({ ok: true, report, agent: false, fallback: "brave_evidence_only" }, 200, env);
            }
          }
        }

        return jsonResponse({
          error: env.BRAVE_SEARCH_API_KEY
            ? "The SOCMINT agent failed and Brave fallback returned no usable public sources. Refine the target or add known public URLs."
            : "The SOCMINT agent failed and the Worker-side independent search fallback is not configured. Add known public URLs or configure Brave for the Worker.",
          code: "SOCMINT_AGENT_UNAVAILABLE",
          detail: agentFailure.message || null
        }, status >= 400 && status < 600 ? status : 502, env);
      }
    }
  }

  const urlOnlyAgentFallback = Boolean(agentFailure && query.urls.length);
  let result;
  let discoveryMode = urlOnlyAgentFallback
    ? "url_context_agent_fallback"
    : (query.mode === "discover" ? "google_search+url_context" : "url_context");
  try {
    result = await geminiSocmint(env, query, urlOnlyAgentFallback ? false : query.mode === "discover");
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
          error: "Legacy Gemini public-web discovery is quota-limited. CT Atlas SOCMINT normally uses the ADK agent and its configured public collectors; add known public URLs for URL-only fallback analysis or configure an independent search provider.",
          code: "SOCMINT_SEARCH_QUOTA_EXHAUSTED",
          retry_after_seconds: error?.retry_after_seconds || null
        }, 429, env);
      }
      if ([400,403,404].includes(status)) {
        return jsonResponse({
          error: "Legacy Gemini public-web discovery is unavailable for this API project. CT Atlas SOCMINT does not depend on Gemini Google Search grounding: use the ADK agent, add known public URLs for direct analysis, or configure an independent web-search provider such as Brave or SearXNG.",
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
