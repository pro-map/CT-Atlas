#!/usr/bin/env python3
"""Isolated, read-only CPU feasibility probe for historical CBRNE backfill.

Does not fetch sources, read production events, consume Gemini quotas, or write
any CT ATLAS checkpoint. Examples below are synthetic, not real incidents.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from urllib.request import Request, urlopen

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from threat_categories import SELECTION_NOTE

MODEL = "qwen3.5:4b"
URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/") + "/api/chat"
CATEGORIES = ("Radiological/Nuclear", "Chemicals and Explosives", "Biological Terrorism")

# Fictitious news summaries. Never treat these as events or publish them.
CASES = [
    {
        "id": "en-radnuc-alleged",
        "text": "Prosecutors allege that a terrorist cell tried to acquire stolen radioactive medical sources for a planned attack. The suspects deny the charges; no device was found.",
        "expected": ["Radiological/Nuclear"],
    },
    {
        "id": "fr-explosive-plot",
        "text": "La police a annoncé l'arrestation d'un suspect dans un projet d'attentat terroriste à l'explosif contre une gare. Aucun attentat n'a eu lieu.",
        "expected": ["Chemicals and Explosives"],
    },
    {
        "id": "ar-bio-threat",
        "text": "أعلنت الشرطة أنها تحقق في تهديد صريح من جماعة متطرفة باستخدام عامل بيولوجي ضد محطة قطار. لم يتم تأكيد وجود أي عامل بيولوجي.",
        "expected": ["Biological Terrorism"],
    },
    {
        "id": "en-anthrax-hoax",
        "text": "Police investigated an extremist's hoax letter threatening to release anthrax at a public building. Laboratory tests found no biological agent.",
        "expected": ["Biological Terrorism"],
    },
    {
        "id": "en-accidental-chemical",
        "text": "An accidental chlorine leak at a chemical plant injured three workers. Authorities ruled out deliberate harm and any terrorism connection.",
        "expected": [],
    },
    {
        "id": "fr-medical-isotopes",
        "text": "Un centre hospitalier a publié un rapport de recherche sur les isotopes utilisés en imagerie médicale. Aucun incident ni menace n'a été signalé.",
        "expected": [],
    },
    {
        "id": "en-historical-article",
        "text": "An anniversary essay commemorated a bombing that happened twenty years ago. No new incident, investigation or judicial development was reported.",
        "expected": [],
    },
    {
        "id": "en-ordinary-crime",
        "text": "A police report says a suspect poisoned a relative in a domestic dispute. There is no alleged extremist motive or terrorism link.",
        "expected": [],
    },
]

SCHEMA = {
    "type": "object",
    "properties": {
        "categories": {
            "type": "array",
            "items": {"type": "string", "enum": list(CATEGORIES)},
        },
        "reported_status": {
            "type": "string",
            "enum": ["CONFIRMED", "SUSPECTED", "ALLEGED", "THREAT", "HOAX", "UNKNOWN"],
        },
        "reason": {"type": "string"},
    },
    "required": ["categories", "reported_status", "reason"],
    "additionalProperties": False,
}

SYSTEM = (
    "You classify news summaries for a SIX-MONTH HISTORICAL counterterrorism "
    "backfill. Judge as of the report date, not today. Only the following "
    "three specialist category labels may be used. Output valid JSON "
    "matching the supplied schema. For an event with no clearly reported "
    "non-state terrorism nexus or no concrete qualifying event, return "
    "categories=[]. Do not infer a confirmed agent, attack or attribution "
    "from a reported suspicion or hoax. Do not fabricate facts. "
    "The report may be in Arabic, French or English. "
    "This probe never creates real events.\n\n"
    + SELECTION_NOTE
)


def evaluate(case):
    request_data = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "Assess this report:\n" + case["text"]},
        ],
        "format": SCHEMA,
        "stream": False,
        "think": False,
        "options": {"temperature": 0.0, "num_ctx": 4096, "num_predict": 256},
        "keep_alive": "10m",
    }
    request = Request(
        URL, data=json.dumps(request_data, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST"
    )
    start = time.monotonic()
    with urlopen(request, timeout=180) as response:
        payload = json.loads(response.read().decode("utf-8"))
    elapsed = round(time.monotonic() - start, 2)
    raw = payload.get("message", {}).get("content", "")
    result = json.loads(raw)
    categories = result.get("categories")
    if not isinstance(categories, list) or any(c not in CATEGORIES for c in categories):
        raise ValueError("Model did not return valid category labels")
    if result.get("reported_status") not in SCHEMA["properties"]["reported_status"]["enum"]:
        raise ValueError("Model returned invalid reported_status")
    match = set(categories) == set(case["expected"])
    return {
        "id": case["id"],
        "expected": case["expected"],
        "actual": categories,
        "category_match": match,
        "seconds": elapsed,
        "status": result["reported_status"],
    }


def main():
    print("Qwen backfill-only isolated CPU pilot: synthetic examples, no live writes.", flush=True)
    reports = []
    for item in CASES:
        report = evaluate(item)
        reports.append(report)
        print(json.dumps(report, ensure_ascii=False), flush=True)
    matches = sum(row["category_match"] for row in reports)
    seconds = round(sum(row["seconds"] for row in reports), 2)
    print(f"BENCHMARK completed: exact category matches {matches}/{len(reports)}, "
          f"inference time {seconds}s. These are synthetic cases, NOT accuracy "
          "validation on real articles.", flush=True)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as dest:
            dest.write("# Qwen — backfill-only, CPU smoke test\n\n")
            dest.write("**Isolation:** No source collection, no production changes, "
                       "no Gemini requests, no saved events, no secrets or artifacts.\n\n")
            dest.write(f"**Model:** {MODEL}; **synthetic cases:** {len(reports)}; "
                       f"**exact category matches:** {matches}/{len(reports)}; "
                       f"**inference seconds:** {seconds}.\n\n")
            dest.write("| Case | Expected | Qwen | Match | Seconds |\n")
            dest.write("|---|---|---|---|---:|\n")
            for r in reports:
                expected = ", ".join(r["expected"]) or "none"
                actual = ", ".join(r["actual"]) or "none"
                dest.write(f"| {r['id']} | {expected} | {actual} | "
                           f"{'yes' if r['category_match'] else 'no'} | {r['seconds']} |\n")
            dest.write("\n**A green workflow means only that the test executed.** "
                       "It does not establish production readiness or equivalence to Gemini. "
                       "The daily ATLAS collector remains Gemini-based.\n")


if __name__ == "__main__":
    main()
