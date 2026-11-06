"""Tests for tools/build_events_map.py: the map's attacks-only data file."""
import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
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
            ['attack', 'attempt', 'plot', 'legacy-attack', 'unlocated-attack'],
        )

    def test_unlocated_attacks_stay_for_the_ticker_and_the_header_counts(self):
        output = m.build_map(sample_database(), [])
        unlocated = [e for e in output['events'] if e['id'] == 'unlocated-attack']
        self.assertEqual(len(unlocated), 1)
        self.assertIs(unlocated[0]['excluded_from_map'], True)
        self.assertNotIn('unlocated-attack', [e['id'] for e in output['recent_events']])

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
        database['events'].append(event('old-arrest', primary_event_type='ARREST', published='2026-03-20T08:00:00Z'))
        database['events'].append(event('arrest20', primary_event_type='ARREST', published='2026-09-10T08:00:00Z'))
        now = datetime(2026, 9, 30, 12, tzinfo=timezone.utc)
        output = m.build_map(database, ['related_articles'], now=now)
        self.assertEqual(
            [e['id'] for e in output['recent_events']],
            ['attack-not-flagged', 'arrest', 'piracy', 'legacy-arrest', 'arrest20'],
        )
        self.assertEqual(output['map']['recent_events_days'], m.RECENT_DAYS)

    def test_six_month_context_keeps_every_category_and_radnuc_metadata(self):
        database = sample_database()
        for ident, kind, category, published in (
            ('radnuc60', 'CBRN', 'CBRN', '2026-08-01T08:00:00Z'),
            ('arrest89', 'ARREST', 'Arrests', '2026-07-03T08:00:00Z'),
            ('too-old', 'CBRN', 'CBRN', '2026-03-01T08:00:00Z'),
        ):
            database['events'].append(event(ident, primary_event_type=kind, category=category,
                published=published, cbrn_subgroups=['RADNUC']))
        output = m.build_map(database, [], now=datetime(2026, 9, 30, 12, tzinfo=timezone.utc))
        ids = [e['id'] for e in output['recent_events']]
        self.assertIn('radnuc60', ids)
        self.assertIn('arrest89', ids)
        self.assertNotIn('too-old', ids)
        self.assertEqual(next(e for e in output['recent_events'] if e['id'] == 'radnuc60')['cbrn_subgroups'], ['RADNUC'])
        m.validate(output, database)

    def test_older_events_cited_by_key_developments_are_kept(self):
        database = sample_database()
        database['trend_summary'] = {'developments': [{'event_id': 'old-arrest'}, {'event_id': 'attack'}, {'title': 'no id'}]}
        database['events'].append(event('old-arrest', primary_event_type='ARREST', published='2026-03-20T08:00:00Z'))
        database['events'].append(event('old-piracy', primary_event_type='PIRACY', published='2026-03-20T08:00:00Z'))
        now = datetime(2026, 9, 30, 12, tzinfo=timezone.utc)
        output = m.build_map(database, [], now=now)
        recent_ids = [e['id'] for e in output['recent_events']]
        self.assertIn('old-arrest', recent_ids)
        self.assertNotIn('old-piracy', recent_ids)
        # An attack stays in events only, never duplicated into recent_events.
        self.assertNotIn('attack', recent_ids)
        m.validate(output, database)

    def test_six_month_payload_includes_all_categories_and_event_types(self):
        now = datetime(2026, 10, 8, 12, tzinfo=timezone.utc)
        topics = [
            ('ATTACK', 'Attacks'), ('ATTEMPTED_ATTACK', 'Attacks'),
            ('DISRUPTED_PLOT', 'Counter Terrorism Action'),
            ('CT_OPERATION', 'Counter Terrorism Action'), ('ARREST', 'Arrests'),
            ('FINANCING', 'Terrorist Financing'),
            ('WEAPONS', 'Weapons'), ('PIRACY', 'Maritime Piracy'),
            ('ONLINE_CYBER_AI', 'Online / Cyber / AI'), ('CBRN', 'CBRN'),
            ('OTHER_CT', 'Radiological/Nuclear'),
            ('OTHER_CT', 'Chemicals and Explosives'),
            ('OTHER_CT', 'Biological Terrorism'),
        ]
        records = [event(str(i), primary_event_type=kind, category=category,
                         is_attack=kind == 'ATTACK',
                         published=(now - timedelta(days=179)).isoformat())
                   for i, (kind, category) in enumerate(topics)]
        records += [event('boundary', primary_event_type='ARREST', category='Arrests',
                          published=(now - timedelta(days=180)).isoformat()),
                    event('expired', primary_event_type='ARREST', category='Arrests',
                          published=(now - timedelta(days=182)).isoformat())]
        db = {'events': records}
        output = m.build_map(db, [], now=now)
        ids = [e['id'] for e in output['events'] + output['recent_events']]
        self.assertEqual(set(ids), {str(i) for i in range(len(topics))} | {'boundary'})
        self.assertEqual(len(ids), len(set(ids)), 'No attack duplicated as context')
        self.assertEqual(output['map']['recent_events_days'], 181)
        m.validate(output, db)

    def test_retired_judicial_records_are_filtered_under_all_topics(self):
        database = sample_database()
        database['events'] += [
            event('court-radnuc', primary_event_type='JUDICIAL', category='Radiological/Nuclear'),
            event('court-bio', primary_event_type='JUDICIAL', category='Biological Terrorism'),
            event('legacy-court', primary_event_type='OTHER_CT', category='Legal / Judicial'),
            event('actual-arrest', primary_event_type='ARREST', categories=['Arrests', 'Legal / Judicial']),
        ]
        output = m.build_map(database, [], now=datetime(2026, 9, 30, 12, tzinfo=timezone.utc))
        all_records = output['events'] + output['recent_events']
        ids = {record['id'] for record in all_records}
        self.assertFalse(ids & {'court-radnuc', 'court-bio', 'legacy-court'})
        self.assertIn('actual-arrest', ids)
        self.assertEqual(next(record for record in all_records if record['id'] == 'actual-arrest')['categories'], ['Arrests'])
        self.assertEqual(output['map']['retired_judicial_count'], 3)
        self.assertNotIn('Legal / Judicial', output['database_summary']['by_category'])
        self.assertEqual(output['database_summary']['total_events'], 9)
        m.validate(output, database)

    def test_validator_rejects_judicial_context_injected_after_build(self):
        database = sample_database()
        output = m.build_map(database, [])
        output['recent_events'].append(event('court', primary_event_type='JUDICIAL', category='Radiological/Nuclear'))
        with self.assertRaises(ValueError):
            m.validate(output, database)

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
            self.assertEqual(len(written['events']), 5)

            source.write_text(json.dumps({'events': []}), encoding='utf-8')
            self.assertEqual(m.main(['--input', str(source), '--output', str(Path(tmp) / 'other.json')]), 1)


