// End-to-end rehearsal of the mirror's chunked publication files. events-lite.json and
// events-map.json cross the 25 MiB Workers asset cap between about 28 Dec 2026 and 19 Jan
// 2027, and their chunked path has never run in production (the mirror was down from 27 Oct
// to 1 Nov 2026 while only events.json could be chunked). A synthetic database goes through
// the real tools/deploy_mirror.sh --prepare-only; the staged folder becomes the ASSETS of the
// staged Worker behind a local HTTP server; every route the map page, the report Worker and
// the publication audit read must return the builders' exact bytes, or fail loudly.
// The suite lowers the cap to 256 KiB so that the files stay small. The same test at the
// real cap (about 250 MB written, a minute or more):
//   CT_ATLAS_REHEARSE_REAL_CAP=1 node --test tests/mirror-stage-e2e.test.cjs
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const { once } = require("node:events");
const { execFile, execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "..");
const MiB = 1024 * 1024;
const REAL_CAP = process.env.CT_ATLAS_REHEARSE_REAL_CAP === "1";
const CAP = REAL_CAP ? 25 * MiB : MiB / 4;
// Both derived files must outgrow the cap: just past it at the real cap, as in late
// December; by three chunks in the suite.
const TARGET = REAL_CAP ? CAP + MiB : Math.round(2.5 * CAP);
const DATASETS = ["events.json", "events-lite.json", "events-map.json"];
const DAY = 86400e3;
const MINUTE = 60e3;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const stem = name => name.slice(0, -".json".length);
const ids = events => Array.from(events, event => event.id);

// ---------------------------------------------------------------- the synthetic database

// Scripts, escapes and characters that a chunk boundary or a byte-level compaction could break.
const WORDS = ["security", "forces", "عملية", "أمنية", "警方", "袭击", "задержаны", "взрыв", "Ελλάδα", "हमला",
  "공격", "Zürich", "😀", "quote\"d", "back\\slash", "line\nbreak", "tab\tstop", "sep\u2028arator", "</script>", "€100"];
// A number spelling that only a byte-preserving compaction keeps, written where an event
// holds the string "@lexeme@".
const LEXEME = "1.2300e+04";
const LEXEME_SLOT = '"@lexeme@"';
const EXCLUDED = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, "tools/events-lite-excluded-fields.json"), "utf8")));

function words(seed, count) {
  let state = Math.imul(seed + 1, 0x9e3779b1) >>> 0 || 1;
  const out = [];
  for (let i = 0; i < count; i++) {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    out.push(WORDS[state % WORDS.length]);
  }
  return out.join(" ");
}

// Attacks are map points; follow-ups and the other records are the map's recent context.
// A few records are older than the map window (lite only), one of them is cited by the
// brief (so the map keeps it), and one is retired Judicial (full file only).
const KINDS = [
  { type: "ATTACK", category: "Attacks" },
  { type: "ATTACK", category: "Attacks" },
  { type: "ATTACK", category: "Attacks" },
  { type: "ATTACK", category: "Attacks", followUp: true },
  { type: "DISRUPTED_PLOT", category: "Counter Terrorism Action" },
  { type: "ARREST", category: "Arrests" },
  { type: "CT_OPERATION", category: "Counter Terrorism Action" },
  { type: "ATTACK", category: "Attacks", unlocated: true },
  { type: "ARREST", category: "Arrests", unlocated: true },
  { type: "FINANCING", category: "Terrorist Financing" },
];
const CITED = 50;
const RETIRED = 5;
const isOld = index => index % 97 === CITED;
const inMap = index => index !== RETIRED && (!isOld(index) || index === CITED);

