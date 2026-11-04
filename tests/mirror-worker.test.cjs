const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const workerPromise = import("../tools/mirror-worker.mjs").then(module => module.default);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

// The same naming as tools/compact_mirror_json.py: '<stem>-shards.json' lists
// '_events/<stem>-<sha16>-<index>.bin' (events.json keeps events-shards.json).
function fixture(bytes, chunkSize = 7, filename = "events.json") {
  const stem = filename.replace(/\.json$/, "");
  const manifest = { format: "ct-atlas-byte-shards-v1", filename,
    size_bytes: bytes.length, sha256: hash(bytes), parts: [] };
  const files = new Map();
  const requests = [];
  for (let start = 0; start < bytes.length; start += chunkSize) {
    const part = bytes.subarray(start, start + chunkSize);
    const path = `_events/${stem}-${manifest.sha256.slice(0, 16)}-${String(manifest.parts.length).padStart(5, "0")}.bin`;
    manifest.parts.push({ path, size_bytes: part.length, sha256: hash(part) });
    files.set("/" + path, part);
  }
  const env = { ASSETS: { async fetch(input) {
    const request = input instanceof Request ? input : new Request(input);
    const path = new URL(request.url).pathname;
    requests.push(request);
    if (path === `/${stem}-shards.json`) return Response.json(manifest);
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

test("small publication files and unrelated assets retain ordinary asset handling", async () => {
  // events-map.json is a chunkable route now (it was "unrelated" when only
  // events.json could be chunked); a whole asset is still served directly.
  const { env, files, requests } = fixture(Buffer.from("unused"));
  files.set("/events.json", "{\"events\":[]}");
  files.set("/events-map.json", "map asset");
  files.set("/index.html", "page");
  const worker = await workerPromise;
  assert.equal(await (await worker.fetch(new Request("https://mirror.test/events.json"), env)).text(), '{"events":[]}');
  assert.equal(await (await worker.fetch(new Request("https://mirror.test/events-map.json"), env)).text(), "map asset");
  assert.equal(await (await worker.fetch(new Request("https://mirror.test/index.html"), env)).text(), "page");
  assert.equal(requests.length, 3);
});

test("every publication file over the 25 MiB asset cap is streamed whole at its own URL", async () => {
  // events-lite.json and events-map.json grow like events.json; a whole copy
  // over the cap failed every mirror deploy, so they are chunked the same way.
  const bytes = Buffer.alloc(25 * 1024 * 1024 + 4096, "عربي 中文 😀 ");
  for (const filename of ["events.json", "events-lite.json", "events-map.json"]) {
    const { env, requests, manifest } = fixture(bytes, 8 * 1024 * 1024, filename);
    const response = await (await workerPromise).fetch(new Request(`https://mirror.test/${filename}?v=1`), env);
    assert.equal(response.status, 200, filename);
    assert.equal(response.headers.get("Content-Length"), String(bytes.length));
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(bytes), filename);
    const paths = requests.map(request => new URL(request.url).pathname);
    assert.equal(paths[1], "/" + filename.replace(/\.json$/, "") + "-shards.json");
    assert.equal(paths.filter(path => path.startsWith("/_events/")).length, manifest.parts.length);
    assert.equal(manifest.parts.length, 4);
  }
});

test("a manifest or chunk named for another publication file is refused", async () => {
  for (const fault of ["filename", "prefix"]) {
    const { env, manifest, requests } = fixture(Buffer.from('{"events":[]}'), 7, "events-lite.json");
    if (fault === "filename") manifest.filename = "events.json";
    else manifest.parts[0].path = manifest.parts[0].path.replace("_events/events-lite-", "_events/events-");
    const response = await (await workerPromise).fetch(new Request("https://mirror.test/events-lite.json"), env);
    assert.equal(response.status, 503, fault);
    assert.equal(requests.length, 2, "No chunk may be requested for an invalid manifest");
  }
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

test("publication dataset routes are read only", async () => {
  for (const filename of ["events.json", "events-lite.json", "events-map.json"]) {
    const { env, requests } = fixture(Buffer.from('{"events":[]}'), 7, filename);
    const response = await (await workerPromise).fetch(new Request(`https://mirror.test/${filename}`, { method: "POST" }), env);
    assert.equal(response.status, 405, filename);
    assert.equal(response.headers.get("Allow"), "GET, HEAD");
    assert.equal(requests.length, 0);
  }
});
