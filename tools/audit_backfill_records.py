#!/usr/bin/env python3
"""Read-only record-identity audit. No model/network calls or database writes."""
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def main():
    raw = Path("events.json").read_bytes()
    events = json.loads(raw)["events"]
    groups = defaultdict(list)
    for e in events:
        groups[str(e.get("id") or "")].append(e)
    repeated = {k: v for k, v in groups.items() if len(v) > 1}
    exact = Counter(canonical(e) for e in events)
    print("AUDIT_TOTAL " + canonical({
        "blob_sha": hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest(),
        "records": len(events), "distinct_record_ids": len(groups),
        "reused_record_id_groups": len(repeated),
        "exact_duplicate_copies": sum(v - 1 for v in exact.values()),
        "missing_ids": len(groups.get("", [])),
    }))
    for key, members in sorted(repeated.items(), key=lambda x: (-len(x[1]), x[0])):
        all_fields = set().union(*(set(e) for e in members))
        differences = [f for f in sorted(all_fields)
                       if len({canonical(e.get(f)) for e in members}) > 1]
        identities = {canonical({f: e.get(f) for f in ("url", "original_title", "published")})
                      for e in members}
        variants = list({canonical(e): e for e in members}.values())
        sample_fields = ("id", "incident_id", "title", "original_title", "url", "published",
                         "country", "city", "latitude", "longitude", "ai_selected",
                         "primary_event_type", "update_type", "parent_event_id", "split_from_id")
        samples = [{f: e[f] for f in sample_fields if f in e} for e in variants[:2]]
        print("AUDIT_GROUP " + canonical({"id": key, "copies": len(members),
              "full_variants": len(variants), "source_identities": len(identities),
              "differing_fields": differences, "samples": samples}))
    saved = defaultdict(Counter)
    for path in Path("archive").glob("*-selected-*.json"):
        data = json.loads(path.read_text(encoding="utf-8"))
        for e in data.get("events", []):
            key = str(e.get("id") or "")
            if key in repeated:
                saved[key][path.name] += 1
    print("AUDIT_REPLAY " + canonical(saved))


if __name__ == "__main__":
    main()
