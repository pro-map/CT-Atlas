#!/usr/bin/env python3
"""Apply the narrowly evidenced summary correction documented in issue #74.

Only the exact unsupported English summary is replaced. Original reporting,
identifiers, geography, relevance decisions, checkpoints and quotas are untouched.
This is not an assertion that no casualties occurred in the real incident.
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import tempfile
from pathlib import Path

RECORD_ID = "368efec8cff2082a"
ORIGINAL_TITLE = "13名士兵遭伏击，7名枪手全身而退：菲律宾巴西兰的枪声，打碎了什么？"
SOURCE = "搜狐网"
PUBLISHED = "2026-10-07T15:55:08+00:00"
OLD_SUMMARY = ("Thirteen Philippine soldiers were ambushed in Basilan, resulting in casualties, "
               "while seven gunmen withdrew without injury. The report does not identify the "
               "attackers but describes a violent incident.")
NEW_SUMMARY = ("The report describes an ambush involving 13 soldiers in Basilan, Philippines, "
               "and says seven gunmen escaped unharmed. The available excerpt does not identify the attackers.")


def correct_rows(value):
    count = 0
    if isinstance(value, list):
        return sum(correct_rows(row) for row in value)
    if not isinstance(value, dict):
        return 0
    same_source = (value.get("original_title") == ORIGINAL_TITLE
                   and value.get("source") == SOURCE and value.get("published") == PUBLISHED)
    if value.get("id") == RECORD_ID and not same_source:
        raise ValueError("Known record ID has changed source identity; refuse editorial overwrite")
    if same_source and value.get("summary") == OLD_SUMMARY:
        value["summary"] = NEW_SUMMARY
        count += 1
    # Known recovery representations only, not arbitrary metadata dictionaries.
    for field in ("events", "articles", "related_articles", "selected_event"):
        if field in value:
            count += correct_rows(value[field])
    return count


def atomic_write(path, raw):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + ".",
                                         suffix=".tmp", delete=False) as out:
            temporary = Path(out.name)
            out.write(raw)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def run(root, *, apply=False, defer_invalid_map=False):
    root = Path(root)
    database = root / "events.json"
    try:
        raw_map = database.read_bytes()
        payload = json.loads(raw_map)
        if not isinstance(payload, dict) or not isinstance(payload.get("events"), list) or not payload["events"]:
            raise ValueError("Invalid Map database")
    except (OSError, ValueError, UnicodeError):
        if not defer_invalid_map:
            raise
        report = {"issue": 74, "changed_summaries": 0, "applied": False,
                  "deferred_to_mandatory_publication_guard": True}
        print("SOURCE_FAITHFULNESS " + json.dumps(report))
        return report
    paths = sorted(set(root.glob("archive/gemini-chinese-map-selected-*.json")) |
                   set(root.glob("archive/gemini-chinese-map-reviews-*.json"))) + [database]
    changes = []
    for path in paths:
        before = raw_map if path == database else path.read_bytes()
        original = json.loads(before)
        expected = copy.deepcopy(original)
        count = correct_rows(expected)
        if not count:
            continue
        old, new = json.dumps(OLD_SUMMARY).encode(), json.dumps(NEW_SUMMARY).encode()
        # Preserve formatting and every other byte, rather than rewriting a large database.
        if before.count(old) != count:
            raise ValueError("Ambiguous textual occurrences; refuse replacement")
        after = before.replace(old, new)
        if json.loads(after) != expected:
            raise ValueError("Unexpected non-summary change; refuse replacement")
        changes.append((path, before, after, count))
    # Validate all files and identities before the first write. Recovery archives
    # go first; an interrupted database replace remains safely repeatable.
    if apply:
        for path, before, _, _ in changes:
            if path.read_bytes() != before:
                raise ValueError("Concurrent file change; refuse editorial write")
        for path, _, after, _ in changes:
            atomic_write(path, after)
    report = {"issue": 74, "applied": apply, "changed_summaries": sum(x[3] for x in changes),
              "files": {str(p.relative_to(root)): n for p, _, _, n in changes},
              "publication_confirmed": False}
    print("SOURCE_FAITHFULNESS " + json.dumps(report, sort_keys=True))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--defer-invalid-map", action="store_true",
                        help="Only before the workflow's mandatory guard, which restores invalid working Maps")
    args = parser.parse_args()
    run(args.root, apply=args.apply, defer_invalid_map=args.defer_invalid_map)


if __name__ == "__main__":
    main()
