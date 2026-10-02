#!/usr/bin/env python3
"""Load articles that already exist in this repository into the D1 background
corpus (ct-atlas-background-articles), one copy per story. Safe to run on
every push and on a schedule.

Sources (earlier ones win when two share a URL):
  related_article    other outlets' reports merged into each map event
                     (events.json related_articles). events-lite.json strips
                     them, so the report Worker has never seen them. They
                     inherit the parent event's category, actor, country,
                     region and incident id.
  removed_event      events archived by tools/cleanup_existing_events.py.
  recovered          former map events recovered from events.json's git
                     history by tools/recover_from_history.py (stored as
                     removed_event, with their related articles), related
                     articles dropped from events still on the map, and the
                     articles incident merges cut off (related-overflow-*).
  rejected_candidate background-articles.json, the collector's local fallback
                     for days when D1 was unreachable.
  historical_review  candidates Gemini reviewed and kept off the map that are
                     still in ai_article_selection_cache.json. Reviews cached
                     since October 2026 carry their article's link and date;
                     older ones only have a synthetic
                     "gemini-review:<fingerprint>" key and their review date.

Every row goes through tools/archive_dedup.py (plan_archive): off-topic
reviews (score 0) and second copies of a story are never inserted. With --cleanup apply (or ARCHIVE_CLEANUP=apply)
the rows of that kind already in D1 are deleted too; the default, plan, only
reports them.

Usage:
    python3 tools/sync_background_corpus.py --dry-run
    CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... python3 tools/sync_background_corpus.py [--cleanup apply]
"""
from __future__ import annotations

import argparse
import glob
import importlib.util
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import archive_dedup  # noqa: E402

_spec = importlib.util.spec_from_file_location("collector", ROOT / "collector.py")
collector = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(collector)

# Rows deleted per run at most (each delete costs D1 about 2 rows written; the
# Free plan allows 100,000 a day, shared with the collector and this sync).
MAX_DELETES_PER_RUN = 20_000


CORPUS_STATS_UPSERT = collector.BACKGROUND_CORPUS_STATS_UPSERT


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
                # Not stored in D1: lets the dedup plan see a translation and
                # its untranslated twin as one story.
                "original_title": article.get("original_title"),
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
                "original_title": event.get("original_title"),
                "kind": "removed_event",
                "parent_incident_id": event.get("incident_id"),
                "collected_at": data.get("removed_at") or data.get("created_at") or now,
            }


def recovered_articles(recovered_paths, overflow_paths, live_events, now):
    """Former map events recovered from events.json's history by
    tools/recover_from_history.py (as removed events, with their related
    articles), related articles dropped from events still on the map, and the
    articles the incident merges cut off (archive/related-overflow-*.json)."""
    yield from removed_events(recovered_paths, now)
    for path in recovered_paths:
        data = _load_json(path) or {}
        collected_at = data.get("created_at") or now
        for row in related_articles(data.get("events") or [], collected_at):
            yield row
        for item in data.get("related_articles") or []:
            parent = {**(item.get("parent") or {}), "related_articles": [item.get("article") or {}]}
            yield from related_articles([parent], collected_at)
    by_incident = {}
    for event in live_events:
        if event.get("incident_id"):
            by_incident.setdefault(event["incident_id"], event)
    for path in overflow_paths:
        data = _load_json(path) or {}
        collected_at = data.get("created_at") or now
        for item in data.get("articles") or []:
            if not isinstance(item, dict):
                continue
            parent = by_incident.get(item.get("incident_id")) or {"incident_id": item.get("incident_id")}
            yield from related_articles([{**parent, "related_articles": [item.get("article") or {}]}], collected_at)


def fallback_file_articles(path):
    data = _load_json(path) or {}
    for article in data.get("articles") or []:
        if isinstance(article, dict) and article.get("url") and article.get("title"):
            yield {**article, "kind": "rejected_candidate"}


def map_threshold(root=ROOT):
    """The score a review needs to reach the map: ct-atlas-runtime.json, the
    value the collector workflow exports. Reviews below it belong here, so the
    archive never drops the ones between the collector's code default (50) and
    the map's real threshold."""
    runtime = _load_json(root / "ct-atlas-runtime.json") or {}
    try:
        return int(runtime.get("ai_selection_threshold"))
    except (TypeError, ValueError):
        return collector.AI_SELECTION_THRESHOLD


