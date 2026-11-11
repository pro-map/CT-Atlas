"use strict";

// The daily quiz was removed on 2026-11-11 and the owner had its stored answers
// erased. The gate does it once, on the first call of /retired-quiz-purge.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function loadGate() {
  const sharedSource = fs.readFileSync(path.join(__dirname, "../cloudflare-worker/shared.js"), "utf8");
  const gateSource = fs.readFileSync(path.join(__dirname, "../cloudflare-worker/report-gate.js"), "utf8");
  const sharedUrl = "data:text/javascript;base64," + Buffer.from(sharedSource).toString("base64");
  const anchor = 'from"./shared.js";';
  assert.ok(gateSource.includes(anchor));
  const linked = gateSource.replace(anchor, 'from"' + sharedUrl + '";');
  return import("data:text/javascript;base64," + Buffer.from(linked).toString("base64"));
}

// Enough of the Durable Object storage API: sorted list with prefix/limit/startAfter,
// and put/delete of up to 128 keys at once, as Cloudflare enforces.
class MemoryStorage {
  constructor(entries) { this.values = new Map(entries); this.calls = []; }
  async get(key) { return this.values.get(key); }
  async put(key, value) {
    if (key && typeof key === "object") {
      assert.ok(Object.keys(key).length <= 128, "at most 128 keys per put");
      for (const [item, itemValue] of Object.entries(key)) this.values.set(item, itemValue);
    } else this.values.set(key, value);
  }
  async delete(keys) {
    assert.ok(Array.isArray(keys) && keys.length <= 128, "at most 128 keys per delete");
    let deleted = 0;
    for (const key of keys) if (this.values.delete(key)) deleted++;
    return deleted;
  }
  async list({ prefix = "", limit = Infinity, startAfter = "" } = {}) {
    this.calls.push(prefix);
    const keys = [...this.values.keys()].filter(key => key.startsWith(prefix) && key > startAfter).sort().slice(0, limit);
    return new Map(keys.map(key => [key, this.values.get(key)]));
  }
}

function seed() {
  const entries = [
    ["session:abc", { username: "group-s-2" }],
    ["usage-log:2026-10-01:group-s-2:x", { feature: "searches" }],
    ["usage-total:group-p-9", { username: "group-p-9", logins: 3 }],
  ];
  for (let i = 0; i < 300; i++) {
    entries.push([`quiz-answer:2026-10-${String(1 + (i % 28)).padStart(2, "0")}:user-${i}`, { correct: true, question: "q" }]);
  }
  for (let i = 0; i < 700; i++) {
    entries.push([`usage-day:2026-10-${String(1 + (i % 28)).padStart(2, "0")}:user-${i}`,
      { username: `user-${i}`, logins: 1, quiz_answers: 2, quiz_correct: 1, quiz_incorrect: 1 }]);
  }
  entries.push(["usage-total:group-s-2", { username: "group-s-2", searches: 5, quiz_answers: 4, quiz_correct: 4 }]);
  return entries;
}

test("the first request erases every quiz answer and quiz counter, and nothing else", async () => {
  const { ReportGate } = await loadGate();
  const storage = new MemoryStorage(seed());
  const gate = new ReportGate({ storage }, {});
  const response = await gate.fetch(new Request("https://gate.internal/retired-quiz-purge", { method: "POST", body: "{}" }));
  const result = await response.json();

  assert.equal(result.done, true);
  assert.equal(result.answers_deleted, 300);
  assert.equal(result.usage_rows_cleared, 701);
  assert.equal([...storage.values.keys()].filter(key => key.startsWith("quiz-answer:")).length, 0);
  for (const [key, value] of storage.values) {
    if (value && typeof value === "object") {
      for (const counter of ["quiz_answers", "quiz_correct", "quiz_incorrect"]) assert.ok(!(counter in value), key);
    }
  }
  // Everything else is untouched.
  assert.deepEqual(storage.values.get("session:abc"), { username: "group-s-2" });
  assert.deepEqual(storage.values.get("usage-log:2026-10-01:group-s-2:x"), { feature: "searches" });
  assert.deepEqual(storage.values.get("usage-total:group-p-9"), { username: "group-p-9", logins: 3 });
  assert.deepEqual(storage.values.get("usage-total:group-s-2"), { username: "group-s-2", searches: 5 });
  assert.equal(storage.values.get("usage-day:2026-10-01:user-0").logins, 1);
});

test("the purge runs once: later requests and a new isolate only read the marker", async () => {
  const { ReportGate } = await loadGate();
  const storage = new MemoryStorage(seed());
  await new ReportGate({ storage }, {}).purgeRetiredQuiz();
  storage.values.set("quiz-answer:2026-12-01:late", { correct: true });
  storage.calls.length = 0;

  const fresh = new ReportGate({ storage }, {});
  const marker = await fresh.purgeRetiredQuiz();
  assert.equal(marker.answers_deleted, 300);
  assert.deepEqual(storage.calls, [], "no listing once the marker exists");
  assert.ok(storage.values.has("quiz-answer:2026-12-01:late"), "a finished purge never runs again");
});

test("only its own route erases: other gate routes leave the answers alone", async () => {
  const { ReportGate } = await loadGate();
  const storage = new MemoryStorage(seed());
  const gate = new ReportGate({ storage }, {});
  for (const route of ["/migration-status", "/usage-stats", "/session-get"]) {
    await gate.fetch(new Request("https://gate.internal" + route, { method: "POST", body: "{}" })).catch(() => {});
  }
  assert.equal([...storage.values.keys()].filter(key => key.startsWith("quiz-answer:")).length, 300);
  assert.ok(!storage.values.has("__retired_quiz_purge"));
});

test("one public GET route runs it and shows what was done; /health stays untouched", () => {
  const worker = fs.readFileSync(path.join(__dirname, "../cloudflare-worker/index.js"), "utf8");
  assert.match(worker, /if \(url\.pathname === "\/retired-quiz-purge" && request\.method === "GET"\) \{\nconst purge = await gateCall\(env, "\/retired-quiz-purge", \{\}\)/);
  const health = worker.slice(worker.indexOf('if (url.pathname === "/health"'), worker.indexOf('if (url.pathname === "/health/status"'));
  assert.ok(!/quiz/i.test(health), "/health keeps its single gate read");
});
