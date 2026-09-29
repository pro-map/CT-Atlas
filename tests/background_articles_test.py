"""Tests for the background-articles corpus: candidates Gemini reviews but does
not select for the map are now saved separately (never read by the map, never
folded into events.json/events-lite.json) instead of being discarded, so the
report generator and Deep Search can eventually draw on a much larger corpus
than what the map shows. No network access; collector.py is imported directly."""
import importlib.util
import json
import os
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("collector", "collector.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


def make_event(**overrides):
    event = {
        "id": "evt-1",
        "url": "https://example.com/article",
        "title": "Some rejected article",
        "summary": "Background context only.",
        "source": "Reuters",
        "published": "2026-09-20T10:00:00+00:00",
        "category": "Attacks",
        "categories": ["Attacks"],
        "actor_group": None,
        "primary_event_type": "OTHER_CT",
        "original_language": "en",
        "ai_relevance_score": 40,
        "ai_relevance_reason": "No concrete operational fact.",
    }
    event.update(overrides)
    return event


class BackgroundArticlesTests(unittest.TestCase):
    def setUp(self):
        self._old_cwd = os.getcwd()
        self._tmpdir = tempfile.mkdtemp()
        os.chdir(self._tmpdir)

    def tearDown(self):
        os.chdir(self._old_cwd)

    def test_persist_creates_file_with_expected_shape(self):
        collector.persist_background_articles([make_event()])
        with open(collector.BACKGROUND_ARTICLES_FILE, encoding="utf-8") as handle:
            data = json.load(handle)
        self.assertEqual(data["article_count"], 1)
        self.assertEqual(len(data["articles"]), 1)
        saved = data["articles"][0]
        self.assertEqual(saved["title"], "Some rejected article")
        self.assertEqual(saved["ai_relevance_score"], 40)
        self.assertIn("collected_at", saved)

    def test_never_receives_events_that_made_the_map(self):
        # ai_select_events() only ever calls persist_background_articles(rejected),
        # never on `selected` -- this test locks in that a background article
        # always carries a sub-threshold (or out-of-scope) Gemini judgment.
        collector.persist_background_articles([make_event(ai_relevance_score=40)])
        with open(collector.BACKGROUND_ARTICLES_FILE, encoding="utf-8") as handle:
            data = json.load(handle)
        self.assertLess(data["articles"][0]["ai_relevance_score"], collector.AI_SELECTION_THRESHOLD)

    def test_duplicate_url_is_not_added_twice(self):
        collector.persist_background_articles([make_event()])
        collector.persist_background_articles([make_event(id="evt-1-again", title="Different title, same URL")])
        with open(collector.BACKGROUND_ARTICLES_FILE, encoding="utf-8") as handle:
            data = json.load(handle)
        self.assertEqual(data["article_count"], 1)

    def test_new_article_with_different_url_is_added(self):
        collector.persist_background_articles([make_event()])
        collector.persist_background_articles([make_event(id="evt-2", url="https://example.com/other")])
        with open(collector.BACKGROUND_ARTICLES_FILE, encoding="utf-8") as handle:
            data = json.load(handle)
        self.assertEqual(data["article_count"], 2)

    def test_articles_older_than_retention_window_are_pruned(self):
        stale = make_event(id="evt-old", url="https://example.com/old", published="2020-01-01T00:00:00+00:00")
        fresh = make_event(id="evt-new", url="https://example.com/new", published="2026-09-25T00:00:00+00:00")
        collector.persist_background_articles([stale, fresh])
        with open(collector.BACKGROUND_ARTICLES_FILE, encoding="utf-8") as handle:
            data = json.load(handle)
        self.assertEqual(data["article_count"], 1)
        self.assertEqual(data["articles"][0]["id"], "evt-new")

    def test_articles_without_a_url_are_skipped(self):
        collector.persist_background_articles([make_event(url=None)])
        self.assertFalse(os.path.exists(collector.BACKGROUND_ARTICLES_FILE))

    def test_empty_rejected_list_does_not_create_a_file(self):
        collector.persist_background_articles([])
        self.assertFalse(os.path.exists(collector.BACKGROUND_ARTICLES_FILE))

    def test_ai_select_events_calls_persist_with_the_rejected_list(self):
        # Locks in the call site inside ai_select_events(): it must persist
        # `rejected`, never `selected`, and must do so even when AI selection
        # itself is disabled (the early-return path) -- i.e. persistence must
        # never be skipped by a code path that also skips discarding rejects.
        calls = []
        original = collector.persist_background_articles
        collector.persist_background_articles = lambda rejected: calls.append(list(rejected))
        original_enabled = collector.AI_SELECTION_ENABLED
        try:
            collector.AI_SELECTION_ENABLED = False
            events = [make_event()]
            result = collector.ai_select_events(events)
            self.assertEqual(result, events)
            self.assertEqual(calls, [], "AI selection disabled: nothing was reviewed, so nothing to persist.")
        finally:
            collector.persist_background_articles = original
            collector.AI_SELECTION_ENABLED = original_enabled


if __name__ == "__main__":
    unittest.main()
