"""Geolocation rescue uses only non-deprecated 3.8 Flash after billing verification.

The default configuration sends no rescue API calls. Once explicitly enabled
and verified for the project, the rescue never uses Gemini 3.6 Flash (reserved
for reports), records the model used, and stops on provider daily quota.
"""
import contextlib
import importlib.util
import io
import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("geolocate", "geolocate.py")
geolocate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(geolocate)


def payload(n):
    return {"event_id": f"e{n}", "title": f"Event {n}"}


class RescueChainTests(unittest.TestCase):
    def setUp(self):
        self.original = (geolocate.GEMINI_RESCUE_MODELS, geolocate.GEMINI_RESCUE_MODEL,
                         geolocate.BATCH_SIZE, geolocate.GEMINI_RESCUE_BILLING_VERIFIED)
        geolocate.GEMINI_RESCUE_MODELS = ["model-a", "model-b", "model-c"]
        geolocate.BATCH_SIZE = 2
        geolocate.GEMINI_RESCUE_BILLING_VERIFIED = True

    def tearDown(self):
        (geolocate.GEMINI_RESCUE_MODELS, geolocate.GEMINI_RESCUE_MODEL,
         geolocate.BATCH_SIZE, geolocate.GEMINI_RESCUE_BILLING_VERIFIED) = self.original

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

    def test_only_current_38_is_configured_and_project_verification_defaults_off(self):
        self.assertEqual(self.original[0], ["gemini-3.8-flash"])
        self.assertFalse(self.original[3])
        self.assertNotIn("gemini-3.7-flash", self.original[0])
        self.assertNotIn("gemini-3.5-flash", self.original[0])
        self.assertNotIn("gemini-3.6-flash", self.original[0])

    def test_unverified_billing_blocks_all_rescue_requests_and_preserves_retry(self):
        geolocate.GEMINI_RESCUE_BILLING_VERIFIED = False
        with mock.patch.object(geolocate, "process_batch_resilient") as stub:
            results, done = geolocate.rescue_unknown_events([payload(1), payload(2)])
        self.assertEqual((results, done), ([], {}))
        stub.assert_not_called()

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

    def test_the_run_request_cap_stops_the_rescue_without_switching_models(self):
        def fake(batch, instructions_override=None, model_override=None):
            raise geolocate.GeminiCallCapError("cap")

        with mock.patch.object(geolocate, "process_batch_resilient", side_effect=fake) as stub:
            results, done = geolocate.rescue_unknown_events([payload(n) for n in range(4)])
        self.assertEqual((results, done, stub.call_count), ([], {}, 1))
        self.assertEqual(geolocate.GEMINI_RESCUE_MODEL, "model-a")


class DailyQuotaTests(unittest.TestCase):
    # The per-run request cap is module state: every test starts a fresh run.
    def setUp(self):
        self.saved_requests = geolocate.GEMINI_REQUESTS_SENT
        geolocate.GEMINI_REQUESTS_SENT = 0

    def tearDown(self):
        geolocate.GEMINI_REQUESTS_SENT = self.saved_requests

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

    def test_the_run_cap_counts_every_request_retries_included(self):
        response = mock.Mock(status_code=503, headers={}, text="unavailable")
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": "test"}), \
             mock.patch.object(geolocate, "MAX_CALLS_PER_RUN", 2), \
             mock.patch.object(geolocate.requests, "post", return_value=response) as post, \
             mock.patch.object(geolocate.time, "sleep"):
            with self.assertRaises(geolocate.GeminiCallCapError):
                geolocate.call_gemini_batch([payload(1)], model_override="model-a")
            with self.assertRaises(geolocate.GeminiCallCapError):
                geolocate.call_gemini_batch([payload(2)], model_override="model-a")
        self.assertEqual(post.call_count, 2)
        # The cap stops through the existing quota checkpoint path.
        self.assertTrue(issubclass(geolocate.GeminiCallCapError, geolocate.GeminiQuotaError))

    def test_the_default_cap_is_twelve_requests_a_run(self):
        # Normal runs need 2-7; a forced refresh (about 330) spreads over runs.
        self.assertEqual(geolocate.MAX_CALLS_PER_RUN, 12)


