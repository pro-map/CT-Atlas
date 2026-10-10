"""Tests for staged six-month Chinese whole-map history, without LLM or source calls."""
import copy
import json
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))

import collector
import threat_categories
import enrich_archive
import qwen_chinese_map_backfill as m
from enrich_radnuc import CHINESE_BACKFILL_PROFILES
from qwen_backfill_adapter import LocalQwenBackend

class ChineseWholeMapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config=m.configuration(ROOT,collector)
        cls.plan=m.plan_tasks(cls.config,collector)

    def test_eight_non_specialist_categories_and_two_chinese_editions(self):
        self.assertEqual(len(m.eight_categories(collector)),8)
        self.assertFalse(set(m.eight_categories(collector)) & set(threat_categories.LABELS))
        self.assertEqual({q["code"] for q in self.plan},{"zh","zh-Hant"})
        self.assertEqual({q["source"] for q in self.plan},{"google"})
        self.assertEqual(set(m.eight_categories(collector)),{q["category"] for q in self.plan})
        self.assertEqual({x["ceid"] for x in CHINESE_BACKFILL_PROFILES},{"CN:zh-Hans","TW:zh-Hant"})

    def test_180_days_are_frozen_and_every_category_present_in_each_window(self):
        intervals=sorted({enrich_archive.window(task) for task in self.plan})
        self.assertEqual(intervals[0][0],date(2026,10,10)-timedelta(days=180))
        self.assertEqual(intervals[-1][1],date(2026,10,11))
        self.assertTrue(all(a[1]==b[0] for a,b in zip(intervals,intervals[1:])))
        self.assertEqual(len(self.plan),len({t["key"] for t in self.plan}))
        for win in intervals:
            rows=[t for t in self.plan if enrich_archive.window(t)==win]
            for category in m.eight_categories(collector):
                for script in m.SCRIPTS:
                    self.assertEqual({t["query"] for t in rows if
                                      t["category"]==category and t["code"]==script},
                                     set(self.config["queries"][category][script]))

    def test_all_context_qualified_queries_and_separate_checkpoint_namespace(self):
        self.assertTrue(all(") (" in t["query"] for t in self.plan))
        self.assertNotIn(m.STATE, (enrich_archive.STATE_FILE,))
        self.assertNotIn("radnuc",m.STATE)
        self.assertFalse(set(self.config["queries"]) & set(threat_categories.LABELS))
        self.assertEqual(len({t["key"] for t in self.plan}),len(self.plan))

    def test_existing_daily_collector_and_specialist_plan_untouched(self):
        daily=(ROOT / ".github/workflows/update-map.yml").read_text(encoding="utf-8")
        self.assertIn("AI_SELECTION_MODEL: \"gemini-3.5-flash-lite\"",daily)
        self.assertNotIn("QWEN_BACKFILL_MODEL",daily)
        self.assertNotIn("qwen_chinese_map_backfill", (ROOT / "collector.py").read_text(encoding="utf-8"))
        self.assertTrue(set(threat_categories.LABELS).isdisjoint(m.eight_categories(collector)))

    def test_loopback_qwen_prompt_explicitly_includes_maritime_piracy_exception(self):
        adapter=LocalQwenBackend(collector,scope="map_chinese")
        self.assertIn("Maritime Piracy",adapter.instructions)
        self.assertIn("NO terrorism",adapter.instructions)
        self.assertIn("Chinese",adapter.instructions)
        self.assertIn("is_current_ct_event",adapter.schema["properties"]["results"]["items"]["required"])
        with self.assertRaises(ValueError):
            LocalQwenBackend(collector,scope="invalid")

    def test_manifest_does_not_slide_or_overwrite_and_progress_not_inflated(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/"archive").mkdir()
            (root/m.CONFIG).write_text(json.dumps(self.config,ensure_ascii=False),encoding="utf-8")
            original=m.freeze(root,self.config)
            self.assertEqual(original,m.freeze(root,self.config))
            report=m.progress(root,self.config,collector,self.plan)
            self.assertEqual(report["planned_root_queries"],len(self.plan))
            self.assertEqual(report["successful_root_queries"],0)
            self.assertEqual(report["new_events_integrated_into_map"],0)
            self.assertEqual(report["staged_reports_waiting_for_validation"],0)
            self.assertFalse(report["processing_complete"])
            self.assertEqual(report["pending_search_units_including_children"],len(self.plan))
            self.assertEqual(report["publication"],"QUARANTINED_NOT_PUBLISHED")
            sample=self.plan[0]
            state=enrich_archive.load_state(root,m.STATE)
            state["done"][sample["key"]]="fake"
            state["rejected_queries"][sample["key"]]={"task":sample,"error":"query rejected"}
            enrich_archive.save_state(root,state,[x["key"] for x in self.plan],m.STATE)
            report=m.progress(root,self.config,collector,self.plan)
            self.assertEqual(report["completed_root_queries_including_rejected"],1)
            self.assertEqual(report["successful_root_queries"],0)
            self.assertEqual(report["rejected_queries_not_successful"],1)
            self.assertEqual(report["new_events_integrated_into_map"],0)
            other=copy.deepcopy(self.config);other["version"]="unreviewed"
            with self.assertRaises(ValueError):m.freeze(root,other)

    def test_unbounded_cpu_batches_refused_before_any_llm_work(self):
        for posts,fetches,minutes in ((0,10,4),(999,10,4),(2,100000,4),(2,15,300)):
            with self.subTest(args=(posts,fetches,minutes)):
                with self.assertRaises(ValueError):
                    m.run(ROOT,max_posts=posts,max_fetches=fetches,deadline_minutes=minutes)

if __name__=="__main__":unittest.main()
