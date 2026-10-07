"""geolocate.py's rescue pass: it moves along a chain of Flash models when one
runs out of free quota, never uses Gemini 3.6 Flash (kept for the Report
Generator and Deep Search fallback), records the model that handled each
event, and gives up at once on a daily quota answer."""
import importlib.util
import os
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("geolocate", "geolocate.py")
geolocate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(geolocate)


def payload(n):
    return {"event_id": f"e{n}", "title": f"Event {n}"}


class RescueChainTests(unittest.TestCase):
    def setUp(self):
        self.original = (geolocate.GEMINI_RESCUE_MODELS, geolocate.GEMINI_RESCUE_MODEL, geolocate.BATCH_SIZE)
        geolocate.GEMINI_RESCUE_MODELS = ["model-a", "model-b", "model-c"]
        geolocate.BATCH_SIZE = 2

    def tearDown(self):
        geolocate.GEMINI_RESCUE_MODELS, geolocate.GEMINI_RESCUE_MODEL, geolocate.BATCH_SIZE = self.original

    def run_rescue(self, exhausted, items):
        calls = []

        def fake(batch, instructions_override=None, model_override=None):
            calls.append((model_override, [item["event_id"] for item in batch]))
            if model_override in exhausted:
                raise geolocate.GeminiQuotaError("429")
            return [{"event_id": item["event_id"], "country": "France"} for item in batch]

        with mock.patch.object(geolocate, "process_batch_resilient", side_effect=fake):
            results, done = geolocate.rescue_unknown_events(items)
        return results, done, calls

    def test_the_default_chain_leaves_3_6_flash_to_the_interactive_features(self):
        self.assertNotIn("gemini-3.6-flash", self.original[0])
        self.assertEqual(self.original[0], ["gemini-3.7-flash", "gemini-3.8-flash", "gemini-3.5-flash"])

    def test_a_spent_model_hands_the_same_batch_to_the_next(self):
        results, done, calls = self.run_rescue({"model-a"}, [payload(n) for n in range(4)])
        self.assertEqual(calls, [("model-a", ["e0", "e1"]), ("model-b", ["e0", "e1"]), ("model-b", ["e2", "e3"])])
        self.assertEqual(len(results), 4)
        self.assertEqual(done, {"e0": "model-b", "e1": "model-b", "e2": "model-b", "e3": "model-b"})

    def test_all_models_spent_keeps_finished_batches_and_stops(self):
        calls = []

        def fake(batch, instructions_override=None, model_override=None):
            calls.append(model_override)
            if len(calls) > 1:
                raise geolocate.GeminiQuotaError("429")
            return [{"event_id": item["event_id"]} for item in batch]

        with mock.patch.object(geolocate, "process_batch_resilient", side_effect=fake):
            results, done = geolocate.rescue_unknown_events([payload(n) for n in range(6)])
        self.assertEqual(calls, ["model-a", "model-a", "model-b", "model-c"])
        self.assertEqual(done, {"e0": "model-a", "e1": "model-a"}, "unfinished events stay retryable")

    def test_a_transient_failure_stops_without_switching_models(self):
        def fake(batch, instructions_override=None, model_override=None):
            raise geolocate.GeminiTransientError("503")

        with mock.patch.object(geolocate, "process_batch_resilient", side_effect=fake) as stub:
            results, done = geolocate.rescue_unknown_events([payload(n) for n in range(4)])
        self.assertEqual((results, done, stub.call_count), ([], {}, 1))

    def test_the_frozen_event_records_the_model_that_handled_it(self):
        event = {}
        geolocate.mark_rescue_complete(event, "located", "reason", model="model-b")
        self.assertEqual(event["ai_geo_rescue_model"], "model-b")


class DailyQuotaTests(unittest.TestCase):
    def test_a_daily_quota_answer_is_not_retried(self):
        response = mock.Mock(status_code=429, headers={},
                             text='{"error": {"details": [{"quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}}')
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": "test"}), \
             mock.patch.object(geolocate.requests, "post", return_value=response) as post, \
             mock.patch.object(geolocate.time, "sleep") as sleep:
            with self.assertRaises(geolocate.GeminiQuotaError):
                geolocate.call_gemini_batch([payload(1)], model_override="model-a")
        self.assertEqual(post.call_count, 1)
        sleep.assert_not_called()

    def test_a_per_minute_answer_is_still_retried(self):
        response = mock.Mock(status_code=429, headers={"Retry-After": "10"},
                             text='{"error": {"details": [{"quotaId": "GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}]}}')
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": "test"}), \
             mock.patch.object(geolocate.requests, "post", return_value=response) as post, \
             mock.patch.object(geolocate.time, "sleep"):
            with self.assertRaises(geolocate.GeminiQuotaError):
                geolocate.call_gemini_batch([payload(1)], model_override="model-a")
        self.assertEqual(post.call_count, geolocate.REQUEST_ATTEMPTS)


class SourceFaithfulGeolocationTests(unittest.TestCase):
    def test_payload_keeps_original_language_text_for_geography(self):
        event = {
            "id": "e-source",
            "title": "Youth accused of terrorism after bringing toxic products to school in Brazil",
            "original_title": "Jovem é acusado de terrorismo ao levar produtos tóxicos para escola",
            "summary": "Generated English summary.",
            "original_summary": "Resumo original sem país.",
            "source": "gmconline.com.br",
            "related_articles": [{
                "title": "Generated related title",
                "original_title": "Título relacionado original",
                "original_summary": "Resumo relacionado original",
                "source": "Example",
            }],
        }
        item = geolocate.event_ai_payload(event, 0)
        self.assertEqual(item["original_title"], event["original_title"])
        self.assertEqual(item["original_summary"], event["original_summary"])
        self.assertEqual(item["related_articles"][0]["original_title"], "Título relacionado original")
        self.assertEqual(item["related_articles"][0]["original_summary"], "Resumo relacionado original")

    def test_prompt_rejects_publisher_country_as_standalone_evidence(self):
        text = geolocate.SYSTEM_INSTRUCTIONS.lower()
        self.assertIn("original_title", text)
        self.assertIn("publisher's home country", text)
        self.assertIn("is not event-location evidence by itself", text)
        self.assertIn("return unknown", text)

    def test_prompt_explicitly_checks_source_country_contradictions(self):
        text = geolocate.SYSTEM_INSTRUCTIONS.lower()
        self.assertIn("source-country contradiction check", text)
        self.assertIn("suspected translation/publisher leakage", text)
        self.assertIn("independent same-incident source", text)
        self.assertIn("article language or cctld", text)

    def test_prompt_handles_multi_location_and_non_physical_events(self):
        text = geolocate.SYSTEM_INSTRUCTIONS.lower()
        self.assertIn("multi-location events", text)
        self.assertIn("digital / non-physical events", text)
        self.assertIn("national institutions", text)
        self.assertIn("do not infer a capital city", text)
        self.assertIn("website shutdown", text)
        self.assertIn("return the common region or country", text)


if __name__ == "__main__":
    unittest.main()
