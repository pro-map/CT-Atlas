"""Offline regression tests: all requests mocked, no credentials or network."""
import copy
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import groq_backfill as backend
import groq_backfill_runtime as runtime
import archive_review


def answer(rid):
    return dict(event_id=rid, relevance_score=80, is_current_ct_event=True,
                categories=['Attacks'], cbrn_subgroups=[], reported_status='SUSPECTED',
                actor_scope='NON_STATE', original_language='zh', english_title='Fictional attack',
                english_summary='Fictional test only.', canonical_event='Fictional event',
                actor_group='', primary_event_type='ATTACK', is_attack=True,
                incident_anchor='Fictional incident', update_type='INITIAL', reason='Fictional source.')


def fixture_collector():
    class Incomplete(Exception): pass
    class Transient(Exception): pass
    properties = {key: {'type': 'string'} for key in answer('p0')}
    properties.update(relevance_score={'type': 'integer'}, is_current_ct_event={'type': 'boolean'},
                      is_attack={'type': 'boolean'}, categories={'type': 'array', 'items': {'enum': ['Attacks']}},
                      cbrn_subgroups={'type': 'array', 'items': {'enum': ['RADNUC']}})
    for key, options in [('actor_scope', ['NON_STATE','STATE_ONLY','UNKNOWN']),
                         ('reported_status', ['SUSPECTED','CONFIRMED','UNKNOWN']),
                         ('primary_event_type', ['ATTACK','ARREST']), ('update_type', ['INITIAL'])]:
        properties[key]['enum'] = options
    schema = {'type':'object','properties':{'results':{'type':'array','items':{'type':'object','properties':properties}}},'required':['results']}
    return SimpleNamespace(AI_SELECTION_SCHEMA=schema, AISelectionIncompleteError=Incomplete,
                           AISelectionTransientError=Transient)


def article(n):
    return dict(event_id='p'+str(n), title='Fictional title '+str(n), summary='Test only',
                source='Fake', published='2026-06-10', current_categories=['Attacks'],
                collection_language_hint='zh')


def response(status=200, rows=None, code='json_validate_failed'):
    wire = ({'choices':[{'message':{'content':json.dumps({'results':rows})}}],
             'usage':{'prompt_tokens':1234,'completion_tokens':234,'total_tokens':1468}}
            if status==200 else {'error':{'code':code,'type':'invalid_request_error',
                                          'message':'DO_NOT_LOG_SECRET_SOURCE','failed_generation':'DO_NOT_LOG_GENERATION'}})
    return SimpleNamespace(status_code=status, headers={}, json=lambda:wire)


class GroqHistoryRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name); self.collector = fixture_collector()
        self.env = patch.dict(os.environ, GROQ_API_KEY='FAKE_TEST_SECRET', GITHUB_RUN_ID='unit-test')
        self.env.start(); self.addCleanup(self.env.stop)

    def gate(self, post, cap=5):
        return backend.GroqGate(self.collector, backend.GroqDailyQuota(self.root), cap,
                                post=post, sleep=lambda _:None)

    def test_internal_caps_increased_without_resetting_same_day_ledger(self):
        quota=backend.GroqDailyQuota(self.root); quota.reserve(4444)
        again=backend.GroqDailyQuota(self.root)
        self.assertEqual((again.used,again.tokens),(1,4444))
        self.assertEqual((backend.MAX_POSTS_PER_UTC_DAY,backend.MAX_RESERVED_TOKENS_PER_UTC_DAY),(32,160000))
        self.assertEqual(backend.MIN_INTERVAL_SECONDS,72)

    def test_telemetry_redacts_every_free_form_server_field(self):
        reply=response(400,code='DO_NOT_LOG_CODE')
        reply.headers={'x-ratelimit-limit-tokens':'8000','retry-after':'DO_NOT_LOG_HEADER'}
        data=runtime.safe_response_metadata(reply); text=json.dumps(data)
        self.assertNotIn('DO_NOT_LOG',text)
        self.assertEqual(data['error_code'],'unclassified')
        self.assertEqual(data['rate_headers'],{'x-ratelimit-limit-tokens':8000})

    def test_success_tracks_usage_separately_from_reservation(self):
        gate=self.gate(lambda *a,**k:response(rows=[answer('p0')]))
        gate.call_batch([article(0)])
        data=json.loads(next((self.root/'quota/groq-history-telemetry').glob('*.json')).read_text())
        row=data['attempts'][0]
        self.assertTrue(row['validated_response']); self.assertEqual(row['validated_articles'],1)
        self.assertEqual(row['provider_usage']['total_tokens'],1468)
        self.assertNotEqual(row['reserved_tokens'],1468)
        self.assertNotIn('FAKE_TEST_SECRET',json.dumps(data))

    def test_reuse_survives_process_and_remaps_wire_id_without_http(self):
        self.gate(lambda *a,**k:response(rows=[answer('p0')])).call_batch([article(0)])
        gate=self.gate(lambda *a,**k:self.fail('No second HTTP request'))
        item=article(0); item['event_id']='p12'
        out=gate.call_batch([item])
        self.assertEqual(out[0]['event_id'],'p12'); self.assertEqual(gate.posts,0)
        self.assertEqual(gate.quota.used,1)

    def test_input_or_policy_change_invalidates_cache(self):
        gate=self.gate(lambda *a,**k:response(rows=[answer('p0')]))
        gate.call_batch([article(0)]); item=article(0); item['summary']='Changed evidence'
        gate.call_batch([item]); self.assertEqual(gate.posts,2)
        with patch.object(backend,'INSTRUCTIONS',backend.INSTRUCTIONS+' version changed'):
            gate.call_batch([item])
        self.assertEqual(gate.posts,3)

    def test_400_schema_is_split_but_never_accepted_as_a_review(self):
        calls=[]
        def post(*a,**k):
            items=json.loads(k['json']['messages'][1]['content'])['events']; calls.append(len(items))
            return response(400) if len(items)>1 else response(rows=[answer(items[0]['event_id'])])
        gate=self.gate(post)
        result=gate.call_batch([article(0),article(1)])
        self.assertEqual(calls,[2,1,1]); self.assertEqual(len(result),2)
        data=json.loads(next((self.root/'quota/groq-history-telemetry').glob('*.json')).read_text())
        self.assertEqual(sum(x['validated_articles'] for x in data['attempts']),2)
        self.assertEqual(gate.quota.used,3)

    def test_valid_sibling_survives_budget_stop_and_is_not_rebilled(self):
        def post(*a,**k):
            items=json.loads(k['json']['messages'][1]['content'])['events']
            return response(400) if len(items)>1 else response(rows=[answer(items[0]['event_id'])])
        gate=self.gate(post,cap=2)
        with self.assertRaises(archive_review.BudgetReached):
            gate.call_batch([article(0),article(1)])
        gate=self.gate(post)
        self.assertEqual(len(gate.call_batch([article(0),article(1)])),2)
        self.assertEqual(gate.posts,1); self.assertEqual(gate.quota.used,3)

    def test_429_500_unknown_400_and_refusal_are_not_retried(self):
        for status,code in [(429,'rate_limit_exceeded'),(500,'invalid_request_error'),
                            (400,'invalid_request_error'),(400,'content_policy_violation')]:
            with self.subTest(status=status,code=code):
                calls=[]
                def post(*a,**k): calls.append(1); return response(status,code=code)
                gate=self.gate(post)
                with self.assertRaises((archive_review.BudgetReached,self.collector.AISelectionTransientError)):
                    gate.call_batch([article(4),article(5)])
                self.assertEqual(len(calls),1)

    def test_incomplete_singleton_stays_queued_not_terminally_skipped(self):
        gate=self.gate(lambda *a,**k:response(rows=[]))
        with self.assertRaises(self.collector.AISelectionTransientError): gate.call_batch([article(0)])
        self.assertFalse((self.root/runtime.CACHE_FILE).exists())

    def test_corrupt_cached_row_cannot_bypass_original_validator(self):
        gate=self.gate(lambda *a,**k:response(rows=[answer('p0')]))
        gate.call_batch([article(0)])
        path=self.root/runtime.CACHE_FILE; data=json.loads(path.read_text())
        next(iter(data['entries'].values()))['relevance_score']=10000
        runtime.atomic_json(path,data)
        gate.call_batch([article(0)]); self.assertEqual(gate.posts,2)

    def test_preflight_is_read_only_and_skips_exhaustion_but_not_maintenance(self):
        quota=backend.GroqDailyQuota(self.root);quota.tokens=159000;quota.used=31;quota.persist()
        before=quota.path.read_bytes()
        self.assertFalse(runtime.preflight(self.root)['run_needed'])
        self.assertTrue(runtime.preflight(self.root,maintenance=True)['run_needed'])
        self.assertTrue(runtime.preflight(self.root,day='2099-01-01')['run_needed'])
        self.assertEqual(quota.path.read_bytes(),before)

    def test_workflow_keeps_publication_and_serialization_guards(self):
        text=(ROOT/'.github/workflows/groq-free-backfill.yml').read_text()
        self.assertIn('cron: "45 */2 * * *"',text)
        self.assertIn('group: ct-map-update-main',text)
        self.assertIn('cancel-in-progress: false',text)
        self.assertIn('backfill_publication_guard.py finalize',text)
        self.assertIn('backfill_publication_guard.py verify',text)
        self.assertIn("needs.backfill.outputs.publication_ready == 'true'",text)
        self.assertIn('groq_backfill_runtime.py preflight',text)
        self.assertIn('archive/groq-history-review-cache-v1.json',text)

    def test_atomic_failure_does_not_truncate_cache(self):
        path=self.root/runtime.CACHE_FILE;runtime.atomic_json(path,{'old':1});before=path.read_bytes()
        with patch.object(runtime.os,'replace',side_effect=OSError('fake')):
            with self.assertRaises(OSError): runtime.atomic_json(path,{'new':2})
        self.assertEqual(path.read_bytes(),before)


if __name__=='__main__': unittest.main()
