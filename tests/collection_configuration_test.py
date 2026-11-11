"""No-network contracts for the shared daily source configuration."""
import copy
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'tools')]
import collector
import collection_config as config
import threat_categories as topics

CODES = {'ar','bn','de','en','es','fa','fr','ha','he','hi','id','it','ps','pt','ru','so','sw','tr','ur','zh','zh-Hant'}


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

    def test_specialist_profiles_match_daily_editions_and_are_copies(self):
        identity = lambda p: tuple(p[k] for k in ('code','hl','gl','ceid'))
        profiles = config.specialist_profiles(collector.MULTILINGUAL_PROFILES)
        self.assertEqual({identity(p) for p in profiles}, {identity(p) for p in collector.MULTILINGUAL_PROFILES})
        profiles[-1]['code'] = 'changed'
        self.assertNotIn('changed', {p['code'] for p in collector.MULTILINGUAL_PROFILES})

    def test_core_english_queries_and_curated_lists_unchanged(self):
        for category in topics.LABELS:
            self.assertEqual(collector.CORE_SEARCH_QUERIES[category],topics.daily_queries(category))
        english = topics.vocabulary()['chemical_explosives']['terms']['en']
        self.assertEqual(len(english),95)
        self.assertEqual(hashlib.sha256('\n'.join(english).encode()).hexdigest(),
                         '581ffe4ef31139281b82c926237dec24cf09975bb68494aeb56de3eaefd97ddd')

    def test_install_is_idempotent(self):
        namespace = {key:copy.deepcopy(getattr(collector,key)) for key in
            ('CATEGORIES','CORE_SEARCH_QUERIES','OFFICIAL_SOURCE_QUERIES','TARGETED_MEDIA_CATEGORY_TERMS',
             'MULTILINGUAL_PROFILES','CATEGORY_RELEVANCE','ACTION_TERMS')}
        before = copy.deepcopy(namespace)
        topics.install_collection(namespace)
        self.assertEqual(namespace,before)

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
        import events_store;events_store.require_materialized(ROOT)
        paths=[ROOT/'events.json',*(ROOT/'quota').glob('*.json'),*(ROOT/'archive').glob('*state.json')]
        before={p:hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
        with patch('requests.sessions.Session.request',side_effect=AssertionError('Network forbidden')):
            report=config.validate_runtime(vars(collector))
        self.assertNotIn('published',report)
        self.assertNotIn('completed',report)
        self.assertEqual(before,{p:hashlib.sha256(p.read_bytes()).hexdigest() for p in paths})

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
