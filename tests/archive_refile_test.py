"""How the background-archive sync files former map events and archive
reviews (tools/sync_background_corpus.py), by what happened to them: map
events that aged out or were recovered stay archived incidents, cleanup
commentary stays commentary, a cleanup re-check is reporting outside the map's
scope (noise at 0), and a fresh review is filed as the map's own selection
would file it. Rows already in D1 are re-filed (UPDATE) or deleted when the
repository's verdict on them changes. No network."""
import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, "tools")
import archive_dedup  # noqa: E402

spec = importlib.util.spec_from_file_location("sync_background_corpus", "tools/sync_background_corpus.py")
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


HEADLINES = {
    "https://clean/zero": "Football club unveils new stadium sponsorship deal",
    "https://clean/low": "Parliament debates border security funding package",
    "https://clean/op": "Opinion: what the Sahel crisis means for Europe",
    "https://aged/1": "JNIM fighters ambush army convoy near Boni",
    "https://x/1": "Gunmen storm police station in Diffa region",
    "https://both/1": "Houthi forces shell residential areas of Taiz",
}


def event(url, score, **extra):
    return {"url": url, "title": HEADLINES.get(url, f"Headline for {url}"), "published": "2026-05-04T08:00:00+00:00",
            "ai_relevance_score": score, "ai_relevance_reason": "Jihadist attack", **extra}


class VerdictTests(unittest.TestCase):
    def verdict(self, aged_out=False, **fields):
        return sync.former_event_verdict(event("https://x/1", fields.pop("score", 80), **fields), 60, aged_out)

    def test_opinion_pieces_caught_by_the_keyword_pass_stay_commentary(self):
        self.assertEqual(self.verdict(_cleanup_reason="keyword: opinion/analysis pattern")[0], "removed_event")

    def test_a_cleanup_recheck_is_reporting_the_map_dropped_whatever_its_score(self):
        kind, score, note, _ = self.verdict(_cleanup_reason="gemini re-check: score 0 under current rules")
        self.assertEqual((kind, score), ("rejected_candidate", 0))
        self.assertTrue(archive_dedup.is_noise({"kind": kind, "ai_relevance_score": score}))
        kind, score, note, _ = self.verdict(_cleanup_reason="gemini re-check: score 35 under current rules")
        self.assertEqual((kind, score), ("rejected_candidate", 35))
        self.assertIn("re-checked", note)
        # Removed although it scored 70: the scope check dropped it.
        self.assertEqual(self.verdict(_cleanup_reason="gemini re-check: score 70 under current rules")[:2],
                         ("rejected_candidate", 70))

    def test_events_that_were_on_the_map_stay_archived_incidents_whatever_the_threshold(self):
        self.assertEqual(self.verdict(aged_out=True)[:2], ("archived_incident", 80))
        self.assertEqual(self.verdict(score=55, _recovery_reason="retention_prune")[:2], ("archived_incident", 55))
        self.assertEqual(self.verdict(score=45, _recovery_reason="rereviewed")[:2], ("archived_incident", 45))

    def test_an_event_of_unknown_history_keeps_the_old_filing(self):
        self.assertEqual(self.verdict(score=None)[:2], ("removed_event", None))
        self.assertEqual(self.verdict()[:2], ("removed_event", 80))

    def test_any_row_scored_0_is_noise_but_a_missing_score_is_not(self):
        self.assertTrue(archive_dedup.is_noise({"kind": "removed_event", "ai_relevance_score": 0}))
        self.assertFalse(archive_dedup.is_noise({"kind": "related_article", "ai_relevance_score": None}))

    def test_archived_incidents_rank_between_related_articles_and_commentary(self):
        rank = archive_dedup.KIND_RANK
        self.assertLess(rank["related_article"], rank["archived_incident"])
        self.assertLess(rank["archived_incident"], rank["removed_event"])
        self.assertLess(rank["removed_event"], rank["rejected_candidate"])


