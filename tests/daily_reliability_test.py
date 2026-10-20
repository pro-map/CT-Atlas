"""No-network regressions for daily safety, recovery and publication receipts."""
import ast
import copy
import io
import json
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT),str(ROOT/'tools')]
import daily_reliability as safe
import daily_source_retry as source
import daily_publication_audit as audit
import threat_categories as taxonomy


def city(name,code='AT',**kw):
    return {'name':name,'countrycode':code,'geonameid':name+code,
            'latitude':48,'longitude':14,'alternatenames':[],**kw}


class ReliabilityTests(unittest.TestCase):
    def test_canonical_name_beats_another_city_alias(self):
        garsten=city('Garsten',population=10)
        wrong=city('Windischgarsten',population=1000,alternatenames=['Garsten'])
        self.assertEqual(safe.canonical_city([wrong,garsten],'Garsten','AT'),garsten)

    def test_other_country_is_never_a_fallback(self):
        self.assertIsNone(safe.canonical_city([city('Al Bayda','LY')],'Al Bayda','SY'))

    def test_ambiguous_namesake_is_not_resolved_by_population(self):
        self.assertIsNone(safe.canonical_city([city('Springfield','US',geonameid='1'),
            city('Springfield','US',geonameid='2')],'Springfield','US'))

    def test_validated_transliteration_and_nonlatin_names(self):
        self.assertEqual(safe.canonical_city([city('München','DE',alternatenames=['Munich'])],'Munich','DE')['name'],'München')
        self.assertEqual(safe.normal_name('北京'), '北京')

    def test_actual_geocoder_uses_country_locked_resolver(self):
        tree=ast.parse((ROOT/'geolocate.py').read_text())
        node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='resolve_city')
        namespace={'CITY_INDEX':{'al bayda':[city('Al Bayda','LY')]},'normalize_name':safe.normal_name}
        exec(compile(ast.Module(body=[node],type_ignores=[]),'geolocate.py','exec'),namespace)
        self.assertIsNone(namespace['resolve_city']('Al Bayda','SY'))

    def test_unresolved_ai_coordinates_are_not_precise_city_evidence(self):
        result={'precision':'city','city':'No Such Place','country_code':'AT','confidence':.99,'latitude':1,'longitude':2}
        guarded=safe.city_resolution_guard({},result,{},safe.normal_name)
        self.assertEqual(guarded['precision'],'country')
        self.assertIsNone(guarded['latitude'])
        self.assertLessEqual(guarded['confidence'],.5)
        self.assertEqual(result['latitude'],1)

    def test_explicit_decision_clears_old_rn_compatibility(self):
        event={'id':'keep','title':'A report','categories':['Radiological/Nuclear'],
               'threat_categories':['Radiological/Nuclear'],'cbrn_subgroups':['RADNUC'],
               'latitude':12,'longitude':34}
        taxonomy.annotate(event,{'categories':['Arrests'],'actor_scope':'NON_STATE'})
        self.assertEqual(event['categories'],['Arrests'])
        self.assertEqual(event['threat_categories'],[])
        self.assertEqual(event['cbrn_subgroups'],[])
        self.assertEqual((event['id'],event['latitude'],event['longitude']),('keep',12,34))

    def test_rn_decision_still_keeps_rn(self):
        e={'categories':['Arrests']}
        taxonomy.annotate(e,{'categories':['Radiological/Nuclear'],'actor_scope':'NON_STATE'})
        self.assertEqual(e['threat_categories'],['Radiological/Nuclear'])

    def test_targeted_Garsten_repair_never_refreshes_unrelated_records(self):
        e={'id':'82b5e133d2a54751','country_code':'AT','city':'Windischgarsten',
           'title':'Arrest at Garsten','latitude':1,'longitude':2}
        self.assertTrue(safe.repair_known_city(e,lambda *a:city('Garsten')))
        self.assertEqual(e['city'],'Garsten')
        self.assertIsNone(safe.repair_known_city(e,lambda *a:city('Garsten')))
        unrelated={'id':'other','country_code':'AT','city':'Windischgarsten','title':'Arrest at Garsten'}
        self.assertIsNone(safe.repair_known_city(unrelated,lambda *a:city('Garsten')))

    def test_metadata_repair_is_idempotent_and_preserves_evidence(self):
        e={'id':'a','categories':['Arrests'],'threat_categories':['Radiological/Nuclear'],
           'cbrn_subgroups':[],'threat_taxonomy_version':'v1','ai_selection_complete':True,
           'summary':'source','latitude':1,'published':'2026-10-20'}
        old=copy.deepcopy(e)
        self.assertTrue(safe.metadata_repair(e))
        self.assertIsNone(safe.metadata_repair(e))
        for key in ('id','summary','latitude','published'):self.assertEqual(e[key],old[key])

    def test_unreviewed_categories_are_not_assumed_authoritative(self):
        e={'categories':['Arrests'],'threat_categories':['Radiological/Nuclear']}
        old=copy.deepcopy(e)
        self.assertIsNone(safe.metadata_repair(e));self.assertEqual(e,old)

    def test_recovery_does_not_borrow_next_daily_reserve(self):
        u={'pacific_day':'2026-10-20','calls':30,'overflow_calls':25,'completed_daily_slots':[safe.SLOTS[0]]}
        self.assertEqual(safe.recovery_caps(u,'2026-10-20',30,60,25,50),(0,0))
        u.update(calls=50,overflow_calls=40,completed_daily_slots=list(safe.SLOTS))
        self.assertEqual(safe.recovery_caps(u,'2026-10-20',30,60,25,50),(10,10))

    def test_recovery_fails_closed_on_missing_or_stale_accounting(self):
        for u in ({},{'pacific_day':'2026-10-19','calls':0,'overflow_calls':0},
                  {'pacific_day':'2026-10-20','calls':True,'overflow_calls':0}):
            self.assertEqual(safe.recovery_caps(u,'2026-10-20',30,60,25,50),(0,0))

    def test_retry_delay_is_bounded_and_long_retry_after_is_deferred(self):
        self.assertEqual([safe.retry_delay(i,jitter=0) for i in range(6)],[4,8,16,32,60,60])
        self.assertIsNone(safe.retry_delay(0,SimpleNamespace(headers={'Retry-After':'300'}),jitter=0))

    def test_recovered_source_retry_is_not_a_new_event(self):
        stats=Counter(); sleep=[]
        replies=iter([SimpleNamespace(status_code=429,headers={}),
                      SimpleNamespace(status_code=200,json=lambda:{'articles':[]})])
        client=SimpleNamespace(get=lambda *a,**k:next(replies),RequestException=RuntimeError)
        self.assertEqual(source.fetch_articles(client,'https://example.test',stats,label='x',sleep=sleep.append),[])
        self.assertEqual((stats['attempted'],stats['http_attempts'],stats['successful'],stats['rate_limited'],stats['failed']),(1,2,1,1,0))
        self.assertEqual(len(sleep),1)

    def test_terminal_source_failure_remains_explicit(self):
        stats=Counter()
        client=SimpleNamespace(get=lambda *a,**k:SimpleNamespace(status_code=503,headers={}),RequestException=RuntimeError)
        source.fetch_articles(client,'https://example.test',stats,label='x',sleep=lambda _:None)
        self.assertEqual(stats['failed'],1)
        self.assertFalse(stats['deferred_queries'][0]['recovered'])

    def test_receipt_counts_ids_not_cached_or_changed_summaries(self):
        before={'events':[{'id':'a','summary':'old'}]}
        after={'events':[{'id':'a','summary':'new'},{'id':'b'}]}
        r=safe.publication_delta(before,after)
        self.assertEqual(r['added_record_ids'],['b']);self.assertEqual(r['changed_record_ids'],['a'])
        self.assertFalse(r['publication_confirmed']);self.assertFalse(r['independent_incidents_verified'])

    def test_duplicate_identifiers_block_receipts(self):
        with self.assertRaises(ValueError):safe.rows({'events':[{'id':'a'},{'id':'a'}]})

    def test_json_formatting_is_not_a_publication_difference(self):
        self.assertEqual(safe.digest({'a':1,'b':[2]}),safe.digest(json.loads('{"b": [2], "a": 1}')))

    def test_verify_checks_actual_served_bytes_not_a_green_workflow(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); expected=root/'manifest.json'; output=root/'receipt.json'
            data={'events':[{'id':'a'}]}
            audit.write(expected,{'files':{'events.json':{'sha256_canonical_json':safe.digest(data),'record_count':1}}})
            with patch.object(audit.urllib.request,'urlopen',return_value=io.BytesIO(json.dumps(data).encode())):
                self.assertTrue(audit.verify('https://example.test',expected,output,attempts=1)['publication_confirmed'])
            with patch.object(audit.urllib.request,'urlopen',return_value=io.BytesIO(b'{"events":[]}')):
                with self.assertRaises(RuntimeError):audit.verify('https://example.test',expected,output,attempts=1)
            self.assertFalse(audit.read(output)['publication_confirmed'])

    def test_delay_attribution_is_an_estimate_not_a_cause(self):
        result=safe.timing(safe.SLOTS[0],'2026-10-20T13:33:58Z','2026-10-20T13:34:28Z')
        self.assertEqual(result['creation_delay_seconds'],19018)
        self.assertIn('not_proof',result['schedule_attribution'])

if __name__=='__main__':unittest.main()
