"use strict";
// Social, Dark Web, Facial and IP Intelligence are retired: their code is gone, what they stored
// is not. Only the owner may delete stored data, so these tests pin both halves: nothing can reach
// the tools any more, and nothing here removes their data sooner than it would have gone anyway.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(ROOT, file), "utf8");
const worker = import("../cloudflare-worker/index.js");
const DAY = 86400000;
const HASH = "a".repeat(64);
const USERS = { admin: HASH, "group-i-1": HASH, "group-i-2": HASH };

class Storage {
  constructor() { this.values = new Map(); this.alarm = null; }
  async get(key) {
    if (Array.isArray(key)) return new Map(key.filter(k => this.values.has(k)).map(k => [k, structuredClone(this.values.get(k))]));
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    if (key && typeof key === "object") {
      for (const [k, v] of Object.entries(key)) this.values.set(k, structuredClone(v));
      return;
    }
    this.values.set(key, structuredClone(value));
  }
  async delete(key) { for (const k of Array.isArray(key) ? key : [key]) this.values.delete(k); }
  async list({ prefix = "", startAfter, end, limit = Infinity } = {}) {
    const keys = [...this.values.keys()].sort()
      .filter(k => k.startsWith(prefix) && (startAfter === undefined || k > startAfter) && (end === undefined || k < end));
    return new Map(keys.slice(0, limit).map(k => [k, structuredClone(this.values.get(k))]));
  }
  async transaction(fn) { return fn(this); }
  async getAlarm() { return this.alarm; }
  async setAlarm(when) { this.alarm = when; }
  async deleteAlarm() { this.alarm = null; }
}

async function gate() {
  const { ReportGate } = await worker;
  const storage = new Storage();
  return { storage, gate: new ReportGate({ storage }, { AUTH_USERS_JSON: JSON.stringify(USERS) }) };
}

function workerEnv() {
  return {
    AUTH_USERS_JSON: JSON.stringify(USERS),
    REPORT_GATE: {
      idFromName: name => name,
      get: () => ({ fetch: async () => Response.json({ username: "group-i-1", expires_at: Date.now() + DAY }) })
    }
  };
}

test("the Worker entry module links and exports exactly the gate and the FaceShare stub", async () => {
  const module = await worker;
  assert.deepEqual(Object.keys(module).sort(), ["FaceShare", "ReportGate", "default"]);
  assert.equal(typeof module.default.fetch, "function");
  assert.equal(typeof module.default.scheduled, "function");
});

test("FaceShare has no request handler and only keeps the expiry of a crop already hosted", async () => {
  const { FaceShare } = await worker;
  assert.deepEqual(Object.getOwnPropertyNames(FaceShare.prototype).sort(), ["alarm", "constructor"]);
  let cleared = 0;
  const storage = new Proxy({ deleteAll: async () => { cleared += 1; } }, {
    get(target, name) {
      if (name in target) return target[name];
      throw new Error("the stub may only clear its own expired crop");
    }
  });
  const stub = new FaceShare({ storage }, {});
  assert.equal(cleared, 0, "nothing is deleted unless the crop's own alarm fires");
  await stub.alarm();
  assert.equal(cleared, 1);
  assert.equal(fs.existsSync(path.join(ROOT, "cloudflare-worker/face-share.js")), false);
});

