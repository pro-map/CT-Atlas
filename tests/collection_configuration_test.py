"""No-network contracts for shared daily/history source configuration."""
import copy
import hashlib
import json
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'tools')]
import collector
import collection_config as config
import threat_categories as topics
import enrich_threat_categories as specialist
import enrich_chinese_map as chinese
import enrich_archive
import radnuc_vocabulary
import enrich_radnuc

CODES = {'ar','bn','de','en','es','fa','fr','ha','he','hi','id','it','ps','pt','ru','so','sw','tr','ur','zh','zh-Hant'}
# SHA-256 of full plans after the user retired Judicial on 2026-10-14.
# Existing task keys remain readable; removed court keywords no longer retrieve.
# A renamed query with a reset checkpoint must not pass as unchanged work.
BASELINE = {
    topics.RN: (7560, '0cccef797a34f8be9f866a343201927898334e4079ef135ca77eade454e1cd29'),
    topics.CE: (3321, '2c2bf60aa5164e7aa1171480398851ffe5cc5d7eb6cc7568476e5681295daed6'),
    topics.BIO: (3105, 'c023473386141c9ea49bafafb050d93746eded2abee552848fd0278baf9beb5c'),
    'chinese': (1092, 'dc231adbbcede0323e0ac9180e3499101288c4843d5702ba7fda46f6924fb677'),
    'general_archive': (12266, '8f9d8d5e2e049ea3977f0e885c29dfcf198be7a45d2e9d7c08a901bfc193f869'),
}


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


