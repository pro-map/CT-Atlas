"""Durability of the scheduled collection: the committed AI selection cache
stays small (decisions unused for 21 days are dropped, the file is written
compact), every events.json writer produces the same bytes, Google News
failures end a wave early instead of running into the step timeout, and one
temporary Gemini error no longer abandons the rest of a selection lane."""
import importlib.util
import json
import os
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("collector", "collector.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)

NOW = datetime(2026, 11, 4, 12, 0, tzinfo=timezone.utc)


def item(days_ago, **extra):
    return {"version": collector.AI_SELECTION_VERSION,
            "reviewed_at": (NOW - timedelta(days=days_ago)).isoformat(),
            "result": {"event_id": "x", "relevance_score": 0}, **extra}


class SelectionCacheTests(unittest.TestCase):
    def test_decisions_unused_for_three_weeks_are_dropped(self):
        cache = {"items": {
            "recent": item(3),
            "old": item(30),
            "old-but-seen": item(30, last_seen_at=(NOW - timedelta(days=1)).isoformat()),
            "old-archive-review": item(40, article={"url": "https://x/1"}),
            "old-queued": item(40),
        }}
        removed = collector.prune_selection_cache(cache, now=NOW, days=21, keep={"old-queued"})
        self.assertEqual(removed, 1)
        self.assertEqual(set(cache["items"]), {"recent", "old-but-seen", "old-archive-review", "old-queued"})

    def test_old_off_topic_verdicts_keep_only_what_rejects_them_again(self):
        full = {"event_id": "e1", "relevance_score": 0, "is_current_ct_event": False,
                "english_title": "Yacht sale", "reason": "Not CT", "english_summary": "long text"}
        cache = {"items": {
            "old-zero": item(5, result=dict(full)),
            "new-zero": item(1, result=dict(full)),
            "old-kept": item(5, result={**full, "relevance_score": 40}),
        }}
        self.assertEqual(collector.slim_off_topic_decisions(cache, now=NOW, days=3), 1)
        self.assertEqual(cache["items"]["old-zero"]["result"],
                         {"event_id": "e1", "relevance_score": 0, "is_current_ct_event": False})
        self.assertIn("reason", cache["items"]["new-zero"]["result"])
        self.assertIn("english_title", cache["items"]["old-kept"]["result"], "archive-bound reviews keep everything")
        event = {"title": "Yacht sale", "summary": "", "categories": ["Attacks"], "category": "Attacks"}
        self.assertFalse(collector.apply_ai_selection(event, cache["items"]["old-zero"]["result"]),
                         "a slim verdict still rejects the candidate")

    def test_zero_days_keeps_everything(self):
        cache = {"items": {"old": item(300)}}
        self.assertEqual(collector.prune_selection_cache(cache, now=NOW, days=0, keep=set()), 0)

    def test_queued_candidates_are_recognised_by_fingerprint(self):
        event = {"title": "Gunmen attack a police post", "summary": "s", "url": "https://x/2",
                 "source_article_fingerprints": ["fp-related"]}
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "queue.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump({"version": 1, "events": [event]}, handle)
            keep = collector.queued_selection_fingerprints(path)
        self.assertIn(collector.selection_fingerprint(event), keep)
        self.assertIn("fp-related", keep)
        self.assertEqual(collector.queued_selection_fingerprints(os.path.join(tmp, "missing.json")), set())

    def test_the_cache_is_written_compact_and_pruned_once_per_run(self):
        saved = (collector.AI_SELECTION_CACHE_FILE, collector._SELECTION_CACHE_PRUNED)
        with tempfile.TemporaryDirectory() as tmp:
            collector.AI_SELECTION_CACHE_FILE = os.path.join(tmp, "cache.json")
            collector._SELECTION_CACHE_PRUNED = False
            try:
                stale = {"version": collector.AI_SELECTION_VERSION, "reviewed_at": "2020-01-01T00:00:00+00:00",
                         "result": {"event_id": "x", "relevance_score": 0}}
                cache = {"items": {"stale": stale}}
                collector.save_selection_cache(cache)
                self.assertNotIn("stale", cache["items"])
                cache["items"]["later"] = dict(stale)
                collector.save_selection_cache(cache)          # not pruned again in the same run
                text = open(collector.AI_SELECTION_CACHE_FILE, encoding="utf-8").read()
            finally:
                collector.AI_SELECTION_CACHE_FILE, collector._SELECTION_CACHE_PRUNED = saved
        self.assertIn('"later"', text)
        self.assertNotIn("\n  ", text, "no indentation")
        self.assertTrue(text.endswith("}\n"))


class OneJsonFormatTests(unittest.TestCase):
    def test_every_events_json_writer_produces_the_same_bytes(self):
        data = {"events": [{"id": "a", "title": "Attaque à Kidal"}], "number_of_events": 1}
        spec = importlib.util.spec_from_file_location("finalize_daily_status", "tools/finalize_daily_status.py")
        finalize = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(finalize)
        from pathlib import Path
        with tempfile.TemporaryDirectory() as tmp:
            a, b = os.path.join(tmp, "a.json"), Path(tmp) / "b.json"
            collector.atomic_json_write(a, data)
            finalize.atomic_write(b, data)
            self.assertEqual(open(a, "rb").read(), b.read_bytes())
        source = open("geolocate.py", encoding="utf-8").read()
        self.assertIn('json.dump(data, handle, ensure_ascii=False, indent=2)\n'
                      '            # The same bytes as every other events.json writer.\n'
                      '            handle.write("\\n")', source)


class Response:
    def __init__(self, status):
        self.status_code, self.headers = status, {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise collector.requests.HTTPError(str(self.status_code))


class GoogleNewsTests(unittest.TestCase):
    def setUp(self):
        self.saved = (collector.session, collector.time, collector.COLLECTION_STARTED,
                      collector.SERVER_ERROR_STREAK, dict(collector.QUERY_STATS))
        self.sleeps = []
        collector.time = SimpleNamespace(sleep=self.sleeps.append, monotonic=time.monotonic)
        collector.QUERY_STATS.clear()
        collector.SERVER_ERROR_STREAK = 0

    def tearDown(self):
        (collector.session, collector.time, collector.COLLECTION_STARTED,
         collector.SERVER_ERROR_STREAK, stats) = self.saved
        collector.QUERY_STATS.clear()
        collector.QUERY_STATS.update(stats)

    def answer(self, *statuses):
        replies = list(statuses)
        collector.session = SimpleNamespace(get=lambda url, timeout: Response(replies.pop(0)))

    def test_no_wait_after_the_last_throttled_attempt(self):
        self.answer(429, 429)
        self.assertIsNone(collector._request_google_news_network("https://news.google.com/rss/search?q=x"))
        self.assertEqual(len(self.sleeps), collector.REQUEST_ATTEMPTS - 1)

    def test_a_clear_failure_rate_ends_the_wave_early(self):
        collector.QUERY_STATS.update(successful=44, failed=15)
        self.answer(429, 429)
        with self.assertRaises(RuntimeError) as raised:
            collector._request_google_news_network("https://news.google.com/rss/search?q=x")
        self.assertIn("Too many Google News queries failed", str(raised.exception))

    def test_a_few_early_failures_do_not_end_the_wave(self):
        collector.QUERY_STATS.update(successful=3, failed=5)
        self.answer(429, 429)
        self.assertIsNone(collector._request_google_news_network("https://news.google.com/rss/search?q=x"))

    def test_the_collection_stops_at_its_deadline(self):
        collector.COLLECTION_STARTED = time.monotonic() - (collector.COLLECTION_DEADLINE_MINUTES + 1) * 60
        self.answer(200)
        with self.assertRaises(RuntimeError) as raised:
            collector._request_google_news_network("https://news.google.com/rss/search?q=x")
        self.assertIn("deadline", str(raised.exception))

    def test_no_second_wave_late_in_the_run(self):
        calls = []

        def failing_wave(*args, **kwargs):
            calls.append(1)
            raise RuntimeError("Too many Google News queries failed (99/100).")
        saved_once = collector._collect_all_once
        collector._collect_all_once = failing_wave
        collector.COLLECTION_STARTED = time.monotonic() - 90 * 60
        try:
            with self.assertRaises(RuntimeError):
                collector.collect_all(3)
        finally:
            collector._collect_all_once = saved_once
        self.assertEqual(len(calls), 1)


class TransientSelectionTests(unittest.TestCase):
    def run_selection(self, failing_batches):
        events = [{"id": f"evt-{n}", "title": f"Attack number {n} on a police post", "summary": "s",
                   "url": f"https://outlet.test/{n}", "source": "Outlet", "published": "2026-11-03T10:00:00+00:00",
                   "category": "Attacks", "categories": ["Attacks"], "related_articles": []} for n in range(6)]
        calls = []

        def fake_batch(batch):
            calls.append([item["event_id"] for item in batch])
            if len(calls) in failing_batches:
                raise collector.AISelectionTransientError("Gemini article-selection service unavailable.")
            return [{"event_id": item["event_id"], "relevance_score": 0, "english_title": item["title"]}
                    for item in batch]

        names = ("AI_SELECTION_ENABLED", "AI_SELECTION_CACHE_FILE", "AI_SELECTION_BATCH_SIZE",
                 "process_ai_selection_batch", "persist_background_articles", "_SELECTION_CACHE_PRUNED")
        saved = {name: getattr(collector, name) for name in names}
        skipped = []
        collector.selection_batch_skipped = skipped.append
        with tempfile.TemporaryDirectory() as tmp:
            collector.AI_SELECTION_ENABLED = True
            collector.AI_SELECTION_CACHE_FILE = os.path.join(tmp, "cache.json")
            collector.AI_SELECTION_BATCH_SIZE = 2
            collector.process_ai_selection_batch = fake_batch
            collector.persist_background_articles = lambda rejected: None
            collector._SELECTION_CACHE_PRUNED = True
            try:
                result = collector.ai_select_events(events)
                items = json.load(open(collector.AI_SELECTION_CACHE_FILE, encoding="utf-8"))["items"]
            finally:
                for name, value in saved.items():
                    setattr(collector, name, value)
                del collector.selection_batch_skipped
        return result, calls, items, skipped

    def test_one_failed_batch_is_skipped_and_the_lane_goes_on(self):
        result, calls, items, skipped = self.run_selection({1})
        self.assertEqual(len(calls), 3, "the two later batches were still reviewed")
        self.assertEqual(len(items), 4)
        self.assertIsNone(result, "undecided candidates: partial publication, they stay queued")
        self.assertEqual(len(skipped), 1)

    def test_two_failed_batches_in_a_row_stop_the_lane(self):
        result, calls, items, skipped = self.run_selection({1, 2})
        self.assertEqual(len(calls), 2)
        self.assertIsNone(result)

    def test_temporary_http_errors_are_retried_three_times_not_five(self):
        self.assertEqual(collector.AI_SELECTION_TRANSIENT_ATTEMPTS, 3)
        self.assertEqual(collector.AI_SELECTION_ATTEMPTS, 5, "429s keep their own retries")


if __name__ == "__main__":
    unittest.main()