function syntheticEvent(index, now) {
  const kind = index === RETIRED ? { type: "JUDICIAL", category: "Legal/Judicial" }
    : isOld(index) ? KINDS[5] : KINDS[index % KINDS.length];
  // A minute of its own per record and two outlets each: nothing is held for corroboration.
  const published = new Date(isOld(index) ? now - 400 * DAY - index * MINUTE : now - (index + 1) * 7 * MINUTE).toISOString();
  const located = !kind.unlocated;
  const outlet = offset => `Outlet ${(index + offset) % 13}`;
  return {
    id: index.toString(16).padStart(16, "0"),
    category: kind.category,
    categories: [kind.category],
    title: `${kind.type} ${index}: ${words(index, 6)}`,
    summary: words(index + 1e6, 70),
    original_title: words(index + 2e6, 10),
    original_summary: words(index + 3e6, 50),
    original_language: "ar",
    published,
    source: outlet(0),
    source_count: 2,
    url: `https://example.test/a/${index}?q=a%20b&r=${index}`,
    collector: "Google News RSS",
    country: "Rehearsalia",
    city: located ? `City ${index % 50}` : null,
    region: null,
    latitude: located ? (index * 37) % 140 - 70 + 0.12345 : null,
    longitude: located ? (index * 71) % 340 - 170 + 0.6789 : null,
    location_precision: located ? "city" : "unlocated",
    location_confidence: located ? "high" : "low",
    sources: [outlet(0), outlet(5)],
    related_articles: [1, 2].map(n => ({ title: words(index * 3 + n, 12), url: `https://example.test/r/${index}/${n}`,
      source: outlet(n), published })),
    article_count: 3,
    first_reported: published,
    last_reported: published,
    ai_geo_reason: words(index + 4e6, 25),
    ai_geo_fingerprint: sha256(String(index)),
    primary_event_type: kind.type,
    is_attack: kind.type === "ATTACK",
    incident_id: `inc-${kind.followUp ? index - 1 : index}`,
    update_type: kind.followUp ? "FOLLOW_UP" : "INITIAL",
    threat_categories: [],
    reported_status: "CONFIRMED",
    location_confidence_score: "@lexeme@",
    location_evidence: [words(index + 5e6, 20)],
    excluded_from_map: !located,
  };
}

function liteBytes(event) {
  return Buffer.byteLength(JSON.stringify(Object.fromEntries(Object.entries(event).filter(([key]) => !EXCLUDED.has(key))))) + 1;
}

// Two passes hold one event at a time: the first counts the events the target needs, so
// that number_of_events can precede them as in the real file.
function eventCount(now) {
  let lite = 0, map = 0, index = 0;
  for (; lite < TARGET || map < TARGET; index++) {
    if (index === RETIRED) continue;
    const bytes = liteBytes(syntheticEvent(index, now));
    lite += bytes;
    if (inMap(index)) map += bytes;
  }
  return index;
}

// Writes the database pretty-printed, as the collector does, and hashes the compact form
// the mirror must serve: the same JSON without whitespace outside strings, plus "\n".
function writeDatabase(file, now) {
  const count = eventCount(now);
  const fd = fs.openSync(file, "w");
  const hash = createHash("sha256");
  let size = 0;
  const put = (pretty, compact) => {
    fs.writeSync(fd, pretty.split(LEXEME_SLOT).join(LEXEME));
    const bytes = Buffer.from(compact.split(LEXEME_SLOT).join(LEXEME));
    hash.update(bytes);
    size += bytes.length;
  };
  const member = (key, value) => [`  ${JSON.stringify(key)}: ${JSON.stringify(value, null, 2).replace(/\n/g, "\n  ")}`,
    `${JSON.stringify(key)}:${JSON.stringify(value)}`];
  const stamp = new Date(now - 10 * MINUTE).toISOString();
  const head = {
    project: "CT Atlas mirror rehearsal",
    retention_days: 180,
    collection_status: { schema_version: 2, status: "complete", last_attempt_at: new Date(now - 70 * MINUTE).toISOString(),
      published_at: stamp, finalized_at: stamp },
    trend_summary: { overview: words(1, 40), developments: [{ event_id: syntheticEvent(CITED, now).id, headline: words(2, 8) }] },
    last_updated: stamp,
    number_of_events: count,
  };
  put("{\n", "{");
  for (const [key, value] of Object.entries(head)) {
    const [pretty, compact] = member(key, value);
    put(pretty + ",\n", compact + ",");
  }
  put('  "events": [\n', '"events":[');
  for (let index = 0; index < count; index++) {
    const event = syntheticEvent(index, now);
    put((index ? ",\n    " : "    ") + JSON.stringify(event, null, 2).replace(/\n/g, "\n    "),
      (index ? "," : "") + JSON.stringify(event));
  }
  // A key after "events", as in the real file: the Worker's stream parser must reach it.
  const [pretty, compact] = member("geolocation", { method: "rehearsal", version: "1" });
  put("\n  ],\n" + pretty + "\n}\n", "]," + compact + "}\n");
  fs.closeSync(fd);
  return { sha256: hash.digest("hex"), size };
}

