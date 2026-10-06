"use strict";
// The admin search history: every counted search keeps one small row (what was searched,
// with which filters) that the admin opens by clicking the count. Rows stay with their user
// and feature, follow the same Paris-day periods as the counters, keep only whitelisted
// fields and are deleted after 90 days.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

let modules;
function loadGate() {
  if (!modules) {
    const sharedSource = fs.readFileSync(path.join(__dirname, "../cloudflare-worker/shared.js"), "utf8");
    const gateSource = fs.readFileSync(path.join(__dirname, "../cloudflare-worker/report-gate.js"), "utf8");
    const sharedUrl = "data:text/javascript;base64," + Buffer.from(sharedSource).toString("base64");
    const anchor = 'from"./shared.js";';
    assert.ok(gateSource.includes(anchor));
    const gateUrl = "data:text/javascript;base64," + Buffer.from(gateSource.replace(anchor, 'from"' + sharedUrl + '";')).toString("base64");
    modules = Promise.all([import(sharedUrl), import(gateUrl)]);
  }
  return modules;
}

// Durable Object storage with the real API's semantics: code-unit key order, [start, end)
// ranges, reverse, limit, batch operations of at most 128 keys, transactions and the alarm.
class Storage {
  constructor() { this.values = new Map(); this.alarm = null; }
  async get(key) {
    if (Array.isArray(key)) {
      assert.ok(key.length <= 128);
      return new Map(key.filter(k => this.values.has(k)).map(k => [k, structuredClone(this.values.get(k))]));
    }
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    if (key && typeof key === "object") {
      const entries = Object.entries(key);
      assert.ok(entries.length <= 128);
      for (const [k, v] of entries) this.values.set(k, structuredClone(v));
      return;
    }
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    const keys = Array.isArray(key) ? key : [key];
    assert.ok(keys.length <= 128);
    let removed = 0;
    for (const k of keys) if (this.values.delete(k)) removed++;
    return Array.isArray(key) ? removed : removed > 0;
  }
  async list({ prefix = "", start, startAfter, end, reverse = false, limit = Infinity } = {}) {
    let keys = [...this.values.keys()]
      .filter(k => k.startsWith(prefix) && (start === undefined || k >= start) && (startAfter === undefined || k > startAfter) && (end === undefined || k < end))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (reverse) keys.reverse();
    return new Map(keys.slice(0, limit).map(k => [k, structuredClone(this.values.get(k))]));
  }
  async transaction(fn) {
    const saved = new Map(this.values);
    try { return await fn(this); } catch (error) { this.values = saved; throw error; }
  }
  async getAlarm() { return this.alarm; }
  async setAlarm(when) { this.alarm = when; }
  async deleteAlarm() { this.alarm = null; }
}

const HASH = "a".repeat(64);
const USERS = { admin: HASH, "group-i-1": HASH, "group-i-10": HASH, "group-i-11": HASH, "group-s-11": HASH };

