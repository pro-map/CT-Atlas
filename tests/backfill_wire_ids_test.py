"""The manual Gemini backfill tools must map answers back by list position, not
by event id: legacy ids are shared by unrelated non-Latin headlines, so an
answer keyed by id would be applied to every event carrying it."""
import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path


def load_tool(name):
    spec = importlib.util.spec_from_file_location(name, f"tools/{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


NOW = datetime.now(timezone.utc).isoformat()


class WireIdTests(unittest.TestCase):
    def run_tool(self, tool, events, answer):
        seen_ids = []

        def fake_call_batch(items):
            seen_ids.extend(item["event_id"] for item in items)
            return [{"event_id": item["event_id"], **answer(item)} for item in items]

        database = {"events": events}
        original_load = tool.collector.load_database_strict
        original_call, original_root = tool.call_batch, tool.ROOT
        with tempfile.TemporaryDirectory() as tmp:
            tool.collector.load_database_strict = lambda: database
            tool.call_batch = fake_call_batch
            tool.ROOT = Path(tmp)
            try:
                tool.main()
                written = json.loads((Path(tmp) / "events.json").read_text(encoding="utf-8"))
            finally:
                tool.collector.load_database_strict = original_load
                tool.call_batch, tool.ROOT = original_call, original_root
        return written["events"], seen_ids

    def test_recategorize_answers_each_event_even_when_ids_are_shared(self):
        tool = load_tool("recategorize_ct_action")
        events = [
            {"id": "dup", "title": "Police raid dismantles cell", "summary": "", "published": NOW, "categories": ["Attacks"], "category": "Attacks"},
            {"id": "dup", "title": "Bomb attack on market", "summary": "", "published": NOW, "categories": ["Attacks"], "category": "Attacks"},
        ]
        written, seen_ids = self.run_tool(
            tool, events,
            lambda item: {"tags": ["Counter Terrorism Action"] if "raid" in item["title"] else ["Attacks"]},
        )
        self.assertEqual(seen_ids, ["idx0", "idx1"])
        self.assertEqual(written[0]["categories"], ["Counter Terrorism Action"])
        self.assertEqual(written[1]["categories"], ["Attacks"])

    def test_actor_group_backfill_answers_each_event_even_when_ids_are_shared(self):
        tool = load_tool("backfill_actor_group")
        events = [
            {"id": "dup", "title": "Gaza rocket fire", "summary": "", "published": NOW},
            {"id": "dup", "title": "Raqqa ambush", "summary": "", "published": NOW},
        ]
        written, seen_ids = self.run_tool(
            tool, events,
            lambda item: {"actor_group": "Hamas" if "Gaza" in item["title"] else "Islamic State"},
        )
        self.assertEqual(seen_ids, ["idx0", "idx1"])
        canonical = tool.collector.canonicalize_actor_group
        self.assertEqual(written[0]["actor_group"], canonical("Hamas"))
        self.assertEqual(written[1]["actor_group"], canonical("Islamic State"))
        self.assertNotEqual(written[0]["actor_group"], written[1]["actor_group"])


if __name__ == "__main__":
    unittest.main()
