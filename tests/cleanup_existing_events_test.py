"""tools/cleanup_existing_events.py writes events.json and its archive like every
other writer: whole or not at all, in the same bytes. Keyword pass only, so no
Gemini call is made."""
import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("cleanup_existing_events", ROOT / "tools/cleanup_existing_events.py")
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)

OPINION = {"id": "op", "title": "Opinion: why the jihadist threat is growing in the Sahel",
           "summary": "An editorial.", "category": "Attacks"}
KEPT = [{"id": "a", "title": "Militants attack army post near Gao", "summary": "Soldiers were killed.",
         "category": "Attacks"},
        {"id": "b", "title": "Attaque contre un poste militaire à Ménaka", "summary": "Bilan provisoire.",
         "category": "Attacks"}]


class CleanupWriteTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.database = self.root / "events.json"
        self.archive = self.root / "archive" / "removed-events-test.json"
        # Key order as the collector writes it: geolocation comes after events.
        self.original = {"last_updated": "2026-11-07T00:00:00+00:00", "number_of_events": 3,
                         "events": [KEPT[0], OPINION, KEPT[1]], "geolocation": {"located": 3}}
        self.database.write_text(json.dumps(self.original, ensure_ascii=False, indent=2), encoding="utf-8")

    def run_cleanup(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return cleanup.main(["--input", str(self.database), "--archive", str(self.archive),
                                 "--skip-rescore", "--show", "0"])

    def test_the_database_keeps_its_bytes_format_and_its_count(self):
        self.assertEqual(self.run_cleanup(), 0)
        expected = {**self.original, "number_of_events": 2, "events": KEPT}
        self.assertEqual(self.database.read_text(encoding="utf-8"),
                         json.dumps(expected, ensure_ascii=False, indent=2) + "\n")
        reference = self.root / "reference.json"
        cleanup.collector.atomic_json_write(reference, expected)
        self.assertEqual(self.database.read_bytes(), reference.read_bytes(), "the collector's own bytes")
        archived = self.archive.read_text(encoding="utf-8")
        self.assertTrue(archived.endswith("}\n"))
        self.assertEqual(json.loads(archived)["events"],
                         [{"_cleanup_reason": "keyword: opinion/analysis pattern", **OPINION}])
        self.assertEqual(sorted(path.name for path in self.root.rglob("*.tmp")), [])

    def test_an_interrupted_database_write_leaves_the_database_as_it_was(self):
        before = self.database.read_bytes()
        real_dump = json.dump
        calls = []

        def dump(*args, **kwargs):
            calls.append(args[0])
            if len(calls) == 2:
                raise OSError("disk full")
            return real_dump(*args, **kwargs)

        with mock.patch("json.dump", dump), self.assertRaises(OSError):
            self.run_cleanup()
        self.assertEqual(len(calls), 2, "the archive is written first, then the database")
        self.assertEqual(self.database.read_bytes(), before)
        self.assertFalse(Path(str(self.database) + ".tmp").exists())


if __name__ == "__main__":
    unittest.main()
