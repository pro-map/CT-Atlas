#!/usr/bin/env python3
"""Gemini-only, resumable six-month history for eight Map topics in two Chinese scripts.

Search editions are discovery hints, NEVER event locations or proof of relevance.
Runs off the ordinary GEMINI enrichment ledger (no extra daily allowance), in
bounded batches. Checkpoints and publication metadata are separate from CBRNE.
No Qwen / Ollama dependency, no automatic background bulk processing.
"""
from __future__ import annotations

import argparse
import copy
import json
import signal
import sys
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))
import archive_review
import enrich_archive
import enrich_radnuc
import threat_categories

CONFIG = "chinese-gemini-backfill-queries.json"
MANIFEST = "archive/gemini-chinese-map-plan.json"
STATE = "archive/gemini-chinese-map-state.json"
STATUS = "archive/gemini-chinese-map-status.json"
SELECTED_PREFIX = "gemini-chinese-map-selected"
SEEN_PREFIX = "gemini-chinese-map-v1"
SCRIPTS = ("zh", "zh-Hant")
CONFIG_VERSION = "gemini-chinese-eight-map-history-v1-20261010"
CATEGORIES = (
    "Terrorist Financing", "Weapons", "Maritime Piracy", "Online / Cyber / AI",
    "Attacks", "Counter Terrorism Action", "Arrests", "Legal / Judicial",
)


def configuration(root=ROOT, collector=None):
    root = Path(root)
    config = json.loads((root / CONFIG).read_text(encoding="utf-8"))
    if (config.get("version") != CONFIG_VERSION or config.get("anchor") != "2026-10-10"
            or config.get("window_days") != 180):
        raise ValueError("Unexpected Chinese historical window/version: do not reset checkpoints")
    collector = collector or archive_review.load_collector(root)
    schema = collector.AI_SELECTION_SCHEMA["properties"]["results"]["items"]["properties"]
    labels = set(schema["categories"]["items"]["enum"])
    if set(CATEGORIES) != labels - set(threat_categories.LABELS):
        raise ValueError("Map category labels changed: inspect historical Chinese plan")
    if set(config.get("queries", {})) != set(CATEGORIES):
        raise ValueError("Missing Chinese Map category")
    for category in CATEGORIES:
        if set(config["queries"][category]) != set(SCRIPTS):
            raise ValueError(f"Missing Chinese edition for {category}")
        for code in SCRIPTS:
            queries = config["queries"][category][code]
            if len(queries) != 3 or len(set(queries)) != 3:
                raise ValueError(f"Expected three distinct native Chinese queries for {category}/{code}")
            if any(not isinstance(q, str) or ") (" not in q or len(q) > 380 for q in queries):
                raise ValueError("Chinese search expression lacks qualifying context")
    return config


def frozen_manifest(root, config):
    root = Path(root)
    start = date.fromisoformat(config["anchor"]) - timedelta(days=180)
    manifest = {"version": 1, "vocabulary_version": config["version"],
                "anchor": config["anchor"], "from": start.isoformat(),
                "through": config["anchor"], "window_days": 180}
    saved = archive_review.read_json(root / MANIFEST)
    if saved is not None and saved != manifest:
        raise ValueError("Existing Chinese history manifest differs; refusing reset")
    if saved is None:
        archive_review.write_json(root / MANIFEST, manifest)
    return manifest


def plan_tasks(config, collector):
    """Stable, interleaved sources across eight categories and both scripts."""
    first = date.fromisoformat(config["anchor"]) - timedelta(days=180)
    end = date.fromisoformat(config["anchor"]) + timedelta(days=1)
    monday = first - timedelta(days=first.weekday())
    windows = []
    while monday < end:
        windows.append((monday, max(monday, first), min(monday + timedelta(days=7), end)))
        monday += timedelta(days=7)
    profiles = {row["code"]: row for row in enrich_radnuc.CHINESE_BACKFILL_PROFILES}
    if set(profiles) != set(SCRIPTS):
        raise ValueError("Missing fixed Google News Simplified/Traditional editions")
    tasks = []
    for week, low, high in reversed(windows):
        for slot in range(3):
            for category in CATEGORIES:
                for script in SCRIPTS:
                    source = profiles[script]
                    task = {
                        "group": "gemini_chinese_map", "source": "google",
                        "category": category, "query": config["queries"][category][script][slot],
                        "locale": f"{source['hl']}|{source['gl']}|{source['ceid']}",
                        "code": script, "name": source["name"],
                        "hl": source["hl"], "gl": source["gl"], "ceid": source["ceid"],
                        "week": week.isoformat(), "start": low.isoformat(),
                        "end": high.isoformat(),
                    }
                    task["key"] = enrich_archive.task_key(task)
                    tasks.append(task)
    if len({task["key"] for task in tasks}) != len(tasks):
        raise ValueError("Chinese history key collision; do not reuse checkpoint IDs")
    return tasks


