#!/usr/bin/env python3
"""The CT Atlas database kept as one JSON Lines file per month (docs/STORAGE_MIGRATION.md).

GitHub refuses any file over 100 MiB, and events.json would cross that line in
January 2027. So the database is also written, and later only written, as:

  data/events/YYYY-MM.jsonl  the events published that month, one compact JSON
                             record per line, in the database order (newest first).
                             Records without a usable date go to undated.jsonl, last.
  data/events/meta.json      every other top-level key of events.json, the key order,
                             a seal per month file (events, bytes, sha256) and
                             events_sha256, the sha256 of the events.json they rebuild.

events.json is rebuilt from them byte for byte. The mode comes from the
data/events/meta.json of the commit checked out (HEAD):

  legacy  no meta.json: events.json is the only database.
  dual    authority "events.json" ("expand"): events.json stays tracked and is the
          source of truth; every data commit writes the month files too.
  store   authority "store" ("contract"): events.json is no longer tracked; it is
          rebuilt after every checkout by `materialize`.

Commands (Linux: python3 events_store.py ...; Windows: py -3.12 events_store.py ...):

  materialize   After a clone or pull. Store mode: writes events.json. Dual mode:
                checks that events.json and the month files agree. Legacy: checks
                that events.json is there.
  stage         Instead of `git add events.json`: validates events.json, writes the
                month files that changed and stages what the mode needs.
  check         The committed tree (HEAD) is consistent. Runs after every rebase.
  build --ref REF [--out FILE | --stdout]
                events.json as it was at any commit, before or after the migration.
  verify --against FILE [--receipt FILE]
                The store holds exactly FILE's records and metadata.
  reconcile --prefer events.json|store
                Prints the records that differ, then rewrites the other side.
  reseal        Recomputes meta.json's seals from the month files (last resort).
  migrate expand|contract|uncontract|collapse [--dry-run]
                Used only by .github/workflows/migrate-events-store.yml.

Standard library only. Every file is written atomically (temporary file, fsync,
os.replace) and read and split as bytes, on b"\\n" only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

FORMAT = "ct-atlas-events-store/1"
TOOL_VERSION = 1
ROOT = Path(__file__).resolve().parent
DATABASE = "events.json"
STORE = "data/events"
META = STORE + "/meta.json"
SIDECAR = "events.json.store-base"
UNDATED = "undated"
SHRINK_RATIO = 0.9
MONTH = re.compile(r"\d{4}-(?:0[1-9]|1[0-2])")
MATERIALIZE = "python3 events_store.py materialize (on Windows: py -3.12 events_store.py materialize)"
# Added by the contract commit, removed by uncontract.
IGNORE_BLOCK = (
    "# The database is committed as data/events/ (docs/STORAGE_MIGRATION.md);\n"
    "# events.json is rebuilt from it by `events_store.py materialize`.\n"
    "/events.json\n"
)


class StoreError(RuntimeError):
    """events.json or the month files are inconsistent. Nothing was written."""


# ---------------------------------------------------------------- formats

def canonical(database):
    """events.json's bytes, as every writer formats them: collector.atomic_json_write,
    tools/finalize_daily_status.atomic_write (indent 2, raw UTF-8, final newline)."""
    return (json.dumps(database, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")


def record_line(event):
    """One month-file line: the record as compact JSON, key order kept."""
    return json.dumps(event, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8") + b"\n"


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def _refuse_constant(name):
    raise ValueError(f"{name} is not valid JSON")


def parse(data, what):
    try:
        return json.loads(data.decode("utf-8"), parse_constant=_refuse_constant)
    except (UnicodeDecodeError, ValueError) as error:
        raise StoreError(f"{what} does not parse: {error}") from None


def month_of(event):
    published = event.get("published")
    if isinstance(published, str) and MONTH.fullmatch(published[:7]):
        return published[:7]
    return UNDATED


def month_order(months):
    """Newest month first, undated last: the order of the database and of meta.json."""
    dated = sorted({month for month in months if month != UNDATED}, reverse=True)
    return dated + ([UNDATED] if UNDATED in months else [])


def validate(database, what=DATABASE):
    """The checks every mode makes: an events list of objects with unique non-empty ids."""
    if not isinstance(database, dict) or not isinstance(database.get("events"), list):
        raise StoreError(f"{what} has no events list.")
    seen = set()
    for index, event in enumerate(database["events"]):
        if not isinstance(event, dict):
            raise StoreError(f"{what}: record {index} is not an object.")
        identifier = event.get("id")
        if not isinstance(identifier, str) or not identifier:
            raise StoreError(f"{what}: record {index} has no id.")
        if identifier in seen:
            raise StoreError(f"{what} holds the id {identifier} twice.")
        seen.add(identifier)


def count_problem(database, what=DATABASE):
    if "number_of_events" in database and database["number_of_events"] != len(database["events"]):
        return f"{what}: number_of_events is {database['number_of_events']} but it holds {len(database['events'])} events."
    return None


# ---------------------------------------------------------------- split and rebuild

def split(database, authority):
    """(meta, {month: file bytes}, database in month order, ids that had to move).

    The database order is kept. Only a record published outside its run of months
    (out of order) is moved, stably, next to its month; the caller warns."""
    events = database["events"]
    months = [month_of(event) for event in events]
    order = month_order(months)
    rank = {month: index for index, month in enumerate(order)}
    moved, furthest = [], -1
    for event, month in zip(events, months):
        if rank[month] < furthest:
            moved.append(event["id"])
        furthest = max(furthest, rank[month])
    groups = {month: [] for month in order}
    for event, month in zip(events, months):
        groups[month].append(event)
    regrouped_events = [event for month in order for event in groups[month]]
    if sorted(map(id, regrouped_events)) != sorted(map(id, events)):
        raise StoreError("Regrouping by month changed the set of records.")
    regrouped = {key: (regrouped_events if key == "events" else value) for key, value in database.items()}
    files = {month: b"".join(record_line(event) for event in groups[month]) for month in order}
    meta = {
        "format": FORMAT,
        "partition": "month",
        "authority": authority,
        "events_sha256": sha256(canonical(regrouped)),
        "top_level_keys": list(database),
        "months": {month: {"events": len(groups[month]), "bytes": len(files[month]), "sha256": sha256(files[month])}
                   for month in order},
        "metadata": {key: value for key, value in database.items() if key != "events"},
    }
    return meta, files, regrouped, moved


def rebuild(meta, read_month, where=STORE, *, sealed=True):
    """(events.json bytes, database) from meta.json and read_month(month) -> bytes or None.
    sealed=False skips the seals (reseal only); every other check stays."""
    if not isinstance(meta, dict) or meta.get("format") != FORMAT or meta.get("partition") != "month":
        raise StoreError(f"{where}/meta.json is not a {FORMAT} month store.")
    if meta.get("authority") not in ("events.json", "store"):
        raise StoreError(f"{where}/meta.json has an unknown authority {meta.get('authority')!r}.")
    keys, metadata, months = meta.get("top_level_keys"), meta.get("metadata"), meta.get("months")
    if not isinstance(keys, list) or not isinstance(metadata, dict) or not isinstance(months, dict):
        raise StoreError(f"{where}/meta.json lacks top_level_keys, metadata or months.")
    if keys.count("events") != 1 or [key for key in keys if key != "events"] != list(metadata):
        raise StoreError(f"{where}/meta.json: top_level_keys and metadata disagree.")
    if list(months) != month_order(months) or any(m != UNDATED and not MONTH.fullmatch(m) for m in months):
        raise StoreError(f"{where}/meta.json lists its months out of order or with a bad name.")
    events = []
    for month, seal in months.items():
        name = f"{where}/{month}.jsonl"
        data = read_month(month)
        if data is None:
            raise StoreError(f"{name} is missing.")
        if sealed and (len(data) != seal.get("bytes") or sha256(data) != seal.get("sha256")):
            raise StoreError(f"{name} does not match its seal in meta.json (edited by hand, or its line endings "
                             "were changed: data/events must be checked out with LF).")
        if not data.endswith(b"\n"):
            raise StoreError(f"{name} does not end with a newline.")
        lines = data[:-1].split(b"\n")
        if sealed and len(lines) != seal.get("events"):
            raise StoreError(f"{name} holds {len(lines)} records, its seal {seal.get('events')}.")
        for number, line in enumerate(lines, 1):
            event = parse(line, f"{name} line {number}")
            if not isinstance(event, dict):
                raise StoreError(f"{name} line {number} is not an object.")
            if month_of(event) != month:
                raise StoreError(f"{name} line {number} ({event.get('id')}) belongs to {month_of(event)}.")
            events.append(event)
    database = {key: (events if key == "events" else metadata[key]) for key in keys}
    validate(database, where)
    problem = count_problem(database, where)
    if problem:
        raise StoreError(problem)
    body = canonical(database)
    if sealed and sha256(body) != meta.get("events_sha256"):
        raise StoreError(f"{where} rebuilds an events.json whose sha256 is not events_sha256 in meta.json "
                         "(a merge or a revert mixed two versions).")
    return body, database


# ---------------------------------------------------------------- git and files

def git(root, *args, check=True):
    result = subprocess.run(["git", *args], cwd=root, capture_output=True)
    if check and result.returncode:
        raise StoreError(f"git {' '.join(args)} failed: {result.stderr.decode('utf-8', 'replace').strip()}")
    return result


def in_git(root):
    """root is the top of a Git work tree with a commit."""
    prefix = git(root, "rev-parse", "--show-prefix", check=False)
    return prefix.returncode == 0 and not prefix.stdout.strip() and \
        git(root, "rev-parse", "--verify", "--quiet", "HEAD", check=False).returncode == 0


def blob(root, ref, path):
    """The bytes of path at ref, or None when ref has no such file."""
    result = git(root, "cat-file", "blob", f"{ref}:{path}", check=False)
    return result.stdout if result.returncode == 0 else None


def tree_names(root, ref, folder):
    output = git(root, "ls-tree", "--name-only", "-z", f"{ref}", f"{folder}/").stdout.decode("utf-8")
    return {name.rsplit("/", 1)[-1] for name in output.split("\0") if name}


def tracked(root, path):
    return bool(git(root, "ls-files", "-z", "--", path).stdout)


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_bytes(path):
    return path.read_bytes() if path.is_file() else None


def disk_reader(root):
    return lambda month: read_bytes(root / STORE / f"{month}.jsonl")


def ref_reader(root, ref):
    return lambda month: blob(root, ref, f"{STORE}/{month}.jsonl")


def committed_meta(root, ref="HEAD"):
    """meta.json at ref (on disk outside Git) as a dict, or None: the legacy layout."""
    data = blob(root, ref, META) if in_git(root) else read_bytes(root / META)
    return None if data is None else parse(data, META)


def mode(root=ROOT):
    meta = committed_meta(root)
    if meta is None:
        return "legacy"
    return "store" if meta.get("authority") == "store" else "dual"


def disk_meta(root):
    data = read_bytes(root / META)
    if data is None:
        raise StoreError(f"{META} is missing from the working tree although HEAD has it; run `git checkout -- {STORE}`.")
    return parse(data, META)


def stray_files(names, meta):
    expected = {"meta.json"} | {f"{month}.jsonl" for month in meta["months"]}
    return sorted(set(names) - expected)


def disk_names(root):
    folder = root / STORE
    return [path.name for path in folder.iterdir() if path.is_file()] if folder.is_dir() else []


def write_sidecar(root, meta_bytes, events_sha):
    atomic_write(root / SIDECAR, canonical({"meta_sha256": sha256(meta_bytes), "events_sha256": events_sha}))


def read_sidecar(root):
    data = read_bytes(root / SIDECAR)
    try:
        value = json.loads(data.decode("utf-8")) if data is not None else None
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def notice(kind, title, message):
    """A GitHub annotation in Actions, a plain line elsewhere."""
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print(f"::{kind} title={title}::{message}", flush=True)
    else:
        print(f"{kind}: {title}: {message}", flush=True)


# ---------------------------------------------------------------- reading the database

def require_materialized(root=ROOT):
    """Raises when the store exists on disk but events.json was never rebuilt from it."""
    if (root / META).is_file() and not (root / DATABASE).exists():
        raise RuntimeError(f"events.json is not materialized: run {MATERIALIZE}.")


def build_ref(root, ref="HEAD"):
    """events.json's bytes at ref, from whichever layout that commit has."""
    meta_bytes, database = blob(root, ref, META), blob(root, ref, DATABASE)
    if meta_bytes is not None:
        meta = parse(meta_bytes, f"{ref}:{META}")
        if meta.get("authority") == "store" or database is None:
            return rebuild(meta, ref_reader(root, ref), f"{ref}:{STORE}")[0]
    if database is None:
        raise StoreError(f"{ref} has neither events.json nor {META}.")
    return database