PARIS = {'latitude': 48.85, 'longitude': 2.35, 'location_precision': 'city'}
LYON = {'latitude': 45.76, 'longitude': 4.84, 'location_precision': 'city'}
UNLOCATED = {'latitude': None, 'longitude': None, 'location_precision': 'unlocated', 'excluded_from_map': True}


def attack(event_id, published='2026-09-29T08:00:00Z', incident='inc-1', update='INITIAL', place=PARIS, **fields):
    return event(event_id, primary_event_type='ATTACK', is_attack=True, category='Attacks', published=published,
                 incident_id=incident, update_type=update, **place, **fields)


class AttackPointTests(unittest.TestCase):
    now = datetime(2026, 10, 3, 12, tzinfo=timezone.utc)

    def build(self, *records):
        database = {'events': list(records)}
        output = m.build_map(database, [], now=self.now)
        m.validate(output, database)
        return output

    def points(self, *records):
        return [e['id'] for e in self.build(*records)['events']]

    def test_an_initial_with_its_follow_ups_is_one_point_even_when_they_came_first(self):
        self.assertEqual(self.points(
            attack('early-report', '2026-09-28T08:00:00Z', update='FOLLOW_UP'),
            attack('initial', '2026-09-29T08:00:00Z'),
            attack('reaction', '2026-09-30T08:00:00Z', update='OTHER_UPDATE'),
        ), ['initial'])

    def test_a_blank_update_type_counts_as_initial(self):
        self.assertEqual(self.points(
            attack('follow-up', '2026-09-28T08:00:00Z', update='FOLLOW_UP'),
            attack('legacy', '2026-09-29T08:00:00Z', update=''),
        ), ['legacy'])

    def test_an_incident_with_no_initial_keeps_its_earliest_record(self):
        self.assertEqual(self.points(
            attack('later', '2026-09-30T08:00:00Z', update='FOLLOW_UP'),
            attack('earliest', '2026-09-29T08:00:00Z', update='INVESTIGATION_UPDATE'),
        ), ['earliest'])

    def test_close_initials_are_one_point_and_far_apart_ones_are_two(self):
        self.assertEqual(self.points(
            attack('first', '2026-09-20T08:00:00Z'),
            attack('same-city-later', '2026-09-28T08:00:00Z'),
            attack('elsewhere-same-week', '2026-09-22T08:00:00Z', place=LYON),
        ), ['first'])
        self.assertEqual(self.points(
            attack('first', '2026-09-20T08:00:00Z'),
            attack('elsewhere-later', '2026-09-24T08:00:00Z', place=LYON),
        ), ['first', 'elsewhere-later'])

    def test_a_later_initial_must_be_far_from_every_point(self):
        self.assertEqual(self.points(
            attack('paris', '2026-09-20T08:00:00Z'),
            attack('lyon', '2026-09-24T08:00:00Z', place=LYON),
            attack('lyon-again', '2026-09-28T08:00:00Z', place=LYON),
        ), ['paris', 'lyon'])

    def test_an_unlocated_initial_cannot_split(self):
        self.assertEqual(self.points(
            attack('first', '2026-09-20T08:00:00Z'),
            attack('nowhere', '2026-09-28T08:00:00Z', place=UNLOCATED),
        ), ['first'])

    def test_a_follow_up_of_an_attack_of_an_earlier_year_gets_no_point(self):
        output = self.build(
            attack('coverage', '2026-09-29T08:00:00Z', incident='inc-old', update='FOLLOW_UP',
                   incident_anchor='Ataturk Airport attack 2016-06-28'),
            attack('this-year', '2026-09-29T08:00:00Z', incident='inc-new', update='FOLLOW_UP',
                   incident_anchor='Attack in Lyon 2026-09-20'),
        )
        self.assertEqual([e['id'] for e in output['events']], ['this-year'])
        self.assertEqual([e['id'] for e in output['recent_events']], ['coverage'])

    def test_an_old_year_never_removes_an_initial_or_the_incident_it_opened(self):
        self.assertEqual(self.points(
            attack('anniversary-labelled-initial', incident_anchor='Attack on 2016-06-28'),
        ), ['anniversary-labelled-initial'])
        self.assertEqual(self.points(
            attack('history', '2026-09-28T08:00:00Z', update='FOLLOW_UP', incident_anchor='Attack 2016'),
            attack('current', '2026-09-29T08:00:00Z', update='FOLLOW_UP', incident_anchor='Attack 2026'),
        ), ['current'])

    def test_an_unlocated_point_gives_way_to_a_located_record_initials_first(self):
        self.assertEqual(self.points(
            attack('no-place', '2026-09-28T08:00:00Z', place=UNLOCATED),
            attack('located-update', '2026-09-29T08:00:00Z', update='FOLLOW_UP'),
            attack('located-initial', '2026-09-30T08:00:00Z'),
        ), ['located-initial'])
        self.assertEqual(self.points(
            attack('no-place', '2026-09-28T08:00:00Z', place=UNLOCATED),
            attack('located-update', '2026-09-29T08:00:00Z', update='FOLLOW_UP'),
        ), ['located-update'])
        self.assertEqual(self.points(attack('no-place', place=UNLOCATED)), ['no-place'],
                         'An incident nobody could place still reaches the ticker and the header')

    def test_a_historic_record_never_takes_over_an_unlocated_point(self):
        self.assertEqual(self.points(
            attack('no-place', '2026-09-28T08:00:00Z', place=UNLOCATED),
            attack('history', '2026-09-29T08:00:00Z', update='FOLLOW_UP', incident_anchor='Attack 2016'),
        ), ['no-place'])

    def test_one_incident_groups_executed_attempted_and_foiled_records(self):
        self.assertEqual(self.points(
            attack('attack'),
            event('attempt', primary_event_type='ATTEMPTED_ATTACK', incident_id='inc-1', update_type='FOLLOW_UP'),
            event('plot', primary_event_type='DISRUPTED_PLOT', incident_id='inc-1', update_type='FOLLOW_UP'),
        ), ['attack'])

    def test_records_without_an_incident_id_each_stay_a_point(self):
        self.assertEqual(self.points(attack('a', incident=''), attack('b', incident='', update='FOLLOW_UP')), ['a', 'b'])

    def test_flags_follow_list_positions_because_event_ids_repeat(self):
        records = [attack('dup', '2026-09-29T08:00:00Z', incident='inc-1'),
                   attack('dup', '2026-09-30T08:00:00Z', incident='inc-1', update='FOLLOW_UP'),
                   attack('dup', '2026-09-30T08:00:00Z', incident='inc-2')]
        self.assertEqual(m.attack_update_indexes(records), {1})

    def test_only_attack_records_are_flagged(self):
        database = {'events': [attack('attack'),
                               event('arrest', primary_event_type='ARREST', incident_id='inc-1', update_type='ARREST_UPDATE'),
                               event('claim', primary_event_type='ATTACK', is_attack=False, incident_id='inc-1')]}
        output = m.build_map(database, [], now=self.now)
        self.assertEqual([e['id'] for e in output['events']], ['attack'])
        self.assertEqual([e['id'] for e in output['recent_events']], ['arrest', 'claim'])
        self.assertFalse(any('attack_update' in e for e in output['events'] + output['recent_events']))

    def test_follow_ups_move_to_recent_events_with_the_flag_and_the_source_is_untouched(self):
        database = {'events': [attack('initial'), attack('follow-up', '2026-09-30T08:00:00Z', update='FOLLOW_UP',
                                                         related_articles=[1])]}
        output = m.build_map(database, ['related_articles'], now=self.now)
        self.assertEqual([e['id'] for e in output['events']], ['initial'])
        self.assertNotIn('attack_update', output['events'][0])
        moved = output['recent_events'][0]
        self.assertEqual(moved['id'], 'follow-up')
        self.assertIs(moved['attack_update'], True)
        self.assertNotIn('related_articles', moved)
        self.assertFalse(any('attack_update' in record for record in database['events']))
        self.assertFalse(m.is_map_attack(moved))
        m.validate(output, database)

    def test_an_old_attack_with_a_new_follow_up_stays_out_of_the_short_window(self):
        output = self.build(
            attack('old-initial', '2026-09-01T08:00:00Z'),
            attack('fresh-follow-up', '2026-10-03T08:00:00Z', update='FOLLOW_UP'),
        )
        point = output['events'][0]
        self.assertEqual((point['id'], point['published']), ('old-initial', '2026-09-01T08:00:00Z'))
        self.assertEqual([e['id'] for e in output['recent_events']], ['fresh-follow-up'])

    def test_old_follow_ups_leave_recent_events_unless_a_key_development_cites_them(self):
        records = [attack('initial', '2026-03-01T08:00:00Z'),
                   attack('old-update', '2026-03-02T08:00:00Z', update='FOLLOW_UP'),
                   attack('cited-update', '2026-03-03T08:00:00Z', update='FOLLOW_UP')]
        database = {'trend_summary': {'developments': [{'event_id': 'cited-update'}]}, 'events': records}
        output = m.build_map(database, [], now=self.now)
        self.assertEqual([e['id'] for e in output['recent_events']], ['cited-update'])
        m.validate(output, database)

    def test_retired_records_neither_group_nor_shift_the_flags(self):
        court = event('court', primary_event_type='JUDICIAL', incident_id='inc-1', update_type='INITIAL')
        output = self.build(court, attack('follow-up', update='FOLLOW_UP'),
                            attack('second', '2026-09-30T08:00:00Z', update='FOLLOW_UP'))
        self.assertEqual([e['id'] for e in output['events']], ['follow-up'])
        self.assertEqual([e['id'] for e in output['recent_events']], ['second'])

    def test_database_totals_stay_record_based(self):
        database = {'events': [attack('initial'), attack('follow-up', update='FOLLOW_UP')]}
        output = m.build_map(database, [], now=self.now)
        self.assertEqual(output['database_summary'], {'total_events': 2, 'by_category': {'Attacks': 2}})
        self.assertEqual(output['map']['source_event_count'], 2)

    def test_a_stale_stored_flag_is_ignored(self):
        output = self.build(attack('point', attack_update=True))
        self.assertEqual([e['id'] for e in output['events']], ['point'])
        self.assertNotIn('attack_update', output['events'][0])

    def test_validate_rejects_a_follow_up_among_the_points(self):
        database = {'events': [attack('initial'), attack('follow-up', update='FOLLOW_UP')]}
        output = m.build_map(database, [], now=self.now)
        output['events'], output['recent_events'] = output['recent_events'], output['events']
        with self.assertRaisesRegex(ValueError, 'follow-up'):
            m.validate(output, database)

    def test_validate_counts_points_not_attack_records(self):
        database = {'events': [attack('initial'), attack('follow-up', update='FOLLOW_UP')]}
        output = m.build_map(database, [], now=self.now)
        output['events'].append(attack('extra-point', incident='inc-1'))
        with self.assertRaisesRegex(ValueError, 'attack points'):
            m.validate(output, database)

    def test_validate_rejects_an_incident_that_lost_its_point(self):
        database = {'events': [attack('a', incident='inc-a'), attack('b', incident='inc-b')]}
        output = m.build_map(database, [], now=self.now)
        output['events'][1] = dict(output['events'][0])
        with self.assertRaisesRegex(ValueError, 'inc-b'):
            m.validate(output, database)

    def test_an_incident_of_historic_records_only_may_have_no_point(self):
        output = self.build(attack('history', update='FOLLOW_UP', incident_anchor='Attack 2016'), attack('other', incident='inc-2'))
        self.assertEqual([e['id'] for e in output['events']], ['other'])


