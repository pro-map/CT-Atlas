"""Offline specialist taxonomy, daily queries and evidence safety."""
import copy
import hashlib
import sys
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT));sys.path.insert(0,str(ROOT/'tools'))
import collector
import radnuc
import threat_categories as t

class TaxonomyTests(unittest.TestCase):
    def decision(self,categories,**extra):
        return {'relevance_score':90,'is_current_ct_event':True,'categories':categories,
                'cbrn_subgroups':['RADNUC'] if t.RN in categories else [],'actor_scope':'NON_STATE',
                'english_title':'Police disrupt an extremist plot','english_summary':'A concrete terrorism investigation is reported.',
                'original_language':'en','primary_event_type':'DISRUPTED_PLOT',**extra}

    def test_three_top_level_categories_and_no_parent(self):
        enum=collector.AI_SELECTION_SCHEMA['properties']['results']['items']['properties']['categories']['items']['enum']
        for label in t.LABELS:self.assertIn(label,enum);self.assertIn(label,collector.CATEGORIES)
        self.assertNotIn('CBRN',enum);self.assertNotIn('CBRN',collector.CATEGORIES)
        self.assertNotIn('CBRNE',collector.CATEGORIES)

    def test_every_specialist_english_query_reaches_daily_collection(self):
        for label in t.LABELS:
            self.assertEqual(collector.CORE_SEARCH_QUERIES[label],t.daily_queries(label))
            self.assertTrue(t.queries(label))
        for label in t.LABELS:
            for p in collector.MULTILINGUAL_PROFILES:
                self.assertTrue(set(t.queries(label,p['code'])) <= {q['term'] for q in p['queries'] if q['category']==label})

    def test_all_biological_terms_have_context_qualified_queries(self):
        for code,terms in t.vocabulary()['biological']['terms'].items():
            queries=t.queries(t.BIO,code);joined=' '.join(queries)
            for term in terms:self.assertIn('"'+term+'"',joined)
            for query in queries:self.assertIn(') (',query);self.assertLess(len(query),700)

    def test_reviewed_chemical_terms_match_the_supplied_list_exactly(self):
        item=t.vocabulary()['chemical_explosives']
        terms=item['terms']['en']
        self.assertEqual(len(terms),95)
        self.assertEqual(len(set(terms)),95)
        # Independent fingerprint of the reviewed list supplied on 2026-10-08.
        self.assertEqual(hashlib.sha256('\n'.join(terms).encode('utf-8')).hexdigest(),
                         '581ffe4ef31139281b82c926237dec24cf09975bb68494aeb56de3eaefd97ddd')
        self.assertEqual(item['review']['supplied_count'],100)
        self.assertEqual(item['review']['excluded_source_numbers'],[77,78,79,80,81])
        self.assertNotIn('not yet supplied',item['status'])
        self.assertEqual(item['vocabulary_version'],'chemical-explosives-user-v2-20261008')

    def test_every_chemical_term_is_context_qualified_and_registered_for_daily_search(self):
        for code,terms in t.vocabulary()['chemical_explosives']['terms'].items():
            queries=t.queries(t.CE,code)
            joined=' '.join(queries)
            for term in terms:self.assertIn('"'+term+'"',joined)
            for query in queries:
                self.assertIn(') (',query)
                self.assertLess(len(query),700)
        self.assertEqual(collector.CORE_SEARCH_QUERIES[t.CE],t.queries(t.CE))
        self.assertEqual(collector.OFFICIAL_SOURCE_QUERIES[t.CE],t.queries(t.CE))

    def test_chinese_biological_and_chemical_terms_have_context_in_daily_searches(self):
        expected={'zh','zh-Hant'}
        self.assertEqual({p['code'] for p in collector.MULTILINGUAL_PROFILES
                          if p['code'] in expected}, expected,
                         'User now requested both Chinese editions in daily Gemini updates')
        for label,vocab_name in ((t.CE,'chemical_explosives'),(t.BIO,'biological')):
            for code in expected:
                self.assertTrue(t.vocabulary()[vocab_name]['terms'][code])
                self.assertTrue(t.vocabulary()[vocab_name]['context'][code])
                queries=t.queries(label,code)
                self.assertTrue(queries)
                self.assertTrue(all(') (' in q for q in queries))
                self.assertTrue(all(len(q)<700 for q in queries))
                for term in t.vocabulary()[vocab_name]['terms'][code]:
                    self.assertIn('"'+term+'"',' '.join(queries))

    def test_configuration_rules_reach_the_shared_editorial_filter(self):
        rules=t.vocabulary()['chemical_explosives']['rules']
        self.assertTrue(rules)
        for rule in rules:
            self.assertIn(rule,t.SELECTION_NOTE)
            self.assertIn(rule,collector.AI_SELECTION_INSTRUCTIONS)
        self.assertIn('Reject manuals',collector.AI_SELECTION_INSTRUCTIONS)
        self.assertIn('non-state terrorism nexus',collector.AI_SELECTION_INSTRUCTIONS)

    def test_modern_decisions_are_authoritative_not_incidental_material_words(self):
        x={'title':'Terror suspect arrested','summary':'A nearby nuclear plant, anthrax research and explosives safety were mentioned in background.'}
        self.assertTrue(collector.apply_ai_selection(x,self.decision(['Arrests'])))
        self.assertEqual(x['categories'],['Arrests'])
        collector.ensure_event_metadata(x)
        self.assertEqual(x['categories'],['Arrests'])

    def test_biological_hoax_does_not_become_confirmed_attack(self):
        x={'id':'fixed','title':'Police investigate an anthrax hoax','latitude':1,'longitude':2}
        self.assertTrue(collector.apply_ai_selection(x,self.decision([t.BIO,'Arrests'],
            english_title=x['title'],reported_status='HOAX',primary_event_type='ARREST',is_attack=False)))
        self.assertEqual(x['reported_status'],'HOAX');self.assertFalse(x['is_attack'])
        self.assertEqual((x['id'],x['latitude'],x['longitude']),('fixed',1,2))
        self.assertEqual(x['categories'],[t.BIO,'Arrests'])

    def test_state_only_is_rejected_in_every_specialist_category(self):
        for label in t.LABELS:
            x={'title':'State military operation'}
            self.assertFalse(collector.apply_ai_selection(x,self.decision([label],actor_scope='STATE_ONLY')))
            self.assertFalse(x['ai_selected'])

    def test_legacy_radnuc_survives_without_parent_and_without_evidence_changes(self):
        x={'id':'keep','categories':['CBRN','Arrests'],'cbrn_subgroups':['RADNUC'],
           'title':'Police arrest suspect in dirty bomb plot','latitude':48.5,'longitude':2.3,'source':'Official'}
        before=copy.deepcopy(x);t.annotate(x)
        self.assertEqual(x['categories'],['Arrests',t.RN]);self.assertNotIn('CBRN',x['categories'])
        for k in ('id','title','latitude','longitude','source'):self.assertEqual(x[k],before[k])
        again=copy.deepcopy(x);t.annotate(x);self.assertEqual(x,again)

    def test_generic_guns_attacks_and_disease_news_do_not_gain_specialist_labels(self):
        for text,category in [('Terrorist arrested with a rifle','Weapons'),('Militants attack police','Attacks'),
                              ('Natural anthrax outbreak','Arrests')]:
            x={'title':text,'category':category,'ai_selected':True};t.annotate(x)
            self.assertFalse(set(x.get('categories',[])) & set(t.LABELS))

    def test_old_selected_explosive_reporting_gets_one_record_with_both_axes(self):
        x={'id':'same','categories':['Weapons','Arrests'],'title':'Police seized explosives in extremist plot','ai_selected':True}
        t.annotate(x);self.assertIn(t.CE,x['categories']);self.assertEqual(x['id'],'same')
        self.assertEqual(x['categories'].count(t.CE),1)

    def test_unclear_legacy_record_remains_for_review_and_is_not_deleted(self):
        x={'id':'x','category':'CBRN','title':'Materials seized in a terrorism investigation','cbrn_subgroups':[]}
        t.annotate(x);self.assertTrue(x['category_review_required']);self.assertEqual(x['categories'],[])
        self.assertEqual(x['id'],'x')

if __name__=='__main__':unittest.main()
