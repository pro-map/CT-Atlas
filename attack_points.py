"""Shared, dependency-free rule for the map's attack points: one per incident.

Attack records are grouped by incident_id and only the record chosen below is
a point; the others are its updates. attack_update is derived at publication
time and never stored in events.json, because several jobs rewrite incident_id
and update_type after collection and a stored flag would go stale.

update_type is unreliable in both directions: a reaction piece can be labelled
INITIAL and a real attack FOLLOW_UP. It therefore only chooses the point and
proves nothing about timing, and an incident with no INITIAL keeps a point.
"""
from __future__ import annotations

import math
import re
from collections import defaultdict
from datetime import datetime, timezone

from retired_categories import active_event, is_retired_judicial_event

MAP_TYPES = ("ATTACK", "ATTEMPTED_ATTACK", "DISRUPTED_PLOT")
# Consolidation over-merges now and then: a later INITIAL further than both of
# these from every point is another attack. SPLIT_DAYS is collector.py's
# INCIDENT_INITIAL_MERGE_DAYS.
SPLIT_DAYS = 3.0
SPLIT_KM = 100.0
_ANCHOR_YEAR = re.compile(r"(?<!\d)((?:19|20)\d{2})(?!\d)")
_UNDATED = datetime.max.replace(tzinfo=timezone.utc)


def event_categories(event: dict) -> list[str]:
    raw = event.get("categories")
    if isinstance(raw, list) and raw:
        return [str(value) for value in raw]
    return [str(event["category"])] if event.get("category") else []


def is_attack_record(event: dict) -> bool:
    """Executed attacks (ATTACK with is_attack), attempted attacks and disrupted plots."""
    event_type = str(event.get("primary_event_type") or "").strip().upper()
    if event_type:
        if event_type == "ATTACK":
            return event.get("is_attack") is True
        return event_type in MAP_TYPES
    return "Attacks" in event_categories(event)


def is_map_attack(event: dict) -> bool:
    """An attack record that is a point on the map, not an update of one."""
    return event.get("attack_update") is not True and is_attack_record(event)


def published_at(event: dict) -> datetime | None:
    try:
        value = datetime.fromisoformat(str(event.get("published") or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def is_initial(event: dict) -> bool:
    return str(event.get("update_type") or "").strip().upper() in ("", "INITIAL")


def is_historic_update(event: dict) -> bool:
    """A follow-up whose own anchor dates the attack to an earlier calendar year."""
    published = published_at(event)
    years = [int(year) for year in _ANCHOR_YEAR.findall(str(event.get("incident_anchor") or ""))]
    return not is_initial(event) and bool(published and years) and max(years) < published.year


def _located(event: dict) -> bool:
    return (event.get("excluded_from_map") is not True and event.get("location_precision") != "unlocated"
            and event.get("latitude") is not None and event.get("longitude") is not None)


def _distance_km(first: dict, second: dict) -> float | None:
    try:
        lat1, lon1, lat2, lon2 = (math.radians(float(value)) for value in (
            first["latitude"], first["longitude"], second["latitude"], second["longitude"]))
    except (TypeError, ValueError):
        return None
    half_chord = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(half_chord))


def _separate_attacks(first: dict, second: dict) -> bool:
    first_time, second_time = published_at(first), published_at(second)
    if not (first_time and second_time and _located(first) and _located(second)):
        return False
    if abs((first_time - second_time).total_seconds()) <= SPLIT_DAYS * 86400:
        return False
    distance = _distance_km(first, second)
    return distance is not None and distance > SPLIT_KM


def attack_groups(events: list) -> dict:
    """Positions of the attack records by incident_id; with none, a record stands alone under its position."""
    groups = defaultdict(list)
    for index, event in enumerate(events):
        if (isinstance(event, dict) and not is_retired_judicial_event(event)
                and is_attack_record(active_event(event))):
            groups[str(event.get("incident_id") or "").strip() or index].append(index)
    return groups


def _points(events: list, positions: list[int]) -> list[int]:
    ordered = sorted(positions, key=lambda index: (
        published_at(events[index]) or _UNDATED, not _located(events[index]), str(events[index].get("id")), index))
    initials = [index for index in ordered if is_initial(events[index])]
    current = [index for index in ordered if not is_historic_update(events[index])]
    candidates = initials or current
    if not candidates:
        return []
    points = candidates[:1]
    for index in initials[1:]:
        if all(_separate_attacks(events[index], events[point]) for point in points):
            points.append(index)
    if not _located(events[points[0]]):
        points[0] = next((index for index in initials + current if _located(events[index])), points[0])
    return points


def attack_update_indexes(events: list) -> set[int]:
    """List positions of the attack records that are not points. Positions, not
    ids: old event ids are not unique. Non-object and retired records are skipped,
    so the raw list and the active list flag the same records."""
    updates: set[int] = set()
    for positions in attack_groups(events).values():
        updates.update(set(positions) - set(_points(events, positions)))
    return updates
