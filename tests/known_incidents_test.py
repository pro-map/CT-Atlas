"""Known-incident reuse: the list, the wire format, the zero-AI gate, cached
decisions, the rolling registry, batch affinity and the wiring into the run.
No provider is called; requests.post is always a stub."""
import copy
import json
import os
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import collector
import daily_pipeline
import known_incidents
import map_evidence_integrity as mei

ROOT = Path(__file__).resolve().parents[1]

NOW = datetime(2026, 11, 2, 12, tzinfo=timezone.utc)
COUNTRIES = ["Jordan", "France"]
ANCHOR = "Karak church attack Jordan 2026-11-01"
PREFIX = "Review every candidate CT event below. Return exactly one result for every event_id.\n\n"


def iso(hours_ago):
    return (NOW - timedelta(hours=hours_ago)).isoformat()


def slug(text):
    return re.sub(r"\W+", "-", text.lower()).strip("-")


def record(title, hours_ago=24, incident_id="inc-karak", anchor=ANCHOR, kind="ATTACK", update="INITIAL",
           country="Jordan", code="JO", url=None, original=None, related=None):
    return {"id": "rec-" + slug(title), "title": title, "original_title": original or title,
            "summary": title, "original_summary": original or title, "published": iso(hours_ago),
            "url": url or "https://example.test/rec/" + slug(title), "incident_id": incident_id,
            "incident_anchor": anchor, "primary_event_type": kind, "update_type": update,
            "country": country, "country_code": code, "related_articles": related or []}


def candidate(title, hours_ago=6, url=None, summary=None):
    return {"id": "cand-" + slug(title), "title": title, "summary": summary or title,
            "url": url or "https://example.test/cand/" + slug(title), "published": iso(hours_ago),
            "categories": ["Attacks"], "category": "Attacks", "source": "Outlet"}


def decision(english_title, update="FOLLOW_UP", kind="ATTACK", anchor=None, cited=None, score=85, event_id=""):
    result = {"event_id": event_id, "relevance_score": score, "is_current_ct_event": True,
              "categories": ["Attacks"], "original_language": "en", "english_title": english_title,
              "english_summary": english_title, "canonical_event": english_title, "actor_group": "",
              "primary_event_type": kind, "is_attack": kind == "ATTACK", "actor_scope": "NON_STATE",
              "incident_anchor": anchor or english_title + " own anchor", "update_type": update,
              "reason": "Reported incident."}
    if cited:
        result["known_incident_id"] = cited
    return result


def index(records, mode="on", aliases=None, weak=None):
    weak = weak if weak is not None else mei.consolidation_weak_words(records, COUNTRIES)
    return known_incidents.build(records, aliases or {}, NOW, weak, COUNTRIES, collector, mode)


def applied(known, event, result):
    with patch.object(collector, "KNOWN_INCIDENTS", known):
        return collector.apply_ai_selection(event, result)


def payload(event, index_=0):
    return collector.selection_payload(event, index_)


def own_hash(result):
    return collector.anchor_incident_id(result["incident_anchor"])


class IndexTests(unittest.TestCase):
    def test_aliases_merge_under_the_canonical_id(self):
        known = index([record("Karak church shooting", incident_id="inc-old"),
                       record("Karak church toll rises", incident_id="inc-karak", update="FOLLOW_UP")],
                      aliases={"inc-old": "inc-karak"})
        self.assertEqual(list(known.incidents), ["inc-karak"])
        self.assertEqual(len(known.incidents["inc-karak"]["records"]), 2)
        self.assertIs(known.get("inc-old"), known.incidents["inc-karak"])

    def test_review_ids_and_rule_bearing_incidents_are_never_listed(self):
        ruled = record("Reviewed separate attack", incident_id="inc-ruled", anchor="Reviewed attack")
        records = [record("Karak church shooting"), ruled,
                   record("Isolated attack", incident_id="inc-review-1", anchor="Isolated attack")]
        with patch.object(mei, "matched_rule", lambda event: {"reason": "x"} if event.get("id") == ruled["id"] else None):
            known = index(records)
        self.assertEqual(list(known.incidents), ["inc-karak"])
        self.assertEqual(known.blocked, {"inc-ruled", "inc-review-1"})

    def test_degenerate_anchors_are_skipped(self):
        known = index([record("One thing", incident_id="inc-1", anchor="None"),
                       record("Two thing", incident_id="inc-2", anchor="p2"),
                       record("Three thing", incident_id="inc-3", anchor=""),
                       record("Four thing", incident_id="inc-4", anchor="Real anchor")])
        self.assertEqual(list(known.incidents), ["inc-4"])

    def test_an_incident_of_only_other_ct_records_is_not_listed(self):
        known = index([record("Policy speech", incident_id="inc-1", kind="OTHER_CT"),
                       record("Mixed one", incident_id="inc-2", kind="OTHER_CT", update="OTHER_UPDATE"),
                       record("Mixed two", incident_id="inc-2", kind="ARREST", update="FOLLOW_UP")])
        self.assertEqual(list(known.incidents), ["inc-2"])
        self.assertEqual(known.incidents["inc-2"]["type"], "ARREST")

    def test_anchor_is_the_earliest_initial_else_the_most_frequent(self):
        known = index([record("Later one", 10, incident_id="inc-1", anchor="Later anchor"),
                       record("Earlier one", 20, incident_id="inc-1", anchor="Earliest anchor"),
                       record("Update one", 30, incident_id="inc-1", anchor="Update anchor", update="FOLLOW_UP"),
                       record("Update two", 10, incident_id="inc-2", anchor="Rare", update="FOLLOW_UP"),
                       record("Update three", 9, incident_id="inc-2", anchor="Common", update="FOLLOW_UP"),
                       record("Update four", 8, incident_id="inc-2", anchor="Common", update="FOLLOW_UP")])
        self.assertEqual(known.incidents["inc-1"]["anchor"], "Earliest anchor")
        self.assertEqual(known.incidents["inc-2"]["anchor"], "Common")

    def test_evidence_is_the_earliest_records_with_initial_reports_first(self):
        records = [record(f"Story update {n}", 100 - n, update="FOLLOW_UP") for n in range(50)]
        records.append(record("Story first report", 1))
        evidence = index(records).incidents["inc-karak"]["evidence"]
        self.assertEqual(len(evidence), known_incidents.EVIDENCE_RECORDS)
        self.assertEqual(evidence[0]["title"], "Story first report")
        self.assertEqual(evidence[1]["title"], "Story update 0")

    def test_the_seven_day_limit_follows_the_newest_date_of_the_batch(self):
        old = record("Wadi Musa checkpoint ambush", 24 * 20, incident_id="inc-old", anchor="Wadi Musa ambush")
        known = index([old, record("Karak church shooting", 24)])
        rows, _ = known.for_batch([payload(candidate("Wadi Musa checkpoint ambush toll", 6))])
        self.assertNotIn("Wadi Musa ambush", [row[3] for row in rows])
        rows, _ = known.for_batch([payload(candidate("Wadi Musa checkpoint ambush toll", 24 * 19))])
        self.assertEqual([row[3] for row in rows], ["Wadi Musa ambush"], "No hot list for an old batch.")

    def test_a_cached_id_still_resolves_after_the_incident_left_the_window(self):
        known = index([record("Old attack in Wadi Musa", 24 * 60, incident_id="inc-old", anchor="Wadi Musa ambush")])
        self.assertEqual(known.get("inc-old")["id"], "inc-old")

    def test_hot_incidents_come_first_and_the_list_is_capped(self):
        town = lambda n: f"town{chr(97 + n % 26)}{chr(97 + n // 26)}"
        records = [record(f"Plain story {n} {town(n)}", 5, incident_id=f"inc-{n:03}", anchor=f"Anchor {n}")
                   for n in range(90)]
        records[70]["related_articles"] = [{"title": "Copy"}] * 5
        records[71]["related_articles"] = [{"title": "Copy"}] * 3
        known = index(records)
        rows, refs = known.for_batch([payload(candidate(f"News of {town(n)}")) for n in range(40, 80)])
        self.assertEqual(len(rows), 60)
        self.assertEqual([rows[0][3], rows[1][3]], ["Anchor 70", "Anchor 71"])
        self.assertEqual(list(refs), [f"K{n}" for n in range(1, 61)])
        self.assertEqual(rows[0][:3], ["K1", "2026-11-02", "ATTACK"])
        self.assertIn("inc-045", list(refs.values())[30:], "A candidate's own match follows the hot part.")

    def test_identical_input_gives_identical_refs(self):
        records = [record(f"Story of town{chr(97 + n)}", 5 + n, incident_id=f"inc-{n}", anchor=f"Anchor {n}") for n in range(20)]
        batch = [payload(candidate("News of towna and townb and townc"))]
        first = index(copy.deepcopy(records)).for_batch(batch)
        second = index(list(reversed(copy.deepcopy(records)))).for_batch(batch)
        self.assertEqual(first, second)

    def test_a_batch_with_no_shared_words_still_gets_the_hot_list(self):
        known = index([record("Karak church shooting", 24)])
        rows, refs = known.for_batch([payload(candidate("هجوم على كنيسة في مدينة الأردنية"))])
        self.assertEqual(rows[0][3], ANCHOR)
        self.assertEqual(refs, {"K1": "inc-karak"})

    def test_listing_marks_the_incident_as_offered(self):
        known = index([record("Karak church shooting", 24)])
        self.assertEqual(known.offered, set())
        known.for_batch([payload(candidate("Unrelated words only"))])
        self.assertEqual(known.offered, {"inc-karak"})


