import { corsHeaders, jsonResponse, cleanText, gateCall, isAllowedUser } from "./shared.js";

export const VISUAL_INTEL_VERSION = "visual-intel-v1";

export function isVisualIntelConfigured(env) {
  return Boolean(
    String(env?.VISUAL_INTEL_URL || "").trim()
    && String(env?.VISUAL_INTEL_SHARED_SECRET || "").trim()
  );
}

export async function handleVisualAnalyze(request, env) {
  const token = cleanText(request.headers.get("X-Session-Token"), 160);
  if (!token) return jsonResponse({ error: "Authenticated session required." }, 401, env);

  const sessionResponse = await gateCall(env, "/session-get", { session_token: token });
  const session = await sessionResponse.json().catch(() => ({}));
  if (!sessionResponse.ok || !session?.username || !isAllowedUser(session.username, env)) {
    return jsonResponse({ error: "Session expired." }, 401, env);
  }

  if (!isVisualIntelConfigured(env)) {
    return jsonResponse({ error: "Facial Intelligence service is not configured." }, 503, env);
  }

  const contentType = String(request.headers.get("Content-Type") || "");
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return jsonResponse({ error: "multipart/form-data upload required." }, 400, env);
  }

  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > 32 * 1024 * 1024) {
    return jsonResponse({ error: "Combined upload exceeds 30 MB." }, 413, env);
  }

  try {
    const body = await request.arrayBuffer();
    if (body.byteLength > 32 * 1024 * 1024) {
      return jsonResponse({ error: "Combined upload exceeds 30 MB." }, 413, env);
    }

    const target = String(env.VISUAL_INTEL_URL).replace(/\/$/, "") + "/analyze";
    const response = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "X-CT-Atlas-Visual-Key": String(env.VISUAL_INTEL_SHARED_SECRET),
        "X-CT-Atlas-User": String(session.username),
      },
      body,
    });

    const headers = new Headers(corsHeaders(env));
    headers.set("Content-Type", response.headers.get("Content-Type") || "application/json; charset=utf-8");
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    return jsonResponse({ error: "Facial Intelligence service unavailable.", detail: cleanText(error?.message, 500) }, 502, env);
  }
}
