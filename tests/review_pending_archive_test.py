"""tools/archive_review.py and tools/review_pending_archive.py: archive reviews
run on the map's Gemini selection (stubbed here) behind a gate that counts
every Gemini request, paces them, retries a minute's 429 once and stops at a
day's, a per-Pacific-day ledger, and per-batch saving."""
import importlib.util
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, "tools")
import archive_review  # noqa: E402

spec = importlib.util.spec_from_file_location("review_pending_archive", "tools/review_pending_archive.py")
review_tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review_tool)
collector = archive_review.load_collector()

GEMINI = "https://generativelanguage.googleapis.com/v1beta/interactions"


def item(n, title=None):
    return {"url": f"https://outlet.test/{n}", "title": title or f"Event {n}", "summary": "",
            "published": "2026-08-20T10:00:00+00:00", "source": "Outlet", "left_map": "2026-09-02 x"}


def answering(scores, calls, omit=()):
    """A stand-in for collector.call_ai_selection_batch: one answer per item,
    except the titles in omit (Gemini sometimes leaves items out)."""
    def call_batch(payload):
        calls.append([entry["event_id"] for entry in payload])
        return [{"event_id": entry["event_id"], "relevance_score": scores(entry["title"]),
                 "reason": "test", "categories": ["Attacks"], "english_title": f"EN {entry['title']}"}
                for entry in payload if entry["title"] not in omit]
    return call_batch


def stub_collector(call_batch):
    """A collector whose selection call makes one (fake) Gemini request per
    call, like the real one, so the gate sees it."""
    stub = SimpleNamespace(requests=SimpleNamespace(post=lambda *a, **k: SimpleNamespace(status_code=200)))
    for name in ("selection_payload", "normalize_categories", "canonicalize_actor_group", "apply_ai_selection",
                 "AISelectionQuotaError", "AISelectionIncompleteError"):
        setattr(stub, name, getattr(collector, name))
    stub.AI_SELECTION_THRESHOLD = 60

    def call(payload):
        stub.requests.post(GEMINI, json={"model": "gemini-3.1-flash-lite"})
        return call_batch(payload)
    stub.call_ai_selection_batch = call
    return stub


class ReviewBatchesTests(unittest.TestCase):
    def run_review(self, items, call_batch, batch_size=25):
        saved = []
        handled, stop = archive_review.review_batches(
            items, collector, lambda pairs, skipped: saved.append((pairs, skipped)), call_batch, batch_size)
        return handled, stop, saved

    def test_every_batch_is_handed_over_with_positional_ids(self):
        calls = []
        handled, stop, saved = self.run_review([item(n) for n in range(30)], answering(lambda t: 70, calls))
        self.assertEqual((handled, stop), (30, "done"))
        self.assertEqual([len(pairs) for pairs, _ in saved], [25, 5])
        self.assertEqual(calls[0][:2], ["p0", "p1"], "positional wire ids, never stored event ids")
        self.assertEqual(saved[1][0][0][0]["url"], "https://outlet.test/25")

    def test_an_error_stops_and_keeps_the_batches_before(self):
        calls = []
        ok = answering(lambda t: 50, calls)

        def failing(payload):
            if len(calls) >= 1:
                raise collector.AISelectionQuotaError("Gemini returned 429")
            return ok(payload)
        handled, stop, saved = self.run_review([item(n) for n in range(60)], failing)
        self.assertEqual((handled, len(saved)), (25, 1))
        self.assertIn("AISelectionQuotaError", stop)

    def test_the_budget_stops_between_batches(self):
        def budget(payload):
            raise archive_review.BudgetReached("Gemini request budget reached (2).")
        handled, stop, saved = self.run_review([item(n) for n in range(10)], budget)
        self.assertEqual((handled, saved), (0, []))
        self.assertIn("budget", stop)

    def test_items_left_out_are_asked_once_more_then_skipped(self):
        calls = []
        handled, stop, saved = self.run_review([item(n) for n in range(4)],
                                               answering(lambda t: 60, calls, omit={"Event 1"}))
        self.assertEqual((handled, stop), (4, "done"))
        self.assertEqual(calls, [["p0", "p1", "p2", "p3"], ["p1"]], "one more request, for the missing item only")
        pairs, skipped = saved[0]
        self.assertEqual([i["url"] for i, _ in pairs], [f"https://outlet.test/{n}" for n in (0, 2, 3)])
        self.assertEqual([i["url"] for i in skipped], ["https://outlet.test/1"])

    def test_an_unreadable_answer_is_split_in_two_once(self):
        calls = []
        answer = answering(lambda t: 60, calls)

        def unreadable_when_whole(payload):
            if len(payload) == 4:
                calls.append("whole")
                raise collector.AISelectionIncompleteError("Invalid Gemini article-selection JSON.")
            return answer(payload)
        handled, stop, saved = self.run_review([item(n) for n in range(4)], unreadable_when_whole)
        self.assertEqual(calls, ["whole", ["p0", "p1"], ["p2", "p3"]])
        self.assertEqual(len(saved[0][0]), 4)

    def test_a_batch_with_no_answer_at_all_stops_and_stays(self):
        handled, stop, saved = self.run_review([item(n) for n in range(3)], lambda payload: [])
        self.assertEqual((handled, saved), (0, []))
        self.assertIn("none", stop)


