"""Offline failure-path regression tests; no source/model calls or repository writes."""
import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import backfill_publication_guard as guard


def record(key="old"):
    return {"id": key, "title": "Public news record", "country": "Example",
            "latitude": 20.0, "longitude": 30.0, "ai_geo_complete": True,
            "location_method": "ai_city_geonames", "incident_id": "inc-" + key}


def encoded(events):
    return (json.dumps({"last_updated": "unchanged", "events": events}) + "\n").encode()


GOOD = dict(baseline="success", specialists="success", chinese="success",
            new_events="success", geo="success", quarantine="success")


class PublicationGuardTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = self.root / "events.json"
        self.base = self.root / "temporary" / "baseline.json"
        self.backup = self.root / "temporary" / "unvalidated.json"
        self.status = self.root / guard.STATUS
        self.before = encoded([record()])
        self.db.write_bytes(self.before)
        guard.snapshot(self.db, self.base)
        self.protected = self.root / "quota" / "ledger.json"
        self.protected.parent.mkdir()
        self.protected.write_text('{"requests":9,"reserved_tokens":45032}')
        self.checkpoint = self.root / "archive" / "source-state.json"
        self.checkpoint.parent.mkdir()
        self.checkpoint.write_text('{"done":["completed-source"],"queue":["pending"]}')

    def run_guard(self, outcomes=None, count="1", fallback=None):
        kw = {"fallback": fallback} if fallback else {}
        quota, state = self.protected.read_bytes(), self.checkpoint.read_bytes()
        report = guard.finalize(self.db, self.base, self.backup, self.status,
                                outcomes or GOOD, count, **kw)
        self.assertEqual(self.protected.read_bytes(), quota)
        self.assertEqual(self.checkpoint.read_bytes(), state)
        self.assertEqual(guard.verify(self.db, self.status), report)
        self.assertFalse(report["publication_confirmed"])
        return report

    def assert_withheld(self, outcomes, count="1"):
        attempted = self.db.read_bytes()
        report = self.run_guard(outcomes, count)
        self.assertFalse(report["publication_ready"])
        self.assertEqual(self.db.read_bytes(), self.before)
        self.assertEqual(self.backup.read_bytes(), attempted)
        self.assertEqual(report["new_validated_records"], 0)

    def test_failed_enrichment_with_skipped_validation_restores_map(self):
        self.db.write_bytes(encoded([record(), record("new")]))
        self.assert_withheld(dict(GOOD, specialists="failure", new_events="skipped", geo="skipped", quarantine="skipped"))

    def test_each_failed_or_cancelled_stage_refuses_publication(self):
        for name in GOOD:
            for result in ("failure", "cancelled", ""):
                with self.subTest(stage=name, result=result):
                    self.db.write_bytes(encoded([record(), record("new")]))
                    fallback = lambda _: self.before
                    report = self.run_guard(dict(GOOD, **{name: result}), fallback=fallback)
                    self.assertFalse(report["publication_ready"])
                    self.assertEqual(self.db.read_bytes(), self.before)

    def test_success_keeps_validated_new_record_without_claiming_publication(self):
        raw = encoded([record(), record("new")])
        self.db.write_bytes(raw)
        result = self.run_guard()
        self.assertTrue(result["publication_ready"])
        self.assertEqual(result["new_validated_records"], 1)
        self.assertEqual(self.db.read_bytes(), raw)
        self.assertFalse(self.backup.exists())

    def test_zero_call_maintenance_needs_no_geolocation(self):
        result = self.run_guard(dict(GOOD, specialists="skipped", chinese="skipped", geo="skipped"), "0")
        self.assertTrue(result["publication_ready"])
        self.assertEqual(self.db.read_bytes(), self.before)

    def test_missing_key_or_incomplete_geo_never_publishes_new_records(self):
        self.db.write_bytes(encoded([record(), record("new")]))
        self.assert_withheld(dict(GOOD, geo="skipped"))

    def test_green_steps_cannot_replace_actual_coordinate_checks(self):
        for changes in ({"latitude": None}, {"latitude": True}, {"latitude": 91},
                        {"longitude": 181}, {"ai_geo_complete": False}, {"latitude": float("nan")}):
            with self.subTest(changes=changes):
                self.db.write_bytes(encoded([record(), dict(record("new"), **changes)]))
                self.assert_withheld(GOOD)

    def test_protected_geography_changes_fail_closed(self):
        self.db.write_bytes(encoded([dict(record(), latitude=40), record("new")]))
        self.assert_withheld(GOOD)

    def test_missing_count_or_untracked_new_record_fail_closed(self):
        for count in ("", "-1", "0", "invalid"):
            self.db.write_bytes(encoded([record(), record("new")]))
            self.assert_withheld(GOOD, count)

    def test_quarantined_new_candidates_are_not_counted(self):
        result = self.run_guard(GOOD, "2")
        self.assertTrue(result["publication_ready"])
        self.assertEqual(result["new_validated_records"], 0)

    def test_corrupt_working_copy_preserved_before_restore(self):
        self.db.write_bytes(b'{"events": [')
        self.assert_withheld(GOOD)

    def test_duplicate_ids_fail_closed_without_deletion(self):
        self.db.write_bytes(encoded([record(), record()]))
        self.assert_withheld(GOOD)

    def test_missing_or_invalid_snapshot_uses_trusted_git_baseline(self):
        for raw in (None, b"invalid"):
            if raw is None:
                self.base.unlink(missing_ok=True)
            else:
                self.base.write_bytes(raw)
            self.db.write_bytes(encoded([record(), record("new")]))
            result = self.run_guard(fallback=lambda _: self.before)
            self.assertFalse(result["publication_ready"])
            self.assertEqual(self.db.read_bytes(), self.before)

    def test_backup_failure_does_not_overwrite_working_evidence(self):
        attempted = encoded([record(), record("new")])
        self.db.write_bytes(attempted)
        with patch.object(guard, "atomic_bytes", side_effect=OSError("unwritable")):
            with self.assertRaises(OSError):
                self.run_guard(dict(GOOD, quarantine="failure"))
        self.assertEqual(self.db.read_bytes(), attempted)
        self.assertFalse(self.status.exists())

    def test_failed_restore_preserves_original_and_backup(self):
        attempted = encoded([record(), record("new")])
        self.db.write_bytes(attempted)
        replace = guard.os.replace
        def fail_restore(src, dst):
            if Path(dst) == self.db:
                raise OSError("restore failed")
            replace(src, dst)
        with patch.object(guard.os, "replace", side_effect=fail_restore):
            with self.assertRaises(OSError):
                self.run_guard(dict(GOOD, quarantine="failure"))
        self.assertEqual(self.db.read_bytes(), attempted)
        self.assertEqual(self.backup.read_bytes(), attempted)
        self.assertFalse(self.status.exists())

    def test_changed_database_invalidates_guard_receipt(self):
        self.run_guard(dict(GOOD, geo="skipped"), "0")
        self.db.write_bytes(encoded([record(), record("extra")]))
        with self.assertRaises(ValueError):
            guard.verify(self.db, self.status)

    def test_real_local_git_fallback_without_snapshot(self):
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        subprocess.run(["git", "add", "events.json"], cwd=self.root, check=True)
        subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                        "commit", "-qm", "baseline"], cwd=self.root, check=True)
        self.base.unlink()
        self.db.write_bytes(encoded([record(), record("new")]))
        report = self.run_guard()
        self.assertFalse(report["publication_ready"])
        self.assertEqual(self.db.read_bytes(), self.before)

    def test_full_repository_map_snapshot_is_byte_identical(self):
        raw = (ROOT / "events.json").read_bytes()
        guard.parse_map(raw)
        self.db.write_bytes(raw)
        guard.snapshot(self.db, self.base)
        report = self.run_guard(dict(GOOD, geo="skipped"), "0")
        self.assertTrue(report["publication_ready"])
        self.assertEqual(self.db.read_bytes(), raw)
        self.assertEqual(report["new_validated_records"], 0)

    def test_workflow_always_commit_cannot_skip_final_guard(self):
        text = (ROOT / ".github/workflows/groq-free-backfill.yml").read_text()
        block = text.split("id: checkpoint", 1)[1].split("- name: Preserve publication receipt", 1)[0]
        self.assertIn("if: always()", block)
        self.assertLess(block.index("backfill_publication_guard.py finalize"), block.index("git add -- events.json"))
        self.assertLess(block.index("backfill_publication_guard.py verify"), block.index("git add -- events.json"))
        self.assertIn("needs.backfill.outputs.publication_ready == 'true'", text)
        self.assertIn("steps.checkpoint.outputs.publication_ready != 'true'", text)
        self.assertIn('GUARD_CHINESE: "skipped"', block)
        self.assertNotIn("id: chinese", text)
        self.assertNotIn("tools/enrich_chinese_map.py", text)
        for name in GOOD.keys() - {"chinese"}:
            self.assertIn("GUARD_" + name.upper() + ": ${{ steps." + name + ".outcome }}", text)


if __name__ == "__main__":
    unittest.main()
