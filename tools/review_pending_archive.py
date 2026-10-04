#!/usr/bin/env python3
"""Review the events waiting in archive/recovery-pending-review-*.json with
the map's own Gemini selection, and move them on:

  score > 0  -> archive/recovered-events-reviewed-<date>.json, which the
                background-archive sync reads (one copy per story; the sync
                files score >= the map threshold as archived incidents);
  score 0    -> dropped (no counter-terrorism content under today's rules).

The reviews run through tools/archive_review.py: Gemini 3.1 Flash Lite
(ARCHIVE_REVIEW_MODEL; its own 500 requests/day, untouched by the collection),
at most --max-calls HTTP requests a run and ARCHIVE_REVIEW_DAILY_CALLS a
Pacific day (ledger: quota/gemini-3.1-archive-review.json), 6 s apart,
stopping at a daily-quota 429.
Every batch is saved as soon as it is reviewed (the output gains its events,
the pending file loses them), so a run stopped by its timeout or a quota keeps
all its work and the next run continues where it stopped.

    GEMINI_API_KEY=... py -3.11 tools/review_pending_archive.py [--max-calls N] [--dry-run]
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import archive_review  # noqa: E402

ROOT = archive_review.ROOT
REVIEW_MODEL = archive_review.REVIEW_MODEL
MAX_CALLS = int(os.getenv("ARCHIVE_REVIEW_MAX_CALLS", "120"))
# Runs an event Gemini leaves unanswered is offered again before it is dropped.
MAX_ATTEMPTS = 3
DAILY_CALLS = int(os.getenv("ARCHIVE_REVIEW_DAILY_CALLS", "120"))


def load_collector():
    return archive_review.prepare_collector(archive_review.load_collector(ROOT), REVIEW_MODEL)


def read_json(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


write_json = archive_review.write_json


def reviewed_event(item, result, collector):
    """The archive's version of a reviewed event: filed as the map's selection
    files a candidate (archive_review.review_record), with the event's own
    link, headline and date, and a mark the sync reads as a fresh review."""
    return {
        **{key: value for key, value in item.items() if key not in ("left_map",)},
        **archive_review.review_record(item, result, collector),
        "_recovery_reason": "pending_review",
        "_review_model": REVIEW_MODEL,
    }


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
          f"up to {args.max_calls} Gemini request(s) of {archive_review.BATCH_SIZE} events.")
    if args.dry_run or not total:
        return 0

    ledger = archive_review.DailyLedger(archive_review.ledger_path("archive-review", ROOT), DAILY_CALLS)
    budget = ledger.budget(args.max_calls)
    if budget <= 0:
        print(f"Daily allocation already used ({ledger.used}/{ledger.allocation} this Pacific day).")
        return 0
    collector = load_collector()
    day = datetime.now(timezone.utc).strftime("%Y%m%d")
    out_path = ROOT / "archive" / f"recovered-events-reviewed-{day}.json"
    out = read_json(out_path) if out_path.exists() else {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source": "archive/recovery-pending-review-*.json, reviewed by tools/review_pending_archive.py",
        "reason": "Former map events of unknown relevance, reviewed by the map's Gemini selection; "
                  "only those scoring above 0 are kept.",
        "events": [],
    }
    summary = {"kept": 0, "dropped": 0, "skipped": 0, "reviewed": 0, "given_up": 0}
    stop = "done"

    gate = archive_review.GeminiGate(collector, budget, archive_review.SECONDS_BETWEEN_POSTS,
                                     on_post=ledger.save)
    with gate:
        for path, data in pending:
            items = data.get("events") or []
            progress = {"done": 0}
            # Left unanswered this run: offered again at the end of the file.
            retry = []

            def save_batch(pairs, skipped, path=path, data=data, items=items, progress=progress, retry=retry):
                for item, result in pairs:
                    if archive_review.score_of(result) > 0:
                        out["events"].append(reviewed_event(item, result, collector))
                        summary["kept"] += 1
                    else:
                        summary["dropped"] += 1
                        if item.get("_requeued"):
                            # Already in the archive under an older verdict: the 0
                            # must be written down, or that verdict would stand.
                            out["events"].append(reviewed_event(item, result, collector))
                for item in skipped:
                    attempts = int(item.get("_attempts") or 0) + 1
                    if attempts < MAX_ATTEMPTS:
                        retry.append({**item, "_attempts": attempts})
                    else:
                        summary["given_up"] += 1
                summary["reviewed"] += len(pairs)
                summary["skipped"] += len(skipped)
                progress["done"] += len(pairs) + len(skipped)
                out["updated_at"] = datetime.now(timezone.utc).isoformat()
                write_json(out_path, out)
                data["events"] = items[progress["done"]:] + retry
                if data["events"]:
                    write_json(path, data)
                elif os.path.exists(path):
                    os.remove(path)

            _, stop = archive_review.review_batches(items, collector, save_batch)
            if stop != "done":
                break
        calls = gate.posts

    remaining = total - summary["reviewed"] - summary["given_up"]
    print(f"::notice title=Archive review::{summary['reviewed']} reviewed ({summary['kept']} kept, "
          f"{summary['dropped']} scored 0 and dropped, {summary['skipped']} left unanswered, "
          f"{summary['given_up']} of them given up after {MAX_ATTEMPTS} runs) "
          f"with {calls} Gemini request(s); {remaining} still pending; {stop}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
