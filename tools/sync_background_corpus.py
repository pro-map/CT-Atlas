#!/usr/bin/env python3
"""Load articles that already exist in this repository into the D1 background
corpus (ct-atlas-background-articles). Idempotent -- INSERT OR IGNORE keyed by
URL -- so it is safe to run on every push and on a schedule.

Sources (earlier ones win when two share a URL):
  related_article    other outlets' reports merged into each map event
                     (events.json related_articles). events-lite.json strips
                     them, so the report Worker has never seen them. They
                     inherit the parent event's category, actor, country,
                     region and incident id.
  removed_event      events archived by tools/cleanup_existing_events.py.
  rejected_candidate background-articles.json, the collector's local fallback
                     for days when D1 was unreachable.
  historical_review  candidates Gemini reviewed and rejected that are still in
                     ai_article_selection_cache.json. The cache keeps no URL,
                     source or publication date, so these carry a synthetic
                     "gemini-review:<fingerprint>" key and only their review date.

Usage:
    python3 tools/sync_background_corpus.py --dry-run
    CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... python3 tools/sync_background_corpus.py
"""
from __future__ import annotations

import argparse
import glob
import importlib.util
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

_spec = importlib.util.spec_from_file_location("collector", ROOT / "collector.py")
collector = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(collector)


def _load_json(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def related_articles(events, now):
    for event in events:
        for article in event.get("related_articles") or []:
            if not isinstance(article, dict):
                continue
            title = article.get("title") or article.get("original_title")
            if not article.get("url") or not title:
                continue
            yield {
                "url": article["url"],
                "kind": "related_article",
                "title": title,
                "summary": article.get("summary"),
                "source": article.get("source"),
                "published": article.get("published"),
                "category": event.get("category"),
                "categories": event.get("categories"),
                "actor_group": event.get("actor_group"),
                "primary_event_type": event.get("primary_event_type"),
                "original_language": article.get("original_language"),
                "country": event.get("country"),
                "region": event.get("region"),
                "parent_event_id": event.get("id"),
                "parent_incident_id": event.get("incident_id"),
                "collected_at": now,
            }


def removed_events(archive_paths, now):
    for path in archive_paths:
        data = _load_json(path) or {}
        for event in data.get("events") or []:
            if not isinstance(event, dict) or not event.get("url") or not event.get("title"):
                continue
            yield {
                **collector.background_article_from_event(event),
                "kind": "removed_event",
                "parent_incident_id": event.get("incident_id"),
                "collected_at": data.get("removed_at") or now,
            }


def fallback_file_articles(path):
    data = _load_json(path) or {}
    for article in data.get("articles") or []:
        if isinstance(article, dict) and article.get("url") and article.get("title"):
            yield {**article, "kind": "rejected_candidate"}


def historical_reviews(cache):
    threshold = collector.AI_SELECTION_THRESHOLD
    for fingerprint, item in ((cache or {}).get("items") or {}).items():
        result = (item or {}).get("result") or {}
        score = result.get("relevance_score")
        title = result.get("english_title")
        if not isinstance(score, (int, float)) or score >= threshold or not title:
            continue
        categories = collector.normalize_categories(result.get("categories") or [])
        yield {
            "url": f"gemini-review:{fingerprint}",
            "kind": "historical_review",
            "title": title,
            "summary": result.get("english_summary"),
            "category": categories[0] if categories else None,
            "categories": categories,
            "actor_group": collector.canonicalize_actor_group(result.get("actor_group")),
            "primary_event_type": result.get("primary_event_type"),
            "original_language": result.get("original_language"),
            "ai_relevance_score": int(score),
            "ai_relevance_reason": result.get("reason"),
            "collected_at": item.get("reviewed_at") or datetime.now(timezone.utc).isoformat(),
        }


def collect_articles(root=ROOT):
    now = datetime.now(timezone.utc).isoformat()
    database = _load_json(root / "events.json") or {}
    sources = {
        "related_article": related_articles(database.get("events") or [], now),
        "removed_event": removed_events(sorted(glob.glob(str(root / "archive" / "removed-events-*.json"))), now),
        "rejected_candidate": fallback_file_articles(root / collector.BACKGROUND_ARTICLES_FILE),
        "historical_review": historical_reviews(_load_json(root / collector.AI_SELECTION_CACHE_FILE)),
    }

    seen = set()
    articles = []
    counts = {}
    for kind, iterator in sources.items():
        counts[kind] = 0
        for article in iterator:
            if article["url"] in seen:
                continue
            seen.add(article["url"])
            articles.append(article)
            counts[kind] += 1
    return articles, counts


def main(argv=None):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="Build the statements without contacting D1.")
    args = parser.parse_args(argv)

    articles, counts = collect_articles()
    rows = [collector.background_article_row(article) for article in articles]
    statements = list(
        collector.d1_insert_or_ignore_statements(
            "background_articles", collector.BACKGROUND_ARTICLES_D1_COLUMNS, rows
        )
    )

    for kind, count in counts.items():
        print(f"{kind}: {count}")
    print(f"Total: {len(rows)} articles in {len(statements)} INSERT statement(s).")

    if args.dry_run:
        print("Dry run: D1 not contacted.")
        return 0

    inserted = 0
    try:
        for index, sql in enumerate(statements, start=1):
            inserted += inserted_row_count(collector.d1_query(sql))
            if index % 10 == 0 or index == len(statements):
                print(f"  {index}/{len(statements)} statements sent")

        totals = collector.d1_query(
            "SELECT kind, COUNT(*) AS n FROM background_articles GROUP BY kind ORDER BY kind"
        )
    except Exception as error:
        # A workflow annotation is readable without signing in to GitHub, unlike
        # the step log. d1_query's message carries only the HTTP status and
        # Cloudflare's error body, never the token.
        message = " ".join(str(error).split())[:600]
        print(f"::error title=D1 sync failed::{message}")
        return 1

    counts = {
        row.get("kind"): row.get("n")
        for row in (totals.get("result") or [{}])[0].get("results") or []
    }
    summary = ", ".join(f"{kind} {n}" for kind, n in counts.items()) or "empty"
    print(f"::notice title=D1 background corpus::{inserted} new rows inserted; now {sum(counts.values())} total ({summary})")
    return 0


def inserted_row_count(response):
    """Rows a statement actually wrote; INSERT OR IGNORE reports 0 for duplicates."""
    return sum(
        int((statement.get("meta") or {}).get("changes") or 0)
        for statement in (response or {}).get("result") or []
        if isinstance(statement, dict)
    )


if __name__ == "__main__":
    sys.exit(main())