class WireTests(unittest.TestCase):
    def setUp(self):
        self.bodies = []
        self.answers = []
        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(collector.requests, "post", self.post))
        stack.enter_context(patch.object(collector.time, "sleep"))
        stack.enter_context(patch.object(collector, "extract_interaction_text", lambda response: response["text"]))
        stack.enter_context(patch.dict(os.environ, {"GEMINI_API_KEY": "stub"}))

    def post(self, url, **kwargs):
        body = kwargs["json"]
        self.bodies.append(body)
        answer = self.answers.pop(0)
        results = answer(body) if callable(answer) else answer
        return SimpleNamespace(status_code=200, text="", json=lambda: {"text": _dumps({"results": results})})

    def test_unarmed_body_is_todays_body(self):
        batch = [payload(candidate("Karak church shooting"))]
        self.answers.append([{"event_id": batch[0]["event_id"], "known_incident_id": "inc-x"}])
        results = collector.call_ai_selection_batch(batch)
        body = self.bodies[0]
        self.assertEqual(body["input"], PREFIX + _dumps({"events": batch}))
        self.assertIs(body["response_format"]["schema"], collector.AI_SELECTION_SCHEMA)
        self.assertEqual(results[0]["known_incident_id"], "inc-x", "No translation when no list was sent.")

    def test_an_empty_list_sends_todays_body(self):
        batch = [payload(candidate("Karak church shooting"))]
        self.answers.append([{"event_id": batch[0]["event_id"]}])
        with patch.object(collector, "KNOWN_INCIDENTS", index([])):
            collector.call_ai_selection_batch(batch)
        self.assertEqual(self.bodies[0]["input"], PREFIX + _dumps({"events": batch}))
        self.assertIs(self.bodies[0]["response_format"]["schema"], collector.AI_SELECTION_SCHEMA)

    def call_armed(self, known, batch, answer):
        self.answers.append(answer)
        with patch.object(collector, "KNOWN_INCIDENTS", known):
            return collector.call_ai_selection_batch(batch)

    def block(self):
        return json.loads(self.bodies[-1]["input"].rsplit("\n\n", 1)[1])

    def test_the_list_travels_as_rows_beside_the_note_and_a_required_ref(self):
        known = index([record("Karak church shooting", 24)])
        batch = [payload(candidate("Karak church funeral"))]
        self.call_armed(known, batch, [{"event_id": batch[0]["event_id"], "known_incident_ref": ""}])
        body = self.bodies[0]
        self.assertTrue(body["input"].startswith(PREFIX + known_incidents.KNOWN_INCIDENT_NOTE))
        self.assertEqual(self.block(), {"known_incidents": [["K1", "2026-11-01", "ATTACK", ANCHOR]], "events": batch})
        self.assertNotIn("event_id", _dumps(self.block()["known_incidents"]))
        item = body["response_format"]["schema"]["properties"]["results"]["items"]
        self.assertIn("known_incident_ref", item["required"])
        self.assertEqual(item["properties"]["known_incident_ref"], {"type": "string"})
        self.assertEqual(body["system_instruction"], collector.AI_SELECTION_INSTRUCTIONS)
        base = collector.AI_SELECTION_SCHEMA["properties"]["results"]["items"]
        self.assertNotIn("known_incident_ref", base["properties"])
        self.assertNotIn("known_incident_ref", base["required"])

    def test_a_ref_becomes_the_stable_id_and_never_reaches_the_result(self):
        known = index([record("Karak church shooting", 24)])
        batch = [payload(candidate("Karak church funeral"))]
        results = self.call_armed(known, batch, [{"event_id": batch[0]["event_id"], "known_incident_ref": "K1"}])
        self.assertEqual(results, [{"event_id": batch[0]["event_id"], "known_incident_id": "inc-karak"}])
        self.assertEqual(known.stats["refs_set"], 1)

    def test_an_unknown_ref_is_dropped_and_counted(self):
        known = index([record("Karak church shooting", 24)])
        batch = [payload(candidate("Karak church funeral"))]
        results = self.call_armed(known, batch, [{"event_id": batch[0]["event_id"], "known_incident_ref": "K99"}])
        self.assertEqual(results, [{"event_id": batch[0]["event_id"]}])
        self.assertEqual(known.stats["refs_unknown"], 1)

    def test_a_known_incident_id_sent_by_the_model_is_discarded(self):
        known = index([record("Karak church shooting", 24)])
        batch = [payload(candidate("Karak church funeral"))]
        results = self.call_armed(known, batch, [{"event_id": batch[0]["event_id"], "known_incident_ref": "",
                                                  "known_incident_id": "inc-invented"}])
        self.assertEqual(results, [{"event_id": batch[0]["event_id"]}])

    def test_a_split_retry_gets_its_own_map(self):
        known = index([record("Wadi Musa ambush", 24 * 20, incident_id="inc-a", anchor="Anchor A"),
                       record("Aqaba harbour blast", 24 * 20, incident_id="inc-b", anchor="Anchor B")])
        left = payload(candidate("Wadi Musa ambush funeral", 24 * 19))
        right = payload(candidate("Aqaba harbour blast inquiry", 24 * 19))
        reply = lambda body: [{"event_id": item["event_id"], "known_incident_ref": "K1"}
                              for item in json.loads(body["input"].rsplit("\n\n", 1)[1])["events"]]
        self.answers += [[{"event_id": left["event_id"]}], reply, reply]
        with patch.object(collector, "KNOWN_INCIDENTS", known):
            results = collector.process_ai_selection_batch([left, right])
        self.assertEqual(len(self.bodies), 3)
        self.assertEqual({result["event_id"]: result["known_incident_id"] for result in results},
                         {left["event_id"]: "inc-a", right["event_id"]: "inc-b"})


