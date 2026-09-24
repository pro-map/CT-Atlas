import { cleanText, gateCall, jsonResponse, isAllowedUser, normalizeUsername } from "./shared.js";

function sanitizeSocialReport(report) {
  if (!report || typeof report !== "object") return null;
  const safe = {};
  const walk = (value, maxLen = 4000) => {
    if (typeof value === "string") return cleanText(value, maxLen);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) return value.slice(0, 80).map(item => walk(item, maxLen));
    if (typeof value === "object") {
      const out = {};
      for (const [key, child] of Object.entries(value)) {
        if (key === "user_id" || key === "username") continue;
        out[key] = walk(child, maxLen);
      }
      return out;
    }
    return cleanText(String(value), maxLen);
  };

  for (const [key, value] of Object.entries(report)) {
    if (key === "user_id" || key === "username") continue;
    safe[key] = walk(value, key === "source_url" || key === "url" || key === "source_urls" ? 1500 : 8000);
  }

  safe.id = cleanText(String(safe.id || crypto.randomUUID()), 80);
  safe.generated_at = cleanText(String(safe.generated_at || new Date().toISOString()), 64);
  safe.title = cleanText(String(safe.title || "CT Atlas SOCMINT Assessment"), 220);
  safe.version = cleanText(String(safe.version || "socmint-v4-adk-safe-fallback"), 80);
  safe.query = safe.query && typeof safe.query === "object" ? safe.query : {};
  safe.sources = Array.isArray(safe.sources) ? safe.sources.slice(0, 100) : [];
  safe.key_findings = Array.isArray(safe.key_findings) ? safe.key_findings.slice(0, 12) : [];
  safe.entities = Array.isArray(safe.entities) ? safe.entities.slice(0, 60) : [];
  safe.watchpoints = Array.isArray(safe.watchpoints) ? safe.watchpoints.slice(0, 10) : [];
  return safe;
}

async function persistReport(env, username, report) {
  const currentResponse = await gateCall(env, "/social-workspace-get", { username });
  const currentPayload = await currentResponse.json().catch(() => ({}));
  const workspace = currentPayload?.workspace && typeof currentPayload.workspace === "object"
    ? currentPayload.workspace
    : { version: "socmint-v4-adk-safe-fallback", username, reports: [] };

  const safeReport = sanitizeSocialReport(report);
  const reports = Array.isArray(workspace.reports) ? workspace.reports : [];
  reports.unshift(safeReport || { id: crypto.randomUUID(), generated_at: new Date().toISOString(), title: "CT Atlas SOCMINT Assessment" });

  workspace.version = "socmint-v4-adk-safe-fallback";
  workspace.username = username;
  workspace.reports = reports.map(item => sanitizeSocialReport(item)).filter(Boolean).slice(0, 50);
  workspace.updated_at = new Date().toISOString();

  await gateCall(env, "/social-workspace-put", { username, workspace });
  await gateCall(env, "/usage-increment", { username, metrics: { social_intel_requests: 1 } });
}

export {
  sanitizeSocialReport,
  persistReport
};