def gemini_reply(results):
    text = json.dumps({"results": results})
    return mock.Mock(status_code=200, headers={}, text="", json=lambda: {
        "status": "completed",
        "steps": [{"type": "model_output", "content": [{"type": "text", "text": text}]}]})


def country_answers(body, country="CO", confidence=0.9):
    batch = json.loads(body["input"].split("\n\n", 1)[1])["events"]
    return [{"event_id": item["event_id"], "country": "", "country_iso2": country, "city": "",
             "region": "", "precision": "country", "confidence": confidence, "latitude": 0,
             "longitude": 0, "location_is_inferred": False, "evidence": "e", "reason": "r"}
            for item in batch]


class RunCapTests(unittest.TestCase):
    """main() under AI_GEO_MAX_CALLS_PER_RUN: unsent batches keep their AI points."""

    def run_main(self, events, *, force=False, cap=1, reply=None):
        directory = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, directory, True)
        path = os.path.join(directory, "events.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"events": events}, handle)
        sent = []

        def post(url, headers=None, json=None, timeout=None):
            sent.append(json)
            return gemini_reply((reply or country_answers)(json))

        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": "test"}), \
             mock.patch.object(geolocate, "INPUT_FILE", path), \
             mock.patch.object(geolocate, "OUTPUT_FILE", path), \
             mock.patch.object(geolocate, "FORCE_AI", force), \
             mock.patch.object(geolocate, "BATCH_SIZE", 1), \
             mock.patch.object(geolocate, "MAX_CALLS_PER_RUN", cap), \
             mock.patch.object(geolocate, "GEMINI_REQUESTS_SENT", 0), \
             mock.patch.object(geolocate.requests, "post", side_effect=post), \
             mock.patch.object(geolocate.time, "sleep"), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            os.environ.pop("AI_GEO_PRESERVE_IDS_FILE", None)
            geolocate.main()
        with open(path, encoding="utf-8") as handle:
            saved = {event["id"]: event for event in json.load(handle)["events"]}
        return saved, sent, output.getvalue()

    def answered(self, event_id, version, located_at, fingerprint=None):
        event = {"id": event_id, "title": f"Attack {event_id}", "ai_geo_complete": True,
                 "ai_geo_version": version, "country_code": "PE", "country": "Peru",
                 "city": "Lima", "latitude": located_at[0], "longitude": located_at[1],
                 "location_precision": "city", "location_method": "ai_city_geonames"}
        if fingerprint:
            event["ai_geo_fingerprint"] = geolocate.event_fingerprint(
                geolocate.event_ai_payload(event, 0))
        return event

    def test_capped_run_answers_only_what_it_sent(self):
        events = [{"id": f"new{n}", "title": f"Attack {n}", "latitude": 1.5, "longitude": 1.5}
                  for n in range(3)]
        saved, sent, output = self.run_main(events, cap=1)
        self.assertEqual(len(sent), 1)
        self.assertIn("Gemini request cap for this run reached.", output)
        self.assertEqual(saved["new0"]["location_method"], "ai_country_capital")
        self.assertEqual(saved["new0"]["city"], "Bogotá")
        # Never-AI (lexical) points are still withdrawn up front, then retried.
        for event_id in ("new1", "new2"):
            self.assertIsNone(saved[event_id]["latitude"])
            self.assertIs(saved[event_id]["ai_geo_complete"], False)
            self.assertEqual(saved[event_id]["location_method"], "awaiting_ai_geolocation")

    def test_forced_refresh_under_the_cap_keeps_unsent_ai_points(self):
        current = geolocate.AI_GEO_VERSION
        events = [self.answered("current1", current, (-12.04, -77.03), fingerprint=True),
                  self.answered("stale", "gemini-ai-first-v5.2-one-shot-rescue", (-12.05, -77.04)),
                  self.answered("current2", current, (-12.06, -77.05), fingerprint=True)]
        events[1]["ai_geo_rescue_complete"] = True
        saved, sent, output = self.run_main(events, force=True, cap=1)
        self.assertEqual(len(sent), 1)
        # The record the current engine has not answered goes first.
        self.assertIn('"event_id": "stale"', sent[0]["input"])
        self.assertEqual(saved["stale"]["city"], "Bogotá")
        self.assertEqual(saved["stale"]["ai_geo_version"], current)
        self.assertIs(saved["stale"]["ai_geo_rescue_complete"], False)
        for event_id, point in (("current1", (-12.04, -77.03)), ("current2", (-12.06, -77.05))):
            self.assertEqual((saved[event_id]["latitude"], saved[event_id]["longitude"]), point)
            self.assertIs(saved[event_id]["ai_geo_complete"], True)
            self.assertEqual(saved[event_id]["location_method"], "ai_city_geonames")

    def test_an_exhausted_rescue_keeps_no_low_confidence_point(self):
        def reply(body):
            if body["model"] == "rescue-model":
                return country_answers(body, country="")
            return country_answers(body, confidence=0.3)

        with mock.patch.object(geolocate, "GEMINI_RESCUE_BILLING_VERIFIED", True), \
             mock.patch.object(geolocate, "GEMINI_RESCUE_MODELS", ["rescue-model"]), \
             mock.patch.object(geolocate, "GEMINI_RESCUE_MODEL", "rescue-model"):
            saved, sent, _ = self.run_main([{"id": "weak", "title": "Attack"}], cap=5, reply=reply)
        self.assertEqual(len(sent), 2)
        event = saved["weak"]
        self.assertEqual((event["location_method"], event["excluded_from_map"]), ("ai_unlocated_final", True))
        self.assertEqual((event["city"], event["latitude"], event["longitude"]), (None, None, None))


class StoredLocationRepairTests(unittest.TestCase):
    """Zero-AI repairs run by geolocate.py itself on every run."""

    def records(self):
        return {
            "sinaloa": {"id": "sinaloa", "location_method": "ai_region_coordinates", "country_code": "MX",
                        "region": "Sinaloa", "latitude": 24.5369, "longitude": 107.545,
                        "location_precision": "region", "ai_geo_complete": True},
            "segou": {"id": "segou", "location_method": "ai_region_coordinates", "country_code": "ML",
                      "latitude": 14.4, "longitude": 6.22, "ai_geo_complete": True},
            "reunion": {"id": "reunion", "location_method": "ai_region_coordinates", "country_code": "FR",
                        "latitude": -21.1151, "longitude": 55.5364, "ai_geo_complete": True},
            "pacific": {"id": "pacific", "location_method": "ai_region_coordinates", "country_code": "US",
                        "latitude": 0.0, "longitude": -140.0, "ai_geo_complete": True},
            "us": {"id": "us", "location_method": "ai_unlocated", "location_precision": "unlocated",
                   "country_code": "US", "country": "United States", "city": None,
                   "latitude": None, "longitude": None, "ai_geo_complete": True},
            "us_city": {"id": "us_city", "location_method": "ai_unlocated", "location_precision": "unlocated",
                        "country_code": "US", "city": None, "latitude": None, "longitude": None,
                        "ai_geo_complete": True, "geolocation_validation_issue": "ambiguous_or_unresolved_city",
                        "geolocation_requested_city": "Washington", "geolocation_review_required": True},
            "final": {"id": "final", "location_method": "ai_unlocated_final", "location_precision": "unlocated",
                      "ai_geo_rescue_status": "unlocated_final", "excluded_from_map": True,
                      "country_code": "BY", "city": "Minsk", "latitude": 53.9, "longitude": 27.57,
                      "ai_geo_complete": True},
        }

    def test_repairs_are_exact_idempotent_and_send_nothing(self):
        events = self.records()
        untouched = {key: dict(events[key]) for key in ("reunion", "pacific", "us_city")}
        with mock.patch.object(geolocate.requests, "post") as post, \
             contextlib.redirect_stdout(io.StringIO()) as output:
            counts = geolocate.repair_stored_locations(list(events.values()))
            again = geolocate.repair_stored_locations(list(events.values()))
        post.assert_not_called()
        self.assertEqual(dict(counts), {"longitude_sign": 2, "capital_placed": 1, "unlocated_final_cleared": 1})
        self.assertEqual(sum(again.values()), 0)
        self.assertEqual(output.getvalue().count("Stored-location repair (no AI)"), 6)
        self.assertEqual(events["sinaloa"]["longitude"], -107.545)
        self.assertEqual(events["segou"]["longitude"], -6.22)
        for key in ("sinaloa", "segou"):
            self.assertEqual(events[key]["ai_geo_coordinate_correction"], "longitude_sign")
        self.assertEqual((events["us"]["city"], events["us"]["location_precision"],
                          events["us"]["latitude"]), ("Washington", "country_capital", 38.89511))
        self.assertEqual((events["final"]["city"], events["final"]["latitude"],
                          events["final"]["longitude"]), (None, None, None))
        for key, before in untouched.items():
            self.assertEqual(events[key], before)
        # Nothing is re-queued for Gemini or flagged for review.
        for event in events.values():
            self.assertIs(event["ai_geo_complete"], True)
        self.assertNotIn("geolocation_review_required", events["us"])


class ResolverTests(unittest.TestCase):
    """Real GeoNames data: namesakes, capitals and coordinate signs."""

    def test_capitals_with_same_country_namesakes_are_placed(self):
        for code, geonameid in (("US", 4140963), ("VN", 1581130), ("CR", 3621849), ("CO", 3688689)):
            self.assertEqual(geolocate.resolve_capital(code)["geonameid"], geonameid)
            event = {}
            geolocate.apply_ai_result(event, {"precision": "country", "country_iso2": code,
                                              "confidence": .8, "evidence": "country only"}, "fp")
            capital = geolocate.CITIES[str(geonameid)]
            self.assertEqual((event["location_precision"], event["location_method"]),
                             ("country_capital", "ai_country_capital"))
            self.assertEqual((event["latitude"], event["longitude"]),
                             (capital["latitude"], capital["longitude"]))

    def test_the_models_point_picks_among_city_namesakes(self):
        for name, code, point, geonameid in (("Perth", "AU", (-31.95, 115.86), "2063523"),
                                             ("Washington", "US", (38.9, -77.03), "4140963"),
                                             ("Hanoi", "VN", (21.03, 105.85), "1581130")):
            event = {}
            geolocate.apply_ai_result(event, {"precision": "city", "city": name, "country_iso2": code,
                                              "confidence": .9, "latitude": point[0],
                                              "longitude": point[1]}, "fp")
            place = geolocate.CITIES[geonameid]
            self.assertEqual(event["location_method"], "ai_city_geonames", name)
            self.assertEqual((event["latitude"], event["longitude"]),
                             (place["latitude"], place["longitude"]))
            self.assertNotIn("geolocation_validation_issue", event)
        # Without the model's point a namesake is still never chosen by population.
        self.assertIsNone(geolocate.resolve_city("Perth", "AU"))

    def test_one_town_listed_twice_and_reviewed_spellings_resolve(self):
        self.assertEqual(geolocate.resolve_city("Karak", "JO")["geonameid"], 250624)
        self.assertEqual(geolocate.resolve_city("Kerak", "JO")["geonameid"], 250624)
        for name, code, geonameid in (("Hodeidah", "YE", 79415), ("Rankous", "SY", 165533),
                                      ("Deir Ezzor", "SY", 170794), ("Givat Shmuel", "IL", 294981)):
            self.assertEqual(geolocate.resolve_city(name, code)["geonameid"], geonameid)
        # A supplement spelling never leaves its country.
        self.assertIsNone(geolocate.resolve_city("Hodeidah", "SA"))

    def test_a_dropped_longitude_sign_is_restored_and_recorded(self):
        event = {"ai_geo_coordinate_correction": "stale"}
        geolocate.apply_ai_result(event, {"precision": "region", "region": "Sinaloa", "country_iso2": "MX",
                                          "confidence": .8, "latitude": 24.54, "longitude": 107.55}, "fp")
        self.assertEqual((event["latitude"], event["longitude"]), (24.54, -107.55))
        self.assertEqual(event["location_method"], "ai_region_coordinates")
        self.assertEqual(event["ai_geo_coordinate_correction"], "longitude_sign")
        geolocate.apply_ai_result(event, {"precision": "region", "region": "Sinaloa", "country_iso2": "MX",
                                          "confidence": .8, "latitude": 24.54, "longitude": -107.55}, "fp")
        self.assertNotIn("ai_geo_coordinate_correction", event)

    def test_overseas_and_maritime_points_keep_their_coordinates(self):
        for code, point in (("FR", (-21.1151, 55.5364)), ("US", (0.0, -140.0)), ("YE", (20.0, 38.0))):
            event = {}
            geolocate.apply_ai_result(event, {"precision": "region", "region": "far", "country_iso2": code,
                                              "confidence": .8, "latitude": point[0],
                                              "longitude": point[1]}, "fp")
            self.assertEqual((event["latitude"], event["longitude"]), point)
            self.assertEqual(event["location_method"], "ai_region_coordinates")
            self.assertNotIn("ai_geo_coordinate_correction", event)


class SourceFaithfulGeolocationTests(unittest.TestCase):
    def test_city_normalization_keeps_nonlatin_aliases_and_decodes_entities(self):
        self.assertEqual(geolocate.normalize_name('北京'), '北京')
        self.assertEqual(geolocate.normalize_name('C&#xfa;cuta'), geolocate.normalize_name('Cúcuta'))
        self.assertEqual(geolocate.resolve_city('北京', 'CN')['name'], 'Beijing')
        self.assertEqual(geolocate.resolve_city('القاهرة', 'EG')['name'], 'Cairo')
        self.assertEqual(geolocate.resolve_city('C&#xfa;cuta', 'CO')['name'], 'Cúcuta')

    def test_ambiguous_city_never_becomes_a_capital_point(self):
        event = {'id':'unresolved','title':'Incident in an unresolved Colombian locality'}
        geolocate.apply_ai_result(event, {'precision':'city','city':'Unresolved village',
            'country_iso2':'CO','confidence':.99,'latitude':1,'longitude':2,
            'evidence':'Source names the village','reason':'Location requires review'}, 'fingerprint')
        self.assertEqual(event['country_code'], 'CO')
        self.assertIsNone(event['latitude'])
        self.assertIsNone(event['city'])
        self.assertEqual(event['geolocation_requested_city'], 'Unresolved village')
        self.assertTrue(event['geolocation_review_required'])
        self.assertEqual(event['location_evidence'], ['Source names the village'])

    def test_country_only_result_remains_an_explicit_country_level_marker(self):
        event = {}
        geolocate.apply_ai_result(event, {'precision':'country','country_iso2':'CO',
            'confidence':.8,'evidence':'Colombia only'}, 'fingerprint')
        self.assertEqual(event['location_precision'], 'country_capital')
        self.assertEqual(event['city'], 'Bogotá')
        self.assertNotIn('geolocation_review_required', event)

    def test_punctuated_country_alias_is_normalized_on_both_sides(self):
        self.assertEqual(geolocate.resolve_country_code({'country':'U.S.A.'}), 'US')
        self.assertEqual(geolocate.resolve_country_code({'country':'Côte d’ivoire'}), 'CI')

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
