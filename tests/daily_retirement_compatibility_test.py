"""Offline contracts: current RN decisions survive, stale labels and retired UI do not."""
import copy
from pathlib import Path
import unittest
import threat_categories as taxonomy

ROOT = Path(__file__).resolve().parents[1]

class RetirementCompatibilityTests(unittest.TestCase):
    def test_current_radnuc_compatibility_decision_is_preserved(self):
        event = {'id': 'keep', 'categories': ['Attacks'], 'title': 'ISIS dirty bomb plot foiled'}
        taxonomy.annotate(event, {'categories': ['Attacks'], 'cbrn_subgroups': ['RADNUC'], 'actor_scope': 'NON_STATE'})
        self.assertIn(taxonomy.RN, event['categories'])
        self.assertEqual(event['threat_categories'], [taxonomy.RN])

    def test_stale_event_subgroup_cannot_override_new_ordinary_decision(self):
        for extra in ({}, {'cbrn_subgroups': []}):
            with self.subTest(extra=extra):
                event = {'id': 'keep', 'categories': [taxonomy.RN], 'threat_categories': [taxonomy.RN], 'cbrn_subgroups': ['RADNUC']}
                taxonomy.annotate(event, {'categories': ['Arrests'], **extra})
                self.assertEqual(event['categories'], ['Arrests'])
                self.assertEqual(event['threat_categories'], [])
                self.assertEqual(event['cbrn_subgroups'], [])

    def test_state_scope_still_excludes_specialist_categories(self):
        event = {'id': 'keep', 'categories': ['Attacks']}
        taxonomy.annotate(event, {'categories': ['Attacks'], 'cbrn_subgroups': ['RADNUC'], 'actor_scope': 'STATE_ONLY'})
        self.assertNotIn(taxonomy.RN, event['categories'])

    def test_retired_quiz_has_no_automatic_trigger_or_model_secret(self):
        workflow = (ROOT / '.github/workflows/refresh-daily-quiz.yml').read_text()
        self.assertNotIn('  schedule:', workflow)
        self.assertNotIn('  push:', workflow)
        self.assertNotIn('secrets.', workflow)
        self.assertNotIn('generate_daily_quiz.py', workflow)

    def test_hub_no_longer_loads_or_launches_quiz(self):
        page = (ROOT / 'main.html').read_text()
        self.assertNotIn('mainQuizLauncher', page)
        self.assertNotIn('daily-quiz.js', page)

if __name__ == '__main__':
    unittest.main()
