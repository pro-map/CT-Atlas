#!/usr/bin/env python3
"""Separate legacy record-ID collisions without deleting or merging evidence.

This is a record-key migration, NOT incident deduplication or new coverage.
Only an affected record's `id` changes. A durable one-to-many migration log
preserves the ambiguous legacy key; it is deliberately NOT a redirect table.
No model calls. Run --apply before a backfill's old-record/geo snapshots,
then --check before publishing. Unknown/ambiguous source identities fail closed.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import tempfile
from collections import Counter
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

VERSION = "ct-atlas-record-identity-v1"
DEFAULT_LEDGER = "archive/map-record-id-migration-v1.json"
REFERENCE_FIELDS = {"parent_event_id", "parent_record_id", "event_id", "record_id",
                    "source_event_id", "related_event_ids", "related_record_ids"}


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def fingerprint(event):
    fields = tuple(event.get(f) for f in ("url", "original_title", "published"))
    if any(not isinstance(x, str) or not x.strip() for x in fields):
        raise ValueError("Affected record lacks URL, original title or publication date")
    url = urlsplit(fields[0])
    if url.scheme not in {"http", "https"} or not url.netloc:
        raise ValueError("Affected record has no usable public-source URL")
    datetime.fromisoformat(fields[2].replace("Z", "+00:00"))
    return hashlib.sha256(canonical(fields).encode("utf-8")).hexdigest()


def replacement_id(old_id, source_fingerprint):
    return hashlib.sha256(canonical([VERSION, old_id, source_fingerprint]).encode("utf-8")).hexdigest()[:16]


def validate(events, unique=False):
    if not isinstance(events, list) or not events or any(not isinstance(e, dict) for e in events):
        raise ValueError("Malformed or empty Map records")
    if any(not isinstance(e.get("id"), str) or not e["id"].strip() for e in events):
        raise ValueError("A Map record lacks a durable string ID")
    counts = Counter(e["id"] for e in events)
    if unique and any(n != 1 for n in counts.values()):
        raise ValueError("Record-ID collision: refusing publication")
    return counts


def ledger_index(ledger):
    if not isinstance(ledger, dict) or ledger.get("version") != VERSION or not isinstance(ledger.get("migrations"), list):
        raise ValueError("Malformed record-identity migration ledger")
    index, targets = {}, set()
    for row in ledger["migrations"]:
        if not isinstance(row, dict) or set(row) != {"old_id", "source_fingerprint", "new_id"}:
            raise ValueError("Malformed migration entry")
        old, source, new = (row[k] for k in ("old_id", "source_fingerprint", "new_id"))
        if not all(isinstance(v, str) and v for v in (old, source, new)):
            raise ValueError("Missing migration identity")
        if new != replacement_id(old, source) or (old, source) in index or new in targets:
            raise ValueError("Ambiguous or invalid migration mapping")
        index[(old, source)] = new
        targets.add(new)
    return index


def references(value, blocked):
    if isinstance(value, dict):
        for key, item in value.items():
            if key in REFERENCE_FIELDS:
                values = item if isinstance(item, list) else [item]
                if any(isinstance(v, str) and v in blocked for v in values):
                    raise ValueError("Live record reference uses an ambiguous legacy ID")
            references(item, blocked)
    elif isinstance(value, list):
        for item in value:
            references(item, blocked)


def plan(events, ledger=None):
    """Return new records, mapping and statistics; never mutate caller objects."""
    counts = validate(events)
    ledger = copy.deepcopy(ledger) if ledger is not None else {"version": VERSION, "migrations": []}
    index = ledger_index(ledger)
    retired = {old for old, _ in index}
    repeated = {key for key, count in counts.items() if count > 1}
    affected = repeated | retired
    references(events, affected)
    identities, changes = set(), []
    for position, event in enumerate(events):
        old = event["id"]
        if old not in affected:
            continue
        source = fingerprint(event)
        identity = (old, source)
        if identity in identities:
            raise ValueError("Same source identity repeated: requires evidence review, not rekeying")
        identities.add(identity)
        if old in retired and identity not in index:
            raise ValueError("Unknown source reuses retired ID: review before migration")
        new = index.get(identity) or replacement_id(old, source)
        changes.append((position, old, source, new))
    result_ids = [e["id"] for e in events]
    occupied = set(result_ids)
    planned = set()
    for position, old, source, new in changes:
        if new in occupied or new in planned:
            raise ValueError("Replacement record ID already exists; refusing collision/replay")
        planned.add(new)
        result_ids[position] = new
        if (old, source) not in index:
            index[(old, source)] = new
    if len(set(result_ids)) != len(events):
        raise ValueError("Unresolved duplicate record IDs")
    result = copy.deepcopy(events)
    for position, _, _, new in changes:
        result[position]["id"] = new
    ledger["migrations"] = [{"old_id": old, "source_fingerprint": source, "new_id": new}
                            for (old, source), new in sorted(index.items())]
    ledger_index(ledger)
    return result, ledger, {"records": len(events), "collision_groups_before": len(repeated),
                           "records_rekeyed": len(changes), "distinct_record_ids_after": len(result_ids),
                           "records_added": 0, "records_removed": 0, "incident_ids_changed": 0}


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=path.name + ".", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def run(path="events.json", ledger_path=DEFAULT_LEDGER, apply=False, check=False):
    path, ledger_path = Path(path), Path(ledger_path)
    raw = path.read_bytes()
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("Malformed Map database")
    ledger = json.loads(ledger_path.read_text(encoding="utf-8")) if ledger_path.exists() else None
    if check:
        validate(data.get("events"), unique=True)
        retired = {old for old, _ in ledger_index(ledger)} if ledger is not None else set()
        if any(e["id"] in retired for e in data["events"]):
            raise ValueError("Retired ambiguous ID replayed: refusing publication")
        print("RECORD_INTEGRITY_OK " + canonical({"records": len(data["events"]), "duplicate_ids": 0}))
        return {"records_rekeyed": 0}
    repaired, updated, stats = plan(data.get("events"), ledger)
    if apply and stats["records_rekeyed"]:
        data["events"] = repaired
        output = (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        def blob(content):
            return hashlib.sha1(b"blob " + str(len(content)).encode() + b"\0" + content).hexdigest()
        updated["last_migration"] = {**stats, "input_blob_sha": blob(raw),
                                     "output_blob_sha": blob(output), "publication_confirmed": False}
        # Write recoverable mapping first. An interrupted DB replace is safely
        # repeatable against either the original or already-migrated records.
        if updated != ledger:
            atomic_json(ledger_path, updated)
        atomic_json(path, data)
    print("RECORD_ID_MIGRATION " + canonical({**stats, "applied": apply}))
    return stats


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", default="events.json")
    parser.add_argument("--ledger", default=DEFAULT_LEDGER)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--apply", action="store_true")
    modes.add_argument("--check", action="store_true")
    args = parser.parse_args()
    run(args.path, args.ledger, args.apply, args.check)
