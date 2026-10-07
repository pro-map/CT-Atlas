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

recent_events carries the last RECENT_DAYS of every OTHER category: the map
draws them when "Show on map" asks for all events or one of those categories
(its periods are 24h, 7 days, 30 days and 90 days), the header's terrorists killed/captured
counts come from counter-terrorism and arrest reports, and the 24h Key
Developments link to events of any category -- all without downloading the
whole database.

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
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FORMAT = "events-map-v1"
MAP_TYPES = ("ATTACK", "ATTEMPTED_ATTACK", "DISRUPTED_PLOT")
# The map's longest period (90 days) plus a day of slack: the site is
# republished at least twice a day. Also covers the header's casualty window
# (yesterday's full Paris day).
RECENT_DAYS = 91

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


def published_at(event: dict) -> datetime | None:
    try:
        value = datetime.fromisoformat(str(event.get("published") or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def development_event_ids(database: dict) -> set[str]:
    """Event ids the Situation brief's key developments link to."""
    summary = database.get("trend_summary")
    developments = summary.get("developments") if isinstance(summary, dict) else None
    if not isinstance(developments, list):
        return set()
    return {
        str(item["event_id"])
        for item in developments
        if isinstance(item, dict) and item.get("event_id")
    }


def build_map(database: dict, excluded: list[str], now: datetime | None = None) -> dict:
    events = database.get("events")
    if not isinstance(events, list) or not events:
        raise ValueError("The source database has no events; refusing to build the map file.")

    recent_cutoff = (now or datetime.now(timezone.utc)) - timedelta(days=RECENT_DAYS)
    # A development can cite an event first published before the recent
    # window (a materially updated incident): keep it so its link still opens.
    cited_ids = development_event_ids(database)
    drop = set(excluded)
    map_events = []
    recent_events = []
    for index, event in enumerate(events):
        if not isinstance(event, dict):
            raise ValueError(f"Event #{index} is not an object.")
        lite_event = {name: value for name, value in event.items() if name not in drop}
        if is_map_attack(event):
            # Unlocated attacks (excluded_from_map) stay too: the map never
            # draws them, but the ticker, the header's casualty counts and the
            # Key Development links still need them, as with the full file.
            map_events.append(lite_event)
        else:
            published = published_at(event)
            if (published and published >= recent_cutoff) or str(event.get("id") or "") in cited_ids:
                recent_events.append(lite_event)

    output = {key: value for key, value in database.items() if key != "events"}
    output["events"] = map_events
    output["recent_events"] = recent_events
    output["database_summary"] = database_summary(events)
    output["map"] = {
        "format": FORMAT,
        "filter": "executed attacks, attempted attacks and disrupted plots",
        "recent_events_days": RECENT_DAYS,
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
    for index, event in enumerate(output["recent_events"]):
        if is_map_attack(event):
            raise ValueError(f"Recent event #{index} is an attack; attacks belong in events.")
    expected = sum(1 for event in database["events"] if isinstance(event, dict) and is_map_attack(event))
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
        f"events-map: {len(output['events'])} attacks + {len(output['recent_events'])} recent other events "
        f"of {len(database['events'])}, {len(payload) / 1e6:.2f} MB (source {len(source_bytes) / 1e6:.1f} MB)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