def committed_bytes(repository, relative=DATABASE, ref="HEAD"):
    """A committed file's bytes; events.json comes from build_ref, so it works in every layout."""
    relative = Path(relative).as_posix()
    if relative == DATABASE:
        return build_ref(repository, ref)
    data = blob(repository, ref, relative)
    if data is None:
        raise StoreError(f"{ref} has no {relative}.")
    return data


def restore(repository, relative=DATABASE):
    """Puts the committed database back in place of the local copy, staged state included
    (tools/finalize_daily_status.py after a failed collection)."""
    relative = Path(relative).as_posix()
    if relative == DATABASE and mode(repository) == "store":
        body = build_ref(repository, "HEAD")
        atomic_write(repository / DATABASE, body)
        write_sidecar(repository, blob(repository, "HEAD", META), sha256(body))
        return
    git(repository, "restore", "--source=HEAD", "--staged", "--worktree", "--", relative)


def committed_count(root):
    """How many events HEAD holds, or None outside Git."""
    if not in_git(root):
        return None
    meta = committed_meta(root)
    if meta is not None:
        return sum(seal.get("events", 0) for seal in meta.get("months", {}).values())
    data = blob(root, "HEAD", DATABASE)
    if data is None:
        return None
    events = parse(data, f"HEAD:{DATABASE}").get("events")
    return len(events) if isinstance(events, list) else None


