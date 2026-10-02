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
        write_json(self.root / "ct-atlas-runtime.json", {"ai_selection_threshold": 60})
        write_json(self.root / "ai_article_selection_cache.json", {"items": {
            "fp-low": {"reviewed_at": "2026-09-25T10:00:00+00:00", "result": {
                "relevance_score": 30, "english_title": "Niger-Algeria alliance proclaimed at the UN",
                "english_summary": "Diplomacy.", "reason": "Interstate diplomacy, out of scope.",
                "categories": ["Counter Terrorism Action"], "actor_group": None}},
            "fp-noise": {"reviewed_at": "2026-09-25T10:00:00+00:00", "result": {
                "relevance_score": 0, "english_title": "Snake bites rise in rural Syria"}},
            "fp-between": {"reviewed_at": "2026-09-25T10:00:00+00:00", "result": {
                "relevance_score": 55, "english_title": "Analysis of JNIM pressure on Bamako"}},
            "fp-linked": {"reviewed_at": "2026-10-02T10:00:00+00:00",
                          "article": {"url": "https://outlet/analysis", "source": "Outlet",
                                      "published": "2026-10-01T08:00:00+00:00"},
                          "result": {"relevance_score": 20, "english_title": "Commentary on Sahel jihadist rivalry"}},
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
            "related_article": 1, "removed_event": 1, "recovered": 0, "rejected_candidate": 0, "historical_review": 3,
        })

    def test_off_topic_reviews_never_reach_the_archive(self):
        by_url, _ = self.articles_by_url()
        self.assertNotIn("gemini-review:fp-noise", by_url)

    def test_reviews_below_the_maps_real_threshold_are_kept(self):
        # 55 is above the collector's code default (50) but below the map's
        # threshold in ct-atlas-runtime.json (60): it belongs in the archive.
        by_url, _ = self.articles_by_url()
        self.assertEqual(by_url["gemini-review:fp-between"]["ai_relevance_score"], 55)

    def test_reviews_cached_with_their_article_keep_its_link_and_date(self):
        by_url, _ = self.articles_by_url()
        review = by_url["https://outlet/analysis"]
        self.assertEqual(review["kind"], "historical_review")
        self.assertEqual(review["source"], "Outlet")
        self.assertEqual(review["published"], "2026-10-01T08:00:00+00:00")
        self.assertNotIn("gemini-review:fp-linked", by_url)

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


class RecoveredSourceTests(unittest.TestCase):
    """Former map events recovered from events.json's history, related articles
    dropped from live events, and articles cut off by incident merges."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        write_json(self.root / "ct-atlas-runtime.json", {"ai_selection_threshold": 60})
        write_json(self.root / "ai_article_selection_cache.json", {"items": {}})
        write_json(self.root / "events.json", {"events": [{
            "id": "live-1", "incident_id": "inc-live", "url": "https://map/live", "title": "Live event",
            "category": "Attacks", "categories": ["Attacks"], "country": "Mali", "related_articles": [],
        }]})
        write_json(self.root / "archive" / "recovered-events-20261002.json", {
            "created_at": "2026-10-02T10:00:00+00:00",
            "events": [{
                "id": "old-1", "incident_id": "inc-old", "url": "https://old/lead",
                "title": "Rotterdam: Explosion at synagogue", "original_title": "Rotterdam: explosie bij synagoge",
                "published": "2026-03-16T08:00:00+00:00", "category": "Attacks", "categories": ["Attacks"],
                "country": "Netherlands", "ai_relevance_score": 90, "_recovery_reason": "retention_prune",
                "related_articles": [{"url": "https://old/related", "title": "Synagogue blast in Rotterdam",
                                      "published": "2026-03-16T10:00:00+00:00"}],
            }],
            "related_articles": [{
                "article": {"url": "https://live/dropped", "title": "Another outlet on the live event",
                            "published": "2026-09-20T10:00:00+00:00"},
                "parent": {"id": "live-1", "incident_id": "inc-live", "category": "Attacks", "country": "Mali"},
            }],
        })
        write_json(self.root / "archive" / "related-overflow-20261001.json", {
            "created_at": "2026-10-01T16:00:00+00:00",
            "articles": [{"incident_id": "inc-live", "article": {
                "url": "https://overflow/1", "title": "Overflow report", "published": "2026-09-30T10:00:00+00:00"}}],
        })

    def test_recovered_events_their_related_articles_and_cut_off_articles_reach_the_archive(self):
        articles, counts = sync.collect_articles(self.root)
        by_url = {a["url"]: a for a in articles}
        self.assertEqual(counts["recovered"], 4)
        lead = by_url["https://old/lead"]
        self.assertEqual((lead["kind"], lead["ai_relevance_score"], lead["parent_incident_id"]),
                         ("removed_event", 90, "inc-old"))
        self.assertEqual(lead["original_title"], "Rotterdam: explosie bij synagoge")
        related = by_url["https://old/related"]
        self.assertEqual((related["kind"], related["parent_event_id"], related["country"]),
                         ("related_article", "old-1", "Netherlands"))
        dropped = by_url["https://live/dropped"]
        self.assertEqual((dropped["kind"], dropped["parent_incident_id"], dropped["country"]),
                         ("related_article", "inc-live", "Mali"))
        overflow = by_url["https://overflow/1"]
        self.assertEqual((overflow["parent_event_id"], overflow["parent_incident_id"]), ("live-1", "inc-live"))


class SyncRunTests(unittest.TestCase):
    """main() against a fake D1: what is inserted, and what is deleted only in
    apply mode."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        write_json(self.root / "ct-atlas-runtime.json", {"ai_selection_threshold": 60})
        write_json(self.root / "events.json", {"events": [{
            "id": "evt-1", "incident_id": "inc-1", "url": "https://map/event",
            "title": "Gunmen kill twelve soldiers in attack on army base near Gao",
            "published": "2026-09-20T08:00:00+00:00",
            "related_articles": [
                # Same story as the stored wire copy below, which is more recent: not inserted again.
                {"url": "https://map/event", "title": "Gunmen kill twelve soldiers in attack on army base near Gao",
                 "published": "2026-09-20T08:00:00+00:00"},
                {"url": "https://other/angle", "title": "Mali junta vows retaliation after deadly Gao base assault",
                 "published": "2026-09-20T12:00:00+00:00"},
            ],
        }]})
        write_json(self.root / "ai_article_selection_cache.json", {"items": {}})
        self.stored = [
            {"url": "gemini-review:noise", "kind": "historical_review", "title": "Yacht sale in Monaco",
             "collected_at": "2026-09-24T10:00:00+00:00", "ai_relevance_score": 0},
            {"url": "https://wire/copy", "kind": "related_article",
             "title": "Gunmen kill 12 soldiers in attack on army base near Gao, Mali",
             "published": "2026-09-20T09:00:00+00:00", "ai_relevance_score": None},
            {"url": "https://keep/analysis", "kind": "historical_review",
             "title": "Analysis: why JNIM targets fuel convoys around Bamako",
             "published": "2026-09-22T09:00:00+00:00", "ai_relevance_score": 35},
            {"url": "gemini-review:copy", "kind": "historical_review",
             "title": "Analysis: why JNIM targets fuel convoys around Bamako",
             "collected_at": "2026-09-22T12:00:00+00:00", "ai_relevance_score": 35},
        ]
        self.sql = []

        def fake_query(sql, params=None):
            self.sql.append(sql)
            if sql == sync.EXISTING_ROWS_SQL:
                return {"result": [{"results": self.stored}]}
            if sql.startswith("SELECT kind"):
                return {"result": [{"results": [{"kind": "related_article", "n": 2}]}]}
            return {"success": True, "result": [{"meta": {"changes": 1}}]}

        self.original = (sync.ROOT, sync.collector.d1_query)
        sync.ROOT, sync.collector.d1_query = self.root, fake_query

    def tearDown(self):
        sync.ROOT, sync.collector.d1_query = self.original

    def statements(self, prefix):
        return [sql for sql in self.sql if sql.startswith(prefix)]

    def test_plan_mode_inserts_new_stories_but_deletes_nothing(self):
        self.assertEqual(sync.main(["--cleanup", "plan"]), 0)
        inserts = self.statements("INSERT OR IGNORE INTO background_articles")
        self.assertEqual(len(inserts), 1)
        self.assertIn("https://other/angle", inserts[0])
        self.assertNotIn("'https://map/event'", inserts[0])
        self.assertEqual(self.statements("DELETE FROM background_articles WHERE url IN"), [])

    def test_apply_mode_deletes_noise_and_second_copies_only(self):
        self.assertEqual(sync.main(["--cleanup", "apply"]), 0)
        deletes = self.statements("DELETE FROM background_articles WHERE url IN")
        self.assertEqual(len(deletes), 1)
        self.assertIn("'gemini-review:noise'", deletes[0])
        self.assertIn("'gemini-review:copy'", deletes[0])
        self.assertNotIn("https://keep/analysis", deletes[0])
        # A copy of a map event is kept: the map forgets events after 180 days.
        self.assertNotIn("https://wire/copy", deletes[0])

    def test_apply_mode_respects_the_per_run_cap(self):
        self.assertEqual(sync.main(["--cleanup", "apply", "--max-deletes", "1"]), 0)
        deletes = self.statements("DELETE FROM background_articles WHERE url IN")
        self.assertEqual(len(deletes), 1)
        self.assertEqual(deletes[0].count("'"), 2)


class DeleteStatementTests(unittest.TestCase):
    def test_urls_are_quoted_and_batched_under_the_byte_cap(self):
        urls = [f"https://x.test/{n}?q='a'" for n in range(50)]
        statements = list(sync.delete_statements(urls, max_bytes=400))
        self.assertGreater(len(statements), 1)
        for sql in statements:
            self.assertLessEqual(len(sql.encode("utf-8")), 400)
            self.assertTrue(sql.endswith(")"))
        joined = " ".join(statements)
        for url in urls:
            self.assertIn(url.replace("'", "''"), joined)


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
