"""Durable, separate daily news queues. This module never calls an AI provider."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path

QUEUE_FILE = "daily_candidate_queue.json"
STATUS_FILE = "daily-collection-status.json"


def load_queue(path=QUEUE_FILE):
    path = Path(path)
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("events"), list):
        raise ValueError("Invalid daily candidate queue; refusing to discard pending articles.")
    if any(not isinstance(item, dict) for item in data["events"]):
        raise ValueError("Invalid pending article in daily candidate queue.")
    return data["events"]


def save_queue(events, write, path=QUEUE_FILE, now=None):
    write(path, {"version": 1, "updated_at": (now or datetime.now(timezone.utc)).isoformat(),
                 "events": events})


def partition(events, engine, now, disabled_history=()):
    """Publication time selects the daily lane, never incident time or outlet location.

    A stopped historical category cannot be restarted by a stale daily RSS result.
    Pending recent articles automatically move to the older queue as they age.
    """
    cutoff = now - timedelta(days=engine.DAILY_LOOKBACK_DAYS)
    retention = now - timedelta(days=engine.RETENTION_DAYS)
    recent, backlog, seen = [], [], set()
    dropped = {"expired": 0, "retired": 0, "cancelled_history": 0, "duplicates": 0}
    for item in events:
        if engine.out_of_scope_reason(item):
            dropped["retired"] += 1
            continue
        fingerprint = engine.selection_fingerprint(item)
        if fingerprint in seen:
            dropped["duplicates"] += 1
            continue
        seen.add(fingerprint)
        published = engine.event_datetime(item)
        if published and published < retention:
            dropped["expired"] += 1
            continue
        if published and cutoff <= published <= now + timedelta(days=1):
            recent.append(item)
        else:
            categories = item.get("categories") or [item.get("category")]
            if set(categories) & set(disabled_history):
                dropped["cancelled_history"] += 1
                continue
            backlog.append(item)
    key = lambda item: engine.event_datetime(item) or datetime.min.replace(tzinfo=timezone.utc)
    recent.sort(key=key, reverse=True)
    backlog.sort(key=key, reverse=True)
    return recent, backlog, dropped


def prepare(fresh, queued, existing, engine, now, disabled_history=()):
    """Keep queued clusters unchanged so cached partial reviews stay reusable.

    New stories are clustered separately in each lane. Their source fingerprints
    prevent feeds from reintroducing copies already held in the durable queue.
    """
    queued = engine.exclude_reviewed_articles(queued, existing)
    known = {engine.selection_fingerprint(item) for item in queued}
    for item in queued:
        known.update(item.get("source_article_fingerprints") or [])
    fresh = engine.exclude_reviewed_articles(fresh, existing)
    fresh = [item for item in fresh if engine.selection_fingerprint(item) not in known]
    recent, backlog, dropped = partition(fresh, engine, now, disabled_history)
    old_recent, old_backlog, old_dropped = partition(queued, engine, now, disabled_history)
    for key in dropped:
        dropped[key] += old_dropped[key]
    return (old_recent + engine.deduplicate_events(recent),
            old_backlog + engine.deduplicate_events(backlog), dropped)


def unresolved(originals, cache, engine):
    """Call only after publication; completed decisions survive failed runs in queue."""
    items = cache.get("items") or {}
    return [item for item in originals if not (
        isinstance(items.get(engine.selection_fingerprint(item)), dict)
        and items[engine.selection_fingerprint(item)].get("version") == engine.AI_SELECTION_VERSION
        and isinstance(items[engine.selection_fingerprint(item)].get("result"), dict))]


def begin_status(now, previous_published=None):
    unknown = {"candidates": None, "reviewed": None, "pending": None, "status": "unknown"}
    return {"schema_version": 2, "status": "running", "run_started_at": now.isoformat(),
            "last_attempt_at": now.isoformat(), "published_at": previous_published,
            "recent": deepcopy(unknown), "backlog": deepcopy(unknown),
            "maintenance": deepcopy(unknown), "source": {}, "reasons": []}


def finish_status(status, telemetry, google, gdelt, now, recent_days=3):
    result = deepcopy(status)
    lanes = telemetry.get("lanes") or {}
    for lane in ("recent", "backlog", "maintenance"):
        if lane in lanes:
            result[lane] = deepcopy(lanes[lane])
    result["recent"].update(window_start=(now - timedelta(days=recent_days)).isoformat(),
                            window_end=now.isoformat())
    source_errors = int(google.get("failed", 0)) + int(gdelt.get("failed", 0))
    result["source"] = {"google": dict(google), "gdelt": dict(gdelt), "errors": source_errors,
                        "status": "partial" if source_errors else "complete"}
    reasons = list(telemetry.get("reasons") or [])
    for lane in ("recent", "backlog", "maintenance"):
        if result[lane].get("pending", 0):
            reason = "recent_pending" if lane == "recent" else "backlog_pending"
            if reason not in reasons:
                reasons.append(reason)
    if source_errors:
        reasons.append("source_errors")
    result["reasons"] = list(dict.fromkeys(reasons))
    result["budgets"] = deepcopy(telemetry.get("budgets") or {})
    result["status"] = "partial" if reasons or telemetry.get("partial") else "complete"
    result["last_attempt_at"] = now.isoformat()
    return result
