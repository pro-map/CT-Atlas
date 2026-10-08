"""Catch-up expiry, bounded continuation and lossless unfinished review queues."""
import copy
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import archive_review as a
import enrich_archive as e
import specialist_catchup as c
import enrich_threat_categories as b
import threat_categories as topics

NOW = datetime(2026, 10, 8, 10, tzinfo=timezone.utc)

class Controls(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        c.write(self.root, c.CONFIG, json.loads((ROOT/c.CONFIG).read_text()))
        self.report = {'categories': {name: {'pending_searches': 10, 'queued_candidates': 0,
            'last_run': {'tasks_done': 2}, 'complete': False} for name in c.LABELS}, 'complete': False}
        c.write(self.root, c.STATUS, self.report)

    def test_today_uses_long_run_and_temporary_bounded_budget(self):
        x = c.configure(self.root, NOW, '1')
        self.assertTrue(x['enabled']); self.assertTrue(x['catchup'])
        self.assertEqual((x['minutes'],x['searches'],x['requests'],x['daily']), (45,2400,120,600))
        c.configure(self.root, NOW, '1')
        self.assertEqual(c.read(self.root,c.STATE)['runs'], ['1'])

    def test_tomorrow_reverts_to_normal_and_never_runs_an_expired_continuation(self):
        tomorrow = datetime(2026,10,9,10,tzinfo=timezone.utc)
        x = c.configure(self.root,tomorrow,'2')
        self.assertEqual(x['daily'],100); self.assertEqual(x['requests'],60)
        self.assertFalse(c.configure(self.root,tomorrow,'3',continuation=True)['enabled'])
        self.assertFalse(c.continuation_decision(self.root,tomorrow)[0])

    def test_one_immediate_next_batch_only_while_work_remains(self):
        self.assertTrue(c.continuation_decision(self.root,NOW)[0])
        for row in self.report['categories'].values():row['pending_searches']=0
        c.write(self.root,c.STATUS,self.report)
        yes, reason = c.continuation_decision(self.root,NOW)
        self.assertFalse(yes); self.assertIn('limitations',reason)
        self.assertFalse(c.read(self.root,c.STATUS)['complete'])

    def test_provider_quota_no_progress_missing_status_and_round_cap_stop_chain(self):
        for mutation in ('quota','progress','missing','cap'):
            with self.subTest(mutation=mutation):
                report=copy.deepcopy(self.report)
                c.write(self.root,c.STATE,{'end_at':'2026-10-08T22:00:00+00:00','runs':[]})
                if mutation=='quota':report['categories'][c.LABELS[0]]['last_run']['stop']='stopped by AISelectionQuotaError: 429'
                if mutation=='progress':
                    for row in report['categories'].values():row['last_run']={'tasks_done':0,'reviewed':0}
                if mutation=='missing':report['categories'].pop(c.LABELS[0])
                if mutation=='cap':c.write(self.root,c.STATE,{'end_at':'2026-10-08T22:00:00+00:00','runs':list(range(18))})
                c.write(self.root,c.STATUS,report)
                self.assertFalse(c.continuation_decision(self.root,NOW)[0])

    def test_unreviewed_candidates_prevent_completion(self):
        for row in self.report['categories'].values():row['pending_searches']=0
        self.report['categories'][c.LABELS[0]]['queued_candidates']=3
        c.write(self.root,c.STATUS,self.report)
        self.assertTrue(c.continuation_decision(self.root,NOW)[0])

    def test_last_round_is_clipped_before_midnight(self):
        late=datetime(2026,10,8,21,50,tzinfo=timezone.utc)
        self.assertEqual(c.configure(self.root,late,'late')['minutes'],8)


class Replay(unittest.TestCase):
    def test_rss_candidates_survive_deadline_and_resume_without_refetch(self):
        collector=a.prepare_collector(a.load_collector(),threshold=60)
        task={'source':'google','locale':'US:en','query':'sample','week':'2026-10-05','code':'en','name':'English',
              'category':topics.CE}
        task['key']=e.task_key(task)
        event={'title':'Police report a concrete extremist incident','summary':'Investigators made arrests.',
               'published':'2026-10-06T10:00:00Z','url':'https://example.test/report','source':'Official'}
        clock=[0.0]
        class Searcher:
            fetches=0
            def available(self,source):return True
            def search(self,t):
                self.fetches+=1;clock[0]=61.0
                return [copy.deepcopy(event)],False
        class Gate:
            remaining=3;posts=0
            def __enter__(self):return self
            def __exit__(self,*args):return False
        with tempfile.TemporaryDirectory() as tmp:
            a.write_json(Path(tmp)/'events.json',{'events':[]})
            source=Searcher()
            args=dict(root=tmp,collector=collector,max_posts=3,max_fetches=100,now=NOW,
                      plan_factory=lambda *x:[task],gate_factory=lambda n:Gate(),
                      log=lambda *x:None,clock=lambda:clock[0],deadline_minutes=1)
            summary,stop=e.run(**args,searcher=source)
            state=e.load_state(tmp)
            self.assertEqual(len(state['pending_reviews']),1)
            self.assertNotIn(task['key'],state['done'])
            self.assertIn('deadline',stop)
            clock[0]=0.0
            calls=[]
            def review(payload):
                calls.append(payload)
                return [{'event_id':item['event_id'],'relevance_score':0} for item in payload]
            source=Searcher()
            summary,stop=e.run(**args,searcher=source,call_batch=review)
            self.assertEqual(source.fetches,0)
            self.assertEqual(len(calls),1)
            state=e.load_state(tmp)
            self.assertEqual(state['pending_reviews'],[])
            self.assertIn(task['key'],state['done'])
            self.assertEqual(summary['reviewed'],1)

    def test_progress_never_double_counts_plan_children_and_reads_review_queue(self):
        with tempfile.TemporaryDirectory() as tmp:
            task={'key':'same','code':'en','source':'google'}
            state=e.load_state(tmp)
            state['children']['same']=task
            state['pending_reviews']=[{'_key':'item','_task':task}]
            e.save_state(tmp,state,state_file='archive/chemical-explosives-enrichment-state.json')
            result=b.progress(tmp,topics.CE,[task])
            self.assertEqual(result['pending_searches'],1)
            self.assertEqual(result['queued_candidates'],1)
            self.assertFalse(result['complete'])
            self.assertFalse(result['processing_complete'])

if __name__=='__main__':unittest.main()
