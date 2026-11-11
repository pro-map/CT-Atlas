"use strict";
// The real events.json, for the Node tests that read it. Once the database is committed
// as data/events/ (docs/STORAGE_MIGRATION.md), events.json exists only after
// `python3 events_store.py materialize`: say so, rather than fail on ENOENT.
const fs = require("fs");
const path = require("path");

const DATABASE = path.resolve(__dirname, "..", "..", "events.json");

function realDatabasePath() {
  if (!fs.existsSync(DATABASE)) {
    throw new Error("events.json is not materialized: run `python3 events_store.py materialize` " +
      "(on Windows `py -3.12 events_store.py materialize`) before the Node suite.");
  }
  return DATABASE;
}

module.exports = { realDatabasePath };
