"""tools/restore_removed_events.py puts back events a cleanup re-check removed,
never the opinion pieces, never an event the map already holds again."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("restore_removed_events", "tools/restore_removed_events.py")
restore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore)


def event(n, title, url=None, **extra):
    return {"id": f"evt-{n}", "url": url or f"https://outlet.test/{n}", "title": title, "source": "Outlet",
            "published": f"2026-09-{10 + n:02d}T08:00:00+00:00", "ai_relevance_score": 65, **extra}


class RestoreTests(unittest.TestCase):
    def test_rechecked_events_come_back_and_nothing_twice(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            gnews = "https://news.google.com/rss/articles/CBMi"
            live = [event(1, "JNIM fighters ambush army convoy near Boni"),
                    event(2, "Gunmen storm police station in Diffa", url=gnews + "AAA")]
            (root / "events.json").write_text(json.dumps({"events": live, "number_of_events": 2}), encoding="utf-8")
            removed = root / "removed.json"
            removed.write_text(json.dumps({"events": [
                event(3, "Militants attack checkpoint in Borno", _cleanup_reason="gemini re-check: score 40 under current rules"),
                event(4, "Opinion: what the Sahel crisis means", _cleanup_reason="keyword: opinion/analysis pattern"),
                event(1, "JNIM fighters ambush army convoy near Boni", _cleanup_reason="gemini re-check: score 30 under current rules"),
                # The same Google News article under a new redirect token.
                event(5, "Gunmen storm police station in Diffa", url=gnews + "BBB",
                      published="2026-09-12T08:00:00+00:00", _cleanup_reason="gemini re-check: score 0 under current rules"),
            ]}), encoding="utf-8")
            self.assertEqual(restore.main([str(removed), "--input", str(root / "events.json")]), 0)
            data = json.loads((root / "events.json").read_text(encoding="utf-8"))
            self.assertEqual([e["id"] for e in data["events"]], ["evt-3", "evt-2", "evt-1"], "newest first")
            self.assertEqual(data["number_of_events"], 3)
            self.assertNotIn("_cleanup_reason", data["events"][0])


if __name__ == "__main__":
    unittest.main()
