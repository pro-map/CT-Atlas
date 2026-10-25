"""No-network checks of aggregate synthetic scoring; no model quality claims."""
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "experiments"))
import external_llm_metrics as m
import external_llm_pilot as pilot


class SyntheticScoreTests(unittest.TestCase):
    def pair(self, labels, predicted, status="ALLEGED", predicted_status="ALLEGED",
             country="", predicted_country="", lang="en"):
        return ({
            "id": "fictional", "expected_labels": labels,
            "expected_status": status, "expected_country": country, "language": lang,
        }, {
            "category_labels": predicted, "qualifying_event": bool(predicted),
            "reported_status": predicted_status, "event_country": predicted_country,
        })

    def test_true_positive_false_positive_false_negative_are_separate(self):
        cases = [
            self.pair(["Attacks"], ["Attacks"]),
            self.pair(["Weapons"], []),
            self.pair([], ["Attacks"]),
        ]
        report = m.classification_metrics(cases, pilot.CATEGORIES)
        self.assertEqual(report["cases"], 3)
        self.assertEqual(report["label_micro_precision"], 0.5)
        self.assertEqual(report["label_micro_recall"], 0.5)
        self.assertEqual(report["label_micro_f1"], 0.5)
        self.assertEqual(report["per_category"]["Attacks"]["true_positive"], 1)
        self.assertEqual(report["per_category"]["Attacks"]["false_positive"], 1)
        self.assertEqual(report["per_category"]["Weapons"]["false_negative"], 1)
        self.assertFalse(report["production_validated"])

    def test_unsupported_source_country_guess_is_visible(self):
        report = m.classification_metrics([
            self.pair(["Arrests"], ["Arrests"], country="", predicted_country="Brazil"),
            self.pair(["Weapons"], ["Weapons"], country="United States",
                      predicted_country="France", lang="fr"),
        ], pilot.CATEGORIES)
        self.assertEqual(report["unsupported_country_guesses"], 1)
        self.assertEqual(report["country_mismatches_when_provided"], 1)
        self.assertEqual(report["event_country_agreement"], 0)
        self.assertEqual(report["per_language"]["fr"]["cases"], 1)

    def test_status_mismatch_not_silently_counted_as_category_match(self):
        report = m.classification_metrics([
            self.pair(["Biological Terrorism"], ["Biological Terrorism"],
                      status="HOAX", predicted_status="CONFIRMED"),
        ], pilot.CATEGORIES)
        self.assertEqual(report["exact_category_agreement"], 1)
        self.assertEqual(report["reported_status_agreement"], 0)

    def test_nonrelevant_cases_never_look_like_perfect_recall_by_default(self):
        report = m.classification_metrics([self.pair([], [])], pilot.CATEGORIES)
        self.assertIsNone(report["label_micro_precision"])
        self.assertIsNone(report["label_micro_recall"])
        self.assertIsNone(report["label_micro_f1"])

    def test_translation_exact_reference_is_not_certified_fidelity(self):
        fixtures = [x for x in pilot.load_fixtures() if x["task"] == "translation"]
        case = fixtures[0]
        good = {"title_en": case["expected_title_en"]}
        unrelated = {"title_en": case["expected_title_en"] + " 777"}
        report = m.translation_metrics([(case, good), (case, unrelated)])
        self.assertEqual(report["cases"], 2)
        self.assertEqual(report["exact_reference_title_matches"], 1)
        self.assertEqual(report["headlines_with_invented_numerals"], 1)
        self.assertFalse(report["production_validated"])
        self.assertIn("independent bilingual review", report["warning"])

    def test_complete_per_language_and_category_coverage_is_offline(self):
        with mock.patch.object(pilot, "call_json",
                               side_effect=AssertionError("Network attempted")):
            with mock.patch("builtins.print") as out:
                code = pilot.main(["--mode", "coverage", "--max-per-provider", "26"], env={})
        self.assertEqual(code, 0)
        result = json.loads(out.call_args.args[0])
        self.assertEqual(result["total_available_cases"], 26)
        self.assertEqual(result["task_coverage"], {
            "classification": 18, "translation": 8})
        self.assertGreater(result["negative_controls"], 0)
        self.assertEqual(set(result["eleven_category_occurrences"]), set(pilot.CATEGORIES))
        self.assertEqual(result["external_requests"], 0)
        self.assertFalse(result["production_validated"])

    def test_live_preflight_rejects_mutated_fixture_before_network(self):
        fixtures = pilot.load_fixtures()
        bad = dict(fixtures[0])
        bad["expected_status"] = None
        with mock.patch.object(pilot, "FIXTURES") as mock_path:
            mock_path.read_text.return_value = json.dumps({
                "source": "SYNTHETIC_PUBLIC_EXAMPLES_ONLY", "items": [bad]})
            with self.assertRaisesRegex(pilot.PilotSafetyError, "reported-status"):
                pilot.load_fixtures()


if __name__ == "__main__":
    unittest.main()