def _dumps(value):
    return json.dumps(value, ensure_ascii=False)


class GateTests(unittest.TestCase):
    def setUp(self):
        self.first = record("Gunman attacks Karak church during Sunday service", 24)
        self.known = index([self.first])

    def reused(self, event, result, known=None):
        known = known or self.known
        kept = applied(known, event, result)
        self.assertTrue(kept)
        return event

    def assert_refused(self, event, result, reason):
        self.reused(event, result)
        self.assertEqual(event["incident_id"], own_hash(result))
        self.assertEqual(event["incident_reuse_refused"], reason)
        self.assertNotIn("incident_reuse", event)
        self.assertEqual(self.known.stats[reason], 1)

    def test_a_follow_up_joins_the_cited_incident(self):
        event = self.reused(candidate("Funeral held for Karak victims"),
                            decision("Funeral held for Karak victims", cited="inc-karak"))
        self.assertEqual(event["incident_id"], "inc-karak")
        self.assertEqual(event["incident_anchor"], ANCHOR)
        self.assertEqual(event["incident_reuse"], "cited")
        self.assertEqual(self.known.stats["accepted"], 1)

    def test_an_anchor_alone_is_no_evidence(self):
        known = index([record("Gunman opens fire on worshippers", 24)])
        event = candidate("Karak mourners gather at dawn")
        self.reused(event, decision("Karak mourners gather at dawn", cited="inc-karak"), known)
        self.assertEqual(event["incident_reuse_refused"], "no_primary_evidence")

    def test_a_shared_related_article_is_no_evidence(self):
        url = "https://example.test/shared"
        known = index([record("Gunman opens fire on worshippers", 24,
                              related=[{"title": "Karak funeral today", "url": url}])])
        event = candidate("Karak funeral today draws crowds", url=url)
        self.reused(event, decision("Karak funeral today draws crowds", cited="inc-karak"), known)
        self.assertEqual(event["incident_reuse_refused"], "no_primary_evidence")

    def test_a_reviewed_isolated_candidate_is_refused(self):
        event = candidate("Funeral held for Karak victims")
        rule = {"isolated_incident": "inc-review-9", "reason": "Reviewed separate"}
        with patch.object(mei, "matched_rule", lambda item: rule if item.get("id") == event["id"] else None):
            self.assert_refused(event, decision("Funeral held for Karak victims", cited="inc-karak"), "isolated")

    def test_an_initial_report_sharing_only_the_town_stays_separate(self):
        title = "Bomb in Karak market kills three"
        self.assert_refused(candidate(title), decision(title, update="INITIAL", cited="inc-karak"),
                            "initial_needs_two_words")

    def test_an_initial_report_after_36_hours_stays_separate(self):
        title = "Gunman attacks Karak church again"
        self.assert_refused(candidate(title, -13), decision(title, update="INITIAL", cited="inc-karak"),
                            "initial_too_late")

    def test_an_initial_report_within_36_hours_with_two_words_joins(self):
        title = "Karak church service attack leaves dead"
        event = self.reused(candidate(title, -11), decision(title, update="INITIAL", cited="inc-karak"))
        self.assertEqual(event["incident_id"], "inc-karak")

    def test_two_words_must_not_be_country_names(self):
        known = index([record("Karak Jordan shooting spree", 24)])
        event = candidate("Bomb hits Karak Jordan market")
        self.reused(event, decision("Bomb hits Karak Jordan market", update="INITIAL", cited="inc-karak"), known)
        self.assertEqual(event["incident_reuse_refused"], "initial_needs_two_words")

    def test_an_initial_report_of_another_family_stays_separate(self):
        title = "Karak church gunman arrested after service"
        self.assert_refused(candidate(title), decision(title, update="INITIAL", kind="ARREST", cited="inc-karak"),
                            "initial_other_type")

    def test_an_other_ct_initial_label_takes_the_update_path(self):
        title = "King visits Karak after attack"
        event = self.reused(candidate(title, -100), decision(title, update="INITIAL", kind="OTHER_CT", cited="inc-karak"))
        self.assertEqual(event["incident_id"], "inc-karak")

    def test_an_article_long_before_the_first_report_is_refused(self):
        title = "Karak church warned of threats"
        self.assert_refused(candidate(title, 24 * 4), decision(title, cited="inc-karak"), "before_incident")

    def test_an_update_long_after_the_last_report_is_refused(self):
        title = "Karak church memorial opens"
        self.assert_refused(candidate(title, -24 * 8), decision(title, cited="inc-karak"), "stale")

    def test_an_article_without_a_date_is_refused(self):
        event = candidate("Karak church memorial opens")
        event["published"] = ""
        self.assert_refused(event, decision("Karak church memorial opens", cited="inc-karak"), "no_date")

    def test_a_place_only_the_translation_names_is_no_evidence(self):
        event = candidate("Obseques des victimes de la fusillade dans la mosquee")
        self.assert_refused(event, decision("Funeral for Karak victims of the shooting", cited="inc-karak"),
                            "no_primary_evidence")

    def test_a_non_latin_source_cannot_be_grounded_and_is_counted(self):
        event = candidate("تشييع ضحايا الهجوم على الكنيسة")
        self.reused(event, decision("Funeral for Karak victims", cited="inc-karak"))
        self.assertEqual(event["incident_id"], "inc-karak")
        self.assertEqual(self.known.stats["accepted_non_latin"], 1)

    def copied(self):
        anchor_id = collector.anchor_incident_id(ANCHOR)
        known = index([record("Gunman attacks Karak church during Sunday service", 24, incident_id=anchor_id)])
        return known, anchor_id

    def test_a_copied_anchor_with_a_refused_ref_gets_an_id_of_its_own(self):
        known, anchor_id = self.copied()
        known.for_batch([payload(candidate("Unrelated"))])
        title = "Bomb in Karak market kills three"
        event = candidate(title)
        self.reused(event, decision(title, update="INITIAL", anchor=ANCHOR, cited=anchor_id), known)
        self.assertEqual(event["incident_reuse_refused"], "initial_needs_two_words")
        self.assertNotEqual(event["incident_id"], anchor_id)
        self.assertEqual(event["incident_id"], known_incidents.refused_incident_id(event))

    def test_a_copied_anchor_from_an_old_decision_is_gated_though_not_offered_this_run(self):
        known, anchor_id = self.copied()
        title = "Bomb in Karak market kills three"
        event = candidate(title)
        self.reused(event, decision(title, update="INITIAL", anchor=ANCHOR, cited=anchor_id), known)
        self.assertNotEqual(event["incident_id"], anchor_id)

    def test_a_copied_anchor_without_a_ref_is_gated(self):
        known, anchor_id = self.copied()
        known.for_batch([payload(candidate("Unrelated"))])
        refused = candidate("Bomb in Karak market kills three")
        self.reused(refused, decision("Bomb in Karak market kills three", update="INITIAL", anchor=ANCHOR), known)
        self.assertNotEqual(refused["incident_id"], anchor_id)
        passed = candidate("Funeral held for Karak victims")
        self.reused(passed, decision("Funeral held for Karak victims", anchor=ANCHOR), known)
        self.assertEqual(passed["incident_id"], anchor_id)
        self.assertEqual(passed["incident_reuse"], "copied_anchor")
        self.assertEqual(known.stats["copied_anchor"], 1)

    def test_an_alias_of_an_offered_incident_is_gated_too(self):
        alias = collector.anchor_incident_id("Karak attack")
        known = index([record("Gunman attacks Karak church during Sunday service", 24)], aliases={alias: "inc-karak"})
        known.for_batch([payload(candidate("Unrelated"))])
        event = candidate("Bomb in Karak market kills three")
        self.reused(event, decision("Bomb in Karak market kills three", update="INITIAL", anchor="Karak attack"), known)
        self.assertEqual(event["incident_id"], known_incidents.refused_incident_id(event))

    def test_an_own_anchor_the_model_was_not_shown_behaves_as_today(self):
        known, anchor_id = self.copied()
        event = candidate("Bomb in Karak market kills three")
        self.reused(event, decision("Bomb in Karak market kills three", update="INITIAL", anchor=ANCHOR), known)
        self.assertEqual(event["incident_id"], anchor_id)
        self.assertNotIn("incident_reuse", event)
        self.assertNotIn("incident_reuse_refused", event)

    def test_a_second_apply_changes_nothing(self):
        title = "Funeral held for Karak victims"
        result = decision(title, cited="inc-karak")
        event = self.reused(candidate(title), result)
        snapshot, stats = copy.deepcopy(event), dict(self.known.stats)
        self.reused(event, result)
        self.assertEqual(event, snapshot)
        self.assertEqual(dict(self.known.stats), stats)

    def test_an_existing_incident_id_is_left_alone(self):
        event = candidate("Funeral held for Karak victims")
        event["incident_id"] = "inc-settled"
        self.reused(event, decision("Funeral held for Karak victims", cited="inc-karak"))
        self.assertEqual(event["incident_id"], "inc-settled")
        self.assertNotIn("incident_reuse", event)
        self.assertEqual(self.known.stats["accepted"], 0)

    def test_a_below_threshold_candidate_is_left_alone(self):
        title = "Funeral held for Karak victims"
        event, result = candidate(title), decision(title, cited="inc-karak", score=10)
        self.assertFalse(applied(self.known, event, result))
        self.assertEqual(event["incident_id"], own_hash(result))
        self.assertEqual(self.known.stats["accepted"], 0)

    def test_a_scope_rejected_candidate_keeps_its_hash(self):
        title = "Funeral held for Karak victims"
        event, result = candidate(title), decision(title, cited="inc-karak")
        result["categories"] = []
        event["categories"], event["category"] = [], ""
        self.assertFalse(applied(self.known, event, result))
        self.assertEqual(event["incident_id"], own_hash(result))

    def test_an_unarmed_run_ignores_a_stored_id(self):
        title = "Funeral held for Karak victims"
        event, result = candidate(title), decision(title, cited="inc-karak")
        self.assertTrue(collector.apply_ai_selection(event, result))
        self.assertEqual(event["incident_id"], own_hash(result))
        self.assertNotIn("incident_reuse", event)

    def test_an_aliased_target_resolves_to_the_canonical_id(self):
        known = index([self.first], aliases={"inc-merged-away": "inc-karak"})
        event = self.reused(candidate("Funeral held for Karak victims"),
                            decision("Funeral held for Karak victims", cited="inc-merged-away"), known)
        self.assertEqual(event["incident_id"], "inc-karak")

    def test_a_missing_target_gives_the_own_hash(self):
        title = "Funeral held for Karak victims"
        event, result = candidate(title), decision(title, cited="inc-gone")
        self.reused(event, result)
        self.assertEqual(event["incident_id"], own_hash(result))
        self.assertEqual(self.known.stats["target_unknown"], 1)

    def test_shadow_changes_no_id_and_logs_what_it_would_do(self):
        known = index([record("Gunman attacks Karak church during Sunday service", 24,
                              incident_id=collector.anchor_incident_id(ANCHOR))], mode="shadow")
        known.for_batch([payload(candidate("Unrelated"))])
        target = next(iter(known.incidents))
        passed, passed_result = candidate("Funeral held for Karak victims"), decision("Funeral held for Karak victims", cited=target)
        refused, refused_result = (candidate("Bomb in Karak market kills three"),
                                   decision("Bomb in Karak market kills three", update="INITIAL", anchor=ANCHOR))
        self.reused(passed, passed_result, known)
        self.reused(refused, refused_result, known)
        self.assertEqual(passed["incident_id"], own_hash(passed_result))
        self.assertEqual(passed["incident_anchor"], passed_result["incident_anchor"])
        self.assertEqual(refused["incident_id"], target, "Today's path: the hash joins by itself.")
        for event in (passed, refused):
            self.assertNotIn("incident_reuse", event)
            self.assertNotIn("incident_reuse_refused", event)
        self.assertEqual((known.stats["accepted"], known.stats["initial_needs_two_words"]), (1, 1))
        self.assertEqual([(v["outcome"], v["via"], v["target"]) for v in known.stats["verdicts"]],
                         [("accepted", "cited", target), ("initial_needs_two_words", "copied_anchor", target)])
        json.dumps(known.stats)

    def test_only_the_first_verdicts_are_kept(self):
        with patch.object(known_incidents, "VERDICTS_KEPT", 2):
            for n in range(3):
                title = f"Funeral number {n} held for Karak victims"
                self.reused(candidate(title), decision(title, cited="inc-karak"))
        self.assertEqual(len(self.known.stats["verdicts"]), 2)
        self.assertEqual(self.known.stats["accepted"], 3)


