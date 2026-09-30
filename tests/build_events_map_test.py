"""Tests for tools/build_events_map.py: the map's attacks-only data file."""
import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

spec = importlib.util.spec_from_file_location('build_events_map', 'tools/build_events_map.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def event(event_id, **fields):
    return {'id': event_id, 'published': '2026-09-29T08:00:00Z', 'title': f'Event {event_id}', **fields}


def sample_database():
    return {
        'last_updated': '2026-09-30T10:00:00Z',
        'trend_summary': {'overview': 'whole-database 24h assessment'},
        'weekly_analysis': {'analysis': 'weekly'},
        'events': [
            event('attack', primary_event_type='ATTACK', is_attack=True, category='Attacks', related_articles=[1]),
            event('attack-not-flagged', primary_event_type='ATTACK', is_attack=False, category='Attacks'),
            event('attempt', primary_event_type='ATTEMPTED_ATTACK', category='Attacks'),
            event('plot', primary_event_type='DISRUPTED_PLOT', category='Counter Terrorism Action'),
            event('arrest', primary_event_type='ARREST', category='Arrests'),
            event('piracy', primary_event_type='PIRACY', category='Maritime Piracy'),
            event('legacy-attack', categories=['Attacks', 'Weapons']),
            event('legacy-arrest', category='Arrests'),
            event('unlocated-attack', primary_event_type='ATTACK', is_attack=True, excluded_from_map=True),
        ],
    }


class MapAttackTests(unittest.TestCase):
    def test_keeps_executed_attempted_and_foiled_attacks_only(self):
        output = m.build_map(sample_database(), ['related_articles'])
        self.assertEqual(
            [e['id'] for e in output['events']],
            ['attack', 'attempt', 'plot', 'legacy-attack'],
        )

    def test_attack_type_without_the_is_attack_flag_is_not_shown(self):
        self.assertFalse(m.is_map_attack({'primary_event_type': 'ATTACK', 'is_attack': False}))
        self.assertFalse(m.is_map_attack({'primary_event_type': 'attack'}))

    def test_legacy_records_fall_back_to_the_attacks_category(self):
        self.assertTrue(m.is_map_attack({'category': 'Attacks'}))
        self.assertFalse(m.is_map_attack({'category': 'Maritime Piracy'}))

    def test_bookkeeping_fields_are_stripped_like_events_lite(self):
        output = m.build_map(sample_database(), ['related_articles'])
        self.assertNotIn('related_articles', output['events'][0])

    def test_top_level_keys_are_kept_for_the_24h_and_weekly_panels(self):
        output = m.build_map(sample_database(), ['related_articles'])
        self.assertEqual(output['trend_summary'], {'overview': 'whole-database 24h assessment'})
        self.assertEqual(output['weekly_analysis'], {'analysis': 'weekly'})

    def test_database_summary_counts_every_visible_category(self):
        summary = m.build_map(sample_database(), [])['database_summary']
        self.assertEqual(summary['total_events'], 8)
        self.assertEqual(summary['by_category']['Arrests'], 2)
        self.assertEqual(summary['by_category']['Maritime Piracy'], 1)

    def test_recent_events_keep_other_categories_of_the_last_days_only(self):
        database = sample_database()
        database['events'].append(event('old-arrest', primary_event_type='ARREST', published='2026-09-20T08:00:00Z'))
        now = datetime(2026, 9, 30, 12, tzinfo=timezone.utc)
        output = m.build_map(database, ['related_articles'], now=now)
        self.assertEqual(
            [e['id'] for e in output['recent_events']],
            ['attack-not-flagged', 'arrest', 'piracy', 'legacy-arrest'],
        )
        self.assertEqual(output['map']['recent_events_days'], m.RECENT_DAYS)

    def test_validate_rejects_an_attack_among_recent_events(self):
        database = sample_database()
        output = m.build_map(database, [])
        output['recent_events'].append(event('attack-copy', primary_event_type='ATTACK', is_attack=True))
        with self.assertRaises(ValueError):
            m.validate(output, database)

    def test_validate_accepts_the_output_and_detects_a_foreign_event(self):
        database = sample_database()
        output = m.build_map(database, [])
        m.validate(output, database)
        output['events'].append(event('intruder', primary_event_type='ARREST'))
        with self.assertRaises(ValueError):
            m.validate(output, database)

    def test_cli_writes_a_compact_file_and_refuses_an_empty_database(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / 'events.json'
            target = Path(tmp) / 'events-map.json'
            source.write_text(json.dumps(sample_database()), encoding='utf-8')
            self.assertEqual(m.main(['--input', str(source), '--output', str(target)]), 0)
            written = json.loads(target.read_text(encoding='utf-8'))
            self.assertEqual(written['map']['format'], 'events-map-v1')
            self.assertEqual(len(written['events']), 4)

            source.write_text(json.dumps({'events': []}), encoding='utf-8')
            self.assertEqual(m.main(['--input', str(source), '--output', str(Path(tmp) / 'other.json')]), 1)


if __name__ == '__main__':
    unittest.main()
