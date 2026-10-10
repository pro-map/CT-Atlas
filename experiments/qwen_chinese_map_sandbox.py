#!/usr/bin/env python3
"""Disposable CPU test of the all-category Chinese historical staging pipeline.

Never writes to the repository checkout or production database. No secrets,
paid APIs, custom GPU runners, or scheduled high-volume processing.
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
sys.path.insert(0,str(ROOT/"tools"))
import qwen_chinese_map_backfill as b

def main():
    with tempfile.TemporaryDirectory(prefix="qwen-map-chinese-sandbox-") as name:
        folder=Path(name)
        # Collector.py / metadata are copied for archive-review's dynamic
        # loader. Include selected archive data only if needed for dedup.
        for file in ROOT.iterdir():
            if file.is_file() and file.suffix in {".py",".json"}:
                shutil.copy2(file,folder/file.name)
        shutil.copytree(ROOT/"tools",folder/"tools",
                        ignore=shutil.ignore_patterns("__pycache__","*.pyc"))
        (folder/"archive").mkdir()
        (folder/"quota").mkdir()
        report=b.run(root=folder,max_posts=2,max_fetches=12,deadline_minutes=10)
        if report["publication"]!="QUARANTINED_NOT_PUBLISHED":
            raise SystemExit("Unexpected publication status")
        if report["new_events_integrated_into_map"]!=0:
            raise SystemExit("Forbidden live event integration")
        if report["successful_root_queries"] > report["completed_root_queries_including_rejected"]:
            raise SystemExit("Invalid search success accounting")
        if report["staged_reports_waiting_for_validation"] < 0:
            raise SystemExit("Invalid staged report count")
        if any((folder/"quota").iterdir()):
            raise SystemExit("Unexpected API quota state in local Qwen run")
        lines=["## Chinese whole-map 180-day Qwen: disposable test",
               "",
               "This is NOT a published backfill. Repository and CT ATLAS events unchanged.",
               f"Planned Chinese historical source searches: {report['planned_root_queries']}.",
               f"Successfully completed source searches: {report['successful_root_queries']}.",
               f"Rejected source queries (NOT successful): {report['rejected_queries_not_successful']}.",
               f"Remaining tasks incl. split children: {report['pending_search_units_including_children']}.",
               f"Candidates still waiting for Qwen: {report['queued_Qwen_candidates']}.",
               f"Qwen-selected reports staged in temporary directory ONLY: {report['staged_reports_waiting_for_validation']}.",
               f"Real map events added: {report['new_events_integrated_into_map']}.",
               f"Stop reason: {report['stop']}.",
               "",
               "| Category | Planned | Successful | Pending roots | Awaiting Qwen | Staged reports |",
               "|---|---:|---:|---:|---:|---:|"]
        for category,item in report["categories"].items():
            lines.append(f"| {category} | {item['planned']} | {item['successful_root_queries']} | "
                         f"{item['pending_root_queries']} | {item['queued_for_Qwen']} | "
                         f"{item['staged_selected_reports']} |")
        if b.ROOT / "events.json" != folder / "events.json":
            # These are independent copies by design; no write-back.
            pass
        import os
        if os.getenv("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"],"a",encoding="utf-8") as target:
                target.write("\n".join(lines)+"\n")
        print("\n".join(lines),flush=True)
        print("SANDBOX VERIFIED: temporary Qwen Chinese staging completed; no live changes",flush=True)

if __name__=="__main__":
    main()
