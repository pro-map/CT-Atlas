#!/usr/bin/env python3
"""Bounded real-source Qwen pipeline test in an ephemeral copy of CT ATLAS.

Deliberately NEVER commits, publishes, geolocates, deploys or writes production
events/checkpoints. Test-only public news queries with no paid AI provider.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
sys.path.insert(0,str(ROOT / "tools"))
import enrich_threat_categories as e

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    # The source tree is read-only. Only whitelisted files are copied to a
    # scratch directory in the standard runner; all changes die with this job.
    original=ROOT/"events.json"
    before_hash=digest(original)
    with tempfile.TemporaryDirectory(prefix="ct-qwen-backfill-sandbox-") as name:
        sandbox=Path(name)
        for item in ROOT.iterdir():
            if item.is_file() and (item.suffix in {".py",".json"}):
                shutil.copy2(item,sandbox/item.name)
        shutil.copytree(ROOT/"tools",sandbox/"tools",
                        ignore=shutil.ignore_patterns("__pycache__","*.pyc"))
        archive=sandbox/"archive"
        archive.mkdir()
        for item in (ROOT/"archive").iterdir():
            if item.is_file() and (item.name.startswith(("threat-","radnuc-",
                "biological-","chemical-explosives-","enriched-articles-",
                "enrichment-seen-")) or item.name.startswith(("radnuc-v1-seen-",
                "biological-v1-seen-","chemical-explosives-v1-seen-"))):
                shutil.copy2(item,archive/item.name)
        (sandbox/"quota").mkdir()
        quota_before={}
        for item in (ROOT/"quota").glob("*.json"):
            quota_before[item.name]=digest(item)
        print("SANDBOX verified: production events hash recorded; no production writes.",flush=True)
        report=e.run(root=sandbox,max_posts=6,max_fetches=18,deadline_minutes=9,
                     ai_backend="qwen")
        rows=report.get("categories") or {}
        for category,row in rows.items():
            last=row.get("last_run") or {}
            print(f"SANDBOX {category}: pending_searches={row.get('pending_searches')} "
                  f"awaiting_ai={row.get('queued_candidates')} "
                  f"local_AI_requests={last.get('ai_requests',0)} "
                  f"new_sandbox_events={last.get('new_event_records',0)} "
                  f"stop={last.get('stop','')}",flush=True)
        supplement=rows.get("Radiological/Nuclear",{}).get("supplemental_vocabulary",{})
        print(f"SANDBOX supplemental_181: processed={supplement.get('completed_searches')} "
              f"pending={supplement.get('pending_searches')}",flush=True)
        assert report.get("ai_backend")=="qwen"
        assert report.get("complete") is not None
    if digest(original)!=before_hash:
        raise RuntimeError("PRODUCTION EVENT FILE MODIFIED: STOP")
    for filename,old in quota_before.items():
        if digest(ROOT/"quota"/filename)!=old:
            raise RuntimeError("PRODUCTION GEMINI LEDGER MODIFIED: STOP")
    print("SANDBOX PASS: real search pathway exercised, zero production writes, "
          "no Gemini quota changes. This is NOT published backfill progress.",flush=True)

if __name__=="__main__":
    main()