// tools/deploy_mirror.sh works in the folder above its own: the tracked tree as hard links
// (copies where a link is refused), with the synthetic events.json in place of the real one.
// The script writes only into its staging folder, so no linked file is ever written.
function plantTree(tree) {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" });
  for (const name of new Set(listed.split("\0"))) {
    const source = path.join(ROOT, name), target = path.join(tree, name);
    // Skips a file deleted here, and on Windows the case twin of one already planted.
    if (!name || name === "events.json" || !fs.existsSync(source) || fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try { fs.linkSync(source, target); } catch { fs.copyFileSync(source, target); }
  }
}

function run(command, args, options) {
  return new Promise(resolve => execFile(command, args, { maxBuffer: 64 * MiB, ...options },
    (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr })));
}

// ---------------------------------------------------------------- the mirror

// The staged folder as the Worker's ASSETS binding: exact paths, 404 otherwise, and nothing
// that .assetsignore keeps out of the upload. A fault replaces (or with null removes) an asset.
function stagedAssets(staging) {
  const ignored = new Set(fs.readFileSync(path.join(staging, ".assetsignore"), "utf8").split(/\r?\n/).filter(Boolean));
  const faults = new Map();
  const read = name => {
    if (faults.has(name)) return faults.get(name);
    const file = path.join(staging, ...name.split("/"));
    if (!name || ignored.has(name.split("/")[0]) || name.split("/").includes("..") || !fs.existsSync(file)
        || !fs.statSync(file).isFile()) return null;
    return fs.readFileSync(file);
  };
  return {
    faults,
    async fetch(input) {
      const request = input instanceof Request ? input : new Request(input);
      const name = decodeURIComponent(new URL(request.url).pathname.slice(1));
      const bytes = read(name);
      if (!bytes) return new Response("Not Found", { status: 404 });
      return new Response(request.method === "HEAD" ? null : bytes, { headers: {
        "Content-Type": name.endsWith(".json") ? "application/json" : "application/octet-stream",
        "Content-Length": String(bytes.length) } });
    },
  };
}