async function harness() {
  const [shared, { ReportGate }] = await loadGate();
  const storage = new Storage();
  const gate = new ReportGate({ storage }, { AUTH_USERS_JSON: JSON.stringify(USERS) });
  const call = async (route, body) => {
    const response = await gate.fetch(new Request("https://gate.internal" + route, { method: "POST", body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  const history = async (target, metric, period = "today") =>
    call("/usage-history", { username: "admin", target_username: target, metric, period });
  const logKeys = () => [...storage.values.keys()].filter(key => key.startsWith("usage-log:"));
  return { gate, storage, call, history, logKeys, shared };
}

test("a settled event-list search is counted and its text and filters reach the admin history, nothing else", async () => {
  const h = await harness();
  const recorded = await h.call("/usage-record", {
    username: "group-i-1", action: "event_list_search",
    details: { text: "  Boko   Haram ", region: "REGION:AFRICA", topic: "Attacks", actor_group: "ALL", period_days: 7, results: 12,
      scope: "x".repeat(500), password: "secret", image: "data:image/png;base64,AAAA", token: "abc" }
  });
  assert.equal(recorded.status, 200);
  const stats = await h.gate.usageStats("today");
  const row = stats.users.find(item => item.username === "group-i-1");
  assert.equal(row.event_list_searches, 1);
  assert.equal(row.searches, 1);

  const { status, body } = await h.history("group-i-1", "event_list_searches");
  assert.equal(status, 200);
  assert.equal(body.username, "group-i-1");
  assert.equal(body.display_name, "Ed");
  assert.equal(body.retention_days, 90);
  assert.equal(body.rows.length, 1);
  const entry = body.rows[0];
  assert.equal(entry.feature, "event_list");
  assert.equal(entry.text, "Boko Haram");
  assert.equal(entry.region, "REGION:AFRICA");
  assert.equal(entry.period_days, 7);
  assert.equal(entry.results, 12);
  assert.equal(entry.scope.length, 200, "free text is capped");
  for (const forbidden of ["password", "image", "token"]) assert.ok(!(forbidden in entry), forbidden + " is never stored");
  assert.ok(!JSON.stringify([...h.storage.values.values()]).includes("secret"));
  assert.match(entry.id, /^usage-log:\d{4}-\d{2}-\d{2}:group-i-1:event_list:\d{13}:[a-z0-9]{6}$/);

  // An older page without details is still counted, just without a row.
  await h.call("/usage-record", { username: "group-i-1", action: "event_list_search" });
  assert.equal((await h.gate.usageStats("today")).users.find(item => item.username === "group-i-1").event_list_searches, 2);
  assert.equal((await h.history("group-i-1", "searches")).body.rows.length, 1);
});

test("only the admin reads the history, for a known user and a known counter", async () => {
  const h = await harness();
  assert.equal((await h.call("/usage-history", { username: "group-i-1", target_username: "group-i-1", metric: "all", period: "today" })).status, 403);
  assert.equal((await h.history("group-i-1", "passwords")).status, 400);
  assert.equal((await h.history("nobody", "all")).status, 400);
  assert.equal((await h.history("group-i-1", "all", "365")).status, 400);
  assert.equal((await h.history("group-i-1", "__proto__")).status, 400);
});

test("rows stay with their user: group-i-1 never sees group-i-10's searches, and ALL ACTIVITY is newest first", async () => {
  const h = await harness();
  const now = Date.now();
  await h.gate.incrementUsage("group-i-10", { darkweb_searches: 1 }, now - 3000, h.gate.usageLogEntry("group-i-10", "darkweb_search", { text: "other user" }, now - 3000));
  await h.gate.incrementUsage("group-i-1", { darkweb_searches: 1 }, now - 2000, h.gate.usageLogEntry("group-i-1", "darkweb_search", { text: "mine", outlet: "Outlet B", view: "latest" }, now - 2000));
  await h.gate.incrementUsage("group-i-1", { blockchain_searches: 1 }, now - 1000, h.gate.usageLogEntry("group-i-1", "blockchain", { query: "bc1qexample", chain: "bitcoin", origin: "search" }, now - 1000));
  const darkweb = (await h.history("group-i-1", "darkweb_searches")).body.rows;
  assert.deepEqual(darkweb.map(row => row.text), ["mine"]);
  const all = (await h.history("group-i-1", "all")).body.rows;
  assert.deepEqual(all.map(row => row.feature), ["blockchain", "darkweb_search"]);
  assert.equal(all[0].query, "bc1qexample");
  assert.deepEqual((await h.history("group-i-10", "all")).body.rows.map(row => row.text), ["other user"]);
  const stats = (await h.gate.usageStats("today")).users.find(item => item.username === "group-i-1");
  assert.equal(stats.darkweb_searches, 1);
  assert.equal(stats.blockchain_searches, 1);
});

test("a report request keeps its filters and then its outcome; nobody else can change that row", async () => {
  const h = await harness();
  const acquired = await h.call("/acquire", {
    username: "group-i-1", kind: "report_generator",
    details: { region: "GLOBAL", topic: "ALL", actor_group: "ALL", period_days: 7, compare: true }
  });
  assert.equal(acquired.status, 200);
  const id = acquired.body.log_id;
  assert.match(id, /:group-i-1:report_generator:/);
  await h.call("/usage-increment", { username: "group-i-1", metrics: { cached_reports: 1 }, log_update: { id, outcome: "cached", title: "Weekly brief" } });
  let row = (await h.history("group-i-1", "report_generator_requests")).body.rows[0];
  assert.equal(row.outcome, "cached");
  assert.equal(row.title, "Weekly brief");
  assert.equal(row.compare, true);
  assert.equal(row.period_days, 7);

  assert.equal((await h.call("/usage-log-update", { username: "group-s-11", log_update: { id, outcome: "failed" } })).body.updated, false);
  assert.equal((await h.call("/usage-log-update", { username: "group-i-1", log_update: { id, outcome: "hacked", region: "MENA" } })).body.updated, false);
  row = (await h.history("group-i-1", "report_generator_requests")).body.rows[0];
  assert.equal(row.outcome, "cached");
  assert.equal(row.region, "GLOBAL", "only the outcome, title and period can change");
  assert.equal((await h.call("/usage-log-update", { username: "group-i-1", log_update: { id: "usage-log:x", outcome: "failed" } })).body.updated, false);

  await h.call("/release", { permitId: acquired.body.permit_id, username: "group-i-1" });
  const deep = await h.call("/acquire", { username: "admin", kind: "deep_search", details: { question: "Who claimed the Diffa attack?", region: "GLOBAL" } });
  assert.equal(deep.status, 200);
  const rows = (await h.history("admin", "report_requests")).body.rows;
  assert.deepEqual(rows.map(item => item.feature), ["deep_search"]);
  assert.equal(rows[0].question, "Who claimed the Diffa attack?");
});

test("periods follow the counters' Paris days and rows older than 90 days are purged", async () => {
  const h = await harness();
  const now = Date.now();
  const day = 86400000;
  for (const [age, query] of [[0, "today"], [3 * day, "three days"], [10 * day, "ten days"], [95 * day, "too old"]]) {
    await h.gate.incrementUsage("group-i-1", { blockchain_searches: 1 }, now - age, h.gate.usageLogEntry("group-i-1", "blockchain", { query }, now - age));
  }
  const queries = async period => (await h.gate.usageHistory("group-i-1", "blockchain_searches", period, now)).rows.map(row => row.query);
  assert.deepEqual(await queries("today"), ["today"]);
  assert.deepEqual(await queries("7"), ["today", "three days"]);
  assert.deepEqual(await queries("30"), ["today", "three days", "ten days"]);
  assert.deepEqual(await queries("all"), ["today", "three days", "ten days"]);
  assert.equal(h.logKeys().length, 4);
  await h.gate.purgeExpired(now);
  assert.equal(h.logKeys().length, 3);
  assert.ok(!JSON.stringify([...h.storage.values.values()]).includes("too old"));
  assert.equal((await h.gate.usageStats("all")).users.find(item => item.username === "group-i-1").blockchain_searches, 4, "counters are not touched");
});

test("an IP lookup is counted with its canonical target only when its slot is granted", async () => {
  const h = await harness();
  const log = { target: "8.8.8.8", kind: "ip", raw: "https://example.com/?token=secret" };
  for (let i = 0; i < 6; i++) assert.equal((await h.call("/ip-intelligence-limit", { username: "group-i-1", log })).status, 200);
  assert.equal((await h.call("/ip-intelligence-limit", { username: "group-i-1", log })).status, 429);
  const stats = (await h.gate.usageStats("today")).users.find(item => item.username === "group-i-1");
  assert.equal(stats.ip_lookups, 6, "a refused lookup is not counted");
  const rows = (await h.history("group-i-1", "ip_lookups")).body.rows;
  assert.equal(rows.length, 6);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["at", "feature", "id", "kind", "target"]);
  // A domain's own IP analyses take slots without a log: not counted as searches.
  await h.call("/ip-intelligence-limit", { username: "group-i-11" });
  assert.equal((await h.gate.usageStats("today")).users.find(item => item.username === "group-i-11").ip_lookups, 0);
});

test("workspace openings list their times, and social requests keep capped lists", async () => {
  const h = await harness();
  assert.equal((await h.call("/usage-record", { username: "group-s-11", action: "tab_access", tab: "crypto" })).status, 200);
  const opened = (await h.history("group-s-11", "tab:crypto")).body;
  assert.equal(opened.display_name, "Adrien CBRN");
  assert.deepEqual(opened.rows.map(row => row.feature), ["tab_crypto"]);

  await h.call("/usage-increment", {
    username: "group-s-11", metrics: { social_intel_requests: 1 },
    log: { feature: "social", details: {
      target: "Example Person", mode: "discover",
      usernames: Array.from({ length: 50 }, (_, i) => "handle" + i),
      urls: ["https://example.com/" + "p".repeat(400), { nested: true }],
      objective: "o".repeat(2000)
    } }
  });
  const social = (await h.history("group-s-11", "social_intel_requests")).body.rows[0];
  assert.equal(social.usernames.length, 40);
  assert.deepEqual(social.urls.map(url => url.length), [300], "non-text items are dropped and URLs capped");
  assert.equal(social.objective.length, 1500);
  // A Worker module cannot write a workspace-opening row through /usage-increment.
  await h.call("/usage-increment", { username: "group-s-11", metrics: {}, log: { feature: "tab_ip" } });
  assert.equal((await h.history("group-s-11", "tab:ip")).body.rows.length, 0);
  const all = (await h.history("group-s-11", "all")).body.rows.map(row => row.feature).sort();
  assert.deepEqual(all, ["social", "tab_crypto"]);
});

test("the alarm stays armed while history rows exist, so the 90-day purge happens without logins", async () => {
  const h = await harness();
  const now = Date.now();
  assert.equal(await h.gate.purgeExpired(now), null, "no history, nothing to schedule");
  await h.call("/usage-record", { username: "group-i-1", action: "tab_access", tab: "map" });
  assert.equal(await h.gate.purgeExpired(now), now + 86400000, "a daily purge while rows remain");
  await h.gate.alarm();
  assert.ok(h.storage.alarm > Date.now(), "alarm() re-arms instead of deleting the alarm");
});

test("ALL ACTIVITY lists the newest rows first even after a busy day of other features", async () => {
  const h = await harness();
  const now = Date.now();
  for (let i = 520; i >= 1; i--) {
    h.gate.usageLogBudget = new Map(); // isolate ordering from the per-minute cap tested below
    await h.gate.incrementUsage("group-i-1", {}, now - i * 1000, h.gate.usageLogEntry("group-i-1", "tab_map", null, now - i * 1000));
  }
  await h.gate.incrementUsage("group-i-1", { blockchain_searches: 1 }, now, h.gate.usageLogEntry("group-i-1", "blockchain", { query: "newest" }, now));
  const result = await h.gate.usageHistory("group-i-1", "all", "7", now);
  assert.equal(result.truncated, true);
  assert.equal(result.rows.length, 500);
  assert.equal(result.rows[0].query, "newest");
  const times = result.rows.map(row => Date.parse(row.at));
  assert.deepEqual(times, [...times].sort((a, b) => b - a), "strictly newest first");
});

test("a scripted flood is counted but keeps at most 120 history rows per user per minute", async () => {
  const h = await harness();
  const now = Date.now();
  for (let i = 0; i < 125; i++) {
    await h.gate.incrementUsage("group-i-11", { darkweb_searches: 1 }, now, h.gate.usageLogEntry("group-i-11", "darkweb_search", { text: "flood " + i }, now));
  }
  assert.equal((await h.gate.usageStats("today")).users.find(item => item.username === "group-i-11").darkweb_searches, 125);
  assert.equal(h.logKeys().length, 120);
  assert.ok(h.gate.usageLogEntry("group-i-1", "darkweb_search", { text: "other user" }, now), "the cap is per user");
  assert.ok(h.gate.usageLogEntry("group-i-11", "darkweb_search", { text: "next minute" }, now + 60000), "and per minute");
});
