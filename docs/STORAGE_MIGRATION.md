# Storage migration: events.json to monthly files

The plan the owner approved on 2026-11-07 for moving the map database out of a single
`events.json`, with its status. The rules agents follow are in [AGENTS.md](../AGENTS.md).

## Status

| Phase | What | When | State |
| --- | --- | --- | --- |
| 0 | Hardening: shared push script, fail-closed readers, staged size checks, mirror rehearsal over 25 MiB | by 2026-11-11 | merged 2026-11-07 (222772c) |
| 1 | Store code and workflow glue, legacy mode: `events_store.py`, materialize/stage/check in every job, the migration workflow, the guard test, AGENTS.md | by 2026-11-14 | this change |
| 2 | Expand: the owner dispatches `migrate-events-store.yml` (direction `expand`), then at least 5 days of dual-write | about 2026-11-17 | not started |
| 3 | Contract: stop tracking `events.json` | 2026-11-24 to 26, at the latest 2026-12-08 | not started |
| 4 | Watch 2 weeks, then remove the legacy and dual code | after 2027-01-15 | not started |

Measured on 2026-11-11: `events.json` is 50,080,729 bytes (47.8 MiB), 7,232 events, growing
about 0.73 MB a day. GitHub warns at 50 MiB (about 2026-11-13, a warning only), the
project's size check warns at 80 MiB (about 2026-12-24) and GitHub refuses the push at
100 MiB (about 2027-01-20), after which the daily collection can no longer publish. Split
by month the same data is 7 files, the largest 22.6 MiB (2026-10), plus a 24 KB
`meta.json`; the real file rebuilds byte for byte.

## Why

- `events.json` keeps every event of the last 180 days with its related articles, and it
  has no plateau before about April 2027.
- `events-lite.json` and `events-map.json` (about 13-14 MB) reach the mirror's 25 MiB
  per-file cap around the end of December; the chunked path that serves them was
  rehearsed end to end in phase 0.
- Status-only commits (47 of 109 in 14 days) each rewrite the whole 45+ MB file.

## The decision

Three designs were compared on five criteria (data safety and verifiable migration;
beating both deadlines with margin and lasting years; compatibility; simplicity and
number of writers changed; cutover and rollback risk), each scored 1 to 5:

- A, a monthly store in git with `events.json` rebuilt after checkout: 4, 5, 4, 3, 4 = 20/25.
- B, a sidecar codec for the 31 fields `events-lite.json` leaves out: 3, 3, 3, 2, 3 = 14/25.
- C, Cloudflare D1 as the source of truth: 3, 3, 3, 1, 2 = 12/25.

**Design A, with grafts from B and C:**

1. An expand/contract sequence instead of a single cutover commit:
   - "expand" adds `data/events/` while `events.json` stays tracked and authoritative;
   - at least 5 days of real dual-write follow;
   - "contract" then only flips one authority field and untracks `events.json`.
2. `meta.json` records `events_sha256`, the sha256 of the canonical rebuilt
   `events.json` (from C). It is checked on every materialize, and it is the line every
   store commit changes, so concurrent store commits always conflict and a bad
   `git revert` fails closed.
3. From B: an independent record-by-record verifier that does not import
   `events_store`; a publication dry run comparing the manifests built from the old bytes
   and from the store; a 90-day artifact of the bytes before each migration; a static
   guard test over every workflow and tool; the end-to-end rehearsal of the derived-file
   chunk path (done in phase 0).
4. From C: a CI guard that refuses a re-tracked `events.json` once the store is
   authoritative; one shared push script with 5 tries, sleeps and the store check after
   each rebase (phase 0 plus this change); fail-closed guards wherever a missing
   `events.json` used to read as an empty database.
5. Rollback is always a forward commit made by `migrate-events-store.yml`, never
   `git revert`.

The month files are called "month files" in code and docs, so they are not confused with
the mirror's `<stem>-shards.json` byte chunks.

