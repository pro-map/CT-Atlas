"""Zero-network regression tests for eight-category Gemini Chinese history."""
import json
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))
import archive_review
import collector
import enrich_archive
import enrich_chinese_map as m
import threat_categories


class ChineseGeminiHistoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = m.configuration(ROOT, collector)
        cls.plan = m.plan_tasks(cls.config, collector)

    def test_eight_categories_both_chinese_editions_no_specialist_redefinition(self):
        self.assertEqual(len(m.CATEGORIES), 8)
        self.assertFalse(set(m.CATEGORIES) & set(threat_categories.LABELS))
        self.assertEqual(set(m.CATEGORIES), {task["category"] for task in self.plan})
        self.assertEqual({task["code"] for task in self.plan}, {"zh", "zh-Hant"})
        self.assertEqual({task["ceid"] for task in self.plan},
                         {"CN:zh-Hans", "TW:zh-Hant"})
        self.assertEqual({task["source"] for task in self.plan}, {"google"})
        self.assertEqual({task["locale"] for task in self.plan},
                         {"zh-CN|CN|CN:zh-Hans", "zh-TW|TW|TW:zh-Hant"})

    def test_exact_frozen_180_day_history_and_stable_search_ids(self):
        first = date(2026, 10, 10) - timedelta(days=180)
        windows = sorted({enrich_archive.window(task) for task in self.plan})
        self.assertEqual(windows[0][0], first)
        self.assertEqual(windows[-1][1], date(2026, 10, 11))
        self.assertTrue(all(a[1] == b[0] for a, b in zip(windows, windows[1:])))
        self.assertEqual(len(self.plan), 1248)
        self.assertEqual(len({task["key"] for task in self.plan}), len(self.plan))
        from collections import Counter
        self.assertEqual(set(Counter(t["category"] for t in self.plan).values()), {156})
        for task in self.plan:
            self.assertIn(") (", task["query"])

    def test_frozen_manifest_never_reset_and_rejected_queries_not_counted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive_review.write_json(root / m.CONFIG, self.config)
            first = m.frozen_manifest(root, self.config)
            self.assertEqual(first, m.frozen_manifest(root, self.config))
            progress = m.progress(root, self.config, self.plan)
            self.assertEqual(progress["planned_root_queries"], 1248)
            self.assertEqual(progress["confirmed_successful_source_fetches_including_split_children"], 0)
            self.assertEqual(progress["pending_units_including_split_children"], 1248)
            self.assertFalse(progress["publication_confirmed"])
            s = enrich_archive.load_state(root, m.STATE)
            task = self.plan[0]
            s["done"][task["key"]] = "2026-10-10T10:00:00Z"
            s["rejected_queries"][task["key"]] = {"task": task, "error": "provider rejected"}
            enrich_archive.save_state(root, s, [x["key"] for x in self.plan], m.STATE)
            progress = m.progress(root, self.config, self.plan)
            self.assertEqual(progress["processed_root_queries_including_replaced"], 1)
            self.assertEqual(progress["rejected_root_queries_not_successes"], 1)
            self.assertEqual(progress["confirmed_successful_source_fetches_including_split_children"], 0)
            self.assertFalse(progress["complete_source_coverage"])
            bad = dict(self.config)
            bad["version"] = "unreviewed"
            with self.assertRaises(ValueError):
                m.frozen_manifest(root, bad)

    def test_integration_requires_gemini_selection_and_preserves_geodata(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            now = datetime(2026, 10, 10, 10, 0, tzinfo=timezone.utc)
            prior = {"id": "existing-geo", "title": "Existing real incident",
                     "summary": "Security forces disrupted an extremist plot",
                     "published": "2026-10-09T08:00:00+00:00",
                     "categories": ["Arrests"], "category": "Arrests",
                     "latitude": 48.5, "longitude": 2.3, "source": "Official"}
            archive_review.write_json(root / "events.json", {"events": [prior]})
            out = m.ChineseMapOutput(root, now, collector)
            good = {"id": "chinese-new", "title": "Police arrest alleged extremist financier",
                    "original_title": "警方逮捕恐怖融资嫌疑人",
                    "summary": "Police reported an arrest over alleged financing of a terrorist group.",
                    "published": "2026-10-08T09:00:00+00:00", "categories": ["Terrorist Financing"],
                    "category": "Terrorist Financing", "source": "Test public outlet",
                    "url": "https://example.test/chinese-funding",
                    "latitude": 39.9, "longitude": 116.4, "actor_scope": "NON_STATE",
                    "ai_selected": True, "ai_current_ct_event": True,
                    "reported_status": "ALLEGED"}
            rejected = {**good, "id": "rejected",
                        "ai_selected": False, "title": "Unrelated article"}
            out.add([{"selected_event": good}, {"selected_event": rejected}])
            out.save()
            events = archive_review.read_json(root / "events.json")["events"]
            self.assertEqual(len(events), 2)
            self.assertEqual(next(e for e in events if e["id"] == "existing-geo")["latitude"], 48.5)
            self.assertEqual(next(e for e in events if e["id"] == "chinese-new")["reported_status"],
                             "ALLEGED")
            saved = archive_review.read_json(root / "archive" /
                    "gemini-chinese-map-selected-20261010.json")
            self.assertEqual(len(saved["events"]), 1)
            restored = m.ChineseMapOutput(root, now, collector)
            restored.save()
            self.assertEqual(len(archive_review.read_json(root / "events.json")["events"]), 2)

    def test_bounded_settings_reject_large_request_counts_without_any_network(self):
        for kwargs in ({"max_posts": 21}, {"max_fetches": 151},
                       {"deadline_minutes": 120}, {"max_posts": -1}):
            with self.subTest(kwargs=kwargs):
                with self.assertRaises(ValueError):
                    m.run(**kwargs)

    def test_no_ollama_uses_shared_gemini_ledger_and_leaves_daily_collector(self):
        code = (ROOT / "tools/enrich_chinese_map.py").read_text(encoding="utf-8")
        self.assertNotIn("qwen_backfill_adapter", code)
        self.assertIn('ledger_job="enrichment"', code)
        self.assertIn("known_article_keys", code)
        self.assertIn("deduplicate_incremental", code)
        workflow = (ROOT / ".github/workflows/update-map.yml").read_text(encoding="utf-8")
        self.assertIn('AI_SELECTION_MODEL: "gemini-3.5-flash-lite"', workflow)


if __name__ == "__main__":
    unittest.main()
