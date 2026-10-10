"""Regression tests: Qwen is strictly opt-in for specialist historical backfill.

No live Ollama, no Gemini requests, no external network, no production writes.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from urllib.error import URLError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))

import collector
import archive_review
import enrich_archive
import qwen_backfill_adapter as qwen


def decision(**changes):
    result = {
        "event_id": "p0",
        "relevance_score": 88,
        "is_current_ct_event": True,
        "categories": ["Biological Terrorism"],
        "cbrn_subgroups": [],
        "reported_status": "ALLEGED",
        "actor_scope": "NON_STATE",
        "original_language": "en",
        "english_title": "Suspect allegedly threatened biological attack",
        "english_summary": "Police reported an alleged biological threat linked to a non-state extremist.",
        "canonical_event": "Extremist biological threat investigated",
        "actor_group": "Unknown",
        "primary_event_type": "CT_OPERATION",
        "is_attack": False,
        "incident_anchor": "Extremist biological threat investigated",
        "update_type": "INITIAL",
        "reason": "A current reported investigation with an alleged terrorist nexus.",
    }
    result.update(changes)
    return result


class FakeHTTPResponse:
    def __init__(self, value):
        self.contents = json.dumps({"message": {"content": json.dumps({"results": [value]})}}).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def read(self):
        return self.contents


class ZeroSearcher:
    fetches = 0


class QwenBackfillOnlyTests(unittest.TestCase):
    def test_off_machine_endpoints_are_refused(self):
        for endpoint in ("https://api.some-llm.com/api/chat",
                         "http://192.0.2.5:11434/api/chat",
                         "http://127.0.0.1:11434/api/generate"):
            with self.subTest(endpoint=endpoint):
                with self.assertRaises(ValueError):
                    qwen.LocalQwenBackend(collector, url=endpoint)

    def test_local_inference_passes_schema_and_never_posts_to_gemini(self):
        client = qwen.LocalQwenBackend(collector)
        article = [{"event_id": "p0", "title": "Test", "summary": "Only a unit test"}]
        with mock.patch.object(qwen, "urlopen", return_value=FakeHTTPResponse(decision())) as http:
            with mock.patch.object(collector.requests, "post", side_effect=AssertionError("Gemini called")):
                with client.gate_factory(1) as gate:
                    answer = client.call_batch(article)
                    self.assertEqual(answer[0]["categories"], ["Biological Terrorism"])
                    self.assertEqual(gate.posts, 1)
                    self.assertEqual(gate.remaining, 0)
                    with self.assertRaises(archive_review.BudgetReached):
                        client.call_batch(article)
        body = json.loads(http.call_args.args[0].data.decode("utf-8"))
        self.assertEqual(body["model"], qwen.MODEL)
        self.assertEqual(body["messages"][-1]["role"], "user")
        self.assertFalse(body["stream"])
        self.assertEqual(body["format"]["properties"]["results"]["items"]["type"], "object")

    def test_invalid_or_missing_evidence_never_silently_integrated(self):
        for override in (
            {"event_id": "wrong"},
            {"categories": []},
            {"reported_status": "INVENTED"},
            {"english_summary": ""},
            {"is_current_ct_event": False},
            {"actor_scope": "STATE_ONLY"},
        ):
            with self.subTest(override=override):
                client = qwen.LocalQwenBackend(collector)
                with mock.patch.object(qwen, "urlopen", return_value=FakeHTTPResponse(decision(**override))):
                    with client.gate_factory(1) as gate:
                        with self.assertRaises(collector.AISelectionIncompleteError):
                            client.call_batch([{"event_id": "p0", "title": "Test"}])
                        self.assertEqual(gate.posts, 1)

    def test_failure_keeps_candidate_for_later_retry(self):
        client = qwen.LocalQwenBackend(collector)
        with mock.patch.object(qwen, "urlopen", side_effect=URLError("local Ollama offline")):
            with client.gate_factory(1):
                with self.assertRaises(collector.AISelectionTransientError):
                    client.call_batch([{"event_id": "p0", "title": "Test"}])

    def test_qwen_search_run_does_not_read_gemini_ledger(self):
        client = qwen.LocalQwenBackend(collector)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "archive").mkdir()
            (root / "quota").mkdir()
            with mock.patch.object(archive_review, "DailyLedger",
                                   side_effect=AssertionError("Gemini quota ledger accessed")):
                summary, stop = enrich_archive.run(
                    root=root, collector=collector, max_posts=1, max_fetches=0,
                    ai_backend="qwen", searcher=ZeroSearcher(),
                    gate_factory=client.gate_factory, call_batch=client.call_batch,
                    plan_factory=lambda _day, _collector: [],
                    known_keys_factory=lambda _root: set(),
                    reuse_previous_reviews=False, output_factory=lambda _root, _now: enrich_archive.Output(_root, _now),
                    seen_prefix="qwen-test", deadline_minutes=1, log=lambda _message: None,
                )
            self.assertEqual(summary["ai_backend"], "qwen")
            self.assertEqual(summary["ai_requests"], 0)
            self.assertFalse(list((root / "quota").glob("*")))

    def test_qwen_round_robin_supplement_starts_before_base_exhausts(self):
        tasks = [
            {"key": "base-google-1", "source": "google"},
            {"key": "base-google-2", "source": "google"},
            {"key": "base-gdelt", "source": "gdelt"},
            {"key": "supp-google-1", "source": "google",
             "supplemental_vocabulary": "user-radnuc-181"},
            {"key": "supp-google-2", "source": "google",
             "supplemental_vocabulary": "user-radnuc-181"},
            {"key": "supp-gdelt", "source": "gdelt",
             "supplemental_vocabulary": "user-radnuc-181"},
        ]
        original = [t["key"] for t in tasks]
        ordered = enrich_archive.order_historical_tasks(
            tasks, ai_backend="qwen", prioritize_native=True)
        self.assertEqual([t["key"] for t in ordered][:4],
                         ["supp-google-1", "base-google-1",
                          "supp-google-2", "base-google-2"])
        self.assertEqual({t["key"] for t in ordered}, set(original))
        self.assertEqual([t["key"] for t in tasks], original)
        gemini = enrich_archive.order_historical_tasks(
            tasks, ai_backend="gemini", prioritize_native=True)
        self.assertEqual([t["key"] for t in gemini],
                         ["base-google-1", "base-google-2",
                          "supp-google-1", "supp-google-2",
                          "base-gdelt", "supp-gdelt"])

    def test_qwen_round_robin_without_supplement_preserves_base_order(self):
        plain = [{"key": "a", "source": "google"}, {"key": "b", "source": "gdelt"}]
        ordered = enrich_archive.order_historical_tasks(
            plain, ai_backend="qwen", prioritize_native=True)
        self.assertEqual([t["key"] for t in ordered], ["a", "b"])

    def test_default_gemini_backend_still_requires_its_ledger(self):
        self.assertEqual(enrich_archive.run.__defaults__[-1], "gemini")


if __name__ == "__main__":
    unittest.main()
