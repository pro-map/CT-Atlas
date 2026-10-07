#!/usr/bin/env python3
"""Load articles that already exist in this repository into the D1 background
corpus (ct-atlas-background-articles), one copy per story. Safe to run on
every push and on a schedule.

One article per incident: the archive holds stories the map does not. A row
repeating a map event, and other outlets' reports on an incident
(related_article: events.json related_articles, the related articles of
recovered events, related-overflow-*), are not kept, and the ones already in D1
are deleted (plan_archive's map_stories and drop_kinds). An event that ages
out of the map is archived then, as an archived incident.

Sources (earlier ones win when two share a URL):
  removed_event      events archived by tools/cleanup_existing_events.py,
                     map events that aged out of the 180-day retention
                     (archive/removed-events-aged-out-YYYYMM.json, written by
                     the collector's prune_old step), and former map events
                     recovered from events.json's git history by
                     tools/recover_from_history.py; each filed by what
                     happened to it (former_event_verdict).
  enriched           the six-month enrichment's reviews
                     (archive/enriched-articles-*.json).
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
from collections import Counter
import importlib.util
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import archive_dedup  # noqa: E402

_spec = importlib.util.spec_from_file_location("collector", ROOT / "collector.py")
collector = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(collector)

# Rows deleted per run at most (each delete costs D1 about 2 rows written; the
# Free plan allows 100,000 a day, shared with the collector and this sync).
MAX_DELETES_PER_RUN = 20_000
# Rows inserted and re-filed per run at most (about 3 rows written each, the
# full-text index included). What is left waits for the next night.
MAX_INSERTS_PER_RUN = 6_000
MAX_UPDATES_PER_RUN = 5_000
# D1's Free plan caps a database at 500 MB; past this size only incidents and
# their reports are inserted, not background reporting.
SIZE_GUARD_BYTES = 400 * 1024 * 1024
LOW_PRIORITY_KINDS = frozenset({"rejected_candidate", "historical_review"})
# Other outlets' reports on an incident: one article per incident is enough.
DROPPED_KINDS = frozenset({"related_article"})


CORPUS_STATS_UPSERT = collector.BACKGROUND_CORPUS_STATS_UPSERT


def _load_json(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


CLEANUP_RECHECK_RE = re.compile(r"gemini re-check: score (\d+)")


def _int_or_none(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _parent_fields(parent):
    """What a report inherits from the map event it covers."""
    return {
        "category": parent.get("category"),
        "categories": parent.get("categories"),
        "actor_group": parent.get("actor_group"),
        "primary_event_type": parent.get("primary_event_type"),
        "country": parent.get("country"),
        "region": parent.get("region"),
        "parent_event_id": parent.get("id"),
        "parent_incident_id": parent.get("incident_id"),
    }


def live_incidents(events):
    """incident id -> the map event that leads it."""
    incidents = {}
    for event in events:
        if event.get("incident_id"):
            incidents.setdefault(event["incident_id"], event)
    return incidents


def review_verdict(item, threshold, incidents=None, aliases=None):
    """(kind, parent map event or None) for an article Gemini reviewed for the
    archive (tools/review_pending_archive.py, tools/enrich_archive.py), filed
    as the map would file it: kept only when the map's selection kept it
    (apply_ai_selection: the map's threshold, and in scope once translated).
    A kept article about an incident still on the map is one more outlet's
    report on it; any other kept article is an archived incident; the rest is
    reporting outside the map's scope, or noise at score 0."""
    score = _int_or_none(item.get("ai_relevance_score")) or 0
    if score <= 0:
        return "rejected_candidate", None
    used = _int_or_none(item.get("map_threshold")) or threshold
    selected = item.get("ai_selected")
    if selected is None:
        selected = score >= used
    if not selected or score < used:
        return "rejected_candidate", None
    incident = item.get("incident_id")
    if incident and incidents:
        parent = incidents.get(collector.resolve_incident_alias(incident, aliases or {})) or incidents.get(incident)
        if parent:
            return "related_article", parent
    return "archived_incident", None


def former_event_verdict(event, threshold, aged_out=False, incidents=None, aliases=None):
    """(kind, score, reason, parent) the archive should hold for a former map
    event, decided by what happened to it rather than by today's threshold:

      - commentary caught by the cleanup's opinion/analysis keywords stays
        commentary (removed_event);
      - a cleanup re-check carries the event's score today: the map dropped it
        (below the threshold, or out of scope once translated), so it is
        reporting outside the map's scope, or noise at score 0;
      - a fresh archive review (pending_review) is filed by review_verdict;
      - an event that aged out of the 180-day map, or was recovered from the
        map's history, was a CT incident on the map: an archived incident;
      - anything else keeps the old filing (removed_event)."""
    reason = str(event.get("_cleanup_reason") or "")
    score = _int_or_none(event.get("ai_relevance_score"))
    note = event.get("ai_relevance_reason")
    if reason.startswith("keyword:"):
        return "removed_event", score, note, None
    recheck = CLEANUP_RECHECK_RE.search(reason)
    if recheck:
        rescored = int(recheck.group(1))
        return ("rejected_candidate", rescored,
                f"Removed from the map when re-checked under the current rules (score {rescored}).", None)
    if reason:
        return "removed_event", score, note, None
    recovery = event.get("_recovery_reason")
    if recovery == "pending_review":
        kind, parent = review_verdict(event, threshold, incidents, aliases)
        return kind, score, note, parent
    if aged_out or recovery in ("retention_prune", "rereviewed"):
        if score == 0:
            return "rejected_candidate", 0, note, None
        return "archived_incident", score, note, None
    return "removed_event", score, note, None


def _file_time(data):
    return str(data.get("updated_at") or data.get("removed_at") or data.get("created_at") or "")


def former_event_files(paths):
    """[(path, data)] for every file of former map events, the most recent
    first: a link removed by a cleanup, put back on the map and later aged
    out is filed by what happened last (the first copy of a link wins)."""
    files = [(path, _load_json(path) or {}) for path in paths]
    return sorted(files, key=lambda item: (_file_time(item[1]), item[0]), reverse=True)


def removed_events(files, now, threshold=None, incidents=None, aliases=None):
    """Former map events, from former_event_files (or plain paths)."""
    threshold = map_threshold() if threshold is None else threshold
    for entry in files:
        path, data = entry if isinstance(entry, tuple) else (entry, _load_json(entry) or {})
        aged_out = "aged-out" in Path(path).name
        for event in data.get("events") or []:
            if not isinstance(event, dict) or not event.get("url") or not event.get("title"):
                continue
            kind, score, note, parent = former_event_verdict(event, threshold, aged_out, incidents, aliases)
            row = {
                **collector.background_article_from_event(event),
                "original_title": event.get("original_title"),
                "kind": kind,
                "ai_relevance_score": score,
                "ai_relevance_reason": note,
                "parent_incident_id": event.get("incident_id"),
                "collected_at": data.get("removed_at") or data.get("created_at") or now,
                # The repository's verdict on this link wins over the one stored.
                "_authoritative": True,
            }
            if parent:
                row.update(_parent_fields(parent))
            yield row


def enriched_articles(paths, threshold=None, incidents=None, aliases=None):
    """Articles the six-month enrichment found and Gemini reviewed
    (archive/enriched-articles-*.json, tools/enrich_archive.py): English
    headline and summary, the original headline kept for twin matching. They
    are only ever inserted: a link already stored keeps the verdict it has."""
    threshold = map_threshold() if threshold is None else threshold
    for path in paths:
        data = _load_json(path) or {}
        collected_at = data.get("created_at") or datetime.now(timezone.utc).isoformat()
        for article in data.get("articles") or []:
            if not isinstance(article, dict) or not article.get("url") or not article.get("title"):
                continue
            score = _int_or_none(article.get("ai_relevance_score"))
            if score is None:
                continue
            kind, parent = review_verdict(article, threshold, incidents, aliases)
            row = {
                **{column: article.get(column) for column in collector.BACKGROUND_ARTICLES_D1_COLUMNS},
                "original_title": article.get("original_title"),
                "kind": kind,
                "ai_relevance_score": score,
                "ai_relevance_reason": article.get("ai_scope_rejection") if kind == "rejected_candidate"
                and article.get("ai_scope_rejection") else article.get("ai_relevance_reason"),
                "collected_at": article.get("reviewed_at") or collected_at,
            }
            if parent:
                row.update(_parent_fields(parent))
            yield row


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
    first = (response.get("result") or [{}])[0]
    results = first.get("results") or []
    return [row for row in results if row.get("url")]


def database_size(response):
    """Bytes the D1 database holds (every query's meta.size_after), or None."""
    try:
        return int(((response.get("result") or [{}])[0].get("meta") or {}).get("size_after"))
    except (TypeError, ValueError, AttributeError):
        return None


# What a re-filing changes on a stored row.
REFILE_COLUMNS = ("kind", "ai_relevance_score", "ai_relevance_reason", "parent_event_id", "parent_incident_id")


def reconcile(stored, articles):
    """Stored rows whose repository source now gives another verdict (kind or
    score): a former map event re-filed by former_event_verdict, a review
    redone, or a link that is now another outlet's report on a map incident.
    The new verdict is overlaid on the stored rows in place, so the dedup plan
    ranks them as they are now and drops the ones that became noise. Returns
    the rows changed."""
    verdicts = {str(a["url"]): a for a in articles if a.get("_authoritative")}
    changed = []
    for row in stored:
        article = verdicts.get(str(row.get("url")))
        if article is None:
            continue
        kind, score = article.get("kind"), archive_dedup.score_of(article)
        if row.get("kind") == kind and archive_dedup.score_of(row) == score:
            continue
        for column in REFILE_COLUMNS:
            row[column] = article.get(column)
        row["ai_relevance_score"] = score
        changed.append(row)
    return changed


def update_statements(rows, max_bytes=collector.CLOUDFLARE_D1_MAX_STATEMENT_BYTES):
    """UPDATE statements setting each row's REFILE_COLUMNS (CASE on the url,
    literals, under D1's statement size cap)."""
    def statement(batch):
        urls = ",".join(collector.sql_literal(row["url"]) for row in batch)
        cases = []
        for column in REFILE_COLUMNS:
            whens = " ".join(
                f"WHEN {collector.sql_literal(row['url'])} THEN {collector.sql_literal(row.get(column))}"
                for row in batch
            )
            cases.append(f"{column} = CASE url {whens} END")
        return f"UPDATE background_articles SET {', '.join(cases)} WHERE url IN ({urls})"

    def row_bytes(row):
        url = len(collector.sql_literal(row["url"]).encode("utf-8"))
        values = sum(len(collector.sql_literal(row.get(column)).encode("utf-8")) for column in REFILE_COLUMNS)
        # The url appears in every CASE and in the IN list.
        return (len(REFILE_COLUMNS) + 1) * url + values + len(REFILE_COLUMNS) * len(" WHEN  THEN ") + 1

    base = len(statement([]).encode("utf-8"))
    batch, size = [], base
    for row in rows:
        cost = row_bytes(row)
        if batch and size + cost > max_bytes:
            yield statement(batch)
            batch, size = [], base
        batch.append(row)
        size += cost
    if batch:
        yield statement(batch)


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


def map_events(root=ROOT):
    """The map's events: the stories the archive does not repeat."""
    return (_load_json(root / "events.json") or {}).get("events") or []


def plan(stored, articles, events):
    """archive_dedup.plan_archive with the map's stories and the dropped kinds."""
    return archive_dedup.plan_archive(stored, articles, map_stories=events, drop_kinds=DROPPED_KINDS)


def collect_articles(root=ROOT):
    now = datetime.now(timezone.utc).isoformat()
    database = _load_json(root / "events.json") or {}
    events = database.get("events") or []
    threshold = map_threshold(root)
    incidents = live_incidents(events)
    aliases = collector.load_incident_state(str(root / collector.INCIDENT_STATE_FILE)).get("aliases") or {}
    recovered_paths = sorted(glob.glob(str(root / "archive" / "recovered-events-*.json")))
    former = former_event_files(sorted(glob.glob(str(root / "archive" / "removed-events-*.json"))) + recovered_paths)
    sources = {
        # Every former map event (cleanups, aged out, recovered, re-reviewed),
        # the latest verdict on each link first.
        "removed_event": removed_events(former, now, threshold, incidents, aliases),
        "enriched": enriched_articles(
            sorted(glob.glob(str(root / "archive" / "enriched-articles-*.json"))), threshold, incidents, aliases
        ),
        "rejected_candidate": fallback_file_articles(root / collector.BACKGROUND_ARTICLES_FILE),
        "historical_review": historical_reviews(
            _load_json(root / collector.AI_SELECTION_CACHE_FILE), threshold
        ),
    }

    # The archive keeps two years (the collector prunes older rows): an old
    # press release Google News dated as new, on the map for one run before
    # it aged out, is not inserted only to be pruned.
    oldest = (datetime.now(timezone.utc) - timedelta(days=collector.BACKGROUND_ARTICLES_D1_RETENTION_DAYS)).isoformat()
    seen = set()
    articles = []
    counts = {}
    for kind, iterator in sources.items():
        counts[kind] = 0
        for article in iterator:
            if article["url"] in seen:
                continue
            seen.add(article["url"])
            if article.get("published") and str(article["published"]) < oldest:
                continue
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
    parser.add_argument("--max-inserts", type=int, default=MAX_INSERTS_PER_RUN)
    parser.add_argument("--max-updates", type=int, default=MAX_UPDATES_PER_RUN)
    args = parser.parse_args(argv)

    articles, counts = collect_articles(ROOT)

    for kind, count in counts.items():
        print(f"{kind}: {count}")
    print(f"Total: {len(articles)} articles collected from the repository.")

    if args.dry_run:
        insert, _ = plan([], articles, map_events(ROOT))
        print(f"Dry run: D1 not contacted; {len(insert)} of them are unique stories.")
        return 0

    inserted = deleted = updated = 0
    try:
        response = collector.d1_query(EXISTING_ROWS_SQL)
        stored = [row for row in ((response.get("result") or [{}])[0].get("results") or []) if row.get("url")]
        size = database_size(response)
        # D1 keeps no original headline: take it from the repository row
        # with the same link, so stored translations meet their twins too.
        original_by_url = {str(a["url"]): a.get("original_title") for a in articles if a.get("original_title")}
        for row in stored:
            row.setdefault("original_title", original_by_url.get(str(row["url"])))
        changed = reconcile(stored, articles)
        insert, delete = plan(stored, articles, map_events(ROOT))
        known = {str(row["url"]) for row in stored}
        print(
            f"{sum(1 for a in articles if str(a['url']) in known)} already in D1; "
            f"{len(insert)} new unique stories to insert."
        )

        if size is not None and size >= SIZE_GUARD_BYTES:
            # D1's Free plan stops every write at 500 MB, the collector's too:
            # past the guard only incidents and their reports are added.
            held = [row for row in insert if row.get("kind") in LOW_PRIORITY_KINDS]
            insert = [row for row in insert if row.get("kind") not in LOW_PRIORITY_KINDS]
            print(f"::warning title=D1 archive near its size limit::{size // (1024 * 1024)} MB stored; "
                  f"{len(held)} background row(s) not inserted.")

        if len(insert) > args.max_inserts:
            print(f"Inserting the best {max(args.max_inserts, 0)} now; {len(insert) - max(args.max_inserts, 0)} "
                  f"wait for the next run.")
            insert = insert[: max(args.max_inserts, 0)]
        # A stored row is only removed for a copy that is in D1 tonight (or on
        # the map): never for one the size guard or the cap held back.
        kept_urls = known | {str(row["url"]) for row in insert}
        delete = [(url, reason, kept) for url, reason, kept in delete
                  if not kept or reason == "on_map" or kept in kept_urls]

        reasons = archive_dedup.summarize(delete)
        rows_by_url = {str(row["url"]): row for row in [*articles, *stored]}
        print(f"Stored rows the dedup rules reject: {len(delete)} {reasons or ''}")
        for line in cleanup_examples(delete, rows_by_url):
            print(line)

        # Rows that became noise are deleted below, not re-filed.
        deleting = {url for url, _, _ in delete}
        refile = [row for row in changed if str(row["url"]) not in deleting]
        print(f"Stored rows re-filed by their repository verdict: {len(refile)} "
              f"{dict(Counter(row['kind'] for row in refile)) or ''}")
        if args.cleanup == "apply" and refile:
            batch = refile[: max(args.max_updates, 0)]
            for sql in update_statements(batch):
                collector.d1_query(sql)
            updated = len(batch)
            print(f"Re-filed {updated} stored row(s) ({len(refile) - updated} left for the next run).")

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
        f"::notice title=D1 background corpus::{inserted} new rows inserted, {deleted} removed, {updated} re-filed; "
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
