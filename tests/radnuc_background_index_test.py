"""The DATABASE reader's date indexes remain small and range-searchable."""
import importlib.util
import re
import sqlite3
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("sync_background_indexes", "tools/sync_background_corpus.py")
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class RadNucBackgroundIndexTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("""CREATE TABLE background_articles (
            kind TEXT, category TEXT, primary_event_type TEXT,
            title TEXT, summary TEXT, url TEXT, source TEXT,
            original_title TEXT, original_language TEXT,
            published TEXT, collected_at TEXT
        )""")
        self.db.executemany(
            "INSERT INTO background_articles (kind, published, collected_at) VALUES (?, ?, ?)",
            [("archived_incident", "2026-10-13T08:00:00Z", "2026-10-13T10:00:00Z")] * 200
            + [("radnuc_background", published, "2026-10-13T10:00:00+00:00")
               for published in ["2026-10-12T23:46:00Z", "", None, "invalid"]],
        )
        self.db.execute("UPDATE background_articles SET category = 'Radiological/Nuclear', "
                        "primary_event_type = 'BACKGROUND_INFO' WHERE kind = 'radnuc_background'")
        for sql in sync.RADNUC_BACKGROUND_INDEXES:
            self.db.execute(sql)

    def tearDown(self):
        self.db.close()

    def reader_sql(self, name):
        source = Path("cloudflare-worker/database-query.js").read_text()
        values = {
            "BACKGROUND_DATE_SQL": re.search(r'const BACKGROUND_DATE_SQL = "([^"]+)";', source).group(1),
            "BACKGROUND_SCOPE_SQL": re.search(r'const BACKGROUND_SCOPE_SQL = `([^`]+)`;', source).group(1),
            "MAX_BACKGROUND_RESULTS": re.search(r'const MAX_BACKGROUND_RESULTS = (\d+);', source).group(1),
            "periodSql": re.search(r'const periodSql = filters.periodDays \? `([^`]+)`', source).group(1),
        }
        sql = re.search(rf'const {name} = `([^`]+)`;', source).group(1)
        for _ in range(2):
            for key, value in values.items():
                sql = sql.replace("${" + key + "}", value)
        self.assertNotIn("${", sql)
        return sql

    def test_index_creation_is_idempotent_and_excludes_other_archive_kinds(self):
        for sql in sync.RADNUC_BACKGROUND_INDEXES:
            self.db.execute(sql)
        indexes = {row[1] for row in self.db.execute("PRAGMA index_list(background_articles)")}
        self.assertIn("idx_radnuc_background_published", indexes)
        self.assertIn("idx_radnuc_background_collected", indexes)
        # Invalid or absent publication dates still fall back to collection.
        expression = "COALESCE(julianday(NULLIF(TRIM(published), '')), julianday(collected_at))"
        count = self.db.execute(
            f"SELECT COUNT(*) FROM background_articles WHERE kind = 'radnuc_background' "
            f"AND {expression} >= julianday(?) AND {expression} < julianday(?)",
            ("2026-10-12T22:00:00Z", "2026-10-13T22:00:00Z"),
        ).fetchone()[0]
        self.assertEqual(count, 4)

    def test_actual_worker_date_expression_uses_publication_range_index(self):
        source = Path("cloudflare-worker/database-query.js").read_text()
        expression = re.search(r'const BACKGROUND_DATE_SQL = "([^"]+)";', source).group(1)
        self.assertIn(expression, sync.RADNUC_BACKGROUND_INDEXES[0])
        plan = self.db.execute(
            "EXPLAIN QUERY PLAN " + self.reader_sql("itemsSql"),
            ("2026-10-12T11:00:00Z", "2026-10-13T11:00:00Z"),
        ).fetchall()
        details = " ".join(row[3] for row in plan)
        self.assertIn("SEARCH background_articles USING INDEX idx_radnuc_background_published", details)

    def test_paris_daily_additions_use_collection_range_index(self):
        plan = self.db.execute(
            "EXPLAIN QUERY PLAN " + self.reader_sql("countSql"),
            ("2026-10-12T11:00:00Z", "2026-10-13T11:00:00Z", "2026-10-12T22:00:00Z", "2026-10-13T22:00:00Z"),
        ).fetchall()
        self.assertIn(
            "SEARCH background_articles USING INDEX idx_radnuc_background_collected",
            " ".join(row[3] for row in plan),
        )

    def test_actual_reader_counts_publication_and_collection_separately(self):
        bounds = ("2026-10-12T11:00:00Z", "2026-10-13T11:00:00Z", "2026-10-12T22:00:00Z", "2026-10-13T22:00:00Z")
        counts = self.db.execute(self.reader_sql("countSql"), bounds).fetchone()
        self.assertEqual(counts, (4, 4))
        bounds = ("2026-10-13T00:00:00Z", "2026-10-13T11:00:00Z", "2026-10-12T22:00:00Z", "2026-10-13T22:00:00Z")
        counts = self.db.execute(self.reader_sql("countSql"), bounds).fetchone()
        self.assertEqual(counts, (3, 4), "publication period cannot hide today's earlier-publication additions")


if __name__ == "__main__":
    unittest.main()