class CollectionConfigurationTests(unittest.TestCase):
    def test_effective_codes_are_twenty_languages_and_twenty_one_scripts(self):
        meta = config.language_metadata(collector.MULTILINGUAL_PROFILES)
        self.assertEqual(set(meta['language_codes']), CODES)
        self.assertEqual((meta['collection_languages'],meta['language_variants']), (20,21))
        self.assertEqual((meta['translated_languages'],meta['translated_language_variants']), (19,20))
        report = config.validate_runtime(vars(collector))
        self.assertIn('Configured queries', report['coverage_note'])

    def test_every_daily_profile_has_complete_native_specialist_queries(self):
        for profile in collector.MULTILINGUAL_PROFILES:
            for category in topics.LABELS:
                expected = topics.collection_queries(category, profile['code'])
                self.assertTrue(expected, (category,profile['code']))
                actual = {q['term'] for q in profile['queries'] if q['category']==category}
                self.assertTrue(set(expected) <= actual)

    def test_daily_and_history_use_identical_native_query_strings(self):
        for category in topics.LABELS:
            plan = specialist.plan_tasks(category,date(2026,10,8),collector)
            for code in CODES:
                historical = {task['query'] for task in plan if task['source']=='google' and task['code']==code}
                self.assertEqual(set(topics.collection_queries(category,code)), historical)

    def test_history_uses_daily_language_and_edition_inventory(self):
        identity = lambda p: tuple(p[k] for k in ('code','hl','gl','ceid'))
        self.assertEqual({identity(p) for p in enrich_radnuc.profiles(collector)},
                         {identity(p) for p in collector.MULTILINGUAL_PROFILES})
        profiles = config.specialist_profiles(collector.MULTILINGUAL_PROFILES)
        profiles[-1]['code'] = 'changed'
        self.assertNotIn('changed', {p['code'] for p in collector.MULTILINGUAL_PROFILES})

    def test_active_historical_full_plans_have_stable_tasks_and_order(self):
        plans = {category:specialist.plan_tasks(category,date(2026,10,8),collector) for category in topics.LABELS}
        plans['chinese'] = chinese.plan_tasks(chinese.configuration(ROOT,collector),collector)
        plans['general_archive'] = enrich_archive.plan_tasks(date(2026,10,12),collector)
        for key,plan in plans.items():
            self.assertEqual((len(plan),fingerprint(plan)),BASELINE[key],key)

    def test_supplement_stays_181_terms_and_5238_root_tasks(self):
        plan = specialist.plan_tasks(topics.RN,date(2026,10,8),collector)
        self.assertEqual(len(radnuc_vocabulary.all_terms()),181)
        self.assertEqual(sum(bool(t.get('supplemental_vocabulary')) for t in plan),5238)

    def test_core_english_queries_and_curated_lists_unchanged(self):
        for category in topics.LABELS:
            self.assertEqual(collector.CORE_SEARCH_QUERIES[category],topics.daily_queries(category))
        english = topics.vocabulary()['chemical_explosives']['terms']['en']
        self.assertEqual(len(english),95)
        self.assertEqual(hashlib.sha256('\n'.join(english).encode()).hexdigest(),
                         '581ffe4ef31139281b82c926237dec24cf09975bb68494aeb56de3eaefd97ddd')

    def test_install_is_idempotent_and_keeps_original_archive_replay_surface(self):
        namespace = {key:copy.deepcopy(getattr(collector,key)) for key in
            ('CATEGORIES','CORE_SEARCH_QUERIES','OFFICIAL_SOURCE_QUERIES','TARGETED_MEDIA_CATEGORY_TERMS',
             'MULTILINGUAL_PROFILES','CATEGORY_RELEVANCE','ACTION_TERMS','HISTORICAL_REPLAY_PROFILES')}
        before = copy.deepcopy(namespace)
        topics.install_collection(namespace)
        self.assertEqual(namespace,before)
        self.assertEqual(config.language_metadata(namespace['HISTORICAL_REPLAY_PROFILES'])['language_variants'],15)

    def test_old_cbrn_source_hints_survive_but_no_parent_category_is_allowed(self):
        self.assertTrue(any(s.get('category_hint')=='CBRN' for s in collector.TARGETED_SOURCE_SITES))
        self.assertFalse(set(collector.CATEGORIES) & {'CBRN','CBRNE'})
        enum=collector.AI_SELECTION_SCHEMA['properties']['results']['items']['properties']['categories']['items']['enum']
        self.assertFalse(set(enum) & {'CBRN','CBRNE'})

    def test_runtime_drift_fails_explicitly_without_network_or_writes(self):
        data=json.loads((ROOT/'ct-atlas-runtime.json').read_text())
        for key,value in [('collection_languages',12),('language_variants',20),('language_codes',['en'])]:
            bad=copy.deepcopy(data);bad[key]=value
            with tempfile.TemporaryDirectory() as folder:
                p=Path(folder)/'runtime.json';p.write_text(json.dumps(bad));raw=p.read_bytes()
                with patch('requests.sessions.Session.request',side_effect=AssertionError('Network forbidden')):
                    with self.assertRaisesRegex(ValueError,'Runtime language metadata'):
                        config.validate_runtime(vars(collector),p)
                self.assertEqual(p.read_bytes(),raw)

    def test_report_does_not_claim_fetched_events_or_write_checkpoints(self):
        paths=[ROOT/'events.json',*(ROOT/'quota').glob('*.json'),*(ROOT/'archive').glob('*state.json')]
        before={p:hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
        with patch('requests.sessions.Session.request',side_effect=AssertionError('Network forbidden')):
            report=config.validate_runtime(vars(collector))
        self.assertNotIn('published',report)
        self.assertNotIn('completed',report)
        self.assertEqual(before,{p:hashlib.sha256(p.read_bytes()).hexdigest() for p in paths})

    def test_legacy_native_api_delegates_to_single_json_vocabulary(self):
        import historical_specialist_queries as legacy
        for code in legacy.SEEDS:
            for category in (topics.CE,topics.BIO):
                self.assertEqual(legacy.queries(category,code),topics.seed_queries(category,code))
        with patch.object(topics,'seed_queries',return_value=['shared-test-query']):
            self.assertEqual(legacy.queries(topics.CE,'de'),['shared-test-query'])

    def test_no_false_local_editions_and_no_shared_mutable_query_lists(self):
        profiles=[];config.extend_specialist_profiles(profiles)
        self.assertEqual(len(profiles),7)
        config.extend_specialist_profiles(profiles);self.assertEqual(len(profiles),7)
        for code in ('so','sw'):
            p=next(p for p in profiles if p['code']==code)
            self.assertEqual((p['hl'],p['gl'],p['ceid']),('en-US','US','US:en'))
        profiles[0]['queries'].append({'term':'test','category':'test'})
        self.assertEqual(profiles[1]['queries'],[])


if __name__ == '__main__': unittest.main()