def report(event_id, source, published='2026-10-15T09:17:00+00:00', incident=None, **fields):
    return attack(event_id, published, incident or 'inc-' + event_id, source=source, sources=[source], **fields)


class HeldReportTests(unittest.TestCase):
    """Re-dated archive articles (audit of 2026-11-05). Held records stay in the
    database; they leave the map and every count until a second outlet reports them."""
    now = datetime(2026, 10, 20, 12, tzinfo=timezone.utc)

    def build(self, *records):
        database = {'events': list(records)}
        output = m.build_map(database, [], now=self.now)
        m.validate(output, database)
        return output

    def test_a_sole_source_report_of_a_listed_outlet_is_no_point_and_is_not_counted(self):
        rawda = report('rawda', 'Orange Actualités', title='Au moins 235 morts dans un attentat en Égypte')
        output = self.build(report('other', 'Reuters'), rawda)
        self.assertEqual([e['id'] for e in output['events']], ['other'])
        self.assertEqual(output['recent_events'], [], 'The header counts read recent_events')
        self.assertEqual(output['database_summary']['total_events'], 2)
        self.assertEqual(m.held_indexes([rawda]), {0})
        self.assertNotIn('held_for_corroboration', rawda)

    def test_a_second_outlet_in_the_record_or_the_incident_releases_it(self):
        merged = attack('h7', '2026-10-15T09:17:00+00:00', source='Haber 7', sources=['Haber 7', 'TRT Haber'])
        self.assertEqual([e['id'] for e in self.build(merged)['events']], ['h7'])
        self.assertEqual([e['id'] for e in self.build(
            report('h7', 'Haber 7', incident='inc-1'),
            report('trt', 'TRT Haber', incident='inc-1', update='FOLLOW_UP'))['events']], ['h7'])

    def test_another_record_of_the_same_outlet_is_no_corroboration(self):
        output = self.build(report('first', 'Haber 7', incident='inc-1'),
                            report('second', 'Haber 7', incident='inc-1', update='FOLLOW_UP'),
                            report('unrelated', 'Reuters'))
        self.assertEqual([e['id'] for e in output['events']], ['unrelated'])

    def burst(self, source='verify-sy.com', stamp='2026-10-01T09:30:00+00:00', count=4):
        return [report(f'{source}-{n}', source, stamp, title=f'Headline {n}') for n in range(count)]

    def test_four_items_of_one_outlet_in_one_minute_are_a_re_index(self):
        output = self.build(*self.burst(), report('elsewhere', 'Reuters', '2026-10-01T09:31:00+00:00'))
        self.assertEqual([e['id'] for e in output['events']], ['elsewhere'])

    def test_three_items_are_not_and_a_query_repeating_one_article_is_not_a_second_item(self):
        self.assertEqual(len(self.build(*self.burst(count=3))['events']), 3)
        same = [report(f'copy-{n}', 'verify-sy.com', '2026-10-01T09:30:00+00:00', title='One headline') for n in range(6)]
        self.assertEqual(len(self.build(*same)['events']), 6)

    def test_folded_articles_count_towards_a_burst(self):
        records = self.burst(count=2)
        records[0]['related_articles'] = [
            {'title': f'Folded {n}', 'source': 'verify-sy.com', 'published': '2026-10-01T09:30:00+00:00'} for n in range(2)]
        self.assertEqual(self.build(*records)['events'], [])

    def test_a_stamp_on_the_hour_is_a_date_only_feed_not_a_burst(self):
        self.assertEqual(len(self.build(*self.burst('Daily Trust', '2026-09-04T07:00:00+00:00', 7))['events']), 7)

    def test_gdelt_crawl_times_are_not_an_outlets_stamp(self):
        records = self.burst('dw.com')
        for record in records:
            record['collector'] = 'GDELT DOC 2.0'
        self.assertEqual(len(self.build(*records)['events']), 4)

    def test_the_mark_set_at_ingest_holds_a_record_until_a_second_outlet_comes(self):
        marked = report('marked', 'Le Monde.fr', corroboration_hold='same_minute_burst')
        self.assertEqual(self.build(marked, report('other', 'Reuters'))['events'][0]['id'], 'other')
        marked['sources'] = ['Le Monde.fr', 'AFP']
        self.assertEqual(self.build(marked)['events'][0]['id'], 'marked')

    def test_held_records_of_other_types_leave_the_counts_too(self):
        afrin = dict(report('afrin', 'Haber 7'), primary_event_type='CT_OPERATION')
        database = {'events': [afrin, report('other', 'Reuters')]}
        self.assertNotIn('afrin', [e['id'] for e in m.build_map(database, [], now=self.now)['recent_events']])
        self.assertEqual(m.attack_update_indexes(database['events']), {0}, 'The Worker and the weekly counts skip it')

    def test_a_key_development_citing_a_held_record_keeps_its_link(self):
        database = {'trend_summary': {'developments': [{'event_id': 'cited'}]},
                    'events': [report('cited', 'Haber 7'), report('other', 'Reuters')]}
        output = m.build_map(database, [], now=self.now)
        kept = output['recent_events'][0]
        self.assertEqual(kept['id'], 'cited')
        self.assertIs(kept['held_for_corroboration'], True)
        self.assertFalse(m.is_map_attack(kept))
        m.validate(output, database)


