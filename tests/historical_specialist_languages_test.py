"""Offline regression tests for additive, historical-only language coverage."""
import copy
import json
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))
import collector
import threat_categories as topics
import enrich_archive
import enrich_radnuc
import enrich_threat_categories as runner
import historical_specialist_queries as native

ANCHOR = date(2026, 10, 8)
EXISTING = {"ar", "en", "fr", "zh", "zh-Hant"}
EXPECTED = {"ar", "bn", "de", "en", "es", "fa", "fr", "ha", "he", "hi",
            "id", "it", "ps", "pt", "ru", "so", "sw", "tr", "ur", "zh", "zh-Hant"}


class HistoricalSpecialistLanguagesTest(unittest.TestCase):
    def legacy_plan(self, category):
        with patch.object(native, "queries", return_value=[]):
            return runner.plan_tasks(category, ANCHOR, collector)

    def test_every_configured_native_code_has_discovery_queries(self):
        profiles = enrich_radnuc.profiles(collector)
        self.assertEqual({p["code"] for p in profiles}, EXPECTED)
        for category in topics.LABELS:
            plan = runner.plan_tasks(category, ANCHOR, collector)
            self.assertEqual({t["code"] for t in plan if t["source"] == "google"}, EXPECTED)

    def test_all_existing_task_keys_and_task_contents_are_preserved(self):
        for category in (topics.CE, topics.BIO):
            old = self.legacy_plan(category)
            new = {t["key"]: t for t in runner.plan_tasks(category, ANCHOR, collector)}
            self.assertGreater(len(new), len(old))
            for task in old:
                self.assertEqual(new[task["key"]], task)

    def test_rn_and_181_keyword_supplement_are_unchanged(self):
        with patch.object(native, "queries", side_effect=AssertionError("RN must not use native CE/BIO seeds")):
            plan = runner.plan_tasks(topics.RN, ANCHOR, collector)
        self.assertEqual(len(plan), 7560)
        self.assertEqual(sum(bool(t.get("supplemental_vocabulary")) for t in plan), 5238)

    def test_existing_languages_and_gdelt_get_no_extra_queries(self):
        for category in (topics.CE, topics.BIO):
            old = self.legacy_plan(category)
            current = runner.plan_tasks(category, ANCHOR, collector)
            keep = lambda t: t["source"] == "gdelt" or t["code"] in EXISTING
            self.assertEqual([t for t in current if keep(t)], old)

    def test_shared_daily_queries_and_profiles_are_not_modified(self):
        before_profiles = copy.deepcopy(collector.MULTILINGUAL_PROFILES)
        before_vocabulary = copy.deepcopy(topics.vocabulary())
        before_daily = copy.deepcopy(collector.CORE_SEARCH_QUERIES)
        for category in (topics.CE, topics.BIO):
            runner.plan_tasks(category, ANCHOR, collector)
            for code in EXPECTED - EXISTING:
                self.assertEqual(topics.queries(category, code), [])
        self.assertEqual(collector.MULTILINGUAL_PROFILES, before_profiles)
        self.assertEqual(topics.vocabulary(), before_vocabulary)
        self.assertEqual(collector.CORE_SEARCH_QUERIES, before_daily)

    def test_each_added_language_covers_the_same_frozen_180_day_window(self):
        for category in (topics.CE, topics.BIO):
            plan = runner.plan_tasks(category, ANCHOR, collector)
            for code in EXPECTED - EXISTING:
                tasks = [t for t in plan if t.get("code") == code and t["source"] == "google"]
                windows = sorted({enrich_archive.window(t) for t in tasks})
                self.assertEqual(windows[0][0], ANCHOR - timedelta(days=180))
                self.assertEqual(windows[-1][1], ANCHOR + timedelta(days=1))
                self.assertTrue(all(a[1] == b[0] for a, b in zip(windows, windows[1:])))
                self.assertTrue(all(t["category"] == category for t in tasks))

    def test_new_tasks_are_unique_stable_and_not_claimed_completed(self):
        for category in (topics.CE, topics.BIO):
            old = self.legacy_plan(category)
            current = runner.plan_tasks(category, ANCHOR, collector)
            self.assertEqual(len(current), len({t["key"] for t in current}))
            self.assertEqual(current, runner.plan_tasks(category, ANCHOR, collector))
            with tempfile.TemporaryDirectory() as folder:
                path = Path(folder) / "archive" / (runner.PREFIXES[category] + "-enrichment-state.json")
                path.parent.mkdir()
                payload = {"version": enrich_archive.STATE_VERSION,
                           "done": {t["key"]: "2026-10-08T00:00:00Z" for t in old}}
                path.write_text(json.dumps(payload))
                raw = path.read_bytes()
                status = runner.progress(folder, category, current)
                self.assertEqual(status["completed_searches"], len(old))
                self.assertEqual(status["pending_searches"], len(current) - len(old))
                self.assertFalse(status["processing_complete"])
                self.assertEqual(path.read_bytes(), raw)

    def test_query_terms_always_have_terrorism_context_and_are_bounded(self):
        self.assertEqual(set(native.SEEDS), EXPECTED - EXISTING)
        for code, (_, _, _, context) in native.SEEDS.items():
            for category in (topics.CE, topics.BIO):
                for query in native.queries(category, code):
                    self.assertIn(") (", query)
                    self.assertLess(len(query), 700)
                    self.assertTrue(all('"' + term + '"' in query for term in context))

    def test_only_missing_ce_bio_languages_receive_fallback(self):
        for category, code in ((topics.RN, "de"), ("Arrests", "de"), (topics.CE, "xx")):
            self.assertEqual(native.queries(category, code), [])
        for code in EXISTING:
            self.assertEqual(native.queries(topics.CE, code), [])

    def test_queries_return_independent_lists(self):
        first = native.queries(topics.CE, "de")
        expected = first[:]
        first.clear()
        self.assertEqual(native.queries(topics.CE, "de"), expected)

    def test_invalid_terms_are_rejected(self):
        for terms in ((), ("",), ('bad"term',), ("bad\nterm",), ("same", "same")):
            with self.assertRaises(ValueError):
                native._group(terms)


if __name__ == "__main__":
    unittest.main()
