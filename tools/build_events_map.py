#!/usr/bin/env python3
"""Build events-map.json: the map's own data -- only real and foiled attacks, in
the events-lite field set -- plus a small summary of the whole database.

Why: the map shows attacks only (executed attacks, attempted attacks and
disrupted plots). Downloading the full events-lite.json (every category) to
display a fifth of it was most of the map's weight; the full data is still
loaded, on demand, by the Database section.

Legacy records that predate the incident model have no primary_event_type; for
those the "Attacks" category stands in, since it groups executed, attempted and
foiled attacks the same way.

Like events-lite.json it is DERIVED at publication time from the events.json
being deployed and never committed. The map falls back to events-lite.json
(filtering it the same way) when this file is missing or unusable.

Standard library only:
    python tools/build_events_map.py                      # events.json -> events-map.json
    python tools/build_events_map.py --input a.json --output b.json
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FORMAT = "events-map-v1"
MAP_TYPES = ("ATTACK", "ATTEMPTED_ATTACK", "DISRUPTED_PLOT")

_spec = importlib.util.spec_from_file_location("build_events_lite", Path(__file__).resolve().parent / "build_events_lite.py")
lite = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lite)


def event_categories(event: dict) -> list[str]:
    raw = event.get("categories")
    if isinstance(raw, list) and raw:
        return [str(value) for value in raw]
    return [str(event["category"])] if event.get("category") else []


def is_map_attack(event: dict) -> bool:
    """Executed attacks (ATTACK with is_attack), attempted attacks and disrupted plots."""
    event_type = str(event.get("primary_event_type") or "").strip().upper()
    if event_type:
        if event_type == "ATTACK":
            return event.get("is_attack") is True
        return event_type in MAP_TYPES
    return "Attacks" in event_categories(event)


def database_summary(events: list[dict]) -> dict:
    visible = [event for event in events if event.get("excluded_from_map") is not True]
    by_category = Counter(event_categories(event)[0] for event in visible if event_categories(event))
    return {
        "total_events": len(visible),
        "by_category": dict(by_category.most_common()),
    }


def build_map(database: dict, excluded: list[str]) -> dict:
    events = database.get("events")
    if not isinstance(events, list) or not events:
        raise ValueError("The source database has no events; refusing to build the map file.")

    drop = set(excluded)
    map_events = []
    for index, event in enumerate(events):
        if not isinstance(event, dict):
            raise ValueError(f"Event #{index} is not an object.")
        if event.get("excluded_from_map") is True or not is_map_attack(event):
            continue
        map_events.append({name: value for name, value in event.items() if name not in drop})

    output = {key: value for key, value in database.items() if key != "events"}
    output["events"] = map_events
    output["database_summary"] = database_summary(events)
    output["map"] = {
        "format": FORMAT,
        "filter": "executed attacks, attempted attacks and disrupted plots",
        "source_event_count": len(events),
        "excluded_fields": excluded,
    }
    return output


def validate(output: dict, database: dict) -> None:
    for index, event in enumerate(output["events"]):
        if not is_map_attack(event):
            raise ValueError(f"Map event #{index} is not an attack.")
        for name in lite.REQUIRED:
            if name not in event:
                raise ValueError(f"Map event #{index} lost required field {name}.")
    expected = sum(
        1 for event in database["events"]
        if isinstance(event, dict) and event.get("excluded_from_map") is not True and is_map_attack(event)
    )
    if len(output["events"]) != expected:
        raise ValueError(f"Map has {len(output['events'])} events but the source has {expected} attacks.")
    for key in database:
        if key != "events" and key not in output:
            raise ValueError(f"Top-level key {key} was dropped.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--input", default=str(ROOT / "events.json"))
    parser.add_argument("--output", default=str(ROOT / "events-map.json"))
    parser.add_argument("--excluded", default=str(lite.EXCLUDED_FILE))
    args = parser.parse_args(argv)

    try:
        source_bytes = Path(args.input).read_bytes()
        database = json.loads(source_bytes)
        if not isinstance(database, dict):
            raise ValueError("The source database is not a JSON object.")
        output = build_map(database, lite.load_excluded(Path(args.excluded)))
        validate(output, database)
        payload = json.dumps(output, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if json.loads(payload) != output:
            raise ValueError("The serialised map file does not round-trip.")
        lite.write_atomic(Path(args.output), payload)
    except (OSError, ValueError) as exc:
        print(f"events-map NOT built: {exc}", file=sys.stderr)
        return 1

    print(
        f"events-map: {len(output['events'])} attacks of {len(database['events'])} events, "
        f"{len(payload) / 1e6:.2f} MB (source {len(source_bytes) / 1e6:.1f} MB)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
