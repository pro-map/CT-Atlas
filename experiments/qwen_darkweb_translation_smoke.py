#!/usr/bin/env python3
"""Synthetic smoke test only. No Dark Web content or API credentials."""
from __future__ import annotations
import hashlib
import json
from qwen_darkweb_translation_probe import process

SAMPLES = [
    ("ar", "أعلنت الشرطة فتح تحقيق في تهديد أمني مزعوم", "قالت السلطات إنها فتحت تحقيقاً ولم تؤكد وقوع هجوم."),
    ("fr", "Une enquête a été ouverte après une menace présumée", "Selon les autorités, aucune attaque n'a été confirmée."),
    ("zh", "警方宣布调查一起涉嫌安全威胁的事件", "当局表示仍在调查，尚未确认发生袭击。"),
]

items = []
for i,(lang,title,summary) in enumerate(SAMPLES):
    items.append({"id":hashlib.sha256(f"fiction-{i}".encode()).hexdigest(),
                  "title":title, "excerpt":summary, "content_hash":hashlib.sha256(
                      (title+summary).encode()).hexdigest(),
                  "source_language":lang, "text_status":"excerpt"})
report = process(items)
assert len(report["titles"])==len(items)
assert [x["id"] for x in report["titles"]]==[x["id"] for x in items]
assert all(x["overview_en"].strip() and x["title"].strip() for x in report["titles"])
assert all(x["content_hash"]==item["content_hash"] and x["original"]==item["title"]
           for x,item in zip(report["titles"],items))
print("SYNTHETIC DARKWEB QWEN SMOKE: 3/3 structurally valid bilingual title/overview entries, "
      "hashes and originals preserved. Not a content accuracy validation.")
