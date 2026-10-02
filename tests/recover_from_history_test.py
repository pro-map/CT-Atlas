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


if __name__ == "__main__":
    unittest.main()
