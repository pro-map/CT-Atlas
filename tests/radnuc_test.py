"""Offline RADNUC scope and daily search coverage."""
import sys
import unittest

sys.path.insert(0, '.')
sys.path.insert(0, 'tools')
import collector
import radnuc


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

    def test_radnuc_attack_also_keeps_standalone_radiological_category(self):
        event = {'title': 'ISIS dirty bomb plot foiled'}
        self.assertTrue(collector.apply_ai_selection(event, self.decision(event['title'], categories=['Attacks'])))
        self.assertIn('Radiological/Nuclear', event['categories'])
        self.assertNotIn('CBRN', event['categories'])

    def test_material_words_alone_do_not_assign_a_non_cbrn_event(self):
        event = {'title': 'Nuclear medicine expands radiopharmaceutical supply', 'categories': ['Weapons']}
        radnuc.annotate(event)
        self.assertNotIn('cbrn_subgroups', event)


class RadnucQueryTests(unittest.TestCase):
    def test_all_supplied_keywords_have_security_qualified_searches(self):
        joined = ' '.join(radnuc.ENGLISH_QUERIES).lower()
        for keyword in radnuc.KEYWORDS:
            self.assertIn(keyword.lower(), joined)
        for query in radnuc.ENGLISH_QUERIES:
            self.assertTrue(any(term in query for term in ('terror', 'smuggling', 'cyberattack')))

    def test_native_searches_reach_every_daily_profile(self):
        for profile in collector.MULTILINGUAL_PROFILES:
            self.assertTrue(set(radnuc.queries(profile['code'])) <= {
                q['term'] for q in profile['queries'] if q.get('category') == 'Radiological/Nuclear'})


if __name__ == '__main__':
    unittest.main()
