"""Text defects, from the records of the audit of 2026-11-05."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import collector
import geolocate
import map_evidence_integrity as integrity


class TextRepairTests(unittest.TestCase):
    def test_the_stored_defects_are_repaired(self):
        for broken, repaired in (
                ('Police publish video following arson attack on refugee shelter in Baden-W¼rttemberg',
                 'Police publish video following arson attack on refugee shelter in Baden-Württemberg'),
                ('Alcald3a de Bogot3', 'Alcaldía de Bogotá'), ('Choc3', 'Chocó'), ('Nari\x11o', 'Nariño'),
                ('S\x92gou Region', 'Ségou Region'), ('\x13\x11\x12\x12Ile-de-France', 'Ile-de-France'),
                ('Michoac&#xe1;n', 'Michoacán'), ('Vend&#233;e', 'Vendée'), ('Gr&auml;felfing', 'Gräfelfing')):
            self.assertEqual(integrity.repair_text(broken), repaired)

    def test_clean_text_repairs_and_ordinary_text_is_untouched(self):
        self.assertEqual(collector.clean_text('Attack in Baden-W¼rttemberg\x13 &amp; beyond'), 'Attack in Baden-Württemberg & beyond')
        for text in ('Q3 report on piracy', 'Haber3', 'Del R1 al R3', 'Q´hubo Bogotá', 'Line\nbreak\ttab'):
            self.assertEqual(integrity.repair_text(text), text)

    def test_a_geolocation_answer_stores_a_clean_region_and_evidence(self):
        event = {}
        geolocate.apply_ai_result(event, {'precision': 'region', 'region': 'Nari\x11o', 'country_iso2': 'CO', 'confidence': .8,
                                          'latitude': 1.5, 'longitude': -77.5, 'evidence': 'Michoac&#xe1;n'}, 'fp')
        self.assertEqual((event['region'], event['location_evidence']), ('Nariño', ['Michoacán']))

    def test_a_stored_record_is_repaired_when_the_collector_loads_it(self):
        record = {'id': 'a', 'title': 'Shelter in Baden-W¼rttemberg', 'summary': 'x', 'incident_anchor': 'Arson attack Baden-W¼rttemberg 2026-10-28',
                  'region': 'Choc3', 'geolocation_requested_city': 'Bogot3', 'location_evidence': ['Alcald3a de Bogot3'],
                  'published': '2026-10-28T08:00:00+00:00', 'categories': ['Attacks'], 'category': 'Attacks'}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'events.json'
            path.write_text(json.dumps({'events': [record]}), encoding='utf-8')
            with mock.patch.object(collector, 'OUTPUT_FILE', str(path)):
                loaded = collector.load_existing()[0]
        self.assertEqual(loaded['title'], 'Shelter in Baden-Württemberg')
        self.assertEqual(loaded['incident_anchor'], 'Arson attack Baden-Württemberg 2026-10-28')
        self.assertEqual((loaded['region'], loaded['geolocation_requested_city']), ('Chocó', 'Bogotá'))
        self.assertEqual(loaded['location_evidence'], ['Alcaldía de Bogotá'])

    def test_the_repair_workflow_resolves_the_requested_city_with_the_lost_byte(self):
        event = {'country_code': 'CO', 'geolocation_validation_issue': 'ambiguous_or_unresolved_city',
                 'geolocation_requested_city': 'Bogot3'}
        self.assertTrue(integrity.repair_unresolved_city(event, geolocate.resolve_city))
        self.assertEqual((event['city'], event['location_precision']), ('Bogotá', 'city'))


if __name__ == '__main__':
    unittest.main()
