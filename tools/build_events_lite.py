#!/usr/bin/env python3
"""Build events-lite.json: the events database without the collector's own bookkeeping fields
(tools/events-lite-excluded-fields.json), written compactly.

Why: events.json is ~20 MB (5 MB gzipped) because each event also carries ~31 collector
bookkeeping fields (related_articles alone is 27% of the bytes) that neither the map nor
the Worker (reports, deep search, quick ask) ever reads. The lite file is ~7-8 MB (~2.5 MB
gzipped) and parses ~2.4x faster.

The list names what is REMOVED, not what is kept: any field that is not listed (including one
the collector adds tomorrow) stays, so a consumer can never lose data it starts to read.
tests/events-lite.test.cjs proves that no listed field is read by the map or the Worker.

It is a DERIVED file, generated at publication time from the events.json being deployed and
never committed: it can therefore never be older than the database it was built from. The
collector keeps working on the full events.json untouched. Consumers fall back to the full
file whenever the lite one is missing or invalid.

Standard library only:
    python tools/build_events_lite.py                      # events.json -> events-lite.json
    python tools/build_events_lite.py --input a.json --output b.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXCLUDED_FILE = Path(__file__).resolve().parent / "events-lite-excluded-fields.json"
FORMAT = "events-lite-v2"
# Fields without which an event is meaningless to every consumer: never excludable.
REQUIRED = ("id", "published", "title")


def load_excluded(path: Path = EXCLUDED_FILE) -> list[str]:
    excluded = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(excluded, list) or not excluded or not all(isinstance(item, str) and item for item in excluded):
        raise ValueError(f"{path.name} must be a non-empty JSON list of field names.")
    if len(set(excluded)) != len(excluded):
        raise ValueError(f"{path.name} contains duplicate field names.")
    forbidden = [name for name in REQUIRED if name in excluded]
    if forbidden:
        raise ValueError(f"{path.name} must not exclude {', '.join(forbidden)}.")
    return excluded


def build_lite(database: dict, excluded: list[str]) -> dict:
    events = database.get("events")
    if not isinstance(events, list) or not events:
        raise ValueError("The source database has no events; refusing to build an empty lite file.")

    drop = set(excluded)
    lite_events = []
    for index, event in enumerate(events):
        if not isinstance(event, dict):
            raise ValueError(f"Event #{index} is not an object.")
        lite_events.append({name: value for name, value in event.items() if name not in drop})

    # Every non-event key (trend_summary, weekly_analysis, last_updated, ...) is kept as is:
    # together they are ~17 KB and the map and the report cache key read some of them.
    lite = {key: value for key, value in database.items() if key != "events"}
    lite["events"] = lite_events
    lite["lite"] = {"format": FORMAT, "source_event_count": len(events), "excluded_fields": excluded}
    return lite


def validate(lite: dict, database: dict) -> None:
    source = database["events"]
    events = lite["events"]
    if len(events) != len(source):
        raise ValueError(f"Lite has {len(events)} events but the source has {len(source)}.")
    excluded = set(lite["lite"]["excluded_fields"])
    for index, (kept, original) in enumerate(zip(events, source)):
        for name in REQUIRED:
            if name in original and name not in kept:
                raise ValueError(f"Event #{index} lost required field {name}.")
        if kept.get("id") != original.get("id") or kept.get("published") != original.get("published"):
            raise ValueError(f"Event #{index} does not match its source event.")
        # Exactly the excluded fields are gone: nothing else was lost or altered.
        expected = {name: value for name, value in original.items() if name not in excluded}
        if kept != expected:
            raise ValueError(f"Event #{index} differs from its source beyond the excluded fields.")
    for key in database:
        if key != "events" and key not in lite:
            raise ValueError(f"Top-level key {key} was dropped.")


def write_atomic(path: Path, payload: bytes) -> None:
    """A half-written file must never be published: write beside it, then replace."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "wb") as temp:
            temp.write(payload)
        os.replace(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--input", default=str(ROOT / "events.json"))
    parser.add_argument("--output", default=str(ROOT / "events-lite.json"))
    parser.add_argument("--excluded", default=str(EXCLUDED_FILE))
    args = parser.parse_args(argv)

    try:
        source_bytes = Path(args.input).read_bytes()
        database = json.loads(source_bytes)
        if not isinstance(database, dict):
            raise ValueError("The source database is not a JSON object.")
        excluded = load_excluded(Path(args.excluded))
        lite = build_lite(database, excluded)
        validate(lite, database)
        payload = json.dumps(lite, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        # Round-trip: what we publish must parse back to exactly what we validated.
        if json.loads(payload) != lite:
            raise ValueError("The serialised lite file does not round-trip.")
        write_atomic(Path(args.output), payload)
    except (OSError, ValueError) as exc:
        print(f"events-lite NOT built: {exc}", file=sys.stderr)
        return 1

    print(
        f"events-lite: {len(lite['events'])} events, {len(excluded)} fields excluded, "
        f"{len(payload) / 1e6:.1f} MB (source {len(source_bytes) / 1e6:.1f} MB, "
        f"-{100 * (1 - len(payload) / len(source_bytes)):.0f}%)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
