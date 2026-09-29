#!/usr/bin/env python3
"""One-off retroactive cleanup of events.json: remove already-collected events
that fail the current (strengthened) relevance rules, without touching any
kept event's fields.

Two independent passes, both driven by collector.py's own current logic so the
result matches exactly what the live collector would now accept or reject:

  1. Keyword pass (free, offline): events whose title/summary match
     collector.NON_EVENT_PATTERNS (analysis/op-ed/editorial/explainer/...).
  2. Gemini re-check pass (needs GEMINI_API_KEY): borderline-score events
     (--rescore-min..--rescore-max, default 60-69) are re-submitted to Gemini
     under the CURRENT collector.AI_SELECTION_INSTRUCTIONS. An event is removed
     if the fresh score falls below collector.AI_SELECTION_THRESHOLD or
     collector.out_of_scope_reason() now rejects it. Kept events are left
     completely untouched -- this pass only decides keep/remove, it never
     rewrites title/summary/category/actor_group the way live collection does.

Removed events are archived (never silently discarded) to a JSON file before
being dropped from events.json, and every other top-level key in events.json
is preserved exactly as found.

Usage:
    python3 tools/cleanup_existing_events.py --dry-run
    GEMINI_API_KEY=... python3 tools/cleanup_existing_events.py
    GEMINI_API_KEY=... python3 tools/cleanup_existing_events.py --skip-rescore
    GEMINI_API_KEY=... python3 tools/cleanup_existing_events.py --max-batches 15

--max-batches lets a large rescore be spread across several runs/days: each
run only sees candidates still in events.json (removed ones are already
gone), so re-running with the same range simply continues where the last
run stopped -- no separate checkpoint file needed.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

_spec = importlib.util.spec_from_file_location("collector", ROOT / "collector.py")
collector = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(collector)


def keyword_flagged(event):
    """Mirrors is_relevant_article()'s own use of has_non_event_pattern(): a
    pattern hit (e.g. "documentary evidence" matching \\bdocumentary\\b) does not
    remove the event if its headline alone already carries strong hard-news
    evidence (a CT anchor plus one of its category's action verbs)."""
    title = event.get("title") or ""
    summary = event.get("summary") or ""
    combined = collector.normalize_relevance_text(f"{title} {summary}")
    if not collector.has_non_event_pattern(combined):
        return False

    title_text = collector.normalize_relevance_text(title)
    title_anchor = any(
        collector.contains_term(title_text, anchor) for anchor in collector.CT_ANCHORS
    )
    action_terms = collector.ACTION_TERMS.get(event.get("category") or "", set())
    title_action = any(
        collector.contains_term(title_text, term) for term in action_terms
    )
    return not (title_anchor and title_action)


def rescore_batch_indexed(indices, batch_events):
    """Re-submit these events to Gemini under the current selection prompt.
    `indices` are these events' positions in the full events list -- used as
    the wire event_id since events.json has duplicate "id" values, so
    collector.selection_payload's own id-derivation cannot be trusted here.
    Returns {index: (score, scope_reason)}. Raises on unrecoverable API errors."""
    payloads = []
    event_by_wire_id = {}
    for index, event in zip(indices, batch_events):
        payload = collector.selection_payload(event, index)
        wire_id = str(index)
        payload["event_id"] = wire_id
        payloads.append(payload)
        event_by_wire_id[wire_id] = (index, event)

    results = collector.process_ai_selection_batch(payloads)

    outcomes = {}
    for result in results:
        wire_id = str(result.get("event_id") or "")
        entry = event_by_wire_id.get(wire_id)
        if entry is None:
            continue
        index, event = entry
        try:
            score = int(result.get("relevance_score", 0))
        except (TypeError, ValueError):
            score = 0
        score = max(0, min(100, score))
        scope_reason = collector.out_of_scope_reason(event)
        outcomes[index] = (score, scope_reason)
    return outcomes


def main(argv=None):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--input", default=str(ROOT / "events.json"))
    parser.add_argument("--archive", default=None)
    parser.add_argument("--dry-run", action="store_true", help="Report what would be removed; write nothing.")
    parser.add_argument("--skip-rescore", action="store_true", help="Run only the free keyword pass.")
    parser.add_argument("--rescore-min", type=int, default=60)
    parser.add_argument("--rescore-max", type=int, default=69)
    parser.add_argument(
        "--max-batches", type=int, default=None,
        help="Stop after this many Gemini batches (for spreading a large rescore across several days).",
    )
    parser.add_argument("--show", type=int, default=40, help="How many removed titles to print.")
    args = parser.parse_args(argv)

    with open(args.input, encoding="utf-8") as handle:
        database = json.load(handle)

    events = database.get("events")
    if not isinstance(events, list) or not events:
        print("No events found; aborting.", file=sys.stderr)
        return 1

    print(f"Loaded {len(events)} events from {args.input}")

    # events.json has ~100 duplicate "id" values across otherwise-distinct
    # events (a pre-existing data issue, unrelated to this cleanup), so
    # candidates/decisions are tracked by list position, never by event["id"].
    keyword_flags = [keyword_flagged(event) for event in events]
    print(f"Keyword pass: {sum(keyword_flags)} events match an opinion/analysis pattern")

    rescore_removed = [False] * len(events)
    rescore_scores = [None] * len(events)
    rescore_error = None

    if not args.skip_rescore:
        candidate_indices = [
            index
            for index, event in enumerate(events)
            if not keyword_flags[index]
            and args.rescore_min <= (event.get("ai_relevance_score") or 0) <= args.rescore_max
        ]
        print(
            f"Gemini re-check pass: {len(candidate_indices)} events scored "
            f"{args.rescore_min}-{args.rescore_max} under the previous rules"
        )

        if candidate_indices and not args.dry_run:
            batch_size = collector.AI_SELECTION_BATCH_SIZE
            total_batches = (len(candidate_indices) + batch_size - 1) // batch_size
            batches_run = 0
            for start in range(0, len(candidate_indices), batch_size):
                if args.max_batches is not None and batches_run >= args.max_batches:
                    remaining = len(candidate_indices) - start
                    print(
                        f"  Reached --max-batches={args.max_batches}; "
                        f"{remaining} candidates left for a future run."
                    )
                    break
                batch_indices = candidate_indices[start:start + batch_size]
                batch = [events[i] for i in batch_indices]
                batch_number = start // batch_size + 1
                print(f"  batch {batch_number}/{total_batches} -- {len(batch)} events")
                try:
                    outcomes = rescore_batch_indexed(batch_indices, batch)
                except Exception as error:  # noqa: BLE001 - surface and stop, keep partial progress
                    rescore_error = str(error)
                    print(f"  Gemini re-check stopped early: {error}", file=sys.stderr)
                    break
                batches_run += 1
                for index, (score, scope_reason) in outcomes.items():
                    rescore_scores[index] = score
                    if scope_reason or score < collector.AI_SELECTION_THRESHOLD:
                        rescore_removed[index] = True
        elif candidate_indices and args.dry_run:
            print("  (dry run: not calling Gemini; re-run without --dry-run to actually re-check these)")

    removed = []
    kept = []
    for index, event in enumerate(events):
        if keyword_flags[index]:
            reason = "keyword: opinion/analysis pattern"
        elif rescore_removed[index]:
            reason = f"gemini re-check: score {rescore_scores[index]} under current rules"
        else:
            reason = None

        if reason:
            removed.append({"_cleanup_reason": reason, **event})
        else:
            kept.append(event)

    print(f"\nTotal removed: {len(removed)} / {len(events)}  (kept {len(kept)})")
    if rescore_error:
        print(f"Note: Gemini re-check stopped early ({rescore_error}); only events processed so far were judged.")

    for event in removed[: args.show]:
        print(
            f"  - [{event.get('category')}] score={event.get('ai_relevance_score')} "
            f":: {event.get('title')}  ({event['_cleanup_reason']})"
        )
    if len(removed) > args.show:
        print(f"  ... and {len(removed) - args.show} more")

    if args.dry_run:
        print("\nDry run: no files written.")
        return 0

    if not removed:
        print("\nNothing to remove; leaving events.json untouched.")
        return 0

    archive_path = Path(args.archive) if args.archive else ROOT / "archive" / f"removed-events-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.json"
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    with open(archive_path, "w", encoding="utf-8") as handle:
        json.dump(
            {"removed_at": datetime.now(timezone.utc).isoformat(), "events": removed},
            handle,
            ensure_ascii=False,
            indent=2,
        )
    print(f"\nArchived {len(removed)} removed events to {archive_path}")

    database["events"] = kept
    with open(args.input, "w", encoding="utf-8") as handle:
        json.dump(database, handle, ensure_ascii=False, indent=2)
    print(f"Wrote {len(kept)} remaining events to {args.input}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
