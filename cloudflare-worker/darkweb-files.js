import { gateCall } from "./shared.js";

export const DARKWEB_FILES_VERSION = "darkweb-files-v1";
export const PDF_MAX_BYTES = 50 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;

export function fileStorageConfigured(env) {
  return typeof env.DARKWEB_FILES?.put === "function" && typeof env.DARKWEB_FILES?.get === "function";
}

export async function withHostedFiles(data, env) {
  const items = data.items || (data.item ? [data.item] : []);
  const hashes = [...new Set(items.flatMap(i => (i.attachments || []).filter(a => a.type === "pdf").map(a => a.sha256).filter(h => HASH.test(h || ""))))];
  let info;
  for (let offset = 0; offset < Math.max(1, hashes.length); offset += 600) {
    const response = await gateCall(env, "/darkweb-files-info", { hashes: hashes.slice(offset, offset + 600) });
    if (!response.ok) throw new Error("File storage metadata unavailable");
    const page = await response.json();
    if (!info) info = page; else Object.assign(info.files, page.files);
  }
  for (const item of items) item.attachments = (item.attachments || []).map(a => ({ ...a,
    stored_in_atlas: a.type === "pdf" && fileStorageConfigured(env) && info.files[a.sha256]?.status === "ready" && info.files[a.sha256]?.bytes === a.bytes,
    stored_at: info.files[a.sha256]?.stored_at || "" }));
  return { ...data, files_storage: { ...info.usage, configured: fileStorageConfigured(env), max_file_bytes: PDF_MAX_BYTES, version: DARKWEB_FILES_VERSION } };
}

// Keep the upload streaming. FixedLengthStream gives R2 a known length and
// rejects both truncated and oversized bodies; R2 checks the SHA-256 itself.
export async function putPdf(bucket, key, request, bytes, hash) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing PDF body");
  const stream = new FixedLengthStream(bytes), writer = stream.writable.getWriter();
  let count = 0, prefix = [];
  const pump = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        count += value.byteLength;
        if (count > bytes || count > PDF_MAX_BYTES) throw new Error("PDF size mismatch");
        if (prefix.length < 5) {
          const need = 5 - prefix.length;
          prefix.push(...value.slice(0, need));
          if (prefix.length < 5) { await writer.write(value); continue; }
          if (String.fromCharCode(...prefix) !== "%PDF-") throw new Error("Invalid PDF signature");
        }
        await writer.write(value);
      }
      if (count !== bytes || prefix.length !== 5) throw new Error("Incomplete PDF");
      await writer.close();
    } catch (error) {
      await writer.abort(error).catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
  })();
  const checksum = Uint8Array.from(hash.match(/../g), pair => parseInt(pair, 16)).buffer;
  const write = bucket.put(key, stream.readable, { sha256: checksum, storageClass: "Standard",
    httpMetadata: { contentType: "application/pdf", cacheControl: "private, no-store" },
    customMetadata: { sha256: hash } });
  try { await Promise.all([pump, write]); }
  catch (error) {
    await Promise.allSettled([reader.cancel(error), writer.abort(error)]);
    await Promise.allSettled([pump, write]);
    throw error;
  }
}

export async function handlePdfFile(request, env, reply) {
  const url = new URL(request.url), params = url.searchParams, path = url.pathname;
  const id = params.get("id") || "", hash = params.get("sha256") || "";
  if (!HASH.test(id) || !HASH.test(hash)) return reply({ error: "Invalid PDF reference." }, 400, env);
  if (!fileStorageConfigured(env)) return reply({ error: "Private PDF storage is not configured." }, 503, env);
  const uploading = path !== "/darkweb/file";
  const query = { id, sha256: hash, upload_access: uploading,
    epoch: Number(params.get("epoch")), outlet_id: params.get("outlet_id") || "" };
  const check = await gateCall(env, "/darkweb-file-check", query);
  const checked = await check.json();
  if (!check.ok) return reply(checked, check.status, env);
  const file = checked.file, key = "pdf/" + hash + ".pdf";
  if (path === "/darkweb/file-status" && request.method === "GET") {
    const object = checked.stored ? await env.DARKWEB_FILES.head(key) : null;
    return reply({ stored: !!object && object.size === file.bytes && object.customMetadata?.sha256 === hash }, 200, env);
  }
  if (path === "/darkweb/file-upload" && request.method === "POST") {
    const length = request.headers.get("Content-Length") || "";
    if (request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/pdf" || !/^\d+$/.test(length) || Number(length) !== file.bytes || file.bytes < 5 || file.bytes > PDF_MAX_BYTES) {
      return reply({ error: "Send the recorded PDF with its exact Content-Length (maximum 50 MiB)." }, 400, env);
    }
    const reserve = await gateCall(env, "/darkweb-file-check", { ...query, reserve: true });
    if (!reserve.ok) return reply(await reserve.json(), reserve.status, env);
    try {
      let object = await env.DARKWEB_FILES.head(key);
      if (!object) {
        await putPdf(env.DARKWEB_FILES, key, request, file.bytes, hash);
        object = await env.DARKWEB_FILES.head(key);
      }
      if (!object || object.size !== file.bytes || object.customMetadata?.sha256 !== hash) throw new Error("PDF verification failed");
      const committed = await gateCall(env, "/darkweb-file-commit", { ...query, bytes: object.size });
      return reply(await committed.json(), committed.status, env);
    } catch (_) {
      // Keep the reservation: a lost acknowledgement must never undercount a
      // completed R2 write. A retry reuses it and discovers the object by hash.
      return reply({ error: "PDF transfer failed; retry will resume safely." }, 502, env);
    }
  }
  if (path === "/darkweb/file" && request.method === "GET") {
    if (!checked.stored) return reply({ error: "PDF has not been uploaded to Atlas yet." }, 404, env);
    const object = await env.DARKWEB_FILES.get(key);
    if (!object || object.size !== file.bytes || object.customMetadata?.sha256 !== hash) return reply({ error: "Stored PDF unavailable; resume the collector to synchronize it." }, 404, env);
    const headers = new Headers(reply({}, 200, env).headers);
    headers.set("Content-Type", "application/pdf");
    headers.set("Content-Length", String(object.size));
    headers.set("Content-Disposition", 'attachment; filename="CT-Atlas-' + hash.slice(0,12) + '.pdf"');
    headers.set("Content-Security-Policy", "sandbox; default-src 'none'");
    headers.set("Referrer-Policy", "no-referrer");
    return new Response(object.body, { headers });
  }
  return reply({ error: "Unsupported PDF operation." }, 405, env);
}
