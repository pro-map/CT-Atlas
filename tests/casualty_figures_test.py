"""The casualty figures the selection review writes on each record.

The header counted 3 victims killed and 0 terrorists killed on 15 Nov: most
reports give casualties without a written number ("killed a Chinese national
and a police inspector", "Troops neutralize terrorist"), and the strict text
readers leave those unread on purpose. The review that already reads every
article now returns the figures in the same call; the header reads them first.
"""
import importlib.util
import os
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

import collector

FIELDS = ("victims_killed", "victims_wounded", "perpetrators_killed", "perpetrators_captured")


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def items(schema):
    return schema["properties"]["results"]["items"]


def decision(**figures):
    return {
        "relevance_score": 90, "is_current_ct_event": True, "categories": ["Attacks"], "original_language": "en",
        "english_title": "Suspected terrorists kill Chinese national and police inspector in Bauchi",
        "english_summary": "Suspected terrorists killed a Chinese national and a police inspector in Bauchi State.",
        "canonical_event": "Attack kills Chinese national and police inspector in Bauchi", "actor_group": "",
        "primary_event_type": "ATTACK", "is_attack": True, "update_type": "INITIAL",
        "incident_anchor": "Bauchi attack Nigeria 2026-11-15", "actor_scope": "NON_STATE", "reason": "attack",
        **figures,
    }


def candidate():
    return {"id": "c1", "title": "Bauchi attack", "summary": "Bauchi attack", "url": "https://example.test/bauchi",
            "source": "Reuters", "published": "2026-11-15T08:00:00+00:00"}


class SchemaTests(unittest.TestCase):
    def test_the_four_figures_are_required_nullable_integers(self):
        for schema in (collector.AI_SELECTION_SCHEMA, collector.AI_SELECTION_SCHEMA_KNOWN):
            item = items(schema)
            for name in FIELDS:
                self.assertEqual(item["properties"][name], {"type": ["integer", "null"]}, name)
                self.assertIn(name, item["required"], "an optional field is mostly left out")

    def test_the_prompt_defines_them_on_the_phrasings_the_header_missed(self):
        text = collector.AI_SELECTION_INSTRUCTIONS
        self.assertIn("final editorial relevance filter", text.lower(),
                      "tools/run_collector_quota_safe.py recognises the selection call by this phrase")
        for phrase in FIELDS + ("null when the text does not say", "Chinese national and a police inspector",
                                "neutralize terrorist", "never a sum", "Executions carried"):
            self.assertIn(phrase, text)

    def test_without_casualty_fields_leaves_the_shared_schema_alone(self):
        trimmed = items(collector.without_casualty_fields(collector.AI_SELECTION_SCHEMA_KNOWN))
        self.assertFalse(set(FIELDS) & set(trimmed["properties"]))
        self.assertFalse(set(FIELDS) & set(trimmed["required"]))
        self.assertIn("known_incident_ref", trimmed["required"])
        self.assertIn("victims_killed", items(collector.AI_SELECTION_SCHEMA_KNOWN)["properties"])


class FigureTests(unittest.TestCase):
    def test_a_decision_from_before_the_fields_has_none(self):
        self.assertIsNone(collector.casualty_figures({"relevance_score": 90}))

    def test_only_whole_figures_in_range_are_kept(self):
        self.assertEqual(collector.casualty_figures(dict.fromkeys(FIELDS)), {})
        self.assertEqual(collector.casualty_figures({"victims_killed": 2, "victims_wounded": 0, "perpetrators_killed": None,
                                                     "perpetrators_captured": 9.0}),
                         {"victims_killed": 2, "victims_wounded": 0, "perpetrators_captured": 9})
        for bad in (-1, 2.5, "3", True, 100001):
            self.assertEqual(collector.casualty_figures({"victims_killed": bad}), {}, bad)

    def test_the_record_keeps_the_figures_of_its_own_decision(self):
        event = candidate()
        collector.apply_ai_selection(event, decision(victims_killed=2, victims_wounded=None,
                                                     perpetrators_killed=None, perpetrators_captured=None))
        self.assertEqual(event["casualties"], {"victims_killed": 2})
        self.assertEqual(event["title"], "Suspected terrorists kill Chinese national and police inspector in Bauchi")
        collector.apply_ai_selection(event, decision())
        self.assertNotIn("casualties", event, "a decision without figures must not keep another text's figures")