class GroundedTitleTests(unittest.TestCase):
    def test_a_word_absent_from_a_latin_source_is_dropped(self):
        title = mei.grounded_title({"title": "Attack in Trappes near Paris, 2 dead",
                                    "original_title": "Fusillade a Trappes", "original_summary": "attack in the suburbs"})
        self.assertEqual(title, "Attack in Trappes , 2")

    def test_accents_do_not_matter(self):
        self.assertEqual(mei.grounded_title({"title": "Kerak church", "original_title": "Kérak église church"}),
                         "Kerak church")

    def test_an_english_title_stays_whole(self):
        title = "Karak church attack: 3 dead"
        self.assertEqual(mei.grounded_title({"title": title, "original_title": title}), title)

    def test_a_non_latin_source_stays_whole(self):
        self.assertEqual(mei.grounded_title({"title": "Karak funeral", "original_title": "جنازة في الكرك"}), "Karak funeral")


class CachedDecisionTests(unittest.TestCase):
    def setUp(self):
        self.cache = {"version": collector.AI_SELECTION_VERSION, "items": {}}
        self.saved = []
        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(collector, "load_selection_cache", lambda: self.cache))
        stack.enter_context(patch.object(collector, "save_selection_cache", lambda cache: self.saved.append(copy.deepcopy(cache))))
        stack.enter_context(patch.object(collector, "persist_background_articles", lambda events: None))
        stack.enter_context(patch.object(collector.time, "sleep"))
        stack.enter_context(patch.object(collector, "AI_SELECTION_ENABLED", True))
        stack.enter_context(patch.dict(os.environ, {"GEMINI_API_KEY": "stub"}))
        self.known = index([record("Gunman attacks Karak church during Sunday service", 24)])
        stack.enter_context(patch.object(collector, "KNOWN_INCIDENTS", self.known))

    def replay(self, event, result):
        self.cache["items"][collector.selection_fingerprint(event)] = {"version": collector.AI_SELECTION_VERSION, "result": result}
        with patch.object(collector.requests, "post", side_effect=AssertionError("No AI call")):
            return collector.ai_select_events([event])

    def test_the_selection_version_is_not_bumped(self):
        self.assertEqual(collector.AI_SELECTION_VERSION, "gemini-ct-selection-v7-standalone-threat-topics")

    def test_an_old_decision_applies_with_no_ai_call(self):
        title = "Funeral held for Karak victims"
        event, result = candidate(title), decision(title)
        self.assertEqual(self.replay(event, result), [event])
        self.assertEqual(event["incident_id"], own_hash(result))

    def test_a_decision_with_an_id_replays_with_no_ai_call(self):
        title = "Funeral held for Karak victims"
        event = candidate(title)
        self.assertEqual(self.replay(event, decision(title, cited="inc-karak")), [event])
        self.assertEqual(event["incident_id"], "inc-karak")

    def test_a_replayed_decision_passes_the_gate_again(self):
        title = "Bomb in Karak market kills three"
        event, result = candidate(title), decision(title, update="INITIAL", cited="inc-karak")
        self.assertEqual(self.replay(event, result), [event])
        self.assertEqual(event["incident_id"], own_hash(result))

    def test_the_checkpoints_store_the_stable_id_and_never_the_ref(self):
        title = "Funeral held for Karak victims"
        event = candidate(title)
        answer = dict(decision(title, event_id=event["id"]), known_incident_ref="K1")
        response = SimpleNamespace(status_code=200, text="", json=lambda: {"text": _dumps({"results": [answer]})})
        with patch.object(collector.requests, "post", return_value=response), \
             patch.object(collector, "extract_interaction_text", lambda body: body["text"]):
            self.assertEqual(collector.ai_select_events([event]), [event])
        self.assertTrue(self.saved)
        for saved in self.saved:
            stored = saved["items"][collector.selection_fingerprint(candidate(title))]["result"]
            self.assertEqual(stored["known_incident_id"], "inc-karak")
            self.assertNotIn("known_incident_ref", stored)

    def test_fingerprint_and_payload_do_not_depend_on_the_list(self):
        event = candidate("Funeral held for Karak victims")
        before = collector.selection_fingerprint(event), payload(event)
        self.known.for_batch([payload(event)])
        self.assertEqual((collector.selection_fingerprint(event), payload(event)), before)


