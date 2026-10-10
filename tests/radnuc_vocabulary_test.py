"""The 181 supplied RN terms must drive daily AND supplemental historical intake."""
import hashlib
import json
import sys
import tempfile
import unittest
from datetime import date,timedelta
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT),str(ROOT/'tools')]
import collector
import radnuc
import radnuc_vocabulary as v
import threat_categories as t
import enrich_archive as e
import enrich_radnuc as r
import enrich_threat_categories as b
import specialist_catchup as c
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
            if code!='en':self.assertEqual(t.queries(t.RN,code),radnuc.queries(code))
        self.assertEqual(t.LABELS,('Radiological/Nuclear','Chemicals and Explosives','Biological Terrorism'))

    def test_material_names_do_not_automatically_assign_terrorism(self):
        event={'title':'Hospital expands its Lutetium-177 treatment programme','categories':['Other']}
        t.annotate(event)
        self.assertNotIn(t.RN,event['categories'])


class SupplementPlan(unittest.TestCase):
    def setUp(self):self.plan=v.backfill_tasks(e.task_key)

    def test_separate_fixed_six_month_window_and_both_providers(self):
        anchor=date(2026,10,9)
        windows=sorted({e.window(task) for task in self.plan})
        self.assertEqual(windows[0][0],anchor-timedelta(days=180))
        self.assertEqual(windows[-1][1],anchor+timedelta(days=1))
        self.assertTrue(all(left[1]==right[0] for left,right in zip(windows,windows[1:])))
        self.assertEqual({x['source'] for x in self.plan},{'google','gdelt'})
        self.assertEqual(len(self.plan),len({x['key'] for x in self.plan}))

    def test_every_new_query_in_every_window_for_each_provider(self):
        windows={e.window(task) for task in self.plan}
        for window in windows:
            self.assertEqual(
                {x['query'] for x in self.plan
                 if e.window(x)==window and x['source']=='gdelt'},
                set(v.queries()))
            self.assertEqual(
                {x['query'] for x in self.plan
                 if e.window(x)==window and x['source']=='google' and x['code']=='en'},
                set(v.queries()))
            for code,profile in v.CHINESE_SUPPLEMENT_QUERIES.items():
                with self.subTest(window=window,code=code):
                    chinese=[x for x in self.plan if e.window(x)==window
                             and x['source']=='google' and x['code']==code]
                    self.assertEqual({x['query'] for x in chinese},set(profile['queries']))
                    self.assertTrue(all(x['locale']==f"{profile['hl']}|{profile['gl']}|{profile['ceid']}"
                                        for x in chinese))

    def test_chinese_supplement_preserves_exactly_181_user_keywords(self):
        self.assertEqual(len(v.all_terms()),181)
        self.assertEqual({x['code'] for x in self.plan
                          if x['source']=='google' and x['code'].startswith('zh')},
                         {'zh','zh-Hant'})
        self.assertTrue(all(x['supplemental_vocabulary']==v.vocabulary()['version']
                            for x in self.plan))
        self.assertTrue(set(v.queries()) <= {x['query'] for x in self.plan})

    def test_original_checkpoint_identities_are_not_reset(self):
        with patch.object(v,'backfill_tasks',return_value=[]):
            before=b.plan_tasks(t.RN,date(2026,10,8),collector)
        after=b.plan_tasks(t.RN,date(2026,10,8),collector)
        self.assertTrue({x['key'] for x in before}<={x['key'] for x in after})
        # The existing English/other native queries retain every old key.
        # The new Chinese-only keys are strictly additive.
        old=[task for task in before if task['code'] not in ('zh','zh-Hant')]
        self.assertEqual(len(old),2160)
        self.assertGreater(len(before),len(old))

    def test_supplement_stays_frozen_when_base_plan_date_advances(self):
        one=r.plan_tasks(date(2026,10,8),collector)
        two=r.plan_tasks(date(2026,10,10),collector)
        select=lambda rows:{x['key'] for x in rows if x.get('supplemental_vocabulary')}
        self.assertEqual(select(one),select(two))

    def test_progress_counts_only_supplement_and_includes_pending_reviews(self):
        state={'done':{self.plan[0]['key']:'done','unrelated-old-key':'done'},'children':{},'pending_reviews':[]}
        report=v.progress(self.plan,state)
        self.assertEqual(report['completed_searches'],1)
        self.assertEqual(report['pending_searches'],len(self.plan)-1)
        self.assertEqual(report['supplied_keywords'],181)
        self.assertFalse(report['processing_complete'])
        state['pending_reviews']=[{'_task':self.plan[0]}]
        self.assertEqual(v.progress(self.plan,state)['pending_searches'],len(self.plan))

    def test_status_and_readable_summary_display_the_new_cohort(self):
        with tempfile.TemporaryDirectory() as tmp:
            row=b.progress(tmp,t.RN,self.plan)
            self.assertEqual(row['supplemental_vocabulary']['supplied_keywords'],181)
            c.write(tmp,c.STATUS,{'batch_status':'partial','categories':{name:row if name==t.RN else {} for name in t.LABELS}})
            summary=c.summary(tmp)
            self.assertIn('Additional Radiological/Nuclear keyword backfill',summary)
            self.assertIn('"supplied_keywords": 181',summary)


if __name__=='__main__':unittest.main()