class GateTests(unittest.TestCase):
    def make(self, responses, max_posts=10):
        clock, sleeps, sent = [100.0], [], []

        def sleep(seconds):
            sleeps.append(round(seconds, 3))
            clock[0] += seconds

        def post(url, *args, **kwargs):
            sent.append(url)
            status, text = responses.pop(0) if responses else (200, "")
            return SimpleNamespace(status_code=status, text=text)
        stub = SimpleNamespace(requests=SimpleNamespace(post=post), AISelectionQuotaError=collector.AISelectionQuotaError)
        posts = []
        gate = archive_review.GeminiGate(stub, max_posts, min_interval=6, sleep=sleep, clock=lambda: clock[0],
                                         on_post=posts.append)
        return gate, stub, clock, sleeps, sent, posts

    def test_gemini_requests_are_counted_and_spaced_six_seconds_apart(self):
        gate, stub, clock, sleeps, sent, posts = self.make([])
        with gate:
            stub.requests.post(GEMINI, json={})
            clock[0] += 2
            stub.requests.post(GEMINI, json={})
            stub.requests.post("https://api.cloudflare.com/d1/query", json={})
        self.assertEqual(gate.posts, 2, "only Gemini requests count")
        self.assertEqual(posts, [1, 2], "the ledger hears of every request")
        self.assertEqual(sleeps, [4.0])
        self.assertEqual(len(sent), 3)

    def test_a_minutes_429_waits_and_tries_once_more(self):
        gate, stub, clock, sleeps, sent, _ = self.make([(429, "GenerateRequestsPerMinutePerProjectPerModel"), (200, "")])
        with gate:
            response = stub.requests.post(GEMINI, json={})
        self.assertEqual((response.status_code, gate.posts), (200, 2))
        self.assertIn(60, sleeps)

    def test_a_days_429_stops_the_run_at_once(self):
        gate, stub, clock, sleeps, sent, _ = self.make([(429, "GenerateRequestsPerDayPerProjectPerModel-FreeTier")])
        with gate:
            with self.assertRaises(collector.AISelectionQuotaError):
                stub.requests.post(GEMINI, json={"model": "gemini-3.1-flash-lite"})
            with self.assertRaises(collector.AISelectionQuotaError):
                stub.requests.post(GEMINI, json={})
        self.assertEqual((gate.posts, sleeps), (1, []))

    def test_a_second_429_in_a_row_stops_too(self):
        gate, stub, *_ = self.make([(429, "PerMinute"), (429, "PerMinute")])
        with gate:
            with self.assertRaises(collector.AISelectionQuotaError):
                stub.requests.post(GEMINI, json={})
        self.assertEqual(gate.posts, 2)

    def test_the_budget_is_counted_in_requests(self):
        gate, stub, *_ = self.make([], max_posts=2)
        with gate:
            stub.requests.post(GEMINI, json={})
            stub.requests.post(GEMINI, json={})
            with self.assertRaises(archive_review.BudgetReached):
                stub.requests.post(GEMINI, json={})
        self.assertEqual(gate.posts, 2)

    def test_uninstall_restores_the_original_post(self):
        gate, stub, *_ = self.make([])
        original = stub.requests.post
        with gate:
            self.assertIsNot(stub.requests.post, original)
        self.assertIs(stub.requests.post, original)


