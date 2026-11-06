"""The Maritime label on the Houthi land war, from the records of the audit of 2026-11-05."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import collector


def houthi(title, categories, **fields):
    return {'title': title, 'summary': title, 'categories': categories, 'category': categories[0], **fields}


class MaritimeCategoryTests(unittest.TestCase):
    def test_the_houthi_land_war_leaves_maritime_as_primary(self):
        for title in ('Houthi attack damages plane at Riyadh airport', 'Three civilians injured in Houthi shelling of residential areas in Taiz',
                      'Coalition: The attack on King Khalid International Airport is a terrorist act'):
            event = houthi(title, ['Maritime Piracy', 'Attacks'], primary_event_type='ATTACK')
            self.assertTrue(collector.correct_primary_category(event))
            self.assertEqual((event['category'], event['categories']), ('Attacks', ['Attacks', 'Maritime Piracy']))
            self.assertFalse(collector.correct_primary_category(event), 'A correction applies once')

    def test_any_maritime_word_keeps_the_label_in_any_language_of_the_record(self):
        for fields in ({'title': 'Houthi missile hits tanker off Hodeidah'}, {'title': 'Attack', 'summary': 'A vessel was struck in the Red Sea'},
                       {'title': 'Yemeni Army reports military progress near Bab al-Mandab'},
                       {'title': 'Attack on the port of Aden'}, {'title': 'Attack', 'original_title': 'هجوم على ميناء عدن'}):
            event = {'summary': '', **fields, 'categories': ['Maritime Piracy', 'Attacks'], 'category': 'Maritime Piracy'}
            self.assertFalse(collector.correct_primary_category(event), fields)
            self.assertEqual(event['category'], 'Maritime Piracy')

    def test_a_sole_label_or_a_piracy_type_is_left_alone(self):
        self.assertFalse(collector.correct_primary_category(houthi('Houthi siege of Taiz', ['Maritime Piracy'])))
        self.assertFalse(collector.correct_primary_category(houthi('Houthi siege of Taiz', ['Maritime Piracy', 'Attacks'], primary_event_type='PIRACY')))
        self.assertFalse(collector.correct_primary_category(houthi('Houthi siege of Taiz', ['Attacks', 'Maritime Piracy'])))

    def test_a_new_decision_and_a_stored_record_are_both_corrected(self):
        event = {'id': 'a', 'title': 'x', 'summary': 'x', 'url': 'https://example.test/a', 'source': 'Reuters', 'published': '2026-11-01T08:00:00+00:00'}
        result = {'relevance_score': 90, 'is_current_ct_event': True, 'categories': ['Maritime Piracy', 'Attacks'], 'original_language': 'en',
                  'english_title': 'Three civilians injured in Houthi shelling of residential areas in Taiz', 'english_summary': 'Shelling of Taiz.',
                  'canonical_event': 'Houthi shelling of Taiz', 'primary_event_type': 'ATTACK', 'is_attack': True, 'update_type': 'INITIAL',
                  'incident_anchor': 'Houthi shelling of Taiz 2026-11-01', 'actor_scope': 'NON_STATE'}
        collector.apply_ai_selection(event, result)
        self.assertEqual(event['categories'], ['Attacks', 'Maritime Piracy'])
        stored = houthi('Houthi attack damages plane at Riyadh airport', ['Maritime Piracy', 'Attacks'], id='b', published='2026-10-28T08:00:00+00:00')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'events.json'
            path.write_text(json.dumps({'events': [stored]}), encoding='utf-8')
            with mock.patch.object(collector, 'OUTPUT_FILE', str(path)):
                self.assertEqual(collector.load_existing()[0]['category'], 'Attacks')


if __name__ == '__main__':
    unittest.main()