function serve(worker, assets) {
  const server = http.createServer(async (req, res) => {
    try {
      const headers = Object.entries(req.headers).filter(([name]) => name !== "host" && name !== "connection");
      const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers });
      const response = await worker.fetch(request, { ASSETS: assets });
      const sent = Object.fromEntries(response.headers);
      // Cloudflare compresses JSON for a client that accepts it, as browsers do, and drops
      // Content-Length: then only the end of the chunked framing tells a cut body from a whole one.
      if (/\b(gzip|br)\b/.test(req.headers["accept-encoding"] || "")) delete sent["content-length"];
      res.writeHead(response.status, sent);
      // The headers go out before the body, and the body at the pace the client reads it,
      // as on the platform: otherwise a failure could cut the response before it began.
      res.flushHeaders();
      await new Promise(resolve => setImmediate(resolve));
      if (response.body) {
        for await (const chunk of response.body) {
          if (!res.write(chunk)) await Promise.race([once(res, "drain"), once(res, "close")]);
        }
      }
      res.end();
    } catch {
      // What the platform does when a Worker's body fails midway: the connection is cut,
      // so a client sees a short body, never one that looks complete.
      res.destroy();
    }
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// One request as a client sees it: the response, and the whole body or what cut it.
async function get(url, headers = {}, method = "GET") {
  const response = await fetch(url, { headers, method });
  try {
    return { response, bytes: Buffer.from(await response.arrayBuffer()) };
  } catch (error) {
    return { response, error };
  }
}

// ---------------------------------------------------------------- the readers

// The map page's own loaders from index.html, fetching relative URLs from the mirror.
function mapPage(base) {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8").replace(/\r\n/g, "\n");
  const declaration = name => {
    const start = html.indexOf(`\nfunction ${name}(`) + 1;
    assert.ok(start > 0, `${name}() not found in index.html`);
    return html.slice(start, html.indexOf("\n}", start) + 2);
  };
  const constant = name => html.match(new RegExp(`^const ${name} = [^;]*;`, "m"))[0];
  const window = {};
  const requests = [];
  const context = vm.createContext({ window, AbortController, setTimeout, clearTimeout, Response, TransformStream,
    TextDecoder, crypto, fetch: (url, options) => { requests.push(url); return fetch(new URL(url, base), options); } });
  vm.runInContext([
    ...["CATEGORY_ALIASES", "MAP_DOWNLOAD_STALL_MS", "MAP_RECENT_EVENT_DAYS"].map(constant),
    ...["isJudicialCategory", "isRetiredJudicialEvent", "normalizeActiveEvent", "eventLooksLikeMaritimePiracy",
      "normalizeCategoryName", "eventCategories", "eventMatchKey", "removeRetiredJudicialData", "guardMapDownload",
      "loadEventsDatabase", "isMapAttackEvent", "readMapSnapshotResponse", "loadMapDatabase",
      "mapPublicationMatches"].map(declaration),
  ].join("\n"), context);
  return { context, window, requests, run: code => vm.runInContext(code, context) };
}

// The report Worker's fetchEventsDatabase (cloudflare-worker/shared.js), pointed at the mirror.
// In production it reads ct-atlas.com (cloudflare-worker/wrangler.toml), not the mirror.
async function reportWorker(base) {
  const { fetchEventsDatabase } = await import(pathToFileURL(path.join(ROOT, "cloudflare-worker/shared.js")).href);
  return fetchEventsDatabase({ EVENTS_URL: base + "events.json", EVENTS_LITE_URL: base + "events-lite.json" });
}

// daily_publication_audit verify and the live check's map hash, unchanged, except that
// verify() takes only https:// deployments and this mirror speaks plain HTTP: its
// connections skip TLS and nothing else.
const AUDIT = [
  "import http.client, json, sys, urllib.request",
  "sys.path.insert(0, 'tools')",
  "import daily_publication_audit as audit",
  "class PlainHttps(urllib.request.HTTPSHandler):",
  "    def https_open(self, request):",
  "        return self.do_open(http.client.HTTPConnection, request)",
  "urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({}), PlainHttps))",
  "url, expected, receipt = sys.argv[1:]",
  "try:",
  "    audit.verify(url, expected, receipt, attempts=1)",
  "except RuntimeError:",
  "    sys.exit(3)",
  "live = audit.read_live(url)",
  "print(json.dumps({'served': live['sha256_bytes'], 'named': live['manifest']['files']['events-map.json']['sha256_bytes']}))",
].join("\n");

// ---------------------------------------------------------------- the rehearsal

let tmp, staging, workerFile, assets, server, base;
const expected = {};
const manifests = {};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-rehearsal-"));
  const tree = path.join(tmp, "tree");
  const oracle = path.join(tmp, "oracle");
  plantTree(tree);
  const database = writeDatabase(path.join(tree, "events.json"), Date.now());
  const env = { ...process.env, PYTHONIOENCODING: "utf-8" };
  delete env.CT_ATLAS_MIRROR_REHEARSAL_CAP;
  const deployEnv = {
    ...env,
    ...(REAL_CAP ? {} : { CT_ATLAS_MIRROR_REHEARSAL_CAP: String(CAP) }),
    // The manifest names the revision it was built from, and refuses a database much
    // smaller than the live site's unless the shrink is intended: a synthetic one is.
    GIT_DIR: execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: ROOT, encoding: "utf8" }).trim(),
    ALLOW_SHRINK: "1",
  };
  // The expected derived bytes come from the same builders, run apart from the deploy.
  const [deploy, ...builds] = await Promise.all([
    run("bash", ["tools/deploy_mirror.sh", "--prepare-only"], { cwd: tree, env: deployEnv }),
    ...[["build_events_lite", "events-lite.json"], ["build_events_map", "events-map.json"]].map(([tool, name]) =>
      run("python3", [`tools/${tool}.py`, "--input", path.join(tree, "events.json"), "--output", path.join(oracle, name)],
        { cwd: ROOT, env })),
  ]);
  assert.equal(deploy.status, 0, deploy.stderr || deploy.stdout);
  for (const build of builds) assert.equal(build.status, 0, build.stderr);

  staging = path.join(tree, "_pages_mirror");
  expected["events.json"] = { ...database, document: JSON.parse(fs.readFileSync(path.join(tree, "events.json"), "utf8")) };
  for (const name of ["events-lite.json", "events-map.json"]) {
    // Compaction adds the final newline the builders leave out, and changes nothing else.
    const bytes = Buffer.concat([fs.readFileSync(path.join(oracle, name)), Buffer.from("\n")]);
    expected[name] = { sha256: sha256(bytes), size: bytes.length, document: JSON.parse(bytes) };
  }
  for (const name of DATASETS) {
    const file = path.join(staging, `${stem(name)}-shards.json`);
    if (fs.existsSync(file)) manifests[name] = JSON.parse(fs.readFileSync(file, "utf8"));
  }
  // The Worker wrangler would deploy from the staged folder.
  workerFile = fs.readFileSync(path.join(staging, "wrangler.toml"), "utf8").match(/^main = "(.+)"$/m)[1];
  assets = stagedAssets(staging);
  server = await serve((await import(pathToFileURL(path.join(staging, workerFile)).href)).default, assets);
  base = `http://127.0.0.1:${server.address().port}/`;
});

