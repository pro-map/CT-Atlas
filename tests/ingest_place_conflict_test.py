"""Different named places at ingest, and promoted headlines, from the real cases
of the audit of 2026-11-05."""
import contextlib
import io
import unittest

import collector
import map_evidence_integrity as integrity


def article(title, source='Outlet', published='2026-10-20T08:00:00+00:00', **fields):
    return {'title': title, 'original_title': title, 'summary': '', 'url': 'https://example.test/' + str(abs(hash(title))),
            'source': source, 'published': published, 'category': 'Attacks', 'categories': ['Attacks'], **fields}


def places(title, country):
    return sorted(integrity.headline_places(title, country))


class HeadlinePlaceTests(unittest.TestCase):
    def test_a_locative_names_a_place_a_bare_word_does_not(self):
        self.assertEqual(places('Arrest following axe attack in Hattingen', 'DE'), ['hattingen'])
        self.assertEqual(places("Hakkari'deki terör saldırısı", 'TR'), ['hakkari'])
        self.assertEqual(places('Karak: Funeral shooting at a church in Hammoud village', 'JO'), ['karak'])
        for title, country in (("Alias 'La Morocha', FARC dissidents leader close to Calarcá, captured", 'CO'),
                               ('Orange News in Hong Kong Receives Powder Letter', 'US'), ('Moscow says it foiled an attack', 'RU')):
            self.assertEqual(places(title, country), [], title)

    def test_a_list_after_a_locative_names_every_place(self):
        self.assertEqual(places('Nigerian troops neutralize terrorists and recover arms in Kaduna and Kano', 'NG'), ['kaduna', 'kano'])
        self.assertEqual(places('Explosive attack in Montebello, Cali, Colombia', 'CO'), ['cali', 'montebello'])

    def test_a_country_or_a_region_of_the_same_name_is_not_the_town(self):
        self.assertEqual(places('Car bomb explosion in Colombia leaves four women injured', 'CO'), [])
        self.assertEqual(places('Young woman detained while carrying out a terrorist act in Saratov Oblast', 'RU'), [])
        self.assertEqual(places('Over 10 people killed in Mopti region following clashes', 'ML'), [])

    def test_a_state_stands_for_all_its_places(self):
        self.assertEqual(places('Attempted attack thwarted in Norte de Santander', 'CO'), ['norte de santander'])
        self.assertFalse(integrity._far_apart(integrity.headline_places('captured in Chiapas', 'MX')['chiapas'],
                                              integrity.headline_places('arrested in Tapachula', 'MX')['tapachula']))


