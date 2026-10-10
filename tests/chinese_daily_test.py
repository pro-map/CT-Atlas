"""Chinese daily-Gemini discovery is additive, bounded and covers every map category."""
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))

import collector
import threat_categories as topics
import enrich_radnuc


class ChineseDailyTests(unittest.TestCase):
    def profiles(self):
        return [p for p in collector.MULTILINGUAL_PROFILES
                if p["code"] in {"zh", "zh-Hant"}]

    def test_two_supported_editions_only_no_site_guess(self):
        profiles = self.profiles()
        self.assertEqual(len(profiles), 2)
        self.assertEqual({p["ceid"] for p in profiles},
                         {"CN:zh-Hans", "TW:zh-Hant"})
        self.assertTrue(all(not p["sites"] for p in profiles))
        self.assertEqual({p["code"] for p in profiles}, {"zh", "zh-Hant"})

    def test_all_11_map_labels_receive_contextual_native_queries(self):
        reference = set(collector.AI_SELECTION_SCHEMA["properties"]["results"]["items"]
                        ["properties"]["categories"]["items"]["enum"])
        self.assertEqual(len(reference), 11)
        self.assertEqual(set(collector.CATEGORIES), reference)
        for profile in self.profiles():
            per_category = {}
            for q in profile["queries"]:
                per_category.setdefault(q["category"], []).append(q["term"])
            self.assertEqual(set(per_category), reference)
            for category, queries in per_category.items():
                self.assertTrue(queries, (profile["code"], category))
                self.assertEqual(len(queries), len(set(queries)))
                self.assertTrue(all(") (" in q and len(q) < 700 for q in queries))

    def test_normal_daily_uses_one_query_per_general_category_plus_specialist_vocabulary(self):
        config = collector.CHINESE_MAP_QUERY_CONFIG
        for profile in self.profiles():
            lang = profile["code"]
            for label, scripts in config["queries"].items():
                current = [q["term"] for q in profile["queries"] if q["category"] == label]
                self.assertEqual(current, [scripts[lang][0]])
            for category in topics.LABELS:
                q = [x["term"] for x in profile["queries"] if x["category"] == category]
                self.assertEqual(q, topics.queries(category, lang))
                self.assertTrue(q)

    def test_multilingual_intake_uses_gemini_without_new_quota_settings(self):
        self.assertEqual(len(self.profiles()), len(collector.CHINESE_DAILY_PROFILES))
        # This module only extends Google News discovery. No direct Qwen
        # dependency on the default daily collector and no new LLM providers.
        text = (ROOT / "collector.py").read_text(encoding="utf-8")
        self.assertNotIn("qwen_backfill_adapter", text)
        workflow = (ROOT / ".github/workflows/update-map.yml").read_text(encoding="utf-8")
        self.assertIn("AI_SELECTION_MODEL: \"gemini-3.5-flash-lite\"", workflow)
        self.assertIn("AI_SELECTION_DAILY_CALL_BUDGET: \"60\"", workflow)
        self.assertNotIn("QWEN_BACKFILL_URL", workflow)

    def test_chinese_specialist_backfill_remains_independent(self):
        plan = enrich_radnuc.profiles(collector)
        for edition in collector.CHINESE_DAILY_PROFILES:
            self.assertEqual(sum(1 for p in plan if
                                 (p["code"], p["ceid"]) == (edition["code"], edition["ceid"])), 1)


if __name__ == "__main__":
    unittest.main()
