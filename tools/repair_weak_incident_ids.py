#!/usr/bin/env python3
"""Repair raw paragraph-marker incident hashes without changing Map records.

Run before history replay and again before committing, including on failure.
An isolated 'p2' is unsafe too: tomorrow's unrelated 'p2' must not collide.
Already consolidated incident IDs are left alone. No network or model calls.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import tempfile
import unicodedata
from collections import Counter
from pathlib import Path


def weak_anchor(value):
    anchor = unicodedata.normalize("NFKD", str(value or "")).strip().lower()
    return bool(re.fullmatch(r"(?:p|para|paragraph|item|row|event|article|ref)[-_ ]?\d{1,4}", anchor))


def anchor_id(anchor):
    normalized = unicodedata.normalize("NFKD", str(anchor))
    normalized = "".join(ch for ch in normalized if not unicodedata.combining(ch))
    normalized = re.sub(r"[^a-z0-9]+", " ", normalized.lower()).strip()
    return "inc-" + hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]


def record_incident_id(record_id):
    return "inc-" + hashlib.sha256(
        ("groq-weak-anchor-record:" + str(record_id)).encode("utf-8")
    ).hexdigest()[:16]


def repair(events):
    """Only replace raw weak-anchor hashes, with all checks before mutation.

    Legacy duplicate record IDs unrelated to this repair are not deleted or
    rewritten. An affected record must have a unique durable ID; ambiguity
    there stops the write rather than inventing an identity from list order.
    """
    if not isinstance(events, list) or any(not isinstance(e, dict) for e in events):
        raise ValueError("Malformed Map events")
    counts = Counter(str(e.get("id") or "") for e in events)
    changes = []
    for item in events:
        anchor = item.get("incident_anchor")
        if not weak_anchor(anchor) or item.get("incident_id") != anchor_id(anchor):
            continue
        record_id = str(item.get("id") or "")
        if not record_id or counts[record_id] != 1:
            raise ValueError("Affected weak-anchor record lacks a unique durable ID")
        new_id = record_incident_id(record_id)
        if any(e is not item and e.get("incident_id") == new_id for e in events):
            raise ValueError("Replacement incident ID is already assigned; refuse collision")
        changes.append((item, item["incident_id"], new_id))
    for item, old_id, new_id in changes:
        item["incident_id"] = new_id
        print(f"Rekeyed record {item['id']}: {old_id} -> {new_id}")
    return len(changes)


def main(path):
    source = Path(path)
    data = json.loads(source.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("events"), list) or not data["events"]:
        raise ValueError("Malformed or empty Map database")
    count = repair(data["events"])
    if count:
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=source.parent,
                                             prefix=source.name + ".", suffix=".tmp", delete=False) as handle:
                temporary = Path(handle.name)
                json.dump(data, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary, source.stat().st_mode & 0o777)
            os.replace(temporary, source)
        finally:
            if temporary is not None and temporary.exists():
                temporary.unlink()
    print(f"Weak-anchor incident records rekeyed: {count}; Map records preserved: {len(data['events'])}")
    return count


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "events.json")
