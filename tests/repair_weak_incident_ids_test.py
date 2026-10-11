import hashlib
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import repair_weak_incident_ids as repair


class WeakIncidentIdsTest(unittest.TestCase):
    def test_distinct_countries_no_longer_share_p2(self):
        incident = repair.anchor_id("p2")
        records = [
            {"id": "463d05ada300976a", "country": "United Arab Emirates", "incident_anchor": "p2", "incident_id": incident},
            {"id": "0b4ca7b7fdf48a64", "country": "Algeria", "incident_anchor": "p2", "incident_id": incident},
        ]
        self.assertEqual(repair.repair(records), 2)
        self.assertNotEqual(records[0]["incident_id"], records[1]["incident_id"])
        self.assertEqual(repair.repair(records), 0)

    def test_real_anchor_and_single_record_stay_unchanged(self):
        descriptive = repair.anchor_id("Dubai aircraft bombing plot")
        weak = repair.anchor_id("p2")
        records = [
            {"id": "a", "incident_anchor": "Dubai aircraft bombing plot", "incident_id": descriptive},
            {"id": "b", "incident_anchor": "p2", "incident_id": weak},
        ]
        self.assertEqual(repair.repair(records), 0)
        self.assertEqual(records[0]["incident_id"], descriptive)
        self.assertEqual(records[1]["incident_id"], weak)


if __name__ == "__main__":
    unittest.main()
