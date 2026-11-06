"""The weekly and the 24h brief state only what the data supports. The records
and day counts are the real ones behind the owner-requested report of 5 Nov 2026."""
import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import collector

GENERATED = datetime(2026, 11, 5, 23, 10, 16, tzinfo=timezone.utc)

# Records published per day up to that report. Its fortnight opens on 23 Oct,
# which the window cuts; the file held 7 records for 5 Nov, against about 150
# on a normal day. The earlier days serve the runs before it.
PUBLISHED_PER_DAY = {
    "2026-10-18": 100, "2026-10-19": 141, "2026-10-20": 111, "2026-10-21": 125, "2026-10-22": 152,
    "2026-10-23": 170, "2026-10-24": 103, "2026-10-25": 121, "2026-10-26": 116, "2026-10-27": 162,
    "2026-10-28": 151, "2026-10-29": 149, "2026-10-30": 134, "2026-10-31": 88, "2026-11-01": 88,
    "2026-11-02": 150, "2026-11-03": 143, "2026-11-04": 87, "2026-11-05": 7,
}

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


def records(per_day):
    return [{"id": f"{day}-{number}", "title": f"Record {number}", "published": f"{day}T12:00:00+00:00"}
            for day, count in per_day.items() for number in range(count)]


def coverage_at(moment, per_day):
    with frozen_at(moment):
        return collector._weekly_coverage(collector._weekly_windows(records(per_day)))


class WeeklyWindowTests(unittest.TestCase):
    def test_a_follow_up_does_not_bring_an_old_attack_into_the_week(self):
        with frozen_at(GENERATED):
            windows = collector._weekly_windows([CIZRE, SUDAN_DRONE])
        self.assertNotIn(CIZRE, windows["current"] + windows["previous"])
        self.assertEqual(windows["previous"], [SUDAN_DRONE])
        self.assertEqual(windows["current"], [])

    def test_the_model_sees_the_publication_time(self):
        self.assertEqual(collector._weekly_compact_event(CIZRE, 0)["event_or_report_time"], CIZRE["published"])

    def test_a_record_without_a_usable_publication_date_still_has_a_time(self):
        self.assertEqual(collector._weekly_event_time({"published": "unknown", "last_reported": CIZRE["last_reported"]}),
                         datetime(2026, 11, 2, 8, 47, tzinfo=timezone.utc))


class WeeklyEventFieldTests(unittest.TestCase):
    def test_the_actor_and_the_case_label_reach_the_model(self):
        row = collector._weekly_compact_event(KEBBI, 0)
        self.assertEqual(row["actor_or_group"], "Lakurawa")
        self.assertEqual(row["incident_anchor"], "Kebbi communities Lakurawa attack 2026")

    def test_no_field_stays_that_no_record_can_fill(self):
        row = collector._weekly_compact_event(KEBBI, 0)
        self.assertNotIn("target", row)
        self.assertNotIn("tactics_or_weapons", row)


class CapitalPlaceholderTests(unittest.TestCase):
    def test_the_capital_of_a_country_level_record_is_not_sent_as_its_place(self):
        for row in (collector._weekly_compact_event(SYNAGOGUE, 0), collector._trend_payload(SYNAGOGUE, 0)):
            self.assertEqual((row["city"], row["country"], row["location_precision"]), ("", "Italy", "country"))

    def test_a_located_city_is_kept(self):
        for row in (collector._weekly_compact_event(CIZRE, 0), collector._trend_payload(CIZRE, 0)):
            self.assertEqual((row["city"], row["location_precision"]), ("Cizre", "city"))

    def test_the_fallback_brief_does_not_name_it_either(self):
        development = collector._trend_fallback([SYNAGOGUE], GENERATED.isoformat())["developments"][0]
        self.assertEqual(development["location"], "Italy")

    def test_both_prompts_explain_the_blank_city(self):
        for instructions in (collector.AI_WEEKLY_INSTRUCTIONS, collector.AI_TREND_INSTRUCTIONS):
            self.assertIn('location_precision "country"', " ".join(instructions.split()))
            self.assertIn("only as a placeholder", " ".join(instructions.split()))


if __name__ == "__main__":
    unittest.main()
