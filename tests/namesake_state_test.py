"""Namesakes settled by the state the text names, without AI (audit of 2026-11-05)."""
import unittest

import geolocate
import map_evidence_integrity as integrity


def stored(title, requested, country, **fields):
    return {'title': title, 'summary': title, 'country_code': country, 'geolocation_requested_city': requested,
            'geolocation_validation_issue': 'ambiguous_or_unresolved_city', **fields}


class ResolverTests(unittest.TestCase):
    def test_the_state_settles_the_namesake(self):
        balboa = geolocate.resolve_city('Balboa', 'CO', context='Car bomb attack near a hospital in Balboa, Cauca')
        self.assertEqual((balboa['admin1code'], round(balboa['latitude'], 2)), ('09', 2.04))
        matamoros = geolocate.resolve_city('Matamoros', 'MX', context='Detention in Matamoros leads to narcobloqueos in Tamaulipas')
        self.assertEqual((matamoros['name'], matamoros['admin1code']), ('Heroica Matamoros', '28'))
        villanueva = geolocate.resolve_city('Villanueva', 'CO', context='peaje de Villanueva, Casanare')
        self.assertEqual((villanueva['admin1code'], villanueva['population']), ('32', 31727))

    def test_without_the_state_a_namesake_stays_unresolved(self):
        self.assertIsNone(geolocate.resolve_city('Balboa', 'CO'))
        self.assertIsNone(geolocate.resolve_city('Matamoros', 'MX', context='U.S. Issues Security Alert in Matamoros'))

    def test_a_state_with_no_namesake_or_two_states_with_one_each_settle_nothing(self):
        self.assertIsNone(geolocate.resolve_city('Balboa', 'CO', context='Balboa, Huila'))
        self.assertIsNone(geolocate.resolve_city('Balboa', 'CO', context='Balboa in Cauca and Risaralda'))

    def test_a_longer_state_name_is_not_read_as_the_shorter_one(self):
        self.assertEqual(geolocate.named_states('CO', 'attack in Valle del Cauca'), {'29'})
        self.assertEqual(geolocate.named_states('CO', 'Norte de Santander'), {'21'})
        self.assertEqual(geolocate.named_states('CO', 'Cauca y Santander'), {'09', '26'})

    def test_a_cartel_named_after_a_state_says_nothing_of_the_place(self):
        for text in ('Sinaloa Cartel operator', 'Cártel de Sinaloa', 'CJNG, Cartel Jalisco Nueva Generación', 'Jalisco New Generation Cartel'):
            self.assertEqual(geolocate.named_states('MX', text), set(), text)
        self.assertIsNone(geolocate.resolve_city('Matamoros', 'MX', context='Matamoros: Sinaloa Cartel operator'))

    def test_another_country_is_not_affected(self):
        self.assertEqual(geolocate.named_states('AU', 'Perth, Western Australia'), set())
        self.assertIsNone(geolocate.resolve_city('Perth', 'AU', context='Perth, Western Australia'))


class GeolocationAnswerTests(unittest.TestCase):
    def answer(self, title, city, country):
        event = {'title': title, 'summary': title}
        geolocate.apply_ai_result(event, {'precision': 'city', 'city': city, 'country_iso2': country, 'confidence': .9,
                                          'latitude': 1.0, 'longitude': 2.0, 'evidence': title}, 'fp')
        return event

    def test_a_new_answer_lands_on_the_namesake_of_the_state_in_the_text(self):
        event = self.answer('Car bomb attack near a hospital in Balboa, Cauca', 'Balboa', 'CO')
        self.assertEqual((event['city'], round(event['latitude'], 2), event['location_method']), ('Balboa', 2.04, 'ai_city_geonames'))
        self.assertNotIn('geolocation_validation_issue', event)

    def test_the_rule_that_discards_unresolved_ai_coordinates_stands(self):
        event = self.answer('Attack in Balboa', 'Balboa', 'CO')
        self.assertIsNone(event['latitude'])
        self.assertEqual(event['location_method'], 'unresolved_city_no_capital_fallback')
        self.assertEqual(event['geolocation_validation_issue'], 'ambiguous_or_unresolved_city')


class StoredRecordTests(unittest.TestCase):
    def test_the_repair_workflow_settles_a_stored_namesake(self):
        event = stored('Car bomb attack near a hospital in Balboa, Cauca', 'Balboa', 'CO',
                       location_precision='unlocated', location_method='unresolved_city_no_capital_fallback')
        self.assertTrue(integrity.repair_unresolved_city(event, geolocate.resolve_city))
        self.assertEqual((event['city'], event['location_precision'], event['location_method']),
                         ('Balboa', 'city', 'source_name_geonames_correction'))
        self.assertIn('names the state', event['location_review_reason'])
        self.assertFalse(integrity.repair_unresolved_city(event, geolocate.resolve_city), 'The repair must be idempotent')

    def test_the_label_keeps_the_source_spelling(self):
        event = stored('Detention in Matamoros leads to narcobloqueos in Tamaulipas', 'Matamoros', 'MX')
        self.assertTrue(integrity.repair_unresolved_city(event, geolocate.resolve_city))
        self.assertEqual((event['city'], round(event['latitude'], 2)), ('Matamoros', 25.88))

    def test_a_record_that_does_not_name_the_state_is_left_for_review(self):
        event = stored('Minor dies after shooting in Matamoros', 'Matamoros', 'MX')
        self.assertFalse(integrity.repair_unresolved_city(event, geolocate.resolve_city))
        self.assertEqual(event['geolocation_validation_issue'], 'ambiguous_or_unresolved_city')


if __name__ == '__main__':
    unittest.main()
