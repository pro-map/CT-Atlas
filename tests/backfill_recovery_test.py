"""Regressions for the actual interrupted/green-but-incomplete backfill failures."""
import copy
import itertools
import json
import sys
import tempfile
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT/'tools')]
import archive_review as a
import backfill_query as q
import enrich_archive as e
import enrich_threat_categories as b
import specialist_catchup as c
import collector
import threat_categories as topics

NOW = datetime(2026,10,9,8,tzinfo=timezone.utc)


def task(query='(alpha OR beta) (incident OR investigation)', source='google'):
    row = {'source':source,'query':query,'locale':'US:en','code':'en','name':'English',
           'week':'2026-10-05','start':'2026-10-06','end':'2026-10-07','category':topics.CE,
           'hl':'en-US','gl':'US','ceid':'US:en'}
    row['key'] = e.task_key(row)
    return row


def event(n=0):
    return {'title':f'Police report incident number {n}','summary':'A concrete investigation is reported.',
            'source':'Official','url':f'https://example.test/incident/{n}',
            'published':'2026-10-06T10:00:00Z'}


class QueryCompatibility(unittest.TestCase):
    def terms(self, query):
        return {tuple(term.strip('"') for term in pair) for pair in itertools.product(*q.groups(query))}

    def test_short_acronyms_unquoted_but_phrases_preserved(self):
        result=q.gdelt_queries('("ABC" OR "chemical incident") ("arrested" OR "investigation")')
        self.assertEqual(result,['(ABC OR "chemical incident") (arrested OR investigation)'])

    def test_splitting_is_equivalent_not_truncation_or_context_removal(self):
        source='("one long material phrase" OR "another long material phrase" OR "third specific phrase") ("arrested" OR "investigation" OR "prosecution")'
        result=q.gdelt_queries(source,max_bytes=85)
        self.assertGreater(len(result),1)
        self.assertTrue(all(len(x.encode())<=85 for x in result))
        self.assertEqual(set().union(*(self.terms(x) for x in result)),self.terms(source))

    def test_all_real_gdelt_queries_fit_and_keep_all_term_context_pairs(self):
        for category in topics.LABELS:
            raw=b.raw_plan_tasks(category,date(2026,10,8),collector)
            for original in {t['query'] for t in raw if t['source']=='gdelt'}:
                with self.subTest(category=category,query=original):
                    children=q.gdelt_queries(original)
                    self.assertTrue(all(len(x.encode())<=q.GDELT_QUERY_BYTES for x in children))
                    self.assertEqual(self.terms(original),set().union(*(self.terms(x) for x in children)))

    def test_native_task_keys_unchanged_and_repaired_keys_are_distinct(self):
        native=task()
        self.assertEqual(q.provider_tasks(native,e.task_key),[native])
        gdelt=task('("ABC" OR "chemical incident") ("arrested" OR "investigation")','gdelt')
        fixed=q.provider_tasks(gdelt,e.task_key)
        self.assertTrue(all(t['key']!=gdelt['key'] for t in fixed))
        self.assertTrue(all(t['legacy_query_key']==gdelt['key'] for t in fixed))

    def test_saturated_single_day_can_be_split_without_losing_context(self):
        original=task()
        children=q.split_saturated(original,e.task_key)
        self.assertEqual(len(children),2)
        self.assertEqual(self.terms(original['query']),set().union(*(self.terms(t['query']) for t in children)))
        self.assertEqual({e.window(t) for t in children},{e.window(original)})

    def test_nested_unsupported_expression_is_not_silently_modified(self):
        with self.assertRaises(ValueError):q.gdelt_queries('((alpha OR beta) OR gamma) delta')


