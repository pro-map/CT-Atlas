"""Retirement reduces active load while preserving complete archived evidence."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from retired_categories import active_categories, active_event, is_retired_judicial_event, judicial_headline_reason

spec = importlib.util.spec_from_file_location("retire_judicial", "tools/retire_judicial.py")
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


def event(ident, **fields):
    return {"id": ident, "title": ident, "published": "2026-10-14T08:00:00Z", **fields}


class RetirementPolicyTests(unittest.TestCase):
    def test_primary_judicial_is_retired_under_every_threat_topic(self):
        for category in ("Radiological/Nuclear", "Biological Terrorism", "Chemicals and Explosives", "Attacks"):
            self.assertTrue(is_retired_judicial_event(event("court", primary_event_type="JUDICIAL", category=category)))
        self.assertTrue(is_retired_judicial_event(event("court", primary_event_type=" judicial ")))

    def test_only_legacy_judicial_label_is_retired(self):
        for kind in (None, "OTHER_CT"):
            self.assertTrue(is_retired_judicial_event(event("court", primary_event_type=kind, category="Legal / Judicial")))
        self.assertFalse(is_retired_judicial_event(event("background", primary_event_type="BACKGROUND_INFO",
            category="Radiological/Nuclear")))

    def test_actual_incident_with_secondary_judicial_label_is_preserved(self):
        source = event("attack", primary_event_type="ATTACK", categories=["Attacks", "Legal / Judicial"])
        self.assertFalse(is_retired_judicial_event(source))
        self.assertEqual(active_categories(source), ["Attacks"])
        self.assertEqual(active_event(source)["category"], "Attacks")
        self.assertEqual(source["categories"], ["Attacks", "Legal / Judicial"], "Source evidence is not mutated.")
        for kind, category in (("ARREST", "Arrests"), ("FINANCING", "Terrorist Financing"),
                               ("CT_OPERATION", "Counter Terrorism Action")):
            item = event(kind, primary_event_type=kind, category="Legal / Judicial")
            self.assertFalse(is_retired_judicial_event(item))
            self.assertEqual(active_categories(item), [category])

    def test_headline_screen_is_conservative_and_never_reads_summary(self):
        court_titles = ["ISIS supporter convicted of terrorism", "Suspect sentenced for a terror attack",
                        "Man indicted on terrorism charges", "Terror trial begins in court",
                        "Suspect faces trial for terrorism", "Court rejects appeal by terrorist",
                        "Man charged with terrorism"]
        for title in court_titles:
            self.assertTrue(judicial_headline_reason({"title": title}), title)
        operational = ["Convicted extremist arrested in a police raid", "Court suspect arrested with explosives",
                       "Bomb attack kills five as convicted extremist is hunted", "Weapons seized during CT raid",
                       "Police thwarted terrorist plot near court", "RadNuc regulator publishes new safety standards"]
        for title in operational:
            self.assertIsNone(judicial_headline_reason({"title": title}), title)
        self.assertIsNone(judicial_headline_reason({"title": "Security forces arrest two suspects",
            "summary": "A court had convicted one suspect years earlier."}))
        # Retention is structured: headlines must not delete existing incidents.
        self.assertFalse(is_retired_judicial_event(event("Suspect sentenced for an attack",
            primary_event_type="ATTACK", category="Attacks")))


class MigrationTests(unittest.TestCase):
    def fixture(self, directory):
        source = Path(directory) / "events.json"
        archive = Path(directory) / "archive" / "removed-events-judicial-retired-20261014.json"
        court = event("shared-id", title="Court sentencing", primary_event_type="JUDICIAL",
                      category="Biological Terrorism", related_articles=[{"title": "full source evidence"}])
        active = event("shared-id", title="Real terrorist attack", primary_event_type="ATTACK", is_attack=True,
                       category="Legal / Judicial", categories=["Attacks", "Legal / Judicial"], latitude=1, longitude=2)
        data = {"number_of_events": 3, "events": [court, active,
                event("old-label", primary_event_type="OTHER_CT", category="Legal / Judicial")],
                "weekly_analysis": {"analysis": "old Judicial counts"},
                "trend_summary": {"developments": [{"event_id": "shared-id"}, {"event_id": "old-label"}]}}
        source.write_text(json.dumps(data), encoding="utf-8")
        return source, archive, data

    def test_evidence_is_preserved_and_active_migration_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            source, archive, original = self.fixture(directory)
            result = migration.migrate(source, archive)
            self.assertEqual(result, {"retired": 2, "cleaned": 1, "active": 1})
            saved = json.loads(source.read_text(encoding="utf-8"))
            evidence = json.loads(archive.read_text(encoding="utf-8"))
            self.assertEqual(evidence["events"][0]["related_articles"], original["events"][0]["related_articles"])
            self.assertEqual(evidence["previous_weekly_analysis"], original["weekly_analysis"])
            self.assertTrue(all(e["_cleanup_reason"].startswith("retired Judicial") for e in evidence["events"]))
            self.assertEqual(saved["events"][0]["categories"], ["Attacks"])
            self.assertEqual(saved["events"][0]["latitude"], 1)
            self.assertEqual(saved["number_of_events"], 1)
            self.assertEqual(saved["trend_summary"]["developments"], [{"event_id": "shared-id"}])
            self.assertEqual(saved["weekly_analysis"], {})
            before = (source.read_bytes(), archive.read_bytes())
            self.assertEqual(migration.migrate(source, archive), {"retired": 0, "cleaned": 0, "active": 1})
            self.assertEqual((source.read_bytes(), archive.read_bytes()), before)

    def test_dry_run_does_not_write_source_or_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            source, archive, _ = self.fixture(directory)
            before = source.read_bytes()
            self.assertEqual(migration.migrate(source, archive, dry_run=True)["retired"], 2)
            self.assertEqual(source.read_bytes(), before)
            self.assertFalse(archive.exists())

    def test_archive_failure_leaves_active_source_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            source, archive, _ = self.fixture(directory)
            before = source.read_bytes()
            with patch.object(migration, "atomic_json_write", side_effect=OSError("archive write failed")):
                with self.assertRaises(OSError):
                    migration.migrate(source, archive)
            self.assertEqual(source.read_bytes(), before)

    def test_database_write_failure_preserves_evidence_for_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            source, archive, _ = self.fixture(directory)
            before = source.read_bytes()
            original_write = migration.atomic_json_write
            def fail_source(path, data):
                if path == source:
                    raise OSError("database write failed")
                return original_write(path, data)
            with patch.object(migration, "atomic_json_write", side_effect=fail_source):
                with self.assertRaises(OSError):
                    migration.migrate(source, archive)
            self.assertEqual(source.read_bytes(), before)
            self.assertEqual(len(json.loads(archive.read_text())["events"]), 2)
            migration.migrate(source, archive)
            self.assertEqual(len(json.loads(archive.read_text())["events"]), 2, "Retry duplicates no evidence.")


if __name__ == "__main__":
    unittest.main()