class RollingTests(unittest.TestCase):
    def run_lane(self, events, answer):
        cache = {"version": collector.AI_SELECTION_VERSION, "items": {}}
        requests_seen = []

        def post(url, **kwargs):
            sent = json.loads(kwargs["json"]["input"].rsplit("\n\n", 1)[1])
            requests_seen.append(sent)
            text = _dumps({"results": [answer(item, sent.get("known_incidents", [])) for item in sent["events"]]})
            return SimpleNamespace(status_code=200, text="", json=lambda: {"text": text})

        with patch.object(collector, "load_selection_cache", lambda: cache), \
             patch.object(collector, "save_selection_cache", lambda current: None), \
             patch.object(collector, "persist_background_articles", lambda rows: None), \
             patch.object(collector, "extract_interaction_text", lambda body: body["text"]), \
             patch.object(collector, "AI_SELECTION_ENABLED", True), \
             patch.object(collector, "AI_SELECTION_BATCH_SIZE", 1), \
             patch.object(collector.requests, "post", post), patch.object(collector.time, "sleep"), \
             patch.dict(os.environ, {"GEMINI_API_KEY": "stub"}):
            kept = collector.ai_select_events(events, lane="recent")
        return kept, requests_seen

    def test_a_later_batch_cites_an_incident_of_an_earlier_batch(self):
        founder_anchor = "Aqaba harbour blast Jordan 2026-11-02"
        founder = candidate("Aqaba harbour blast kills sailors", 3)
        follower = candidate("Aqaba harbour blast inquiry opens", 4)
        seed = record("Gunman attacks Karak church during Sunday service", 24)
        known = index([seed])

        def answer(item, listed):
            if item["event_id"] == founder["id"]:
                return decision(founder["title"], update="INITIAL", anchor=founder_anchor, event_id=item["event_id"])
            ref = next(row[0] for row in listed if row[3] == founder_anchor)
            return dict(decision(follower["title"], event_id=item["event_id"]), known_incident_ref=ref)

        with patch.object(collector, "KNOWN_INCIDENTS", known):
            kept, requests_seen = self.run_lane([founder, follower], answer)
        self.assertEqual(len(requests_seen), 2)
        self.assertEqual(len(kept), 2)
        founded = collector.anchor_incident_id(founder_anchor)
        self.assertEqual(founder["incident_id"], founded, "The founder keeps its own hash.")
        self.assertNotIn("incident_reuse_refused", founder)
        self.assertEqual(follower["incident_id"], founded)
        self.assertEqual(follower["incident_anchor"], founder_anchor)
        self.assertEqual(follower["incident_reuse"], "cited")
        self.assertTrue(known.incidents[founded]["run"])

    def test_a_candidate_never_supports_itself(self):
        known = index([])
        title = "Aqaba harbour blast kills sailors"
        event = candidate(title, 3)
        result = decision(title, update="INITIAL", anchor="Aqaba blast")
        known.observe(event, result, 50)
        founded = collector.anchor_incident_id("Aqaba blast")
        known.for_batch([payload(candidate("Unrelated", 2))])
        same_url = candidate(title + " again", 2, url=event["url"])
        cited = decision(same_url["title"], cited=founded)
        known.observe(same_url, cited, 50)
        self.assertEqual(len(known.incidents[founded]["evidence"]), 1, "Refused, so it widens nothing.")
        self.assertEqual(applied(known, same_url, cited), True)
        self.assertEqual(same_url["incident_reuse_refused"], "no_primary_evidence")

    def founded(self):
        known = index([])
        title = "Aqaba harbour blast kills sailors"
        event, result = candidate(title, 3), decision(title, update="INITIAL", anchor="Aqaba blast")
        known.observe(event, result, 50)
        return known, event, result

    def test_the_first_article_of_a_rolling_entry_keeps_its_hash(self):
        known, event, result = self.founded()
        known.for_batch([payload(candidate("Unrelated", 2))])
        self.assertTrue(applied(known, event, result))
        self.assertEqual(event["incident_id"], own_hash(result))
        self.assertNotIn("incident_reuse", event)
        self.assertNotIn("incident_reuse_refused", event)

    def test_a_copied_rolling_anchor_is_gated(self):
        known, _, founder_result = self.founded()
        known.for_batch([payload(candidate("Unrelated", 2))])
        title = "Grenade thrown at Irbid checkpoint"
        event, result = candidate(title, 2), decision(title, update="INITIAL", anchor="Aqaba blast")
        known.observe(event, result, 50)
        self.assertEqual(len(known.incidents[own_hash(founder_result)]["evidence"]), 1)
        self.assertTrue(applied(known, event, result))
        self.assertEqual(event["incident_id"], known_incidents.refused_incident_id(event))

    def test_articles_sharing_an_anchor_before_it_was_shown_join_as_today(self):
        known, _, founder_result = self.founded()
        title = "Grenade thrown at Irbid checkpoint"
        event, result = candidate(title, 2), decision(title, update="INITIAL", anchor="Aqaba blast")
        known.observe(event, result, 50)
        known.for_batch([payload(candidate("Unrelated", 2))])
        self.assertTrue(applied(known, event, result))
        self.assertEqual(event["incident_id"], own_hash(founder_result))
        self.assertNotIn("incident_reuse_refused", event)

    def test_only_kept_eligible_results_enter_the_registry(self):
        known = index([])
        title = "Aqaba harbour blast kills sailors"
        known.observe(candidate(title), decision(title, score=10), 50)
        known.observe(candidate(title), dict(decision(title), is_current_ct_event=False), 50)
        known.observe(candidate(title), decision(title, kind="OTHER_CT"), 50)
        known.observe(candidate(title), decision(title, anchor="p2"), 50)
        self.assertEqual(known.incidents, {})

    def test_a_kept_result_never_reopens_a_blocked_id(self):
        blocked = collector.anchor_incident_id("Reviewed attack")
        ruled = record("Reviewed attack", incident_id=blocked, anchor="Reviewed attack")
        title = "Aqaba harbour blast kills sailors"
        with patch.object(mei, "matched_rule", lambda event: {"reason": "x"} if event.get("id") == ruled["id"] else None):
            known = index([ruled])
            known.observe(candidate(title), decision(title, anchor="Reviewed attack"), 50)
        self.assertNotIn(blocked, known.incidents)

    def test_a_refused_citation_founds_its_own_entry(self):
        known = index([record("Gunman attacks Karak church during Sunday service", 24)])
        title = "Bomb in Karak market kills three"
        result = decision(title, update="INITIAL", cited="inc-karak")
        known.observe(candidate(title), result, 50)
        self.assertEqual(len(known.incidents["inc-karak"]["records"]), 1)
        self.assertTrue(known.incidents[own_hash(result)]["run"])

    def test_an_accepted_citation_rises_in_the_hot_list_but_evidence_stops_growing(self):
        records = [record(f"Karak church update {n}", 40 + n, update="FOLLOW_UP") for n in range(40)]
        known = index(records)
        before = known.incidents["inc-karak"]["recent"]
        title = "Karak church funeral draws thousands"
        known.observe(candidate(title), decision(title, cited="inc-karak"), 50)
        self.assertEqual(known.incidents["inc-karak"]["recent"], before + 1)
        self.assertEqual(len(known.incidents["inc-karak"]["evidence"]), 40)