test("wrangler keeps the FaceShare namespace and drops every binding of the retired tools", () => {
  const config = read("cloudflare-worker/wrangler.toml");
  const active = config.split("\n").filter(line => !line.trim().startsWith("#")).join("\n");
  assert.match(active, /\[exports\.FaceShare\]\ntype = "durable-object"\nstorage = "sqlite"\n/);
  assert.match(active, /\[exports\.ReportGate\]\ntype = "durable-object"\nstorage = "sqlite"\n/);
  assert.doesNotMatch(active, /state\s*=/, "state = \"deleted\" permanently destroys a namespace");
  assert.doesNotMatch(active, /FACE_SHARE|DARKWEB_FILES|r2_buckets/);
  assert.doesNotMatch(active, /^\[ai\]/m, "nothing else uses env.AI");
  assert.match(read("cloudflare-worker/index.js"), /export class FaceShare \{/);
});

test("no Worker module still reads Workers AI or a binding or secret of the retired tools", () => {
  const dir = path.join(ROOT, "cloudflare-worker");
  for (const name of fs.readdirSync(dir).filter(file => /\.m?js$/.test(file))) {
    const source = fs.readFileSync(path.join(dir, name), "utf8");
    assert.doesNotMatch(source, /env\??\.(AI\b|DARKWEB_|SOCMINT_|VISUAL_INTEL_|FACE_SHARE|BRAVE_SEARCH_API_KEY|GEMINI_SOCMINT_|IPINFO_|PROXYCHECK_|IPAPI_IS_)/, name);
  }
});

test("the retired routes answer 404 and /health no longer mentions the tools", async () => {
  const { default: app } = await worker;
  const session = { "X-Session-Token": "token" };
  for (const [method, route] of [
    ["POST", "/social-investigate"], ["GET", "/social-workspace"], ["POST", "/social-workspace"], ["POST", "/visual-analyze"],
    ["POST", "/face-share"], ["GET", "/face-share/AAAAAAAAAAAAAAAAAAAAAA.jpg"], ["HEAD", "/face-share/AAAAAAAAAAAAAAAAAAAAAA.jpg"],
    ["GET", "/darkweb/state"], ["POST", "/darkweb/ingest"], ["POST", "/darkweb/policy"],
    ["POST", "/ip-intelligence/lookup"], ["GET", "/ip-intelligence/lookup"]
  ]) {
    const response = await app.fetch(new Request("https://worker.test" + route, { method, headers: session }), workerEnv(), { waitUntil() {} });
    assert.equal(response.status, 404, method + " " + route);
  }
  const health = await (await app.fetch(new Request("https://worker.test/health"), workerEnv(), { waitUntil() {} })).json();
  assert.equal(health.ok, true);
  assert.deepEqual(Object.keys(health).filter(key => /social|darkweb|visual|face|ip_intelligence/.test(key)), []);
});

test("a stale page can no longer record a retired tab or search", async () => {
  const { default: app } = await worker;
  const record = body => app.fetch(new Request("https://worker.test/usage-record", {
    method: "POST", headers: { "X-Session-Token": "token" }, body: JSON.stringify({ username: "group-i-1", ...body })
  }), workerEnv(), { waitUntil() {} });
  for (const tab of ["facial", "social", "darkweb", "ip"]) assert.equal((await record({ action: "tab_access", tab })).status, 400, tab);
  assert.equal((await record({ action: "darkweb_search" })).status, 400);
});

test("saved Social reports keep ageing out on the alarm: past 90 days they go, younger ones stay", async () => {
  const { gate: reportGate, storage } = await gate();
  const now = Date.now();
  const fresh = { id: "fresh", generated_at: new Date(now - 10 * DAY).toISOString() };
  const expired = { id: "expired", generated_at: new Date(now - 91 * DAY).toISOString() };
  await storage.put("social-workspace:group-i-1", { version: "v", username: "group-i-1", reports: [fresh, expired] });
  assert.equal(await reportGate.purgeExpired(now), Date.parse(fresh.generated_at) + 90 * DAY, "the next expiry stays scheduled");
  assert.deepEqual((await storage.get("social-workspace:group-i-1")).reports.map(report => report.id), ["fresh"]);
});

test("a chunked Social workspace ages out too, and a damaged one is left as it is", async () => {
  const { gate: reportGate, storage } = await gate();
  const now = Date.now();
  const padding = "x".repeat(40000);
  const workspace = { version: "v", username: "group-i-1", reports: [
    { id: "fresh", generated_at: new Date(now - DAY).toISOString(), body: padding },
    { id: "expired", generated_at: new Date(now - 91 * DAY).toISOString(), body: padding }
  ] };
  const serialized = JSON.stringify(workspace);
  const count = Math.ceil(serialized.length / 32000);
  const key = "social-workspace:group-i-1";
  await storage.put(key, { format: "social-chunks-v1", chunks: count });
  for (let i = 0; i < count; i++) await storage.put(`social-chunk:${key}:${i}`, serialized.slice(i * 32000, (i + 1) * 32000));
  await reportGate.purgeExpired(now);
  const kept = await reportGate.readSocialWorkspace(key);
  assert.deepEqual(kept.reports.map(report => report.id), ["fresh"]);

  await storage.put("social-workspace:group-i-2", { format: "social-chunks-v1", chunks: 2 });
  await assert.rejects(reportGate.purgeExpired(now), /incomplete/);
  assert.deepEqual(await storage.get("social-workspace:group-i-2"), { format: "social-chunks-v1", chunks: 2 });
});

test("search-history rows of the retired tools still leave at 90 days, and not a day sooner", async () => {
  const { gate: reportGate, storage } = await gate();
  const now = Date.now();
  const dayKey = when => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date(when));
  const key = (age, feature) => `usage-log:${dayKey(now - age * DAY)}:group-i-1:${feature}:${String(now - age * DAY).padStart(13, "0")}:abc123`;
  const features = ["social", "facial_extraction", "facial_search", "darkweb_search", "ip_lookup", "tab_facial", "tab_darkweb", "tab_ip"];
  for (const feature of features) {
    await storage.put(key(100, feature), { feature });
    await storage.put(key(80, feature), { feature });
  }
  await reportGate.purgeExpired(now);
  for (const feature of features) {
    assert.equal(await storage.get(key(100, feature)), undefined, feature + " past retention");
    assert.deepEqual(await storage.get(key(80, feature)), { feature }, feature + " inside retention");
  }
});