class ReviewPriority(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup)
        self.root=Path(tmp.name);a.write_json(self.root/'events.json',{'events':[]})
        self.clock=[0.0];self.sequence=[];self.gate=None
        self.collector=a.prepare_collector(a.load_collector(ROOT),threshold=60)

    def run_work(self,plan,search,**options):
        outer=self
        class Source:
            fetches=0
            def available(self,source):return True
            def search(self,t):
                self.fetches+=1;outer.sequence.append('search')
                return search(t)
        class Gate:
            posts=0
            def __init__(self,n):self.max_posts=n
            @property
            def remaining(self):return self.max_posts-self.posts
            def __enter__(self):outer.gate=self;return self
            def __exit__(self,*args):return False
        def review(payload):
            self.sequence.append('review');self.gate.posts+=1
            return [{'event_id':item['event_id'],'relevance_score':0} for item in payload]
        source=Source()
        result=e.run(self.root,self.collector,20,100,today=NOW.date(),now=NOW,
            plan_factory=lambda *_:plan,searcher=source,call_batch=review,gate_factory=Gate,
            clock=lambda:self.clock[0],deadline_minutes=2,log=lambda *_:None,review_first=True,**options)
        return result,source

    def test_saved_partial_batch_is_reviewed_before_any_new_search(self):
        old,new=task(),task('(delta OR gamma) investigation')
        state=e.load_state(self.root)
        state['pending_reviews']=[{**event(), '_key':e.article_keys(event()['title'],'Official')[0], '_task':old}]
        e.save_state(self.root,state)
        (summary,_),_=self.run_work([old,new],lambda t:([],False))
        self.assertEqual(self.sequence[0],'review')
        self.assertEqual(summary['reviewed'],1)
        self.assertEqual(e.load_state(self.root)['pending_reviews'],[])

    def test_fresh_partial_batch_flushes_before_deadline_reserve(self):
        one,two=task(),task('(delta OR gamma) investigation')
        def search(t):
            self.clock[0]+=85
            return [event()],False
        (summary,_),_=self.run_work([one,two],search)
        self.assertEqual(self.sequence[:2],['search','review'])
        self.assertEqual(summary['reviewed'],1)

    def test_native_queries_are_prioritized_over_refusing_optional_provider(self):
        gdelt,native=task(source='gdelt'),task()
        searched=[]
        def search(t):searched.append(t['source']);return [],False
        self.run_work([gdelt,native],search,prioritize_native=True)
        self.assertEqual(searched,['google','gdelt'])

    def test_rejected_query_is_recorded_separately_from_successful_work(self):
        t=task(source='gdelt')
        def search(_):raise e.QueryRejected('bad expression')
        (summary,_),_=self.run_work([t],search)
        state=e.load_state(self.root)
        self.assertEqual(summary['fetched'],0)
        self.assertIn(t['key'],state['rejected_queries'])
        self.assertEqual(state['rejected_queries'][t['key']]['task'],t)
        e.save_state(self.root,state,state_file='archive/chemical-explosives-enrichment-state.json')
        row=b.progress(self.root,topics.CE,[t])
        self.assertEqual(row['successful_main_queries'],0)
        self.assertEqual(row['rejected_queries'],1)
        self.assertFalse(row['complete'])

    def test_single_day_saturation_refines_query_instead_of_claiming_coverage(self):
        t=task()
        def search(current):return ([],current['key']==t['key'])
        (summary,_),_=self.run_work([t],search,refine_saturated=True)
        self.assertEqual(summary['split'],1)
        state=e.load_state(self.root)
        self.assertEqual(state['saturated_queries'],{})
        self.assertEqual(summary['fetched'],3)

    def test_one_gdelt_refusal_opens_shared_circuit_without_retry_loop(self):
        seen=[]
        fake=SimpleNamespace(requests=SimpleNamespace(RequestException=RuntimeError),GDELT_DOC_SEARCH_URL='https://example.test')
        source=b.SpecialistSearcher(fake,sleep=lambda _:None)
        with patch.object(source,'_gdelt_answer',side_effect=lambda t:seen.append(t) or None):
            with self.assertRaises(e.SourceUnavailable):source.search(task(source='gdelt'))
        self.assertEqual(len(seen),1)
        self.assertFalse(source.available('gdelt'))
        self.assertTrue(source.available('google'))


class CompleteSnapshots(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup);self.root=Path(tmp.name)
        a.write_json(self.root/'events.json',{'events':[]})
        b.manifest(self.root,NOW.date())
        self.tasks={name:[task(query='(alpha OR beta) investigation')] for name in topics.LABELS}
        for name in topics.LABELS:
            state=e.load_state(self.root)
            state['done'][self.tasks[name][0]['key']]=NOW.isoformat()
            e.save_state(self.root,state,state_file=f'archive/{b.PREFIXES[name]}-enrichment-state.json')

    def test_partial_report_is_reconstructed_from_all_durable_states(self):
        a.write_json(self.root/b.STATUS,{'categories':{topics.CE:{'last_run':{'reviewed':5}}}})
        with patch.object(a,'load_collector',return_value=collector),patch.object(b,'plan_tasks',side_effect=lambda c,*_:self.tasks[c]):
            report=b.refresh_status(self.root,'interrupted')
        self.assertEqual(set(report['categories']),set(topics.LABELS))
        self.assertTrue(all(x['completed_searches']==1 for x in report['categories'].values()))
        self.assertEqual(report['batch_status'],'interrupted')

    def test_interruption_keeps_other_categories_not_yet_reached(self):
        # Ensure all three have genuine open work, then interrupt the first.
        for name in topics.LABELS:
            e.save_state(self.root,e.load_state('/nonexistent'),state_file=f'archive/{b.PREFIXES[name]}-enrichment-state.json')
        class Output:
            integrated=0
            database={'events':[]}
            def __init__(self,*args,**kwargs):pass
            def save(self):pass
        with patch.object(a,'load_collector',return_value=collector),patch.object(b,'plan_tasks',side_effect=lambda c,*_:self.tasks[c]),patch.object(b.enrich_radnuc,'IntegratedOutput',Output),patch.object(e,'run',side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):b.run(self.root,today=NOW.date(),log=lambda *_:None)
        report=a.read_json(self.root/b.STATUS)
        self.assertEqual(report['batch_status'],'interrupted')
        self.assertEqual(set(report['categories']),set(topics.LABELS))
        self.assertTrue(all(x['planned_searches']==1 for x in report['categories'].values()))
        self.assertFalse(report['complete'])

    def test_health_does_not_return_green_for_a_blocked_batch(self):
        a.write_json(self.root/c.STATUS,{'batch_status':'blocked','categories':{name:{} for name in topics.LABELS}})
        self.assertEqual(c.health(self.root),1)

    def test_first_round_is_short_validation_then_normal_catchup_rounds(self):
        config=json.loads((ROOT/c.CONFIG).read_text())
        config.update(start_at='2026-10-09T07:00:00+00:00',end_at='2026-10-09T22:00:00+00:00',first_round_minutes=6)
        c.write(self.root,c.CONFIG,config)
        self.assertEqual(c.configure(self.root,NOW,'first')['minutes'],6)
        self.assertEqual(c.configure(self.root,NOW,'next')['minutes'],45)


if __name__=='__main__':unittest.main()