# ---------------------------------------------------------------- commands

def materialize(root=ROOT, *, force=False):
    current_mode = mode(root)
    path = root / DATABASE
    if current_mode == "legacy":
        if not path.exists():
            raise StoreError("events.json is missing, and there is no data/events store to rebuild it from: "
                             "run `git checkout -- events.json`.")
        validate(parse(path.read_bytes(), DATABASE))
        print("events.json is the database (no data/events store yet); nothing to build.")
        return current_mode
    meta = disk_meta(root)
    body, database = rebuild(meta, disk_reader(root))
    stray = stray_files(disk_names(root), meta)
    if stray:
        raise StoreError(f"{STORE} holds files meta.json does not list: {', '.join(stray)}.")
    current = read_bytes(path)
    summary = f"{len(database['events'])} events, {len(meta['months'])} month files, events.json sha256 {sha256(body)}"
    if current_mode == "dual":
        if current != body:
            raise StoreError(
                "events.json and data/events disagree. If you changed events.json on purpose, run "
                "`events_store.py stage` to write the month files too. Otherwise `events_store.py reconcile "
                "--prefer events.json` (events.json is the source of truth until the contract) lists the "
                "records that differ and rewrites the month files.")
        print(f"events.json matches data/events: {summary}.")
        return current_mode
    if current == body:
        write_sidecar(root, read_bytes(root / META), sha256(body))
        print(f"events.json is up to date: {summary}.")
        return current_mode
    if current is not None and not force:
        base = read_sidecar(root)
        if not base or base.get("events_sha256") != sha256(current):
            raise StoreError(
                "events.json has changes that are not in data/events. Run `events_store.py stage` to keep "
                "them, or `events_store.py materialize --force` to replace them with the committed database.")
    atomic_write(path, body)
    write_sidecar(root, read_bytes(root / META), sha256(body))
    print(f"events.json rebuilt from data/events: {summary}.")
    return current_mode