class ReviewVerdictTests(unittest.TestCase):
    live = {"inc-gao": {"id": "evt-gao", "incident_id": "inc-gao", "country": "Mali", "region": "Africa",
                        "category": "Attacks", "categories": ["Attacks"], "actor_group": "JNIM"}}

    def verdict(self, **fields):
        return sync.review_verdict({"ai_relevance_score": 75, **fields}, 60, self.live, {"inc-old": "inc-gao"})

    def test_a_kept_report_on_an_incident_still_on_the_map_is_another_outlets_report(self):
        kind, parent = self.verdict(ai_selected=True, incident_id="inc-gao")
        self.assertEqual((kind, parent["id"]), ("related_article", "evt-gao"))
        self.assertEqual(self.verdict(ai_selected=True, incident_id="inc-old")[0], "related_article",
                         "merged incident ids are followed")

    def test_a_kept_report_on_any_other_incident_is_an_archived_incident(self):
        self.assertEqual(self.verdict(ai_selected=True, incident_id="inc-elsewhere"), ("archived_incident", None))

    def test_the_maps_scope_check_and_threshold_decide(self):
        self.assertEqual(self.verdict(ai_selected=False, incident_id="inc-gao")[0], "rejected_candidate")
        self.assertEqual(self.verdict(ai_relevance_score=55)[0], "rejected_candidate")
        self.assertEqual(self.verdict(ai_relevance_score=0)[0], "rejected_candidate")

    def test_the_threshold_used_at_review_time_holds(self):
        self.assertEqual(self.verdict(ai_relevance_score=62, map_threshold=65, ai_selected=True)[0],
                         "rejected_candidate")
        self.assertEqual(self.verdict(ai_relevance_score=62, map_threshold=60, ai_selected=True)[0],
                         "archived_incident")


class SourcesTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        write_json(self.root / "ct-atlas-runtime.json", {"ai_selection_threshold": 60})
        write_json(self.root / "events.json", {"events": [
            {"id": "evt-gao", "incident_id": "inc-gao", "url": "https://map/gao", "title": "Map event",
             "country": "Mali", "region": "Africa", "category": "Attacks", "categories": ["Attacks"]}]})
        write_json(self.root / "archive" / "removed-events-aged-out-202610.json", {
            "created_at": "2026-10-02T18:30:00+00:00", "events": [event("https://aged/1", 85),
                                                                   event("https://both/1", 65)]})
        write_json(self.root / "archive" / "removed-events-20260929-180940.json", {
            "removed_at": "2026-09-29T18:09:40+00:00", "events": [
                event("https://clean/zero", 75, _cleanup_reason="gemini re-check: score 0 under current rules"),
                event("https://clean/op", 75, _cleanup_reason="keyword: opinion/analysis pattern"),
                # Removed by the cleanup, back on the map, then aged out: the later fact wins.
                event("https://both/1", 65, _cleanup_reason="gemini re-check: score 0 under current rules")]})
        write_json(self.root / "archive" / "enriched-articles-20261003.json", {
            "created_at": "2026-10-03T02:30:00+00:00", "articles": [
                {"url": "https://hi/1", "title": "Militants attack police post in Kishtwar",
                 "original_title": "किश्तवाड़ में पुलिस चौकी पर आतंकी हमला", "original_language": "hi",
                 "source": "Dainik", "published": "2026-05-06T07:00:00+00:00", "ai_relevance_score": 82,
                 "ai_selected": True, "map_threshold": 60, "incident_id": "inc-kishtwar",
                 "ai_relevance_reason": "Militant attack", "categories": ["Attacks"], "category": "Attacks"},
                {"url": "https://gao/2", "title": "Gunmen ambush soldiers near Gao", "source": "RFI",
                 "published": "2026-09-20T07:00:00+00:00", "ai_relevance_score": 80, "ai_selected": True,
                 "map_threshold": 60, "incident_id": "inc-gao"},
                {"url": "https://id/1", "title": "Minister condemns attack", "source": "Kompas",
                 "published": "2026-05-07T07:00:00+00:00", "ai_relevance_score": 70, "ai_selected": False,
                 "ai_scope_rejection": "diplomatic condemnation rather than a new operational event"},
                {"url": "https://no-score/1", "title": "Unreviewed", "source": "X"}]})

    def test_every_source_files_its_rows_by_what_happened_to_them(self):
        articles, counts = sync.collect_articles(self.root)
        by_url = {a["url"]: a for a in articles}
        self.assertEqual(by_url["https://aged/1"]["kind"], "archived_incident")
        self.assertEqual(by_url["https://both/1"]["kind"], "archived_incident", "the latest verdict wins")
        self.assertEqual((by_url["https://clean/zero"]["kind"], by_url["https://clean/zero"]["ai_relevance_score"]),
                         ("rejected_candidate", 0))
        self.assertEqual(by_url["https://clean/op"]["kind"], "removed_event")
        hindi = by_url["https://hi/1"]
        self.assertEqual((hindi["kind"], hindi["original_title"], hindi["original_language"]),
                         ("archived_incident", "किश्तवाड़ में पुलिस चौकी पर आतंकी हमला", "hi"))
        gao = by_url["https://gao/2"]
        self.assertEqual((gao["kind"], gao["parent_event_id"], gao["parent_incident_id"], gao["country"]),
                         ("related_article", "evt-gao", "inc-gao", "Mali"))
        rejected = by_url["https://id/1"]
        self.assertEqual((rejected["kind"], rejected["ai_relevance_reason"]),
                         ("rejected_candidate", "diplomatic condemnation rather than a new operational event"))
        self.assertNotIn("https://no-score/1", by_url)
        self.assertEqual(counts["enriched"], 3)
        self.assertFalse(any(by_url[u].get("_authoritative") for u in ("https://hi/1", "https://gao/2")),
                         "enrichment rows are only inserted, never re-file a stored link")
        row = sync.collector.background_article_row(hindi)
        self.assertEqual(len(row), len(sync.collector.BACKGROUND_ARTICLES_D1_COLUMNS))

    def test_the_noise_row_is_never_inserted(self):
        articles, _ = sync.collect_articles(self.root)
        insert, _ = archive_dedup.plan_archive([], articles)
        self.assertNotIn("https://clean/zero", {row["url"] for row in insert})


