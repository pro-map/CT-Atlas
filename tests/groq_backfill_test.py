"""Offline, provider-isolated checks for historical Groq Free public-news backfill."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import archive_review
import enrich_archive
import groq_backfill


def collector():
    return archive_review.load_collector(ROOT)


def answer(item_id):
    return {
        "event_id": item_id, "relevance_score": 86,
        "is_current_ct_event": True, "categories": ["Attacks"],
        "cbrn_subgroups": [], "reported_status": "CONFIRMED",
        "actor_scope": "NON_STATE", "original_language": "zh",
        "english_title": "Fictional militants attacked a checkpoint",
        "english_summary": "The fictitious report alleges a clash near a town.",
        "canonical_event": "Fictional checkpoint incident",
        "actor_group": "", "primary_event_type": "ATTACK",
        "is_attack": True, "incident_anchor": "Fictional checkpoint event",
        "update_type": "INITIAL", "reason": "Fictional dated armed attack reported.",
    }


def source(item_id="p0"):
    return {"event_id": item_id, "title": "Fictional militants attacked a checkpoint",
            "summary": "This fake news snippet is written for testing only.",
            "source": "Imaginary Gazette", "published": "2026-06-10",
            "collection_language_hint": "zh",
            "current_categories": ["Attacks"],
            "url": "https://private.invalid/NOT_FOR_VENDOR"}


class GroqPublicNewsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.collector = collector()

    def test_groq_schema_contains_all_map_fields_and_strict_objects(self):
        schema = groq_backfill.schema_for(self.collector)
        self.assertFalse(schema["additionalProperties"])
        row = schema["properties"]["results"]["items"]
        self.assertFalse(row["additionalProperties"])
        self.assertEqual(set(row["required"]), set(row["properties"]))
        self.assertIn("reported_status", row["required"])
        self.assertEqual(len(row["properties"]["categories"]["items"]["enum"]), 11)

    def test_strict_results_are_complete_and_fail_on_wrong_country_or_actor_schema(self):
        event = source()
        self.assertEqual(groq_backfill.validated_results({"results": [answer("p0")]},
                                                         [event], self.collector)[0]["event_id"], "p0")
        tests = [
            {**answer("p0"), "event_id": "p1"},
            {**answer("p0"), "relevance_score": 101},
            {**answer("p0"), "categories": ["Unrecognized"]},
            {**answer("p0"), "actor_scope": "STATE_ONLY"},
            {**answer("p0"), "is_attack": False, "primary_event_type": "ATTACK", "reason": "x", "update_type": "UNRECOGNIZED"},
        ]
        for value in tests:
            with self.subTest(invalid=value):
                with self.assertRaises(self.collector.AISelectionIncompleteError):
                    groq_backfill.validated_results({"results": [value]}, [event], self.collector)
        with self.assertRaises(self.collector.AISelectionIncompleteError):
            groq_backfill.validated_results({"results": [answer("p0"), answer("p0")]},
                                            [event, source("p1")], self.collector)

    def test_quota_independent_from_existing_gemini_ledger_and_durable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            quota = groq_backfill.GroqDailyQuota(root)
            self.assertGreater(quota.budget(10), 0)
            quota.reserve(3500)
            again = groq_backfill.GroqDailyQuota(root)
            self.assertEqual(again.used, 1)
            self.assertEqual(again.tokens, 3500)
            self.assertFalse((root / "quota/gemini-3.1-enrichment.json").exists())
            self.assertTrue((root / groq_backfill.QUOTA_FILE).exists())
            with self.assertRaises(archive_review.BudgetReached):
                again.reserve(groq_backfill.MAX_RESERVED_TOKENS_PER_UTC_DAY)
            self.assertEqual(groq_backfill.GroqDailyQuota(root).used, 1)

    def test_http200_one_source_batch_sends_no_source_url_or_secret_to_logs(self):
        seen = []
        class FakeResponse:
            status_code = 200
            def json(self):
                return {"choices": [{"message": {
                    "content": json.dumps({"results": [answer("p0")]})}}],
                    "usage": {"prompt_tokens": 3100, "completion_tokens": 500}}
        def fake_post(url, **kwargs):
            seen.append({"url": url, **kwargs})
            return FakeResponse()
        with tempfile.TemporaryDirectory() as tmp:
            quota = groq_backfill.GroqDailyQuota(tmp)
            gate = groq_backfill.GroqGate(self.collector, quota, 2,
                                           post=fake_post, sleep=lambda _: None)
            with mock.patch.dict(os.environ, {"GROQ_API_KEY": "MOCK_KEY_NOT_FOR_LOGS"}):
                result = gate.call_batch([source()])
            self.assertEqual(len(result), 1)
            self.assertEqual(gate.posts, 1)
            self.assertEqual(quota.used, 1)
        self.assertEqual(len(seen), 1)
        request = seen[0]
        self.assertEqual(request["url"], groq_backfill.URL)
        self.assertFalse(request["allow_redirects"])
        self.assertEqual(request["json"]["model"], groq_backfill.MODEL)
        self.assertEqual(request["json"]["response_format"]["json_schema"]["strict"], True)
        sent = json.dumps(request["json"])
        self.assertNotIn("NOT_FOR_VENDOR", sent)
        self.assertNotIn("MOCK_KEY_NOT_FOR_LOGS", sent)
        self.assertEqual(result[0]["categories"], ["Attacks"])

    def test_429_no_retry_with_durable_quota_reservation(self):
        attempts = []
        def fail(*_, **__):
            attempts.append(True)
            return SimpleNamespace(status_code=429, text="DO_NOT_LOG_SOURCE")
        with tempfile.TemporaryDirectory() as tmp:
            gate = groq_backfill.GroqGate(self.collector,
                    groq_backfill.GroqDailyQuota(tmp), 2, post=fail)
            with mock.patch.dict(os.environ, {"GROQ_API_KEY": "FAKE_KEY"}):
                with self.assertRaises(archive_review.BudgetReached) as caught:
                    gate.call_batch([source()])
            self.assertNotIn("DO_NOT_LOG_SOURCE", str(caught.exception))
            self.assertEqual(groq_backfill.GroqDailyQuota(tmp).used, 1)
        self.assertEqual(len(attempts), 1)

    def test_fail_without_credentials_or_when_request_over_budget(self):
        with tempfile.TemporaryDirectory() as tmp:
            quota = groq_backfill.GroqDailyQuota(tmp)
            gate = groq_backfill.GroqGate(self.collector, quota, 1,
                    post=lambda *args, **kwargs: self.fail("Network should not run"))
            with mock.patch.dict(os.environ, {"GROQ_API_KEY": ""}):
                with self.assertRaises(archive_review.BudgetReached):
                    gate.call_batch([source()])
            self.assertEqual(quota.used, 0)
            with mock.patch.dict(os.environ, {"GROQ_API_KEY": "LOCAL_FAKE"}):
                with self.assertRaises(self.collector.AISelectionIncompleteError):
                    gate.call_batch([source("p" + "a" * 20000)])
            self.assertEqual(quota.used, 0)

    def test_disabled_by_default_and_existing_daily_untouched(self):
        with mock.patch.dict(os.environ, {"CT_ATLAS_BACKFILL_PROVIDER": ""}):
            self.assertFalse(groq_backfill.enabled())
        with mock.patch.dict(os.environ, {"CT_ATLAS_BACKFILL_PROVIDER": "groq"}):
            self.assertTrue(groq_backfill.enabled())
        self.assertEqual(enrich_archive.BATCH_SIZE if hasattr(enrich_archive, "BATCH_SIZE")
                         else archive_review.BATCH_SIZE, 25)

    def test_hooks_use_one_ledger_and_injected_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            hooks = groq_backfill.hooks(tmp, self.collector)
            ledger = hooks["ledger_factory"](tmp, "enrichment", None)
            gate = hooks["gate_factory"](2)
            self.assertIs(gate.quota, ledger)
            self.assertEqual(hooks["review_batch_size"], 3)
            self.assertEqual(hooks["review_provider"], "Groq GPT-OSS-120B")
            self.assertEqual(ledger.used, 0)


if __name__ == "__main__":
    unittest.main()