def shadow_round_trip(raw, database):
    """Legacy mode: the expand rehearsed in memory, reported, never fatal."""
    try:
        problems = []
        body = canonical(database)
        if body != raw:
            problems.append("events.json is not in the canonical format (indent 2, final newline)")
        meta, files, regrouped, moved = split(database, "events.json")
        if moved:
            problems.append(f"{len(moved)} records are out of month order, such as {', '.join(moved[:5])}")
            body = canonical(regrouped)
        rebuilt, _ = rebuild(parse(canonical(meta), META), files.get)
        if rebuilt != body:
            problems.append("the month files do not rebuild events.json")
        largest = max((len(data) for data in files.values()), default=0)
        if problems:
            notice("warning", "Store shadow round trip", "; ".join(problems) + ".")
        else:
            notice("notice", "Store shadow round trip",
                   f"shadow round trip OK: {len(database['events'])} events in {len(files)} month files, "
                   f"largest {largest / 1048576:.1f} MiB, events.json {len(raw) / 1048576:.1f} MiB.")
    except Exception as error:  # noqa: BLE001 - a rehearsal never stops a commit
        notice("warning", "Store shadow round trip", f"failed: {error}")


def write_store(root, meta, files):
    """Writes the month files that changed, removes the months that aged out, then meta.json.
    Returns the changed file names."""
    folder = root / STORE
    changed = []
    for month, data in files.items():
        path = folder / f"{month}.jsonl"
        if read_bytes(path) != data:
            atomic_write(path, data)
            changed.append(path.name)
    for name in disk_names(root):
        if name.endswith(".jsonl") and name[:-len(".jsonl")] not in files:
            (folder / name).unlink()
            changed.append(name + " (removed)")
    meta_bytes = canonical(meta)
    if read_bytes(root / META) != meta_bytes:
        atomic_write(root / META, meta_bytes)
        changed.append("meta.json")
    return changed


