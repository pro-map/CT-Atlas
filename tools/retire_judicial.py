#!/usr/bin/env python3
"""Retire Judicial records without AI calls, after preserving full evidence.

Run once on main under the same write lock as collection. It is idempotent
and also strips the old secondary label from genuine operational records.
"""
from __future__ import annotations

import argparse
from collections import Counter
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from retired_categories import active_event, is_judicial_category, is_retired_judicial_event  # noqa: E402

DEFAULT_ARCHIVE = "archive/removed-events-judicial-retired-20261014.json"
RETIREMENT_REASON = "retired Judicial collection; preserved evidence outside the active map/database"


def _digest(event):
    original = {key: value for key, value in event.items() if key != "_cleanup_reason"}
    return hashlib.sha256(json.dumps(original, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def atomic_json_write(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as output:
            json.dump(data, output, ensure_ascii=False, indent=2)
            output.write("\n")
        os.replace(name, path)
    except BaseException:
        Path(name).unlink(missing_ok=True)
        raise


def partition(database):
    events = database.get("events")
    if not isinstance(events, list) or not events:
        raise ValueError("Refusing to migrate an empty or malformed event database.")
    if any(not isinstance(event, dict) for event in events):
        raise ValueError("Every event must be an object.")
    retired, active = [], []
    for event in events:
        if is_retired_judicial_event(event):
            retired.append(deepcopy(event))
        else:
            active.append(active_event(event))
    if not active:
        raise ValueError("Retirement would empty the active database; refusing migration.")
    return active, retired


def migrate(input_path: Path, archive_path: Path, *, dry_run=False, now=None):
    database = json.loads(input_path.read_text(encoding="utf-8"))
    if not isinstance(database, dict):
        raise ValueError("The event database must be an object.")
    active, retired = partition(database)
    cleaned = sum(original != changed for original, changed in zip(
        [event for event in database["events"] if not is_retired_judicial_event(event)], active
    ))
    report = {"retired": len(retired), "cleaned": cleaned, "active": len(active)}
    if dry_run or not (retired or cleaned):
        return report

    timestamp = (now or datetime.now(timezone.utc)).isoformat()
    # Archive first. If this write fails, the source database stays untouched.
    if retired:
        archive = json.loads(archive_path.read_text(encoding="utf-8")) if archive_path.exists() else {}
        if not isinstance(archive, dict):
            raise ValueError("Existing retirement archive is not an object; source database left untouched.")
        archived = archive.get("events", [])
        if not isinstance(archived, list) or any(not isinstance(event, dict) for event in archived):
            raise ValueError("Existing retirement archive is malformed; source database left untouched.")
        known = Counter(_digest(event) for event in archived)
        seen = Counter()
        for event in retired:
            digest = _digest(event)
            seen[digest] += 1
            if seen[digest] > known[digest]:
                archived.append({**event, "_cleanup_reason": RETIREMENT_REASON})
        preserved = Counter(_digest(event) for event in archived)
        if any(preserved[digest] < count for digest, count in seen.items()):
            raise ValueError("Retirement evidence validation failed; source database left untouched.")
        archive.update({"removed_at": timestamp, "reason": RETIREMENT_REASON, "events": archived})
        archive.setdefault("previous_trend_summary", database.get("trend_summary", {}))
        archive.setdefault("previous_weekly_analysis", database.get("weekly_analysis", {}))
        atomic_json_write(archive_path, archive)
        # Verify the persisted evidence, not just the in-memory archive.
        saved = json.loads(archive_path.read_text(encoding="utf-8"))
        counts = Counter(_digest(event) for event in saved["events"])
        if any(counts[digest] < count for digest, count in seen.items()):
            raise ValueError("Persisted archive is incomplete; source database left untouched.")

    database["events"] = active
    database["number_of_events"] = len(active)
    database["last_updated"] = timestamp
    database["category_retirement"] = {"category": "Legal / Judicial", "applied_at": timestamp, **report}
    # A cached weekly AI text contains old category counts; preserve it in the
    # evidence archive and let the ordinary daily workflow regenerate it.
    database["weekly_analysis"] = {}
    trend = database.get("trend_summary")
    if isinstance(trend, dict) and isinstance(trend.get("developments"), list):
        active_ids = {str(event.get("id") or "") for event in active}
        trend["developments"] = [item for item in trend["developments"] if isinstance(item, dict)
            and str(item.get("event_id") or "") in active_ids
            and not is_judicial_category(item.get("category"))]
    atomic_json_write(input_path, database)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--input", default=str(ROOT / "events.json"))
    parser.add_argument("--archive", default=str(ROOT / DEFAULT_ARCHIVE))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    try:
        report = migrate(Path(args.input), Path(args.archive), dry_run=args.dry_run)
    except (OSError, ValueError) as error:
        print(f"Judicial retirement failed: {error}", file=sys.stderr)
        return 1
    print("Judicial retirement " + json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
