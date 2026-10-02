#!/usr/bin/env python3
"""Recover, for the background archive, the map events and related articles
that left events.json over its git history without being archived.

Every committed version of events.json is read (oldest first). An event (or
related article) present in some version but absent from the current file is
classified by why it left:

  deliberate_cleanup  removed by a retroactive cleanup or the opinion/analysis
                      purge: already archived (archive/removed-events-*.json).
  retention_prune     published more than 180 days before it left: the map's
                      retention, not a judgement -> recovered.
  rereviewed          the current Gemini selection reviewed it again after it
                      left (its cache key is in a later
                      ai_article_selection_cache.json): recovered with that
                      score unless it is 0 (off-topic).
  unknown             removed by an older re-selection or never scored: its
                      relevance under today's rules is unknown, so it waits in
                      a review file instead of reaching the archive.

Outputs (read by tools/sync_background_corpus.py, which deduplicates them):
  archive/recovered-events-<date>.json      events to archive (kind
                                            removed_event) with their related
                                            articles
  archive/recovery-pending-review-<date>.json  events waiting for a Gemini
                                            review

Needs the full git history, so it runs locally (CI checkouts are shallow):
    py -3.11 tools/recover_from_history.py [--dry-run]
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RETENTION_DAYS = 180
# A little slack: the prune runs on the collector's schedule, not at midnight.
RETENTION_SLACK_DAYS = 2
DELIBERATE_REMOVALS = ("Retroactive cleanup", "Remove opinion/analysis")
EVENT_FIELDS = (
    "id", "incident_id", "title", "summary", "original_title", "original_summary", "original_language",
    "published", "source", "url", "category", "categories", "actor_group", "primary_event_type", "is_attack",
    "country", "country_code", "city", "region", "ai_relevance_score", "ai_relevance_reason", "related_articles",
)


def git(*args, binary=False):
    result = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, check=True)
    return result.stdout if binary else result.stdout.decode("utf-8")


def parse_time(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def classify(event, removed_by, removed_on, later_score):
    """(reason, score): why an event left the map and the relevance the
    archive should record, or score None when it must not be archived now."""
    if any(marker in (removed_by or "") for marker in DELIBERATE_REMOVALS):
        return "deliberate_cleanup", None
    if later_score is not None:
        return "rereviewed", (later_score if later_score > 0 else None)
    published = parse_time(event.get("published"))
    if removed_on and published and published < removed_on - timedelta(days=RETENTION_DAYS - RETENTION_SLACK_DAYS):
        score = event.get("ai_relevance_score")
        return "retention_prune", (int(score) if isinstance(score, (int, float)) and score > 0 else None)
    return "unknown", None


def scan_history(canonical_url):
    """Last known version of every lead event and related article, and the
    commit (date, subject) that removed it."""
    commits = git("log", "--reverse", "--format=%H|%ad|%s", "--date=iso-strict", "--", "events.json").strip().splitlines()
    leads, related = {}, {}
    previous_leads, previous_related = set(), set()
    for index, line in enumerate(commits):
        sha, date, subject = line.split("|", 2)
        try:
            data = json.loads(git("show", f"{sha}:events.json", binary=True).decode("utf-8"))
        except (subprocess.CalledProcessError, ValueError):
            continue
        now_leads, now_related = set(), set()
        for event in data.get("events") or []:
            key = canonical_url(event.get("url") or "")
            if not key:
                continue
            now_leads.add(key)
            leads[key] = {"event": {field: event.get(field) for field in EVENT_FIELDS}, "removed_by": None}
            for article in event.get("related_articles") or []:
                article_key = canonical_url(article.get("url") or "") if isinstance(article, dict) else ""
                if article_key:
                    now_related.add(article_key)
                    related[article_key] = {"article": article, "parent_url": key, "removed_by": None}
        for key in previous_leads - now_leads:
            leads[key]["removed_by"] = leads[key]["removed_by"] or f"{date} {subject}"
        for key in previous_related - now_related:
            related[key]["removed_by"] = related[key]["removed_by"] or f"{date} {subject}"
        previous_leads, previous_related = now_leads, now_related
        if index % 25 == 0:
            print(f"  events.json history {index + 1}/{len(commits)}", flush=True)
    return leads, related


def later_selection_scores(fingerprints):
    """The most recent Gemini selection score cached for each fingerprint."""
    found = {}
    for line in git("log", "--format=%H", "--", "ai_article_selection_cache.json").strip().splitlines():
        try:
            cache = json.loads(git("show", f"{line}:ai_article_selection_cache.json", binary=True).decode("utf-8"))
        except (subprocess.CalledProcessError, ValueError):
            continue
        for fingerprint, item in (cache.get("items") or {}).items():
            if fingerprint in fingerprints and fingerprint not in found:
                score = ((item or {}).get("result") or {}).get("relevance_score")
                if isinstance(score, (int, float)):
                    found[fingerprint] = int(score)
    return found


def main(argv=None):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="Classify and report without writing files.")
    args = parser.parse_args(argv)

    spec = importlib.util.spec_from_file_location("collector", ROOT / "collector.py")
    collector = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(collector)

    current = json.loads((ROOT / "events.json").read_text(encoding="utf-8"))
    current_urls, live_events = set(), {}
    for event in current.get("events") or []:
        lead_url = collector.canonical_url(event.get("url") or "")
        current_urls.add(lead_url)
        live_events[lead_url] = event
        for article in event.get("related_articles") or []:
            current_urls.add(collector.canonical_url(article.get("url") or ""))

    leads, related = scan_history(collector.canonical_url)
    missing = {key: value for key, value in leads.items() if key not in current_urls}
    fingerprints = {collector.selection_fingerprint(value["event"]): key for key, value in missing.items()}
    scores = {fingerprints[fp]: score for fp, score in later_selection_scores(set(fingerprints)).items()}

    recovered, pending, reasons = [], [], Counter()
    recovered_urls = set()
    for key, value in missing.items():
        event, removed_by = value["event"], value["removed_by"] or ""
        reason, score = classify(event, removed_by, parse_time(removed_by.split(" ", 1)[0]), scores.get(key))
        reasons[reason + ("" if score is not None or reason in ("deliberate_cleanup", "unknown") else "_off_topic")] += 1
        if score is not None:
            recovered.append({**event, "ai_relevance_score": score, "_recovery_reason": reason,
                              "_left_map": removed_by[:120]})
            recovered_urls.add(key)
        elif reason == "unknown":
            pending.append({field: event.get(field) for field in (
                "url", "title", "original_title", "summary", "published", "source", "ai_relevance_score")}
                | {"left_map": removed_by[:120]})

    # Related articles of recovered events travel inside each event. Those
    # dropped from an event still on the map (the old 24-per-event cap, merges)
    # are recovered with that live parent's context.
    live_related = []
    for key, value in related.items():
        parent = live_events.get(value["parent_url"])
        if key in current_urls or parent is None:
            continue
        live_related.append({
            "article": value["article"],
            "parent": {field: parent.get(field) for field in (
                "id", "incident_id", "category", "categories", "actor_group", "primary_event_type",
                "country", "region")},
        })
    stray_related = sum(1 for key, value in related.items()
                        if key not in current_urls and value["parent_url"] not in recovered_urls
                        and value["parent_url"] not in live_events)

    print("\nRemoved events by reason:", dict(reasons))
    print(f"Recovered: {len(recovered)} events (with their related articles), "
          f"{len(live_related)} related articles of events still on the map; pending review: {len(pending)}")
    print(f"Related articles left out (parent neither live nor recovered): {stray_related}")
    if args.dry_run:
        return 0

    stamp = datetime.now(timezone.utc)
    day = stamp.strftime("%Y%m%d")
    common = {"created_at": stamp.isoformat(), "source": "events.json git history"}
    (ROOT / "archive" / f"recovered-events-{day}.json").write_text(json.dumps({
        **common,
        "reason": "Map events that left events.json without being archived: aged out (180-day retention) or "
                  "re-reviewed by the current Gemini selection with a score above 0; and related articles "
                  "dropped from events still on the map.",
        "events": recovered,
        "related_articles": live_related,
    }, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    (ROOT / "archive" / f"recovery-pending-review-{day}.json").write_text(json.dumps({
        **common,
        "reason": "Events that left the map through an older re-selection or were never scored: their relevance "
                  "under the current rules is unknown, so they wait for a Gemini review before reaching the archive.",
        "events": pending,
    }, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"Wrote archive/recovered-events-{day}.json and archive/recovery-pending-review-{day}.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
