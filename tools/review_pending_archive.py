#!/usr/bin/env python3
"""Review the events waiting in archive/recovery-pending-review-*.json with
the map's own Gemini selection, and move them on:

  score > 0  -> archive/recovered-events-reviewed-<date>.json, which the
                background-archive sync reads (one copy per story);
  score 0    -> dropped (no counter-terrorism content under today's rules).

The reviews run on a model whose free quota the daily collection does not
touch (ARCHIVE_REVIEW_MODEL, Gemini 3.1 Flash Lite by default: its own 500
requests/day; the collection uses 3.5 Flash Lite), paced under its 15
requests/minute. A run stops cleanly on a quota answer (429), a failure or
its call budget; reviewed events leave the pending file, so the next run
continues where this one stopped.

    GEMINI_API_KEY=... py -3.11 tools/review_pending_archive.py [--max-calls N] [--dry-run]
"""
from __future__ import annotations

import argparse
import glob
import importlib.util
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REVIEW_MODEL = os.getenv("ARCHIVE_REVIEW_MODEL", "gemini-3.1-flash-lite")
MAX_CALLS = int(os.getenv("ARCHIVE_REVIEW_MAX_CALLS", "120"))
BATCH_SIZE = 25
# 15 requests/minute on the free tier, with a margin.
SECONDS_BETWEEN_CALLS = float(os.getenv("ARCHIVE_REVIEW_SECONDS_BETWEEN_CALLS", "5"))


def load_collector():
    spec = importlib.util.spec_from_file_location("collector", ROOT / "collector.py")
    collector = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(collector)
    return collector


def read_json(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path, data):
    tmp = Path(str(path) + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def reviewed_event(item, result, collector):
    """The archive's version of a reviewed event: Gemini's score, reason and
    categories, the article's own link, headline and date."""
    categories = collector.normalize_categories(result.get("categories") or []) or item.get("categories") or []
    return {
        **{key: value for key, value in item.items() if key not in ("left_map",)},
        "ai_relevance_score": int(result.get("relevance_score") or 0),
        "ai_relevance_reason": result.get("reason"),
        "category": categories[0] if categories else item.get("category"),
        "categories": categories,
        "actor_group": collector.canonicalize_actor_group(result.get("actor_group")) or item.get("actor_group"),
        "primary_event_type": result.get("primary_event_type") or item.get("primary_event_type"),
        "_recovery_reason": "pending_review",
        "_review_model": REVIEW_MODEL,
    }


def review(items, call_batch, collector, max_calls, pause=SECONDS_BETWEEN_CALLS, sleep=time.sleep):
    """Review items in batches until done, out of budget or stopped by an
    error. Returns (kept, dropped_count, reviewed_count, calls_made, stop_reason)."""
    kept, dropped, reviewed, calls = [], 0, 0, 0
    for start in range(0, len(items), BATCH_SIZE):
        if calls >= max_calls:
            return kept, dropped, reviewed, calls, f"call budget reached ({max_calls})"
        batch = items[start:start + BATCH_SIZE]
        # Positional wire ids: stored event ids are not unique.
        payload = [collector.selection_payload({**item, "id": f"p{offset}"}, offset)
                   for offset, item in enumerate(batch)]
        if calls:
            sleep(pause)
        calls += 1
        try:
            results = call_batch(payload)
        except Exception as error:  # noqa: BLE001 -- quota, transient or malformed: stop, keep progress
            return kept, dropped, reviewed, calls, f"stopped by {type(error).__name__}: {str(error)[:200]}"
        by_id = {str(result.get("event_id")): result for result in results or [] if isinstance(result, dict)}
        for offset, item in enumerate(batch):
            result = by_id.get(f"p{offset}")
            if result is None:
                return kept, dropped, reviewed, calls, "incomplete answer"
        for offset, item in enumerate(batch):
            result = by_id[f"p{offset}"]
            reviewed += 1
            try:
                score = int(result.get("relevance_score") or 0)
            except (TypeError, ValueError):
                score = 0
            if score > 0:
                kept.append(reviewed_event(item, result, collector))
            else:
                dropped += 1
    return kept, dropped, reviewed, calls, "done"


def main(argv=None):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--max-calls", type=int, default=MAX_CALLS)
    parser.add_argument("--dry-run", action="store_true", help="Count what is pending without calling Gemini.")
    args = parser.parse_args(argv)

    pending_paths = sorted(glob.glob(str(ROOT / "archive" / "recovery-pending-review-*.json")))
    pending = [(path, read_json(path)) for path in pending_paths]
    total = sum(len(data.get("events") or []) for _, data in pending)
    print(f"Pending review: {total} event(s) in {len(pending_paths)} file(s); model {REVIEW_MODEL}, "
          f"up to {args.max_calls} call(s) of {BATCH_SIZE}.")
    if args.dry_run or not total:
        return 0

    collector = load_collector()
    collector.AI_SELECTION_MODEL = REVIEW_MODEL
    calls_left = args.max_calls
    day = datetime.now(timezone.utc).strftime("%Y%m%d")
    out_path = ROOT / "archive" / f"recovered-events-reviewed-{day}.json"
    out = read_json(out_path) if out_path.exists() else {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source": "archive/recovery-pending-review-*.json, reviewed by tools/review_pending_archive.py",
        "reason": "Former map events of unknown relevance, reviewed by the map's Gemini selection; "
                  "only those scoring above 0 are kept.",
        "events": [],
    }

    summary = {"kept": 0, "dropped": 0, "reviewed": 0}
    stop = "done"
    for path, data in pending:
        items = data.get("events") or []
        kept, dropped, reviewed, calls, stop = review(
            items, collector.process_ai_selection_batch, collector, calls_left,
        )
        calls_left -= calls
        out["events"].extend(kept)
        summary["kept"] += len(kept)
        summary["dropped"] += dropped
        summary["reviewed"] += reviewed
        data["events"] = items[reviewed:]
        if data["events"]:
            write_json(path, data)
        else:
            os.remove(path)
        if stop != "done":
            break

    if summary["kept"]:
        out["updated_at"] = datetime.now(timezone.utc).isoformat()
        write_json(out_path, out)
    remaining = total - summary["reviewed"]
    print(f"::notice title=Archive review::{summary['reviewed']} reviewed ({summary['kept']} kept, "
          f"{summary['dropped']} scored 0 and dropped); {remaining} still pending; {stop}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