class FarNamedPlaceTests(unittest.TestCase):
    def assertSplit(self, record, folded, country):
        existing = article(record, country_code=country)
        self.assertTrue(integrity.far_named_place(article(folded), existing, country), folded)
        self.assertFalse(collector.event_match(article(folded), existing)[0], folded)

    def test_the_audits_folded_attacks_stay_apart(self):
        self.assertSplit('Arrest following knife attack at Hamburg Central Station', 'Arrest following axe attack in Hattingen', 'DE')
        self.assertSplit('Failed terrorist attack on police patrol in Jaleq, Saravan', 'Armed attack on military bus near Nikshahr', 'IR')
        self.assertSplit('ELN explosive drone attack kills soldier in La Vega, Cauca', 'Ataque con explosivos en Arauquita deja un soldado herido', 'CO')
        self.assertSplit('ELN explosive drone attack kills soldier in La Vega, Cauca', 'Soldier injured in ELN explosive attack in Arauca', 'CO')
        self.assertSplit('Child dies from landmine explosion in Hama countryside', 'IED explosion in Jaramana, Syria', 'SY')
        self.assertSplit('Terrorist attack in Silvan', "Ankara'daki terör saldırısı", 'TR')

    def test_a_pair_the_older_rules_merge_is_now_refused_by_the_place(self):
        # A stored pair: title_plus_anchor merges it, and only the record's country tells them apart.
        record = 'Syrian security forces dismantle ISIS cell in Raqqa'
        folded = 'Security forces dismantle ISIS cell in Homs countryside'
        fresh = article(folded, summary=folded)
        self.assertTrue(collector.event_match(fresh, article(record, summary=record))[0])
        self.assertEqual(collector.event_match(fresh, article(record, summary=record, country_code='SY')),
                         (False, 0.0, 'different_named_place'))
        self.assertEqual(sorted(integrity.headline_places('Attack in Silvan district', 'TR')), ['silvan'])

    def test_a_wrong_folded_variant_no_longer_attracts_its_copies(self):
        existing = article('ELN explosive drone attack kills soldier in La Vega, Cauca', country_code='CO')
        existing['title_variants'] = ['Soldier injured in ELN explosive attack in Arauca']
        existing['related_articles'] = [article('Soldier injured in ELN explosive attack in Arauca')]
        self.assertFalse(collector.event_match(article('Soldier injured in ELN explosive attack in Arauca'), existing)[0])

    def test_genuine_merges_stay(self):
        for record, folded, country in (
                ('Hagadera police commander, driver killed in Dadaab IED blast',
                 'Police commander and driver killed in suspected IED attack in Garissa', 'KE'),
                ('Abu Dhabi accuses co-pilot of using an axe in a terrorist act',
                 'Pilot on Dubai flight: Co-pilot said he was praying then attacked me', 'AE'),
                ('Leader of 18 Sureños arrested in Tapachula', "'El Pulpito', Barrio 18 gang leader, captured in Chiapas", 'MX'),
                ('Leader of cell linked to Los Rusos arrested in Acapulco', 'Leader of cell linked to Los Rusos arrested for attack on SSPC agents in Guerrero', 'MX'),
                ('Suspected Al-Shabaab Militants Launch Attacks on KDF Teams in Garissa and Lamu',
                 'Suspected Al-Shabaab Militants Target KDF Teams in Lamu, Garissa, No Casualties', 'KE'),
                ('Clashes between Dozo hunters and jihadists near Djenné, Mali', 'Over 10 people killed in Mopti region following clashes', 'ML'),
                ('Young woman detained while carrying out a terrorist act in Saratov Oblast', '18-year-old girl detained in Balashov for committing a terrorist act', 'RU'),
                ('675 Million Pesos Seized in Operation Against FARC Dissidents in El Charco, Nariño', 'Security operation against FARC dissidents in Nariño', 'CO')):
            self.assertFalse(integrity.far_named_place(article(folded), article(record), country), folded)

    def test_a_headline_with_no_place_or_a_shared_place_is_no_conflict(self):
        for record, folded in (('Attack on police in Silvan', 'Attack on police leaves two dead'),
                               ('Attack in Silvan', 'Suspect of the attack in Silvan arrested in Ankara')):
            self.assertFalse(integrity.far_named_place(article(folded), article(record), 'TR'), folded)

    def test_the_records_stored_place_counts_as_named(self):
        existing = article('Syrian security forces dismantle ISIS cell in Raqqa', city='Homs')
        self.assertFalse(integrity.far_named_place(article('Cell dismantled in Homs countryside'), existing, 'SY'))

    def test_the_same_link_or_headline_is_never_vetoed(self):
        first, second = article('Attack in Silvan'), article('Attack in Silvan', country_code='TR')
        self.assertFalse(integrity.far_named_place(first, second, 'TR'))
        link = article("Ankara'daki terör saldırısı", url='https://example.test/one')
        self.assertFalse(integrity.far_named_place(link, article('Terrorist attack in Silvan', url='https://example.test/one'), 'TR'))

    def test_before_geolocation_the_one_country_both_texts_name_decides(self):
        first = article('ELN explosive drone attack kills soldier in La Vega, Cauca, Colombia')
        second = article('Explosive attack in Arauquita, Colombia leaves soldier injured')
        self.assertEqual(collector.shared_country_code(second, first), 'CO')
        self.assertEqual(collector.event_match(second, first)[2], 'different_named_place')
        self.assertIsNone(collector.shared_country_code(article('Attack in Silvan'), article('Attack in Hakkari')))
        self.assertFalse(integrity.far_named_place(article('Attack in Silvan'), article('Attack in Hakkari'), None))

    def test_a_vetoed_article_becomes_its_own_record(self):
        existing = article('Arrest following knife attack at Hamburg Central Station', 'Reuters', country_code='DE')
        fresh = article('Arrest following axe attack in Hattingen')
        with contextlib.redirect_stdout(io.StringIO()):
            events = collector.deduplicate_incremental([existing], [fresh])
        self.assertEqual(len(events), 2)
        self.assertEqual(existing['related_articles'], [])


if __name__ == '__main__':
    unittest.main()
