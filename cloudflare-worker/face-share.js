import { jsonResponse, cleanText, gateCall, isAllowedUser } from "./shared.js";

// Temporary hosting of ONE face crop so that reverse-image engines (Yandex, Bing, Baidu,
// Google Lens, TinEye) can fetch it by URL and open their results directly.
//
// Why this exists: none of those engines accepts an upload from another site, and none
// can be embedded in a frame, so the only way to give an analyst a one-click result page
// is a URL the engine can download from. Design constraints:
//   - upload needs an authenticated, allow-listed session; only the analyst's explicit
//     click on an engine triggers it (see facial-crops.js);
//   - one Durable Object per image (EU jurisdiction when available) that deletes ITSELF
//     through an alarm after FACE_SHARE_TTL_MS, so nothing accumulates or needs cleaning;
//   - the link is 128 bits of randomness, served no-store / noindex, capped in reads.
const FACE_SHARE_VERSION = "face-share-v1";
const FACE_SHARE_TTL_MS = 10 * 60 * 1000;
const FACE_SHARE_MAX_BYTES = 150 * 1024;
const FACE_SHARE_MAX_READS = 25;
const FACE_SHARE_UPLOADS_PER_HOUR = 40;
const FACE_SHARE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const FACE_SHARE_PATH_RE = /^\/face-share\/([A-Za-z0-9_-]{22})\.jpg$/;

// Best-effort, per Worker isolate: the endpoint is already limited to ~35 allow-listed users.
const recentUploads = new Map();

function newFaceShareId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function looksLikeJpeg(bytes) {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function faceShareStub(env, id) {
  const namespace = typeof env.FACE_SHARE?.jurisdiction === "function"
    ? env.FACE_SHARE.jurisdiction("eu")
    : env.FACE_SHARE;
  return namespace.get(namespace.idFromName(id));
}

function withinRateLimit(username, now) {
  const recent = (recentUploads.get(username) || []).filter(time => now - time < 3600 * 1000);
  if (recent.length >= FACE_SHARE_UPLOADS_PER_HOUR) {
    recentUploads.set(username, recent);
    return false;
  }
  recent.push(now);
  recentUploads.set(username, recent);
  return true;
}

function resetFaceShareRateLimit() {
  recentUploads.clear();
}

// Reads the body chunk by chunk and stops as soon as it exceeds the cap, so a stream sent
// without Content-Length can never be buffered whole. Returns null when the cap is exceeded.
async function readBodyCapped(request, maxBytes) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

class FaceShare {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();

    if (url.pathname === "/put") {
      if (await this.state.storage.get("bytes")) return new Response("exists", { status: 409 });
      const expiresAt = Number(request.headers.get("X-Expires-At"));
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (!Number.isFinite(expiresAt) || expiresAt <= now || !bytes.length) return new Response("bad request", { status: 400 });
      await this.state.storage.put({ bytes, expires_at: expiresAt, reads: 0 });
      await this.state.storage.setAlarm(expiresAt);
      return new Response("ok");
    }

    if (url.pathname === "/get" || url.pathname === "/head") {
      const [bytes, expiresAt, reads] = await Promise.all([
        this.state.storage.get("bytes"),
        this.state.storage.get("expires_at"),
        this.state.storage.get("reads")
      ]);
      if (!bytes || now >= Number(expiresAt) || Number(reads) >= FACE_SHARE_MAX_READS) {
        await this.state.storage.deleteAlarm();
        await this.state.storage.deleteAll();
        return new Response(null, { status: 404 });
      }
      if (url.pathname === "/get") await this.state.storage.put("reads", Number(reads) + 1);
      return new Response(url.pathname === "/get" ? bytes : null, {
        headers: { "Content-Type": "image/jpeg", "Content-Length": String(bytes.length) }
      });
    }

    return new Response("not found", { status: 404 });
  }

  // Fires at the expiry time: the image is gone, and so is the object's storage.
  async alarm() {
    await this.state.storage.deleteAll();
  }
}

async function handleFaceShareUpload(request, env, now = Date.now()) {
  const token = cleanText(request.headers.get("X-Session-Token"), 160);
  if (!token) return jsonResponse({ error: "Authenticated session required." }, 401, env);

  const sessionResponse = await gateCall(env, "/session-get", { session_token: token });
  const session = await sessionResponse.json().catch(() => ({}));
  if (!sessionResponse.ok || !session?.username || !isAllowedUser(session.username, env)) {
    return jsonResponse({ error: "Session expired." }, 401, env);
  }

  if (!env.FACE_SHARE) return jsonResponse({ error: "Face search hosting is not configured." }, 503, env);

  const contentType = String(request.headers.get("Content-Type") || "").toLowerCase();
  if (!contentType.startsWith("image/jpeg")) return jsonResponse({ error: "A JPEG image is required." }, 415, env);
  if (Number(request.headers.get("Content-Length") || 0) > FACE_SHARE_MAX_BYTES) {
    return jsonResponse({ error: "Image exceeds " + Math.round(FACE_SHARE_MAX_BYTES / 1024) + " KB." }, 413, env);
  }
  if (!withinRateLimit(String(session.username).toLowerCase(), now)) {
    return jsonResponse({ error: "Too many face searches this hour. Try again later." }, 429, env);
  }

  const bytes = await readBodyCapped(request, FACE_SHARE_MAX_BYTES);
  if (!bytes) {
    return jsonResponse({ error: "Image exceeds " + Math.round(FACE_SHARE_MAX_BYTES / 1024) + " KB." }, 413, env);
  }
  if (!looksLikeJpeg(bytes)) return jsonResponse({ error: "The file is not a JPEG image." }, 415, env);

  const id = newFaceShareId();
  const expiresAt = now + FACE_SHARE_TTL_MS;
  const stored = await faceShareStub(env, id).fetch("https://face.internal/put", {
    method: "PUT",
    headers: { "X-Expires-At": String(expiresAt) },
    body: bytes
  });
  if (!stored.ok) return jsonResponse({ error: "Could not host the image." }, 502, env);

  return jsonResponse({
    ok: true,
    version: FACE_SHARE_VERSION,
    url: new URL(request.url).origin + "/face-share/" + id + ".jpg",
    expires_at: new Date(expiresAt).toISOString(),
    ttl_seconds: FACE_SHARE_TTL_MS / 1000
  }, 200, env);
}

// Public on purpose (the search engines fetch it anonymously): the 128-bit id is the secret.
async function handleFaceShareGet(request, env) {
  const notFound = () => new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive" }
  });
  const match = FACE_SHARE_PATH_RE.exec(new URL(request.url).pathname);
  if (!match || !FACE_SHARE_ID_RE.test(match[1]) || !env.FACE_SHARE) return notFound();

  const head = request.method === "HEAD";
  const stored = await faceShareStub(env, match[1]).fetch("https://face.internal/" + (head ? "head" : "get"));
  if (!stored.ok) return notFound();

  return new Response(head ? null : stored.body, {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": stored.headers.get("Content-Length") || "",
      "Content-Disposition": 'inline; filename="face.jpg"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      "Referrer-Policy": "no-referrer"
    }
  });
}

export {
  FACE_SHARE_VERSION,
  FACE_SHARE_TTL_MS,
  FACE_SHARE_MAX_BYTES,
  FACE_SHARE_MAX_READS,
  FaceShare,
  handleFaceShareUpload,
  handleFaceShareGet,
  resetFaceShareRateLimit
};
