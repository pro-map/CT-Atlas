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

test("admin usage returns current per-user counters and excludes legacy Social counts in every period", async () => {
  const [{ parisDayKey }, { ReportGate }] = await loadGateModules();
  const gate = new ReportGate({ storage: new MemoryStorage() }, { AUTH_USERS_JSON: JSON.stringify(USERS) });
  const metrics = {
    report_generator_requests: 3,
    deep_search_requests: 2,
    quick_ask_requests: 4,
    blockchain_searches: 5,
    facial_extractions: 7,
    facial_searches: 8
  };
  await gate.incrementUsage("group-s-2", metrics);
  // Existing data may include the retired counter. It must never reappear.
  for (const key of [`usage-total:group-s-2`, `usage-day:${parisDayKey()}:group-s-2`]) {
    const legacy = await gate.state.storage.get(key);
    await gate.state.storage.put(key, { ...legacy, social_intel_requests: 6 });
  }
  await gate.incrementUsage("group-p-9", { social_intel_requests: 1 });

  const allTime = await gate.usageStats("all");
  const row = allTime.users.find(item => item.username === "group-s-2");
  assert.equal(row.display_name, "Sebastien Breuil");
  for (const [metric, count] of Object.entries(metrics)) assert.equal(row[metric], count, metric);
  for (const [metric, count] of Object.entries(metrics)) assert.equal(allTime.summary[metric], count, metric);
  assert.ok(!Object.hasOwn(row, "social_intel_requests"));
  assert.ok(!Object.hasOwn(allTime.summary, "social_intel_requests"));
  assert.equal(allTime.summary.active_users, 1, "Social-only requests do not create activity");

  const daily = await gate.usageStats("today");
  const dailyRow = daily.users.find(item => item.username === "group-s-2");
  for (const [metric, count] of Object.entries(metrics)) assert.equal(dailyRow[metric], count, metric);
  assert.ok(!Object.hasOwn(dailyRow, "social_intel_requests"));
  assert.ok(!Object.hasOwn(daily.summary, "social_intel_requests"));
  assert.equal(allTime.users.find(item => item.username === "group-p-9").display_name, "MTS");
  assert.equal(parisDayKey(), parisDayKey(Date.now()));
});

test("the facial search usage action increments its per-user counter", async () => {
  const [{}, { ReportGate }] = await loadGateModules();
  const gate = new ReportGate({ storage: new MemoryStorage() }, { AUTH_USERS_JSON: JSON.stringify(USERS) });
  const response = await gate.fetch(new Request("https://gate.internal/usage-record", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "group-s-2", action: "facial_search" })
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  const stats = await gate.usageStats("all");
  assert.equal(stats.users.find(item => item.username === "group-s-2").facial_searches, 1);
});

