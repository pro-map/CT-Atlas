"""Offline RADNUC scope, multilingual planning and recoverable map integration."""
import copy
import json
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, '.')
sys.path.insert(0, 'tools')
import collector
import radnuc
import archive_review
import enrich_archive
import enrich_radnuc


class RadnucScopeTests(unittest.TestCase):
    def decision(self, title, **updates):
        return {'relevance_score': 95, 'is_current_ct_event': True,
                'categories': ['CBRN'], 'cbrn_subgroups': ['RADNUC'],
                'actor_scope': 'NON_STATE', 'english_title': title,
                'english_summary': 'A concrete reported investigation.',
                'actor_group': 'ISIS', 'original_language': 'en',
                'primary_event_type': 'DISRUPTED_PLOT', 'is_attack': False, **updates}

    def test_high_scoring_state_operation_is_rejected_even_with_incidental_group(self):
        event = {'title': 'Israeli strikes target Iranian nuclear facility',
                 'summary': 'Background mentions ISIS.'}
        self.assertFalse(collector.apply_ai_selection(event, self.decision(event['title'], actor_scope='STATE_ONLY')))
        self.assertFalse(event['ai_selected'])
        self.assertIn('state', event['ai_scope_rejection'])

    def test_legacy_state_strike_is_rejected_without_new_schema_fields(self):
        event = {'title': 'Israeli military bombs Iranian nuclear plant', 'summary': 'ISIS discussed as background'}
        decision = self.decision(event['title'])
        del decision['actor_scope']
        self.assertFalse(collector.apply_ai_selection(event, decision))

    def test_state_investigation_against_a_nonstate_suspect_is_kept(self):
        event = {'title': 'Israeli police arrest ISIS suspect in dirty bomb plot'}
        self.assertTrue(collector.apply_ai_selection(event, self.decision(event['title'])))
        self.assertEqual(event['cbrn_subgroups'], ['RADNUC'])

    def test_translated_state_attack_is_rejected_after_translation(self):
        event = {'title': 'ضربة على منشأة نووية', 'categories': ['CBRN']}
        self.assertFalse(collector.apply_ai_selection(event, self.decision(
            'Iranian military attacks nuclear facility', original_language='ar', actor_scope='STATE_ONLY')))
        self.assertEqual(event['original_title'], 'ضربة على منشأة نووية')

    def test_a_chemical_event_with_incidental_nuclear_mention_is_not_radnuc(self):
        event = {'title': 'Police disrupt chemical plot', 'summary': 'A nearby nuclear plant was unaffected.'}
        self.assertTrue(collector.apply_ai_selection(event, self.decision(event['title'], cbrn_subgroups=[])))
        collector.ensure_event_metadata(event)
        self.assertEqual(event['cbrn_subgroups'], [])

    def test_radnuc_attack_also_keeps_cbrn_parent_category(self):
        event = {'title': 'ISIS dirty bomb plot foiled'}
        self.assertTrue(collector.apply_ai_selection(event, self.decision(event['title'], categories=['Attacks'])))
        self.assertIn('CBRN', event['categories'])

    def test_material_words_alone_do_not_assign_a_non_cbrn_event(self):
        event = {'title': 'Nuclear medicine expands radiopharmaceutical supply', 'categories': ['Weapons']}
        radnuc.annotate(event)
        self.assertNotIn('cbrn_subgroups', event)


class RadnucPlanTests(unittest.TestCase):
    def setUp(self):
        self.today = date(2026, 10, 7)
        self.plan = enrich_radnuc.plan_tasks(self.today, collector)

    def test_all_existing_and_enrichment_languages_are_covered(self):
        expected = {p['code'] for p in collector.MULTILINGUAL_PROFILES + enrich_archive.NEW_LANGUAGE_PROFILES}
        codes = {t['code'] for t in self.plan if t['source'] == 'google'}
        self.assertTrue(expected <= codes)
        self.assertEqual(codes, set(radnuc.LEXICONS))
        self.assertTrue(all(t['locale'] == 'all' for t in self.plan if t['source'] == 'gdelt'))

    def test_windows_cover_180_days_without_a_gap_and_include_recent_reporting(self):
        windows = sorted({enrich_archive.window(t) for t in self.plan})
        self.assertEqual(windows[0][0], self.today - timedelta(days=180))
        self.assertEqual(windows[-1][1], self.today + timedelta(days=1))
        self.assertTrue(all(left[1] == right[0] for left, right in zip(windows, windows[1:])))
        self.assertEqual(len(self.plan), len({t['key'] for t in self.plan}))

    def test_all_supplied_keywords_have_security_qualified_searches(self):
        joined = ' '.join(radnuc.ENGLISH_QUERIES).lower()
        for keyword in radnuc.KEYWORDS:
            self.assertIn(keyword.lower(), joined)
        for query in radnuc.ENGLISH_QUERIES:
            self.assertTrue(any(term in query for term in ('terror', 'smuggling', 'cyberattack')))

    def test_native_searches_reach_every_daily_profile(self):
        for profile in collector.MULTILINGUAL_PROFILES:
            self.assertTrue(set(radnuc.queries(profile['code'])) <= {
                q['term'] for q in profile['queries'] if q.get('category') == 'CBRN'})


class RadnucIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.now = datetime.now(timezone.utc)
        archive_review.write_json(self.root / 'events.json', {'events': [
            {'id': 'existing', 'title': 'Unrelated existing arrest', 'summary': 'Police arrested an extremist',
             'published': self.now.isoformat(), 'category': 'Arrests', 'categories': ['Arrests'],
             'latitude': 12, 'longitude': 13}]})

    def tearDown(self):
        self.temp.cleanup()

    def event(self, identifier='new', source='Outlet'):
        return {'id': identifier, 'title': 'Police arrest ISIS cell in Paris dirty bomb plot',
                'summary': 'Police arrested three ISIS members in Paris after disrupting a dirty bomb plot.',
                'published': self.now.isoformat(), 'category': 'CBRN', 'categories': ['CBRN'],
                'source': source, 'url': f'https://news.test/{identifier}',
                'country': 'France', 'country_code': 'FR', 'city': 'Paris',
                'actor_group': 'ISIS', 'cbrn_subgroups': ['RADNUC'], 'actor_scope': 'NON_STATE',
                'primary_event_type': 'DISRUPTED_PLOT', 'ai_selected': True, 'ai_current_ct_event': True}

    def test_selected_reports_integrate_and_recovery_does_not_duplicate_them(self):
        output = enrich_radnuc.IntegratedOutput(self.root, self.now, collector)
        output.add([{'title': 'article', 'selected_event': self.event()}])
        output.save()
        database = archive_review.read_json(self.root / 'events.json')
        self.assertEqual(len(database['events']), 2)
        self.assertEqual(next(e for e in database['events'] if e['id'] == 'existing')['latitude'], 12)
        recovered = enrich_radnuc.IntegratedOutput(self.root, self.now, collector)
        recovered.save()
        self.assertEqual(len(archive_review.read_json(self.root / 'events.json')['events']), 2)

    def test_english_normalized_reports_from_two_languages_merge(self):
        output = enrich_radnuc.IntegratedOutput(self.root, self.now, collector)
        a, b = self.event('fr-report', 'French outlet'), self.event('ar-report', 'Arabic outlet')
        a['original_language'], b['original_language'] = 'fr', 'ar'
        a['original_title'], b['original_title'] = 'Complot déjoué', 'إحباط مخطط'
        output.add([{'selected_event': a}, {'selected_event': b}])
        output.save()
        events = archive_review.read_json(self.root / 'events.json')['events']
        self.assertEqual(len(events), 2)
        rad = next(e for e in events if 'RADNUC' in e.get('cbrn_subgroups', []))
        self.assertEqual(set(rad['sources']), {'French outlet', 'Arabic outlet'})
        self.assertEqual(rad['cbrn_subgroups'], ['RADNUC'])

    def test_state_operations_and_rejected_reports_never_enter_database(self):
        output = enrich_radnuc.IntegratedOutput(self.root, self.now, collector)
        state, rejected = self.event('state'), self.event('irrelevant')
        state['actor_scope'] = 'STATE_ONLY'
        rejected['ai_selected'] = False
        output.add([{'selected_event': state}, {'selected_event': rejected}])
        output.save()
        self.assertEqual(len(archive_review.read_json(self.root / 'events.json')['events']), 1)

    def test_enrichment_run_wires_translation_integration_and_separate_resume_state(self):
        import shutil
        shutil.copy('collector.py', self.root / 'collector.py')
        shutil.copy('radnuc.py', self.root / 'radnuc.py')
        archive_review.write_json(self.root / 'ct-atlas-runtime.json', {'ai_selection_threshold': 60})
        original_state = {'version': 2, 'done': {'ordinary-archive-task': 'kept'}}
        archive_review.write_json(self.root / enrich_archive.STATE_FILE, original_state)
        event = self.event('new-article')
        event['original_title'] = 'Article en français'
        class Searcher:
            fetches = 0
            def available(self, source): return True
            def search(inner, task):
                inner.fetches += 1
                return [copy.deepcopy(event)], False
        class Gate:
            posts = 0
            remaining = 1
            def __enter__(inner): return inner
            def __exit__(inner, *args): return False
        def answer(payload):
            return [{'event_id': item['event_id'], 'relevance_score': 90,
                     'is_current_ct_event': True, 'categories': ['CBRN'],
                     'cbrn_subgroups': ['RADNUC'], 'actor_scope': 'NON_STATE',
                     'english_title': event['title'], 'english_summary': event['summary'],
                     'original_language': 'fr', 'actor_group': 'ISIS'} for item in payload]
        status = enrich_radnuc.run(self.root, max_posts=1, max_fetches=1,
            searcher=Searcher(), gate_factory=lambda posts: Gate(), call_batch=answer,
            log=lambda *args: None)
        self.assertEqual(status['last_run']['reviewed'], 1)
        self.assertEqual(len(archive_review.read_json(self.root / 'events.json')['events']), 2)
        self.assertGreater(status['pending_searches'], 0)
        self.assertFalse(status['complete'])
        self.assertEqual(archive_review.read_json(self.root / enrich_archive.STATE_FILE), original_state)
        self.assertTrue((self.root / enrich_radnuc.STATE_FILE).exists())

    def test_legacy_retained_cbrn_record_gets_subgroup_without_losing_coordinates(self):
        old = self.event('old')
        del old['cbrn_subgroups']
        old['latitude'], old['longitude'] = 48.85, 2.35
        archive_review.write_json(self.root / 'events.json', {'events': [old]})
        output = enrich_radnuc.IntegratedOutput(self.root, self.now, collector)
        output.save()
        retained = archive_review.read_json(self.root / 'events.json')['events'][0]
        self.assertEqual(retained['cbrn_subgroups'], ['RADNUC'])
        self.assertEqual(retained['latitude'], 48.85)


if __name__ == '__main__':
    unittest.main()
