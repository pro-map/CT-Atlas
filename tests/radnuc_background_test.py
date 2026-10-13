"""Daily RadNuc background reaches only the archive, even on review failure."""
import copy
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
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
            report=daily.run(root,collector=collector,searcher=Searcher(),review=lambda _:[decision()],
                gate_factory=lambda *_:Gate(),max_fetches=1,now=NOW)
            self.assertTrue(report['failed'])
            self.assertEqual(len(archive_review.read_json(root/bg.STATE_FILE)['pending']),2)
            self.assertEqual(archive_review.read_json(root/bg.ARTICLES_FILE)['articles'],[])

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
