const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const workerPromise = import("../tools/mirror-worker.mjs").then(module => module.default);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

function fixture(bytes, chunkSize = 7) {
  const manifest = { format: "ct-atlas-byte-shards-v1", filename: "events.json",
    size_bytes: bytes.length, sha256: hash(bytes), parts: [] };
  const files = new Map();
  const requests = [];
  for (let start = 0; start < bytes.length; start += chunkSize) {
    const part = bytes.subarray(start, start + chunkSize);
    const path = `_events/events-${manifest.sha256.slice(0, 16)}-${String(manifest.parts.length).padStart(5, "0")}.bin`;
    manifest.parts.push({ path, size_bytes: part.length, sha256: hash(part) });
    files.set("/" + path, part);
  }
  const env = { ASSETS: { async fetch(input) {
    const request = input instanceof Request ? input : new Request(input);
    const path = new URL(request.url).pathname;
    requests.push(request);
    if (path === "/events-shards.json") return Response.json(manifest);
    if (!files.has(path)) return new Response("Missing", { status: 404 });
    return new Response(request.method === "HEAD" ? null : files.get(path));
  } } };
  return { env, files, manifest, requests };
}

test("chunked full dataset is byte exact across UTF-8 and JSON token boundaries", async () => {
  const bytes = Buffer.from('{"events":[{"id":"a","title":"عربي 中文 😀","summary":"a  b\\nline"}],"n":1.2300e+04}\n');
  const { env, requests, manifest } = fixture(bytes);
  const response = await (await workerPromise).fetch(new Request("https://mirror.test/events.json?integrity=123"), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /application\/json/);
  assert.equal(response.headers.get("Content-Length"), String(bytes.length));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(requests.filter(req => new URL(req.url).pathname.startsWith("/_events/")).length, manifest.parts.length);
});

test("small full JSON and unrelated assets retain ordinary asset handling", async () => {
  const { env, files, requests } = fixture(Buffer.from("unused"));
  files.set("/events.json", "{\"events\":[]}");
  files.set("/events-map.json", "map asset");
  const worker = await workerPromise;
  assert.equal(await (await worker.fetch(new Request("https://mirror.test/events.json"), env)).text(), '{"events":[]}');
  assert.equal(await (await worker.fetch(new Request("https://mirror.test/events-map.json"), env)).text(), "map asset");
  assert.equal(requests.length, 2);
});

test("HEAD reports full size without reading data chunks", async () => {
  const bytes = Buffer.from('{"events":[]}');
  const { env, requests } = fixture(bytes);
  const response = await (await workerPromise).fetch(new Request("https://mirror.test/events.json", { method: "HEAD" }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Length"), String(bytes.length));
  assert.equal(await response.text(), "");
  assert.equal(requests.length, 2);
});

test("outer conditional/range headers are not applied to individual chunks", async () => {
  const bytes = Buffer.from('{"events":[]}');
  const { env, requests } = fixture(bytes);
  const response = await (await workerPromise).fetch(new Request("https://mirror.test/events.json", {
    headers: { Range: "bytes=2-4", "If-None-Match": '"old"' }
  }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  for (const request of requests.slice(1)) {
    assert.equal(request.headers.get("Range"), null);
    assert.equal(request.headers.get("If-None-Match"), null);
  }
});

test("matching ETag avoids downloading chunk bodies", async () => {
  const { env, requests, manifest } = fixture(Buffer.from('{"events":[]}'));
  const response = await (await workerPromise).fetch(new Request("https://mirror.test/events.json", {
    headers: { "If-None-Match": `"sha256-${manifest.sha256}"` }
  }), env);
  assert.equal(response.status, 304);
  assert.equal(requests.length, 2);
});

test("missing first chunk returns an explicit uncacheable failure", async () => {
  const { env, files, manifest } = fixture(Buffer.from('{"events":[]}'));
  files.delete("/" + manifest.parts[0].path);
  const response = await (await workerPromise).fetch(new Request("https://mirror.test/events.json"), env);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("a missing or truncated later chunk aborts the response body", async () => {
  for (const fault of ["missing", "short", "long"]) {
    const { env, files, manifest } = fixture(Buffer.from('{"events":[{"id":"a"}]}'));
    const path = "/" + manifest.parts[1].path;
    if (fault === "missing") files.delete(path);
    else files.set(path, Buffer.alloc(fault === "short" ? 1 : 20, 32));
    const response = await (await workerPromise).fetch(new Request("https://mirror.test/events.json"), env);
    await assert.rejects(response.arrayBuffer());
  }
});

test("invalid shard paths and lengths cannot become asset requests", async () => {
  for (const fault of ["path", "length"]) {
    const { env, manifest, requests } = fixture(Buffer.from('{"events":[]}'));
    if (fault === "path") manifest.parts[0].path = "../secret";
    else manifest.size_bytes += 1;
    const response = await (await workerPromise).fetch(new Request("https://mirror.test/events.json"), env);
    assert.equal(response.status, 503);
    assert.equal(requests.length, 2);
  }
});

test("full dataset route is read only", async () => {
  const { env, requests } = fixture(Buffer.from('{"events":[]}'));
  const response = await (await workerPromise).fetch(new Request("https://mirror.test/events.json", { method: "POST" }), env);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "GET, HEAD");
  assert.equal(requests.length, 0);
});