Why A wins: zero writer logic changes; the published bytes and URLs are identical; a
missing materialize fails loudly instead of giving silently wrong data; the largest
committed file drops from one file growing to about 150 MiB to one month of about
22-23 MiB at today's rate; retention bounds the store to 7-8 files; status-only commits
shrink from 44 MB to about 21 KB.

What the review found wrong or weak in each design, and how the plan answers it:

- A as first proposed: a single revertible cutover commit is dangerous (a plain
  `git revert` after later data commits deletes the store and silently brings back an old
  `events.json`), hence expand/contract, forward-only rollbacks and the `events_sha256`
  anchor. Its verify job compared with the live site, which can lag HEAD; the comparator is
  now a manifest built from the bytes before the migration. Two concurrent commits could
  auto-merge `meta.json` into a mixed status; `events_sha256` makes them always conflict.
  Its shadow round trip never exercised fresh checkouts, Git's line-ending rules or real
  rebases; the dual-write period does. A test helper that materializes on its own could
  overwrite an agent's edits; workflows materialize explicitly, tests fail with a clear
  message instead.
- B: any reader that bypassed the codec would silently get slim records (other agents,
  inline workflow Python, the real-file tests); the slim file plateaus at 44-48 MiB, at
  GitHub's warning forever; about 17 modules change their I/O; a multi-file crash protocol
  is new code on the critical path; reverting the code while the data is split corrupts
  silently.
- C: every data write would depend on the Cloudflare REST API and a new token; D1 batch
  atomicity over REST is undocumented; D1 Free limits stop all queries until 00:00 UTC and
  are shared with the background corpus and Deep Search; Git stops being the per-push
  history; agents could no longer commit data; no relief before the cutover; the most work.

Facts checked on 2026-11-07 (origin/main c23dc9d): `events.json` was 45,860,278 bytes,
6,652 events, 34 top-level keys with `events` at index 32 and `geolocation` after it,
canonical (indent 2, `ensure_ascii=False`, final newline), no NaN or Infinity. Split by the
first 7 characters of `published` into compact JSON Lines and rebuilt, the bytes were
identical; the months were contiguous and newest first; no raw CR, LF or U+2028 inside a
line; the longest line was 119,572 bytes. Every commit changes `collection_status`, so in
design A `meta.json` changes in every commit.

## A. Store format: `ct-atlas-events-store/1`

`data/events/YYYY-MM.jsonl`:

- One event per line: `json.dumps(event, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n"`.
- The writer's key order and the database order (published, newest first) are kept.
- Month = `published[:7]`. Records without a usable date go to `undated.jsonl`, placed last.
- Files are read and written as bytes and split on `b"\n"` only, never `splitlines()`.

`data/events/meta.json`, canonical indent 2 plus a final newline, holds `format`,
`partition: "month"`, `authority` (`"events.json"` or `"store"`), `events_sha256`,
`top_level_keys` (all of them, in order), `months` (`{YYYY-MM: {events, bytes, sha256}}`)
and `metadata` (every key but `events`, verbatim and in order).

Rebuild = concatenate the months in order, put the list back at its key index, check
every seal, `number_of_events` and `events_sha256`, then write
`json.dumps(indent=2, ensure_ascii=False) + "\n"`.

Ignored files: `events.json.store-base`, a sidecar holding `{meta_sha256, events_sha256}`,
the store a local `events.json` was built from (ignored from phase 1 on); `events.json`
itself, ignored only from the contract commit on.

`.gitattributes`: `data/events/** text eol=lf`.

## B. `events_store.py` (repository root, standard library only)

Atomic writes everywhere (temporary file, fsync, `os.replace`). The mode comes from
`data/events/meta.json` at HEAD:

- **legacy**: no `meta.json`;
- **dual**: authority `"events.json"`, and `events.json` is tracked;
- **store**: authority `"store"`, and `events.json` is untracked.

