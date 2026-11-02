"""Offline regressions for confirmed collection and semantic-retention defects."""
from collections import Counter
from copy import deepcopy
from itertools import product
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import collector
import daily_source_retry as source
from tools import backfill_query


def response(status=200, payload=None, text='', headers=None):
    def decode():
        if payload is None:
            raise ValueError('not valid JSON')
        return payload
    return SimpleNamespace(status_code=status, json=decode, text=text, headers=headers or {})


def alternatives(query):
    # Each tuple is one conjunction of exact terms. Query fragments are a
    # union, so this checks semantics independently of emitted parentheses.
    def normalize(term):
        if term.startswith('"') and term.endswith('"') and ' ' not in term[1:-1]:
            return term[1:-1]
        return term
    return {frozenset(normalize(term) for term in terms)
            for terms in product(*backfill_query.groups(query))}


class GdeltDailyTests(unittest.TestCase):
    def test_every_daily_category_query_uses_supported_grammar_without_losing_anchors(self):
        for category, configured in collector.CATEGORIES.items():
            with self.subTest(category=category):
                queries = collector.gdelt_doc_category_queries(category)
                expected = set().union(*(alternatives(term) for term in configured[:5]))
                actual = set().union(*(alternatives(query) for query in queries))
                self.assertEqual(actual, expected)
                self.assertTrue(all(len(query.encode()) <= backfill_query.GDELT_QUERY_BYTES for query in queries))

    def test_daily_discovery_sorts_latest_articles_first(self):
        params = parse_qs(urlsplit(collector.gdelt_doc_url('terrorism', days=3)).query)
        self.assertEqual(params['sort'], ['datedesc'])
        self.assertEqual(params['timespan'], ['3d'])

    def test_separate_query_matches_do_not_duplicate_the_same_source_article(self):
        article = {'url': 'https://example.test/item', 'title': 'Police arrest ISIS suspect',
                   'seendate': '20261101T120000Z', 'language': 'English', 'domain': 'example.test'}
        with patch.object(collector, 'gdelt_doc_category_queries', return_value=['terrorism', 'extremism']), \
             patch.object(collector, 'fetch_gdelt_doc_articles', return_value=[article]) as fetch, \
             patch.object(collector.time, 'sleep'), patch.object(collector, 'GDELT_STATS', Counter()):
            events = collector.collect_gdelt_category_query('Arrests', days=3)
        self.assertEqual(fetch.call_count, 2)
        self.assertEqual(len(events), 1)

    def test_non_english_sources_are_not_mislabelled_as_english(self):
        for name, code in [('Chinese', 'zh'), ('Bengali', 'bn'), ('Hindi', 'hi'),
                           ('Indonesian', 'id'), ('Portuguese', 'pt'), ('Somali', 'so'),
                           ('Swahili', 'sw'), ('Hausa', 'ha'), ('Unlisted language', 'und')]:
            with self.subTest(language=name):
                event = collector.gdelt_article_to_event({'url': 'https://example.test/item',
                    'title': 'A source headline', 'language': name}, ['Arrests'])
                self.assertEqual(event['original_language'], code)
                self.assertEqual(event['collection_language'], code)

    def test_plain_text_http_200_throttle_retries_with_bounded_wait(self):
        stats, waits, calls = Counter(), [], []
        answers = iter([response(text='Please limit requests to one every 5 seconds.'),
                        response(payload={'articles': []})])
        def get(*args, **kwargs):
            calls.append(args)
            return next(answers)
        client = SimpleNamespace(get=get, RequestException=RuntimeError)
        self.assertEqual(source.fetch_articles(client, 'https://example.test', stats, label='x', sleep=waits.append), [])
        self.assertEqual((stats['successful'], stats['failed'], stats['rate_limited']), (1, 0, 1))
        self.assertEqual(len(calls), 2)
        self.assertGreaterEqual(waits[0], 30)
        self.assertLessEqual(waits[0], 120)

    def test_persistent_throttle_pauses_remaining_queries_without_empty_successes(self):
        stats, calls = Counter(), []
        def get(*args, **kwargs):
            calls.append(args)
            return response(status=429)
        client = SimpleNamespace(get=get, RequestException=RuntimeError)
        for label in ('first', 'second'):
            source.fetch_articles(client, 'https://example.test/' + label, stats, label=label, sleep=lambda _: None)
        self.assertEqual(len(calls), 2)
        self.assertEqual((stats['attempted'], stats['failed'], stats['successful']), (2, 2, 0))
        self.assertEqual(stats['skipped_http_queries'], 1)
        self.assertEqual(stats['deferred_queries'][1]['reason'], 'source_paused_rate_limit')

    def test_provider_query_rejection_is_not_retried_as_transient_or_empty(self):
        stats, calls = Counter(), []
        def get(*args, **kwargs):
            calls.append(args)
            return response(text='Your query was too long.')
        client = SimpleNamespace(get=get, RequestException=RuntimeError)
        source.fetch_articles(client, 'https://example.test', stats, label='x', sleep=lambda _: None)
        self.assertEqual(len(calls), 1)
        self.assertEqual(stats['query_rejected'], 1)
        self.assertEqual(stats['successful'], 0)
        self.assertEqual(stats['deferred_queries'][0]['reason'], 'query_rejected')

    def test_raw_control_characters_in_json_titles_do_not_discard_valid_articles(self):
        stats = Counter()
        reply = response(text='{"articles":[{"url":"https://example.test","title":"A\tB"}]}')
        client = SimpleNamespace(get=lambda *a, **kw: reply, RequestException=RuntimeError)
        rows = source.fetch_articles(client, 'https://example.test', stats, label='x', sleep=lambda _: None)
        self.assertEqual(rows[0]['title'], 'A\tB')
        self.assertEqual(stats['successful'], 1)