def stage(root=ROOT, *, add=True):
    """Instead of `git add events.json`. Returns the mode."""
    current_mode = mode(root)
    path = root / DATABASE
    if not path.exists():
        raise StoreError(f"events.json is missing; nothing to stage. Rebuild it with {MATERIALIZE}.")
    raw = path.read_bytes()
    database = parse(raw, DATABASE)
    validate(database)
    problem = count_problem(database)
    if current_mode == "store":
        if tracked(root, DATABASE):
            raise StoreError("events.json is tracked again although data/events is the database; "
                             "run `git rm --cached events.json`.")
        base = read_sidecar(root)
        if not base or base.get("meta_sha256") != sha256(read_bytes(root / META) or b""):
            raise StoreError("This events.json was built from an older data/events. Save your changes, pull, run "
                             f"{MATERIALIZE}, apply them again, then stage.")
    previous = committed_count(root)
    if previous and len(database["events"]) < SHRINK_RATIO * previous and os.environ.get("ALLOW_SHRINK") != "1":
        raise StoreError(f"events.json holds {len(database['events'])} events, HEAD {previous}: more than "
                         f"{100 - SHRINK_RATIO * 100:.0f}% fewer. A deliberate removal sets ALLOW_SHRINK=1.")
    if current_mode == "legacy":
        if problem:
            notice("warning", "Event count", problem)
        shadow_round_trip(raw, database)
        if add:
            git(root, "add", "--", DATABASE)
        return current_mode
    if problem:
        raise StoreError(problem)
    meta, files, regrouped, moved = split(database, "store" if current_mode == "store" else "events.json")
    if moved:
        notice("warning", "Records out of month order",
               f"{len(moved)} records were moved next to their month: {', '.join(moved[:20])}.")
    body = canonical(regrouped)
    if body != raw:
        atomic_write(path, body)
        print("events.json rewritten in the canonical format and month order.")
    changed = write_store(root, meta, files)
    rebuilt, _ = rebuild(disk_meta(root), disk_reader(root))
    if rebuilt != body:
        raise StoreError("The month files just written do not rebuild events.json.")
    if current_mode == "store":
        write_sidecar(root, read_bytes(root / META), meta["events_sha256"])
    if add:
        git(root, "add", "-A", "--", STORE)
        if current_mode == "dual":
            git(root, "add", "--", DATABASE)
    for name in changed:
        month = name.split(".", 1)[0]
        seal = meta["months"].get(month)
        print(f"  {STORE}/{name}" + (f": {seal['events']} events, {seal['bytes']} bytes" if seal else ""))
    print(f"Staged ({current_mode} mode): {len(changed)} store files changed, "
          f"{len(database['events'])} events, events.json sha256 {meta['events_sha256']}.")
    return current_mode


def check(root=ROOT, ref="HEAD"):
    """The committed tree at ref is consistent. Writes nothing."""
    meta_bytes, database = blob(root, ref, META), blob(root, ref, DATABASE)
    if meta_bytes is None:
        if database is None:
            raise StoreError(f"events.json is missing from {ref}.")
        validate(parse(database, f"{ref}:{DATABASE}"), f"{ref}:{DATABASE}")
        print(f"{ref}: events.json is the database (legacy layout) and is valid.")
        return "legacy"
    meta = parse(meta_bytes, f"{ref}:{META}")
    body, rebuilt = rebuild(meta, ref_reader(root, ref), f"{ref}:{STORE}")
    stray = stray_files(tree_names(root, ref, STORE), meta)
    if stray:
        raise StoreError(f"{ref}:{STORE} holds files meta.json does not list: {', '.join(stray)}.")
    if meta["authority"] == "store":
        if database is not None:
            raise StoreError(f"events.json is tracked again at {ref} although data/events is the database.")
    elif database is None:
        raise StoreError(f"events.json is missing from {ref} while it is still the source of truth.")
    elif database != body:
        raise StoreError(f"events.json and data/events disagree at {ref}: a commit changed one without the other. "
                         "Fix it forward: `events_store.py reconcile --prefer events.json`, then stage and commit.")
    current_mode = "store" if meta["authority"] == "store" else "dual"
    print(f"{ref}: data/events is consistent ({current_mode} mode): {len(rebuilt['events'])} events, "
          f"{len(meta['months'])} month files, events.json sha256 {meta['events_sha256']}.")
    return current_mode


