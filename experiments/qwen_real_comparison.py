#!/usr/bin/env python3
"""Read-only Qwen/Gemini comparison on previously reviewed historical news.

Ground truth is the SAVED Gemini decision: agreement is not proof of correctness.
Never writes to events.json, checkpoints, archives, or production services.
"""
from __future__ import annotations

import hashlib
import json
import os
import random
import time
from collections import Counter
from pathlib import Path
from urllib.request import Request, urlopen

from qwen_backfill_probe import CATEGORIES, MODEL, SYSTEM, URL

ROOT = Path(__file__).resolve().parents[1]
SOURCES = {
    "Radiological/Nuclear": [
        "archive/radnuc-selected-20261008.json",
        "archive/radnuc-selected-20261009.json",
    ],
    "Chemicals and Explosives": [
        "archive/chemical-explosives-selected-20261008.json",
        "archive/chemical-explosives-selected-20261009.json",
    ],
    "Biological Terrorism": [
        "archive/biological-selected-20261008.json",
        "archive/biological-selected-20261009.json",
    ],
}
POSITIVES_PER_CATEGORY = 4
NEGATIVES_PER_CATEGORY = 3


def examples():
    result = []
    for category, files in SOURCES.items():
        positives, negatives, seen = [], [], set()
        for filename in files:
            path = ROOT / filename
            if not path.exists():
                raise FileNotFoundError(f"Expected reviewed reference file not found: {filename}")
            for event in json.loads(path.read_text(encoding="utf-8")).get("events", []):
                if not isinstance(event, dict):
                    continue
                title = str(event.get("original_title") or event.get("title") or "").strip()
                summary = str(event.get("original_summary") or event.get("summary") or "").strip()
                if len(title) < 12 or not summary or not event.get("ai_selection_complete"):
                    continue
                identity = str(event.get("url") or event.get("id") or title)
                if identity in seen:
                    continue
                seen.add(identity)
                row = {
                    "target": category,
                    "id": hashlib.sha256(identity.encode("utf-8")).hexdigest()[:12],
                    "text": title + "\n" + summary,
                    "language": event.get("original_language") or "",
                    "gemini_labels": [x for x in event.get("categories") or [] if x in CATEGORIES],
                    "gemini_selected": event.get("ai_selected") is True,
                    "gemini_status": event.get("reported_status") or "UNKNOWN",
                }
                (positives if category in row["gemini_labels"] and row["gemini_selected"] else negatives).append(row)
        rng = random.Random(category + "|20261010|fixed")
        rng.shuffle(positives)
        rng.shuffle(negatives)
        if len(positives) < POSITIVES_PER_CATEGORY or len(negatives) < NEGATIVES_PER_CATEGORY:
            raise ValueError(f"Insufficient comparable real records for {category}: "
                             f"{len(positives)} positive, {len(negatives)} negative")
        result.extend(positives[:POSITIVES_PER_CATEGORY] + negatives[:NEGATIVES_PER_CATEGORY])
    return result


def ask_qwen(row):
    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "Review this historical news excerpt. "
             "Use the content only: neither the original query nor label is proof.\n" + row["text"]},
        ],
        "format": {
            "type": "object",
            "properties": {
                "categories": {"type": "array", "items": {"type": "string", "enum": list(CATEGORIES)}},
                "reported_status": {"type": "string", "enum": [
                    "CONFIRMED", "SUSPECTED", "ALLEGED", "THREAT", "HOAX", "UNKNOWN"]},
                "reason": {"type": "string"},
            },
            "required": ["categories", "reported_status", "reason"],
            "additionalProperties": False,
        },
        "stream": False, "think": False,
        "options": {"temperature": 0, "num_ctx": 4096, "num_predict": 256},
        "keep_alive": "15m",
    }
    start = time.monotonic()
    request = Request(
        URL, method="POST",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    with urlopen(request, timeout=180) as response:
        result = json.loads(response.read().decode("utf-8"))
    parsed = json.loads(result["message"]["content"])
    if not isinstance(parsed.get("categories"), list) or any(
        c not in CATEGORIES for c in parsed["categories"]
    ):
        raise ValueError("Qwen output contains invalid specialist categories")
    return parsed, round(time.monotonic() - start, 2)


def main():
    rows = examples()
    stats = Counter()
    seconds = 0.0
    summary = ["# Qwen vs saved Gemini historical decisions — read-only\n",
               "**Caution:** agreement with previous Gemini classifications is not "
               "an independently validated precision/recall measure. "
               "A different answer requires human examination.\n",
               f"**Model:** {MODEL} on free standard CPU GitHub runner. "
               f"**Reference examples:** {len(rows)} (4 Gemini-positive and "
               "3 Gemini-negative per specialist category).\n",
               "| Category | Gemini positive | Qwen positive | Agree | Disagree | Seconds |",
               "|---|---:|---:|---:|---:|---:|"]
    by_cat = {}
    mismatches = []
    print(f"Read-only comparison: {len(rows)} real historical source article excerpts.", flush=True)
    for i, row in enumerate(rows, 1):
        result, elapsed = ask_qwen(row)
        seconds += elapsed
        gemini = row["target"] in row["gemini_labels"] and row["gemini_selected"]
        qwen = row["target"] in result["categories"]
        stats["agree" if gemini == qwen else "disagree"] += 1
        by_cat.setdefault(row["target"], {"g": 0, "q": 0, "agree": 0, "disagree": 0, "sec": 0.0})
        cat = by_cat[row["target"]]
        cat["g"] += int(gemini)
        cat["q"] += int(qwen)
        cat["agree" if gemini == qwen else "disagree"] += 1
        cat["sec"] += elapsed
        if gemini != qwen:
            mismatches.append({"category": row["target"], "ref": row["id"],
                               "language": row["language"], "gemini": gemini, "qwen": qwen,
                               "gemini_status": row["gemini_status"], "qwen_status": result["reported_status"]})
        print(f"PROGRESS {i}/{len(rows)} {row['target']} "
              f"language={row['language']} agree={gemini == qwen} sec={elapsed}", flush=True)
    for category, item in by_cat.items():
        summary.append(f"| {category} | {item['g']} | {item['q']} | {item['agree']} | "
                       f"{item['disagree']} | {item['sec']:.1f} |")
    summary.extend([
        "",
        f"**Overall:** {stats['agree']}/{len(rows)} agreement, "
        f"{stats['disagree']} disagreements; inference {seconds:.1f} seconds.",
        "",
        "**Disagreements for analyst review (short hashed identifiers only):**",
        "",
        "| Category | Ref | Source language | Gemini target | Qwen target | Gemini status | Qwen status |",
        "|---|---|---|---|---|---|---|",
    ])
    for row in mismatches:
        summary.append(f"| {row['category']} | {row['ref']} | {row['language']} | "
                       f"{row['gemini']} | {row['qwen']} | {row['gemini_status']} | {row['qwen_status']} |")
    summary.append("\n**No event additions, source fetches, API quota, or backfill state changes.** "
                   "A green workflow proves completion of comparison, not acceptance of Qwen for production.")
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write("\n".join(summary) + "\n")
    print(f"COMPARISON completed: {stats['agree']}/{len(rows)} matches vs Gemini saved labels; "
          f"{stats['disagree']} disagreements; {seconds:.1f}s.", flush=True)


if __name__ == "__main__":
    main()
