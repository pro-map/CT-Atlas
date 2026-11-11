#!/usr/bin/env python3
"""Publish honest daily progress without replacing data after a failed collector.

Run after selection and geolocation, including after failed/skipped steps. A
failed collection restores the Git version of events.json before adding only
collection_status. Current-attempt telemetry is never confused with an older
successful run, and unlocated decisions are distinct from pending decisions.
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import os
import statistics
import sys
import tempfile
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from daily_reliability import PACIFIC, recovery_wanted
import events_store

LANES = ("recent", "backlog", "maintenance")
DERIVED_REASONS = {"recent_pending", "backlog_pending", "maintenance_pending", "category_pending",
                   "geolocation_pending", "geolocation_review_required", "source_errors", "radnuc_background_partial"}
DAY = timedelta(hours=24)
MEDIAN_DAYS = 14
# Run health. On the 46 stored runs from 14 October to 5 November 2026 these give
# 38 healthy, 4 degraded and 4 starved: 16 October, both runs of 5 November and the
# failed collection of 30 October. The lowest healthy events ratio was 0.56.
STARVED_EVENTS_RATIO = 0.25      # events of the last 24 h against the 14-day median
DEGRADED_EVENTS_RATIO = 0.50
STARVED_REVIEW_SHARE = 0.10      # new reviews / (new reviews + recent articles waiting)
DEGRADED_REVIEW_SHARE = 0.50
STARVED_MIN_WAITING = 100        # a handful of waiting articles starves nothing
DEGRADED_MIN_WAITING = 600


def timestamp(value):
    try:
        parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def read_object(path):
    if path is None or not Path(path).exists():
        return {}
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{Path(path).name} must be a JSON object")
    return value


def fresh(value, started_at):
    if not isinstance(value, dict):
        return False
    recorded = timestamp(value.get("run_started_at") or value.get("last_attempt_at"))
    return recorded is not None and recorded >= timestamp(started_at)


def count(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def known_lane(value):
    if not isinstance(value, dict):
        return False
    candidates, reviewed, pending = (count(value.get(name)) for name in ("candidates", "reviewed", "pending"))
    return None not in (candidates, reviewed, pending) and reviewed + pending == candidates


def located(event):
    lat, lon = event.get("latitude"), event.get("longitude")
    if isinstance(lat, bool) or isinstance(lon, bool):
        return False
    try:
        lat, lon = float(lat), float(lon)
        return math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180
    except (TypeError, ValueError):
        return False


def restore_database(path, repository):
    """Restore first: a partial/invalid collector swap can never reach the site.
    events_store rebuilds the committed events.json in every layout (docs/STORAGE_MIGRATION.md)."""
    relative = path.resolve().relative_to(repository.resolve())
    events_store.restore(repository.resolve(), relative)


def baseline_database(path, repository):
    relative = path.resolve().relative_to(repository.resolve())
    value = json.loads(events_store.committed_bytes(repository.resolve(), relative).decode("utf-8"))
    if not isinstance(value, dict) or not isinstance(value.get("events"), list):
        raise ValueError("The published database is invalid")
    return value


def atomic_write(path, value):
    handle, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def run_health(status, events):
    """Whether this run kept the map current, apart from the permanent 'partial':
    the older queue, category work and locations awaiting review are always open.

    Events are counted by publication date up to the start of the run, not up to
    now (a long gap is not starvation) or last_updated (repairs move it). The
    median of the 14 days before is read from the same database, so it needs no
    history. It runs higher than the live count, which has not caught up yet.
    """
    until = timestamp(status.get("last_attempt_at")) or datetime.now(timezone.utc)
    published = [when for when in (timestamp(event.get("published")) for event in events) if when]
    last_24h = sum(when >= until - DAY for when in published)
    days = Counter((until - when) // DAY for when in published if when < until - DAY)
    median = statistics.median(days[day] for day in range(1, MEDIAN_DAYS + 1))
    recent = status.get("recent") if isinstance(status.get("recent"), dict) else {}
    new_reviews, waiting = count(recent.get("new_reviews")), count(recent.get("pending"))
    share = (new_reviews / (new_reviews + waiting) if new_reviews is not None and waiting is not None
             and new_reviews + waiting else None)
    starved, degraded = [], []
    if status.get("collect_outcome") not in (None, "success"):
        starved.append("collection_failed")
    if median and last_24h < STARVED_EVENTS_RATIO * median:
        starved.append("few_events_published")
    elif median and last_24h < DEGRADED_EVENTS_RATIO * median:
        degraded.append("few_events_published")
    if share is not None and share < STARVED_REVIEW_SHARE and waiting >= STARVED_MIN_WAITING:
        starved.append("reviews_far_below_arrivals")
    elif share is not None and share < DEGRADED_REVIEW_SHARE and waiting > DEGRADED_MIN_WAITING:
        degraded.append("reviews_below_arrivals")
    if (status.get("source") or {}).get("status") == "failed":
        degraded.append("source_failed")
    geolocation = status.get("geolocation") or {}
    if geolocation.get("status") == "failed" or count(geolocation.get("pending")):
        degraded.append("geolocation_incomplete")
    return {"state": "starved" if starved else "degraded" if degraded else "healthy",
            "reasons": starved + degraded, "events_published_last_24h": last_24h,
            "events_published_median_14d": median, "new_reviews": new_reviews, "recent_pending": waiting,
            "review_share": None if share is None else round(share, 3),
            "thresholds": {"starved_events_ratio": STARVED_EVENTS_RATIO, "degraded_events_ratio": DEGRADED_EVENTS_RATIO,
                           "starved_review_share": STARVED_REVIEW_SHARE, "degraded_review_share": DEGRADED_REVIEW_SHARE,
                           "starved_min_waiting": STARVED_MIN_WAITING, "degraded_min_waiting": DEGRADED_MIN_WAITING}}


def health_summary(health):
    return (f"{health['events_published_last_24h']} events published in the last 24 h "
            f"(14-day median {health['events_published_median_14d']:g}); "
            f"{health['new_reviews']} new reviews, {health['recent_pending']} recent articles waiting; "
            + ", ".join(health["reasons"]))


def radnuc_row(value):
    if not value:
        return None
    counts = value.get("counts") if isinstance(value.get("counts"), dict) else {}
    reviewed, pending = count(counts.get("reviewed")), count(value.get("pending_reviews"))
    row = {"category": "Radiological/Nuclear", "last_attempt_at": value.get("updated_at"),
           "status": "failed" if value.get("failed") is True else value.get("batch_status", "unknown"),
           "reviewed": reviewed, "pending": pending,
           "candidates": reviewed + pending if reviewed is not None and pending is not None else None}
    for name in ("recent_pending", "backlog_pending", "undated_pending", "source_discovery", "source_coverage", "stop_code"):
        if name in value:
            row[name] = copy.deepcopy(value[name])
    if row["status"] not in ("complete", "partial", "failed", "unknown"):
        row["status"] = "complete" if value.get("complete") is True else "partial" if pending else "unknown"
    return row


def finalize(database_path, *, collect_outcome, geolocate_outcome, started_at,
             repository=ROOT, cache_path=None, status_path=None, radnuc_path=None,
             refresh_existing=False, geolocation_forced=False):
    if not refresh_existing and timestamp(started_at) is None:
        raise ValueError("The current attempt start timestamp is required")
    database_path, repository = Path(database_path), Path(repository)
    if not refresh_existing and collect_outcome != "success":
        restore_database(database_path, repository)
    database = read_object(database_path)
    events = database.get("events")
    if not isinstance(events, list) or not all(isinstance(event, dict) for event in events):
        raise ValueError("Invalid database; recovery files must be retained")
    baseline = baseline_database(database_path, repository)
    sidecar = read_object(status_path)
    existing = database.get("collection_status")
    if refresh_existing:
        status = copy.deepcopy(existing if isinstance(existing, dict) else sidecar)
    else:
        status = copy.deepcopy(sidecar if fresh(sidecar, started_at) else existing if fresh(existing, started_at) else {})
    cache = read_object(cache_path)
    telemetry = cache.get("selection_runtime_telemetry")
    refresh_telemetry_is_current = False
    if refresh_existing and isinstance(telemetry, dict):
        actual_start = timestamp(status.get("run_started_at") or status.get("last_attempt_at"))
        # The wrapper starts before collector.main(). Its final checkpoint
        # timestamp identifies progress in this actual collection attempt.
        checkpoint_at = timestamp(telemetry.get("last_run_at") or telemetry.get("run_started_at"))
        refresh_telemetry_is_current = actual_start is None or (checkpoint_at is not None and checkpoint_at >= actual_start)
    legacy_telemetry = telemetry if refresh_existing and refresh_telemetry_is_current and telemetry.get("schema_version") != 2 else {}
    telemetry = telemetry if isinstance(telemetry, dict) and telemetry.get("schema_version") == 2 and (
        refresh_telemetry_is_current if refresh_existing else fresh(telemetry, started_at)) else {}
    previous_status = status.get("status")
    reasons = [reason for reason in status.get("reasons", []) if isinstance(reason, str) and reason not in DERIVED_REASONS]
    for reason in telemetry.get("reasons", []):
        if isinstance(reason, str) and reason not in DERIVED_REASONS:
            reasons.append(reason)
    if legacy_telemetry.get("partial_recovery") or legacy_telemetry.get("budget_reached"):
        reasons.append("selection_budget" if legacy_telemetry.get("budget_reached") else "selection_incomplete")
    for lane in LANES:
        current = status.get(lane) if isinstance(status.get(lane), dict) else {}
        runtime = telemetry.get("lanes", {}).get(lane, {})
        if known_lane(current):
            # Queue totals are authoritative; calls/reasons enrich those totals.
            merged = copy.deepcopy(runtime)
            merged.update(current)
            if status.get("status") in ("running", "failed") and known_lane(runtime):
                # The discovery sidecar precedes AI. On later failure preserve
                # validated reviews from its attempted subset of the full queue.
                candidates = max(current["candidates"], runtime["candidates"])
                reviewed = max(current["reviewed"], runtime["reviewed"])
                merged.update(candidates=candidates, reviewed=reviewed, pending=candidates - reviewed)
        elif known_lane(runtime):
            merged = copy.deepcopy(current)
            merged.update(runtime)
        else:
            merged = copy.deepcopy(current)
            merged.update({"candidates": count(current.get("candidates")),
                           "reviewed": count(current.get("reviewed")),
                           "pending": count(current.get("pending")), "status": "unknown"})
            # Legacy *_pending fields were input totals, including cache hits.
            # Expose the total without fabricating reviewed or pending counts.
            if lane in ("recent", "backlog") and count(legacy_telemetry.get(f"{lane}_pending")) is not None:
                merged["candidates"] = legacy_telemetry[f"{lane}_pending"]
        status[lane] = merged
        if count(merged.get("pending")):
            reasons.append(f"{lane}_pending")
    status["budgets"] = copy.deepcopy(telemetry.get("budgets") or status.get("budgets") or {})
    if legacy_telemetry and not status["budgets"]:
        status["budgets"] = {"primary": {"per_run": count(legacy_telemetry.get("max_calls_per_run")),
                                         "per_day": count(legacy_telemetry.get("daily_call_budget")),
                                         "used_this_run": count(legacy_telemetry.get("calls_this_run")),
                                         "used_today": count(legacy_telemetry.get("calls_today"))}}
    status.setdefault("source", {"status": "unknown"})
    source = status["source"] if isinstance(status["source"], dict) else {"status": "unknown"}
    if source.get("status") not in ("complete", "partial", "failed", "unknown"):
        source["status"] = ("partial" if source.get("errors") else "complete") if any(
            isinstance(source.get(name), dict) and source[name] for name in ("google", "gdelt")) else "unknown"
    status["source"] = source
    if source.get("errors") or count(source.get("failed_requests")) or source.get("status") in ("partial", "failed"):
        reasons.append("source_errors")
    original_ids = {str(event.get("id")) for event in baseline["events"] if event.get("id") is not None}
    original_by_id = {str(event["id"]): event for event in baseline["events"] if event.get("id") is not None}
    # Events a forced geolocation refresh has not reached yet are pending too.
    pending_geo = sum(event.get("ai_geo_complete") is False or bool(event.get("ai_geo_refresh_pending")) or
                      (event.get("id") is not None and str(event["id"]) not in original_ids
                       and event.get("ai_geo_complete") is not True) for event in events)
    completed_geo = [event for event in events if event.get("ai_geo_complete") is True]
    geo = {"status": "partial" if pending_geo else "complete", "pending": pending_geo,
           "located": sum(located(event) for event in events),
           "unlocated": sum(not located(event) for event in events),
           "completed_unlocated": sum(not located(event) for event in completed_geo),
           "outcome": geolocate_outcome, "processed_this_run": None}
    if refresh_existing:
        previous_geo = status.get("geolocation") if isinstance(status.get("geolocation"), dict) else {}
        geo["outcome"] = previous_geo.get("outcome") or status.get("geolocate_outcome", "unknown")
        if previous_geo.get("status") == "failed" or geo["outcome"] == "failure":
            geo["status"] = "failed"
            reasons.append("geolocation_failed")
        else:
            geo["status"] = "partial" if pending_geo else previous_geo.get("status", "unknown")
        geo["processed_this_run"] = count(previous_geo.get("processed_this_run"))
    elif collect_outcome == "success" and geolocate_outcome in ("success", "failure"):
        if not geolocation_forced:
            # The old summary sometimes reported the size of the input queue.
            # Count only completed transitions visible in the saved database.
            def completed_transition(event):
                previous = original_by_id.get(str(event.get("id")))
                return event.get("ai_geo_complete") is True and (
                    previous is None or previous.get("ai_geo_complete") is not True or
                    (bool(event.get("ai_geo_fingerprint")) and bool(previous.get("ai_geo_fingerprint"))
                     and event["ai_geo_fingerprint"] != previous["ai_geo_fingerprint"]))
            geo["processed_this_run"] = sum(completed_transition(event) for event in events)
    if not refresh_existing and geolocate_outcome == "failure":
        geo["status"] = "failed"
        reasons.append("geolocation_failed")
    elif not refresh_existing and geolocate_outcome not in ("success",):
        geo["status"] = "skipped" if geolocate_outcome == "skipped" else "unknown"
    if pending_geo:
        reasons.append("geolocation_pending")
    status["geolocation"] = geo
    row = radnuc_row(read_object(radnuc_path))
    categories = [item for item in status.get("categories", []) if isinstance(item, dict)]
    if row:
        categories = [item for item in categories if item.get("category") != "Radiological/Nuclear"] + [row]
    status["categories"] = categories
    if any(item.get("status") in ("partial", "failed") or count(item.get("pending")) for item in categories):
        reasons.append("category_pending")
    actual_attempt = (status.get("last_attempt_at") or telemetry.get("last_run_at") or legacy_telemetry.get("last_run_at")) if refresh_existing else status.get("last_attempt_at") or started_at
    # Only a collection moves the age of the data. A repair moves last_updated too, as
    # the publication version, and copying that here would pass it off as a collection.
    collected = not refresh_existing and collect_outcome == "success"
    published_at = database.get("last_updated")
    if not collected and isinstance(existing, dict):
        published_at = existing.get("published_at") or published_at
    status.update(schema_version=2, last_attempt_at=actual_attempt, published_at=published_at,
                  finalized_at=datetime.now(timezone.utc).isoformat())
    if not refresh_existing:
        status.update(collect_outcome=collect_outcome, geolocate_outcome=geolocate_outcome)
    if refresh_existing and (previous_status == "failed" or status.get("collect_outcome") == "failure"):
        status["status"] = "failed"
        if status.get("collect_outcome") == "failure":
            reasons.append("collection_failed")
    elif not refresh_existing and collect_outcome != "success":
        status["status"] = "failed"
        reasons.append("collection_failed" if collect_outcome == "failure" else "collection_not_run")
    elif reasons or any(count(status[lane].get("pending")) for lane in LANES):
        status["status"] = "partial"
    elif not all(known_lane(status[lane]) for lane in LANES) or source.get("status") == "unknown" or geo["status"] in ("unknown", "skipped"):
        status["status"] = "unknown"
    else:
        status["status"] = "complete"
    status['geolocation']['review_required'] = sum(event.get('geolocation_review_required') is True for event in events)
    if status['geolocation']['review_required']:
        reasons.append('geolocation_review_required')
        if status['status']=='complete': status['status']='partial'
    status["reasons"] = list(dict.fromkeys(reason for reason in reasons if isinstance(reason, str)))
    if telemetry.get("temporary_failures"):
        status["temporary_failures"] = copy.deepcopy(telemetry["temporary_failures"])
    status["health"] = run_health(status, events)
    # A refresh that changes nothing but the clock keeps the published
    # finalized_at and leaves both files untouched: git then sees no diff, so
    # nothing is committed or redeployed, and open maps (whose publication
    # manifest includes finalized_at) do not download the same data again.
    unchanged = (refresh_existing and isinstance(existing, dict) and bool(existing.get("finalized_at"))
                 and {**status, "finalized_at": existing["finalized_at"]} == existing)
    if unchanged:
        status["finalized_at"] = existing["finalized_at"]
    else:
        database["collection_status"] = status
        atomic_write(database_path, database)
    if status_path and not (unchanged and sidecar == status):
        atomic_write(Path(status_path), status)
    return status


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--database", type=Path, default=ROOT / "events.json")
    parser.add_argument("--repository", type=Path, default=ROOT)
    parser.add_argument("--cache", type=Path, default=ROOT / "ai_article_selection_cache.json")
    parser.add_argument("--status", type=Path, default=ROOT / "daily-collection-status.json")
    parser.add_argument("--radnuc-status", type=Path, default=ROOT / "archive/radnuc-background-status.json")
    parser.add_argument("--collect-outcome", default="skipped")
    parser.add_argument("--geolocate-outcome", default="skipped")
    parser.add_argument("--run-started-at", default=os.getenv("CT_ATLAS_RUN_STARTED_AT"))
    parser.add_argument("--refresh-existing", action="store_true", help="Refresh progress metadata without claiming a new collection attempt")
    parser.add_argument("--geolocation-forced", action="store_true",
                        default=os.getenv("FORCE_GEO_REQUESTED", "").lower() == "true",
                        help="Do not infer a processed total from unchanged forced-refresh records")
    args = parser.parse_args(argv)
    status = finalize(args.database, repository=args.repository, cache_path=args.cache, status_path=args.status,
                      radnuc_path=args.radnuc_status, collect_outcome=args.collect_outcome,
                      geolocate_outcome=args.geolocate_outcome,
                      started_at=args.run_started_at or datetime.now(timezone.utc).isoformat(),
                      refresh_existing=args.refresh_existing, geolocation_forced=args.geolocation_forced)
    print(json.dumps({"status": status["status"], "recent_pending": status["recent"]["pending"],
                      "backlog_pending": status["backlog"]["pending"], "geolocation_pending": status["geolocation"]["pending"],
                      "reasons": status["reasons"]}))
    health = status["health"]
    if not args.refresh_existing and health["state"] != "healthy":
        # Annotations are public; GitHub run logs need admin rights.
        level = "error" if health["state"] == "starved" else "warning"
        print(f"::{level} title=Map {health['state']}::{health_summary(health)}")
    if os.getenv("GITHUB_OUTPUT") and not args.refresh_existing:
        usage = read_object(args.cache).get("selection_quota_usage")
        wanted = recovery_wanted(status, usage, datetime.now(PACIFIC).date().isoformat())
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
            stream.write(f"recovery_wanted={str(wanted).lower()}\n")
            stream.write(f"map_health={health['state']}\n")
            stream.write(f"map_health_summary={health_summary(health)}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