class AffinityTests(unittest.TestCase):
    def pending(self):
        items = []
        for n in range(15):
            if n % 3 == 1:
                title = f"Trappes shooting suspect case {n}"
            elif n % 3 == 2:
                title = f"Karak church funeral mourners {n}"
            else:
                title = f"Isolated headline word{chr(97 + n % 26)}x{chr(97 + n // 26)} {n}"
            items.append({"event_id": f"e{n}", "title": title, "related_articles": []})
        return items

    def test_order_is_a_deterministic_permutation(self):
        pending = self.pending()
        ordered = known_incidents.story_order(pending, 4)
        self.assertEqual(sorted(item["event_id"] for item in ordered), sorted(item["event_id"] for item in pending))
        self.assertEqual(ordered, known_incidents.story_order(copy.deepcopy(pending), 4))

    def test_one_story_lands_together_and_the_newest_stays_first(self):
        pending = self.pending()
        ordered = [item["event_id"] for item in known_incidents.story_order(pending, 8)]
        self.assertEqual(ordered[0], "e0")
        story = [position for position, event_id in enumerate(ordered) if int(event_id[1:]) % 3 == 1]
        self.assertEqual(story, list(range(story[0], story[0] + 5)))

    def test_related_titles_count(self):
        pending = [{"event_id": "a", "title": "Unrelated first", "related_articles": []},
                   {"event_id": "b", "title": "Lead", "related_articles": [{"title": "Trappes shooting suspect"}]},
                   {"event_id": "c", "title": "Other headline", "related_articles": []},
                   {"event_id": "d", "title": "Trappes shooting inquiry", "related_articles": []}]
        self.assertEqual([item["event_id"] for item in known_incidents.story_order(pending, 4)], ["a", "b", "d", "c"])

    def test_a_word_in_too_many_candidates_groups_nothing(self):
        pending = [{"event_id": f"e{n}", "title": f"Trappes shooting {n}", "related_articles": []} for n in range(8)]
        pending.insert(1, {"event_id": "other", "title": "Lone headline", "related_articles": []})
        self.assertEqual(known_incidents.story_order(pending, 4), pending)

    def test_a_group_is_capped_at_two_batches(self):
        pending = [{"event_id": f"e{n}", "title": f"Trappes shooting suspect {n}", "related_articles": []} for n in range(6)]
        pending.insert(2, {"event_id": "other", "title": "Lone headline", "related_articles": []})
        ordered = [item["event_id"] for item in known_incidents.story_order(pending, 1)]
        self.assertEqual(ordered, ["e0", "e1", "other", "e2", "e3", "e4", "e5"])

    def test_a_budget_cut_only_leaves_candidates_older_than_every_seed_before_it(self):
        pending = self.pending()
        position = {item["event_id"]: n for n, item in enumerate(pending)}
        ordered = known_incidents.story_order(pending, 3)
        for cut in range(1, len(ordered)):
            seen, seeds = set(), []
            for item in ordered[:cut]:
                if set(range(position[item["event_id"]])) <= seen:
                    seeds.append(position[item["event_id"]])
                seen.add(position[item["event_id"]])
            self.assertGreater(min(position[item["event_id"]] for item in ordered[cut:]), max(seeds))

    def test_an_unarmed_selection_keeps_its_order(self):
        events = [candidate(f"Trappes shooting suspect {n}", n) for n in range(2)]
        events.insert(1, candidate("Lone headline", 1))
        batches = []

        def process(batch):
            batches.append([item["event_id"] for item in batch])
            raise collector.AISelectionQuotaError("stop")

        with patch.object(collector, "load_selection_cache", lambda: {"items": {}}), \
             patch.object(collector, "save_selection_cache", lambda cache: None), \
             patch.object(collector, "AI_SELECTION_ENABLED", True), \
             patch.object(collector, "process_ai_selection_batch", process):
            self.assertIsNone(collector.ai_select_events(events))
            batches_unarmed = list(batches)
            batches.clear()
            with patch.object(collector, "KNOWN_INCIDENTS", index([])):
                self.assertIsNone(collector.ai_select_events(events))
        self.assertEqual(batches_unarmed[0], [event["id"] for event in events])
        self.assertEqual(batches[0], [events[0]["id"], events[2]["id"], events[1]["id"]])


