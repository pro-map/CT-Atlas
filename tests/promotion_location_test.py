"""A promoted headline must fit the point the record keeps, from the real cases
of the audit of 2026-11-05."""
import unittest

import collector


def article(title, source='Outlet', published='2026-10-20T08:00:00+00:00', **fields):
    return {'title': title, 'original_title': title, 'summary': '', 'url': 'https://example.test/' + str(abs(hash(title))),
            'source': source, 'published': published, 'category': 'Attacks', 'categories': ['Attacks'], **fields}


def located(title, source='Local outlet', **fields):
    return article(title, source, ai_geo_complete=True, **fields)


SANAA = {'country': 'Yemen', 'country_code': 'YE', 'city': 'Sanaa', 'latitude': 15.35, 'longitude': 44.21, 'location_precision': 'city'}
YOBE = {'country': 'Nigeria', 'country_code': 'NG', 'region': 'Yobe State', 'latitude': 12.0, 'longitude': 11.5, 'location_precision': 'region'}
JEDDAH = {'country': 'Saudi Arabia', 'country_code': 'SA', 'city': 'Jeddah', 'latitude': 21.54, 'longitude': 39.17, 'location_precision': 'city'}
ABUJA = {'country': 'Nigeria', 'country_code': 'NG', 'city': 'Abuja', 'latitude': 9.06, 'longitude': 7.49, 'location_precision': 'country_capital'}


class PromotionTests(unittest.TestCase):
    def merged(self, existing, new):
        collector.merge_event(existing, new, 1.0, 'same_incident')
        return existing

    def test_a_record_of_another_country_is_not_promoted_over_the_point(self):
        kept = self.merged(located('Strikes reported in Sanaa', **SANAA), article('Debris falls in Jeddah, Taif and Rabigh', 'Reuters', **JEDDAH))
        self.assertEqual((kept['title'], kept['source'], kept['city']), ('Strikes reported in Sanaa', 'Local outlet', 'Sanaa'))
        self.assertEqual([item['title'] for item in kept['related_articles']], ['Debris falls in Jeddah, Taif and Rabigh'])
        self.assertIn('Reuters', kept['sources'])

    def test_consolidation_keeps_the_yobe_headline_on_the_yobe_point(self):
        kotsrahe = {'country': 'Cameroon', 'country_code': 'CM', 'latitude': 10.7, 'longitude': 13.9, 'location_precision': 'region'}
        kept = self.merged(located('ISWAP attack in Yobe', **YOBE), article('Boko Haram attack in Kotsrahé, Cameroon', 'Reuters', **kotsrahe))
        self.assertEqual(kept['title'], 'ISWAP attack in Yobe')

    def test_a_headline_naming_a_far_town_of_the_country_is_not_promoted(self):
        kept = self.merged(located('ISWAP attack on checkpoint', **YOBE), article('Attack in Kano leaves six dead', 'Reuters', country='Nigeria'))
        self.assertEqual(kept['title'], 'ISWAP attack on checkpoint')

    def test_a_far_located_record_of_the_country_is_not_promoted(self):
        lagos = {**YOBE, 'region': None, 'city': 'Lagos', 'latitude': 6.45, 'longitude': 3.39, 'location_precision': 'city'}
        kept = self.merged(located('ISWAP attack on checkpoint', **YOBE), article('Gunmen attack checkpoint', 'Reuters', **lagos))
        self.assertEqual(kept['title'], 'ISWAP attack on checkpoint')

    def test_a_headline_fitting_the_point_or_naming_no_place_is_promoted(self):
        for title in ('Six killed in attack on checkpoint', 'Six killed in attack in Damaturu, Nigeria', 'Attack in Yobe State leaves six dead'):
            kept = self.merged(located('ISWAP attack on checkpoint', **YOBE), article(title, 'Reuters', country='Nigeria'))
            self.assertEqual((kept['title'], kept['source']), (title, 'Reuters'), title)

    def test_a_record_not_yet_geolocated_takes_the_better_headline_as_before(self):
        kept = self.merged(article('Strikes reported in Sanaa', 'Local outlet'), article('Debris falls in Jeddah, Taif and Rabigh', 'Reuters'))
        self.assertEqual(kept['title'], 'Debris falls in Jeddah, Taif and Rabigh')

    def test_a_capital_placeholder_is_no_evidence_against_a_headline(self):
        kept = self.merged(located('Gunmen attack village', **ABUJA), article('Gunmen attack village in Kano', 'Reuters', country='Nigeria'))
        self.assertEqual(kept['title'], 'Gunmen attack village in Kano')


if __name__ == '__main__':
    unittest.main()
