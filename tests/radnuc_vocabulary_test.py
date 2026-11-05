"""The 181 supplied RN terms must drive daily intake."""
import hashlib
import sys
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT),str(ROOT/'tools')]
import collector
import radnuc
import radnuc_vocabulary as v
import threat_categories as t
from tools.backfill_query import groups


class Vocabulary(unittest.TestCase):
    def atoms(self,queries):
        return {term.strip('"') for query in queries for group in groups(query) for term in group}

    def test_all_181_user_supplied_entries_are_preserved_exactly(self):
        terms=v.all_terms()
        self.assertEqual(len(terms),181)
        self.assertEqual(hashlib.sha256('\n'.join(terms).encode()).hexdigest(),
                         '8f93e472f1c317182ee1ee5a41ec63dd205c97aefaba460382274675e34386ee')

    def test_daily_queries_include_each_entry_and_existing_queries(self):
        daily=collector.CORE_SEARCH_QUERIES[t.RN]
        self.assertTrue(set(v.all_terms())<=self.atoms(daily))
        self.assertTrue(set(radnuc.ENGLISH_QUERIES)<=set(daily))
        self.assertTrue(set(v.queries())<=set(collector.CATEGORIES[t.RN]))
        self.assertTrue(set(v.queries())<=set(collector.OFFICIAL_SOURCE_QUERIES[t.RN]))

    def test_each_broad_term_is_paired_with_context_not_searched_alone(self):
        broad={term for group in v.vocabulary()['keyword_groups']
               if group['retrieval']=='incident_context_required' for term in group['terms']}
        anchors=set().union(*map(set,v.vocabulary()['context_groups']))
        for query in v.queries():
            atoms=self.atoms([query])
            if atoms & broad:
                self.assertTrue(atoms & anchors,query)

    def test_queries_fit_provider_ceiling_and_keep_short_tokens_unquoted(self):
        for query in v.queries():self.assertLessEqual(len(query.encode()),200)
        joined=' '.join(v.queries())
        for token in ['HEU','LEU','U-235','Cs-137','Tc-99m']:
            self.assertIn(token,joined);self.assertNotIn('"'+token+'"',joined)

    def test_native_existing_searches_unchanged_and_no_new_map_subcategory(self):
        for code in radnuc.LEXICONS:
            if code!='en':
                self.assertEqual(t.queries(t.RN,code),radnuc.queries(code)+v.queries(code))
        self.assertEqual(t.LABELS,('Radiological/Nuclear','Chemicals and Explosives','Biological Terrorism'))

    def test_chinese_supplement_runs_daily_in_both_writing_systems(self):
        for code, config in v.CHINESE_SUPPLEMENT_QUERIES.items():
            profiles = [p for p in collector.MULTILINGUAL_PROFILES if p['code']==code]
            self.assertTrue(profiles)
            for profile in profiles:
                actual = {q['term'] for q in profile['queries'] if q['category']==t.RN}
                self.assertEqual(actual, set(radnuc.queries(code)+config['queries']))
            result = v.queries(code)
            result.clear()
            self.assertEqual(v.queries(code), config['queries'])

    def test_material_names_do_not_automatically_assign_terrorism(self):
        event={'title':'Hospital expands its Lutetium-177 treatment programme','categories':['Other']}
        t.annotate(event)
        self.assertNotIn(t.RN,event['categories'])


if __name__=='__main__':unittest.main()
