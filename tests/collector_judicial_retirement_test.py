"""Retirement stops fresh discovery, queued AI work and cached court verdicts."""
import copy
import unittest
from unittest.mock import patch

import collector


class CollectorJudicialRetirementTests(unittest.TestCase):
    def test_retired_category_has_no_active_schema_or_query_inventory(self):
        for name in ("CATEGORIES", "CORE_SEARCH_QUERIES", "OFFICIAL_SOURCE_QUERIES",
                     "TARGETED_MEDIA_CATEGORY_TERMS", "CATEGORY_RELEVANCE", "ACTION_TERMS"):
            self.assertNotIn("Legal / Judicial", getattr(collector, name), name)
        for profile in collector.MULTILINGUAL_PROFILES:
            self.assertFalse(any(row["category"] == "Legal / Judicial" for row in profile["queries"]))
        properties = collector.AI_SELECTION_SCHEMA["properties"]["results"]["items"]["properties"]
        self.assertNotIn("Legal / Judicial", properties["categories"]["items"]["enum"])
        self.assertNotIn("JUDICIAL", properties["primary_event_type"]["enum"])
        self.assertNotIn("JUDICIAL_UPDATE", properties["update_type"]["enum"])

    def test_court_headline_is_screened_before_other_scope_exemptions(self):
        self.assertTrue(collector.out_of_scope_reason({
            "title": "ISIS supporter sentenced for terrorism financing", "summary": ""}))
        self.assertFalse(collector.is_relevant_article("Terrorist Financing",
            "ISIS supporter sentenced for terrorism financing", "Court imposed a prison term."))
        self.assertEqual(collector.out_of_scope_reason({
            "title": "Police arrest ISIS suspect", "summary": "An earlier suspect was sentenced."}), "")

    def test_resumed_court_queue_uses_zero_ai_calls(self):
        candidates = [{"id": "trial", "title": "Terrorism trial begins", "summary": ""},
                      {"id": "typed", "title": "A later case development", "primary_event_type": "JUDICIAL"}]
        with patch.object(collector, "load_selection_cache", return_value={"items": {}}), \
             patch.object(collector, "save_selection_cache"), \
             patch.object(collector, "process_ai_selection_batch") as ai, \
             patch.object(collector, "persist_background_articles_to_d1") as archive:
            self.assertEqual(collector.ai_select_events(candidates), [])
            ai.assert_not_called()
            archive.assert_not_called()

    def test_cached_judicial_decision_cannot_be_relabelled_as_weapons(self):
        source = {"id": "court", "title": "Weapons case update", "categories": ["Weapons"]}
        result = {"relevance_score": 95, "is_current_ct_event": True,
                  "categories": ["Weapons"], "primary_event_type": "JUDICIAL"}
        self.assertFalse(collector.apply_ai_selection(source, result))
        self.assertFalse(source["ai_selected"])
        self.assertFalse(source["ai_current_ct_event"])

    def test_translated_court_record_cannot_evade_retirement_with_arrest_type(self):
        source = {"id": "foreign-court", "title": "محاكمة", "categories": ["Arrests"]}
        decision = {"relevance_score": 90, "is_current_ct_event": True,
                    "primary_event_type": "ARREST", "categories": ["Arrests"],
                    "english_title": "ISIS supporter convicted of terrorism"}
        self.assertFalse(collector.apply_ai_selection(source, decision))
        self.assertFalse(source["ai_selected"])

    def test_existing_operational_record_is_preserved_and_label_stripped(self):
        arrest = {"id": "arrest", "primary_event_type": "ARREST", "update_type": "JUDICIAL_UPDATE",
                  "title": "Police arrest suspect", "category": "Legal / Judicial"}
        court = {"id": "court", "primary_event_type": "JUDICIAL", "category": "Weapons"}
        with patch.object(collector, "load_database_strict", return_value={"events": [copy.deepcopy(arrest), court]}):
            retained = collector.load_existing()
        self.assertEqual(len(retained), 1)
        self.assertEqual(retained[0]["id"], "arrest")
        self.assertEqual(retained[0]["categories"], ["Arrests"])

    def test_retired_reject_is_not_sent_to_background_d1(self):
        with patch.object(collector, "persist_background_articles_to_d1") as d1:
            collector.persist_background_articles([{"id": "court", "primary_event_type": "JUDICIAL"}])
            collector.persist_background_articles([{"id": "old", "ai_scope_rejection": "Judicial collection is retired"}])
            d1.assert_not_called()


if __name__ == "__main__":
    unittest.main()