class LedgerTests(unittest.TestCase):
    def test_the_allocation_holds_across_runs_of_one_pacific_day_and_resets_after(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "quota" / "gemini-3.1-test.json"
            morning = datetime(2026, 10, 3, 15, 0, tzinfo=timezone.utc)       # 08:00 Pacific
            ledger = archive_review.DailyLedger(path, 120, now=morning)
            self.assertEqual(ledger.budget(100), 100)
            ledger.save(100)
            again = archive_review.DailyLedger(path, 120, now=morning)
            self.assertEqual((again.used, again.budget(100)), (100, 20))
            # 06:30 Paris the next day is still the same Pacific day (21:30 Pacific).
            self.assertEqual(archive_review.DailyLedger(
                path, 120, now=datetime(2026, 10, 4, 4, 30, tzinfo=timezone.utc)).budget(100), 20)
            # 09:30 Paris: a new Pacific day.
            self.assertEqual(archive_review.DailyLedger(
                path, 120, now=datetime(2026, 10, 4, 7, 30, tzinfo=timezone.utc)).budget(100), 100)


class PrepareTests(unittest.TestCase):
    def test_the_model_threshold_and_note_apply_to_that_instance_only(self):
        fresh = archive_review.load_collector()
        archive_review.prepare_collector(fresh, "gemini-3.1-flash-lite", threshold=60)
        archive_review.prepare_collector(fresh, "gemini-3.1-flash-lite", threshold=60)
        self.assertEqual((fresh.AI_SELECTION_MODEL, fresh.AI_SELECTION_PAUSE_SECONDS, fresh.AI_SELECTION_THRESHOLD),
                         ("gemini-3.1-flash-lite", 0, 60))
        self.assertEqual(fresh.AI_SELECTION_INSTRUCTIONS.count("ARCHIVE REVIEW:"), 1)
        self.assertNotIn("score >= 50", fresh.AI_SELECTION_INSTRUCTIONS)
        self.assertNotIn("ARCHIVE REVIEW:", collector.AI_SELECTION_INSTRUCTIONS)

    def test_the_review_prompt_reads_like_the_collections(self):
        """The collection's wrapper sets its threshold with the same helper."""
        wrapper = Path("tools/run_collector_quota_safe.py").read_text(encoding="utf-8")
        self.assertIn("archive_review.apply_threshold(collector,THRESHOLD)", wrapper)
        for phrase in ("score >= 50", "at least 50", "just above 50"):
            self.assertIn(phrase, collector.AI_SELECTION_INSTRUCTIONS, "the phrase the helper rewrites still exists")
        fresh = archive_review.apply_threshold(archive_review.load_collector(), 60)
        self.assertIn("score >= 60", fresh.AI_SELECTION_INSTRUCTIONS)

    def test_the_threshold_comes_from_the_runtime_file(self):
        self.assertEqual(archive_review.map_threshold(), json.loads(
            Path("ct-atlas-runtime.json").read_text(encoding="utf-8"))["ai_selection_threshold"])


class MainTests(unittest.TestCase):
    def run_main(self, call_batch, max_calls, events, daily=120):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "archive").mkdir()
            pending = root / "archive" / "recovery-pending-review-20261002.json"
            pending.write_text(json.dumps({"events": events}), encoding="utf-8")
            original = (review_tool.ROOT, review_tool.load_collector, archive_review.SECONDS_BETWEEN_POSTS,
                        review_tool.DAILY_CALLS)
            review_tool.ROOT, review_tool.load_collector = root, (lambda: stub_collector(call_batch))
            archive_review.SECONDS_BETWEEN_POSTS, review_tool.DAILY_CALLS = 0, daily
            try:
                self.assertEqual(review_tool.main(["--max-calls", str(max_calls)]), 0)
            finally:
                (review_tool.ROOT, review_tool.load_collector, archive_review.SECONDS_BETWEEN_POSTS,
                 review_tool.DAILY_CALLS) = original
            remaining = json.loads(pending.read_text(encoding="utf-8"))["events"] if pending.exists() else []
            out = list((root / "archive").glob("recovered-events-reviewed-*.json"))
            kept = json.loads(out[0].read_text(encoding="utf-8"))["events"] if out else []
            ledger = json.loads((root / "quota" / "gemini-3.1-archive-review.json").read_text(encoding="utf-8")) \
                if (root / "quota" / "gemini-3.1-archive-review.json").exists() else None
            return remaining, kept, ledger

    def test_reviewed_events_move_and_the_rest_stays_pending(self):
        calls = []
        events = [item(n, "JNIM attack" if n % 2 else "Yacht sale") for n in range(30)]
        remaining, kept, ledger = self.run_main(answering(lambda t: 0 if "Yacht" in t else 80, calls), 1, events)
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(remaining), 5)
        self.assertEqual(len(kept), 12)        # odd items among the first 25
        self.assertTrue(all(event["ai_relevance_score"] == 80 for event in kept))
        self.assertNotIn("left_map", kept[0])
        # Filed as the map's selection files it: the sync reads these marks.
        self.assertEqual((kept[0]["ai_selected"], kept[0]["map_threshold"], kept[0]["_recovery_reason"]),
                         (True, 60, "pending_review"))
        self.assertTrue(kept[0]["incident_id"].startswith("inc-"))
        self.assertEqual(ledger["posts"], 1)

    def test_a_failure_mid_run_keeps_every_batch_saved_before_it(self):
        calls = []
        ok = answering(lambda t: 70, calls)

        def second_fails(payload):
            if calls:
                raise collector.AISelectionTransientError("Gemini unavailable (HTTP 503).")
            return ok(payload)
        remaining, kept, _ = self.run_main(second_fails, 10, [item(n) for n in range(60)])
        self.assertEqual(len(kept), 25)
        self.assertEqual(len(remaining), 35)
        self.assertEqual(remaining[0]["url"], "https://outlet.test/25")

    def test_a_finished_pending_file_is_removed(self):
        remaining, kept, _ = self.run_main(answering(lambda t: 30, []), 10, [item(n) for n in range(3)])
        self.assertEqual((remaining, len(kept)), ([], 3))

    def test_no_request_once_the_daily_allocation_is_used(self):
        calls = []
        remaining, kept, ledger = self.run_main(answering(lambda t: 30, calls), 10, [item(n) for n in range(3)], daily=0)
        self.assertEqual((calls, kept, len(remaining)), ([], [], 3))


if __name__ == "__main__":
    unittest.main()
