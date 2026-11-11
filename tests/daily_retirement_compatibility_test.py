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

    def test_the_quiz_is_removed_everywhere(self):
        # Removed for good at the owner's request on 2026-11-11.
        for path in ('daily-quiz.js', 'daily-quiz.css', 'daily-quiz.json', 'daily-quiz-history.json',
                     'cloudflare-worker/quiz.js', 'tools/generate_daily_quiz.py',
                     '.github/workflows/refresh-daily-quiz.yml'):
            self.assertFalse((ROOT / path).exists(), path)
        worker = (ROOT / 'cloudflare-worker/index.js').read_text(encoding='utf-8')
        gate = (ROOT / 'cloudflare-worker/report-gate.js').read_text(encoding='utf-8')
        self.assertNotIn('/quiz-', worker + gate)
        self.assertNotIn('quiz_tracking', worker)
        self.assertNotIn('quiz_answers: 0', (ROOT / 'cloudflare-worker/shared.js').read_text(encoding='utf-8'))
        for page in ('main.html', 'tools/deploy_mirror.sh', 'usage-auth-fix.js', 'usage-admin.css',
                     '.github/workflows/live-smoke.yml', '.github/workflows/deploy-current-ct-atlas-ui.yml'):
            self.assertNotIn('quiz', (ROOT / page).read_text(encoding='utf-8').lower(), page)

if __name__ == '__main__':
    unittest.main()
