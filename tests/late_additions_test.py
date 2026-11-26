"""An incident that reaches CT Atlas after its article is a day old still shows in the
periods of the day it arrived (owner's request of 2026-11-26).

From 12 to 26 Nov 2026, 141 of the 607 attacks added to the map (23%) arrived with an
article already more than 24 hours old, so the "last 24 hours" view, keyed on the
article date alone, never showed them. The collector now records when each new
cluster reaches the database (added_at), and the map, the Database panel and the
24-hour brief count an event in a period by its article OR by that date.
"""
import contextlib
import io
import json
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import collector

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import build_events_lite  # noqa: E402


def article(title, published='2026-11-24T08:00:00+00:00', **fields):
    return {'title': title, 'original_title': title, 'summary': '', 'url': 'https://example.test/' + str(abs(hash(title))),
            'source': 'Outlet', 'published': published, 'category': 'Attacks', 'categories': ['Attacks'], **fields}


def merge(existing, fresh, **kwargs):
    with contextlib.redirect_stdout(io.StringIO()):
        return collector.deduplicate_incremental(existing, fresh, **kwargs)


class AddedAtTests(unittest.TestCase):
    def test_a_new_cluster_records_when_it_reached_the_database(self):
        when = datetime(2026, 11, 26, 5, 31, 12, 987000, tzinfo=timezone.utc)
        existing = article('Arrest following knife attack at Hamburg Central Station', country_code='DE')
        fresh = article('Arrest following axe attack in Hattingen')
        events = merge([existing], [fresh], added_at=when)
        self.assertEqual(len(events), 2)
        self.assertEqual(events[1]['added_at'], '2026-11-26T05:31:12+00:00')
        # The article date is untouched: it still says when the source reported it.
        self.assertEqual(events[1]['published'], '2026-11-24T08:00:00+00:00')

    def test_records_already_in_the_database_get_no_date(self):
        # Older records follow their article only; stamping them now would put the
        # whole database in today's 24 hours.
        existing = article('Arrest following knife attack at Hamburg Central Station', country_code='DE')
        events = merge([existing], [article('Arrest following axe attack in Hattingen')])
        self.assertNotIn('added_at', events[0])

    def test_a_report_merged_into_an_existing_incident_adds_no_date(self):
        existing = article('Attack in Silvan', url='https://example.test/silvan')
        repeat = article('Attack in Silvan', url='https://example.test/silvan', published='2026-11-25T09:00:00+00:00')
        events = merge([existing], [repeat])
        self.assertEqual(len(events), 1)
        self.assertNotIn('added_at', events[0])

    def test_without_a_given_time_the_merge_uses_the_current_utc_time(self):
        before = datetime.now(timezone.utc).replace(microsecond=0)
        existing = article('Arrest following knife attack at Hamburg Central Station', country_code='DE')
        events = merge([existing], [article('Arrest following axe attack in Hattingen')])
        stamp = datetime.fromisoformat(events[1]['added_at'])
        self.assertEqual(stamp.utcoffset(), timedelta(0))
        self.assertLessEqual(before, stamp)
        self.assertLessEqual(stamp, datetime.now(timezone.utc))

    def test_main_merges_through_the_stamping_function(self):
        source = (ROOT / 'collector.py').read_text(encoding='utf-8')
        self.assertIn('events = deduplicate_incremental(existing, selected_fresh)', source)
        self.assertEqual(source.count('deduplicate_incremental('), 2, 'one definition, one caller')


class BriefTests(unittest.TestCase):
    def test_the_24_hour_brief_counts_a_late_arrival_on_the_day_it_arrived(self):
        event = {'published': '2026-11-24T08:00:00+00:00', 'last_reported': '2026-11-24T10:00:00+00:00',
                 'added_at': '2026-11-26T05:31:12+00:00'}
        self.assertEqual(collector._trend_recency(event), datetime(2026, 11, 26, 5, 31, 12, tzinfo=timezone.utc))

    def test_a_later_report_still_wins_over_an_earlier_arrival(self):
        event = {'published': '2026-11-20T08:00:00+00:00', 'last_reported': '2026-11-26T09:00:00+00:00',
                 'added_at': '2026-11-21T05:31:12+00:00'}
        self.assertEqual(collector._trend_recency(event), datetime(2026, 11, 26, 9, tzinfo=timezone.utc))

    def test_records_without_the_date_keep_the_old_rule(self):
        self.assertEqual(collector._trend_recency({'published': '2026-11-24T08:00:00Z'}),
                         datetime(2026, 11, 24, 8, tzinfo=timezone.utc))
        self.assertEqual(collector._trend_recency({'added_at': '2026-11-24T08:00:00+00:00'}),
                         datetime(2026, 11, 24, 8, tzinfo=timezone.utc))
        self.assertIsNone(collector._trend_recency({}))


class PublishedFilesTests(unittest.TestCase):
    def test_the_lite_and_map_files_keep_the_date(self):
        # The map and the Database panel read events-map.json and events-lite.json.
        self.assertNotIn('added_at', build_events_lite.load_excluded())
        self.assertNotIn('added_at', build_events_lite.DERIVED_FIELDS)
        database = {'last_updated': '2026-11-26T06:33:40+00:00', 'events': [
            article('Attack in Silvan', id='a1', added_at='2026-11-26T05:31:12+00:00')]}
        lite = build_events_lite.build_lite(database, build_events_lite.load_excluded())
        self.assertEqual(lite['events'][0]['added_at'], '2026-11-26T05:31:12+00:00')


if __name__ == '__main__':
    unittest.main()
