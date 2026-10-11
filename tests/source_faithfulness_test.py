"""Offline evidence-preserving editorial correction tests; no source/model calls."""
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import apply_source_faithfulness as repair


def event():
    return {"id": repair.RECORD_ID, "original_title": repair.ORIGINAL_TITLE,
            "source": repair.SOURCE, "published": repair.PUBLISHED,
            "summary": repair.OLD_SUMMARY, "latitude": 6.5833, "longitude": 122.05,
            "incident_id": "inc-7ffa74915c7dcf7d", "ai_geo_complete": True}


class SourceFaithfulnessTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "archive").mkdir()
        (self.root / "quota").mkdir()
        self.files = [self.root / "events.json",
                      self.root / "archive/gemini-chinese-map-selected-20261011.json",
                      self.root / "archive/gemini-chinese-map-reviews-20261011.json"]
        for i, path in enumerate(self.files):
            row = event()
            if i == 2:
                row.pop("id")
            data = {"events" if i < 2 else "articles": [row], "metadata": "unchanged"}
            path.write_text(json.dumps(data, ensure_ascii=False, indent=i + 1) + "\n", encoding="utf-8")
        self.checkpoint = self.root / "archive/gemini-chinese-map-state.json"
        self.quota = self.root / "quota/groq-oss120b-public-backfill.json"
        self.checkpoint.write_text('{"done":["retained"],"pending":["still waiting"]}')
        self.quota.write_text('{"requests":18,"reserved_tokens":90164}')

    def test_all_representations_change_only_exact_summary_bytes(self):
        before = {p: p.read_bytes() for p in self.files}
        state, quota = self.checkpoint.read_bytes(), self.quota.read_bytes()
        result = repair.run(self.root, apply=True)
        self.assertEqual(result["changed_summaries"], 3)
        for path, raw in before.items():
            expected = raw.replace(json.dumps(repair.OLD_SUMMARY).encode(), json.dumps(repair.NEW_SUMMARY).encode())
            self.assertEqual(path.read_bytes(), expected)
        self.assertEqual(self.checkpoint.read_bytes(), state)
        self.assertEqual(self.quota.read_bytes(), quota)
        self.assertFalse(result["publication_confirmed"])

    def test_dry_run_and_second_application_preserve_bytes(self):
        before = [p.read_bytes() for p in self.files]
        self.assertEqual(repair.run(self.root)["changed_summaries"], 3)
        self.assertEqual([p.read_bytes() for p in self.files], before)
        repair.run(self.root, apply=True)
        after = [p.read_bytes() for p in self.files]
        self.assertEqual(repair.run(self.root, apply=True)["changed_summaries"], 0)
        self.assertEqual([p.read_bytes() for p in self.files], after)

    def test_different_source_with_reused_id_refuses_before_any_write(self):
        data = json.loads(self.files[0].read_text())
        data["events"][0]["published"] = "2026-10-08"
        self.files[0].write_text(json.dumps(data))
        before = [p.read_bytes() for p in self.files]
        with self.assertRaises(ValueError):
            repair.run(self.root, apply=True)
        self.assertEqual([p.read_bytes() for p in self.files], before)

    def test_unknown_summary_and_unrelated_records_are_not_rewritten(self):
        row = event()
        row["summary"] = "A separately revised summary with additional evidence."
        value = {"events": [row, {"id": "other", "summary": repair.OLD_SUMMARY}]}
        before = copy.deepcopy(value)
        self.assertEqual(repair.correct_rows(value), 0)
        self.assertEqual(value, before)

    def test_ambiguous_occurrence_does_not_change_any_file(self):
        data = json.loads(self.files[0].read_text())
        data["unrelated_metadata"] = repair.OLD_SUMMARY
        self.files[0].write_text(json.dumps(data))
        before = [p.read_bytes() for p in self.files]
        with self.assertRaises(ValueError):
            repair.run(self.root, apply=True)
        self.assertEqual([p.read_bytes() for p in self.files], before)

    def test_invalid_map_only_defers_to_mandatory_guard_when_explicit(self):
        self.files[0].write_bytes(b'{"events":[')
        before = [p.read_bytes() for p in self.files]
        with self.assertRaises(ValueError):
            repair.run(self.root, apply=True)
        result = repair.run(self.root, apply=True, defer_invalid_map=True)
        self.assertTrue(result["deferred_to_mandatory_publication_guard"])
        self.assertEqual([p.read_bytes() for p in self.files], before)

    def test_failed_replace_never_truncates_original(self):
        before = [p.read_bytes() for p in self.files]
        with patch.object(repair.os, "replace", side_effect=OSError("test failure")):
            with self.assertRaises(OSError):
                repair.run(self.root, apply=True)
        self.assertEqual([p.read_bytes() for p in self.files], before)

    def test_nested_recovery_representation_keeps_other_fields(self):
        data = {"selected_event": event()}
        before = copy.deepcopy(data)
        self.assertEqual(repair.correct_rows(data), 1)
        before["selected_event"]["summary"] = repair.NEW_SUMMARY
        self.assertEqual(data, before)


if __name__ == "__main__":
    unittest.main()
