"""Shared, dependency-free rule for the map's attack points: one per incident.

Attack records are grouped by incident_id and only the record chosen below is
a point; the others are its updates. attack_update is derived at publication
time and never stored in events.json, because several jobs rewrite incident_id
and update_type after collection and a stored flag would go stale.

update_type is unreliable in both directions: a reaction piece can be labelled
INITIAL and a real attack FOLLOW_UP. It therefore only chooses the point and
proves nothing about timing, and an incident with no INITIAL keeps a point.

Two kinds of record read as attacks and are no points either, and carry the
same flag: hoaxes, and reports held until a second outlet carries them
(held_indexes). A held record stays in events.json and the Database.
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
# Google News re-dates old articles of an outlet when it re-indexes them, and
# the feed date is all the age gate sees: Haber 7 supplied 33 of the 39 Turkish
# points of 30 days and Orange Actualites what looks like the 2017 Rawda attack,
# dated 15 October 2026. Their sole-source reports are held, and so is any
# outlet's re-index: REINDEX_BURST_ITEMS different articles stamped with one minute.
HOLD_OUTLETS = frozenset({"haber 7", "orange actualités"})
REINDEX_BURST_ITEMS = 4
# Stored on a record the collector marked; the rule below is what decides.
HOLD_FIELD = "corroboration_hold"
GDELT_COLLECTOR = "GDELT DOC 2.0"
# The fields of a map point, as a sibling's city replaces them.
LOCATION_FIELDS = ("latitude", "longitude", "city", "region", "location_precision",
                   "location_confidence", "location_method", "location_evidence")
# Two city records this close are one place ('Karak' and 'Al-Karak').
SAME_PLACE_KM = 25.0
# A region's own coordinates are evidence, unlike a capital's: 12 devices found
# in Saxony stay in Saxony although a sibling names a town 483 km away.
REGION_SIBLING_KM = 150.0


def event_categories(event: dict) -> list[str]:
    raw = event.get("categories")
    if isinstance(raw, list) and raw:
        return [str(value) for value in raw]
    return [str(event["category"])] if event.get("category") else []


def is_hoax(event: dict) -> bool:
    return str(event.get("reported_status") or "").strip().upper() == "HOAX"


def _attack_by_type(event: dict) -> bool:
    event_type = str(event.get("primary_event_type") or "").strip().upper()
    if event_type:
        if event_type == "ATTACK":
            return event.get("is_attack") is True
        return event_type in MAP_TYPES
    return "Attacks" in event_categories(event)


def is_attack_record(event: dict) -> bool:
    """Executed attacks (ATTACK with is_attack), attempted attacks and disrupted plots, never a hoax."""
    return not is_hoax(event) and _attack_by_type(event)


def is_map_attack(event: dict) -> bool:
    """An attack record that is a point on the map, not an update of one."""
    return event.get("attack_update") is not True and is_attack_record(event)


def _parse_time(value) -> datetime | None:
    try:
        moment = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def published_at(event: dict) -> datetime | None:
    return _parse_time(event.get("published"))


def outlet_key(name) -> str:
    return " ".join(str(name or "").casefold().split())


def burst_key(article: dict) -> tuple | None:
    """(outlet, minute) of an article, or None when its stamp cannot show a
    burst: GDELT's says when it crawled the page, and date-only feeds stamp every
    item on the hour (07:00 or 08:00 UTC, 75% of the on-the-hour stamps stored)."""
    moment = _parse_time(article.get("primary_source_published") or article.get("published"))
    outlet = outlet_key(article.get("source"))
    if (not moment or not outlet or article.get("collector") == GDELT_COLLECTOR
            or (moment.minute == 0 and moment.second == 0)):
        return None
    return outlet, moment.astimezone(timezone.utc).replace(second=0, microsecond=0)


def reindex_bursts(articles) -> set:
    """burst_keys shared by REINDEX_BURST_ITEMS or more different headlines. The
    same article found again through other queries counts once."""
    headlines = defaultdict(set)
    for article in articles:
        title = " ".join(str(article.get("original_title") or article.get("title") or "").casefold().split())
        key = burst_key(article)
        if title and key:
            headlines[key].add(title)
    return {key for key, found in headlines.items() if len(found) >= REINDEX_BURST_ITEMS}


def _articles(event: dict) -> list[dict]:
    return [event, *(article for article in event.get("related_articles") or [] if isinstance(article, dict))]


def held_indexes(events: list) -> set[int]:
    """List positions of the records held for corroboration: a sole-source
    report of a HOLD_OUTLETS outlet, or of any outlet's re-index, marked at
    ingest or seen in the stored stamps. A second outlet anywhere in the incident
    releases them: nothing here is stored, so the next publication does it."""
    live = [(index, event) for index, event in enumerate(events)
            if isinstance(event, dict) and not is_retired_judicial_event(event)]
    bursts = reindex_bursts(article for _, event in live for article in _articles(event))
    outlets = defaultdict(set)
    incidents = {}
    for index, event in live:
        incidents[index] = str(event.get("incident_id") or "").strip() or index
        outlets[incidents[index]].update(outlet_key(article.get("source")) for article in _articles(event))
        outlets[incidents[index]].update(outlet_key(name) for name in event.get("sources") or [])
    return {index for index, event in live
            if len(outlets[incidents[index]] - {""}) < 2 and (
                event.get(HOLD_FIELD) or outlet_key(event.get("source")) in HOLD_OUTLETS
                or burst_key(event) in bursts)}


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
    """Positions of the attack records by incident_id, held reports aside; with
    no id, a record stands alone under its position."""
    held = held_indexes(events)
    groups = defaultdict(list)
    for index, event in enumerate(events):
        if (index not in held and isinstance(event, dict) and not is_retired_judicial_event(event)
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
    """List positions of the records that read as attacks but are not points:
    follow-ups, held reports and hoaxes. Positions, not ids: old event ids are
    not unique. Non-object and retired records are skipped, so the raw list and
    the active list flag the same records."""
    updates = held_indexes(events)
    for positions in attack_groups(events).values():
        updates.update(set(positions) - set(_points(events, positions)))
    updates.update(index for index, event in enumerate(events)
                   if isinstance(event, dict) and not is_retired_judicial_event(event)
                   and is_hoax(event) and _attack_by_type(active_event(event)))
    return updates


def sibling_locations(events: list) -> dict[int, int]:
    """Position of a point on a capital or a region -> position of the record
    whose city it should be drawn on: same incident, same country (false merges
    join Tartus to Kirkuk), and every such city of the incident is one place.
    Stored records stay as they are: the map file borrows the location."""
    def place_key(event):
        return str(event.get("incident_id") or "").strip(), event.get("country_code")

    cities = defaultdict(list)
    for index, event in enumerate(events):
        if (isinstance(event, dict) and not is_retired_judicial_event(event) and all(place_key(event))
                and _located(event) and event.get("location_precision") == "city"
                and not event.get("geolocation_review_required")):
            cities[place_key(event)].append(index)
    updates = attack_update_indexes(events)
    borrowed = {}
    for positions in attack_groups(events).values():
        for index in set(positions) - updates:
            event = events[index]
            precision = event.get("location_precision")
            if precision not in ("country_capital", "region") or not _located(event):
                continue
            siblings = [other for other in cities.get(place_key(event), ())
                        if (_distance_km(event, events[other]) or 0) > SAME_PLACE_KM]
            if not siblings or any((_distance_km(events[first], events[second]) or 0) > SAME_PLACE_KM
                                   for first in siblings for second in siblings):
                continue
            if precision == "region" and any((_distance_km(event, events[other]) or 0) > REGION_SIBLING_KM
                                             for other in siblings):
                continue
            borrowed[index] = min(siblings, key=lambda other: (published_at(events[other]) or _UNDATED, other))
    return borrowed
