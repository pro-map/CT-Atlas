#!/usr/bin/env python3
"""Describe disagreement cases from the read-only 21-item historical benchmark.

The positions below were identified by the completed 2026-10-10 runner logs.
Only already-public archive excerpts, no LLM calls or new source collection.
"""
from qwen_real_comparison import examples

DISAGREEMENT_POSITIONS = (1, 2, 10, 11, 15, 16, 17)
all_cases = examples()
for position in DISAGREEMENT_POSITIONS:
    item = all_cases[position - 1]
    title, _, text = item["text"].partition("\n")
    print(f"CASE {position}/21")
    print(f"category={item['target']} language={item['language']} ref={item['id']}")
    print(f"gemini_positive={item['gemini_selected']} gemini_labels={item['gemini_labels']}")
    print(f"original_title={title[:250]}")
    print(f"original_excerpt={text[:450]}")
    print("---")
print("All 7 disagreements occur in Gemini-positive sample positions; the 9 Gemini-negative "
      "control articles were not promoted by Qwen. This is NOT independently verified correctness.")
