import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import repair_weak_incident_ids as repair


def event(record_id, anchor="p2", **fields):
    return dict(id=record_id, incident_anchor=anchor, incident_id=repair.anchor_id(anchor), **fields)


class WeakIncidentIdsTest(unittest.TestCase):
    def test_reported_pair_and_all_other_fields_preserved(self):
        records = [event("463d05ada300976a", country="United Arab Emirates", latitude=25.07725),
                   event("0b4ca7b7fdf48a64", country="Algeria", latitude=36.73225)]
        before = copy.deepcopy(records)
        self.assertEqual(repair.repair(records), 2)
        self.assertNotEqual(records[0]["incident_id"], records[1]["incident_id"])
        for old, new in zip(before, records):
            self.assertEqual({k:v for k,v in old.items() if k != "incident_id"},
                             {k:v for k,v in new.items() if k != "incident_id"})
        self.assertEqual(repair.repair(records), 0)

    def test_singleton_is_safe_before_next_batch_arrives(self):
        records = [event("a")]
        self.assertEqual(repair.repair(records), 1)
        first_id = records[0]["incident_id"]
        records.append(event("b"))
        self.assertEqual(repair.repair(records), 1)
        self.assertEqual(records[0]["incident_id"], first_id)
        self.assertNotEqual(first_id, records[1]["incident_id"])

    def test_archive_replay_is_deterministic(self):
        first, replay = event("a"), event("a")
        repair.repair([first]); repair.repair([replay])
        self.assertEqual(first, replay)

    def test_descriptive_and_consolidated_ids_unchanged(self):
        records = [event("a", "Dubai aircraft bombing plot"), event("b")]
        records[1]["incident_id"] = "inc-reviewed-real-case"
        before = copy.deepcopy(records)
        self.assertEqual(repair.repair(records), 0)
        self.assertEqual(records, before)

    def test_unrelated_legacy_duplicate_record_ids_are_not_modified(self):
        records = [event("legacy", "Case one"), event("legacy", "Case two"), event("a")]
        before = copy.deepcopy(records[:2])
        self.assertEqual(repair.repair(records), 1)
        self.assertEqual(records[:2], before)
        self.assertEqual(len(records), 3)

    def test_affected_duplicate_id_refuses_before_any_mutation(self):
        records = [event("good"), event("duplicate"), event("duplicate", "Other case")]
        before = copy.deepcopy(records)
        with self.assertRaises(ValueError):
            repair.repair(records)
        self.assertEqual(records, before)

    def test_missing_id_and_malformed_records_refused(self):
        for records in ([event("")], [None], {}):
            with self.subTest(records=records), self.assertRaises(ValueError):
                repair.repair(records)

    def test_replacement_collision_refused(self):
        records = [event("a"), event("b", "Real case")]
        records[1]["incident_id"] = repair.record_incident_id("a")
        with self.assertRaises(ValueError):
            repair.repair(records)

    def test_normalized_marker_and_meaningful_name(self):
        for anchor in ("p2", "P2", "paragraph-2", "item_12", "ｐ２"):
            self.assertTrue(repair.weak_anchor(anchor))
            record = event("a", anchor)
            self.assertEqual(repair.repair([record]), 1)
        self.assertFalse(repair.weak_anchor("Operation P2 in Dubai"))

    def test_file_write_is_idempotent_and_preserves_metadata(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "events.json"
            path.write_text(json.dumps({"updated": "unchanged", "events": [event("a")]}))
            self.assertEqual(repair.main(path), 1)
            first = path.read_bytes()
            self.assertEqual(repair.main(path), 0)
            self.assertEqual(path.read_bytes(), first)
            self.assertEqual(json.loads(first)["updated"], "unchanged")

    def test_failed_replace_leaves_original_file_intact(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "events.json"
            path.write_text(json.dumps({"events": [event("a")]}))
            before = path.read_bytes()
            with patch.object(repair.os, "replace", side_effect=OSError("test write failure")):
                with self.assertRaises(OSError):
                    repair.main(path)
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(list(Path(folder).glob("*.tmp")), [])

    def test_empty_database_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "events.json"
            path.write_text('{"events": []}')
            with self.assertRaises(ValueError):
                repair.main(path)


if __name__ == "__main__":
    unittest.main()
