"""tools/review_pending_archive.py: reviews pending former map events with the
map's Gemini selection (stubbed here), keeps those scoring above 0, drops the
rest, and stops cleanly on its budget or an error, keeping the remainder."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("review_pending_archive", "tools/review_pending_archive.py")
review_tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review_tool)
collector = review_tool.load_collector()


def item(n, title=None):
    return {"url": f"https://outlet.test/{n}", "title": title or f"Event {n}", "summary": "",
            "published": "2026-08-20T10:00:00+00:00", "source": "Outlet", "left_map": "2026-09-02 x"}


def answering(scores, calls):
    def call_batch(payload):
        calls.append([entry["event_id"] for entry in payload])
        return [{"event_id": entry["event_id"], "relevance_score": scores(entry["title"]),
                 "reason": "test", "categories": ["Attacks"]} for entry in payload]
    return call_batch


class ReviewTests(unittest.TestCase):
    def test_scores_above_zero_are_kept_and_zero_dropped(self):
        calls = []
        items = [item(1, "JNIM attack in Mali"), item(2, "Yacht sale in Monaco")]
        kept, dropped, reviewed, used, stop = review_tool.review(
            items, answering(lambda title: 0 if "Yacht" in title else 70, calls), collector, 10, sleep=lambda s: None)
        self.assertEqual((dropped, reviewed, used, stop), (1, 2, 1, "done"))
        self.assertEqual([event["url"] for event in kept], ["https://outlet.test/1"])
        self.assertEqual(kept[0]["ai_relevance_score"], 70)
        self.assertEqual(kept[0]["_recovery_reason"], "pending_review")
        self.assertNotIn("left_map", kept[0])
        self.assertEqual(calls, [["p0", "p1"]], "positional wire ids, never stored event ids")

    def test_the_budget_stops_between_batches(self):
        calls = []
        items = [item(n) for n in range(60)]
        kept, dropped, reviewed, used, stop = review_tool.review(
            items, answering(lambda title: 50, calls), collector, 2, sleep=lambda s: None)
        self.assertEqual((reviewed, used), (50, 2))
        self.assertTrue(stop.startswith("call budget reached"))

    def test_an_error_stops_without_losing_the_unreviewed(self):
        def failing(payload):
            raise collector.AISelectionQuotaError("Gemini returned 429")
        kept, dropped, reviewed, used, stop = review_tool.review(
            [item(n) for n in range(30)], failing, collector, 10, sleep=lambda s: None)
        self.assertEqual((kept, dropped, reviewed, used), ([], 0, 0, 1))
        self.assertIn("AISelectionQuotaError", stop)

    def test_calls_are_paced_under_the_per_minute_limit(self):
        pauses = []
        review_tool.review([item(n) for n in range(60)], answering(lambda title: 50, []), collector, 10,
                           pause=5, sleep=pauses.append)
        self.assertEqual(pauses, [5, 5], "a pause before every call but the first")


class MainTests(unittest.TestCase):
    def test_a_run_moves_reviewed_events_and_keeps_the_rest_pending(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "archive").mkdir()
            pending = root / "archive" / "recovery-pending-review-20261002.json"
            pending.write_text(json.dumps({"events": [item(n, "JNIM attack" if n % 2 else "Yacht sale")
                                                      for n in range(30)]}), encoding="utf-8")
            original = (review_tool.ROOT, review_tool.load_collector, review_tool.SECONDS_BETWEEN_CALLS)
            calls = []
            stub = type("Stub", (), {})()
            for name in ("selection_payload", "normalize_categories", "canonicalize_actor_group",
                         "AISelectionQuotaError"):
                setattr(stub, name, getattr(collector, name))
            stub.process_ai_selection_batch = answering(lambda title: 0 if "Yacht" in title else 80, calls)
            review_tool.ROOT, review_tool.load_collector = root, (lambda: stub)
            try:
                self.assertEqual(review_tool.main(["--max-calls", "1"]), 0)
            finally:
                review_tool.ROOT, review_tool.load_collector, _ = original
            self.assertEqual(len(calls), 1)
            remaining = json.loads(pending.read_text(encoding="utf-8"))["events"]
            self.assertEqual(len(remaining), 5)
            out = list((root / "archive").glob("recovered-events-reviewed-*.json"))
            kept = json.loads(out[0].read_text(encoding="utf-8"))["events"]
            self.assertEqual(len(kept), 12)        # odd items among the first 25
            self.assertTrue(all(event["ai_relevance_score"] == 80 for event in kept))


if __name__ == "__main__":
    unittest.main()
