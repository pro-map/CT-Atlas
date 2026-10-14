"""Publication safety and honest counters across failure and partial recovery."""
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("finalize_daily_status", Path(__file__).resolve().parents[1] / "tools/finalize_daily_status.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
START = "2026-10-14T10:00:00+00:00"


def lane(candidates=0, reviewed=0, pending=0):
    return {"candidates": candidates, "reviewed": reviewed, "pending": pending}


def progress(**overrides):
    value = {"schema_version": 2, "run_started_at": START, "last_attempt_at": START,
             "status": "complete", "recent": lane(), "backlog": lane(), "maintenance": lane(),
             "source": {"status": "complete", "errors": []}, "reasons": []}
    value.update(overrides)
    return value


class FinalizeDailyStatusTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.path = self.root / "events.json"
        self.cache = self.root / "cache.json"
        self.sidecar = self.root / "status.json"
        self.radnuc = self.root / "radnuc.json"
        self.original = {"last_updated": "2026-10-13T18:00:00Z", "number_of_events": 1,
                         "trend_summary": {"overview": "Original overview"},
                         "events": [{"id": "old", "title": "Arrest", "ai_geo_complete": True,
                                     "latitude": None, "longitude": None}]}
        self.write(self.path, self.original)
        for command in (["git", "init", "--quiet"], ["git", "config", "user.email", "test@example.test"],
                        ["git", "config", "user.name", "Test"], ["git", "add", "events.json"],
                        ["git", "commit", "--quiet", "-m", "Published snapshot"]):
            subprocess.run(command, cwd=self.root, check=True, capture_output=True)

    @staticmethod
    def write(path, value):
        path.write_text(json.dumps(value), encoding="utf-8")

    def run_finalize(self, *, collect="success", geo="success", refresh=False, forced=False):
        return MODULE.finalize(self.path, collect_outcome=collect, geolocate_outcome=geo,
                               started_at=START, repository=self.root, cache_path=self.cache,
                               status_path=self.sidecar, radnuc_path=self.radnuc,
                               refresh_existing=refresh, geolocation_forced=forced)

    def test_failed_collection_restores_git_database_before_status_even_if_file_corrupt(self):
        self.path.write_text('{"events": [broken', encoding="utf-8")
        self.write(self.cache, {"selection_runtime_telemetry": {"schema_version": 2,
                    "run_started_at": "2026-10-13T10:00:00Z", "lanes": {"recent": lane(100, 100, 0)}}})
        result = self.run_finalize(collect="failure", geo="skipped")
        database = json.loads(self.path.read_text())
        self.assertEqual({key: value for key, value in database.items() if key != "collection_status"}, self.original)
        self.assertEqual(result["status"], "failed")
        self.assertIsNone(result["recent"]["reviewed"], "old cache counters cannot describe a failed new attempt")
        self.assertEqual(result["published_at"], self.original["last_updated"])
        self.assertEqual(result["geolocation"]["pending"], 0)
        self.assertEqual(result["geolocation"]["completed_unlocated"], 1)

    def test_failed_collection_keeps_fresh_review_progress_but_never_partial_event_swap(self):
        self.write(self.path, {"last_updated": "2099-01-01", "events": [{"id": "incorrect-partial"}]})
        self.write(self.cache, {"selection_runtime_telemetry": {"schema_version": 2,
                    "run_started_at": START, "lanes": {"recent": lane(4, 2, 2)}, "reasons": ["transient_error"]}})
        result = self.run_finalize(collect="failure", geo="failure")
        self.assertEqual(result["recent"]["pending"], 2)
        self.assertIn("transient_error", result["reasons"])
        self.assertIn("geolocation_failed", result["reasons"])
        self.assertEqual(json.loads(self.path.read_text())["events"], self.original["events"])

    def test_green_geolocation_with_pending_decisions_is_partial_and_unlocated_is_separate(self):
        updated = {**self.original, "events": self.original["events"] + [
            {"id": "unfinished", "ai_geo_complete": False},
            {"id": "untouched-new"},
            {"id": "new-located", "ai_geo_complete": True, "latitude": 12.0, "longitude": 5.0}],
            "collection_status": progress(), "geolocation": {"ai_processed_this_run": 1}}
        self.write(self.path, updated)
        result = self.run_finalize()
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["geolocation"]["pending"], 2)
        self.assertEqual(result["geolocation"]["completed_unlocated"], 1)
        self.assertEqual(result["geolocation"]["processed_this_run"], 1)
        self.assertIn("geolocation_pending", result["reasons"])
        self.assertEqual(json.loads(self.path.read_text())["events"], updated["events"])

    def test_processed_geolocation_count_uses_completed_transitions_not_input_summary(self):
        original = {**self.original, "events": [{"id": "pending-a", "ai_geo_complete": False},
                    {"id": "pending-b", "ai_geo_complete": False},
                    {"id": "done", "ai_geo_complete": True, "ai_geo_fingerprint": "stable"}]}
        self.write(self.path, original)
        subprocess.run(["git", "add", "events.json"], cwd=self.root, check=True)
        subprocess.run(["git", "commit", "--quiet", "-m", "Pending geo snapshot"], cwd=self.root, check=True)
        updated = {**original, "collection_status": progress(), "geolocation": {"ai_processed_this_run": 78},
                   "events": [{"id": "pending-a", "ai_geo_complete": True},
                              {"id": "pending-b", "ai_geo_complete": False},
                              {"id": "done", "ai_geo_complete": True, "ai_geo_fingerprint": "stable"}]}
        self.write(self.path, updated)
        self.assertEqual(self.run_finalize()["geolocation"]["processed_this_run"], 1)

    def test_forced_refresh_does_not_infer_processed_count_from_unchanged_records(self):
        self.write(self.sidecar, progress())
        self.assertIsNone(self.run_finalize(forced=True)["geolocation"]["processed_this_run"])

    def test_success_with_source_errors_is_partial_even_when_reviews_complete(self):
        self.write(self.sidecar, progress(source={"status": "partial", "errors": [{"source": "GDELT", "status": 429}]}))
        self.assertEqual(self.run_finalize()["status"], "partial")

    def test_complete_requires_known_consistent_counts_and_completed_steps(self):
        self.write(self.sidecar, progress())
        result = self.run_finalize()
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["reasons"], [])
        self.assertEqual(result["geolocation"]["pending"], 0, "completed but unlocated is not unfinished AI work")
        self.assertEqual(json.loads(self.path.read_text())["trend_summary"], self.original["trend_summary"])

    def test_known_reviews_without_source_evidence_do_not_imply_complete_collection(self):
        self.write(self.cache, {"selection_runtime_telemetry": {"schema_version": 2, "run_started_at": START,
                    "lanes": {name: lane() for name in MODULE.LANES}}})
        result = self.run_finalize()
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(result["source"]["status"], "unknown")

    def test_durable_queue_counts_take_priority_over_attempted_subset_telemetry(self):
        self.write(self.sidecar, progress(recent=lane(100, 20, 80)))
        self.write(self.cache, {"selection_runtime_telemetry": {"schema_version": 2, "run_started_at": START,
                    "lanes": {"recent": {**lane(40, 20, 20), "calls": 2}}}})
        result = self.run_finalize()
        self.assertEqual(result["recent"]["candidates"], 100)
        self.assertEqual(result["recent"]["pending"], 80)
        self.assertEqual(result["recent"]["calls"], 2)

    def test_unknown_early_attempt_retains_known_discovery_totals(self):
        self.write(self.sidecar, progress(recent={"candidates": 12, "reviewed": None, "pending": None}))
        result = self.run_finalize(collect="failure", geo="skipped")
        self.assertEqual(result["recent"]["candidates"], 12)
        self.assertIsNone(result["recent"]["reviewed"])
        self.assertIsNone(result["recent"]["pending"])

    def test_running_discovery_snapshot_merges_validated_subset_progress_on_failure(self):
        self.write(self.sidecar, progress(status="running", recent=lane(100, 0, 100)))
        self.write(self.cache, {"selection_runtime_telemetry": {"schema_version": 2, "run_started_at": START,
                    "lanes": {"recent": lane(40, 20, 20)}}})
        result = self.run_finalize(collect="failure", geo="skipped")
        self.assertEqual(result["recent"]["candidates"], 100)
        self.assertEqual(result["recent"]["reviewed"], 20)
        self.assertEqual(result["recent"]["pending"], 80)

    def test_refresh_legacy_status_never_relabels_input_totals_as_pending(self):
        self.write(self.cache, {"selection_runtime_telemetry": {"last_run_at": "2026-10-13T21:13:00Z",
                    "recent_pending": 3262, "backlog_pending": 8116, "partial_recovery": True, "budget_reached": True}})
        result = self.run_finalize(refresh=True)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["last_attempt_at"], "2026-10-13T21:13:00Z")
        self.assertEqual(result["recent"]["candidates"], 3262)
        self.assertIsNone(result["recent"]["pending"])
        self.assertIsNone(result["recent"]["reviewed"])
        self.assertEqual(result["backlog"]["candidates"], 8116)
        self.assertEqual(json.loads(self.path.read_text())["last_updated"], self.original["last_updated"])

    def test_refresh_preserves_a_known_prior_complete_attempt_without_inventing_new_one(self):
        previous = progress(geolocation={"status": "complete", "outcome": "success", "pending": 0, "processed_this_run": 1})
        self.write(self.path, {**self.original, "collection_status": previous})
        result = self.run_finalize(refresh=True)
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["last_attempt_at"], START)
        self.assertEqual(result["geolocation"]["processed_this_run"], 1)
        self.assertEqual(result["published_at"], self.original["last_updated"])

    def test_refresh_clears_derived_radnuc_pending_reason_after_category_completes(self):
        previous = progress(status="partial", reasons=["category_pending", "radnuc_background_partial"],
                            categories=[{"category": "Radiological/Nuclear", "status": "partial", "pending": 9}],
                            geolocation={"status": "complete", "outcome": "success", "pending": 0})
        self.write(self.path, {**self.original, "collection_status": previous})
        self.write(self.radnuc, {"updated_at": "2026-10-14T11:00:00Z", "counts": {"reviewed": 9},
                                "pending_reviews": 0, "batch_status": "complete", "complete": True})
        result = self.run_finalize(refresh=True)
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["reasons"], [])
        self.assertEqual(result["categories"][0]["pending"], 0)

    def test_refresh_preserves_failed_collection_and_failed_location_outcomes(self):
        previous = progress(status="failed", collect_outcome="failure", geolocate_outcome="failure",
                            reasons=["collection_failed", "transient_error", "geolocation_failed"],
                            geolocation={"status": "failed", "outcome": "failure", "pending": 0})
        self.write(self.path, {**self.original, "collection_status": previous})
        result = self.run_finalize(refresh=True)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["collect_outcome"], "failure")
        self.assertEqual(result["geolocation"]["status"], "failed")
        self.assertEqual(result["geolocation"]["outcome"], "failure")
        self.assertIn("transient_error", result["reasons"])

    def test_refresh_rejects_prior_success_cache_counters_for_a_newer_failed_attempt(self):
        unknown = {"candidates": None, "reviewed": None, "pending": None}
        previous = progress(status="failed", collect_outcome="failure", recent=unknown,
                            backlog=unknown, maintenance=unknown, reasons=["collection_failed"])
        self.write(self.path, {**self.original, "collection_status": previous})
        self.write(self.cache, {"selection_runtime_telemetry": {"schema_version": 2,
                    "run_started_at": "2026-10-13T10:00:00Z", "last_run_at": "2026-10-13T10:05:00Z",
                    "lanes": {"recent": lane(100, 100, 0), "backlog": lane(200, 200, 0)}}})
        result = self.run_finalize(refresh=True)
        self.assertEqual(result["status"], "failed")
        self.assertIsNone(result["recent"]["candidates"])
        self.assertIsNone(result["recent"]["reviewed"])
        self.assertIsNone(result["backlog"]["pending"])

    def test_refresh_accepts_current_checkpoint_from_wrapper_started_before_main(self):
        unknown = {"candidates": None, "reviewed": None, "pending": None}
        self.write(self.path, {**self.original, "collection_status": progress(status="failed", collect_outcome="failure", recent=unknown)})
        self.write(self.cache, {"selection_runtime_telemetry": {"schema_version": 2,
                    "run_started_at": "2026-10-14T09:59:58Z", "last_run_at": "2026-10-14T10:05:00Z",
                    "lanes": {"recent": lane(10, 3, 7)}}})
        result = self.run_finalize(refresh=True)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["recent"]["reviewed"], 3)
        self.assertEqual(result["recent"]["pending"], 7)

    def test_independent_radnuc_partial_is_visible_with_its_own_attempt_timestamp(self):
        self.write(self.sidecar, progress())
        self.write(self.radnuc, {"updated_at": "2026-10-14T06:12:23Z", "counts": {"reviewed": 41},
                    "pending_reviews": 459, "recent_pending": 443, "backlog_pending": 16, "batch_status": "partial"})
        result = self.run_finalize()
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["categories"][0]["candidates"], 500)
        self.assertEqual(result["categories"][0]["recent_pending"], 443)
        self.assertEqual(result["categories"][0]["last_attempt_at"], "2026-10-14T06:12:23Z")


if __name__ == "__main__":
    unittest.main()
