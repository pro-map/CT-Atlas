#!/usr/bin/env python3
"""Put back on the map the events a cleanup re-check removed by mistake.

From 2026-10-02 the scheduled 60-69 cleanup (cleanup-events.yml, manual only
since 2026-10-04) re-checked events earlier runs had already kept, and
Gemini's run-to-run variation removed some of them. This puts the events a
'gemini re-check' removed in the given archive/removed-events-*.json files
back into events.json, as they were (minus the cleanup's reason). Events
removed by the opinion/analysis keyword pass stay removed, and an event the
map already holds again (same link, or for a Google News redirect the same
headline and outlet: collector.article_identities, leads and their other
reports alike) is not added twice. The archive files are
left untouched: the sync drops archive rows that repeat a map event, and an
event that later ages out of the map is archived by what happened last.

    py -3.11 tools/restore_removed_events.py archive/removed-events-20261002-175602.json ... [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import collector  # noqa: E402


def identities(article):
    """Every key the collector knows an article by, under its English and
    its original headline."""
    keys = set(collector.article_identities(article))
    if article.get("original_title"):
        keys |= collector.article_identities({**article, "title": article["original_title"]})
    return keys


def map_identities(events):
    keys = set()
    for event in events:
        keys |= identities(event)
        for article in event.get("related_articles") or []:
            if isinstance(article, dict):
                keys |= identities(article)
    return keys


def restorable(paths, events):
    """(events to put back, already on the map, kept removed) from the files."""
    restore, already, kept_removed = [], 0, 0
    known = map_identities(events)
    for path in paths:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        for event in data.get("events") or []:
            if not str(event.get("_cleanup_reason") or "").startswith("gemini re-check"):
                kept_removed += 1
                continue
            keys = identities(event)
            if not event.get("url") or keys & known:
                already += 1
                continue
            known |= keys
            restore.append({key: value for key, value in event.items() if key != "_cleanup_reason"})
    return restore, already, kept_removed


def main(argv=None):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("files", nargs="+")
    parser.add_argument("--input", default=str(ROOT / collector.OUTPUT_FILE))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    database = json.loads(Path(args.input).read_text(encoding="utf-8"))
    events = database.get("events") or []
    restore, already, kept_removed = restorable(args.files, events)
    print(f"{len(restore)} event(s) to put back; {already} already on the map; "
          f"{kept_removed} removed by the keyword pass stay removed.")
    if args.dry_run or not restore:
        return 0
    events.extend(restore)
    # The collector keeps events newest first.
    events.sort(key=lambda event: event.get("published", ""), reverse=True)
    database["events"] = events
    database["number_of_events"] = len(events)
    collector.atomic_json_write(args.input, database)
    print(f"events.json now holds {len(events)} events.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