test("everything else the retired tools stored survives the alarm and every retired gate route", async () => {
  const { gate: reportGate, storage } = await gate();
  const seeded = {
    "darkweb:policy": { epoch: 2, from: "2025-01-01", through: "2026-12-31" },
    "darkweb:outlets": [{ id: "outlet", enabled: true }],
    "darkweb:item:a": { id: "a", first_seen: "2026-01-01" },
    "darkweb:publication:2:a": { id: "a", preview: "text" },
    "darkweb:publication-index:2:2026-01-01:a": "a",
    "darkweb:publication-pending:2:a": "a",
    "darkweb:summary": { text: "summary" },
    "darkweb:known:outlet:ab": {},
    ["darkweb:file:" + HASH]: { status: "ready", bytes: 10 },
    "darkweb:files-usage": { stored_bytes: 10, reserved_bytes: 0, files: 1 },
    "social-usage:group-i-1": { day: "2026-01-01", count: 1 },
    "social-usage-global": { day: "2026-01-01", count: 1 },
    "social-active:group-i-1": { run_id: "dead", started_at: 1 },
    "ip-intelligence:limit:group-i-1": { count: 2, until: 1 },
    "ip-intelligence:keyed-day": "2026-11-05",
    "ip-intelligence:keyed:2026-11-05": 12,
    "ip-intelligence:keyed:2026-11-05:group-i-1": 3,
    "usage-total:group-i-1": { username: "group-i-1", facial_searches: 3, darkweb_searches: 4, ip_lookups: 7 },
    "tab-access-total:group-i-1": { username: "group-i-1", facial: 5, darkweb: 6, ip: 8 }
  };
  await storage.put(seeded);
  const before = JSON.stringify([...storage.values].sort());
  await reportGate.alarm();
  for (const route of ["/darkweb-state", "/darkweb-policy", "/darkweb-ingest", "/darkweb-file-commit", "/social-workspace-get", "/social-report-delete", "/social-acquire", "/social-release", "/ip-intelligence-limit"]) {
    const response = await reportGate.fetch(new Request("https://gate.internal" + route, {
      method: "POST", body: JSON.stringify({ username: "group-i-1", reset: true, report_id: "x", policy: {}, keyed: true, log: { target: "8.8.8.8" } })
    }));
    assert.equal(response.status, 404, route);
  }
  assert.equal(JSON.stringify([...storage.values].sort()), before);
});

test("the IP Intelligence modules are gone and what stays in the Worker does not need them", () => {
  for (const file of ["ip-intelligence.js", "domain-intelligence.js", "domain-data.js"]) {
    assert.equal(fs.existsSync(path.join(ROOT, "cloudflare-worker", file)), false, file);
  }
  const dir = path.join(ROOT, "cloudflare-worker");
  for (const name of fs.readdirSync(dir).filter(file => /\.m?js$/.test(file))) {
    assert.doesNotMatch(fs.readFileSync(path.join(dir, name), "utf8"), /ip-intelligence|domain-intelligence|domain-data|handleIPIntelligence|\bip_lookup\b/, name);
  }
});

