#!/usr/bin/env python3
"""Fail-closed commit guard for the Groq public-news historical workflow.

Never calls a model or changes a quota/checkpoint. On an incomplete validation
path, save the working bytes as a recovery artifact and restore the baseline.
A ready working copy is NOT a confirmed deployment or a new unique incident.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

STATUS = "archive/groq-publication-guard-status.json"


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def parse_map(raw):
    def invalid_constant(value):
        raise ValueError("Non-finite JSON value")
    data = json.loads(raw, parse_constant=invalid_constant)
    events = data.get("events") if isinstance(data, dict) else None
    if not isinstance(events, list) or not events:
        raise ValueError("Missing or empty Map database")
    ids = [e.get("id") if isinstance(e, dict) else None for e in events]
    if any(not isinstance(i, str) or not i.strip() for i in ids) or len(set(ids)) != len(ids):
        raise ValueError("Missing, invalid or colliding record IDs")
    return data


def atomic_bytes(path, raw):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
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


def snapshot(database, baseline):
    raw = Path(database).read_bytes()
    parse_map(raw)
    atomic_bytes(baseline, raw)


def geo_fields(event):
    fixed = {"latitude", "longitude", "country", "country_code", "city", "region",
             "excluded_from_map"}
    return {k: v for k, v in event.items()
            if k in fixed or k.startswith(("ai_geo_", "location_"))}


def located(event):
    values = [event.get("latitude"), event.get("longitude")]
    if any(isinstance(v, bool) or v is None for v in values):
        return False
    try:
        lat, lon = map(float, values)
        return (math.isfinite(lat) and math.isfinite(lon)
                and -90 <= lat <= 90 and -180 <= lon <= 180)
    except (ValueError, TypeError, OverflowError):
        return False


def assess(before, after, outcomes, new_count):
    required = ("baseline", "new_events", "quarantine")
    if any(outcomes.get(k) != "success" for k in required):
        return "validation_path_incomplete"
    if any(outcomes.get(k) not in ("success", "skipped") for k in ("specialists", "chinese")):
        return "enrichment_incomplete"
    if not isinstance(new_count, str) or not new_count.isdecimal():
        return "new_count_missing_or_invalid"
    count = int(new_count)
    if outcomes.get("geo") != "success" and not (count == 0 and outcomes.get("geo") == "skipped"):
        return "geolocation_incomplete"
    previous = {e["id"]: e for e in before["events"]}
    new = [e for e in after["events"] if e["id"] not in previous]
    if len(new) > count:
        return "new_count_mismatch"
    for event in after["events"]:
        old = previous.get(event["id"])
        if old is not None and geo_fields(event) != geo_fields(old):
            return "protected_geography_changed"
    if any(not located(e) or e.get("ai_geo_complete") is not True for e in new):
        return "new_record_geolocation_unvalidated"
    return "validated_working_copy"


def git_baseline(database):
    # Local read only. No credentials, network calls or workflow dispatch.
    return subprocess.run(["git", "show", "HEAD:events.json"], cwd=Path(database).parent,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          check=True).stdout


def finalize(database, baseline, backup, status, outcomes, new_count, *, fallback=git_baseline):
    database, baseline = Path(database), Path(baseline)
    current_raw = database.read_bytes() if database.exists() else b""
    used_snapshot = False
    if outcomes.get("baseline") == "success":
        try:
            before_raw = baseline.read_bytes()
            before = parse_map(before_raw)
            used_snapshot = True
        except (OSError, ValueError, TypeError):
            pass
    if not used_snapshot:
        before_raw = fallback(database)
        before = parse_map(before_raw)
    reason = "baseline_snapshot_unavailable"
    if used_snapshot:
        try:
            after = parse_map(current_raw)
            reason = assess(before, after, outcomes, new_count)
        except (ValueError, TypeError, UnicodeError):
            reason = "working_copy_invalid"
    ready = reason == "validated_working_copy"
    saved_backup = False
    if not ready and current_raw != before_raw:
        # Back up BEFORE any restore. Failure here stops the commit, not evidence retention.
        atomic_bytes(backup, current_raw)
        saved_backup = True
        atomic_bytes(database, before_raw)
    final_raw = database.read_bytes()
    final = parse_map(final_raw)
    previous_ids = {e["id"] for e in before["events"]}
    report = {
        "version": 1, "updated_at": datetime.now(timezone.utc).isoformat(),
        "run_id": os.getenv("GITHUB_RUN_ID", ""),
        "publication_ready": ready, "publication_confirmed": False,
        "reason": reason, "baseline_snapshot_used": used_snapshot,
        "baseline_sha256": digest(before_raw), "final_map_sha256": digest(final_raw),
        "working_copy_sha256": digest(current_raw), "recovery_copy_saved": saved_backup,
        "records": len(final["events"]),
        "new_validated_records": sum(e["id"] not in previous_ids for e in final["events"]),
        "note": "Validation and record IDs are not proof of deployed unique real-world incidents.",
    }
    atomic_bytes(status, (json.dumps(report, indent=2) + "\n").encode())
    print("PUBLICATION_GUARD " + json.dumps(report, sort_keys=True))
    return report


def verify(database, status):
    raw = Path(database).read_bytes()
    parse_map(raw)
    report = json.loads(Path(status).read_text(encoding="utf-8"))
    if report.get("version") != 1 or report.get("final_map_sha256") != digest(raw):
        raise ValueError("Map changed after the final publication guard; refuse commit")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("snapshot", "finalize", "verify"))
    parser.add_argument("--database", default="events.json")
    parser.add_argument("--baseline", default=os.getenv("MAP_BASELINE", ""))
    parser.add_argument("--backup", default=os.getenv("MAP_UNVALIDATED", ""))
    parser.add_argument("--status", default=STATUS)
    args = parser.parse_args()
    if args.mode == "snapshot":
        if not args.baseline:
            parser.error("A baseline path is required")
        snapshot(args.database, args.baseline)
    elif args.mode == "verify":
        verify(args.database, args.status)
    else:
        if not args.baseline or not args.backup:
            parser.error("Baseline and recovery-copy paths are required")
        outcomes = {k: os.getenv("GUARD_" + k.upper(), "")
                    for k in ("baseline", "specialists", "chinese", "new_events", "geo", "quarantine")}
        report = finalize(args.database, args.baseline, args.backup, args.status,
                          outcomes, os.getenv("GUARD_NEW_COUNT", ""))
        if os.getenv("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as out:
                out.write("publication_ready=" + str(report["publication_ready"]).lower() + "\n")


if __name__ == "__main__":
    main()
