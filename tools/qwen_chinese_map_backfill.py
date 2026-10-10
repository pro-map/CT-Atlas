#!/usr/bin/env python3
"""Six-month Simplified + Traditional Chinese historical staging across 8 ATLAS categories.

Qwen performs classification on PUBLIC news in an isolated, checkpointed archive.
This script NEVER mutates events.json, the specialist backfills or Gemini quotas.
A stage item is NOT a validated/new map event. Run only in a disposable runner
until the real-world QA gate is met. The Gemini daily collector is independent.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))
import archive_review
import enrich_archive
import enrich_threat_categories
import qwen_backfill_adapter
import threat_categories
from enrich_radnuc import CHINESE_BACKFILL_PROFILES

CONFIG = "chinese-map-backfill-queries.json"
MANIFEST = "archive/qwen-chinese-map-plan.json"
STATE = "archive/qwen-chinese-map-state.json"
STATUS = "archive/qwen-chinese-map-status.json"
STAGED_PREFIX = "qwen-chinese-map-staged"
SEEN_PREFIX = "qwen-chinese-map"
SCRIPTS = ("zh", "zh-Hant")


def eight_categories(collector):
    props = collector.AI_SELECTION_SCHEMA["properties"]["results"]["items"]["properties"]
    all_labels = props["categories"]["items"]["enum"]
    labels = [x for x in all_labels if x not in threat_categories.LABELS]
    if len(all_labels) != 11 or len(labels) != 8 or len(set(labels)) != 8:
        raise ValueError("Map taxonomy changed: inspect the Chinese historical vocabulary")
    return labels


def configuration(root=ROOT, collector=None):
    root = Path(root)
    cfg = json.loads((root / CONFIG).read_text(encoding="utf-8"))
    if cfg.get("anchor") != "2026-10-10" or cfg.get("window_days") != 180:
        raise ValueError("Unexpected historical window; refuse to change previous checkpoint")
    collector = collector or archive_review.load_collector(root)
    labels = eight_categories(collector)
    if set(cfg.get("queries", {})) != set(labels):
        raise ValueError("Missing or extra category in Chinese history search config")
    for category, lang in cfg["queries"].items():
        if set(lang) != set(SCRIPTS):
            raise ValueError(f"Missing script/edition in {category}")
        for script, phrases in lang.items():
            if not 1 <= len(phrases) <= 8 or len(set(phrases)) != len(phrases):
                raise ValueError(f"Bad or duplicate native Chinese queries: {category}/{script}")
            if any(not isinstance(q, str) or not q.strip() or len(q) > 380 or ") (" not in q
                   for q in phrases):
                raise ValueError(f"Unqualified news query: {category}/{script}")
    return cfg


def freeze(root, config):
    root = Path(root)
    prior = archive_review.read_json(root / MANIFEST)
    start = date.fromisoformat(config["anchor"]) - timedelta(days=180)
    manifest = {
        "version": 1, "vocabulary_version": config["version"],
        "anchor": config["anchor"], "from": start.isoformat(),
        "through": config["anchor"], "window_days": 180,
        "status": "QUARANTINED_NOT_PUBLISHED",
    }
    if prior and prior != manifest:
        raise ValueError("Saved Chinese history manifest differs: refuse to reset work")
    if prior is None:
        archive_review.write_json(root / MANIFEST, manifest)
    return manifest


def plan_tasks(config, collector):
    anchor = date.fromisoformat(config["anchor"])
    first, end = anchor - timedelta(days=180), anchor + timedelta(days=1)
    monday = first - timedelta(days=first.weekday())
    windows = []
    while monday < end:
        windows.append((monday, max(monday, first), min(monday+timedelta(days=7), end)))
        monday += timedelta(days=7)
    profiles = {p["code"]: p for p in CHINESE_BACKFILL_PROFILES}
    if set(profiles) != set(SCRIPTS):
        raise ValueError("Missing Chinese source profiles")
    tasks = []
    # Round robin across all categories AND scripts for each week; do not let
    # one crowded source category starve the whole map in a bounded batch.
    for week, start, stop in reversed(windows):
        for index in range(max(len(q) for by_script in config["queries"].values()
                               for q in by_script.values())):
            for category in eight_categories(collector):
                for script in SCRIPTS:
                    phrases = config["queries"][category][script]
                    if index >= len(phrases):
                        continue
                    profile = profiles[script]
                    task = {
                        "group": "qwen_chinese_map", "source": "google",
                        "category": category, "query": phrases[index],
                        "locale": f"{profile['hl']}|{profile['gl']}|{profile['ceid']}",
                        "code": script, "name": profile["name"],
                        "hl": profile["hl"], "gl": profile["gl"], "ceid": profile["ceid"],
                        "week": week.isoformat(), "start": start.isoformat(), "end": stop.isoformat(),
                    }
                    task["key"] = enrich_archive.task_key(task)
                    tasks.append(task)
    if len({t["key"] for t in tasks}) != len(tasks):
        raise ValueError("Historical Chinese task identity collision")
    return tasks


def staged_article_keys(root):
    keys = enrich_threat_categories.known_map_keys(root)
    for path in (Path(root) / "archive").glob(f"{STAGED_PREFIX}-*.json"):
        rows = (archive_review.read_json(path) or {}).get("articles") or []
        for row in rows:
            keys.update(enrich_archive.article_keys(row.get("original_title") or row.get("title"),
                                                   row.get("source")))
            url = enrich_archive.link_key(row.get("url"))
            if url:
                keys.add(url)
    return keys


class StagedOutput(enrich_archive.Output):
    """Never integrates directly into events.json: human QA still required."""
    include_event = True

    def __init__(self, root, now):
        self.path = Path(root) / "archive" / f"{STAGED_PREFIX}-{now:%Y%m%d}.json"
        self.data = archive_review.read_json(self.path) or {
            "created_at": now.isoformat(), "articles": [],
            "source": "Qwen Chinese whole-map historical public-news staging",
            "publication_status": "QUARANTINED_NOT_PUBLISHED",
        }


def progress(root, config, collector, plan, batch=None, stop="Not run"):
    state = enrich_archive.load_state(root, STATE)
    done = set(state["done"])
    plan_keys = {t["key"] for t in plan}
    rejected = set(state["rejected_queries"]) & plan_keys
    queue = state.get("pending_reviews") or []
    children = state.get("children") or {}
    waiting = (plan_keys - done) | {k for k in children if k not in done}
    waiting |= {item["_task"]["key"] for item in queue}
    rows = []
    for path in (Path(root) / "archive").glob(f"{STAGED_PREFIX}-*.json"):
        rows.extend((archive_review.read_json(path) or {}).get("articles") or [])
    positive = [item for item in rows if item.get("ai_selected") and
                item.get("selected_event", {}).get("ai_selected")]
    grouped = {}
    for label in eight_categories(collector):
        category_tasks = [t for t in plan if t["category"] == label]
        grouped[label] = {
            "planned": len(category_tasks),
            "completed_root_queries": sum(t["key"] in done for t in category_tasks),
            "successful_root_queries": sum(t["key"] in done and t["key"] not in rejected
                                           for t in category_tasks),
            "pending_root_queries": sum(t["key"] not in done for t in category_tasks),
            "queued_for_Qwen": sum(x["_task"].get("category")==label for x in queue),
            "staged_selected_reports": sum(label in (x.get("categories") or []) for x in positive),
        }
    issues = {name: sum(int(stats.get(name, 0)) for stats in state["stats"].values())
              for name in ("query_errors", "failed_searches", "full_single_day")}
    report = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "vocabulary_version": config["version"], "anchor": config["anchor"],
        "window_days": 180, "model": "local_Qwen_3.5_4B",
        "categories": grouped,
        "planned_root_queries": len(plan),
        "completed_root_queries_including_rejected": len(plan_keys & done),
        "successful_root_queries": len(plan_keys & done - rejected),
        "rejected_queries_not_successful": len(rejected),
        "pending_search_units_including_children": len(waiting),
        "queued_Qwen_candidates": len(queue),
        "staged_reports_waiting_for_validation": len(positive),
        "new_events_integrated_into_map": 0,
        "coverage_issues": issues,
        "processing_complete": not waiting,
        "complete_source_coverage": (not waiting and not rejected and
                                     not state["saturated_queries"] and not any(issues.values())),
        "batch": batch or {}, "stop": stop,
        "publication": "QUARANTINED_NOT_PUBLISHED",
        "note": "No stage record is a verified new event; source failures or saturation are not successful retrievals.",
    }
    archive_review.write_json(Path(root) / STATUS, report)
    return report


def hash_file(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def run(root=ROOT, max_posts=4, max_fetches=25, deadline_minutes=12,
        *, searcher=None, gate_factory=None, call_batch=None):
    if not (1 <= max_posts <= 8 and 1 <= max_fetches <= 35 and 1 <= deadline_minutes <= 18):
        raise ValueError("Refusing an unbounded Qwen CPU or source-search run")
    root = Path(root)
    collector = archive_review.load_collector(root)
    config = configuration(root, collector)
    freeze(root, config)
    plan = plan_tasks(config, collector)
    before_events = hash_file(root / "events.json")
    quota_dir = root / "quota"
    gemini_before = {p.name: hash_file(p) for p in quota_dir.glob("gemini-*.json")}
    # Source evidence is reviewed strictly as of its historical publication.
    archive_review.prepare_collector(collector, threshold=archive_review.map_threshold(root))
    backend = qwen_backfill_adapter.LocalQwenBackend(collector, scope="map_chinese")
    collector.AI_SELECTION_MODEL = backend.model
    factory = lambda *_args: StagedOutput(root, datetime.now(timezone.utc))
    summary, stop = enrich_archive.run(
        root=root, collector=collector, max_posts=max_posts, max_fetches=max_fetches,
        deadline_minutes=deadline_minutes,
        plan_factory=lambda _day,_collector: plan,
        state_file=STATE, output_factory=factory,
        searcher=searcher,
        known_keys_factory=staged_article_keys, reuse_previous_reviews=False,
        seen_prefix=SEEN_PREFIX, retry_failed_tasks=True,
        refine_saturated=True, review_first=True, prioritize_native=True,
        ai_backend="qwen",
        gate_factory=gate_factory or backend.gate_factory,
        call_batch=call_batch or backend.call_batch,
    )
    if hash_file(root / "events.json") != before_events:
        raise RuntimeError("Production/staging event file mutated: block publishing")
    if {p.name: hash_file(p) for p in quota_dir.glob("gemini-*.json")} != gemini_before:
        raise RuntimeError("Gemini quota ledger unexpectedly mutated: block publishing")
    report = progress(root, config, collector, plan, batch=summary, stop=stop)
    print(json.dumps({
        "status": "QUARANTINED_NOT_PUBLISHED",
        "planned": report["planned_root_queries"],
        "successful_searches": report["successful_root_queries"],
        "pending": report["pending_search_units_including_children"],
        "AI_queued": report["queued_Qwen_candidates"],
        "staged_only": report["staged_reports_waiting_for_validation"],
        "integrated_into_map": 0,
        "stop": stop,
    }, ensure_ascii=False), flush=True)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="Show all eight categories and source coverage without fetching")
    parser.add_argument("--max-posts", type=int, default=4)
    parser.add_argument("--max-fetches", type=int, default=25)
    parser.add_argument("--deadline-minutes", type=float, default=12)
    args = parser.parse_args()
    if args.dry_run:
        collector = archive_review.load_collector(ROOT)
        config = configuration(ROOT, collector)
        plan = plan_tasks(config, collector)
        print(json.dumps({"categories": eight_categories(collector),
                          "languages": SCRIPTS, "from": "2026-04-13",
                          "through": "2026-10-10", "queries": len(plan),
                          "by_category": dict(Counter(p["category"] for p in plan))},
                         ensure_ascii=False, indent=2))
    else:
        run(max_posts=args.max_posts, max_fetches=args.max_fetches,
            deadline_minutes=args.deadline_minutes)


if __name__ == "__main__":
    main()
