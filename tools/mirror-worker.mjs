// Keep the complete /events.json response when it exceeds the static-asset cap.
// Chunks contain the original compacted bytes, including all collector metadata.
// Byte streams (not JSON parsing or concatenated strings) keep Worker memory bounded.
const FORMAT = "ct-atlas-byte-shards-v1";

function validateManifest(manifest) {
  if (manifest?.format !== FORMAT || manifest.filename !== "events.json" ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
      !Number.isSafeInteger(manifest.size_bytes) || manifest.size_bytes <= 0 ||
      !Array.isArray(manifest.parts) || !manifest.parts.length) {
    throw new Error("Invalid mirror manifest");
  }
  let total = 0;
  for (const [index, part] of manifest.parts.entries()) {
    const path = `_events/events-${manifest.sha256.slice(0, 16)}-${String(index).padStart(5, "0")}.bin`;
    if (part.path !== path || !Number.isSafeInteger(part.size_bytes) ||
        part.size_bytes <= 0 || part.size_bytes > 25 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(part.sha256)) {
      throw new Error("Invalid mirror chunk");
    }
    total += part.size_bytes;
  }
  if (total !== manifest.size_bytes) throw new Error("Invalid mirror length");
}

async function fetchPart(env, part) {
  // Do not forward Range/If-None-Match from the outer JSON request to an individual
  // chunk, where either header could silently shorten the reconstructed response.
  const response = await env.ASSETS.fetch(new Request(`https://assets.local/${part.path}`));
  if (response.status !== 200 || !response.body) {
    throw new Error("Mirror dataset chunk is unavailable");
  }
  return response.body.getReader();
}

function chunkStream(env, parts, firstReader) {
  let reader = firstReader;
  let index = 0;
  let received = 0;
  let cancelled = false;
  return new ReadableStream({
    async pull(controller) {
      try {
        while (!cancelled) {
          if (!reader) reader = await fetchPart(env, parts[index]);
          if (cancelled) { await reader.cancel(); return; }
          const { value, done } = await reader.read();
          if (!done) {
            received += value.byteLength;
            if (received > parts[index].size_bytes) throw new Error("Mirror chunk is too long");
            controller.enqueue(value);
            return;
          }
          reader.releaseLock();
          reader = null;
          if (received !== parts[index].size_bytes) throw new Error("Mirror chunk is incomplete");
          received = 0;
          index += 1;
          if (index === parts.length) { controller.close(); return; }
        }
      } catch (error) {
        if (reader) await reader.cancel().catch(() => {});
        // A failed chunk aborts the body; never return a syntactically valid partial
        // dataset with a successful status or substitute an older deployment.
        if (!cancelled) controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      if (reader) await reader.cancel(reason).catch(() => {});
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/events.json") return env.ASSETS.fetch(request);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    // Small deployments keep using the ordinary full JSON asset.
    const direct = await env.ASSETS.fetch(request);
    if (direct.status !== 404) return direct;
    if (direct.body) await direct.body.cancel();
    try {
      const response = await env.ASSETS.fetch("https://assets.local/events-shards.json");
      if (response.status !== 200) throw new Error("Mirror manifest is unavailable");
      const manifest = await response.json();
      validateManifest(manifest);
      const etag = `"sha256-${manifest.sha256}"`;
      const headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=0, must-revalidate",
        "ETag": etag,
        "X-Content-Type-Options": "nosniff",
        "Access-Control-Allow-Origin": "*"
      };
      if (request.headers.get("If-None-Match") === etag) {
        return new Response(null, { status: 304, headers });
      }
      headers["Content-Length"] = String(manifest.size_bytes);
      if (request.method === "HEAD") return new Response(null, { headers });
      const first = await fetchPart(env, manifest.parts[0]);
      return new Response(chunkStream(env, manifest.parts, first), { headers });
    } catch (_) {
      return new Response("Full dataset temporarily unavailable", {
        status: 503, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" }
      });
    }
  }
};
