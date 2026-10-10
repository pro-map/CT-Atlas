const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

// Evaluate only the pure sorting helper, not the browser-only UI handlers.
function latest(items) {
  const source = fs.readFileSync("darkweb.js", "utf8");
  const start = source.indexOf("function latestCollectedPublications(){");
  const end = source.indexOf("\nfunction renderLatestPublications(){", start);
  assert.ok(start >= 0 && end > start, "Latest-publications helper must remain discoverable");
  const archiveItems = new Map(items.map(item => [item.id, item]));
  const context = vm.createContext({ archiveItems });
  return vm.runInContext(source.slice(start, end) + "\nlatestCollectedPublications()", context);
}

test("late-arriving 8 October Al-Naba PDF stays visible on 10 October", () => {
  const rows = latest([
    { id:"oct10", publication_version:1, published_at:"2026-10-10", first_seen:"2026-10-10T07:00:00Z" },
    { id:"naba", publication_version:1, published_at:"2026-10-08", first_seen:"2026-10-10T09:40:00Z" },
    { id:"oct9", publication_version:1, published_at:"2026-10-09", first_seen:"2026-10-09T08:00:00Z" },
    { id:"generic", published_at:"2026-10-10", first_seen:"2026-10-10T11:00:00Z" }
  ]);
  assert.deepEqual(Array.from(rows, x => x.id), ["naba", "oct10", "oct9"]);
});

test("latest-publications view caps at ten and excludes undated or legacy cards", () => {
  const source = Array.from({length: 18}, (_,i) => ({
    id:"issue"+i, publication_version:1, published_at:"2026-10-08",
    first_seen:"2026-10-10T08:"+String(i).padStart(2,"0")+":00Z"
  }));
  source.push({ id:"undated", publication_version:1, first_seen:"2026-10-10T09:00:00Z" });
  assert.equal(latest(source).length, 10);
  assert.equal(latest(source)[0].id, "issue17");
});