class HoaxTests(unittest.TestCase):
    now = datetime(2026, 10, 20, 12, tzinfo=timezone.utc)

    def test_a_hoax_is_no_attack_whatever_its_type(self):
        for fields in ({'primary_event_type': 'ATTACK', 'is_attack': True}, {'primary_event_type': 'DISRUPTED_PLOT'},
                       {'primary_event_type': 'ATTEMPTED_ATTACK'}, {'categories': ['Attacks']}):
            self.assertFalse(m.is_attack_record({**fields, 'reported_status': 'HOAX'}), fields)
            self.assertFalse(m.is_attack_record({**fields, 'reported_status': ' hoax '}), fields)
            self.assertTrue(m.is_attack_record({**fields, 'reported_status': 'THREAT'}), fields)

    def test_the_school_hoaxes_leave_the_map_and_the_counts_of_the_worker(self):
        hoax = attack('hoax', '2026-10-10T08:00:00Z', title='Schools in the UK, Hungary, and Serbia receive bomb threat hoaxes',
                      reported_status='HOAX')
        database = {'events': [hoax, attack('real', '2026-10-10T08:00:00Z', 'inc-2')]}
        output = m.build_map(database, [], now=self.now)
        m.validate(output, database)
        self.assertEqual([e['id'] for e in output['events']], ['real'])
        self.assertEqual([e['id'] for e in output['recent_events']], ['hoax'])
        self.assertIs(output['recent_events'][0]['attack_update'], True)

    def test_a_hoax_arrest_is_not_flagged_as_an_attack(self):
        self.assertEqual(m.attack_update_indexes([{'primary_event_type': 'ARREST', 'reported_status': 'HOAX'}]), set())


if __name__ == '__main__':
    unittest.main()

