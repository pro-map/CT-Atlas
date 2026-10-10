#!/usr/bin/env python3
"""Test complete ATLAS selection schema with real historic reference excerpts.

No GitHub data changes, no Gemini call, no publication or actual event writes.
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
sys.path.insert(0,str(ROOT/"tools"))
import collector
from qwen_real_comparison import examples
from qwen_backfill_adapter import LocalQwenBackend

def main():
    selected=[]
    for category in ("Radiological/Nuclear","Chemicals and Explosives","Biological Terrorism"):
        selected.append(next(x for x in examples()
                             if x["target"]==category and category in x["gemini_labels"]
                             and x["gemini_selected"]))
    backend=LocalQwenBackend(collector)
    collector.AI_SELECTION_MODEL=backend.model
    start=time.monotonic()
    with backend.gate_factory(len(selected)) as gate:
        for i,row in enumerate(selected,1):
            original_title, _, original_summary = row["text"].partition("\n")
            source={"id":"p0","title":original_title,"summary":original_summary,
                    "original_language":row["language"],"published":"2026-06-01",
                    "source":"Previously reviewed public news","categories":[]}
            result=backend.call_batch([collector.selection_payload(source,0)])[0]
            labels=set(result["categories"])
            agree=row["target"] in labels
            print(f"FULL_SCHEMA {i}/{len(selected)} target={row['target']} "
                  f"language={row['language']} previous_Gemini_positive=True "
                  f"Qwen_has_target={agree} score={result['relevance_score']} "
                  f"status={result['reported_status']} valid_schema=True",flush=True)
        print(f"FULL_SCHEMA complete: {gate.posts} local inferences in "
              f"{time.monotonic()-start:.1f}s; data unchanged.",flush=True)
if __name__=="__main__":
    main()
