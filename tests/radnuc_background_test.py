"""Daily RadNuc background reaches only the archive, even on review failure."""
import copy
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT),str(ROOT/'tools')]
import collector
import radnuc
import radnuc_background as bg
import radnuc_background_topics as topics
import enrich_radnuc_background as daily
import archive_review
import sync_background_corpus as sync
import archive_dedup

NOW=datetime(2026,10,13,10,tzinfo=timezone.utc)


def candidate(index=0, **extra):
    return {'title':f'Country publishes nuclear industry policy {index}',
            'summary':'New licensing and construction rules were announced by the regulator.',
            'url':f'https://authority.test/policy/{index}', 'source':'Regulator',
            'published':NOW.isoformat(), 'original_language':'en',**extra}


def decision(identifier='0', topic=None, **extra):
    return {'event_id':identifier,'keep_background':True,'is_operational_event':False,'is_anti_war':False,
            'topic_ids':[topic or topics.topic_ids()[0]],'english_title':'Nuclear regulator updates construction licensing rules',
            'english_summary':'The regulator announced new nuclear industry licensing rules.',
            'original_language':'en','reason':'Regulatory industry background.',**extra}


class Gate:
    posts=0
    remaining=6
    def __enter__(self):return self
    def __exit__(self,*_):return False


class BackgroundTests(unittest.TestCase):
    def setUp(self):
        sleeper = patch.object(daily.time, 'sleep')
        sleeper.start()
        self.addCleanup(sleeper.stop)

    def test_transient_http_retries_are_counted_and_cannot_exceed_the_existing_gate(self):
        responses=[SimpleNamespace(status_code=503),SimpleNamespace(status_code=200,json=lambda:{})]
        with patch.dict('os.environ',{'GEMINI_API_KEY':'synthetic-test-key'}), \
             patch.object(collector.requests,'post',side_effect=responses) as post, \
             patch.object(collector,'extract_interaction_text',return_value=json.dumps({'results':[decision()]})):
            with archive_review.GeminiGate(collector,2,min_interval=0) as gate:
                result=daily.call_review(collector,[{'event_id':'0'}])
            self.assertEqual(len(result),1)
            self.assertEqual(gate.posts,2)
            self.assertEqual(post.call_count,2)
        with patch.dict('os.environ',{'GEMINI_API_KEY':'synthetic-test-key'}), \
             patch.object(collector.requests,'post',return_value=SimpleNamespace(status_code=503)) as post:
            with archive_review.GeminiGate(collector,1,min_interval=0) as gate:
                with self.assertRaises(archive_review.BudgetReached):
                    daily.call_review(collector,[{'event_id':'0'}])
            self.assertEqual(gate.posts,1)
            self.assertEqual(post.call_count,1)

    def test_nonretryable_http_error_preserves_a_specific_safe_status(self):
        with patch.dict('os.environ',{'GEMINI_API_KEY':'synthetic-test-key'}), \
             patch.object(collector.requests,'post',return_value=SimpleNamespace(status_code=403)) as post:
            with self.assertRaises(daily.BackgroundHTTPError) as error:
                daily.call_review(collector,[{'event_id':'0'}])
            self.assertEqual(error.exception.status,403)
            self.assertEqual(post.call_count,1)

    def test_one_unanswerable_candidate_does_not_block_a_valid_sibling(self):
        with tempfile.TemporaryDirectory() as tmp:
            class Searcher:
                def search(self,task):return [candidate(1),candidate(2)],False
            def review(payload):
                return [decision(row['event_id']) for row in payload if row['title'].endswith('2')]
            report=daily.run(tmp,collector=collector,searcher=Searcher(),review=review,
                gate_factory=lambda *_:Gate(),max_fetches=1,now=NOW)
            self.assertEqual(report['counts']['accepted'],1)
            self.assertEqual(report['batch_status'],'partial')
            self.assertFalse(report['complete'])
            self.assertFalse(report['failed'])
            saved=archive_review.read_json(Path(tmp)/bg.ARTICLES_FILE)['articles']
            self.assertEqual([row['url'] for row in saved],[candidate(2)['url']])
            pending=archive_review.read_json(Path(tmp)/bg.STATE_FILE)['pending']
            self.assertEqual([row['url'] for row in pending],[candidate(1)['url']])

    def test_model_output_cutoff_splits_the_batch_instead_of_stopping_the_whole_update(self):
        with tempfile.TemporaryDirectory() as tmp:
            class Searcher:
                def search(self,task):return [candidate(1),candidate(2)],False
            calls=[]
            def review(payload):
                calls.append(len(payload))
                if len(payload)>1:
                    raise collector.AISelectionIncompleteError('Gemini interaction status=incomplete')
                return [decision(payload[0]['event_id'],english_title=payload[0]['title'])]
            report=daily.run(tmp,collector=collector,searcher=Searcher(),review=review,
                gate_factory=lambda *_:Gate(),max_fetches=1,now=NOW)
            self.assertEqual(calls,[2,1,1])
            self.assertTrue(report['review_complete'])
            self.assertFalse(report['complete'])
            self.assertEqual(report['counts']['reviewed'],2)
            self.assertEqual(report['review_validation_errors']['interaction_incomplete'],1)

    def test_partial_response_shrinks_the_next_batch_without_discarding_unresolved_inputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            class Searcher:
                def search(self,task):return [candidate(i) for i in range(8)],False
            calls=[]
            def review(payload):
                calls.append(len(payload))
                chosen=payload[:1] if len(calls)==1 else payload
                return [decision(row['event_id'],english_title=row['title']) for row in chosen]
            report=daily.run(tmp,collector=collector,searcher=Searcher(),review=review,
                gate_factory=lambda *_:Gate(),max_fetches=1,now=NOW)
            self.assertEqual(calls[:2],[8,4])
            self.assertEqual(report['counts']['reviewed'],8)
            self.assertEqual(report['pending_reviews'],0)
            self.assertTrue(report['review_complete'])
            self.assertFalse(report['complete'])

    def test_twenty_request_envelope_counts_http_retries_and_preserves_the_remaining_queue(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            archive_review.write_json(root/bg.STATE_FILE,{'version':1,'seen':{},'cursor':0,
                'pending':[candidate(i) for i in range(200)]})
            class Searcher:
                def search(self,task):return [],False
            attempts=[]
            def post(url,**kwargs):
                attempts.append(url)
                return SimpleNamespace(status_code=200)
            def review(payload):
                # Two actual HTTP attempts per batch; the request gate, not
                # the number of successful batches, controls the envelope.
                for _ in range(2):collector.requests.post(collector.GEMINI_INTERACTIONS_URL)
                return [decision(row['event_id'],english_title=row['title']) for row in payload]
            with patch.object(collector.requests,'post',side_effect=post):
                report=daily.run(root,max_posts=20,max_fetches=1,collector=collector,
                    searcher=Searcher(),review=review,now=NOW,
                    gate_factory=lambda budget:archive_review.GeminiGate(collector,budget,min_interval=0))
            self.assertEqual(report['counts']['requests'],20)
            self.assertEqual(len(attempts),20)
            self.assertEqual(report['counts']['reviewed'],80)
            self.assertEqual(report['recent_pending'],120)
            self.assertEqual(len(archive_review.read_json(root/bg.STATE_FILE)['pending']),120)
            self.assertEqual(report['shared_daily_review_allocation'],40)
            self.assertEqual(report['batch_status'],'partial')

    def test_full_queue_is_reviewed_before_discovery_and_recent_new_input_precedes_old_queue(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            old=candidate(0,published=(NOW-timedelta(days=4)).isoformat())
            carried=[candidate(i,published=(NOW-timedelta(days=1)).isoformat()) for i in range(1,500)]
            archive_review.write_json(root/bg.STATE_FILE,{'version':1,'seen':{},'cursor':0,'pending':[old,*carried]})
            order=[];batches=[]
            class Searcher:
                def search(self,task):
                    order.append('search')
                    self_outer.assertLess(len(archive_review.read_json(root/bg.STATE_FILE)['pending']),daily.MAX_PENDING)
                    return [candidate(500)],False
            self_outer=self
            def review(payload):
                order.append('review');batches.append([row['title'] for row in payload])
                collector.requests.post(collector.GEMINI_INTERACTIONS_URL)
                return [decision(row['event_id'],english_title=row['title']) for row in payload]
            with patch.object(collector.requests,'post',return_value=SimpleNamespace(status_code=200)):
                report=daily.run(root,max_posts=2,max_fetches=1,collector=collector,
                    searcher=Searcher(),review=review,now=NOW,
                    gate_factory=lambda budget:archive_review.GeminiGate(collector,budget,min_interval=0))
            self.assertEqual(order,['review','search','review'])
            self.assertEqual(batches[1][0],candidate(500)['title'])
            self.assertNotIn(old['title'],[title for batch in batches for title in batch])
            self.assertEqual(report['counts']['recent_reviewed'],16)
            self.assertEqual(report['counts']['backlog_reviewed'],0)
            self.assertEqual(report['backlog_pending'],1)
            self.assertEqual(report['recent_pending'],484)
            self.assertEqual(report['pending_reviews'],485)
            self.assertEqual(report['source_discovery']['searched_queries'],1)
            self.assertEqual(report['source_discovery']['pending_queries'],49)

    def test_existing_backlog_is_reviewed_only_after_recent_without_historical_searches(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            archive_review.write_json(root/bg.STATE_FILE,{'version':1,'seen':{},'cursor':0,
                'pending':[candidate(0,published=(NOW-timedelta(days=5)).isoformat()),candidate(1),
                    candidate(2,published='')]})
            batches=[]
            def review(payload):
                batches.append([row['title'] for row in payload])
                return [decision(row['event_id'],english_title=row['title']) for row in payload]
            report=daily.run(root,max_fetches=0,collector=collector,review=review,
                gate_factory=lambda *_:Gate(),now=NOW)
            self.assertEqual(batches,[[candidate(1)['title']],[candidate(0)['title']],[candidate(2)['title']]])
            self.assertEqual(report['counts']['recent_reviewed'],1)
            self.assertEqual(report['counts']['backlog_reviewed'],1)
            self.assertEqual(report['counts']['undated_reviewed'],1)
            self.assertFalse(report['backfill'])
            self.assertTrue(report['review_complete'])
            self.assertFalse(report['complete'])

    def test_empty_review_queue_does_not_claim_unsearched_sources_are_complete(self):
        with tempfile.TemporaryDirectory() as tmp:
            class Searcher:
                def search(self,task):return [],False
            report=daily.run(tmp,max_fetches=1,collector=collector,searcher=Searcher(),
                review=lambda _:[],gate_factory=lambda *_:Gate(),now=NOW)
            self.assertEqual(report['pending_reviews'],0)
            self.assertTrue(report['review_complete'])
            self.assertFalse(report['complete'])
            self.assertEqual(report['batch_status'],'partial')
            self.assertEqual(report['source_discovery']['planned_queries'],50)
            self.assertEqual(report['source_discovery']['pending_queries'],49)
            self.assertEqual(report['source_discovery']['stop_code'],'fetch_limit_reached')

    def test_unchanged_shared_daily_ledger_limits_the_larger_run_envelope(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            archive_review.write_json(root/bg.STATE_FILE,{'version':1,'seen':{},'cursor':0,
                'pending':[candidate(i) for i in range(40)]})
            ledger_path=archive_review.ledger_path('archive-review',root)
            archive_review.write_json(ledger_path,{'pacific_day':archive_review.pacific_day(NOW),'posts':39,'allocation':40})
            def review(payload):
                collector.requests.post(collector.GEMINI_INTERACTIONS_URL)
                return [decision(row['event_id'],english_title=row['title']) for row in payload]
            with patch.object(collector.requests,'post',return_value=SimpleNamespace(status_code=200)):
                report=daily.run(root,max_fetches=0,collector=collector,review=review,now=NOW,
                    gate_factory=lambda budget:archive_review.GeminiGate(collector,budget,min_interval=0))
            self.assertEqual(report['requests_available_at_start'],1)
            self.assertEqual(report['counts']['requests'],1)
            self.assertEqual(report['counts']['reviewed'],8)
            self.assertEqual(report['recent_pending'],32)

    def test_ten_user_topics_and_all_shared_languages_are_daily_archive_only(self):
        self.assertEqual(len(topics.topic_ids()),10)
        self.assertEqual(topics.vocabulary()['category'],bg.CATEGORY)
        self.assertTrue(topics.vocabulary()['archive_only'])
        self.assertEqual(topics.vocabulary()['collection'],'daily_only')
        tasks=daily.plan_queries(collector,NOW)
        self.assertEqual(len(tasks),50)
        self.assertEqual({t['code'] for t in tasks},set(radnuc.LEXICONS))
        self.assertTrue(all(datetime.fromisoformat(t['start']).date()==(NOW-timedelta(days=3)).date() for t in tasks))
        self.assertEqual(len(topics.queries('en')),10)
        self.assertIn('anti-war',topics.SELECTION_NOTE.lower())

    def test_every_topic_uses_one_rn_filing_without_ct_scores_or_map_linkage(self):
        for topic in topics.topic_ids():
            row=bg.article(candidate(),decision(topic=topic),NOW)
            self.assertTrue(bg.valid_article(row))
            self.assertEqual(row['categories'],[bg.CATEGORY])
            self.assertIsNone(row['ai_relevance_score'])
            self.assertFalse(row['ai_selected']);self.assertFalse(row['ai_current_ct_event'])
            self.assertNotIn('latitude',row);self.assertNotIn('incident_id',row)
            self.assertIsNone(row['parent_event_id'])

    def test_operational_and_anti_war_decisions_never_become_background(self):
        for field in ('is_operational_event','is_anti_war'):
            bad=decision(**{field:True})
            with self.assertRaises(ValueError):daily.validate_results({'results':[bad]},[{'event_id':'0'}])
            self.assertIsNone(bg.article(candidate(),bad,NOW))

    def test_partial_duplicate_ids_and_unknown_topics_leave_the_batch_unaccepted(self):
        for rows in ([decision()], [decision(),decision()], [decision(),decision('1',topic_ids=['invented'])]):
            with self.assertRaises(ValueError):
                daily.validate_results({'results':rows},[{'event_id':'0'},{'event_id':'1'}])

    def test_map_selection_cannot_promote_an_archive_only_row_even_at_score_100(self):
        row=bg.article(candidate(),decision(),NOW)
        self.assertFalse(collector.apply_ai_selection(row,{
            'relevance_score':100,'categories':[bg.CATEGORY,'Attacks'],'is_current_ct_event':True}))
        self.assertFalse(row['ai_selected']);self.assertFalse(row['ai_current_ct_event'])
        self.assertEqual(row['categories'],[bg.CATEGORY])

    def test_daily_ingestion_deduplicates_and_writes_no_map_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            map_files={name:root/name for name in ('events.json','events-lite.json','events-map.json')}
            for p in map_files.values():p.write_text('{"events":[]}')
            original={p:p.read_bytes() for p in map_files.values()}
            class Searcher:
                def search(self,task):return [candidate(),candidate()],False
            review=lambda payload:[decision(p['event_id']) for p in payload]
            one=daily.run(root,collector=collector,searcher=Searcher(),review=review,gate_factory=lambda *_:Gate(),
                          max_fetches=1,now=NOW)
            two=daily.run(root,collector=collector,searcher=Searcher(),review=review,gate_factory=lambda *_:Gate(),
                          max_fetches=1,now=NOW)
            self.assertEqual(one['counts']['accepted'],1);self.assertEqual(two['counts']['reviewed'],0)
            articles=archive_review.read_json(root/bg.ARTICLES_FILE)['articles']
            self.assertEqual(len(articles),1)
            self.assertEqual(original,{p:p.read_bytes() for p in map_files.values()})

    def test_failed_ai_review_preserves_candidates_without_adding_articles(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            class Searcher:
                def search(self,task):return [candidate(1),candidate(2)],False
            report=daily.run(root,collector=collector,searcher=Searcher(),review=lambda _:[],
                gate_factory=lambda *_:Gate(),max_fetches=1,now=NOW)
            self.assertTrue(report['failed'])
            self.assertEqual(len(archive_review.read_json(root/bg.STATE_FILE)['pending']),2)
            self.assertEqual(archive_review.read_json(root/bg.ARTICLES_FILE)['articles'],[])

    def test_partial_siblings_are_matched_by_id_and_unresolved_rows_stay_pending(self):
        with tempfile.TemporaryDirectory() as tmp:
            class Searcher:
                def search(self,task):return [candidate(1),candidate(2)],False
            calls=[]
            def review(payload):
                calls.append(payload)
                return [decision('1'),decision('0',is_operational_event=True)] if len(calls)==1 else []
            report=daily.run(tmp,collector=collector,searcher=Searcher(),review=review,
                gate_factory=lambda *_:Gate(),max_fetches=1,now=NOW)
            saved=archive_review.read_json(Path(tmp)/bg.ARTICLES_FILE)['articles']
            self.assertEqual([row['url'] for row in saved],[candidate(2)['url']])
            pending=archive_review.read_json(Path(tmp)/bg.STATE_FILE)['pending']
            self.assertEqual([row['url'] for row in pending],[candidate(1)['url']])
            self.assertEqual(report['counts']['accepted'],1)
            self.assertLessEqual(len(calls),6)
            self.assertFalse(report['failed'])

    def test_duplicate_decisions_are_all_withheld_and_numeric_wire_ids_are_unambiguous(self):
        payload=[{'event_id':'0'},{'event_id':'1'}]
        valid,issues=daily.partition_results([decision('0'),decision('0'),decision(1)],payload)
        self.assertEqual([i for i,_ in valid],[1])
        self.assertEqual(issues['Invalid background review identifier'],2)

    def test_three_day_window_excludes_old_undated_and_future_candidates(self):
        with tempfile.TemporaryDirectory() as tmp:
            class Searcher:
                def search(self,task):return [candidate(1,published=(NOW-timedelta(days=180)).isoformat()),
                    candidate(2,published=''),candidate(3,published=(NOW+timedelta(days=1)).isoformat())],False
            review=lambda _:(_ for _ in ()).throw(AssertionError('Nothing should be reviewed'))
            report=daily.run(tmp,collector=collector,searcher=Searcher(),review=review,
                gate_factory=lambda *_:Gate(),max_fetches=1,now=NOW)
            self.assertEqual(report['counts']['reviewed'],0)

    def test_archive_sync_retains_purpose_and_files_only_under_rn(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);row=bg.article(candidate(),decision(),NOW)
            archive_review.write_json(root/bg.ARTICLES_FILE,{'articles':[row,{**row,'ai_selected':True}]})
            articles,_=sync.collect_articles(root)
            self.assertEqual(len(articles),1)
            self.assertEqual(articles[0]['kind'],bg.KIND)
            self.assertEqual(articles[0]['categories'],[bg.CATEGORY])
            insert,_=archive_dedup.plan_archive([],articles)
            self.assertEqual(len(insert),1)

    def test_existing_off_topic_verdict_can_be_refiled_as_reviewed_rn_background(self):
        row=bg.article(candidate(),decision(),NOW)
        stored=[{'url':row['url'],'kind':'rejected_candidate','ai_relevance_score':0,
                 'category':'Other','categories':'["Other"]','primary_event_type':'OTHER'}]
        changed=sync.reconcile(stored,[{**row,'_authoritative':True}])
        self.assertEqual(len(changed),1)
        self.assertEqual(stored[0]['kind'],bg.KIND)
        self.assertEqual(stored[0]['categories'],json.dumps([bg.CATEGORY]))
        self.assertEqual(stored[0]['primary_event_type'],'BACKGROUND_INFO')
        self.assertFalse(archive_dedup.is_noise(stored[0]))


if __name__=='__main__':unittest.main()