WRAPPER = textwrap.dedent('''
    import importlib.util, json, os, sys
    from types import SimpleNamespace
    os.environ.update({"AI_SELECTION_BATCH_SIZE": "1", "AI_SELECTION_MAX_CALLS_PER_RUN": "10",
                       "AI_SELECTION_DAILY_CALL_BUDGET": "60", "AI_SELECTION_OVERFLOW_MODEL": "gemini-3.1-flash-lite",
                       "AI_SELECTION_OVERFLOW_MAX_CALLS_PER_RUN": "2", "AI_SELECTION_OVERFLOW_DAILY_CALL_BUDGET": "50",
                       "GEMINI_API_KEY": "stub"})
    root = sys.argv[1]
    sys.path.insert(0, os.path.join(root, "tools"))
    spec = importlib.util.spec_from_file_location("quota_safe", os.path.join(root, "tools", "run_collector_quota_safe.py"))
    wrapper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(wrapper)
    collector = wrapper.collector
    wrapper.time = SimpleNamespace(monotonic=lambda: 0.0, sleep=lambda seconds: None)
    collector.time = SimpleNamespace(sleep=lambda seconds: None, monotonic=collector.time.monotonic)
    collector.AI_SELECTION_ENABLED = True
    collector.BACKFILL_ACTIVE = False
    wrapper.official_result = lambda event: None
    cache = {"version": collector.AI_SELECTION_VERSION, "items": {}}
    collector.load_selection_cache = lambda: cache
    wrapper.SAVE_CACHE = lambda current: cache.update(current)
    collector.persist_background_articles = lambda events: None
    def event(key):
        return {"id": key, "url": "https://example.test/" + key, "title": "ISIS attack kills one in Nigeria " + key,
                "summary": "", "categories": ["Attacks"], "published": "2026-11-02T10:00:00+00:00"}
    def decision(key):
        return {"event_id": key, "relevance_score": 85, "is_current_ct_event": True, "categories": ["Attacks"],
                "original_language": "en", "english_title": "ISIS attacked a patrol in Nigeria " + key,
                "english_summary": "An attack occurred.", "canonical_event": "Patrol attack " + key,
                "reason": "Confirmed.", "primary_event_type": "ATTACK", "incident_anchor": "Patrol attack " + key,
                "update_type": "INITIAL"}
    class Stub:
        def __init__(self):
            self.settled = []
            self.sent = []
            self.stats = {"mode": "shadow", "offered": 1}
        def for_batch(self, batch):
            return [["K1", "2026-11-01", "ATTACK", "Known anchor"]], {"K1": "inc-known"}
        def translate(self, results, refs):
            for result in results:
                result.pop("known_incident_ref", None)
        def observe(self, event, result, threshold):
            pass
        def settle(self, event, result):
            self.settled.append(event["id"])
    stub = Stub()
    collector.KNOWN_INCIDENTS = stub
    collector.KNOWN_INCIDENT_TELEMETRY = stub.stats
    mode = sys.argv[2]
    if mode == "overflow":
        statuses, bodies = [429, 200], []
        def post(url, *args, **kwargs):
            bodies.append(kwargs["json"])
            status = statuses.pop(0)
            text = json.dumps({"results": [decision("a")]})
            return SimpleNamespace(status_code=status, text="", json=lambda: {"steps": [], "text": text})
        wrapper.POST = post
        collector.extract_interaction_text = lambda payload: payload["text"]
        collector.call_ai_selection_batch([{"event_id": "a", "title": "t"}])
        print(json.dumps({"models": [body["model"] for body in bodies], "inputs": [body["input"] for body in bodies],
                          "selection": wrapper.is_selection({"json": bodies[0]}), "overflow_ids": sorted(wrapper.OVERFLOW_IDS),
                          "calls": wrapper.calls, "overflow_calls": wrapper.overflow_calls}))
    else:
        hit, fresh, failed = event("hit"), event("fresh"), event("failed")
        cache["items"][collector.selection_fingerprint(hit)] = {"version": collector.AI_SELECTION_VERSION, "result": decision("hit")}
        def process(batch):
            if batch[0]["event_id"] == "failed":
                raise collector.AISelectionQuotaError("stop")
            return [decision(batch[0]["event_id"])]
        wrapper.PROCESS_BATCH = process
        # fresh is newer, so its batch runs first and the failure comes after it
        failed["published"] = "2026-11-01T10:00:00+00:00"
        kept = collector.ai_select_events([hit, fresh, failed], lane="recent")
        status = collector.selection_runtime_status()
        print(json.dumps({"kept": [e["id"] for e in kept], "settled": stub.settled, "telemetry": status["known_incidents"]}))
''')


