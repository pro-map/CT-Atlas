"""Tests for the background-articles corpus: candidates Gemini reviews but does
not select for the map are saved separately (never read by the map, never
folded into events.json/events-lite.json) instead of being discarded, so the
report generator and Deep Search can eventually draw on a much larger corpus
than what the map shows.

Primary storage is Cloudflare D1; a local JSON file is the fallback when D1
is unreachable. No network access: d1_query is replaced by a fake in the D1
tests, and Cloudflare credentials are cleared so nothing can reach the real API."""
import importlib.util
import json
import os
import sqlite3
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


class _IsolatedTestCase(unittest.TestCase):
    def setUp(self):
        self._old_cwd = os.getcwd()
        self._tmpdir = tempfile.mkdtemp()
        os.chdir(self._tmpdir)
        self._saved_env = {
            key: os.environ.pop(key, None)
            for key in ("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN")
        }
        self._original_d1_query = collector.d1_query

    def tearDown(self):
        collector.d1_query = self._original_d1_query
        for key, value in self._saved_env.items():
            if value is not None:
                os.environ[key] = value
        os.chdir(self._old_cwd)


class D1StorageTests(_IsolatedTestCase):
    def test_rows_follow_the_d1_column_order_and_encode_categories_as_json(self):
        row = collector.background_article_row(collector.background_article_from_event(make_event()))
        self.assertEqual(len(row), len(collector.BACKGROUND_ARTICLES_D1_COLUMNS))
        as_dict = dict(zip(collector.BACKGROUND_ARTICLES_D1_COLUMNS, row))
        self.assertEqual(as_dict["url"], "https://example.com/article")
        self.assertEqual(as_dict["ai_relevance_score"], 40)
        self.assertEqual(json.loads(as_dict["categories"]), ["Attacks"])

    def test_statements_stay_under_the_d1_byte_budget(self):
        article = collector.background_article_from_event(make_event(summary="x" * 900))
        rows = [collector.background_article_row({**article, "url": f"https://x/{i}"}) for i in range(400)]
        statements = list(collector.d1_insert_or_ignore_statements(
            "background_articles", collector.BACKGROUND_ARTICLES_D1_COLUMNS, rows
        ))
        self.assertGreater(len(statements), 1)
        for sql in statements:
            self.assertTrue(sql.startswith("INSERT OR IGNORE INTO background_articles"))
            self.assertLessEqual(len(sql.encode("utf-8")), collector.CLOUDFLARE_D1_MAX_STATEMENT_BYTES)

    def test_literals_round_trip_exactly_through_sqlite(self):
        # Hostile text: quotes, a statement terminator, SQL comment markers,
        # non-Latin scripts, emoji, and a NUL byte (stripped by design).
        tricky = "O'Brien \"said\"; DROP TABLE x; -- /* é ع 中 🙂 */"
        rows = [
            collector.background_article_row({
                **collector.background_article_from_event(make_event(url=f"https://x/{i}", title=tricky + str(i))),
                "kind": "rejected_candidate",
                "summary": None if i % 2 else "line1\nline2\x00",
            })
            for i in range(30)
        ]
        db = sqlite3.connect(":memory:")
        columns = collector.BACKGROUND_ARTICLES_D1_COLUMNS
        db.execute(
            "CREATE TABLE background_articles ("
            + ",".join(c + (" TEXT PRIMARY KEY" if c == "url" else "") for c in columns) + ")"
        )
        for sql in collector.d1_insert_or_ignore_statements("background_articles", columns, rows, max_bytes=2000):
            db.execute(sql)
        stored = {r[0]: r for r in db.execute(f"SELECT {','.join(columns)} FROM background_articles")}

        self.assertEqual(len(stored), 30)
        for row in rows:
            expected = tuple(v.replace("\x00", "") if isinstance(v, str) else v for v in row)
            self.assertEqual(stored[row[0]], expected)
        self.assertEqual(db.execute("SELECT name FROM sqlite_master WHERE name='x'").fetchall(), [])

    def test_oversized_rows_are_skipped_not_sent(self):
        huge = collector.background_article_row({
            **collector.background_article_from_event(make_event(summary="y" * 5000)), "kind": "rejected_candidate",
        })
        self.assertEqual(list(collector.d1_insert_or_ignore_statements(
            "background_articles", collector.BACKGROUND_ARTICLES_D1_COLUMNS, [huge], max_bytes=1000
        )), [])

    def test_successful_d1_write_skips_the_local_fallback(self):
        calls = []
        collector.d1_query = lambda sql, params=None: calls.append((sql, params)) or {"success": True}
        collector.persist_background_articles([make_event()])

        self.assertTrue(any(sql.startswith("INSERT OR IGNORE") for sql, _ in calls))
        self.assertTrue(any(sql.startswith("DELETE FROM background_articles") for sql, _ in calls))
        self.assertFalse(os.path.exists(collector.BACKGROUND_ARTICLES_FILE))

    def test_d1_failure_falls_back_to_the_local_file(self):
        def failing(sql, params=None):
            raise RuntimeError("403 not authorised for D1")

        collector.d1_query = failing
        collector.persist_background_articles([make_event()])

        with open(collector.BACKGROUND_ARTICLES_FILE, encoding="utf-8") as handle:
            data = json.load(handle)
        self.assertEqual(data["article_count"], 1)

    def test_missing_cloudflare_credentials_fall_back_instead_of_crashing(self):
        # Credentials are cleared in setUp; the real d1_query must raise, not hit the network.
        with self.assertRaises(RuntimeError):
            collector.d1_query("SELECT 1")
        collector.persist_background_articles([make_event()])
        self.assertTrue(os.path.exists(collector.BACKGROUND_ARTICLES_FILE))

    def test_url_less_events_are_never_sent_to_d1(self):
        calls = []
        collector.d1_query = lambda sql, params=None: calls.append(sql) or {"success": True}
        collector.persist_background_articles([make_event(url=None)])
        self.assertEqual(calls, [])


