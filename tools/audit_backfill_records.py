#!/usr/bin/env python3
"""Read-only record-identity audit. No model/network calls or database writes."""
import ast
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
    source_counts = {key: len({canonical({f: e.get(f) for f in ("url", "original_title", "published")})
                              for e in members}) for key, members in repeated.items()}
    print("AUDIT_TOTAL " + canonical({
        "blob_sha": hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest(),
        "records": len(events), "distinct_record_ids": len(groups),
        "reused_record_id_groups": len(repeated),
        "affected_records": sum(map(len, repeated.values())),
        "exact_duplicate_copies": sum(v - 1 for v in exact.values()),
        "ambiguous_same_source_groups": [k for k, v in repeated.items() if source_counts[k] != len(v)],
        "missing_ids": len(groups.get("", [])),
    }))
    for number, (key, members) in enumerate(sorted(repeated.items(), key=lambda x: (-len(x[1]), x[0]))):
        all_fields = set().union(*(set(e) for e in members))
        differences = [f for f in sorted(all_fields)
                       if len({canonical(e.get(f)) for e in members}) > 1]
        sample_fields = ("id", "incident_id", "title", "original_title", "published",
                         "country", "city", "latitude", "longitude", "primary_event_type", "update_type")
        samples = [{f: e[f] for f in sample_fields if f in e} for e in members[:2]] if number < 2 else []
        print("AUDIT_GROUP " + canonical({"id": key, "records": len(members),
              "source_identities": source_counts[key], "samples": samples}))
    saved = defaultdict(Counter)
    for path in Path("archive").glob("*-selected-*.json"):
        data = json.loads(path.read_text(encoding="utf-8"))
        for e in data.get("events", []):
            key = str(e.get("id") or "")
            if key in repeated:
                saved[key][path.name] += 1
    print("AUDIT_REPLAY " + canonical(saved))
    source = Path("collector.py").read_text(encoding="utf-8")
    nodes = [n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef)]
    print("AUDIT_ID_FUNCTIONS " + canonical([{"name": n.name, "line": n.lineno, "end": n.end_lineno}
          for n in nodes if "id" in n.name or "metadata" in n.name]))
    for node in nodes:
        if node.name in {"ensure_event_metadata", "unused_event_id", "generate_id", "event_id", "make_id", "generate_event_id"}:
            print("AUDIT_CODE " + node.name + "\n" + ast.get_source_segment(source, node))


if __name__ == "__main__":
    main()
