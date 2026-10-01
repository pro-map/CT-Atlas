#!/usr/bin/env python3
"""Retroactive incident consolidation of events.json: merge incident ids that
describe the same real-world incident, then fold duplicate records of the
same development. Uses collector.consolidate_incidents, the same pass the
daily collector runs, with a larger Gemini budget so the 180-day backlog
drains over a few runs. Progress is kept in incident_consolidation_state.json,
so re-running continues where the last run stopped.

Usage:
    python3 tools/consolidate_incidents.py --dry-run
    GEMINI_API_KEY=... python3 tools/consolidate_incidents.py --max-calls 60
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

_spec = importlib.util.spec_from_file_location("collector", ROOT / "collector.py")
collector = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(collector)


def main(argv=None):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--input", default=str(ROOT / collector.OUTPUT_FILE))
    parser.add_argument("--state", default=str(ROOT / collector.INCIDENT_STATE_FILE))
    parser.add_argument("--max-calls", type=int, default=60, help="Gemini window reviews this run.")
    parser.add_argument("--dry-run", action="store_true",
                        help="No Gemini calls and nothing written: report the backlog and the free record merges.")
    args = parser.parse_args(argv)

    with open(args.input, encoding="utf-8") as handle:
        database = json.load(handle)
    events = database.get("events")
    if not isinstance(events, list) or not events:
        print("No events found; aborting.", file=sys.stderr)
        return 1

    incidents_before = len({collector._incident_key(event) for event in events})
    records_before = len(events)
    state = collector.load_incident_state(args.state)
    events, stats = collector.consolidate_incidents(
        events, state, max_calls=args.max_calls, use_gemini=not args.dry_run
    )
    incidents_after = len({collector._incident_key(event) for event in events})

    print(f"Records:   {records_before} -> {len(events)}")
    print(f"Incidents: {incidents_before} -> {incidents_after}")
    remaining = stats["windows_pending"] - stats["windows_reviewed"]
    print(f"Windows still to review: {remaining}")
    if stats["error"]:
        print(f"::warning title=Incident consolidation paused::{stats['error']}")

    largest = Counter(event.get("incident_id") for event in events if event.get("incident_id")).most_common(5)
    for incident_id, count in largest:
        title = next(event.get("title") for event in events if event.get("incident_id") == incident_id)
        print(f"  {count:3d} records  {incident_id}  {title[:90]}")

    if args.dry_run:
        print("Dry run: nothing written.")
        return 0

    database["events"] = events
    database["number_of_events"] = len(events)
    collector.atomic_json_write(args.input, database)
    collector.save_incident_state(state, events, args.state)
    print(f"::notice title=Incident consolidation::{records_before}->{len(events)} records, "
          f"{incidents_before}->{incidents_after} incidents, {remaining} windows left")
    return 0


if __name__ == "__main__":
    sys.exit(main())
