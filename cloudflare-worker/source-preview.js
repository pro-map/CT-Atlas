import { cleanText, gateCall, corsHeaders } from "./shared.js";

const SOURCE_PREVIEW_VERSION = "source-preview-v1-og-image";
const PREVIEW_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const ARTICLE_HTML_LIMIT = 350000;
const IMAGE_BYTES_LIMIT = 1600000;

function isPrivateIpv4(host) {
  const match = String(host || "").match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some(n => n < 0 || n > 255)) return true;
  const [a,b] = parts;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isSafePublicUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!["http:","https:"].includes(url.protocol)) return false;
    if (url.username || url.password) return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g,"");
    if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
    if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return false;
    if (isPrivateIpv4(host)) return false;
    return true;
  } catch (_) {
    return false;
  }
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi,"&")
    .replace(/&quot;/gi,'"')
    .replace(/&#39;|&apos;/gi,"'")
    .replace(/&lt;/gi,"<")
    .replace(/&gt;/gi,">");
}

function tagAttributes(tag) {
  const attrs = {};
  const rx = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = rx.exec(tag))) {
    attrs[String(match[1] || "").toLowerCase()] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function extractPreviewImageUrl(html, baseUrl) {
  const accepted = new Set([
    "og:image",
    "og:image:url",
    "og:image:secure_url",
    "twitter:image",
    "twitter:image:src"
  ]);
  for (const tag of String(html || "").match(/<meta\b[^>]*>/gi) || []) {
    const attrs = tagAttributes(tag);
    const key = String(attrs.property || attrs.name || "").toLowerCase();
    if (!accepted.has(key) || !attrs.content) continue;
    try {
      const resolved = new URL(attrs.content, baseUrl).toString();
      if (isSafePublicUrl(resolved)) return resolved;
    } catch (_) {}
  }
  for (const tag of String(html || "").match(/<link\b[^>]*>/gi) || []) {
    const attrs = tagAttributes(tag);
    if (String(attrs.rel || "").toLowerCase() !== "image_src" || !attrs.href) continue;
    try {
      const resolved = new URL(attrs.href, baseUrl).toString();
      if (isSafePublicUrl(resolved)) return resolved;
    } catch (_) {}
  }
  return "";
}

async function fetchSafe(url, init = {}, maxRedirects = 3) {
  let current = String(url || "");
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!isSafePublicUrl(current)) throw new Error("Unsafe external URL.");
    const response = await fetch(current, { ...init, redirect: "manual" });
    if (![301,302,303,307,308].includes(response.status)) return response;
    const location = response.headers.get("Location");
    if (!location) return response;
    current = new URL(location, current).toString();
  }
  throw new Error("Too many redirects.");
}

async function readLimitedBytes(response, limit) {
  const declared = Number(response.headers.get("Content-Length") || 0);
  if (declared && declared > limit) throw new Error("Remote content exceeds preview size limit.");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("Remote content exceeds preview size limit.");
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch (_) {}
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

async function readLimitedText(response, limit) {
  const bytes = await readLimitedBytes(response, limit);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

async function discoverArticleImage(articleUrl) {
  if (!isSafePublicUrl(articleUrl)) return "";
  try {
    const response = await fetchSafe(articleUrl, {
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        "User-Agent": "CT-Atlas-Source-Preview/1.0"
      },
      cf: { cacheTtl: 3600, cacheEverything: false }
    });
    if (!response.ok) return "";
    const type = String(response.headers.get("Content-Type") || "").toLowerCase();
    if (type && !type.includes("text/html") && !type.includes("application/xhtml")) return "";
    const html = await readLimitedText(response, ARTICLE_HTML_LIMIT);
    return extractPreviewImageUrl(html, response.url || articleUrl);
  } catch (error) {
    console.warn("Source preview discovery failed", cleanText(error?.message, 160));
    return "";
  }
}

async function createSourcePreviews(env, sources, options = {}) {
  const maxImages = Math.max(0, Math.min(3, Number(options.maxImages || 2)));
  const maxAttempts = Math.max(maxImages, Math.min(4, Number(options.maxAttempts || maxImages)));
  const previews = [];
  let attempts = 0;

  for (const source of Array.isArray(sources) ? sources : []) {
    if (previews.length >= maxImages || attempts >= maxAttempts) break;
    const articleUrl = cleanText(source?.url, 1500);
    if (!articleUrl || !isSafePublicUrl(articleUrl)) continue;
    attempts++;
    const imageUrl = await discoverArticleImage(articleUrl);
    if (!imageUrl) continue;

    const tokenResponse = await gateCall(env, "/source-image-token-put", {
      image_url: imageUrl,
      source_id: cleanText(source?.id, 40),
      title: cleanText(source?.title, 300),
      source: cleanText(source?.source, 160),
      article_url: articleUrl,
      expires_at: Date.now() + PREVIEW_TOKEN_TTL_MS
    });
    const tokenPayload = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokenPayload?.token) continue;

    previews.push({
      source_id: cleanText(source?.id, 40),
      title: cleanText(source?.title, 300),
      source: cleanText(source?.source, 160),
      article_url: articleUrl,
      image_path: "/source-image/" + encodeURIComponent(tokenPayload.token)
    });
  }

  return previews;
}

async function handleSourceImage(request, env) {
  const url = new URL(request.url);
  const token = cleanText(url.pathname.split("/").pop(), 100);
  if (!token || !/^[a-zA-Z0-9-]{20,100}$/.test(token)) {
    return new Response("Not found", { status: 404 });
  }

  const lookup = await gateCall(env, "/source-image-token-get", { token });
  const payload = await lookup.json().catch(() => ({}));
  if (!lookup.ok || !payload?.image_url || !isSafePublicUrl(payload.image_url)) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const upstream = await fetchSafe(payload.image_url, {
      headers: {
        "Accept": "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8",
        "User-Agent": "CT-Atlas-Source-Preview/1.0"
      },
      cf: { cacheTtl: 86400, cacheEverything: true }
    });
    if (!upstream.ok) return new Response("Image unavailable", { status: 502 });
    const type = String(upstream.headers.get("Content-Type") || "").split(";")[0].toLowerCase();
    if (!["image/jpeg","image/png","image/webp","image/gif","image/avif"].includes(type)) {
      return new Response("Unsupported image", { status: 415 });
    }
    const bytes = await readLimitedBytes(upstream, IMAGE_BYTES_LIMIT);
    const headers = new Headers(corsHeaders(env));
    headers.set("Content-Type", type);
    headers.set("Cache-Control", "public, max-age=21600");
    headers.set("Content-Length", String(bytes.length));
    return new Response(bytes, { status: 200, headers });
  } catch (error) {
    console.warn("Source image proxy failed", cleanText(error?.message, 160));
    return new Response("Image unavailable", { status: 502 });
  }
}

export {
  SOURCE_PREVIEW_VERSION,
  isSafePublicUrl,
  extractPreviewImageUrl,
  createSourcePreviews,
  handleSourceImage
};