| Command | Does |
| --- | --- |
| `materialize [--force]` | legacy: requires `events.json` to exist and parse. dual: rebuilds from the store and requires the bytes to equal `events.json`; on a mismatch exits 1 and points to `stage` or `reconcile`. store: verifies every seal, unique non-empty ids, month placement and order, `number_of_events` and `events_sha256`, then writes `events.json` and the sidecar. Never writes an empty database; leaves an identical file untouched; refuses to overwrite a local `events.json` that differs from its sidecar unless `--force`. |
| `stage` | Replaces every `git add events.json`. Validates `events.json` (an events list of objects, unique non-empty ids, `number_of_events` equal to the count, no NaN); in store mode refuses a stale sidecar or a tracked `events.json`; refuses a shrink below 0.9 x HEAD's count unless `ALLOW_SHRINK=1`; writes the changed month files only, deletes months that aged out, writes `meta.json` last; rebuilds from disk and requires the bytes to equal the canonical `events.json` (a non-canonical one is rewritten); a record out of month order is moved next to its month with a warning. Stages `data/events` (dual and store) and `events.json` (legacy and dual). In legacy mode it also runs a shadow round trip in memory and reports `shadow round trip OK` as a notice, or a warning. |
| `check [--ref REF]` | The materialize validation against a commit or tree, writing nothing. In dual mode also requires `HEAD:events.json` to equal the rebuild; in store mode refuses a tracked `events.json`. Runs after every rebase (push script) and in Python CI. |
| `build --ref REF --out FILE \| --stdout` | `events.json` at any commit, from either layout. |
| `verify --against FILE [--receipt FILE]` | Same id sequence, the compact bytes of each record, metadata deep-equal with key order; writes a JSON receipt. |
| `reconcile --prefer events.json\|store` | Prints the per-record differences, then rewrites the other side. |
| `reseal` | Recomputes the seals from the month files, after a check by hand only. |
| `migrate expand\|contract\|uncontract\|collapse [--dry-run]` | The migrations, staged and never committed (the workflow commits). |

`require_materialized()` raises when `meta.json` exists and `events.json` is missing;
`collector.load_database_strict` and `tools/recover_from_history.py` call it.
`restore()`, `committed_bytes()` and `build_ref()` give `tools/finalize_daily_status.py`
and `tools/recover_from_history.py` the committed database in every layout.

## C. Phases

Dates are projections from the 2026-11-07 measurements.

**Phase 0** (merged 2026-11-07, 222772c): `cleanup_existing_events.py` writes atomically
and sets `number_of_events`; fail-closed guards on a missing database (collector, the
update-map prepare step, `sync_background_corpus`, `enrich_radnuc_background`);
`tools/push_data_commit.sh` (fetch, rebase, validation, push; 5 tries, sleeps of 4, 8, 12
and 16 s; a conflict aborts the rebase and exits 1) in every data workflow;
`check_committed_sizes.py` measures staged blobs; the end-to-end mirror rehearsal with
derived files over 25 MiB. Exit check: pytest and the Node suite green; two update-map
runs and one refresh run succeed with the new push script; the rehearsal test green.

**Phase 1** (this change): store code and workflow glue in legacy mode. `meta.json` does
not exist yet, so the behaviour is the same as before, except that `stage` validates
`events.json` before every data commit and reports a shadow round trip. Exit check:
- CI is green;
- for at least 2 days, every writer that ran (update-map twice a day, consolidate,
  refresh, and repair or reconcile if triggered) logged "shadow round trip OK" with no
  warning (the annotation is public on each run);
- the guard test proves that every reader job materializes first.

**Phase 2**, expand plus dual-write. The owner dispatches about 2026-11-17, and
dual-write runs at least 5 days. `migrate-events-store.yml` with `direction=expand`:
1. checks out main with its history and requires HEAD to be the newest main, and
   `check` to pass;
2. records S0 = sha256 of `events.json` and keeps its bytes as a 90-day artifact;
3. splits into `data/events` with `authority: "events.json"` and stages it;
4. checks the staged tree, requires it to rebuild S0 byte for byte, runs the independent
   verifier and the publication dry run;
