"""Tests for tools/sync_background_corpus.py, which seeds the D1 background
corpus from data already in the repository. No network access."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("sync_background_corpus", "tools/sync_background_corpus.py")
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


class CollectArticlesTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        write_json(self.root / "events.json", {"events": [{
            "id": "evt-1",
            "incident_id": "inc-1",
            "url": "https://map/event",
            "title": "Map event",
            "category": "Maritime Piracy",
            "categories": ["Maritime Piracy"],
            "actor_group": "Al-Shabaab",
            "primary_event_type": "PIRACY",
            "country": "Somalia",
            "region": "Africa",
            "related_articles": [
                {"url": "https://other/1", "title": "Other outlet report", "summary": "s",
                 "source": "Garowe Online", "published": "2026-09-20T00:00:00+00:00", "original_language": "en"},
                {"url": "https://other/2", "title": "", "summary": "no title -> skipped"},
                "not-a-dict",
            ],
        }]})
        write_json(self.root / "archive" / "removed-events-20260929-000000.json", {
            "removed_at": "2026-09-29T08:52:33+00:00",
            "events": [
                {"url": "https://removed/1", "title": "Opinion piece", "incident_id": "inc-9",
                 "_cleanup_reason": "keyword: opinion/analysis pattern"},
                # Same URL as a related article: the related article wins.
                {"url": "https://other/1", "title": "Duplicate"},
            ],
        })
        write_json(self.root / "ai_article_selection_cache.json", {"items": {
            "fp-low": {"reviewed_at": "2026-09-25T10:00:00+00:00", "result": {
                "relevance_score": 0, "english_title": "Niger-Algeria alliance proclaimed at the UN",
                "english_summary": "Diplomacy.", "reason": "Interstate diplomacy, out of scope.",
                "categories": ["Counter Terrorism Action"], "actor_group": None}},
            "fp-kept": {"reviewed_at": "2026-09-25T10:00:00+00:00", "result": {
                "relevance_score": 85, "english_title": "Selected for the map"}},
            "fp-untitled": {"reviewed_at": "2026-09-25T10:00:00+00:00", "result": {"relevance_score": 10}},
        }})

    def articles_by_url(self):
        articles, counts = sync.collect_articles(self.root)
        return {a["url"]: a for a in articles}, counts

    def test_counts_per_source_after_dedup(self):
        _, counts = self.articles_by_url()
        self.assertEqual(counts, {
            "related_article": 1, "removed_event": 1, "rejected_candidate": 0, "historical_review": 1,
        })

    def test_related_articles_inherit_the_parent_event_context(self):
        by_url, _ = self.articles_by_url()
        related = by_url["https://other/1"]
        self.assertEqual(related["kind"], "related_article")
        self.assertEqual(related["source"], "Garowe Online")
        self.assertEqual(related["country"], "Somalia")
        self.assertEqual(related["actor_group"], "Al-Shabaab")
        self.assertEqual(related["parent_event_id"], "evt-1")
        self.assertEqual(related["parent_incident_id"], "inc-1")

    def test_historical_reviews_keep_only_rejected_titled_items_with_a_synthetic_key(self):
        by_url, _ = self.articles_by_url()
        review = by_url["gemini-review:fp-low"]
        self.assertEqual(review["kind"], "historical_review")
        self.assertIsNone(review.get("published"))
        self.assertEqual(review["collected_at"], "2026-09-25T10:00:00+00:00")
        self.assertIn("out of scope", review["ai_relevance_reason"])
        self.assertNotIn("gemini-review:fp-kept", by_url)
        self.assertNotIn("gemini-review:fp-untitled", by_url)

    def test_every_article_produces_a_full_width_row(self):
        articles, _ = sync.collect_articles(self.root)
        for article in articles:
            row = sync.collector.background_article_row(article)
            self.assertEqual(len(row), len(sync.collector.BACKGROUND_ARTICLES_D1_COLUMNS))
            as_dict = dict(zip(sync.collector.BACKGROUND_ARTICLES_D1_COLUMNS, row))
            self.assertTrue(as_dict["url"] and as_dict["title"] and as_dict["kind"] and as_dict["collected_at"])


class InsertedRowCountTests(unittest.TestCase):
    def test_sums_changes_across_statements_in_a_d1_response(self):
        response = {"success": True, "result": [
            {"success": True, "meta": {"changes": 37}},
            {"success": True, "meta": {"changes": 0}},
        ]}
        self.assertEqual(sync.inserted_row_count(response), 37)

    def test_tolerates_missing_meta_or_result(self):
        self.assertEqual(sync.inserted_row_count({"success": True, "result": [{"success": True}]}), 0)
        self.assertEqual(sync.inserted_row_count({}), 0)
        self.assertEqual(sync.inserted_row_count(None), 0)


if __name__ == "__main__":
    unittest.main()