def differences(expected, actual, limit=20):
    """Human-readable differences between two databases, record by record."""
    found = []
    if list(expected) != list(actual):
        found.append(f"top-level keys differ: {list(expected)} / {list(actual)}")
    for key in expected:
        if key != "events" and key in actual and canonical(expected[key]) != canonical(actual[key]):
            found.append(f"metadata {key} differs")
    left = {event.get("id"): event for event in expected.get("events", [])}
    right = {event.get("id"): event for event in actual.get("events", [])}
    found += [f"only in the first: {key}" for key in left if key not in right]
    found += [f"only in the second: {key}" for key in right if key not in left]
    found += [f"record {key} differs" for key in left if key in right and record_line(left[key]) != record_line(right[key])]
    if not found and [e.get("id") for e in expected["events"]] != [e.get("id") for e in actual["events"]]:
        found.append("the same records in another order")
    return found[:limit] + ([f"... {len(found) - limit} more"] if len(found) > limit else [])


def id_digest(events):
    return sha256("\n".join(event["id"] for event in events).encode("utf-8"))


def verify(root, against, *, ref=None, receipt=None):
    """The store (on disk, or at ref) holds exactly the records and metadata of the file against."""
    raw = Path(against).read_bytes()
    expected = parse(raw, str(against))
    validate(expected, str(against))
    if ref:
        meta = parse(blob(root, ref, META) or b"null", f"{ref}:{META}")
        body, actual = rebuild(meta, ref_reader(root, ref), f"{ref}:{STORE}")
    else:
        meta = disk_meta(root)
        body, actual = rebuild(meta, disk_reader(root))
    found = differences(expected, actual)
    ids_expected = [event["id"] for event in expected["events"]]
    ids_actual = [event["id"] for event in actual["events"]]
    if ids_expected != ids_actual:
        found.append("the id sequences differ")
    for index, (left, right) in enumerate(zip(expected["events"], actual["events"])):
        if record_line(left) != record_line(right):
            found.append(f"record {index} ({left['id']}) differs")
            break
    if body != raw:
        found.append("the rebuilt bytes differ from the file")
    result = {
        "tool": f"events_store.py/{TOOL_VERSION}", "format": FORMAT, "verified_at": datetime.now(timezone.utc).isoformat(),
        "against": {"path": Path(against).name, "bytes": len(raw), "sha256": sha256(raw)},
        "store": {"ref": ref or "working tree", "events_sha256": meta["events_sha256"], "months": meta["months"]},
        "events": len(ids_actual), "id_sequence_sha256": id_digest(actual["events"]),
        "identical": not found, "differences": found,
    }
    if receipt:
        atomic_write(Path(receipt), canonical(result))
    if found:
        raise StoreError("The store differs from " + str(against) + ": " + "; ".join(found))
    print(f"Verified: {len(ids_actual)} records, metadata and key order identical to {against} (sha256 {sha256(raw)}).")
    return result


def reseal(root=ROOT):
    """Recomputes meta.json's seals from the month files on disk. Only after checking them by hand."""
    meta = disk_meta(root)
    _, database = rebuild(meta, disk_reader(root), sealed=False)
    fresh, files, regrouped, _ = split(database, meta["authority"])
    changed = write_store(root, fresh, files)
    print(f"Resealed {STORE}: {', '.join(changed) or 'nothing changed'}.")