class MergeTests(unittest.TestCase):
    def record(self, title, source, url, **fields):
        return {"id": title[:12], "title": title, "summary": title, "published": "2026-11-15T08:00:00+00:00",
                "source": source, "sources": [source], "url": url, "category": "Attacks", "categories": ["Attacks"],
                "related_articles": [], "article_count": 1, **fields}

    def test_the_figures_follow_the_headline(self):
        existing = self.record("Attack in Bauchi", "Unknown blog", "https://blog.test/a", casualties={"victims_killed": 1})
        better = self.record("Two killed in Bauchi attack", "Reuters", "https://www.reuters.com/a", casualties={"victims_killed": 2})
        self.assertGreater(collector.source_rank("Reuters"), collector.source_rank("Unknown blog"))
        collector.merge_event(existing, better, 0.9, "test")
        self.assertEqual(existing["casualties"], {"victims_killed": 2})
        unreviewed = self.record("Bauchi attack: toll", "Reuters", "https://www.reuters.com/b")
        existing = self.record("Attack in Bauchi", "Unknown blog", "https://blog.test/a", casualties={"victims_killed": 1})
        collector.merge_event(existing, unreviewed, 0.9, "test")
        self.assertNotIn("casualties", existing, "the header reads the promoted headline's own text")

    def test_a_lesser_source_leaves_the_headline_and_its_figures(self):
        existing = self.record("Two killed in Bauchi attack", "Reuters", "https://www.reuters.com/a", casualties={"victims_killed": 2})
        lesser = self.record("Attack in Bauchi", "Unknown blog", "https://blog.test/a", casualties={})
        collector.merge_event(existing, lesser, 0.9, "test")
        self.assertEqual(existing["casualties"], {"victims_killed": 2})


class SchemaRefusalTests(unittest.TestCase):
    """Nullable integers are documented for the Interactions API but new here:
    a refusal must cost one request, not the collection."""

    def setUp(self):
        self.bodies, self.responses = [], []
        self.patches = [patch.object(collector.requests, "post", self.post),
                        patch.object(collector.time, "sleep", lambda *_: None),
                        patch.object(collector, "extract_interaction_text", lambda payload: payload["text"]),
                        patch.object(collector, "KNOWN_INCIDENTS", None),
                        patch.object(collector, "CASUALTY_SCHEMA_REFUSED", False),
                        patch.dict(os.environ, {"GEMINI_API_KEY": "stub"})]
        for patcher in self.patches:
            patcher.start()
            self.addCleanup(patcher.stop)

    def post(self, url, **kwargs):
        # The retry resends the same body object: keep the schema each request carried.
        self.bodies.append(kwargs["json"]["response_format"]["schema"])
        status, text = self.responses.pop(0)
        return SimpleNamespace(status_code=status, text=text, json=lambda: {"text": text})

    def test_a_refused_schema_is_asked_again_without_the_figures(self):
        self.responses += [(400, '{"error": {"message": "Invalid value at response_format.schema.type"}}'),
                           (200, '{"results": [{"event_id": "e1"}]}'),
                           (200, '{"results": [{"event_id": "e2"}]}')]
        self.assertEqual(collector.call_ai_selection_batch([{"event_id": "e1"}]), [{"event_id": "e1"}])
        self.assertIs(self.bodies[0], collector.AI_SELECTION_SCHEMA)
        self.assertNotIn("victims_killed", items(self.bodies[1])["properties"])
        collector.call_ai_selection_batch([{"event_id": "e2"}])
        self.assertNotIn("victims_killed", items(self.bodies[2])["properties"], "the rest of the run asks without them")

    def test_any_other_400_still_stops_the_batch(self):
        self.responses += [(400, '{"error": {"message": "API key not valid"}}')]
        with self.assertRaises(RuntimeError):
            collector.call_ai_selection_batch([{"event_id": "e1"}])
        self.assertFalse(collector.CASUALTY_SCHEMA_REFUSED)


class PublicationTests(unittest.TestCase):
    """events-map.json and events-lite.json keep every field they do not list."""

    def database(self):
        attack = {"id": "a", "published": "2026-11-15T08:00:00Z", "title": "Somalia MP killed in drive-by shooting",
                  "primary_event_type": "ATTACK", "is_attack": True, "category": "Attacks", "incident_id": "inc-a",
                  "casualties": {"victims_killed": 1}}
        arrest = {"id": "b", "published": "2026-11-15T09:00:00Z", "title": "Ten presumed members of 'Los Cocos' captured",
                  "primary_event_type": "ARREST", "category": "Arrests", "casualties": {"perpetrators_captured": 10}}
        return {"last_updated": "2026-11-16T10:00:00Z", "events": [attack, arrest]}

    def test_both_derived_files_keep_the_figures(self):
        build_map = _load("build_events_map", "tools/build_events_map.py")
        build_lite = _load("build_events_lite", "tools/build_events_lite.py")
        excluded = build_lite.load_excluded()
        self.assertNotIn("casualties", excluded)
        database = self.database()
        lite = build_lite.build_lite(database, excluded)
        build_lite.validate(lite, database)
        self.assertEqual([event["casualties"] for event in lite["events"]],
                         [{"victims_killed": 1}, {"perpetrators_captured": 10}])
        output = build_map.build_map(database, excluded, now=datetime(2026, 11, 16, 12, tzinfo=timezone.utc))
        build_map.validate(output, database)
        self.assertEqual(output["events"][0]["casualties"], {"victims_killed": 1})
        self.assertEqual(output["recent_events"][0]["casualties"], {"perpetrators_captured": 10})


if __name__ == "__main__":
    unittest.main()
