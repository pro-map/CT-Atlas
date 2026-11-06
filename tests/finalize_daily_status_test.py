"""Publication safety and honest counters across failure and partial recovery."""
import importlib.util
import io
import json
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

SPEC =importlib.util.spec_from_file_location("finalize_daily_status", Path(__file__).resolve().parents[1] / "tools/finalize_daily_status.py")
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


class LaterClock(datetime):
    """A clock one hour on, so a rewritten finalized_at is visible."""
    @classmethod
    def now(cls, tz=None):
        return datetime(2026, 10, 14, 13, 0, tzinfo=timezone.utc)


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

    def test_refresh_clears_resolved_geolocation_review_reason(self):
        previous = progress(status="partial", reasons=["geolocation_review_required"],
                            geolocation={"status": "complete", "outcome": "success", "pending": 0,
                                         "review_required": 1})
        self.write(self.path, {**self.original, "collection_status": previous})
        result = self.run_finalize(refresh=True)
        self.assertEqual(result["geolocation"]["review_required"], 0)
        self.assertNotIn("geolocation_review_required", result["reasons"])
        self.assertEqual(result["status"], "complete")

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

    def refresh_later(self):
        with patch.object(MODULE, "datetime", LaterClock):
            return self.run_finalize(refresh=True)

    def test_refresh_without_any_change_keeps_finalized_at_and_both_files(self):
        # The second refresh of a cycle only changed finalized_at, which made git
        # commit and Pages, the mirror and every open map republish the same data.
        self.write(self.path, {**self.original, "collection_status": progress(
            geolocation={"status": "complete", "outcome": "success", "pending": 0})})
        first = self.run_finalize(refresh=True)
        database, sidecar = self.path.read_bytes(), self.sidecar.read_bytes()
        second = self.refresh_later()
        self.assertEqual(second, first)
        self.assertEqual(self.path.read_bytes(), database)
        self.assertEqual(self.sidecar.read_bytes(), sidecar)
        self.assertEqual(json.loads(database)["collection_status"]["finalized_at"], first["finalized_at"])

    def test_refresh_with_a_real_change_still_records_a_new_finalized_at(self):
        self.write(self.path, {**self.original, "collection_status": progress(
            geolocation={"status": "complete", "outcome": "success", "pending": 0})})
        first = self.run_finalize(refresh=True)
        self.write(self.radnuc, {"updated_at": "2026-10-14T12:30:00Z", "counts": {"reviewed": 3},
                                "pending_reviews": 2, "batch_status": "partial"})
        second = self.refresh_later()
        self.assertEqual(second["finalized_at"], "2026-10-14T13:00:00+00:00")
        self.assertNotEqual(second["finalized_at"], first["finalized_at"])
        self.assertEqual(json.loads(self.path.read_text())["collection_status"], second)
        self.assertEqual(json.loads(self.sidecar.read_text()), second)

    def test_unchanged_refresh_still_repairs_a_missing_sidecar(self):
        self.write(self.path, {**self.original, "collection_status": progress(
            geolocation={"status": "complete", "outcome": "success", "pending": 0})})
        first = self.run_finalize(refresh=True)
        database = self.path.read_bytes()
        self.sidecar.unlink()
        second = self.refresh_later()
        self.assertEqual(second["finalized_at"], first["finalized_at"])
        self.assertEqual(self.path.read_bytes(), database)
        self.assertEqual(json.loads(self.sidecar.read_text()), first)

    def test_collection_run_always_records_its_own_finalized_at(self):
        # Only --refresh-existing may keep the previous value: a collection
        # attempt is new publication state even when the counters repeat.
        self.write(self.sidecar, progress())
        first = self.run_finalize()
        with patch.object(MODULE, "datetime", LaterClock):
            second = self.run_finalize()
        self.assertEqual(second["finalized_at"], "2026-10-14T13:00:00+00:00")
        self.assertNotEqual(first["finalized_at"], second["finalized_at"])

    def main_outputs(self, *extra):
        output = self.root / "github-output.txt"
        with patch.dict("os.environ", {"GITHUB_OUTPUT": str(output)}), \
             patch("sys.stdout", new=io.StringIO()):
            MODULE.main(["--database", str(self.path), "--repository", str(self.root), "--cache", str(self.cache),
                         "--status", str(self.sidecar), "--radnuc-status", str(self.radnuc),
                         "--collect-outcome", "success", "--geolocate-outcome", "success",
                         "--run-started-at", START, *extra])
        return dict(line.split("=", 1) for line in output.read_text(encoding="utf-8").splitlines()) if output.exists() else {}

    def test_a_run_tells_the_workflow_whether_a_recovery_run_is_wanted(self):
        budgets = {"primary": {"per_run": 30, "per_day": 60}, "overflow": {"per_run": 25, "per_day": 50}}
        self.write(self.sidecar, progress(recent=lane(2616, 0, 2616), budgets=budgets))
        today = datetime.now(MODULE.PACIFIC).date().isoformat()
        self.write(self.cache, {"items": {}, "selection_quota_usage": {
            "pacific_day": today, "calls": 30, "overflow_calls": 0,
            "completed_daily_slots": ["17 10 * * *", "17 18 * * *"]}})
        self.assertEqual(self.main_outputs()["recovery_wanted"], "true")
        self.write(self.sidecar, progress(recent=lane(2616, 2500, 116), budgets=budgets))
        self.assertEqual(self.main_outputs()["recovery_wanted"], "false")

    def test_a_status_refresh_asks_for_no_recovery_run(self):
        self.write(self.sidecar, progress())
        self.run_finalize()
        self.assertEqual(self.main_outputs("--refresh-existing"), {})

    def events(self, *counts):
        """counts[0] events in the 24 h before the run, then one count per earlier day."""
        start = datetime.fromisoformat(START)
        return [{"id": f"e{day}-{n}", "ai_geo_complete": True,
                 "published": (start - timedelta(hours=24 * day + 1)).isoformat()}
                for day, total in enumerate(counts) for n in range(total)]

    def health(self, events=(), *, collect="success", geo="success", **status):
        self.write(self.path, {**self.original, "events": list(events)})
        self.write(self.sidecar, progress(**status))
        return self.run_finalize(collect=collect, geo=geo)["health"]

    def reviews(self, new_reviews, pending):
        return {"recent": {**lane(new_reviews + pending, new_reviews, pending), "new_reviews": new_reviews}}

    def test_the_permanent_partial_is_not_a_health_problem(self):
        # 132 of 135 statuses said partial, 0 complete: these are always open.
        health = self.health(self.events(90, *[100] * 14), **self.reviews(1400, 0), reasons=["backlog_pending"],
                             backlog=lane(1600, 0, 1600), categories=[{"category": "Radiological/Nuclear", "status": "partial"}])
        self.assertEqual((health["state"], health["reasons"]), ("healthy", []))
        self.assertEqual(health["events_published_last_24h"], 90)
        self.assertEqual(health["events_published_median_14d"], 100)

    def test_the_first_run_of_5_november_is_starved_by_both_measures(self):
        # 19 events against a median near 130, 32 reviewed, 1,862 waiting.
        health = self.health(self.events(19, *[135] * 14), **self.reviews(32, 1862))
        self.assertEqual(health["state"], "starved")
        self.assertEqual(health["reasons"], ["few_events_published", "reviews_far_below_arrivals"])
        self.assertEqual(health["review_share"], 0.017)

    def test_the_run_of_16_october_is_starved_by_its_reviews(self):
        # 47 events alone would only be degraded; 128 reviewed, 1,375 waiting is not.
        health = self.health(self.events(47, *[102] * 14), **self.reviews(128, 1375))
        self.assertEqual((health["state"], health["reasons"]),
                         ("starved", ["reviews_far_below_arrivals", "few_events_published"]))
        self.assertEqual(self.health(self.events(47, *[102] * 14), **self.reviews(1400, 0))["state"], "degraded")

    def test_a_dry_source_is_starved_by_the_event_count_alone(self):
        health = self.health(self.events(10, *[100] * 14), **self.reviews(0, 0))
        self.assertEqual((health["state"], health["reasons"]), ("starved", ["few_events_published"]))

    def test_a_failed_collection_is_starved(self):
        self.write(self.cache, {})
        self.write(self.sidecar, progress())
        self.assertEqual(self.run_finalize(collect="failure", geo="skipped")["health"]["state"], "starved")

    def test_falling_behind_is_degraded_not_starved(self):
        # 28 October: 704 reviewed, 1,162 waiting; slot 2 caught up.
        health = self.health(self.events(76, *[128] * 14), **self.reviews(704, 1162))
        self.assertEqual((health["state"], health["reasons"]), ("degraded", ["reviews_below_arrivals"]))
        health = self.health(self.events(62, *[146] * 14), **self.reviews(1344, 91))
        self.assertEqual((health["state"], health["reasons"]), ("degraded", ["few_events_published"]))

    def test_a_blocked_source_or_failed_geolocation_is_degraded(self):
        days = self.events(100, *[100] * 14)
        blocked = self.health(days, **self.reviews(900, 0), source={"status": "failed", "failure": "soft block"})
        self.assertEqual((blocked["state"], blocked["reasons"]), ("degraded", ["source_failed"]))
        crashed = self.health(days, **self.reviews(900, 0), geo="failure")
        self.assertEqual((crashed["state"], crashed["reasons"]), ("degraded", ["geolocation_incomplete"]))

    def test_a_handful_of_waiting_articles_starves_nothing(self):
        health = self.health(self.events(100, *[100] * 14), **self.reviews(0, 40))
        self.assertEqual(health["state"], "healthy")

    def test_the_window_ends_at_the_run_start_so_a_refresh_changes_nothing(self):
        # A later clock must not read the long gap between two runs as starvation.
        self.health(self.events(90, *[100] * 14), **self.reviews(1400, 0))
        first = json.loads(self.path.read_text())["collection_status"]
        self.assertEqual(self.refresh_later()["health"], first["health"])
        self.assertEqual(json.loads(self.path.read_text())["collection_status"]["finalized_at"], first["finalized_at"])

    def test_the_status_keeps_the_temporary_failures_and_the_thresholds(self):
        self.write(self.cache, {"selection_runtime_telemetry": {
            "schema_version": 2, "run_started_at": START, "lanes": {}, "temporary_failures": {"gemini-3.5-flash-lite:503": 6}}})
        self.write(self.sidecar, progress())
        result = self.run_finalize()
        self.assertEqual(result["temporary_failures"], {"gemini-3.5-flash-lite:503": 6})
        self.assertEqual(json.loads(self.sidecar.read_text())["health"], result["health"])
        self.assertEqual(result["health"]["thresholds"]["starved_events_ratio"], 0.25)

    def test_a_starved_run_is_announced_and_reaches_the_workflow(self):
        self.write(self.path, {**self.original, "events": self.events(7, *[140] * 14)})
        self.write(self.sidecar, progress(**self.reviews(0, 2616)))
        with patch("sys.stdout", new=io.StringIO()) as printed, \
             patch.dict("os.environ", {"GITHUB_OUTPUT": str(self.root / "out.txt")}):
            MODULE.main(["--database", str(self.path), "--repository", str(self.root), "--cache", str(self.cache),
                         "--status", str(self.sidecar), "--radnuc-status", str(self.radnuc),
                         "--collect-outcome", "success", "--geolocate-outcome", "success", "--run-started-at", START])
        self.assertIn("::error title=Map starved::7 events published in the last 24 h (14-day median 140)", printed.getvalue())
        outputs = (self.root / "out.txt").read_text(encoding="utf-8")
        self.assertIn("map_health=starved\n", outputs)
        self.assertIn("map_health_summary=7 events published", outputs)
        self.assertEqual(outputs.count("\n"), 3, "one line per output, or the step output breaks")

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