after(() => {
  server?.closeAllConnections();
  server?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test("the staged folder holds each publication file as the chunks its manifest names", t => {
  assert.ok(expected["events-lite.json"].size > CAP && expected["events-map.json"].size > CAP,
    "the synthetic derived files must outgrow the cap");
  const named = new Set();
  for (const name of DATASETS) {
    const manifest = manifests[name];
    assert.ok(manifest, `${name} must be chunked`);
    assert.ok(!fs.existsSync(path.join(staging, name)), `no whole ${name} may be uploaded beside its chunks`);
    assert.deepEqual([manifest.format, manifest.filename, manifest.sha256, manifest.size_bytes],
      ["ct-atlas-byte-shards-v1", name, expected[name].sha256, expected[name].size]);
    assert.ok(manifest.parts.length >= (REAL_CAP ? 2 : 3), name);
    const chunks = manifest.parts.map((part, index) => {
      assert.equal(part.path, `_events/${stem(name)}-${manifest.sha256.slice(0, 16)}-${String(index).padStart(5, "0")}.bin`);
      const bytes = fs.readFileSync(path.join(staging, part.path));
      assert.ok(bytes.length <= CAP && bytes.length === part.size_bytes && sha256(bytes) === part.sha256, part.path);
      named.add(part.path);
      return bytes;
    });
    assert.equal(sha256(Buffer.concat(chunks)), expected[name].sha256, name);
    t.diagnostic(`${name}: ${expected[name].size} bytes in ${chunks.length} chunks`);
  }
  assert.deepEqual(fs.readdirSync(path.join(staging, "_events")).filter(file => !named.has(`_events/${file}`)), []);
  const publication = JSON.parse(fs.readFileSync(path.join(staging, "publication-manifest.json"), "utf8"));
  for (const name of DATASETS) {
    assert.equal(publication.files[name].sha256_bytes, expected[name].sha256, name);
    assert.equal(publication.files[name].size_bytes, expected[name].size, name);
  }
  assert.ok(fs.readFileSync(path.join(staging, workerFile)).equals(fs.readFileSync(path.join(ROOT, "tools/mirror-worker.mjs"))));
});

test("every route the page, the report Worker and the audit request streams back the exact bytes", async () => {
  for (const name of DATASETS) {
    const etag = `"sha256-${expected[name].sha256}"`;
    const identity = { "Accept-Encoding": "identity" };
    for (const [route, headers] of [
      [name, {}], // the map page
      [`${name}?ct_atlas_version=${Date.now()}`, {}], // the report Worker, past a stale cache
      [`${name}?integrity=${process.hrtime.bigint()}`, { "Cache-Control": "no-cache", ...identity }], // the audit
    ]) {
      const { response, bytes, error } = await get(base + route, headers);
      assert.equal(response.status, 200, route);
      assert.ifError(error);
      assert.equal(response.headers.get("ETag"), etag, route);
      assert.match(response.headers.get("Content-Type"), /^application\/json/, route);
      assert.equal(sha256(bytes), expected[name].sha256, route);
      if (headers["Accept-Encoding"]) assert.equal(response.headers.get("Content-Length"), String(expected[name].size), route);
    }
    // The page fetches with cache: "no-cache", so a browser revalidates its copy, also with
    // the weak ETag Cloudflare hands out once it compresses the body.
    for (const tag of [etag, `W/${etag}`]) {
      const { response, bytes } = await get(base + name, { "If-None-Match": tag });
      assert.equal(response.status, 304, tag);
      assert.equal(bytes.length, 0, tag);
    }
    const head = await get(base + name, identity, "HEAD");
    assert.equal(head.response.headers.get("Content-Length"), String(expected[name].size), name);
  }
  const publication = await get(base + "publication-manifest.json");
  assert.ok(publication.bytes.equals(fs.readFileSync(path.join(staging, "publication-manifest.json"))));
});

test("the map page reads each chunked file whole, and the map matches the publication manifest", async () => {
  const page = mapPage(base);
  const map = await page.run("loadMapDatabase()");
  assert.deepEqual(page.requests.splice(0), ["events-map.json"]);
  assert.equal(page.window.eventsDataSource, "events-map.json");
  assert.equal(JSON.stringify(map), JSON.stringify(expected["events-map.json"].document));
  assert.equal(map._publicationBytesHash, expected["events-map.json"].sha256);
  const publication = await (await fetch(base + "publication-manifest.json")).json();
  assert.equal(page.context.mapPublicationMatches(map, publication.files["events-map.json"]), true);
  const lite = await page.run("loadEventsDatabase()");
  assert.deepEqual(page.requests, ["events-lite.json"]);
  assert.equal(page.window.eventsDataSource, "events-lite.json");
  assert.equal(JSON.stringify(lite), JSON.stringify(expected["events-lite.json"].document));
});

test("the report Worker reads the chunked lite file whole", async () => {
  const result = await reportWorker(base);
  assert.deepEqual([result.ok, result.status, result.source], [true, 200, "lite"]);
  assert.equal(JSON.stringify(result.db), JSON.stringify(expected["events-lite.json"].document));
});

// Each fault breaks the chunked form in a way a partial or interrupted deploy could. Its
// outcome is what a client of the mirror sees: a 503, or a 200 whose body is cut short.
const FAULTS = {
  "a missing first chunk": [manifest => [[manifest.parts[0].path, null]], 503],
  "a missing last chunk": [manifest => [[manifest.parts.at(-1).path, null]], "cut"],
  "a manifest left from another build": [manifest => {
    const other = sha256(Buffer.from(manifest.sha256));
    const parts = manifest.parts.map(part => ({ ...part, path: part.path.replace(manifest.sha256.slice(0, 16), other.slice(0, 16)) }));
    return [[`${stem(manifest.filename)}-shards.json`, Buffer.from(JSON.stringify({ ...manifest, sha256: other, parts }))]];
  }, 503],
  "a manifest whose chunk sizes disagree with the chunks": [manifest => {
    const parts = manifest.parts.map(part => ({ ...part }));
    parts.at(-2).size_bytes += 1;
    parts.at(-1).size_bytes -= 1;
    return [[`${stem(manifest.filename)}-shards.json`, Buffer.from(JSON.stringify({ ...manifest, parts }))]];
  }, "cut"],
};

for (const [fault, [damage, outcome]] of Object.entries(FAULTS)) {
  test(`${fault} fails loudly: the readers take another complete file, or stop`, async () => {
    const breakFiles = names => {
      assets.faults.clear();
      for (const name of names) for (const [asset, bytes] of damage(manifests[name])) assets.faults.set(asset, bytes);
    };
    try {
      breakFiles(DATASETS);
      for (const name of DATASETS) {
        const { response, error } = await get(base + name);
        if (outcome === 503) {
          assert.equal(response.status, 503, name);
          assert.equal(response.headers.get("Cache-Control"), "no-store", name);
        } else {
          assert.equal(response.status, 200, name);
          assert.ok(error, `${name}: a cut body must never read as complete`);
        }
      }
      const stopped = mapPage(base);
      await assert.rejects(stopped.run("loadMapDatabase()"));
      assert.deepEqual(stopped.requests, ["events-map.json", "events-lite.json", "events.json"]);
      assert.deepEqual(await reportWorker(base), { ok: false, status: 503, db: null, source: "full" });

      breakFiles(["events-map.json"]);
      const fromLite = mapPage(base);
      const reduced = await fromLite.run("loadMapDatabase()");
      assert.equal(fromLite.window.eventsDataSource, "events-lite.json");
      assert.deepEqual(ids(reduced.events), ids(expected["events-map.json"].document.events));
      assert.deepEqual(ids(reduced.recent_events), ids(expected["events-map.json"].document.recent_events));

      breakFiles(["events-map.json", "events-lite.json"]);
      const fromFull = mapPage(base);
      const full = await fromFull.run("loadMapDatabase()");
      assert.equal(fromFull.window.eventsDataSource, "events.json");
      // Without the derived attack_update flags, follow-ups move from the context to the points.
      const map = expected["events-map.json"].document;
      assert.deepEqual([...ids(full.events), ...ids(full.recent_events)].sort(), [...ids(map.events), ...ids(map.recent_events)].sort());
      const report = await reportWorker(base);
      assert.deepEqual([report.ok, report.source], [true, "full"]);
      const source = expected["events.json"].document;
      assert.equal(JSON.stringify(report.db),
        JSON.stringify({ ...source, events: source.events.map(({ related_articles, ...kept }) => kept) }));
    } finally {
      assets.faults.clear();
    }
  });
}

test("the publication audit confirms the rehearsal mirror, and refuses it with a chunk missing", async () => {
  const receipt = path.join(tmp, "publication-receipt-mirror.json");
  const audit = () => run("python3", ["-c", AUDIT, base.replace("http://", "https://"), path.join(staging, "publication-manifest.json"), receipt],
    { cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  const confirmed = await audit();
  assert.equal(confirmed.status, 0, confirmed.stderr);
  const proof = JSON.parse(fs.readFileSync(receipt, "utf8"));
  assert.equal(proof.publication_confirmed, true);
  assert.deepEqual(Object.keys(proof.files).sort(), [...DATASETS].sort());
  const live = JSON.parse(confirmed.stdout);
  assert.deepEqual([live.served, live.named], [expected["events-map.json"].sha256, expected["events-map.json"].sha256],
    "the live check must hash the map file its manifest names");

  assets.faults.set(manifests["events-lite.json"].parts.at(-1).path, null);
  try {
    const refused = await audit();
    assert.equal(refused.status, 3, refused.stderr);
  } finally {
    assets.faults.clear();
  }
  const refusal = JSON.parse(fs.readFileSync(receipt, "utf8"));
  assert.equal(refusal.publication_confirmed, false);
  assert.deepEqual(Object.keys(refusal.errors), ["events-lite.json"]);
});

test("a real deploy refuses the rehearsal cap before it stages anything", async () => {
  // Only the script is here: without its guard it would stop at its first copy, never upload.
  const alone = path.join(tmp, "alone");
  fs.mkdirSync(path.join(alone, "tools"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "tools/deploy_mirror.sh"), path.join(alone, "tools/deploy_mirror.sh"));
  const refused = await run("bash", ["tools/deploy_mirror.sh"], { cwd: alone,
    env: { ...process.env, CT_ATLAS_MIRROR_REHEARSAL_CAP: String(CAP) } });
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /only for --prepare-only/);
  assert.ok(!fs.existsSync(path.join(alone, "_pages_mirror")));
});
