"""Offline specialist taxonomy, daily queries, fixed backfill and evidence safety."""
import copy
import hashlib
import json
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT));sys.path.insert(0,str(ROOT/'tools'))
import collector
import radnuc
import threat_categories as t
import archive_review as a
import enrich_archive as e
import enrich_radnuc as r
import enrich_threat_categories as b
import migrate_threat_categories as m

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
            self.assertEqual(collector.CORE_SEARCH_QUERIES[label],t.queries(label))
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

class BackfillTests(unittest.TestCase):
    def test_backfill_covers_six_months_for_each_category(self):
        today=date(2026,10,8)
        for label in t.LABELS:
            plan=b.plan_tasks(label,today,collector)
            windows=sorted({e.window(q) for q in plan})
            self.assertEqual(windows[0][0],today-timedelta(days=180))
            self.assertEqual(windows[-1][1],today+timedelta(days=1))
            self.assertTrue(all(x[1]==y[0] for x,y in zip(windows,windows[1:])))
            self.assertEqual(len(plan),len({q['key'] for q in plan}))
            self.assertEqual({q['category'] for q in plan},{label})

    def test_all_reviewed_chemical_queries_cover_each_historical_window(self):
        plan=b.plan_tasks(t.CE,date(2026,10,8),collector)
        expected=set(t.queries(t.CE,'en'))
        self.assertEqual(len(expected),16)
        windows={e.window(task) for task in plan}
        for window in windows:
            rows=[task for task in plan if e.window(task)==window]
            self.assertEqual({task['query'] for task in rows if task['source']=='google' and task['code']=='en'},expected)
            self.assertEqual({task['query'] for task in rows if task['source']=='gdelt'},expected)
        # Search identities include the query: an old completed query cannot
        # incorrectly mark an expanded vocabulary's different query complete.
        task=next(task for task in plan if task['source']=='google' and task['code']=='en')
        old_key=e.task_key({**task,'query':'"previous provisional search"'})
        self.assertNotEqual(task['key'],old_key)

    def test_fixed_anchor_never_rolls_forward_on_a_daily_rerun(self):
        with tempfile.TemporaryDirectory() as tmp:
            first=b.manifest(tmp,date(2026,10,8));second=b.manifest(tmp,date(2026,10,9))
            self.assertEqual(first,second)
            anchor=date.fromisoformat(first['anchor'])
            self.assertEqual(b.plan_tasks(t.BIO,anchor,collector),b.plan_tasks(t.BIO,date.fromisoformat(second['anchor']),collector))

    def test_radnuc_existing_search_keys_are_preserved(self):
        anchor=date(2026,10,7)
        self.assertEqual(b.plan_tasks(t.RN,anchor,collector),r.plan_tasks(anchor,collector))
        for task in b.plan_tasks(t.RN,anchor,collector):
            self.assertEqual(task['key'],e.task_key({**task,'category':'CBRN'}))

    def test_output_integrates_bio_and_chemical_with_recovery_and_no_duplicate(self):
        now=datetime.now(timezone.utc)
        for label in (t.BIO,t.CE):
            with tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);a.write_json(root/'events.json',{'events':[{'id':'existing','title':'Unrelated arrest','published':now.isoformat(),'category':'Arrests','latitude':1,'longitude':2}]})
                event={'id':'new','title':'Police arrest extremist cell in a concrete plot','summary':'Police disrupted a terrorist plot.',
                       'published':now.isoformat(),'category':label,'categories':[label],'source':'Official',
                       'url':'https://example.test/article','country':'France','actor_scope':'NON_STATE',
                       'ai_selected':True,'ai_current_ct_event':True,'primary_event_type':'ARREST','reported_status':'SUSPECTED'}
                out=r.IntegratedOutput(root,now,collector,label,b.PREFIXES[label]);out.add([{'selected_event':event}]);out.save()
                again=r.IntegratedOutput(root,now,collector,label,b.PREFIXES[label]);again.save()
                events=a.read_json(root/'events.json')['events']
                self.assertEqual(len(events),2);self.assertEqual(next(x for x in events if x['id']=='existing')['latitude'],1)
                self.assertEqual(next(x for x in events if x['id']=='new')['reported_status'],'SUSPECTED')

    def test_off_topic_seen_namespaces_do_not_hide_new_specialist_queries(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp,'archive').mkdir()
            now=datetime.now(timezone.utc)
            e.save_seen(tmp,now,{'old'})
            self.assertNotIn('old',e.load_seen(tmp,'biological-v1'))
            e.save_seen(tmp,now,{'new'},'biological-v1')
            self.assertIn('new',e.load_seen(tmp,'biological-v1'))
            self.assertNotIn('new',e.load_seen(tmp))

    def test_archive_only_items_are_not_silently_skipped_from_new_backfill(self):
        with tempfile.TemporaryDirectory() as tmp:
            a.write_json(Path(tmp)/'events.json',{'events':[]})
            a.write_json(Path(tmp)/'archive/old.json',{'articles':[{'title':'Biological threat','source':'Official','url':'https://example.test/old'}]})
            self.assertEqual(b.known_map_keys(tmp),set())
            self.assertTrue(e.known_article_keys(tmp))

    def test_migration_never_changes_ids_sources_dates_or_locations(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'events.json'
            x={'id':'x','categories':['CBRN'],'cbrn_subgroups':['RADNUC'],'published':'2026-07-08T10:00:00Z','latitude':1,'longitude':2,'source':'Official','url':'https://example.test/x'}
            a.write_json(path,{'events':[x]})
            report=m.migrate(path,write=True)
            self.assertEqual(report['events_preserved'],1)
            migrated=a.read_json(path)['events'][0]
            for key in ('id','published','latitude','longitude','source','url'):self.assertEqual(migrated[key],x[key])
            self.assertEqual(m.migrate(path,write=True)['records_reclassified'],0)

if __name__=='__main__':unittest.main()