class LocalFallbackTests(_IsolatedTestCase):
    def setUp(self):
        super().setUp()

        def unreachable(sql, params=None):
            raise RuntimeError("D1 unreachable in this test")

        collector.d1_query = unreachable

    def test_creates_file_with_expected_shape(self):
        collector.persist_background_articles([make_event()])
        with open(collector.BACKGROUND_ARTICLES_FILE, encoding="utf-8") as handle:
            data = json.load(handle)
        self.assertEqual(data["article_count"], 1)
        saved = data["articles"][0]
        self.assertEqual(saved["title"], "Some rejected article")
        self.assertLess(saved["ai_relevance_score"], collector.AI_SELECTION_THRESHOLD)
        self.assertIn("collected_at", saved)

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

    def test_url_less_only_input_does_not_create_a_file(self):
        collector.persist_background_articles([make_event(url=None)])
        self.assertFalse(os.path.exists(collector.BACKGROUND_ARTICLES_FILE))

    def test_empty_rejected_list_does_not_create_a_file(self):
        collector.persist_background_articles([])
        self.assertFalse(os.path.exists(collector.BACKGROUND_ARTICLES_FILE))


class CallSiteTests(_IsolatedTestCase):
    def test_disabled_ai_selection_returns_early_without_persisting(self):
        calls = []
        original = collector.persist_background_articles
        original_enabled = collector.AI_SELECTION_ENABLED
        collector.persist_background_articles = lambda rejected: calls.append(list(rejected))
        try:
            collector.AI_SELECTION_ENABLED = False
            events = [make_event()]
            self.assertEqual(collector.ai_select_events(events), events)
            self.assertEqual(calls, [])
        finally:
            collector.persist_background_articles = original
            collector.AI_SELECTION_ENABLED = original_enabled

    def test_call_site_is_guarded_so_enrichment_errors_cannot_break_collection(self):
        source = open(os.path.join(self._old_cwd, "collector.py"), encoding="utf-8").read()
        start = source.index("def ai_select_events(")
        end = source.index("\n# ============================================================\n# INTELLIGENT EVENT-LEVEL DEDUPLICATION", start)
        body = source[start:end]
        guarded = body.index("try:\n        persist_background_articles(rejected)")
        self.assertLess(guarded, body.index("return selected", guarded))
        self.assertIn("except Exception", body[guarded:])


if __name__ == "__main__":
    unittest.main()
