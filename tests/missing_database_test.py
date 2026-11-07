"""A missing events.json stops the readers that used to take it for an empty
database: the collector, the map update's list of protected locations, the D1
archive sync and the RadNuc archive. tools/push_data_commit.sh refuses a commit
that deletes it (push_data_commit_test.py)."""
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "tools")]
import collector
import enrich_radnuc_background as radnuc
import sync_background_corpus as sync


class MissingDatabaseTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)

    def test_the_collector_refuses_to_start_from_an_empty_database(self):
        with mock.patch.object(collector, "OUTPUT_FILE", str(self.root / "events.json")):
            for load in (collector.load_database_strict, collector.load_existing):
                with self.subTest(load=load.__name__), self.assertRaisesRegex(RuntimeError, "events.json is missing"):
                    load()

    def test_the_map_update_protects_locations_only_from_a_real_database(self):
        # The step's own Python, as the runner receives it.
        source = (ROOT / ".github/workflows/update-map.yml").read_text(encoding="utf-8")
        step = source.split("        id: prepare\n", 1)[1]
        script = textwrap.dedent(step.split("python - <<'PY'\n", 1)[1].split("\n          PY\n", 1)[0])
        preserve = self.root / "preserve.json"
        env = {**os.environ, "PRESERVE_FILE": str(preserve), "GITHUB_OUTPUT": str(self.root / "output.txt")}

        def prepare():
            return subprocess.run([sys.executable, "-c", script], cwd=self.root, env=env, capture_output=True, text=True)

        result = prepare()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("events.json is missing", result.stderr)
        self.assertFalse(preserve.exists())
        (self.root / "events.json").write_text(json.dumps(
            {"events": [{"id": "located", "latitude": 14.7, "longitude": -3.1}, {"id": "unlocated"}]}), encoding="utf-8")
        result = prepare()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(preserve.read_text(encoding="utf-8")), ["located"])

    def test_the_archive_sync_is_not_planned_without_the_map(self):
        for case, text in (("missing", None), ("unreadable", "{"), ("not a database", "[]")):
            if text is not None:
                (self.root / "events.json").write_text(text, encoding="utf-8")
            for read in (sync.map_events, sync.collect_articles):
                with self.subTest(case=case, read=read.__name__), \
                        self.assertRaisesRegex(RuntimeError, "events.json is missing or unreadable"):
                    read(self.root)

    def test_the_radnuc_archive_stops_before_any_search_or_review(self):
        calls = []

        class Searcher:
            def search(self, task):
                calls.append("search")
                return [], False

        with self.assertRaisesRegex(RuntimeError, "events.json is missing or unreadable"):
            radnuc.run(self.root, collector=collector, searcher=Searcher(), max_fetches=1,
                       review=lambda rows: calls.append("review") or [],
                       now=datetime(2026, 11, 7, 10, tzinfo=timezone.utc))
        self.assertEqual(calls, [])
        self.assertFalse((self.root / radnuc.background.ARTICLES_FILE).exists())


if __name__ == "__main__":
    unittest.main()
