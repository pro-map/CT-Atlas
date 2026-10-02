import { cleanText, gateCall, corsHeaders } from "./shared.js";

const SOURCE_PREVIEW_VERSION = "source-preview-v2-article-head";
const PREVIEW_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
// An article's preview tags sit in its <head>: reading stops there, or at
// this many bytes (news pages run to megabytes once the body is included).
const ARTICLE_HTML_LIMIT = 350000;
// Outlets turn away unknown agents; this is the form link previewers use.
const PREVIEW_USER_AGENT = "Mozilla/5.0 (compatible; CT-Atlas-Preview/1.0; +https://pro-map.github.io/CT-Atlas/)";
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

const IMAGE_META_KEYS = Object.freeze([
  "og:image:secure_url",
  "og:image",
  "og:image:url",
  "twitter:image",
  "twitter:image:src"
]);

// The first value of every <meta property|name|itemprop=...> in the page.
function metaValues(html) {
  const values = new Map();
  for (const tag of String(html || "").match(/<meta\b[^>]*>/gi) || []) {
    const attrs = tagAttributes(tag);
    const key = String(attrs.property || attrs.name || attrs.itemprop || "").toLowerCase();
    if (key && attrs.content && !values.has(key)) values.set(key, attrs.content.trim());
  }
  return values;
}

function resolvedSafeUrl(value, baseUrl) {
  try {
    const resolved = new URL(value, baseUrl).toString();
    return isSafePublicUrl(resolved) ? resolved : "";
  } catch (_) {
    return "";
  }
}

function positiveInt(value) {
  const number = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

// The article's share image and what the page says about it: declared size,
// the photo's own caption (alt text) and the article's headline and outlet.
function extractArticleImage(html, baseUrl) {
  const meta = metaValues(html);
  let url = "";
  for (const key of IMAGE_META_KEYS) {
    url = meta.has(key) ? resolvedSafeUrl(meta.get(key), baseUrl) : "";
    if (url) break;
  }
  if (!url) {
    for (const tag of String(html || "").match(/<link\b[^>]*>/gi) || []) {
      const attrs = tagAttributes(tag);
      if (String(attrs.rel || "").toLowerCase() !== "image_src" || !attrs.href) continue;
      url = resolvedSafeUrl(attrs.href, baseUrl);
      if (url) break;
    }
  }
  if (!url) return null;
  return {
    url,
    width: positiveInt(meta.get("og:image:width") || meta.get("twitter:image:width")),
    height: positiveInt(meta.get("og:image:height") || meta.get("twitter:image:height")),
    alt: cleanText(meta.get("og:image:alt") || meta.get("twitter:image:alt") || "", 300),
    title: cleanText(meta.get("og:title") || meta.get("twitter:title") || "", 300),
    site: cleanText(meta.get("og:site_name") || "", 120)
  };
}

function extractPreviewImageUrl(html, baseUrl) {
  return extractArticleImage(html, baseUrl)?.url || "";
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

// The start of an HTML page: up to its </head> (or `limit` bytes), never an
// error for a long page -- the rest of it is not needed and not downloaded.
async function readHtmlHead(response, limit) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let text = "";
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      text += decoder.decode(value, { stream: true });
      if (/<\/head\s*>/i.test(text.slice(-(value.length + 16)))) break;
    }
  } finally {
    // The rest of the page is not wanted. Not awaited: a cancel can wait on
    // other readers of the same body (a tee), and nothing here depends on it.
    reader.cancel().catch(() => {});
  }
  return text;
}

// The article's share image and its metadata (extractArticleImage), and the
// address the article finally answered from; null when there is none.
async function fetchArticleImage(articleUrl) {
  if (!isSafePublicUrl(articleUrl)) return null;
  try {
    const response = await fetchSafe(articleUrl, {
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        "User-Agent": PREVIEW_USER_AGENT
      },
      cf: { cacheTtl: 3600, cacheEverything: false }
    });
    if (!response.ok) return null;
    const type = String(response.headers.get("Content-Type") || "").toLowerCase();
    if (type && !type.includes("text/html") && !type.includes("application/xhtml")) return null;
    const html = await readHtmlHead(response, ARTICLE_HTML_LIMIT);
    const image = extractArticleImage(html, response.url || articleUrl);
    return image ? { ...image, article_url: response.url || articleUrl } : null;
  } catch (error) {
    console.warn("Source preview discovery failed", cleanText(error?.message, 160));
    return null;
  }
}

// A short-lived token the page fetches the image through (/source-image/...),
// so the browser never loads a third-party address directly.
async function createImageToken(env, imageUrl, details = {}) {
  const tokenResponse = await gateCall(env, "/source-image-token-put", {
    image_url: imageUrl,
    source_id: cleanText(details.source_id, 40),
    title: cleanText(details.title, 300),
    source: cleanText(details.source, 160),
    article_url: cleanText(details.article_url, 1500),
    expires_at: Date.now() + PREVIEW_TOKEN_TTL_MS
  });
  const tokenPayload = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenPayload?.token) return "";
  return "/source-image/" + encodeURIComponent(tokenPayload.token);
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
        "User-Agent": PREVIEW_USER_AGENT
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
  PREVIEW_USER_AGENT,
  isSafePublicUrl,
  fetchSafe,
  readLimitedText,
  readHtmlHead,
  extractArticleImage,
  extractPreviewImageUrl,
  fetchArticleImage,
  createImageToken,
  handleSourceImage
};
