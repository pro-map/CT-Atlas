"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const sharedPath = path.join(__dirname, "../cloudflare-worker/shared.js");
const gatePath = path.join(__dirname, "../cloudflare-worker/report-gate.js");
let gateModulePromise;

function loadGateModules() {
  if (!gateModulePromise) {
    const sharedSource = fs.readFileSync(sharedPath, "utf8");
    const gateSource = fs.readFileSync(gatePath, "utf8");
    const sharedUrl = "data:text/javascript;base64," + Buffer.from(sharedSource).toString("base64");
    const anchor = 'from"./shared.js";';
    assert.ok(gateSource.includes(anchor));
    const linkedGate = gateSource.replace(anchor, 'from"' + sharedUrl + '";');
    const gateUrl = "data:text/javascript;base64," + Buffer.from(linkedGate).toString("base64");
    gateModulePromise = Promise.all([import(sharedUrl), import(gateUrl)]);
  }
  return gateModulePromise;
}

class MemoryStorage {
  constructor() { this.values = new Map(); }
  async get(key) {
    if (Array.isArray(key)) {
      return new Map(key.filter(item => this.values.has(item)).map(item => [item, this.values.get(item)]));
    }
    return this.values.get(key);
  }
  async put(key, value) {
    if (key && typeof key === "object" && !Array.isArray(key)) {
      for (const [item, itemValue] of Object.entries(key)) this.values.set(item, itemValue);
      return;
    }
    this.values.set(key, value);
  }
}

const USERS = {
  "group-s-2": "a".repeat(64),
  "group-p-9": "b".repeat(64)
};

test("admin usage returns current per-user counters and leaves out the counters of retired tools in every period", async () => {
  const [{ parisDayKey }, { ReportGate }] = await loadGateModules();
  const gate = new ReportGate({ storage: new MemoryStorage() }, { AUTH_USERS_JSON: JSON.stringify(USERS) });
  const metrics = {
    report_generator_requests: 3,
    deep_search_requests: 2,
    quick_ask_requests: 4,
    blockchain_searches: 5
  };
  const retired = { social_intel_requests: 6, facial_extractions: 7, facial_searches: 8, darkweb_searches: 9 };
  await gate.incrementUsage("group-s-2", metrics);
  // Existing data may include retired counters. They must never reappear.
  for (const key of [`usage-total:group-s-2`, `usage-day:${parisDayKey()}:group-s-2`]) {
    const legacy = await gate.state.storage.get(key);
    await gate.state.storage.put(key, { ...legacy, ...retired });
  }
  await gate.incrementUsage("group-p-9", { social_intel_requests: 1, facial_searches: 1, darkweb_searches: 1 });

  const allTime = await gate.usageStats("all");
  const row = allTime.users.find(item => item.username === "group-s-2");
  assert.equal(row.display_name, "Sebastien Breuil");
  for (const [metric, count] of Object.entries(metrics)) assert.equal(row[metric], count, metric);
  for (const [metric, count] of Object.entries(metrics)) assert.equal(allTime.summary[metric], count, metric);
  for (const metric of Object.keys(retired)) {
    assert.ok(!Object.hasOwn(row, metric), metric);
    assert.ok(!Object.hasOwn(allTime.summary, metric), metric);
  }
  assert.equal(allTime.summary.active_users, 1, "use of a retired tool does not create activity");

  const daily = await gate.usageStats("today");
  const dailyRow = daily.users.find(item => item.username === "group-s-2");
  for (const [metric, count] of Object.entries(metrics)) assert.equal(dailyRow[metric], count, metric);
  for (const metric of Object.keys(retired)) {
    assert.ok(!Object.hasOwn(dailyRow, metric), metric);
    assert.ok(!Object.hasOwn(daily.summary, metric), metric);
  }
  assert.equal((await gate.state.storage.get("usage-total:group-s-2")).facial_searches, 8, "reporting less never changes what is stored");
  assert.equal(allTime.users.find(item => item.username === "group-p-9").display_name, "MTS");
  assert.equal(parisDayKey(), parisDayKey(Date.now()));
});

test("retired counters and actions are refused without touching what is stored", async () => {
  const [{}, { ReportGate }] = await loadGateModules();
  const gate = new ReportGate({ storage: new MemoryStorage() }, { AUTH_USERS_JSON: JSON.stringify(USERS) });
  const call = (path, body) => gate.fetch(new Request("https://gate.internal" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }));
  await gate.state.storage.put("usage-total:group-s-2", { username: "group-s-2", facial_searches: 4 });
  assert.equal((await call("/usage-increment", { username: "group-s-2", metrics: { facial_searches: 1 } })).status, 200);
  for (const action of ["facial_search", "darkweb_search"]) {
    assert.equal((await call("/usage-record", { username: "group-s-2", action })).status, 400, action);
  }
  assert.equal((await gate.state.storage.get("usage-total:group-s-2")).facial_searches, 4);
});