def historical_reviews(cache, threshold=None):
    threshold = map_threshold() if threshold is None else threshold
    for fingerprint, item in ((cache or {}).get("items") or {}).items():
        result = (item or {}).get("result") or {}
        score = result.get("relevance_score")
        title = result.get("english_title")
        # Score 0 is Gemini's "no counter-terrorism content at all": noise.
        if not isinstance(score, (int, float)) or score <= 0 or score >= threshold or not title:
            continue
        article = (item or {}).get("article") or {}
        url = article.get("url") if archive_dedup.is_link(article.get("url")) else None
        categories = collector.normalize_categories(result.get("categories") or [])
        yield {
            "url": url or f"gemini-review:{fingerprint}",
            "kind": "historical_review",
            "title": title,
            "summary": result.get("english_summary"),
            "source": article.get("source"),
            "published": article.get("published"),
            "category": categories[0] if categories else None,
            "categories": categories,
            "actor_group": collector.canonicalize_actor_group(result.get("actor_group")),
            "primary_event_type": result.get("primary_event_type"),
            "original_language": result.get("original_language"),
            "ai_relevance_score": int(score),
            "ai_relevance_reason": result.get("reason"),
            "collected_at": item.get("reviewed_at") or datetime.now(timezone.utc).isoformat(),
        }


EXISTING_ROWS_SQL = (
    "SELECT url, kind, title, published, collected_at, ai_relevance_score FROM background_articles"
)


def existing_rows():
    """The rows already stored in D1 (only the fields the dedup plan reads), so
    a run only sends genuinely new rows and can spot copies of stored stories.

    Without this, every run re-submits the whole corpus as INSERT OR IGNORE;
    D1 bills those as rows written even when the constraint discards them,
    so a few runs in one day (e.g. iterating on this script, which triggers
    the workflow on every push) can burn through the daily write quota.
    """
    response = collector.d1_query(EXISTING_ROWS_SQL)
    results = (response.get("result") or [{}])[0].get("results") or []
    return [row for row in results if row.get("url")]


def delete_statements(urls, max_bytes=collector.CLOUDFLARE_D1_MAX_STATEMENT_BYTES):
    """DELETE ... WHERE url IN (...) statements under D1's statement size cap
    (literals, not bound parameters: D1 allows only 100 per statement)."""
    prefix = "DELETE FROM background_articles WHERE url IN ("
    batch, size = [], len(prefix.encode("utf-8")) + 1
    for url in urls:
        literal = collector.sql_literal(url)
        literal_bytes = len(literal.encode("utf-8")) + 1
        if batch and size + literal_bytes > max_bytes:
            yield prefix + ",".join(batch) + ")"
            batch, size = [], len(prefix.encode("utf-8")) + 1
        batch.append(literal)
        size += literal_bytes
    if batch:
        yield prefix + ",".join(batch) + ")"


