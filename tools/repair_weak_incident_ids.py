#!/usr/bin/env python3
"""Repair ambiguous short incident anchors in the Groq historical backfill.

An AI response like "p2" is a paragraph marker, not an incident identity.
Never count an Actions success as evidence of publication.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from collections import defaultdict
from pathlib import Path


def weak_anchor(value):
    anchor = str(value or "").strip().lower()
    return bool(re.fullmatch(r"(?:p|para|paragraph|item|row|event|article|ref)[-_ ]?\d{1,4}", anchor))


def anchor_id(anchor):
    normalized = re.sub(r"[^a-z0-9]+", " ", str(anchor).lower()).strip()
    return "inc-" + hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]


def repair(events):
    groups = defaultdict(list)
    for item in events:
        anchor = item.get("incident_anchor")
        if weak_anchor(anchor) and item.get("incident_id") == anchor_id(anchor):
            groups[item["incident_id"]].append(item)
    repaired = 0
    for incident_id, members in groups.items():
        # The same meaningless reference cannot substantiate that distinct
        # published records describe the same real-world event.
        if len(members) < 2:
            continue
        for item in members:
            record_id = str(item.get("id") or "")
            if not record_id:
                raise ValueError("Cannot repair an event lacking its durable record ID")
            item["incident_id"] = "inc-" + hashlib.sha256(
                ("groq-weak-anchor-record:" + record_id).encode("utf-8")
            ).hexdigest()[:16]
            repaired += 1
        print(f"Split {len(members)} ambiguous records previously grouped as {incident_id}")
    if len({str(e.get("id")) for e in events}) != len(events):
        raise ValueError("Duplicate event record IDs; refuse to write")
    return repaired


def main(path):
    source = Path(path)
    data = json.loads(source.read_text(encoding="utf-8"))
    events = data.get("events")
    if not isinstance(events, list):
        raise ValueError("Malformed Map database")
    count = repair(events)
    if count:
        source.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Ambiguous incident records rekeyed: {count}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "events.json")