class ChineseMapOutput(enrich_archive.Output):
    """Reuse the production Gemini selection and incident-clustering code.

    Saved selection events are replayable even if a job ends before its
    working-copy events.json is committed. Nothing is marked 'published' here.
    """
    include_event = True

    def __init__(self, root, now, collector):
        super().__init__(root, now)
        self.root = Path(root)
        self.now = now
        self.collector = collector
        self.path = self.root / "archive" / f"gemini-chinese-map-reviews-{now:%Y%m%d}.json"
        self.data = archive_review.read_json(self.path) or {
            "created_at": now.isoformat(),
            "source": "Gemini historical Chinese news; search edition != event location",
            "articles": [],
        }
        self.database = archive_review.read_json(self.root / "events.json")
        if not isinstance(self.database, dict) or not isinstance(self.database.get("events"), list):
            raise ValueError("Invalid CT Atlas events database; refusing integration")
        self.changed = False
        self.integrated_reports = 0
        self.recover()

    def integrate(self, events):
        eligible = []
        for candidate in events:
            if not isinstance(candidate, dict):
                continue
            event = threat_categories.annotate(copy.deepcopy(candidate))
            if (event.get("ai_selected") is True
                    and event.get("ai_current_ct_event") is True
                    and set(event.get("categories") or ()) & set(CATEGORIES)
                    and not threat_categories.scope_reason(event)
                    and not self.collector.out_of_scope_reason(event)):
                eligible.append(event)
        if not eligible:
            return
        clustered = self.collector.deduplicate_events(eligible)
        merged = self.collector.deduplicate_incremental(
            copy.deepcopy(self.database["events"]), clustered)
        merged = self.collector.prune_old(merged)
        merged.sort(key=lambda ev: ev.get("published") or "", reverse=True)
        if merged != self.database["events"]:
            self.database["events"] = merged
            self.changed = True
        self.integrated_reports += len(eligible)  # source reports, NOT unique new events

    def recover(self):
        events = []
        for file in self.root.glob(f"archive/{SELECTED_PREFIX}-*.json"):
            saved = archive_review.read_json(file) or {}
            events.extend(saved.get("events") or [])
        if events:
            self.integrate(events)

    def add(self, rows):
        selected = [row.pop("selected_event", None) for row in rows]
        selected = [event for event in selected
                    if isinstance(event, dict) and event.get("ai_selected") is True]
        if selected:
            path = self.root / "archive" / f"{SELECTED_PREFIX}-{self.now:%Y%m%d}.json"
            prior = archive_review.read_json(path) or {"events": []}
            seen = {str(event.get("id")) for event in prior["events"]}
            for event in selected:
                if str(event.get("id")) not in seen:
                    prior["events"].append(event)
                    seen.add(str(event.get("id")))
            archive_review.write_json(path, prior, indent=None)
            self.integrate(selected)
        super().add(rows)

    def save(self):
        super().save()
        if self.changed:
            self.database["last_updated"] = datetime.now(timezone.utc).isoformat()
            self.database["gemini_chinese_history"] = {
                "window_days": 180, "editions": ["CN:zh-Hans", "TW:zh-Hant"],
                "publication": "Not confirmed until geolocation and deployment",
                "scope": "Eight non-specialist CT Atlas categories",
            }
            archive_review.write_json(self.root / "events.json", self.database, indent=2)
            self.changed = False


