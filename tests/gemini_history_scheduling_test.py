"""Offline, zero-network regression tests for fair Gemini historical scheduling."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import enrich_archive


class HistoricalOrderingTests(unittest.TestCase):
    def setUp(self):
        self.tasks = [
            {"key": "normal-g1", "source": "google"},
            {"key": "normal-g2", "source": "google"},
            {"key": "normal-g3", "source": "google"},
            {"key": "normal-d", "source": "gdelt"},
            {"key": "supp-g1", "source": "google",
             "supplemental_vocabulary": "user-radnuc-181"},
            {"key": "supp-g2", "source": "google",
             "supplemental_vocabulary": "user-radnuc-181"},
            {"key": "supp-d", "source": "gdelt",
             "supplemental_vocabulary": "user-radnuc-181"},
        ]

    def test_opt_in_interleaves_without_losing_tasks_or_mutating_checkpoints(self):
        original = [dict(t) for t in self.tasks]
        result = enrich_archive.order_history_tasks(
            self.tasks, prioritize_native=True, interleave_supplement=True)
        self.assertEqual([x["key"] for x in result],
                         ["supp-g1", "normal-g1", "supp-g2", "normal-g2",
                          "normal-g3", "supp-d", "normal-d"])
        self.assertEqual({x["key"] for x in result},
                         {x["key"] for x in original})
        self.assertEqual(self.tasks, original)
        self.assertEqual(len(result), len(self.tasks))

    def test_default_preserves_legacy_gemini_ordering(self):
        ordered = enrich_archive.order_history_tasks(
            self.tasks, prioritize_native=True)
        self.assertEqual([x["key"] for x in ordered],
                         ["normal-g1", "normal-g2", "normal-g3",
                          "supp-g1", "supp-g2", "normal-d", "supp-d"])

    def test_no_supplement_produces_no_reordering(self):
        plain = [dict(t) for t in self.tasks[:4]]
        self.assertEqual(
            enrich_archive.order_history_tasks(
                plain, prioritize_native=False, interleave_supplement=True),
            plain)

    def test_both_source_types_remain_eligible_and_rejected_not_relabelled(self):
        task = {**self.tasks[0], "key": "rejected-query", "rejected": True}
        ordered = enrich_archive.order_history_tasks(
            [task, self.tasks[4]], prioritize_native=True,
            interleave_supplement=True)
        self.assertEqual({t["key"] for t in ordered},
                         {"rejected-query", "supp-g1"})
        self.assertTrue(next(t for t in ordered if t["key"] == "rejected-query")["rejected"])


if __name__ == "__main__":
    unittest.main()
