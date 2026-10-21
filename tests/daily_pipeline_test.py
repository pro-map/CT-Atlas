"""Daily priority, durable pending evidence and honest provider-source coverage."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import collector
import daily_pipeline as daily

NOW = datetime(2026, 10, 14, 9, 0, tzinfo=timezone.utc)


def article(name, age=1, category="Arrests"):
    return {"id": name, "title": f"Police arrest ISIS suspect {name}", "summary": "Police detained a terrorist suspect.",
            "url": f"https://example.org/{name}", "published": (NOW-timedelta(days=age)).isoformat(),
            "category": category, "categories": [category]}


class DailyPipelineTests(unittest.TestCase):
    def test_publication_not_incident_date_selects_recent_lane(self):
        update = article("update")
        update["incident_date"] = "2024-01-01"
        recent, backlog, _ = daily.partition([update, article("old", 20), article("boundary", 3)], collector, NOW)
        self.assertEqual([row["id"] for row in recent], ["update", "boundary"])
        self.assertEqual([row["id"] for row in backlog], ["old"])

    def test_aged_pending_moves_to_backlog_without_new_search_or_loss(self):
        queued = [article("yesterday", 4)]
        with patch.object(collector, "deduplicate_events", side_effect=lambda rows: rows):
            recent, backlog, _ = daily.prepare([], queued, [], collector, NOW)
        self.assertEqual(recent, [])
        self.assertEqual(backlog, queued)

    def test_stale_daily_result_cannot_restart_cancelled_history(self):
        recent, backlog, dropped = daily.partition([
            article("recent-radnuc", 1, "Radiological/Nuclear"),
            article("old-radnuc", 20, "Radiological/Nuclear"),
            article("expired", 190), {**article("court"), "primary_event_type": "JUDICIAL"}],
            collector, NOW, {"Radiological/Nuclear", "Legal / Judicial"})
        self.assertEqual([row["id"] for row in recent], ["recent-radnuc"])
        self.assertEqual(backlog, [])
        self.assertEqual((dropped["expired"], dropped["retired"], dropped["cancelled_history"]), (1, 1, 1))

    def test_cancelled_specialist_history_filters_old_legacy_queue_but_keeps_recent_bio(self):
        disabled = set(collector.threat_categories.LABELS)
        queued = [article('queued-old-bio',20,'Biological Terrorism'),
                  article('queued-old-cbrn',20,'CBRN'),
                  article('queued-recent-cbrne',1,'CBRNE')]
        fresh = [article('fresh-old-cbrne',20,'CBRNE'),
                 article('fresh-recent-bio',1,'Biological Terrorism'),
                 article('fresh-old-arrest',20,'Arrests')]
        originals = deepcopy((fresh,queued))
        with patch.object(collector,'deduplicate_events',side_effect=lambda rows:rows):
            recent,backlog,dropped=daily.prepare(fresh,queued,[],collector,NOW,disabled)
        self.assertEqual({row['id'] for row in recent},{'queued-recent-cbrne','fresh-recent-bio'})
        self.assertEqual([row['id'] for row in backlog],['fresh-old-arrest'])
        self.assertEqual(dropped['cancelled_history'],3)
        self.assertEqual((fresh,queued),originals)

    def test_queues_are_clustered_separately_and_cached_original_is_unchanged(self):
        queued = article("queued", 10)
        fresh = [deepcopy(queued), article("new"), article("older", 8)]
        clustered = []
        def cluster(rows):
            clustered.append([row["id"] for row in rows])
            return rows
        with patch.object(collector, "deduplicate_events", side_effect=cluster):
            recent, backlog, _ = daily.prepare(fresh, [queued], [], collector, NOW)
        self.assertEqual(clustered, [["new"], ["older"]])
        self.assertIs(backlog[0], queued)
        self.assertEqual([row["id"] for row in recent], ["new"])

    def test_original_fingerprint_removes_reviewed_foreign_candidate_only_after_publication(self):
        source = article("foreign")
        fingerprint = collector.selection_fingerprint(source)
        cache = {"items": {fingerprint: {"version": collector.AI_SELECTION_VERSION,
                                       "result": {"english_title": "A different translated title"}}}}
        self.assertEqual(daily.unresolved([source, article("pending")], cache, collector), [article("pending")])

    def test_malformed_queue_is_not_silently_emptied(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/"queue.json"
            path.write_text('{"events": "broken"}')
            with self.assertRaises(ValueError):
                daily.load_queue(path)
            self.assertEqual(path.read_text(), '{"events": "broken"}')

    def test_daily_calls_recent_then_backlog_then_maintenance_and_checkpoints_originals(self):
        existing = [article("legacy", 15)]
        calls, snapshots = [], []
        fresh = [article("old", 9), article("new")]
        def select(rows, lane=None):
            calls.append(lane)
            return []
        patches = {
            "parse_collection_mode": lambda: (False, "daily"),
            "initialize_incremental_state": lambda _: None,
            "load_existing_weekly_analysis": lambda: {}, "load_existing": lambda: existing,
            "load_database_strict": lambda: {"events": existing, "last_updated": "previous"},
            "collect_all": lambda _: fresh, "deduplicate_events": lambda rows: rows,
            "ai_select_events": select, "deduplicate_incremental": lambda old, new: old,
            "prune_old": lambda rows, aged=None: rows, "archive_aged_out_events": lambda rows: None,
            "load_incident_state": lambda: {}, "consolidate_incidents": lambda rows, state: (rows, {}),
            "save_incident_state": lambda *args: None, "generate_24h_trend_summary": lambda rows: {},
            "generate_weekly_analysis": lambda rows, **kwargs: {}, "save_database": lambda *args, **kwargs: None,
            "load_selection_cache": lambda: {"items": {}}, "atomic_json_write": lambda *args: None,
        }
        from contextlib import ExitStack
        # Relative dates in this test must remain within today's real daily window.
        clock = datetime.now(timezone.utc)
        for row in fresh:
            row["published"] = (clock-timedelta(days=1 if row["id"] == "new" else 9)).isoformat()
        with ExitStack() as stack:
            for name, replacement in patches.items():
                stack.enter_context(patch.object(collector, name, replacement))
            stack.enter_context(patch.object(collector.collection_config, "validate_runtime", return_value={}))
            stack.enter_context(patch.object(daily, "load_queue", return_value=[]))
            stack.enter_context(patch.object(daily, "save_queue", side_effect=lambda rows, *args, **kwargs: snapshots.append(deepcopy(rows))))
            collector.main()
        self.assertEqual(calls, ["recent", "backlog", "maintenance"])
        self.assertEqual([row["id"] for row in snapshots[0]], ["new", "old"])
        self.assertEqual(snapshots[0], snapshots[-1], "Unreviewed rows remain durable.")

    def test_gdelt_rate_limit_is_visible_independently_of_google(self):
        collector.GDELT_STATS.clear()
        response = SimpleNamespace(status_code=429)
        with patch.object(collector.requests, "get", return_value=response):
            self.assertEqual(collector.fetch_gdelt_doc_articles("terrorism", days=3), [])
        telemetry = {"lanes": {"recent": {"candidates": 0, "reviewed": 0, "pending": 0},
                                 "backlog": {"candidates": 0, "reviewed": 0, "pending": 0}}, "reasons": []}
        status = daily.finish_status(daily.begin_status(NOW), telemetry, {}, collector.GDELT_STATS, NOW)
        self.assertEqual(status["status"], "partial")
        self.assertEqual(status["source"]["errors"], 1)
        self.assertEqual(status["source"]["gdelt"]["rate_limited"], 1)
        collector.GDELT_STATS.clear()

    def test_successful_split_subbatch_is_checkpointed_before_later_quota_error(self):
        rows = [article("left"), article("right")]
        cache = {"items": {}}
        def call(batch):
            if len(batch) == 2:
                raise collector.AISelectionIncompleteError("split")
            if batch[0]["event_id"] == "right":
                raise collector.AISelectionQuotaError("quota")
            return [{"event_id": "left", "relevance_score": 0, "is_current_ct_event": False,
                     "primary_event_type": "OTHER_CT", "categories": []}]
        with patch.object(collector, "load_selection_cache", return_value=cache), \
             patch.object(collector, "save_selection_cache"), \
             patch.object(collector, "call_ai_selection_batch", side_effect=call):
            self.assertIsNone(collector.ai_select_events(rows))
        self.assertIn(collector.selection_fingerprint(rows[0]), cache["items"])
        self.assertNotIn(collector.selection_fingerprint(rows[1]), cache["items"])
        self.assertIsNone(collector.AI_SELECTION_PARTIAL_CHECKPOINT)


if __name__ == "__main__":
    unittest.main()