def progress(root, config, plan, batch=None, stop="Not yet run", added=0):
    """Queries, model reviews and NEW unique records are distinct counters."""
    root = Path(root)
    state = enrich_archive.load_state(root, STATE)
    done = set(state["done"])
    roots = {task["key"] for task in plan}
    rejected = set(state["rejected_queries"]) & roots
    children = state.get("children") or {}
    queued = state.get("pending_reviews") or []
    open_keys = (roots - done) | {key for key in children if key not in done}
    open_keys |= {item["_task"]["key"] for item in queued}
    stats = state.get("stats") or {}
    successful_fetches = sum(int(v.get("searches", 0)) for v in stats.values())
    problems = {name: sum(int(v.get(name, 0)) for v in stats.values())
                for name in ("query_errors", "failed_searches", "full_single_day")}
    by_category = {}
    for label in CATEGORIES:
        scoped = [task for task in plan if task["category"] == label]
        by_category[label] = {
            "planned_root_queries": len(scoped),
            "processed_root_queries_including_replaced": sum(x["key"] in done for x in scoped),
            "rejected_root_queries_not_successes": sum(x["key"] in rejected for x in scoped),
            "pending_root_queries": sum(x["key"] not in done for x in scoped),
            "queued_for_Gemini": sum(x["_task"].get("category") == label for x in queued),
        }
    report = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "vocabulary_version": config["version"], "anchor": config["anchor"],
        "window_days": 180, "model_backend": "gemini_existing_enrichment_ledger",
        "planned_root_queries": len(plan),
        "processed_root_queries_including_replaced": len(roots & done),
        "rejected_root_queries_not_successes": len(rejected),
        "confirmed_successful_source_fetches_including_split_children": successful_fetches,
        "pending_units_including_split_children": len(open_keys),
        "queued_candidates_waiting_for_Gemini": len(queued),
        "new_unique_event_records_this_batch": added,
        "publication_confirmed": False,
        "publication_state": "INTEGRATED_WORKING_COPY_AWAIT_GEO_AND_DEPLOY",
        "category_progress": by_category,
        "coverage_issues_historical": problems,
        "unresolved_rejected_queries": len(state.get("rejected_queries") or {}),
        "unresolved_saturated_queries": len(state.get("saturated_queries") or {}),
        "processing_complete": not open_keys,
        "complete_source_coverage": (
            not open_keys and not state.get("rejected_queries")
            and not state.get("saturated_queries") and not state.get("failures")),
        "latest_batch": batch or {}, "stop": stop,
        "note": "A retrieved article, rejected query, repeated source report or draft "
                "checkpoint is NEVER by itself a new published event. Local map "
                "record counts can change again after clustering and deployment.",
    }
    archive_review.write_json(root / STATUS, report)
    return report


def run(root=ROOT, max_posts=12, max_fetches=90, deadline_minutes=35,
        *, searcher=None, gate_factory=None, call_batch=None):
    if (not 0 <= max_posts <= 20 or not 0 <= max_fetches <= 150
            or not 1 <= deadline_minutes <= 50):
        raise ValueError("Refusing unbounded requests or CPU/source use")
    root = Path(root)
    now = datetime.now(timezone.utc)
    collector = archive_review.prepare_collector(
        archive_review.load_collector(root),
        threshold=archive_review.map_threshold(root))
    config = configuration(root, collector)
    frozen_manifest(root, config)
    plan = plan_tasks(config, collector)
    output = ChineseMapOutput(root, now, collector)
    original_ids = {str(x.get("id")) for x in output.database["events"]}
    output.save()  # recovered events are durable before any new source search
    summary, stop = enrich_archive.run(
        root, collector, max_posts, max_fetches, today=now.date(), now=now,
        searcher=searcher, gate_factory=gate_factory, call_batch=call_batch,
        plan_factory=lambda _day, _collector: plan, state_file=STATE,
        output_factory=lambda _root, _now: output,
        ledger_job="enrichment", seen_prefix=SEEN_PREFIX,
        known_keys_factory=enrich_archive.known_article_keys,
        reuse_previous_reviews=True, retry_failed_tasks=True,
        review_first=True, prioritize_native=True, refine_saturated=True,
        event_screen=enrich_archive.screen, deadline_minutes=deadline_minutes)
    output.save()
    integrated_new = len({str(x.get("id")) for x in output.database["events"]} - original_ids)
    report = progress(root, config, plan, summary, stop, added=integrated_new)
    print(json.dumps({
        "model": "Gemini", "successful_fetches": report[
            "confirmed_successful_source_fetches_including_split_children"],
        "pending": report["pending_units_including_split_children"],
        "reviewed_this_batch": summary.get("reviewed", 0),
        "new_local_records_not_yet_published": integrated_new,
        "status": report["publication_state"], "stop": stop,
    }, ensure_ascii=False), flush=True)
    return report


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--dry-run", action="store_true", help="List historical plan without any API calls or checkpoints")
    p.add_argument("--max-posts", type=int, default=12)
    p.add_argument("--max-fetches", type=int, default=90)
    p.add_argument("--deadline-minutes", type=int, default=35)
    args = p.parse_args()
    if args.dry_run:
        collector = archive_review.load_collector(ROOT)
        config = configuration(ROOT, collector)
        plan = plan_tasks(config, collector)
        print(json.dumps({
            "from": (date.fromisoformat(config["anchor"]) - timedelta(days=180)).isoformat(),
            "through": config["anchor"], "editions": SCRIPTS,
            "planned_root_queries": len(plan),
            "categories": dict(Counter(t["category"] for t in plan)),
            "note": "Dry run only: no articles reviewed or published",
        }, ensure_ascii=False, indent=2))
    else:
        run(max_posts=args.max_posts, max_fetches=args.max_fetches,
            deadline_minutes=args.deadline_minutes)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    main()