class FakeD1:
    def __init__(self, stored, size=None):
        self.stored, self.size, self.sql = stored, size, []

    def __call__(self, sql, params=None):
        self.sql.append(sql)
        if sql == sync.EXISTING_ROWS_SQL:
            meta = {"size_after": self.size} if self.size is not None else {}
            return {"result": [{"results": [dict(row) for row in self.stored], "meta": meta}]}
        if sql.startswith("SELECT kind"):
            return {"result": [{"results": [{"kind": "removed_event", "n": 3}]}]}
        return {"success": True, "result": [{"meta": {"changes": 1}}]}

    def statements(self, prefix):
        return [sql for sql in self.sql if sql.startswith(prefix)]


class ReconcileRunTests(unittest.TestCase):
    """main() against a fake D1 holding rows filed under the old rule."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        write_json(self.root / "ct-atlas-runtime.json", {"ai_selection_threshold": 60})
        write_json(self.root / "events.json", {"events": [
            {"id": "evt-1", "incident_id": "inc-1", "url": "https://map/1", "title": "Map lead",
             "related_articles": [{"url": "https://wire/now-related", "title": "Wire report of the map lead",
                                   "published": "2026-09-20T08:00:00+00:00"}]}]})
        write_json(self.root / "ai_article_selection_cache.json", {"items": {}})
        write_json(self.root / "archive" / "removed-events-20260929-180940.json", {
            "removed_at": "2026-09-29T18:09:40+00:00", "events": [
                event("https://clean/zero", 75, _cleanup_reason="gemini re-check: score 0 under current rules"),
                event("https://clean/low", 75, _cleanup_reason="gemini re-check: score 30 under current rules"),
                event("https://clean/op", 75, _cleanup_reason="keyword: opinion/analysis pattern")]})
        write_json(self.root / "archive" / "removed-events-aged-out-202610.json", {
            "created_at": "2026-10-02T18:30:00+00:00", "events": [event("https://aged/1", 85)]})
        self.stored = [
            {"url": u, "kind": "removed_event", "title": HEADLINES[u], "published": "2026-05-04T08:00:00+00:00",
             "ai_relevance_score": 75}
            for u in ("https://clean/zero", "https://clean/low", "https://clean/op")
        ] + [{"url": "https://aged/1", "kind": "removed_event", "title": HEADLINES["https://aged/1"],
              "published": "2026-05-04T08:00:00+00:00", "ai_relevance_score": 85},
             {"url": "https://wire/now-related", "kind": "rejected_candidate", "title": "Wire report of the map lead",
              "published": "2026-09-20T08:00:00+00:00", "ai_relevance_score": 40}]
        self.d1 = FakeD1(self.stored)
        self.original = (sync.ROOT, sync.collector.d1_query)
        sync.ROOT, sync.collector.d1_query = self.root, self.d1

    def tearDown(self):
        sync.ROOT, sync.collector.d1_query = self.original

    def run_main(self, *args):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(sync.main(list(args)), 0)
        return out.getvalue()

    def test_apply_refiles_changed_rows_and_deletes_the_new_noise(self):
        output = self.run_main("--cleanup", "apply")
        updates = self.d1.statements("UPDATE background_articles")
        deletes = self.d1.statements("DELETE FROM background_articles")
        self.assertEqual(len(updates), 1)
        self.assertIn("WHEN 'https://clean/low' THEN 'rejected_candidate'", updates[0])
        self.assertIn("WHEN 'https://clean/low' THEN 30", updates[0])
        self.assertIn("WHEN 'https://aged/1' THEN 'archived_incident'", updates[0])
        # A link that became another outlet's report on a map incident gets its parent.
        self.assertIn("WHEN 'https://wire/now-related' THEN 'related_article'", updates[0])
        self.assertIn("WHEN 'https://wire/now-related' THEN 'inc-1'", updates[0])
        self.assertNotIn("https://clean/op", updates[0], "commentary is unchanged")
        self.assertNotIn("https://clean/zero", updates[0], "noise is deleted, not re-filed")
        self.assertEqual(len(deletes), 1)
        self.assertIn("'https://clean/zero'", deletes[0])
        self.assertIn("3 re-filed", output)

    def test_plan_mode_changes_nothing_stored(self):
        self.run_main("--cleanup", "plan")
        self.assertFalse(self.d1.statements("UPDATE") + self.d1.statements("DELETE"))

    def test_a_second_night_has_nothing_left_to_refile(self):
        self.d1.stored[:] = [
            {**row, "kind": kind, "ai_relevance_score": score}
            for row, (kind, score) in zip(self.stored, [("rejected_candidate", 0), ("rejected_candidate", 30),
                                                        ("removed_event", 75), ("archived_incident", 85),
                                                        ("related_article", None)])
            if row["url"] != "https://clean/zero"
        ]
        self.run_main("--cleanup", "apply")
        self.assertFalse(self.d1.statements("UPDATE") + self.d1.statements("DELETE"))

    def test_the_update_cap_leaves_the_rest_for_the_next_run(self):
        self.run_main("--cleanup", "apply", "--max-updates", "1")
        updates = self.d1.statements("UPDATE background_articles")
        self.assertEqual(len(updates), 1)
        self.assertEqual(updates[0].split("WHERE url IN (")[1].count("'"), 2)


class InsertCapTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        write_json(self.root / "ct-atlas-runtime.json", {"ai_selection_threshold": 60})
        write_json(self.root / "events.json", {"events": []})
        write_json(self.root / "ai_article_selection_cache.json", {"items": {}})
        self.title = "Gunmen kill twelve soldiers in attack on army base near Gao"
        write_json(self.root / "archive" / "enriched-articles-20261003.json", {"articles": [
            {"url": "https://new/a", "title": "Militants attack police post in Kishtwar district",
             "published": "2026-05-06T07:00:00+00:00", "ai_relevance_score": 90},
            {"url": "https://new/gao", "title": self.title, "published": "2026-09-20T08:00:00+00:00",
             "ai_relevance_score": 80},
            {"url": "https://new/low", "title": "Analysts weigh regional security cooperation",
             "published": "2026-05-08T07:00:00+00:00", "ai_relevance_score": 20}]})

    def run_main(self, d1, *args):
        original = (sync.ROOT, sync.collector.d1_query)
        sync.ROOT, sync.collector.d1_query = self.root, d1
        try:
            with contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(sync.main(["--cleanup", "apply", *args]), 0)
        finally:
            sync.ROOT, sync.collector.d1_query = original
        return out.getvalue()

    def test_a_stored_copy_is_only_deleted_for_a_row_inserted_tonight(self):
        d1 = FakeD1([{"url": "gemini-review:gao", "kind": "historical_review", "title": self.title,
                      "collected_at": "2026-09-21T08:00:00+00:00", "ai_relevance_score": 40}])
        self.run_main(d1, "--max-inserts", "1")
        inserts = d1.statements("INSERT OR IGNORE")
        self.assertEqual(len(inserts), 1)
        self.assertIn("https://new/a", inserts[0], "the best row goes first")
        self.assertNotIn("https://new/gao", inserts[0])
        self.assertFalse(d1.statements("DELETE"), "the review it would replace stays until that copy is inserted")

    def test_near_the_size_limit_only_incidents_are_added(self):
        d1 = FakeD1([], size=450 * 1024 * 1024)
        output = self.run_main(d1)
        inserts = " ".join(d1.statements("INSERT OR IGNORE"))
        self.assertIn("https://new/a", inserts)
        self.assertNotIn("https://new/low", inserts)
        self.assertIn("near its size limit", output)


class UpdateStatementTests(unittest.TestCase):
    def test_rows_are_quoted_and_batched_under_the_byte_cap(self):
        rows = [{"url": f"https://x.test/{n}?q='a'", "kind": "archived_incident", "ai_relevance_score": 70,
                 "ai_relevance_reason": "It's an attack", "parent_incident_id": None} for n in range(40)]
        statements = list(sync.update_statements(rows, max_bytes=2500))
        self.assertGreater(len(statements), 1)
        for sql in statements:
            self.assertLessEqual(len(sql.encode("utf-8")), 2500)
        joined = " ".join(statements)
        for row in rows:
            self.assertIn(row["url"].replace("'", "''"), joined)
        self.assertIn("'It''s an attack'", joined)
        self.assertEqual(sum(sql.count("WHERE url IN") for sql in statements), len(statements))


if __name__ == "__main__":
    unittest.main()
