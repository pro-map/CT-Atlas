"""The 24h brief states only what the data supports. The records are real ones of
the run of 5 Nov 2026."""
import json
import unittest
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import collector

GENERATED = datetime(2026, 11, 5, 23, 10, 16, tzinfo=timezone.utc)

CIZRE = {"id": "e7ba970ebd0b6e26", "title": "Terrorist attack in Cizre", "published": "2026-10-15T14:44:04+00:00",
         "last_reported": "2026-11-02T08:47:00+00:00", "country": "Turkey", "city": "Cizre",
         "location_precision": "city", "primary_event_type": "ATTACK", "is_attack": True, "categories": ["Attacks"]}
SUDAN_DRONE = {"id": "drone-sudan", "title": "Drone strike in Sudan", "published": "2026-10-27T19:55:08+00:00",
               "last_reported": "2026-10-30T17:04:45+00:00", "country": "Sudan", "location_precision": "region",
               "primary_event_type": "ATTACK", "is_attack": True, "categories": ["Attacks"]}
SYNAGOGUE = {"id": "babe896d8fab7e12", "title": "Mass terror attack on synagogue thwarted; suspect left ideological will",
             "published": "2026-10-30T10:29:00+00:00", "last_reported": "2026-10-30T13:16:56+00:00", "country": "Italy",
             "city": "Rome", "location_precision": "country_capital", "location_method": "ai_country_capital",
             "primary_event_type": "DISRUPTED_PLOT", "categories": ["Counter Terrorism Action", "Arrests", "Attacks"],
             "ai_relevance_score": 95}
KEBBI = {"id": "fed4e15821f50078", "title": "Police confirm 12 dead in Lakurawa attacks on Kebbi communities",
         "published": "2026-10-29T11:46:10+00:00", "last_reported": "2026-10-31T18:38:05+00:00", "country": "Nigeria",
         "region": "Kebbi State", "location_precision": "region", "actor_group": "Lakurawa",
         "incident_anchor": "Kebbi communities Lakurawa attack 2026", "primary_event_type": "ATTACK", "is_attack": True,
         "categories": ["Attacks", "Counter Terrorism Action"]}


def frozen_at(moment):
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return moment.astimezone(tz)

    return patch.object(collector, "datetime", Clock)


class CapitalPlaceholderTests(unittest.TestCase):
    def test_the_capital_of_a_country_level_record_is_not_sent_as_its_place(self):
        row = collector._trend_payload(SYNAGOGUE, 0)
        self.assertEqual((row["city"], row["country"], row["location_precision"]), ("", "Italy", "country"))

    def test_a_located_city_is_kept(self):
        row = collector._trend_payload(CIZRE, 0)
        self.assertEqual((row["city"], row["location_precision"]), ("Cizre", "city"))

    def test_the_fallback_brief_does_not_name_it_either(self):
        development = collector._trend_fallback([SYNAGOGUE], GENERATED.isoformat())["developments"][0]
        self.assertEqual(development["location"], "Italy")

    def test_the_prompt_explains_the_blank_city(self):
        instructions = " ".join(collector.AI_TREND_INSTRUCTIONS.split())
        self.assertIn('location_precision "country"', instructions)
        self.assertIn("only as a placeholder", instructions)


class TrendBriefTests(unittest.TestCase):
    def fresh(self, count):
        return [{"id": f"case-{number}", "title": f"Case {number}", "published": GENERATED.isoformat()} for number in range(count)]

    def brief(self, events, overview="FSB disrupts plots in Russia."):
        response = MagicMock(status_code=200)
        answer = json.dumps({"overview": overview, "developments": []})
        with frozen_at(GENERATED), \
             patch.dict(collector.os.environ, {"GEMINI_API_KEY": "not-a-key"}), \
             patch.object(collector, "extract_interaction_text", return_value=answer), \
             patch.object(collector.requests, "post", return_value=response):
            return collector.generate_24h_trend_summary(events)

    def test_the_brief_carries_its_date_first(self):
        self.assertEqual(self.brief(self.fresh(80))["overview"], "As of 06 Nov, 00:10 Paris: FSB disrupts plots in Russia.")

    def test_a_brief_built_on_few_events_says_so_before_the_clamp_cuts_it(self):
        self.assertEqual(self.brief(self.fresh(8))["overview"],
                         "As of 06 Nov, 00:10 Paris, from only 8 reviewed events (normally 80), so developments may be "
                         "missing: FSB disrupts plots in Russia.")

    def test_a_normal_run_below_the_cap_is_not_called_thin(self):
        self.assertNotIn("only", self.brief(self.fresh(79))["overview"])

    def test_an_empty_answer_stays_empty_for_the_page_to_replace(self):
        self.assertEqual(self.brief(self.fresh(80), overview="")["overview"], "")

    def test_the_fallback_gives_the_cases_instead_of_promising_them(self):
        candidates = [SYNAGOGUE, KEBBI, CIZRE, SUDAN_DRONE]
        fallback = collector._trend_fallback(candidates, GENERATED.isoformat(), "Gemini trend temporary error 503")
        self.assertNotIn("shown below", fallback["overview"])
        self.assertTrue(fallback["overview"].startswith("As of 06 Nov, 00:10 Paris"))
        self.assertIn("AI synthesis was unavailable", fallback["overview"])
        self.assertIn(KEBBI["title"], fallback["overview"])
        self.assertIn(CIZRE["title"], fallback["overview"])
        self.assertNotIn(SUDAN_DRONE["title"], fallback["overview"])

    def test_no_reviewed_events_is_not_an_all_clear(self):
        with frozen_at(GENERATED):
            brief = collector.generate_24h_trend_summary([])
        self.assertNotIn("No significant", brief["overview"])
        self.assertIn("This does not mean that nothing happened.", brief["overview"])
        self.assertTrue(brief["overview"].startswith("As of 06 Nov, 00:10 Paris: "))


if __name__ == "__main__":
    unittest.main()
