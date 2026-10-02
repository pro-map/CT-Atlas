"""Map events that age out of the 180-day retention leave the map, not CT
Atlas: prune_old hands them over, and the collector keeps them in a monthly
archive file the background-archive sync reads."""
import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

spec = importlib.util.spec_from_file_location("collector", "collector.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)

sync_spec = importlib.util.spec_from_file_location("sync_background_corpus", "tools/sync_background_corpus.py")
sync = importlib.util.module_from_spec(sync_spec)
sync_spec.loader.exec_module(sync)

NOW = datetime.now(timezone.utc)


def event(title, days_ago, url):
    return {
        "id": url[-6:], "incident_id": "inc-" + url[-4:], "url": url, "title": title,
        "summary": title, "published": (NOW - timedelta(days=days_ago)).isoformat(),
        "category": "Attacks", "categories": ["Attacks"], "country": "Mali", "ai_relevance_score": 85,
        "related_articles": [{"url": url + "/other", "title": "Other outlet"}], "source_article_fingerprints": ["x"],
    }


class PruneOldTests(unittest.TestCase):
    def test_events_dropped_for_their_age_are_handed_over(self):
        recent = event("JNIM fighters attack army post in Mali", 3, "https://a.test/recent")
        old = event("JNIM fighters attack army post near Gao", collector.RETENTION_DAYS + 5, "https://a.test/old")
        aged_out = []
        kept = collector.prune_old([recent, old], aged_out)
        self.assertEqual([e["url"] for e in kept], ["https://a.test/recent"])
        self.assertEqual([e["url"] for e in aged_out], ["https://a.test/old"])

    def test_without_a_list_prune_old_behaves_as_before(self):
        old = event("JNIM fighters attack army post near Gao", collector.RETENTION_DAYS + 5, "https://a.test/old")
        self.assertEqual(collector.prune_old([old]), [])

    def test_out_of_scope_events_are_not_handed_over(self):
        condemnation = event("France condemns the attack in Gao", collector.RETENTION_DAYS + 5, "https://a.test/cond")
        aged_out = []
        collector.prune_old([condemnation], aged_out)
        self.assertEqual(aged_out, [])


class ArchiveFileTests(unittest.TestCase):
    def test_monthly_file_is_compact_deduplicated_and_read_by_the_sync(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "archive"
            old = event("JNIM fighters attack army post near Gao", 200, "https://a.test/old")
            when = datetime(2026, 10, 2, 8, tzinfo=timezone.utc)
            path = collector.archive_aged_out_events([old], now=when, directory=str(archive))
            collector.archive_aged_out_events([old, event("Another aged-out attack in Mopti", 201, "https://a.test/b")],
                                              now=when, directory=str(archive))
            self.assertEqual(Path(path).name, "removed-events-aged-out-202610.json")
            data = json.loads(Path(path).read_text(encoding="utf-8"))
            self.assertEqual([e["url"] for e in data["events"]], ["https://a.test/old", "https://a.test/b"])
            self.assertNotIn("related_articles", data["events"][0])
            self.assertNotIn("source_article_fingerprints", data["events"][0])

            rows = list(sync.removed_events([path], "2026-10-02T09:00:00+00:00"))
            self.assertEqual({row["kind"] for row in rows}, {"removed_event"})
            self.assertEqual(rows[0]["ai_relevance_score"], 85)
            self.assertEqual(rows[0]["parent_incident_id"], old["incident_id"])

    def test_nothing_to_archive_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(collector.archive_aged_out_events([], directory=tmp))
            self.assertEqual(list(Path(tmp).iterdir()), [])


class WorkflowTests(unittest.TestCase):
    def test_the_collection_commits_the_aged_out_archive(self):
        workflow = Path(".github/workflows/update-map.yml").read_text(encoding="utf-8")
        self.assertIn('Path("archive").glob("removed-events-aged-out-*.json")', workflow)


if __name__ == "__main__":
    unittest.main()
