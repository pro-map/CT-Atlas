"""Cancelled RN history must stay stopped without changing daily or checkpoints."""
import copy
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'tools')]
import collector
import backfill_control as control
import threat_categories as topics
import enrich_radnuc as rn
import enrich_threat_categories as specialist
import enrich_archive as archive
import specialist_catchup as catchup
import enrich_chinese_map as chinese
import backfill_gdelt_acled as gdelt
import groq_backfill_runtime as groq_runtime
import daily_pipeline


class BackfillCancellation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root/control.CONFIG).write_text(json.dumps({'disabled_categories':[topics.RN]}))

    def test_global_stop_blocks_every_discovery_entrypoint_without_touching_checkpoints(self):
        (self.root/control.CONFIG).write_text(json.dumps({'historical_enabled': False}))
        checkpoint = self.root / 'archive/saved-state.json'
        checkpoint.parent.mkdir()
        checkpoint.write_text('{"saved":"unchanged"}')
        before = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        with patch('requests.sessions.Session.request', side_effect=AssertionError('No network')), \
             patch.object(archive, 'load_state', side_effect=AssertionError('No replay')), \
             patch.object(archive.archive_review, 'load_collector', side_effect=AssertionError('No collector load')), \
             patch.object(collector, 'parse_collection_mode', return_value=(True, 'backfill')), \
             patch.object(collector, '__file__', str(self.root/'collector.py')), \
             patch.object(collector.collection_config, 'validate_runtime', side_effect=AssertionError('Must stop first')), \
             patch.object(gdelt, 'ROOT', self.root), \
             patch.object(gdelt.collector, 'load_database_strict', side_effect=AssertionError('No database replay')):
            for backend in (rn, specialist, chinese):
                self.assertEqual(backend.run(self.root)['backfill_status'], 'cancelled')
            summary, reason = archive.run(self.root, collector, 100, 100)
            self.assertTrue(all(value == 0 for value in summary.values()))
            self.assertIn('cancelled', reason)
            collector.main()
            gdelt.main()
            now = datetime.now(timezone.utc)
            self.assertFalse(catchup.configure(self.root, now, 'cancelled')['enabled'])
            self.assertFalse(catchup.continuation_decision(self.root, now)[0])
            for maintenance in (False, True):
                self.assertFalse(groq_runtime.preflight(self.root, maintenance=maintenance)['run_needed'])
        after = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(before, {path: after[path] for path in before})
        self.assertEqual(set(after) - set(before), {Path(chinese.STATUS)})
        self.assertEqual(json.loads(after[Path(chinese.STATUS)])['backfill_status'], 'cancelled')

    def test_global_control_requires_a_boolean_and_defaults_to_legacy_enabled(self):
        self.assertTrue(control.history_enabled(self.root))
        for invalid in ('false', 0, None):
            (self.root/control.CONFIG).write_text(json.dumps({'historical_enabled': invalid}))
            with self.assertRaises(ValueError):
                control.history_enabled(self.root)

    def test_production_stop_preserves_recent_bio_and_daily_language_queries(self):
        self.assertFalse(control.history_enabled(ROOT))
        self.assertFalse(control.enabled(ROOT, topics.BIO))
        self.assertIn(topics.BIO, control.disabled_categories(ROOT))
        self.assertIn(topics.BIO, collector.CORE_SEARCH_QUERIES)
        for profile in collector.MULTILINGUAL_PROFILES:
            self.assertIn(topics.BIO, {query['category'] for query in profile['queries']})
        now = datetime.now(timezone.utc)
        def candidate(name, age):
            return {'id': name, 'title': 'Police investigate a biological terror threat '+name,
                    'url': 'https://example.org/'+name, 'category': topics.BIO,
                    'categories': [topics.BIO], 'published': (now-timedelta(days=age)).isoformat()}
        recent, backlog, dropped = daily_pipeline.partition(
            [candidate('recent', 1), candidate('historical', 20)], collector, now,
            control.disabled_categories(ROOT))
        self.assertEqual([item['id'] for item in recent], ['recent'])
        self.assertEqual(backlog, [])
        self.assertEqual(dropped['cancelled_history'], 1)

    def test_direct_rn_and_explicit_specialist_requests_cannot_restart_or_touch_state(self):
        state = self.root/'archive/radnuc-enrichment-state.json'
        state.parent.mkdir()
        state.write_text('{"saved": "unchanged"}')
        before = state.read_bytes()
        with patch.object(rn.archive_review, 'load_collector', side_effect=AssertionError('Must not start')):
            self.assertEqual(rn.run(self.root)['backfill_status'], 'cancelled')
            result = specialist.run(self.root, categories=[topics.RN])
        self.assertEqual(result['requests_this_run'], 0)
        self.assertEqual(state.read_bytes(), before)

    def test_mixed_backend_skips_rn_recovery_and_checkpoint_repair(self):
        output = Mock(database={'events':[]}, integrated=0)
        with patch.object(specialist.archive_review, 'load_collector', return_value=collector), \
             patch.object(specialist, 'repair_children') as repair, \
             patch.object(rn, 'IntegratedOutput', return_value=output) as recover, \
             patch.object(specialist.groq_backfill, 'enabled', return_value=False):
            report = specialist.run(self.root, max_posts=0, max_fetches=0, log=lambda *_:None)
        self.assertEqual({call.args[1] for call in repair.call_args_list}, {topics.CE,topics.BIO})
        self.assertEqual({call.kwargs['category'] for call in recover.call_args_list}, {topics.CE,topics.BIO})
        self.assertEqual(report['categories'][topics.RN]['backfill_status'], 'cancelled')
        self.assertFalse(report['categories'][topics.RN]['complete'])
        self.assertFalse((self.root/'archive/radnuc-enrichment-state.json').exists())

    def test_generic_history_skips_rn_roots_children_and_reviews_without_erasing_them(self):
        task = {'source':'google','locale':'en','query':'RN','week':'2026-10-05',
                'category':topics.RN,'code':'en','name':'English'}
        task['key'] = archive.task_key(task)
        child = {**task,'query':'RN child'}
        child['key'] = archive.task_key(child)
        active = {**task,'category':topics.CE,'query':'chemical'}
        active['key'] = archive.task_key(active)
        candidate = {'_key':'candidate','_task':task,'title':'Saved RN candidate'}
        state = archive.load_state(self.root)
        state.update(children={child['key']:child},pending_reviews=[candidate],
                     done={'old-rn-key':'saved'})
        archive.save_state(self.root,state)
        class Searcher:
            fetches = 0
            def available(self, source): return True
            def search(self, query):
                self.assert_task = query
                if query['category'] == topics.RN: raise AssertionError('Cancelled RN search')
                self.fetches += 1
                return [],False
        class Gate:
            remaining = 1
            posts = 0
            def __enter__(self): return self
            def __exit__(self,*_): return False
        searcher = Searcher()
        with patch.object(archive.archive_review, 'DailyLedger') as ledger:
            ledger.return_value.budget.return_value = 1
            ledger.return_value.used = 0
            archive.run(self.root,collector,1,10,searcher=searcher,
                plan_factory=lambda *_:[task,active,{'key':'old-rn-key','category':topics.RN}],
                gate_factory=lambda *_:Gate(), known_keys_factory=lambda *_:set(),
                reuse_previous_reviews=False,log=lambda *_:None)
        saved = archive.load_state(self.root)
        self.assertEqual(searcher.fetches,1)
        self.assertEqual(saved['pending_reviews'],[candidate])
        self.assertEqual(saved['children'],{child['key']:child})
        self.assertEqual(saved['done']['old-rn-key'],'saved')
        self.assertNotIn(task['key'],saved['done'])

    def test_legacy_backfill_queries_can_be_removed_without_mutating_daily(self):
        names = ('CATEGORIES','CORE_SEARCH_QUERIES','OFFICIAL_SOURCE_QUERIES',
                 'TARGETED_MEDIA_CATEGORY_TERMS','MULTILINGUAL_PROFILES')
        daily = {name:copy.deepcopy(getattr(collector,name)) for name in names}
        historical = copy.deepcopy(daily)
        control.apply_to_collector(historical,self.root)
        self.assertNotIn(topics.RN,historical['CATEGORIES'])
        self.assertIn(topics.RN,daily['CATEGORIES'])
        for p in historical['MULTILINGUAL_PROFILES']:
            self.assertFalse(any(q.get('category')==topics.RN for q in p['queries']))
        self.assertEqual(daily,{name:getattr(collector,name) for name in names})

    def test_cancelled_work_does_not_drive_continuation_or_claim_completion(self):
        report = {'categories':{topics.RN:{'backfill_status':'cancelled','pending_searches':9000,
                                          'queued_candidates':100,'complete':False},
                                topics.CE:{'pending_searches':0,'complete':True},
                                topics.BIO:{'pending_searches':0,'complete':True}}}
        self.assertEqual(catchup.remaining(report),0)
        self.assertTrue(all(row['complete'] for row in control.active_rows(report)))
        self.assertFalse(report['categories'][topics.RN]['complete'])

    def test_chinese_cancellation_precedes_api_quota_recovery_and_preserves_checkpoints(self):
        (self.root/control.CONFIG).write_text(json.dumps({
            'disabled_categories':[topics.RN], 'disabled_lanes':['chinese_map']}))
        paths = [self.root/chinese.STATE, self.root/'events.json', self.root/'quota/groq-oss120b-public-backfill.json']
        for path in paths:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('{"saved":"unchanged"}')
        before = {path:path.read_bytes() for path in paths}
        with patch.object(chinese.archive_review, 'load_collector', side_effect=AssertionError('Must not start')), \
             patch.object(chinese, 'ChineseMapOutput', side_effect=AssertionError('Must not recover')), \
             patch('requests.sessions.Session.request', side_effect=AssertionError('Must not call API')):
            report = chinese.run(self.root)
        self.assertEqual(report['backfill_status'], 'cancelled')
        self.assertFalse(report['processing_complete'])
        self.assertEqual(before, {path:path.read_bytes() for path in paths})

    def test_chinese_stop_preserves_specialist_backfill_languages_and_daily_all_categories(self):
        lanes = {'chinese_map'}
        for code in ('zh','zh-Hant'):
            self.assertTrue(control.task_disabled({'category':'Attacks','code':code}, set(), lanes))
            for category in (topics.CE,topics.BIO):
                self.assertFalse(control.task_disabled({'category':category,'code':code}, set(), lanes))
            profile = next(p for p in collector.MULTILINGUAL_PROFILES if p['code']==code)
            self.assertEqual({q['category'] for q in profile['queries']},set(collector.CATEGORIES))
        self.assertTrue(control.task_disabled({'category':'Attacks','group':'gemini_chinese_map'},set(),lanes))
        self.assertFalse(control.task_disabled({'category':'Attacks','code':'fr'},set(),lanes))


if __name__=='__main__': unittest.main()
