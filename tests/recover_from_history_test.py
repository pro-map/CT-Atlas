"""Tests for tools/recover_from_history.py's classification: only events
that left the map for no editorial reason, or that today's Gemini selection
still finds relevant, may reach the archive."""
import importlib.util
import unittest
from datetime import datetime, timezone

spec = importlib.util.spec_from_file_location("recover_from_history", "tools/recover_from_history.py")
recover = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recover)

LEFT = datetime(2026, 9, 2, 12, tzinfo=timezone.utc)


def event(published, score=80):
    return {"title": "Some event", "published": published, "ai_relevance_score": score}


class ClassifyTests(unittest.TestCase):
    def test_deliberate_cleanups_are_already_archived(self):
        self.assertEqual(
            recover.classify(event("2026-09-01T00:00:00+00:00"),
                             "2026-09-29 Retroactive cleanup: remove non-operational events", LEFT, None),
            ("deliberate_cleanup", None),
        )

    def test_the_current_selections_score_decides_when_it_exists(self):
        self.assertEqual(recover.classify(event("2026-08-30T00:00:00+00:00"), "x", LEFT, 35), ("rereviewed", 35))
        self.assertEqual(recover.classify(event("2026-08-30T00:00:00+00:00"), "x", LEFT, 0), ("rereviewed", None))

    def test_events_that_aged_out_keep_their_map_score(self):
        self.assertEqual(recover.classify(event("2026-03-01T00:00:00+00:00", 90), "x", LEFT, None),
                         ("retention_prune", 90))

    def test_anything_else_waits_for_a_review(self):
        self.assertEqual(recover.classify(event("2026-08-30T00:00:00+00:00", 90), "x", LEFT, None), ("unknown", None))
        self.assertEqual(recover.classify(event("2026-03-01T00:00:00+00:00", None), "x", LEFT, None),
                         ("retention_prune", None))


class HistoryLayoutTests(unittest.TestCase):
    """The scan reads every version, before and after the database moved to data/events/."""

    def test_both_layouts_are_scanned(self):
        import contextlib
        import io
        import os
        import shutil
        import subprocess
        import tempfile
        from pathlib import Path
        from unittest import mock
        store = recover.events_store

        def item(key, published):
            return {"id": key, "url": f"https://news.test/{key}", "title": key, "published": published}

        def save(*events):
            (root / "events.json").write_bytes(store.canonical({"number_of_events": len(events), "events": list(events)}))

        def git(*args):
            subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)

        with tempfile.TemporaryDirectory() as folder, mock.patch.dict(os.environ, {"GITHUB_ACTIONS": ""}), \
                contextlib.redirect_stdout(io.StringIO()):
            root = Path(folder)
            git("init", "--quiet", "--initial-branch=main")
            git("config", "user.email", "test@example.test")
            git("config", "user.name", "Test")
            shutil.copyfile(Path(recover.ROOT) / ".gitattributes", root / ".gitattributes")
            a, b, c = item("a", "2026-11-02T00:00:00Z"), item("b", "2026-10-01T00:00:00Z"), item("c", "2026-11-05T00:00:00Z")
            save(a, b)
            git("add", "-A")
            git("commit", "-q", "-m", "Legacy")
            save(a)
            git("add", "-A")
            git("commit", "-q", "-m", "Legacy removal of b")
            for direction in ("expand", "contract"):
                git("commit", "-q", "-m", store.migrate(root, direction)["message"])
            save(c)
            with mock.patch.dict(os.environ, {"ALLOW_SHRINK": "1"}):
                store.stage(root)
            git("commit", "-q", "-m", "Store removal of a")
            with mock.patch.object(recover, "ROOT", root):
                leads, _ = recover.scan_history(lambda url: url)
        self.assertEqual(set(leads), {a["url"], b["url"], c["url"]})
        self.assertIn("Legacy removal of b", leads[b["url"]]["removed_by"])
        self.assertIn("Store removal of a", leads[a["url"]]["removed_by"])
        self.assertIsNone(leads[c["url"]]["removed_by"])


if __name__ == "__main__":
    unittest.main()