5. commits "Add the monthly database store next to events.json (sha256 S0, N events)"
   and pushes through `push_data_commit.sh` (a dry run stops before the push);
6. a fresh-runner verify job materializes the pushed commit, requires S0, and rebuilds the
   publication manifest to compare with the dry run.

From then on every data commit stages both `events.json` and the month files, and every
job's materialize rebuilds and compares. Exit check:
- at least 5 days and at least 10 data commits, with `check` green on each;
- zero mismatch errors;
- each writer type has committed at least once;
- one consolidation that removed records;
- one status-only refresh, which must change only `meta.json` and `events.json`;
- every deploy verify, the mirror run and live-smoke are green;
- the contract dry-run artifact has been reviewed.

**Phase 3**, contract. Target 2026-11-24 to 26; latest 2026-12-08 (one week before the
earliest 80 MiB warning, about 4 weeks before the earliest 100 MiB block, and leaving the
uncontract rollback open for 4 to 6 weeks). The sequence is in section D. Exit check:
- the next 2 update-map runs commit only `data/events`, the status, the cache and the queue;
- refresh commits only `meta.json`;
- consolidate commits month files plus `meta.json`;
- deploy verify, the mirror run and live-smoke are green;
- the Pages manifest `record_count` equals the previous count plus that day's additions;
- the largest committed file is under 25 MiB.