def wrapper(mode):
    with tempfile.TemporaryDirectory() as folder:
        result = subprocess.run([sys.executable, "-c", WRAPPER, str(ROOT), mode], capture_output=True, text=True,
                                timeout=120, cwd=folder, encoding="utf-8",
                                env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    if result.returncode:
        raise AssertionError(result.stderr[-2000:])
    return json.loads(result.stdout.strip().splitlines()[-1])


class WiringTests(unittest.TestCase):
    def main(self, mode="shadow", build=None):
        existing = [record("Gunman attacks Karak church during Sunday service", 24)]
        armed = {}
        clock = datetime.now(timezone.utc)
        legacy = {"id": "legacy", "published": clock.isoformat(), "title": "Legacy"}
        fresh = [dict(candidate("Recent story"), published=clock.isoformat()),
                 dict(candidate("Older story"), published=(clock - timedelta(days=9)).isoformat())]

        def select(rows, lane=None):
            armed[lane] = collector.KNOWN_INCIDENTS is not None
            return []

        patches = {
            "parse_collection_mode": lambda: (False, "daily"), "initialize_incremental_state": lambda _: None,
            "load_existing_weekly_analysis": lambda: {}, "load_existing": lambda: existing + [legacy],
            "load_database_strict": lambda: {"events": existing, "last_updated": "previous"},
            "collect_all": lambda _: fresh, "deduplicate_events": lambda rows: rows,
            "ai_select_events": select, "deduplicate_incremental": lambda old, new: old,
            "prune_old": lambda rows, aged=None: rows, "archive_aged_out_events": lambda rows: None,
            "load_incident_state": lambda: {}, "consolidate_incidents": lambda rows, state: (rows, {}),
            "save_incident_state": lambda *args: None, "generate_24h_trend_summary": lambda rows: {},
            "generate_weekly_analysis": lambda rows, **kwargs: {}, "save_database": lambda *args, **kwargs: None,
            "load_selection_cache": lambda: {"items": {}}, "atomic_json_write": lambda *args: None,
            "AI_KNOWN_INCIDENTS": mode,
        }
        with ExitStack() as stack:
            for name, replacement in patches.items():
                stack.enter_context(patch.object(collector, name, replacement, create=True))
            stack.enter_context(patch.object(collector, "KNOWN_INCIDENT_TELEMETRY", {}))
            stack.enter_context(patch.object(collector.collection_config, "validate_runtime", return_value={}))
            stack.enter_context(patch.object(daily_pipeline, "load_queue", return_value=[]))
            stack.enter_context(patch.object(daily_pipeline, "save_queue"))
            if build:
                stack.enter_context(patch.object(known_incidents, "build", build))
            collector.main()
            telemetry = dict(collector.KNOWN_INCIDENT_TELEMETRY)
        self.assertIsNone(collector.KNOWN_INCIDENTS)
        return armed, telemetry

    def test_armed_for_the_daily_lanes_and_cleared_before_maintenance(self):
        armed, telemetry = self.main()
        self.assertTrue(armed["recent"] and armed["backlog"])
        self.assertFalse(armed.get("maintenance"))
        self.assertEqual(telemetry["mode"], "shadow", "The telemetry outlives the armed index.")

    def test_off_leaves_the_run_as_it_was(self):
        armed, telemetry = self.main("off")
        self.assertFalse(any(armed.values()))
        self.assertEqual(telemetry, {})

    def test_a_failed_index_leaves_the_selection_running(self):
        def broken(*args):
            raise ValueError("bad record")
        armed, _ = self.main(build=broken)
        self.assertEqual((armed["recent"], armed["backlog"]), (False, False))

    def test_the_default_is_shadow_and_only_on_applies_the_reuse(self):
        self.assertIn('os.getenv("AI_KNOWN_INCIDENTS", "shadow")', (ROOT / "collector.py").read_text(encoding="utf-8"))
        self.assertEqual(self.main("maybe")[1]["mode"], "shadow")
        self.assertEqual(self.main("on")[1]["mode"], "on")

    def test_never_armed_outside_the_daily_lanes(self):
        source = (ROOT / "collector.py").read_text(encoding="utf-8")
        self.assertEqual(source.count("arm_known_incidents("), 2, "One definition, one call.")
        call = source.index("arm_known_incidents(existing, run_now")
        self.assertLess(source.index("daily_pipeline.prepare("), call)
        self.assertLess(call, source.index('ai_select_events(recent, lane="recent")'))
        cleared = re.search(r"KNOWN_INCIDENTS = None\s+selected_fresh", source)
        self.assertLess(source.index('ai_select_events(backlog, lane="backlog")'), cleared.start())
        for tool in (ROOT / "tools").glob("*.py"):
            self.assertNotIn("arm_known_incidents", tool.read_text(encoding="utf-8"), tool.name)

    def test_the_wrapper_paths_reach_settle_and_the_telemetry(self):
        result = wrapper("lanes")
        self.assertEqual(result["kept"], ["hit", "fresh"])
        self.assertEqual(result["settled"], ["hit", "fresh"], "Cache hit, then the recover path.")
        self.assertEqual(result["telemetry"], {"mode": "shadow", "offered": 1})

    def test_the_overflow_model_receives_the_same_list(self):
        result = wrapper("overflow")
        self.assertEqual(result["models"][1], "gemini-3.1-flash-lite")
        self.assertEqual(result["inputs"][0], result["inputs"][1])
        self.assertIn('"known_incidents": [["K1", "2026-11-01", "ATTACK", "Known anchor"]]', result["inputs"][1])
        self.assertTrue(result["selection"])
        self.assertEqual(result["overflow_ids"], ["a"], "The list adds no event ids to the overflow attribution.")
        self.assertEqual((result["calls"], result["overflow_calls"]), (1, 1))


if __name__ == "__main__":
    unittest.main()
