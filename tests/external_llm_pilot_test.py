"""Offline, deterministic checks for isolated external-LLM proof of concept.

No network, credentials, operational news, map events, or private dark-web data.
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "experiments"))

import external_llm_pilot as pilot


class FixtureAndScopeTests(unittest.TestCase):
    def test_fixture_is_synthetic_public_and_covers_all_eleven_map_labels(self):
        cases = pilot.load_fixtures()
        self.assertEqual(len(cases), 26)
        self.assertEqual(len([x for x in cases if x["task"] == "classification"]), 18)
        self.assertEqual(len([x for x in cases if x["task"] == "translation"]), 8)
        self.assertTrue(all(x["synthetic_public"] for x in cases))
        all_labels = set().union(*(set(x.get("expected_labels", [])) for x in cases))
        self.assertEqual(all_labels, set(pilot.CATEGORIES))
        self.assertTrue({"ar", "zh", "zh-Hant", "fr"} <=
                        {x["language"] for x in cases})
        self.assertFalse(any(".onion" in str(x).lower() for x in cases))

    def test_missing_public_marking_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp, "fixture.json")
            file.write_text(json.dumps({"source": "SYNTHETIC_PUBLIC_EXAMPLES_ONLY",
                                        "items": [{
                                            "id": "unsafe", "task": "translation",
                                            "title": "Test", "summary": "Test",
                                            "synthetic_public": False,
                                        }]}), encoding="utf-8")
            with mock.patch.object(pilot, "FIXTURES", file):
                with self.assertRaises(pilot.PilotSafetyError):
                    pilot.load_fixtures()

    def test_untrusted_article_with_onion_url_or_interpol_reference_is_refused(self):
        for title in ["Untrusted http://example.onion", "INTERPOL case document"]:
            with self.subTest(title=title), tempfile.TemporaryDirectory() as tmp:
                f = Path(tmp, "fixture.json")
                item = {
                    "id": "unsafe", "task": "classification", "title": title,
                    "summary": "Test", "synthetic_public": True,
                    "expected_labels": [],
                }
                f.write_text(json.dumps({
                    "source": "SYNTHETIC_PUBLIC_EXAMPLES_ONLY", "items": [item],
                }), encoding="utf-8")
                with mock.patch.object(pilot, "FIXTURES", f):
                    with self.assertRaises(pilot.PilotSafetyError):
                        pilot.load_fixtures()

    def test_groq_uses_gpt_oss_strict_schema_and_no_source_links(self):
        case = next(c for c in pilot.load_fixtures() if c["task"] == "classification")
        params = pilot.prepare_groq(case)
        self.assertEqual(params["model"], "openai/gpt-oss-120b")
        self.assertTrue(params["response_format"]["json_schema"]["strict"])
        self.assertFalse(params["stream"])
        self.assertEqual(set(params["response_format"]["json_schema"]["schema"]["required"]),
                         set(pilot.CLASSIFICATION_SCHEMA["properties"]))
        self.assertNotIn("url", json.dumps(params))

    def test_cloudflare_uses_only_source_title_and_excerpt(self):
        case = next(c for c in pilot.load_fixtures() if c["task"] == "translation")
        params = pilot.prepare_cloudflare(case)
        self.assertEqual(params["model"], "@cf/zai-org/glm-4.7-flash")
        payload = json.loads(params["messages"][1]["content"])
        self.assertEqual(payload["id"], case["id"])
        self.assertEqual(payload["content_hash"], pilot.content_hash(case))
        self.assertNotIn("url", payload)
        self.assertNotIn("attachments", payload)


class SafetyAndValidationTests(unittest.TestCase):
    def setUp(self):
        self.classification = next(c for c in pilot.load_fixtures()
                                   if c["task"] == "classification")
        self.translation = next(c for c in pilot.load_fixtures()
                                if c["task"] == "translation")

    def decision(self, **overrides):
        data = {
            "category_labels": ["Radiological/Nuclear", "Arrests"],
            "relevance_score": 76,
            "qualifying_event": True,
            "actor_scope": "NON_STATE",
            "reported_status": "SUSPECTED",
            "event_country": "",
            "reason": "The fictional police investigation reports a suspected CT event.",
        }
        data.update(overrides)
        return data

    def test_valid_decision_is_accepted_and_semantically_invalid_refused(self):
        self.assertEqual(pilot.validate_classification(self.decision())["relevance_score"], 76)
        invalid = [
            {"category_labels": ["Weapons", "Weapons"]},
            {"category_labels": ["UNKNOWN_CATEGORY"]},
            {"category_labels": []},
            {"relevance_score": 101},
            {"relevance_score": True},
            {"reported_status": "CONFIRMED_BY_MODEL"},
            {"actor_scope": "STATE_ONLY"},
            {"qualifying_event": False},
            {"reason": ""},
        ]
        for item in invalid:
            with self.subTest(item=item):
                with self.assertRaises(pilot.PilotSafetyError):
                    pilot.validate_classification(self.decision(**item))

    def test_translation_rejects_changed_content_hash_or_lost_numbers(self):
        original = self.translation
        answer = {"id": original["id"],
                  "content_hash": pilot.content_hash(original),
                  "title_en": original["expected_title_en"],
                  "overview_en": "A bulletin was issued."}
        self.assertEqual(pilot.validate_translation(original, answer), answer)
        for override in ({"id": "incorrect"}, {"content_hash": "0" * 64},
                         {"title_en": "A new bulletin was published"},
                         {"overview_en": ""}):
            with self.subTest(override=override):
                with self.assertRaises(pilot.PilotSafetyError):
                    pilot.validate_translation(original, {**answer, **override})

    def test_accounts_must_be_explicitly_confirmed_before_any_live_request(self):
        for provider in ("groq", "cloudflare"):
            with self.subTest(provider=provider):
                with self.assertRaises(pilot.PilotSafetyError):
                    pilot.preflight(provider, 1, env={})
        groq = {"EXTERNAL_LLM_PILOT_EXPLICIT_OPT_IN": "YES",
                "GROQ_FREE_PLAN_VERIFIED": "YES", "GROQ_API_KEY": "local-test-value"}
        pilot.preflight("groq", 1, env=groq)
        cloudflare = {"EXTERNAL_LLM_PILOT_EXPLICIT_OPT_IN": "YES",
                      "CLOUDFLARE_WORKERS_AI_FREE_PLAN_VERIFIED": "YES",
                      "CLOUDFLARE_AI_API_TOKEN": "local-test-value",
                      "CLOUDFLARE_AI_ACCOUNT_ID": "a" * 32}
        pilot.preflight("cloudflare", 1, env=cloudflare)
        for provider, env in (("groq", groq), ("cloudflare", cloudflare)):
            with self.assertRaises(pilot.PilotSafetyError):
                pilot.preflight(provider, 3, env=env)

    def test_live_both_preflight_all_before_any_network(self):
        approved_groq = {"EXTERNAL_LLM_PILOT_EXPLICIT_OPT_IN": "YES",
                         "GROQ_FREE_PLAN_VERIFIED": "YES",
                         "GROQ_API_KEY": "fake-not-real"}
        with mock.patch.object(pilot, "call_json", side_effect=AssertionError("Network attempted")):
            with self.assertRaises(pilot.PilotSafetyError):
                pilot.main(["--mode", "live", "--provider", "both", "--max-per-provider", "1"],
                           env=approved_groq)

    def test_offline_default_has_zero_provider_calls_and_no_mutations(self):
        with mock.patch.object(pilot, "call_json", side_effect=AssertionError("Network attempted")):
            with mock.patch("builtins.print") as println:
                rc = pilot.main([], env={})
        self.assertEqual(rc, 0)
        report = json.loads(println.call_args.args[0])
        self.assertEqual(report["mode"], "OFFLINE_PLAN_ONLY")
        self.assertEqual(report["external_requests"], 0)
        self.assertFalse(report["production_modified"])

    def test_live_request_is_bound_to_exact_provider_origin_and_no_redirects(self):
        request = self.decision()
        class Resp:
            status_code = 200
            def json(self):
                return {"choices": [{"message": {"content": json.dumps(request)}}],
                        "usage": {"prompt_tokens": 75, "completion_tokens": 40}}
        seen = []
        def fake_post(url, **kwargs):
            seen.append((url, kwargs))
            return Resp()
        data, usage = pilot.call_json(
            "groq", pilot.prepare_groq(self.classification),
            env={"GROQ_API_KEY": "mock-only"}, post=fake_post)
        self.assertEqual(data["actor_scope"], "NON_STATE")
        self.assertEqual(usage["prompt_tokens"], 75)
        self.assertEqual(seen[0][0], pilot.GROQ_URL)
        self.assertFalse(seen[0][1]["allow_redirects"])
        self.assertEqual(seen[0][1]["headers"]["Authorization"], "Bearer mock-only")

    def test_provider_error_never_logs_response_body_or_retries(self):
        calls = []
        class Fail:
            status_code = 429
            text = "secret source excerpt that should NEVER be printed"
        def fail(url, **kwargs):
            calls.append(url)
            return Fail()
        with self.assertRaisesRegex(pilot.PilotSafetyError, "HTTP 429") as caught:
            pilot.call_json("cloudflare", pilot.prepare_cloudflare(self.translation),
                            env={"CLOUDFLARE_AI_API_TOKEN": "fake-secret",
                                 "CLOUDFLARE_AI_ACCOUNT_ID": "a" * 32}, post=fail)
        self.assertEqual(len(calls), 1)
        self.assertNotIn(Fail.text, str(caught.exception))
        self.assertNotIn("fake-secret", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
