"use strict";
// The SOCMINT limits and report storage in the ReportGate Durable Object.
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
    const gateUrl = "data:text/javascript;base64," + Buffer.from(gateSource.replace('from"./shared.js";', 'from"' + sharedUrl + '";')).toString("base64");
    modules = Promise.all([import(sharedUrl), import(gateUrl)]);
  }
  return modules;
}

class Storage {
  constructor() { this.values = new Map(); this.alarm = null; }
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) {
    if (key && typeof key === "object") {
      for (const [k, v] of Object.entries(key)) this.values.set(k, structuredClone(v));
      return;
    }
    this.values.set(key, structuredClone(value));
  }
  async delete(key) { for (const k of Array.isArray(key) ? key : [key]) this.values.delete(k); }
  async list({ prefix = "" } = {}) { return new Map([...this.values].filter(([key]) => key.startsWith(prefix))); }
  async transaction(fn) { return fn(this); }
  async getAlarm() { return this.alarm; }
  async setAlarm(when) { this.alarm = when; }
  async deleteAlarm() { this.alarm = null; }
}

const HASH = "a".repeat(64);
const USERS = Object.fromEntries(["admin", ...Array.from({ length: 12 }, (_, i) => "group-i-" + (i + 1))].map(name => [name, HASH]));

async function harness() {
  const [shared, { ReportGate }] = await loadGate();
  const storage = new Storage();
  const gate = new ReportGate({ storage }, { AUTH_USERS_JSON: JSON.stringify(USERS) });
  const call = async (route, body) => {
    const response = await gate.fetch(new Request("https://gate.internal" + route, { method: "POST", body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  const startAndFinish = async username => {
    const run = await call("/social-acquire", { username, details: { target: "x" } });
    if (run.status === 200) await call("/social-release", { username, run_id: run.body.run_id });
    return run;
  };
  return { storage, call, startAndFinish, shared };
}

test("each account gets a daily limit, with a clear code", async () => {
  const h = await harness();
  for (let i = 0; i < h.shared.SOCMINT_DAILY_LIMIT; i++) assert.equal((await h.startAndFinish("group-i-1")).status, 200);
  const refused = await h.startAndFinish("group-i-1");
  assert.equal(refused.status, 429);
  assert.equal(refused.body.code, "SOCMINT_USER_QUOTA_EXHAUSTED");
  assert.equal((await h.startAndFinish("group-i-2")).status, 200, "one account's limit does not stop another");
});

test("all accounts together stop at the global limit, which protects the shared Gemini pool", async () => {
  const h = await harness();
  for (let i = 1; i <= h.shared.SOCMINT_GLOBAL_DAILY_LIMIT; i++) assert.equal((await h.startAndFinish("group-i-" + i)).status, 200);
  const refused = await h.startAndFinish("group-i-11");
  assert.equal(refused.status, 429);
  assert.equal(refused.body.code, "SOCMINT_GLOBAL_QUOTA_EXHAUSTED");
  assert.ok(h.shared.SOCMINT_GLOBAL_DAILY_LIMIT * 12 <= 200, "a full day of runs must fit the interactive reserve");
});

test("yesterday's count does not carry over", async () => {
  const h = await harness();
  await h.storage.put("social-usage:group-i-1", { day: "2000-01-01", count: 99 });
  await h.storage.put("social-usage-global", { day: "2000-01-01", count: 99 });
  assert.equal((await h.startAndFinish("group-i-1")).status, 200);
  assert.equal((await h.storage.get("social-usage:group-i-1")).count, 1);
});

test("an account runs one investigation at a time, and a dead run's lock expires", async () => {
  const h = await harness();
  const first = await h.call("/social-acquire", { username: "group-i-1" });
  assert.equal(first.status, 200);
  const second = await h.call("/social-acquire", { username: "group-i-1" });
  assert.equal(second.status, 429);
  assert.equal(second.body.code, "SOCMINT_ACTIVE_RUN_QUOTA");
  assert.ok(second.body.retry_after_seconds > 0);
  assert.equal((await h.storage.get("social-usage:group-i-1")).count, 1, "a refused run is not counted");

  await h.call("/social-release", { username: "group-i-1", run_id: "someone-else" });
  assert.equal((await h.call("/social-acquire", { username: "group-i-1" })).status, 429, "only the run itself releases the lock");

  await h.call("/social-release", { username: "group-i-1", run_id: first.body.run_id });
  assert.equal((await h.storage.get("social-active:group-i-1")), undefined);

  await h.storage.put("social-active:group-i-2", { run_id: "dead", started_at: Date.now() - h.shared.SOCMINT_RUN_LOCK_MS - 1 });
  assert.equal((await h.call("/social-acquire", { username: "group-i-2" })).status, 200);
});

test("admin is exempt from the limits but is still logged", async () => {
  const h = await harness();
  for (let i = 0; i < 12; i++) assert.equal((await h.call("/social-acquire", { username: "admin", details: { target: "x" } })).status, 200);
  assert.equal([...h.storage.values.keys()].filter(key => key.startsWith("usage-log:") && key.includes(":social:")).length, 12);
});

test("a run is on record from the start and gains its outcome at the end", async () => {
  const h = await harness();
  const run = await h.call("/social-acquire", { username: "group-i-1", details: { target: "Example Person", usernames: ["@handle"], mode: "discover", password: "not logged" } });
  const history = () => h.call("/usage-history", { username: "admin", target_username: "group-i-1", metric: "all", period: "today" });
  let [row] = (await history()).body.rows;
  assert.equal(row.feature, "social");
  assert.equal(row.target, "Example Person");
  assert.equal(row.password, undefined);
  assert.equal(row.outcome, undefined);
  await h.call("/social-release", { username: "group-i-1", run_id: run.body.run_id, log_update: { id: run.body.log_id, outcome: "generated", title: "Assessment", discovery_mode: "adk_agent", target: "rewritten" } });
  [row] = (await history()).body.rows;
  assert.equal(row.outcome, "generated");
  assert.equal(row.title, "Assessment");
  assert.equal(row.discovery_mode, "adk_agent");
  assert.equal(row.target, "Example Person", "only the outcome fields can change");
});

test("reports are added inside the gate: newest first, history kept, 50 at most", async () => {
  const h = await harness();
  const report = id => ({ id, generated_at: new Date().toISOString(), title: id, version: "socmint-test" });
  for (let i = 0; i < 52; i++) assert.equal((await h.call("/social-report-add", { username: "group-i-1", report: report("r" + i) })).status, 200);
  const { workspace } = (await h.call("/social-workspace-get", { username: "group-i-1" })).body;
  assert.equal(workspace.reports.length, 50);
  assert.equal(workspace.reports[0].id, "r51");
  assert.equal(workspace.version, "socmint-test");
  assert.equal((await h.call("/social-report-add", { username: "group-i-1" })).status, 400);
});

test("a workspace that cannot be read is never overwritten by a new report", async () => {
  const h = await harness();
  await h.storage.put("social-workspace:group-i-1", { format: "social-chunks-v1", chunks: 2 });
  await assert.rejects(h.call("/social-report-add", { username: "group-i-1", report: { id: "new" } }), /incomplete/);
  assert.deepEqual(await h.storage.get("social-workspace:group-i-1"), { format: "social-chunks-v1", chunks: 2 });
});