**Phase 4**: watch for 2 weeks, then after 2027-01-15 (owner's decision) remove the legacy
and dual branches from `events_store.py` and the workflows, and remove `events.json` from
the mirror push paths. Keep `build --ref`'s fallback for old commits.

If dual-write is not green by 2026-12-08: fix and keep going. Contract stays the only
exit; its hard limit is about 2027-01-03. There is no format stopgap: compact JSON alone
only reaches 100 MiB around 2027-01-27 and would change every writer's bytes.

## D. Contract sequence

T-2 days: the owner sends the agent message (below) and announces a freeze window from
T-1 h to T+3 h: no human or agent pushes touching `events.json` or `data/events`.

1. Dispatch `migrate-events-store.yml` with `direction=contract` and `dry_run=true`. The
   workflow is in the `ct-map-update-main` lock (queue: max, cancel-in-progress: false),
   runs in the protected environment `data-migration` that requires the owner's approval,
   and a real run needs `confirm` to repeat the direction. Review the receipts artifact.
2. Dispatch with `dry_run=false` and `confirm=contract`. The job:
   1. checks out main with its history, requires HEAD to be the newest main, dual mode
      and `check` green; records S0, N, the id sequence hash and the size;
   2. rebuilds from HEAD's store and requires the bytes to equal `HEAD:events.json`;
   3. runs `verify` record by record (same id sequence, compact bytes of every record,
      metadata deep-equal with key order, the top-level keys in order,
      `number_of_events == N`);
   4. runs the independent verifier: for every id the sha256 of the record with sorted
      keys is the same on both sides; the ids, counts and order are equal; every record
      sits in its month file; the seals recompute; a digest over the sorted
      "id, sha" lines goes into the receipt;
   5. publication dry run: builds `events-lite.json`, `events-map.json` and the manifest
      from S0 and from the migrated tree; `sha256_bytes`, `sha256_canonical_json` and
      `record_count` must be identical for all 3 files;
   6. uploads S0's bytes as an artifact kept 90 days;
   7. writes `archive/events-store-contract-YYYYMMDD.json`: S0, N, the id digest, the
      per-month seals, the tool version, the source commit;
   8. sets `authority: "store"`, runs `git rm --cached events.json`, and adds
      `/events.json` to `.gitignore` (`events.json.store-base` is already there);
   9. runs `check_committed_sizes`;
   10. commits "Stop tracking events.json: database in data/events (sha256 S0, N events)";
   11. pushes through `push_data_commit.sh`, whose `events_store.py check` accepts the
       store layout.
3. The verify job on a fresh runner, at the pushed commit, depth 1: materialize, require
   sha256 == S0, run `check`; build the published files without deploying and require
   their manifest to equal the dry run's. The live site is not the comparator.
4. No deploy is needed, because the data is unchanged. The next scheduled update-map
   publishes as usual. Watch it, the mirror run and live-smoke.

## E. Rollback

Always a forward commit made by the workflow; never `git revert` of the expand or
contract commits.

- **R0, during dual-write**: `direction=collapse` removes `data/events`. The verification
  requires `events.json` to be unchanged by that commit. The code falls back to legacy
  mode automatically.
- **R1, after contract**: `direction=uncontract` builds `events.json` from HEAD's store,
  verifies it record by record, `git add -f events.json`, sets `authority: "events.json"`
  and removes the `.gitignore` lines, then commits. The verification requires the new
  `events.json` to equal `build --ref` of the commit before. Dual-write resumes,
  consistent immediately. This works only while the rebuilt file stays under about
  95 MiB, so until about 2027-01-05 at the 14-day rate; after that the only option is to
  fix forward.
- **R2, code rollback**: never revert the `events_store.py` or workflow code while
  authority is `"store"`; run R1 first. If someone reverts anyway: the old code finds no
  `events.json`, and the snapshot step and the guards fail closed; a reverted contract
  commit stops on a `meta.json` conflict, or, forced through, leaves HEAD inconsistent
  (`events_sha256` differs) and materialize and `check` refuse it. Recovery is uncontract
  or reconcile. No data is lost.
- **R3, disaster**: history before the expand commit is never rewritten. The S0 artifact
  is kept 90 days. Every later state comes back with `build --ref <sha>`.

## F. Tests

- `tests/events_store_test.py`: byte round trips on awkward records (Unicode, U+2028 and
  U+2029, CR inside strings, `1e-05` and `1.0`, varying key orders, the undated month, a
  month that ages out); the real file; determinism and no rewrite of unchanged files; seal
  tampering (bytes, CRLF, count, `events_sha256`, key order); duplicate ids across files,
  a missing month, a record in the wrong month, out-of-order records, NaN; a stale sidecar;
  local edits protected; `require_materialized` and the collector; the shrink gate; the
  three modes and a dual-mode mismatch; expand, contract, uncontract and collapse in a
  temporary Git repository; a `git revert` of the contract that conflicts, and one forced
  through, both refused with nothing lost; two clones whose store commits conflict;
  `build --ref` across the layouts; the byte pin between `events_store`,
  `collector.atomic_json_write` and `finalize_daily_status.atomic_write`.
- `tests/events_store_workflow_guard_test.py` (static): every job that reads
  `events.json` materializes first (the composite and `deploy_mirror.sh` do it
  themselves); no workflow runs `git add` on `events.json`; every writer stages through
  `events_store.py`, cleanup and retirement with `ALLOW_SHRINK=1`; only `events_store.py`
  reads the database from Git history; the composite strips `data/events` and the
  sidecar; the push script checks after every rebase; the migration workflow holds the
  data lock, runs only on dispatch in the `data-migration` environment, dry run by
  default, and verifies before it commits.
- `tests/push_data_commit_test.py`: in dual mode, a store commit is pushed and checked;
  two store commits never merge silently; an `events.json` committed without `stage`
  stops the next push.
- `tests/check_committed_sizes_test.py`: the 40 MiB month-file warning; `events.json`
  staged while the store is the database is an error.
- `tests/recover_from_history_test.py`: the history scan reads both layouts.
- The Node real-file tests use `tests/helpers/real-database.cjs`, which fails with
  "run python3 events_store.py materialize" when `events.json` is missing.

## G. What this does not solve (follow-ups, not blockers)

- The published `events.json` keeps growing on Pages toward about 150-161 MiB around
  2027-04/05. GitHub documents no per-file limit for Pages (checked 2026-11-07). On the
  mirror it is chunked, about 18 chunks.
- The Worker's full-file fallback and `events-lite.json` parsing approach the 128 MB
  isolate memory at the plateau (Node estimates). Keep the memory tests' budgets.
- Repository size, about 223 MiB on 2026-11-07, heads for the 1 GB recommendation around
  mid-2027, driven mostly by the AI cache history. 9 workflows still clone with
  fetch-depth 0.
- A month file reaches GitHub's 50 MiB warning at about 2.2 times today's volume. The
  40 MiB per-file warning gives notice, and `partition` in `meta.json` makes a
  half-month re-split a single verified migrate commit. Above about 2 times today's
  125-130 events a day, start with half-month files instead.

## Phase 1 implementation notes

Where this change departs from the plan's file list, and why:

- The migration workflow is in phase 1, not phase 2, so that the expand and contract
  dry runs can be reviewed before the real dispatches. A dry run does the whole migration
  on the runner, commits there and stops before the push. Every check reads the staged
  tree (`git write-tree`), and the commit must be exactly that tree.
- The update-map recovery artifact does not add `data/events/`: it is uploaded before the
  commit step stages anything, so it would only hold HEAD's month files, which Git
  already has. The artifact keeps the run's `events.json`, the work product.
- The fresh-runner verify job compares a digest of the manifest fields passed between the
  jobs, rather than downloading the dry run's artifact.
- `stage` refuses a `number_of_events` that disagrees with the count only once the store
  exists; in legacy mode it is a warning, so phase 1 cannot stop a data commit for it.

## Before phase 2 (owner)

- In GitHub, Settings > Environments > `data-migration`: add yourself as required
  reviewer. Until then the environment exists without protection and anyone who can
  dispatch workflows could run a migration.
- Read the "shadow round trip" annotations of two days of runs (phase 1 exit check).
- Dispatch `Migrate the events store` with `direction=expand` and `dry_run=true`, read the
  receipts, then dispatch `dry_run=false`, `confirm=expand`.
- Send the message below to the other agents, with the expand commit and date.

## Message to the other agents (sent at expand, repeated at contract)

> To the Claude cloud session and ChatGPT/Codex working on pro-map/CT-Atlas. Please read
> this in full before your next pull.
>
> The CT Atlas database is moving out of a single events.json, because GitHub refuses
> files over 100 MiB and events.json would cross that line in January.
>
> Step 1, from commit `<EXPAND_SHA>` (`<DATE>`): a copy of the database is also kept in
> `data/events/YYYY-MM.jsonl` (one event per line, one file per month) plus
> `data/events/meta.json`. events.json stays tracked and remains the source of truth.
>
> Step 2, from commit `<CONTRACT_SHA>` (`<DATE>`): events.json is no longer committed. The
> database in git is `data/events/`. Pulling that commit deletes your tracked events.json;
> the file is then gitignored.
>
> What does not change: https://ct-atlas.com/events.json, events-lite.json, events-map.json
> and publication-manifest.json, and the mirror, keep the same URLs and the same bytes. The
> report Worker, index.html, live-smoke and the concurrency group ct-map-update-main are
> unchanged. The format of events.json is unchanged. Every tool that reads or writes
> events.json still works on a local copy.
>
> The rules are in AGENTS.md and CLAUDE.md at the repository root: materialize after
> every pull, `events_store.py stage` instead of `git add events.json`, never revert the
> expand or contract commits, respect the freeze window `<WINDOW>`. If something does not
> work, stop and tell the owner rather than working around it.

## Owner decisions (2026-11-07)

- Design A with the grafts and the dates: approved.
- AGENTS.md and CLAUDE.md at the repository root: approved.
- Nothing outside the repository downloads `raw.githubusercontent.com/.../main/events.json`.
- Every remote branch but main was deleted (60), so no stale branch edits `events.json`.
- Still open: the protected `data-migration` environment (configured by the owner in
  GitHub settings).
- Accepted as follow-ups: the published `events.json` on Pages, the Worker's full-file
  fallback and the repository size (section G).
