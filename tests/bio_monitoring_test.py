"""Provisional Bio daily intake preserves uncertain alerts and frozen history."""
import copy
import hashlib
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import collector
import threat_categories as topics


class BioMonitoringTest(unittest.TestCase):
    def test_all_daily_languages_get_every_monitoring_group(self):
        configured = set(json.loads((ROOT / 'ct-atlas-runtime.json').read_text())['language_codes'])
        vocab = topics.bio_monitoring_vocabulary()
        self.assertEqual(set(vocab['languages']), configured)
        for code in configured:
            monitoring = topics.bio_monitoring_queries(code)
            self.assertTrue(monitoring, code)
            self.assertTrue(all(len(query) <= 680 for query in monitoring), code)
            joined = ' '.join(monitoring)
            for key in ('powder', 'response', 'mail', 'mail_context', 'targeted', 'target'):
                for term in vocab['languages'][code][key]:
                    self.assertIn('"' + term + '"', joined, (code, key, term))
            for query in monitoring:
                self.assertIn(') (', query)
                for term in vocab['noise_exclusions']:
                    self.assertIn('-"' + term + '"', query)
            loaded = set(collector.CORE_SEARCH_QUERIES[topics.BIO]) if code == 'en' else {
                row['term'] for profile in collector.MULTILINGUAL_PROFILES if profile['code'] == code
                for row in profile['queries'] if row['category'] == topics.BIO}
            self.assertTrue(set(monitoring) <= loaded, code)

    def test_boolean_group_context_and_negative_test_outcomes(self):
        positives = [
            ('Unknown powder found in a lobby', 'Hazmat crews evacuated the building; tests were negative.'),
            ('Suspicious envelope tested negative', 'The mailroom received a letter containing an unidentified substance.'),
            ('Courthouse receives suspicious letter', 'Officials investigated the incident; no agent was confirmed.'),
            ('White powder alert', 'A field test found no hazardous substance.'),
            ('Suspicious powder alert', 'Hazmat used a new method; no dangerous substance was detected.'),
            ('Tribunal évacué après une poudre blanche', 'Une enquête est en cours.'),
            ('法院收到可疑信件', '警方正在调查。'),
        ]
        for title, summary in positives:
            self.assertTrue(topics.bio_monitoring_match(title, summary), title)
            self.assertTrue(collector.is_relevant_article(topics.BIO, title, summary), title)
        negatives = [
            ('Suspicious package at an airport', 'Police established a perimeter.'),
            ('Unknown powder in a laboratory', 'Routine research continues.'),
            ('School opens a new mailroom', 'Students welcome the new facility.'),
            ('Natural anthrax outbreak', 'Cattle became ill after a natural outbreak.'),
        ]
        for title, summary in negatives:
            self.assertFalse(topics.bio_monitoring_match(title, summary), title)
            self.assertFalse(collector.is_relevant_article(topics.BIO, title, summary), title)

    def test_supplied_noise_filter_is_whole_term_and_cannot_fall_through(self):
        for noise in ('cocaine', 'heroin', 'fentanyl', 'meth', 'protein powder', 'baking', 'recipe', 'cosmetic'):
            title = 'Anthrax hoax white powder letter triggers hazmat response'
            summary = 'Terrorism investigators identified ' + noise + '.'
            self.assertFalse(topics.bio_monitoring_match(title, summary), noise)
            self.assertFalse(collector.is_relevant_article(topics.BIO, title, summary), noise)
        self.assertTrue(topics.bio_monitoring_match('Suspicious powder at courthouse', 'A new method was used.'))
        self.assertFalse(topics.bio_noise_match('Suspicious powder', 'Hazmat method and methane analysis'))

    def test_unknown_actor_and_hoax_keep_uncertainty_without_duplicate_record(self):
        event = {'id': 'same-incident', 'title': 'Suspicious letter tested negative for anthrax',
                 'summary': 'Hazmat investigated the powder-filled envelope at the courthouse.'}
        result = {'relevance_score': 85, 'is_current_ct_event': True,
                  'categories': [topics.BIO], 'actor_scope': 'UNKNOWN', 'cbrn_subgroups': [],
                  'english_title': event['title'], 'english_summary': event['summary'],
                  'original_language': 'en', 'primary_event_type': 'OTHER_CT',
                  'is_attack': False, 'reported_status': 'HOAX'}
        self.assertTrue(collector.apply_ai_selection(event, result))
        self.assertEqual(event['id'], 'same-incident')
        self.assertEqual(event['categories'], [topics.BIO])
        self.assertEqual(event['reported_status'], 'HOAX')
        self.assertEqual(event['actor_scope'], 'UNKNOWN')
        self.assertFalse(event['is_attack'])

    def test_noise_is_rejected_after_faithful_translation_too(self):
        event = {'title': 'Alerte à la poudre blanche', 'summary': 'Une enveloppe suspecte a été examinée.'}
        result = {'relevance_score': 90, 'is_current_ct_event': True, 'categories': [topics.BIO],
                  'english_title': 'White powder alert at courthouse',
                  'english_summary': 'Hazmat investigators identified cocaine.',
                  'actor_scope': 'UNKNOWN', 'primary_event_type': 'OTHER_CT', 'is_attack': False}
        self.assertFalse(collector.apply_ai_selection(event, result))
        self.assertIn('noise exclusion', event['ai_scope_rejection'])

    def test_only_affected_recent_candidates_get_new_policy_fingerprint(self):
        ordinary = {'title': 'Police arrest terrorist suspect', 'summary': 'A cell was dismantled.'}
        alert = {'title': 'White powder courthouse alert', 'summary': 'Hazmat responded.'}
        original_vocabulary = topics.bio_monitoring_vocabulary()
        changed_vocabulary = copy.deepcopy(original_vocabulary)
        changed_vocabulary['version'] += '-new-policy'
        ordinary_before = collector.selection_fingerprint(ordinary)
        alert_before = collector.selection_fingerprint(alert)
        with patch.object(topics, 'bio_monitoring_vocabulary', return_value=changed_vocabulary):
            self.assertEqual(collector.selection_fingerprint(ordinary), ordinary_before)
            self.assertNotEqual(collector.selection_fingerprint(alert), alert_before)
        self.assertTrue(set(topics.bio_monitoring_queries()) - set(topics.collection_queries(topics.BIO)))
        replay = {row['term'] for profile in collector.HISTORICAL_REPLAY_PROFILES
                  for row in profile['queries'] if row['category'] == topics.BIO}
        self.assertFalse(replay & set(topics.bio_monitoring_queries()))

    def test_bio_configuration_rules_reach_final_ai_selection(self):
        for rule in topics.vocabulary()['biological']['rules']:
            self.assertIn(rule, collector.AI_SELECTION_INSTRUCTIONS)
        self.assertIn('without a confirmed biological agent or terrorism nexus', collector.AI_SELECTION_INSTRUCTIONS)
        self.assertIn('Negative laboratory or field tests', collector.AI_SELECTION_INSTRUCTIONS)


if __name__ == '__main__':
    unittest.main()
