# Rules for agents working on CT Atlas

Several agents push to this repository (a Claude cloud session, ChatGPT/Codex, local
Claude sessions) and GitHub Actions commits data twice a day. Before any task, run
`git fetch` and compare your branch with `origin/main`.

## The database: events.json and data/events/

GitHub refuses files over 100 MiB, and `events.json` would cross that line in January
2027. The database is therefore moving into one file per month under `data/events/`.
[docs/STORAGE_MIGRATION.md](docs/STORAGE_MIGRATION.md) has the plan and the dates.

`python3 events_store.py check` (on Windows `py -3.12 events_store.py check`) prints the
mode main is in:

| Mode | Since | What is committed | Source of truth |
| --- | --- | --- | --- |
| legacy | today | `events.json` | `events.json` |
| dual | the "expand" commit | `events.json` and `data/events/` | `events.json` |
| store | the "contract" commit | `data/events/` only | `data/events/` |

What does not change in any mode: https://ct-atlas.com/events.json, `events-lite.json`,
`events-map.json` and `publication-manifest.json` keep the same URLs and bytes, on the
site and the mirror; the format of `events.json` (indent 2, raw UTF-8, final newline,
same key order); and every tool that reads or writes `events.json` works on the local copy.

### Rules

1. After every clone or pull, run `python3 events_store.py materialize`
   (`py -3.12 events_store.py materialize` on Windows). In store mode it writes
   `events.json`; before that it checks it. Tests and tools stop with
   "events.json is not materialized" if you skip it; they never start from an empty database.
2. To change data:
   - edit `events.json` with the existing tools;
   - run `python3 events_store.py stage` instead of `git add events.json`;
   - commit exactly what it staged.

   Never `git add -f events.json` once the store is the database, never hand-edit
   `data/events/*`, and never write the month files with your own script. If `stage` says
   your copy is stale, save your edits, pull, run `materialize`, and apply them again.
3. Never `git revert` the expand or contract commits, and never revert `events_store.py`
   or the workflow changes that use it. A rollback is a forward commit made only by
   `.github/workflows/migrate-events-store.yml`, which the owner dispatches.
4. Do not push anything touching `events.json` or `data/events/` during a freeze window
   the owner announces around a migration.
5. History:
   - `git log -- events.json data/events` lists every database commit;
   - `python3 events_store.py build --ref <sha> --stdout` rebuilds `events.json` as it
     was at any commit, before or after the move;
   - one record's history: `git log -S '"id":"<id>"' -- data/events`.
6. "Month files" (`data/events/*.jsonl`) are not the mirror's byte chunks
   (`_events/*-shards.json`). Do not confuse them.
7. From the contract commit on, `raw.githubusercontent.com/pro-map/CT-Atlas/main/events.json`
   returns 404. Use https://ct-atlas.com/events.json instead.
8. Data workflows push through `tools/push_data_commit.sh`, which runs
   `events_store.py check` after its rebase, and hold the `ct-map-update-main` lock.

If something does not work, stop and tell the owner rather than working around it.
