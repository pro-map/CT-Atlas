"""The weekly facts count an attack once, in the week it happened."""
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import collector


def attack(event_id, published, update="INITIAL", incident="inc-1", country="France"):
    return {"id": event_id, "title": event_id, "published": published.isoformat(), "country": country,
            "region": "Europe", "incident_id": incident, "primary_event_type": "ATTACK", "is_attack": True,
            "update_type": update, "categories": ["Attacks"]}


def country_row(stats):
    return stats["top_countries_by_incident_activity"][0]


class StopBeforeTheModelCall(Exception):
    pass


class WeeklyAttackPointTests(unittest.TestCase):
    def test_a_week_holding_only_the_follow_up_does_not_count_the_attack(self):
        now = datetime(2026, 11, 5, tzinfo=timezone.utc)
        initial = attack("initial", now - timedelta(days=9))
        follow_up = attack("follow-up", now - timedelta(days=2), "FOLLOW_UP")
        updates = collector._weekly_attack_updates([initial, follow_up])
        self.assertEqual(updates, {id(follow_up)})
        current = country_row(collector._weekly_stats([follow_up], updates))
        self.assertEqual(current["unique_attacks"], 0)
        self.assertEqual(current["reporting_records"], 1)
        self.assertEqual(country_row(collector._weekly_stats([initial], updates))["unique_attacks"], 1)

    def test_an_orphan_follow_up_stays_a_counted_attack(self):
        orphan = attack("orphan", datetime(2026, 11, 3, tzinfo=timezone.utc), "FOLLOW_UP")
        updates = collector._weekly_attack_updates([orphan])
        self.assertEqual(country_row(collector._weekly_stats([orphan], updates))["unique_attacks"], 1)

    def test_flags_are_taken_before_the_windows_are_cut(self):
        now = datetime.now(timezone.utc)
        events = [attack("initial", now - timedelta(days=30)),
                  attack("follow-up", now - timedelta(days=2), "FOLLOW_UP")]
        seen = []

        def stats(window, attack_updates=()):
            seen.append(collector._weekly_geo_breakdown(window, "country", 10, attack_updates))
            if len(seen) == 2:
                raise StopBeforeTheModelCall
            return {}

        with patch.object(collector, "should_generate_weekly_analysis", return_value=(True, "test")), \
             patch.object(collector, "_weekly_stats", side_effect=stats), \
             patch.dict(collector.os.environ, {"GEMINI_API_KEY": "not-a-key"}), \
             patch.object(collector.requests, "post") as post:
            with self.assertRaises(StopBeforeTheModelCall):
                collector.generate_weekly_analysis(events)
        post.assert_not_called()
        self.assertEqual(seen[0][0]["unique_attacks"], 0)
        self.assertEqual(seen[0][0]["reporting_records"], 1)

    def test_the_selection_prompt_keeps_reactions_out_of_initial(self):
        self.assertIn("reaction, funeral, condolence, statement or visit", collector.AI_SELECTION_INSTRUCTIONS)

    def test_the_split_window_is_the_collector_merge_window(self):
        self.assertEqual(collector.attack_points.SPLIT_DAYS, collector.INCIDENT_INITIAL_MERGE_DAYS)


if __name__ == "__main__":
    unittest.main()