def collect_articles(root=ROOT):
    now = datetime.now(timezone.utc).isoformat()
    database = _load_json(root / "events.json") or {}
    sources = {
        "related_article": related_articles(database.get("events") or [], now),
        "removed_event": removed_events(sorted(glob.glob(str(root / "archive" / "removed-events-*.json"))), now),
        "recovered": recovered_articles(
            sorted(glob.glob(str(root / "archive" / "recovered-events-*.json"))),
            sorted(glob.glob(str(root / "archive" / "related-overflow-*.json"))),
            database.get("events") or [],
            now,
        ),
        "rejected_candidate": fallback_file_articles(root / collector.BACKGROUND_ARTICLES_FILE),
        "historical_review": historical_reviews(
            _load_json(root / collector.AI_SELECTION_CACHE_FILE), map_threshold(root)
        ),
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


def cleanup_examples(delete, rows_by_url, per_reason=4):
    """A few titles per removal reason, for the run's log."""
    lines, shown = [], {}
    for url, reason, kept in delete:
        if shown.get(reason, 0) >= per_reason:
            continue
        shown[reason] = shown.get(reason, 0) + 1
        title = " ".join(str((rows_by_url.get(url) or {}).get("title") or "").split())[:110]
        kept_title = " ".join(str((rows_by_url.get(kept) or {}).get("title") or kept).split())[:110]
        lines.append(f"  [{reason}] {title}")
        if kept:
            lines.append(f"      kept: {kept_title}")
    return lines


def main(argv=None):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="Plan from the repository alone, without contacting D1.")
    parser.add_argument(
        "--cleanup", choices=("plan", "apply"), default=os.getenv("ARCHIVE_CLEANUP") or "plan",
        help="plan: only report the stored rows the dedup rules would remove; apply: delete them.",
    )
    parser.add_argument("--max-deletes", type=int, default=MAX_DELETES_PER_RUN)
    args = parser.parse_args(argv)

    articles, counts = collect_articles(ROOT)

    for kind, count in counts.items():
        print(f"{kind}: {count}")
    print(f"Total: {len(articles)} articles collected from the repository.")

    if args.dry_run:
        insert, _ = archive_dedup.plan_archive([], articles)
        print(f"Dry run: D1 not contacted; {len(insert)} of them are unique stories.")
        return 0

    inserted = deleted = 0
    try:
        stored = existing_rows()
        # D1 keeps no original headline: take it from the repository row
        # with the same link, so stored translations meet their twins too.
        original_by_url = {str(a["url"]): a.get("original_title") for a in articles if a.get("original_title")}
        for row in stored:
            row.setdefault("original_title", original_by_url.get(str(row["url"])))
        insert, delete = archive_dedup.plan_archive(stored, articles)
        known = {str(row["url"]) for row in stored}
        print(
            f"{sum(1 for a in articles if str(a['url']) in known)} already in D1; "
            f"{len(insert)} new unique stories to insert."
        )

        reasons = archive_dedup.summarize(delete)
        rows_by_url = {str(row["url"]): row for row in [*articles, *stored]}
        print(f"Stored rows the dedup rules reject: {len(delete)} {reasons or ''}")
        for line in cleanup_examples(delete, rows_by_url):
            print(line)

        rows = [collector.background_article_row(article) for article in insert]
        statements = list(
            collector.d1_insert_or_ignore_statements(
                "background_articles", collector.BACKGROUND_ARTICLES_D1_COLUMNS, rows
            )
        )
        print(f"Sending {len(rows)} row(s) in {len(statements)} INSERT statement(s).")
        for index, sql in enumerate(statements, start=1):
            inserted += inserted_row_count(collector.d1_query(sql))
            if index % 10 == 0 or index == len(statements):
                print(f"  {index}/{len(statements)} statements sent")

        if args.cleanup == "apply" and delete:
            urls = [url for url, _, _ in delete][: max(args.max_deletes, 0)]
            # meta.changes also counts the full-text index rows the delete
            # trigger touches, so the count reported is the rows requested.
            for sql in delete_statements(urls):
                collector.d1_query(sql)
            deleted = len(urls)
            print(f"Deleted {deleted} stored row(s) ({len(delete) - len(urls)} left for the next run).")

        totals = collector.d1_query(
            "SELECT kind, COUNT(*) AS n FROM background_articles GROUP BY kind ORDER BY kind"
        )
        # One-row summary the Worker's /database-stats reads, so the map can show
        # the archive's size without counting ~10k+ rows on every page view.
        collector.d1_query(CORPUS_STATS_UPSERT)
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
    # meta.changes also counts the full-text index rows the insert trigger
    # writes (three per row), so the rows added come from the totals.
    if counts:
        inserted = sum(int(n or 0) for n in counts.values()) - len(stored) + deleted
    summary = ", ".join(f"{kind} {n}" for kind, n in counts.items()) or "empty"
    pending = "" if args.cleanup == "apply" else f"; cleanup plan (not applied): {len(delete)} rows {reasons}"
    print(
        f"::notice title=D1 background corpus::{inserted} new rows inserted, {deleted} removed; "
        f"now {sum(counts.values())} total ({summary}){pending}"
    )
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