def reconcile(root=ROOT, prefer=DATABASE):
    """Prints the records that differ between events.json and the store, then rewrites the other side."""
    current_mode = mode(root)
    if current_mode == "legacy":
        raise StoreError("There is no data/events store to reconcile with.")
    path = root / DATABASE
    raw = read_bytes(path)
    meta = disk_meta(root)
    try:
        _, stored = rebuild(meta, disk_reader(root))
    except StoreError as error:
        if prefer != DATABASE:
            raise
        print(f"The store does not rebuild ({error}); it is rewritten from events.json.")
        stored = None
    local = parse(raw, DATABASE) if raw is not None else None
    if local is not None and stored is not None:
        for line in differences(local, stored, limit=50) or ["no difference"]:
            print(f"  events.json / data/events: {line}")
    if prefer == DATABASE:
        if local is None:
            raise StoreError("events.json is missing.")
        validate(local)
        problem = count_problem(local)
        if problem:
            raise StoreError(problem)
        meta, files, regrouped, _ = split(local, meta["authority"])
        if canonical(regrouped) != raw:
            atomic_write(path, canonical(regrouped))
        write_store(root, meta, files)
        if current_mode == "store":
            write_sidecar(root, read_bytes(root / META), meta["events_sha256"])
        print("data/events rewritten from events.json; review with `git diff`, then stage and commit.")
    else:
        materialize(root, force=True)
        print("events.json rewritten from data/events.")


# ---------------------------------------------------------------- migrations

def _require(condition, message):
    if not condition:
        raise StoreError(message)


def _clean_database(root):
    raw = read_bytes(root / DATABASE)
    _require(raw is not None and raw == blob(root, "HEAD", DATABASE),
             "events.json differs from HEAD; a migration starts from a clean checkout.")
    return raw


def _ignore_lines(root, present):
    path = root / ".gitignore"
    text = path.read_bytes().decode("utf-8") if path.exists() else ""
    if present and IGNORE_BLOCK not in text:
        text = text + ("" if text.endswith("\n") or not text else "\n") + IGNORE_BLOCK
    elif not present:
        text = text.replace(IGNORE_BLOCK, "")
    atomic_write(path, text.encode("utf-8"))


def migrate(root, direction, *, dry_run=False, receipt=None):
    """One migration step, staged and never committed (the workflow commits).
    Returns a summary: S0 (sha256 of events.json before), events, message."""
    _require(in_git(root), "A migration runs in a Git checkout.")
    current_mode = mode(root)
    before = build_ref(root, "HEAD")
    database = parse(before, DATABASE)
    validate(database)
    summary = {"direction": direction, "dry_run": dry_run, "mode_before": current_mode, "s0": sha256(before),
               "events": len(database["events"]), "bytes": len(before),
               "id_sequence_sha256": id_digest(database["events"]),
               "source_revision": git(root, "rev-parse", "HEAD").stdout.decode().strip(),
               "tool": f"events_store.py/{TOOL_VERSION}", "format": FORMAT,
               "at": datetime.now(timezone.utc).isoformat()}
    tag = f"(sha256 {summary['s0']}, {summary['events']} events)"
    if direction == "expand":
        _require(current_mode == "legacy", f"expand needs the legacy layout; HEAD is in {current_mode} mode.")
        raw = _clean_database(root)
        _require(not (root / STORE).exists() or not any((root / STORE).iterdir()), f"{STORE} already holds files.")
        problem = count_problem(database)
        _require(problem is None, problem or "")
        _require(canonical(database) == raw, "events.json is not in the canonical format.")
        meta, files, regrouped, moved = split(database, "events.json")
        _require(not moved, f"{len(moved)} records are out of month order, such as {moved[:5]}; expand keeps the bytes.")
        summary["months"] = meta["months"]
        summary["message"] = f"Add the monthly database store next to events.json {tag}"
        if not dry_run:
            write_store(root, meta, files)
            body, _ = rebuild(disk_meta(root), disk_reader(root))
            _require(body == raw, "The month files just written do not rebuild events.json.")
            git(root, "add", "-A", "--", STORE)
    elif direction == "collapse":
        _require(current_mode == "dual", f"collapse needs dual mode; HEAD is in {current_mode} mode.")
        _clean_database(root)
        summary["message"] = f"Remove the monthly database store; events.json stays the database {tag}"
        if not dry_run:
            git(root, "rm", "-r", "-q", "--", STORE)
            _require(read_bytes(root / DATABASE) == before, "collapse changed events.json.")
    elif direction == "contract":
        _require(current_mode == "dual", f"contract needs dual mode; HEAD is in {current_mode} mode.")
        check(root)
        raw = _clean_database(root)
        meta = disk_meta(root)
        _require(read_bytes(root / META) == blob(root, "HEAD", META), "data/events/meta.json differs from HEAD.")
        body, _ = rebuild(meta, disk_reader(root))
        _require(body == raw, "data/events does not rebuild HEAD's events.json.")
        with tempfile.TemporaryDirectory() as folder:
            copy = Path(folder) / DATABASE
            copy.write_bytes(raw)
            summary["verification"] = verify(root, copy, ref="HEAD")
        summary["months"] = meta["months"]
        summary["message"] = f"Stop tracking events.json: database in data/events {tag}"
        record = root / "archive" / f"events-store-contract-{datetime.now(timezone.utc):%Y%m%d}.json"
        summary["receipt_path"] = record.relative_to(root).as_posix()
        if not dry_run:
            meta["authority"] = "store"
            atomic_write(root / META, canonical(meta))
            git(root, "rm", "--cached", "-q", "--", DATABASE)
            _ignore_lines(root, True)
            write_sidecar(root, read_bytes(root / META), meta["events_sha256"])
            atomic_write(record, canonical(summary))
            git(root, "add", "--", META, ".gitignore", summary["receipt_path"])
            _require(not tracked(root, DATABASE), "events.json is still in the index.")
    elif direction == "uncontract":
        _require(current_mode == "store", f"uncontract needs store mode; HEAD is in {current_mode} mode.")
        materialize(root, force=True)
        raw = read_bytes(root / DATABASE)
        _require(raw == before, "The rebuilt events.json differs from build --ref HEAD.")
        meta = disk_meta(root)
        summary["message"] = f"Track events.json again; it is the source of truth {tag}"
        if not dry_run:
            meta["authority"] = "events.json"
            atomic_write(root / META, canonical(meta))
            _ignore_lines(root, False)
            git(root, "add", "-f", "--", DATABASE)
            git(root, "add", "--", META, ".gitignore")
            (root / SIDECAR).unlink(missing_ok=True)
    else:
        raise StoreError(f"Unknown direction {direction!r}.")
    if receipt:
        atomic_write(Path(receipt), canonical(summary))
    print(("Dry run: " if dry_run else "") + summary["message"])
    return summary


