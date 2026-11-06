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


class WeeklyCoverageTests(unittest.TestCase):
    def test_the_starved_day_of_5_november_is_found(self):
        coverage = coverage_at(GENERATED, PUBLISHED_PER_DAY)
        self.assertEqual(coverage["starved_days"], [{"date": "2026-11-05", "records": 7}])
        self.assertEqual(coverage["typical_day"], 149)
        self.assertEqual(coverage["records_published_per_day"]["2026-11-04"], 87)

    def test_ordinary_days_are_not_a_starved_run(self):
        # The same fortnight with 5 Nov as it would have been; weekends stay low.
        self.assertEqual(coverage_at(GENERATED, {**PUBLISHED_PER_DAY, "2026-11-05": 141})["starved_days"], [])

    def test_a_day_refilled_by_a_later_run_stops_counting(self):
        later = GENERATED + timedelta(days=2)
        per_day = {**PUBLISHED_PER_DAY, "2026-11-05": 120, "2026-11-06": 130, "2026-11-07": 110}
        self.assertEqual(coverage_at(later, per_day)["starved_days"], [])

    def test_the_day_in_progress_is_judged_on_what_has_passed(self):
        before = {day: count for day, count in PUBLISHED_PER_DAY.items() if day < "2026-11-05"}
        # 18:04 UTC on 5 Nov: 7 records and 32 reviews. The run of the day before
        # had 38 at the same hour, a thin but working run that ended on 87.
        starved = coverage_at(datetime(2026, 11, 5, 18, 4, tzinfo=timezone.utc), {**before, "2026-11-05": 7})
        self.assertEqual(starved["starved_days"], [{"date": "2026-11-05", "records": 7}])
        thin = coverage_at(datetime(2026, 11, 4, 18, 9, tzinfo=timezone.utc), {**before, "2026-11-04": 38})
        self.assertEqual(thin["starved_days"], [])

    def test_a_morning_run_says_nothing_about_a_day_barely_begun(self):
        before = {day: count for day, count in PUBLISHED_PER_DAY.items() if day < "2026-11-02"}
        self.assertEqual(coverage_at(datetime(2026, 11, 2, 7, 58, tzinfo=timezone.utc), before)["starved_days"], [])

    def test_a_long_outage_does_not_become_the_norm(self):
        days = sorted(PUBLISHED_PER_DAY)
        per_day = {**PUBLISHED_PER_DAY, **{day: 7 for day in days[-8:]}}
        self.assertEqual(len(coverage_at(GENERATED, per_day)["starved_days"]), 8)

    def test_the_note_is_for_the_reader_and_stays_out_of_the_panel_headings(self):
        coverage = coverage_at(GENERATED, PUBLISHED_PER_DAY)
        note = collector._weekly_data_note(coverage, [{"location_precision": "country"}, {"location_precision": "city"}])
        self.assertIn("Collection was incomplete on 05 Nov 2026 (7 records), against about 149 records", note)
        self.assertIn("1 of the 2 records assessed give a country only", note)
        for heading in collector.WEEKLY_REQUIRED_SECTIONS:
            self.assertNotIn(heading, note.upper())

    def test_no_note_when_nothing_needs_saying(self):
        clean = {"starved_days": [], "typical_day": 149}
        self.assertEqual(collector._weekly_data_note(clean, [{"location_precision": "city"}]), "")


class WeeklyReportTests(unittest.TestCase):
    ANALYSIS = " ".join(collector.WEEKLY_REQUIRED_SECTIONS) + " " + "operational shift indicates a pattern of disruption. " * 150

    def generate(self, events):
        response = MagicMock(status_code=200)
        answer = json.dumps({"title": "Weekly", "analysis": self.ANALYSIS})
        with frozen_at(GENERATED), \
             patch.object(collector, "should_generate_weekly_analysis", return_value=(True, "owner_request")), \
             patch.dict(collector.os.environ, {"GEMINI_API_KEY": "not-a-key"}), \
             patch.object(collector, "extract_interaction_text", return_value=answer), \
             patch.object(collector.requests, "post", return_value=response) as post:
            weekly = collector.generate_weekly_analysis(events)
        return weekly, json.loads(post.call_args.kwargs["json"]["input"].split("\n\n", 1)[1])

    def test_the_period_text_and_the_panel_fields_give_the_same_dates(self):
        weekly, payload = self.generate(records(PUBLISHED_PER_DAY))
        period = payload["reporting_period"]
        self.assertEqual(period["current_dates"], "30 Oct 2026 to 06 Nov 2026")
        self.assertEqual(period["comparison_dates"], "23 Oct 2026 to 30 Oct 2026")
        self.assertEqual(period["current_start"][:10], "2026-10-30")
        self.assertEqual(period["current_end"][:10], "2026-11-06")
        # The panel prints these stored instants in Paris time.
        for field, dates in (("current_period_start", "30 Oct 2026"), ("current_period_end", "06 Nov 2026"),
                             ("comparison_period_start", "23 Oct 2026"), ("comparison_period_end", "30 Oct 2026")):
            self.assertEqual(datetime.fromisoformat(weekly[field]).astimezone(collector.PARIS_TZ).strftime("%d %b %Y"), dates)
        self.assertIn("current_dates and comparison_dates", " ".join(collector.AI_WEEKLY_INSTRUCTIONS.split()))

    def test_a_starved_period_is_flagged_to_the_model_and_to_the_reader(self):
        weekly, payload = self.generate(records(PUBLISHED_PER_DAY))
        self.assertEqual(payload["data_coverage"]["starved_days"], [{"date": "2026-11-05", "records": 7}])
        self.assertIn("starved_days", collector.AI_WEEKLY_INSTRUCTIONS)
        self.assertTrue(weekly["analysis"].startswith("DATA NOTE: Collection was incomplete on 05 Nov 2026"))
        self.assertEqual(weekly["data_coverage"], payload["data_coverage"])

    def test_the_note_leaves_the_assessment_intact(self):
        weekly, _ = self.generate(records(PUBLISHED_PER_DAY))
        note, assessment = weekly["analysis"].split("\n\n", 1)
        self.assertEqual(assessment, collector.clean_text(self.ANALYSIS))
        self.assertEqual(collector._weekly_analysis_quality_issue(weekly["analysis"]), "")
        self.assertEqual(weekly["version"], "weekly-analysis-v2-analytical-synthesis")

    def test_a_whole_fortnight_with_located_records_carries_no_note(self):
        weekly, payload = self.generate(records({**PUBLISHED_PER_DAY, "2026-11-05": 141}))
        self.assertEqual(payload["data_coverage"]["starved_days"], [])
        self.assertTrue(weekly["analysis"].startswith("EXECUTIVE ASSESSMENT"))


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