test("the retired pages and assets are gone and nothing the site serves points at them", () => {
  for (const name of ["social", "darkweb", "facial"]) {
    for (const file of [name + ".html", name + ".js", name + ".css", name + "-intelligence.svg"]) {
      assert.equal(fs.existsSync(path.join(ROOT, file)), false, file);
    }
  }
  assert.equal(fs.existsSync(path.join(ROOT, "facial-crops.js")), false);
  for (const file of ["ip.html", "ip.js", "ip.css", "ip-report.js", "ip-intelligence.svg"]) {
    assert.equal(fs.existsSync(path.join(ROOT, file)), false, file);
  }
  const pages = fs.readdirSync(ROOT).filter(file => /\.(?:html|js|css)$/.test(file));
  assert.ok(pages.includes("main.html") && pages.includes("feedback.js"));
  for (const page of pages.concat("tools/deploy_mirror.sh")) {
    assert.doesNotMatch(read(page), /\b(?:social|darkweb|facial)(?:-intelligence\.svg|-crops\.js|\.html|\.js|\.css)/, page);
    assert.doesNotMatch(read(page), /value="(?:social|darkweb|facial|ip)"/, page);
    assert.doesNotMatch(read(page), /\bip(?:-intelligence\.svg|-report\.js|\.html|\.js|\.css)|CTAtlasIPReport/, page);
    // The notice has to keep naming the tool: it says what happens to what the tool stored.
    if (page !== "privacy.html") assert.doesNotMatch(read(page), /IP Intelligence/, page);
  }
});

test("the deploys expect no IP Intelligence file and the live check waits for its card to go", () => {
  const deploy = read(".github/workflows/deploy-current-ct-atlas-ui.yml");
  const smoke = read(".github/workflows/live-smoke.yml");
  assert.doesNotMatch(deploy + smoke, /\bip(?:-intelligence\.svg|-report\.js|\.html"|\.js|\.css)|&& grep -q 'IP Intelligence'|grep -q 'IP Intelligence' main\.html/);
  assert.match(smoke, /&& ! grep -q 'IP Intelligence' \/tmp\/main\.html; then/);
  assert.match(deploy, /if grep -q [^\n]*ip\\\.html[^\n]* main\.html; then/, "a link back to the page fails the deploy");
});

test("an old IP row in the admin view is simply not offered: no column, no filter, no label", () => {
  const admin = read("usage-admin.js");
  assert.doesNotMatch(admin, /IP INTELLIGENCE|IP LOOKUP|ip_lookups?|tab:ip|tab_ip|registered_domain|parent_domain|IP or domain/);
  assert.match(read("tab-access.js"), /new Set\(\["map","crypto"\]\)/);
  assert.doesNotMatch(read("pdf-export.js"), /block\.inline|jurisdiction/i, "only the IP briefs placed inline flags");
});

test("the privacy notice drops what only these tools did and says what stays stored", () => {
  const notice = read("privacy.html");
  assert.doesNotMatch(notice, /Yandex|Telegram|4chan|Bluesky|Brave Search|Groq|Workers AI|Cloud Run|reverse-image/);
  assert.doesNotMatch(notice, /IPinfo|proxycheck|ipapi|RIPEstat|<strong>IP Intelligence|you look up in IP Intelligence/i);
  assert.match(notice, /Last updated: 6 November 2026/);
  assert.match(notice, /withdrawn in November 2026/);
  assert.match(notice, /has not been erased/);
  assert.match(notice, /until the administrator deletes them/);
  assert.match(notice, /and IP\s+Intelligence were withdrawn in November 2026/);
  assert.match(notice, /including the IP addresses and domains looked up in IP Intelligence, follow the 90-day/);
  assert.match(notice, /rate-limit counters of IP Intelligence/);
  assert.match(notice, /one-way hashed version of your\s+IP address/, "the login record is not the tool and stays described");
  assert.equal(fs.existsSync(path.join(ROOT, "docs/IP_INTELLIGENCE.md")), false);
});

test("the gate has no code that deletes Dark Web or IP limiter records or a namespace of a retired tool", () => {
  const gateSource = read("cloudflare-worker/report-gate.js");
  assert.doesNotMatch(gateSource, /darkweb:|"\/darkweb-|ip-intelligence/);
  assert.equal((gateSource.match(/deleteAll\(/g) || []).length, 1, "only the existing /migration-retire route");
});

test("reports and Deep Search leave out what the map holds for corroboration",()=>{
  assert.match(read("cloudflare-worker/index.js"),/allEvents\.filter\(e => e\.held_for_corroboration !== true/);
  assert.equal((read("cloudflare-worker/deep-search.js").match(/held_for_corroboration === true/g)||[]).length,2);
});

test("the versioned database read uses no cf cache option workerd refuses beside no-store",()=>{
  assert.match(read("cloudflare-worker/shared.js"),/const freshOptions = \{ cache: "no-store" \};/);
});

test("only /session-check can end a session: a 401 elsewhere asks it first",()=>{
  const source=read("usage-auth-fix.js");
  assert.match(source,/new URL\("\/session-check",url\)/);
  assert.match(source,/if\(check&&check\.status===401\)\{/);
});
