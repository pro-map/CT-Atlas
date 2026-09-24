const SOCIAL_AGENT_CLIENT_VERSION = "socmint-adk-client-v1";

function clean(value, max = 1200) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function agentBaseUrl(env) {
  const raw = clean(env.SOCMINT_AGENT_URL, 1000).replace(/\/+$/, "");
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString().replace(/\/+$/, "") : "";
  } catch (_) {
    return "";
  }
}

function isSocialAgentConfigured(env) {
  return Boolean(
    agentBaseUrl(env) &&
    clean(env.SOCMINT_AGENT_SHARED_SECRET, 500)
  );
}

async function fetchWithTimeout(url, options, timeoutMs = 115000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function runSocialAgent(env, username, query) {
  const base = agentBaseUrl(env);
  const secret = clean(env.SOCMINT_AGENT_SHARED_SECRET, 500);
  if (!base || !secret) {
    const error = new Error("SOCMINT ADK agent is not configured.");
    error.code = "SOCMINT_AGENT_NOT_CONFIGURED";
    error.status = 503;
    throw error;
  }

  let response;
  try {
    response = await fetchWithTimeout(base + "/investigate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CT-Atlas-Agent-Key": secret
      },
      body: JSON.stringify({
        user_id: username,
        query
      })
    });
  } catch (cause) {
    const error = new Error("SOCMINT ADK agent is unreachable.");
    error.code = "SOCMINT_AGENT_UNREACHABLE";
    error.status = 503;
    error.cause = cause;
    throw error;
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.ok || !payload?.report) {
    const detail = clean(
      payload?.detail ||
      payload?.error ||
      ("SOCMINT ADK agent returned HTTP " + response.status),
      1200
    );
    const error = new Error(detail || "SOCMINT ADK agent failed.");
    error.code = response.status === 429
      ? "SOCMINT_AGENT_QUOTA_EXHAUSTED"
      : "SOCMINT_AGENT_FAILED";
    error.status = response.status || 502;
    error.retry_after_seconds = Number(response.headers.get("Retry-After") || 0) || null;
    throw error;
  }

  return {
    report: payload.report,
    meta: payload.meta || {},
    client_version: SOCIAL_AGENT_CLIENT_VERSION
  };
}

export {
  SOCIAL_AGENT_CLIENT_VERSION,
  isSocialAgentConfigured,
  runSocialAgent
};