# ---------------------------------------------------------------- command line

def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except AttributeError:
            pass
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--root", type=Path, default=ROOT, help=argparse.SUPPRESS)
    commands = parser.add_subparsers(dest="command", required=True)
    command = commands.add_parser("materialize", help="rebuild or check events.json after a checkout")
    command.add_argument("--force", action="store_true", help="replace a locally changed events.json")
    command = commands.add_parser("stage", help="instead of git add events.json")
    command.add_argument("--no-add", action="store_true", help="write the files, stage nothing")
    command = commands.add_parser("check", help="the committed tree is consistent")
    command.add_argument("--ref", default="HEAD")
    command = commands.add_parser("build", help="events.json at any commit")
    command.add_argument("--ref", default="HEAD")
    output = command.add_mutually_exclusive_group(required=True)
    output.add_argument("--out", type=Path)
    output.add_argument("--stdout", action="store_true")
    command = commands.add_parser("verify", help="the store holds exactly a file's records")
    command.add_argument("--against", type=Path, required=True)
    command.add_argument("--ref")
    command.add_argument("--receipt", type=Path)
    commands.add_parser("reseal", help="recompute meta.json's seals from the month files")
    command = commands.add_parser("reconcile", help="print the differences, then rewrite the other side")
    command.add_argument("--prefer", choices=(DATABASE, "store"), required=True)
    command = commands.add_parser("migrate", help="used by migrate-events-store.yml")
    command.add_argument("direction", choices=("expand", "contract", "uncontract", "collapse"))
    command.add_argument("--dry-run", action="store_true")
    command.add_argument("--receipt", type=Path)
    args = parser.parse_args(argv)
    root = args.root.resolve()
    try:
        if args.command == "materialize":
            materialize(root, force=args.force)
        elif args.command == "stage":
            stage(root, add=not args.no_add)
        elif args.command == "check":
            check(root, args.ref)
        elif args.command == "build":
            body = build_ref(root, args.ref)
            if args.stdout:
                sys.stdout.flush()
                sys.stdout.buffer.write(body)
            else:
                atomic_write(args.out, body)
                print(f"{args.out}: {len(body)} bytes, sha256 {sha256(body)}", file=sys.stderr)
        elif args.command == "verify":
            verify(root, args.against, ref=args.ref, receipt=args.receipt)
        elif args.command == "reseal":
            reseal(root)
        elif args.command == "reconcile":
            reconcile(root, args.prefer)
        elif args.command == "migrate":
            migrate(root, args.direction, dry_run=args.dry_run, receipt=args.receipt)
    except StoreError as error:
        notice("error", "events_store.py " + args.command, str(error))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
