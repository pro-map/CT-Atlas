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

The map shows one point per attack incident (attack_points.py). The other
attack records of an incident are stamped attack_update and travel with
recent_events, as non-attacks: the map never draws them, but the header's
casualty counts and the Key Developments still reach them. Reports held for
corroboration are stamped too and stay out of this file, so nothing here counts
them; a Key Development citing one still links to it. A point on a capital or a
region is drawn on its incident's city when attack_points.sibling_locations
finds one: location_from_record names the record that lent it, and events.json
keeps its own location.

recent_events carries the last RECENT_DAYS of every OTHER category: the map
draws them when "Show on map" asks for all events or one of those categories
(its periods are 24h, 7 days, 30 days, 90 days and 180 days), the header's terrorists killed/captured
counts come from counter-terrorism and arrest reports, and the 24h Key
Developments link to events of any category -- all without downloading the
whole database.

The retired Judicial collection never enters either event array or the
database summary, even when publishing a pre-migration source snapshot.

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
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from attack_points import (  # noqa: E402
    LOCATION_FIELDS, attack_groups, attack_update_indexes, duplicate_point_indexes, event_categories, held_indexes,
    is_attack_record, is_historic_update, is_map_attack, published_at, sibling_locations,
)
from retired_categories import active_event, is_retired_judicial_event  # noqa: E402
FORMAT = "events-map-v1"
# The map's longest period (180 days) plus a day of slack: the site is
# republished at least twice a day. Also covers the header's casualty window
# (yesterday's full Paris day).
RECENT_DAYS = 181

_spec = importlib.util.spec_from_file_location("build_events_lite", Path(__file__).resolve().parent / "build_events_lite.py")
lite = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lite)


def database_summary(events: list[dict]) -> dict:
    visible = [active_event(event) for event in events if event.get("excluded_from_map") is not True
               and not is_retired_judicial_event(event)]
    by_category = Counter(event_categories(event)[0] for event in visible if event_categories(event))
    return {
        "total_events": len(visible),
        "by_category": dict(by_category.most_common()),
    }


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
    drop = {*excluded, *lite.DERIVED_FIELDS}
    updates = attack_update_indexes(events)
    held = held_indexes(events)
    borrowed = sibling_locations(events)
    map_events = []
    recent_events = []
    for index, event in enumerate(events):
        if not isinstance(event, dict):
            raise ValueError(f"Event #{index} is not an object.")
        if is_retired_judicial_event(event):
            continue
        event = active_event(event)
        lite_event = {name: value for name, value in event.items() if name not in drop}
        if index in updates:
            lite_event["attack_update"] = True
        if index in held:
            lite_event["held_for_corroboration"] = True
        if index in borrowed:
            lender = active_event(events[borrowed[index]])
            lite_event.update({name: lender.get(name) for name in LOCATION_FIELDS},
                              location_from_record=lender.get("id"))
        if is_attack_record(event) and index not in updates:
            # Unlocated attacks (excluded_from_map) stay too: the map never
            # draws them, but the ticker, the header's casualty counts and the
            # Key Development links still need them, as with the full file.
            map_events.append(lite_event)
        else:
            published = published_at(event)
            recent = published and published >= recent_cutoff and index not in held
            if recent or str(event.get("id") or "") in cited_ids:
                recent_events.append(lite_event)

    output = {key: value for key, value in database.items() if key != "events"}
    output["events"] = map_events
    output["recent_events"] = recent_events
    output["database_summary"] = database_summary(events)
    if "number_of_events" in output:
        output["number_of_events"] = sum(not is_retired_judicial_event(event) for event in events)
    output["map"] = {
        "format": FORMAT,
        "filter": "executed attacks, attempted attacks and disrupted plots",
        "recent_events_days": RECENT_DAYS,
        "source_event_count": len(events),
        "retired_judicial_count": sum(is_retired_judicial_event(event) for event in events),
        "excluded_fields": excluded,
    }
    return output


def validate(output: dict, database: dict) -> None:
    for index, event in enumerate(output["events"]):
        if is_retired_judicial_event(event):
            raise ValueError(f"Map event #{index} belongs to the retired Judicial collection.")
        if event.get("attack_update") is True:
            raise ValueError(f"Map event #{index} is a follow-up; follow-ups belong in recent_events.")
        if not is_map_attack(event):
            raise ValueError(f"Map event #{index} is not an attack.")
        for name in lite.REQUIRED:
            if name not in event:
                raise ValueError(f"Map event #{index} lost required field {name}.")
    for index, event in enumerate(output["recent_events"]):
        if is_retired_judicial_event(event):
            raise ValueError(f"Recent event #{index} belongs to the retired Judicial collection.")
        if is_map_attack(event):
            raise ValueError(f"Recent event #{index} is an attack; attacks belong in events.")
    source = database["events"]
    groups = attack_groups(source)
    updates = attack_update_indexes(source)
    expected = sum(index not in updates for positions in groups.values() for index in positions)
    if len(output["events"]) != expected:
        raise ValueError(f"Map has {len(output['events'])} events but the source has {expected} attack points.")
    pointed = {str(event.get("incident_id") or "").strip() for event in output["events"]}
    duplicates = duplicate_point_indexes(source)
    for incident, positions in groups.items():
        # A record with no incident_id is keyed by position: the count above covers it.
        if (isinstance(incident, str) and incident not in pointed and not duplicates & set(positions)
                and not all(is_historic_update(source[index]) for index in positions)):
            raise ValueError(f"Incident {incident} has lost its attack point.")
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