class CurrentEventSelectionTests(unittest.TestCase):
    def event(self):
        return {'title': 'Police arrest an ISIS suspect in Lyon', 'summary': '',
                'category': 'Arrests', 'categories': ['Arrests'], 'url': 'https://example.test/source'}

    def decision(self, **overrides):
        return {'relevance_score': 85, 'is_current_ct_event': True,
                'categories': ['Arrests'], 'english_title': 'Police arrest an ISIS suspect in Lyon',
                'english_summary': 'Police arrested the suspect.', 'original_language': 'en',
                'actor_scope': 'NON_STATE', 'primary_event_type': 'ARREST', **overrides}

    def test_a_high_score_cannot_override_an_explicit_non_current_decision(self):
        event = self.event()
        self.assertFalse(collector.apply_ai_selection(event, self.decision(is_current_ct_event=False)))
        self.assertFalse(event['ai_selected'])
        self.assertFalse(event['ai_current_ct_event'])
        self.assertIn('current CT event', event['ai_scope_rejection'])

    def test_discovery_hint_cannot_fill_an_empty_or_unsupported_semantic_category(self):
        for categories in ([], ['Unsupported category']):
            event = self.event()
            self.assertFalse(collector.apply_ai_selection(event, self.decision(categories=categories)))
            self.assertFalse(event['ai_selected'])
            self.assertEqual(event['categories'], [])
            self.assertEqual(event['category'], '')

    def test_string_false_is_not_a_valid_current_event_boolean(self):
        event = self.event()
        self.assertFalse(collector.apply_ai_selection(event, self.decision(is_current_ct_event='false')))

    def test_supported_current_decision_is_still_retained_without_changing_source(self):
        event = self.event()
        original = deepcopy(event)
        self.assertTrue(collector.apply_ai_selection(event, self.decision()))
        self.assertEqual(event['categories'], ['Arrests'])
        self.assertEqual(event['url'], original['url'])
        self.assertEqual(event['original_title'], original['title'])


if __name__ == '__main__':
    unittest.main()
