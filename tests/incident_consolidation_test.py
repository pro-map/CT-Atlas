"""Tests for collector.consolidate_incidents. Gemini is replaced by a stub
that answers with the short wire ids ("I1", "I2", ...) the real prompt uses."""
import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

spec = importlib.util.spec_from_file_location("collector", "collector.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


def record(title, published, incident_id=None, country="Israel", code="IL", primary="ATTACK",
           update="INITIAL", source="Outlet", url=None, related=None):
    event = {
        "id": title[:20], "title": title, "original_title": title,
        "summary": title, "original_summary": title, "published": published,
        "country": country, "country_code": code, "primary_event_type": primary,
        "update_type": update, "source": source, "sources": [source],
        "url": url or "https://example.test/" + title.replace(" ", "-"),
        "category": "Attacks", "categories": ["Attacks"], "related_articles": related or [],
        "article_count": 1 + len(related or []), "latitude": 32.0, "longitude": 34.8,
    }
    if incident_id:
        event["incident_id"] = incident_id
        event["incident_anchor"] = incident_id + " anchor"
    return event


class GeminiStub:
    """Groups payload items whose headline contains any of `same` keywords."""

    def __init__(self, *keyword_sets, fail=False):
        self.keyword_sets = keyword_sets
        self.fail = fail
        self.calls = 0

    def __call__(self, instructions, text, schema, max_output_tokens=8000):
        self.calls += 1
        if self.fail:
            raise collector.AISelectionQuotaError("quota")
        items = json.loads(text.split("\n\n", 1)[1])["incidents"]
        groups = []
        for keywords in self.keyword_sets:
            ids = [item["id"] for item in items
                   if any(word in " ".join(item["headlines"]).lower() for word in keywords)]
            groups.append({"ids": ids + ["I999"], "reason": "stub"})  # I999: invented id, must be ignored
        return {"groups": groups}


class ConsolidationTests(unittest.TestCase):
    def setUp(self):
        self.original = collector.call_gemini_json
        self.state = {"version": 1, "aliases": {}, "reviewed": {}}

    def tearDown(self):
        collector.call_gemini_json = self.original

    def run_pass(self, events, stub, **kwargs):
        collector.call_gemini_json = stub
        return collector.consolidate_incidents(events, self.state, max_calls=kwargs.get("max_calls", 50),
                                               now=datetime(2026, 10, 1, tzinfo=timezone.utc))

    def flydubai(self):
        return [
            record("Flydubai flight attack diverted", "2026-09-30T08:59:00+00:00", "inc-b", "Saudi Arabia", "SA", source="EL PAIS"),
            record("Flydubai copilot stabs captain", "2026-09-30T19:04:00+00:00", "inc-c", source="ANSA",
                   related=[{"title": "Katz: jihadist attack", "url": "https://ansa.test/2", "published": "2026-09-30T19:30:00+00:00"}]),
            record("Passengers subdue Flydubai attacker", "2026-09-30T20:42:00+00:00", "inc-a", source="Estadao"),
            record("Saudi arrests Flydubai copilot", "2026-10-01T09:00:00+00:00", "inc-d", "Saudi Arabia", "SA",
                   primary="ARREST", update="ARREST_UPDATE"),
            record("Hamas rocket hits Sderot", "2026-09-30T12:00:00+00:00", "inc-z"),
        ]

    def test_same_incident_ids_unify_to_the_earliest_and_records_fold(self):
        events, stats = self.run_pass(self.flydubai(), GeminiStub(["flydubai"]))
        ids = {e["title"]: e.get("incident_id") for e in events}
        self.assertEqual(ids["Saudi arrests Flydubai copilot"], "inc-b")
        self.assertEqual(ids["Hamas rocket hits Sderot"], "inc-z")
        # Three INITIAL reports (two countries) fold into one record; the
        # arrest stays a separate development of the same incident.
        flydubai = [e for e in events if e["incident_id"] == "inc-b"]
        self.assertEqual(len(flydubai), 2)
        initial = next(e for e in flydubai if e["update_type"] == "INITIAL")
        urls = {a["url"] for a in initial["related_articles"]} | {initial["url"]}
        self.assertIn("https://ansa.test/2", urls)  # the merged record's own related article survives
        self.assertEqual(initial["article_count"], 4)
        self.assertEqual(stats["incidents_merged"], 3)
        self.assertEqual(self.state["aliases"], {"inc-a": "inc-b", "inc-c": "inc-b", "inc-d": "inc-b"})

    def test_reviewed_windows_are_not_sent_again(self):
        events, _ = self.run_pass(self.flydubai(), GeminiStub(["flydubai"]))
        stub = GeminiStub(["flydubai"])
        self.run_pass(events, stub)
        self.assertEqual(stub.calls, 0)

    def test_a_later_record_under_an_old_alias_is_remapped_for_free(self):
        events, _ = self.run_pass(self.flydubai(), GeminiStub(["flydubai"]))
        events.append(record("Flydubai crew honoured", "2026-10-01T10:00:00+00:00", "inc-c", update="FOLLOW_UP"))
        stub = GeminiStub()
        events, stats = self.run_pass(events, stub)
        self.assertEqual(stats["aliased_records"], 1)
        self.assertEqual(events[-1]["incident_id"], "inc-b")
        self.assertEqual(stub.calls, 0)

    def test_gemini_failure_keeps_everything_pending_without_raising(self):
        events, stats = self.run_pass(self.flydubai(), GeminiStub(fail=True))
        self.assertIn("quota", stats["error"])
        self.assertEqual(self.state["reviewed"], {})
        self.assertEqual(len({e["incident_id"] for e in events}), 5)

    def test_incidents_far_apart_in_time_or_region_are_never_compared(self):
        events = [
            record("Flydubai attack", "2026-09-30T08:00:00+00:00", "inc-a"),
            record("Flydubai attack anniversary", "2026-09-10T08:00:00+00:00", "inc-b"),
            record("Flydubai attack in Lyon", "2026-09-30T09:00:00+00:00", "inc-c", "France", "FR"),
        ]
        stub = GeminiStub(["flydubai"])
        events, stats = self.run_pass(events, stub)
        self.assertEqual(stub.calls, 0)
        self.assertEqual(stats["windows_pending"], 0)

    def test_legacy_records_without_incident_id_get_one_when_reviewed(self):
        events = [
            record("Flydubai attack", "2026-09-30T08:00:00+00:00", primary=None, update=None),
            record("Flydubai attack video", "2026-09-30T09:00:00+00:00", primary=None, update=None),
            record("Sderot rocket", "2026-09-30T10:00:00+00:00", primary=None, update=None),
        ]
        for event in events:
            event.pop("primary_event_type")
            event.pop("update_type")
        events, _ = self.run_pass(events, GeminiStub(["flydubai"]))
        self.assertTrue(all(e.get("incident_id", "").startswith("inc-") for e in events))
        self.assertEqual(len(events), 2)  # the two Flydubai legacy records fold into one

    def test_follow_ups_in_different_countries_stay_separate(self):
        events = [
            record("Arrest in Germany", "2026-09-30T08:00:00+00:00", "inc-a", "Germany", "DE", "ARREST", "ARREST_UPDATE"),
            record("Arrest in Austria", "2026-09-30T09:00:00+00:00", "inc-a", "Austria", "AT", "ARREST", "ARREST_UPDATE"),
        ]
        events, _ = self.run_pass(events, GeminiStub())
        self.assertEqual(len(events), 2)

    def test_initial_reports_fold_even_when_gemini_typed_them_differently(self):
        events = [
            record("Knife attack on flight", "2026-09-30T08:00:00+00:00", "inc-a", primary="ATTACK"),
            record("Attempted hijack on flight", "2026-09-30T09:00:00+00:00", "inc-a", primary="ATTEMPTED_ATTACK"),
        ]
        events, _ = self.run_pass(events, GeminiStub())
        self.assertEqual(len(events), 1)

    def test_merging_large_records_keeps_articles_beyond_the_dedup_variant_cap(self):
        many = [{"title": f"Report {n}", "url": f"https://x.test/{n}", "published": "2026-09-30T10:00:00+00:00"}
                for n in range(40)]
        events = [
            record("Attack A", "2026-09-30T08:00:00+00:00", "inc-a", related=many[:20]),
            record("Attack A again", "2026-09-30T09:00:00+00:00", "inc-a", related=many[20:]),
        ]
        events, _ = self.run_pass(events, GeminiStub())
        self.assertEqual(len(events), 1)
        urls = {a["url"] for a in events[0]["related_articles"]}
        self.assertTrue({a["url"] for a in many} <= urls)

    def test_text_dedup_merge_keeps_the_incoming_clusters_related_articles(self):
        existing = record("Attack A", "2026-09-30T08:00:00+00:00", "inc-a")
        incoming = record("Attack A follow", "2026-09-30T09:00:00+00:00", "inc-a",
                          related=[{"title": "Other outlet", "url": "https://y.test/1", "published": "2026-09-30T09:30:00+00:00"}])
        collector.merge_event(existing, incoming, 0.9, "test")
        urls = {a["url"] for a in existing["related_articles"]}
        self.assertIn("https://y.test/1", urls)
        self.assertIn(incoming["url"], urls | {existing["url"]})
        self.assertEqual(existing["article_count"], 3)

    def test_incident_payload_carries_original_headlines_for_geo_conflict_checks(self):
        event = record(
            "Youth accused of terrorism after bringing toxic products to school in Brazil",
            "2026-10-03T12:00:00+00:00",
            "inc-a",
            "Brazil",
            "BR",
        )
        event["original_title"] = "Jovem é acusado de terrorismo ao levar produtos tóxicos para escola"
        event["related_articles"] = [{
            "title": "Economic motivation does not rule out terrorism conviction",
            "original_title": "Motivação econômica não afasta condenação por atos preparatórios de terrorismo",
            "url": "https://example.test/unrelated",
            "published": "2026-10-04T12:00:00+00:00",
        }]
        profiles = collector.build_incident_profiles([event])
        key = next(iter(profiles))
        payload = collector._incident_window_payload([key], profiles)[0]
        self.assertIn(event["original_title"], payload["original_headlines"])
        self.assertIn(event["related_articles"][0]["original_title"], payload["original_headlines"])
        self.assertIn("original_headlines", collector.INCIDENT_CONSOLIDATION_INSTRUCTIONS)
        self.assertIn("generated place", collector.INCIDENT_CONSOLIDATION_INSTRUCTIONS)

    def test_save_prunes_state_to_live_incidents(self):
        events, _ = self.run_pass(self.flydubai(), GeminiStub(["flydubai"]))
        self.state["aliases"]["inc-old"] = "inc-gone"
        self.state["reviewed"]["inc-gone"] = "x"
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "state.json"
            collector.save_incident_state(self.state, events, path)
            saved = json.loads(path.read_text(encoding="utf-8"))
        self.assertNotIn("inc-old", saved["aliases"])
        self.assertNotIn("inc-gone", saved["reviewed"])
        self.assertIn("inc-a", saved["aliases"])


def jordan(title, published, incident_id, update="FOLLOW_UP"):
    return record(title, published, incident_id, "Jordan", "JO", update=update)


class SupportComponentTests(unittest.TestCase):
    """2026-11-04: the all-pairs veto rejected a whole Gemini group for one
    pair of headlines without a shared word, so the 23 Oct Karak church attack
    stayed 58 records under 39 ids, and the refused keys were never retried."""

    def setUp(self):
        self.original = collector.call_gemini_json
        self.state = {"version": 1, "aliases": {}, "reviewed": {}}

    def tearDown(self):
        collector.call_gemini_json = self.original

    def run_pass(self, events, stub, **kwargs):
        collector.call_gemini_json = stub
        return collector.consolidate_incidents(events, self.state, max_calls=kwargs.get("max_calls", 50),
                                               now=datetime(2026, 10, 25, tzinfo=timezone.utc),
                                               use_gemini=kwargs.get("use_gemini", True),
                                               reopen=kwargs.get("reopen", False))

    def karak(self):
        return [
            jordan("Gunmen attack Karak church funeral", "2026-10-23T09:00:00+00:00", "inc-a", "INITIAL"),
            jordan("King vows punishment after Karak church attack", "2026-10-23T12:00:00+00:00", "inc-b"),
            jordan("Hammoud village mourns Karak victims", "2026-10-24T08:00:00+00:00", "inc-c"),
            jordan("Hammoud funeral attackers identified", "2026-10-24T18:00:00+00:00", "inc-d",
                   "INVESTIGATION_UPDATE"),
        ]

    def test_a_real_incident_merges_although_one_headline_pair_shares_no_word(self):
        events = self.karak()
        mic = __import__("map_evidence_integrity")
        self.assertFalse(mic.primary_pair_supported(events[1], events[3]))  # the old rule's veto
        events, stats = self.run_pass(events, GeminiStub(["karak", "hammoud"]))
        self.assertEqual({e["incident_id"] for e in events}, {"inc-a"})
        self.assertEqual(stats["incidents_merged"], 3)
        self.assertFalse(any(e.get("dedup_review_required") for e in events))

    def test_an_intruder_linked_by_one_word_is_left_out_and_flagged_alone(self):
        events = [record(f"Trappes shooting {detail}", f"2026-10-23T1{n}:00:00+00:00", f"inc-t{n}", "France", "FR")
                  for n, detail in enumerate(("leaves two dead", "suspect named", "in Yvelines town",
                                              "victims honoured", "gunman charged"))]
        events.append(record("Yvelines prefect bans protest march", "2026-10-24T10:00:00+00:00", "inc-x", "France", "FR"))
        events, _ = self.run_pass(events, GeminiStub(["trappes", "yvelines"]))
        ids = {e["title"]: e["incident_id"] for e in events}
        self.assertEqual({ids[t] for t in ids if t.startswith("Trappes")}, {"inc-t0"})
        self.assertEqual(ids["Yvelines prefect bans protest march"], "inc-x")
        flagged = [e["title"] for e in events if e.get("dedup_review_required")]
        self.assertEqual(flagged, ["Yvelines prefect bans protest march"])

    def test_a_shared_country_name_does_not_link_two_incidents(self):
        # Both pairs pass primary_pair_supported through 'nigerian': the old
        # rule merged any such two-key group Gemini proposed.
        events = [record("Nigerian army kills bandit leaders in Zamfara", "2026-10-23T09:00:00+00:00", "inc-n1", "Nigeria", "NG"),
                  record("Nigerian customs intercept cocaine shipment", "2026-10-23T15:00:00+00:00", "inc-n2", "Nigeria", "NG")]
        events, _ = self.run_pass(events, GeminiStub(["nigerian"]))
        self.assertEqual(sorted(e["incident_id"] for e in events), ["inc-n1", "inc-n2"])
        self.assertTrue(all(e.get("dedup_review_required") for e in events))

    def test_refused_incidents_are_reviewed_again_once_per_rule_version(self):
        events = self.karak()
        events.append(jordan("Amman traffic accident", "2026-10-24T09:00:00+00:00", "inc-e"))
        for event in events:
            event["dedup_review_required"] = True  # refused by the all-pairs rule
        self.state["reviewed"] = {key: "2026-10-24T00:00:00+00:00" for key in ("inc-a", "inc-b", "inc-c", "inc-d", "inc-e")}
        for kwargs in ({"use_gemini": False, "reopen": True},  # resume-pending, --dry-run
                       {"reopen": False}):                     # the collector's own calls
            free = GeminiStub(["karak", "hammoud"])
            events, stats = self.run_pass(events, free, **kwargs)
            self.assertEqual((free.calls, stats["reopened_incidents"]), (0, 0))
            self.assertNotIn("rule_version", self.state)
        self.assertEqual(len(collector.refused_incident_keys(events, self.state)), 5)
        stub = GeminiStub(["karak", "hammoud"])
        events, stats = self.run_pass(events, stub, reopen=True)
        self.assertEqual((stub.calls, stats["reopened_incidents"]), (1, 5))
        ids = {e["title"]: e["incident_id"] for e in events}
        self.assertEqual(ids["Amman traffic accident"], "inc-e")
        self.assertEqual({ids[t] for t in ids if t != "Amman traffic accident"}, {"inc-a"})
        # Merged keys lose the refusal; a key Gemini left alone keeps it.
        self.assertEqual([e["title"] for e in events if e.get("dedup_review_required")], ["Amman traffic accident"])
        self.assertEqual(self.state["rule_version"], collector.INCIDENT_CONSOLIDATION_RULE_VERSION)
        self.assertEqual(collector.refused_incident_keys(events, self.state), set())
        again = GeminiStub(["karak", "hammoud"])
        self.run_pass(events, again, reopen=True)
        self.assertEqual(again.calls, 0)

    def test_a_reviewed_isolation_is_neither_flagged_nor_re_opened(self):
        events = self.karak()
        # The King record carries a reviewed isolated_incident rule.
        king_record = lambda event: event.get("id", "").startswith("King")
        mic = __import__("map_evidence_integrity")
        originals = mic.isolated_pair, collector._isolated_by_review
        mic.isolated_pair = lambda left, right: king_record(left) != king_record(right)
        collector._isolated_by_review = king_record
        try:
            events[1]["dedup_review_required"] = True
            self.assertEqual(collector.refused_incident_keys(events, self.state), set())
            events[1].pop("dedup_review_required")
            events, _ = self.run_pass(events, GeminiStub(["karak", "hammoud"]))
        finally:
            mic.isolated_pair, collector._isolated_by_review = originals
        king = next(e for e in events if e["title"].startswith("King"))
        self.assertEqual(king["incident_id"], "inc-b")
        self.assertNotIn("dedup_review_required", king)
        self.assertEqual({e["incident_id"] for e in events if e is not king}, {"inc-a"})

    def windows_in_three_regions(self):
        return [
            record("Karak church attack", "2026-10-23T09:00:00+00:00", "inc-j1", "Jordan", "JO"),
            record("Karak church funeral", "2026-10-23T12:00:00+00:00", "inc-j2", "Jordan", "JO"),
            record("Trappes shooting", "2026-10-23T09:00:00+00:00", "inc-f1", "France", "FR"),
            record("Trappes gunman", "2026-10-23T12:00:00+00:00", "inc-f2", "France", "FR"),
            record("Planadas bomb attack", "2026-10-23T09:00:00+00:00", "inc-c1", "Colombia", "CO"),
            record("Planadas bomb victims", "2026-10-23T12:00:00+00:00", "inc-c2", "Colombia", "CO"),
        ]

    def test_a_503_skips_one_window_and_the_pass_goes_on(self):
        good = GeminiStub(["karak", "trappes", "planadas"])
        calls = []

        def flaky(*args, **kwargs):
            calls.append(1)
            if len(calls) == 1:
                raise collector.AISelectionTransientError("Gemini unavailable (HTTP 503).")
            return good(*args, **kwargs)

        events, stats = self.run_pass(self.windows_in_three_regions(), flaky)
        self.assertEqual((len(calls), stats["windows_pending"], stats["windows_reviewed"]), (3, 3, 2))
        self.assertIn("503", stats["error"])
        self.assertEqual(len(self.state["reviewed"]), 4, "the failed window stays pending")

    def test_three_503s_in_a_row_pause_the_pass(self):
        calls = []

        def down(*args, **kwargs):
            calls.append(1)
            raise collector.AISelectionTransientError("Gemini unavailable (HTTP 503).")

        events = self.windows_in_three_regions() + [
            record("Poonch hideout raid", "2026-10-23T09:00:00+00:00", "inc-i1", "India", "IN"),
            record("Poonch hideout arms", "2026-10-23T12:00:00+00:00", "inc-i2", "India", "IN"),
        ]
        _, stats = self.run_pass(events, down)
        self.assertEqual(len(calls), collector.INCIDENT_MAX_CONSECUTIVE_UNAVAILABLE)
        self.assertEqual((stats["windows_pending"], stats["windows_reviewed"]), (4, 0))
        self.assertEqual(self.state["reviewed"], {})

    def test_the_rule_version_survives_a_save_and_load(self):
        self.run_pass(self.karak(), GeminiStub(["karak"]), reopen=True)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "state.json"
            collector.save_incident_state(self.state, [], path)
            self.assertEqual(collector.load_incident_state(path)["rule_version"],
                             collector.INCIDENT_CONSOLIDATION_RULE_VERSION)
            path.write_text('{"aliases": {}, "reviewed": {}}', encoding="utf-8")
            self.assertNotIn("rule_version", collector.load_incident_state(path))


class CountryTableTests(unittest.TestCase):
    """2026-11-04: 786 records' countries had no entry in COUNTRY_CANONICAL."""

    def test_the_database_countries_are_recognised(self):
        self.assertEqual(collector.extract_country_families("Jordanian King visits Kerak victims"), {"jordan"})
        for country in ("italy", "spain", "democratic republic of the congo", "poland", "bangladesh", "sudan"):
            self.assertIn(country, collector.COUNTRY_CANONICAL)
            self.assertIn(country, collector.COUNTRY_CONFLICT_ONLY)
        self.assertLessEqual(collector.COUNTRY_CONFLICT_ONLY, set(collector.COUNTRY_CANONICAL))

    def test_places_outlets_and_languages_named_after_a_country_are_not_that_country(self):
        for text in ("Navy kills ISWAP fighters on Lake Chad", "Attack near Al-Auja in the Jordan Valley",
                     "Clashes in South Sudan's Upper Nile", "Latest news from Azerbaijan",
                     "South China Morning Post", "Spanish media report an arrest", "Omani pilot detained",
                     "Lake-Chad region attack", "South Sudanese troops clash",
                     "Attack in Republic of Congo capital Brazzaville", "Congo-Brazzaville unrest"):
            with self.subTest(text=text):
                self.assertEqual(collector.extract_country_families(text), set())
        self.assertEqual(collector.extract_country_families("Chad army repels Boko Haram near Lake Chad"), {"chad"})

    def test_a_new_country_keeps_two_countries_apart_but_never_makes_two_stories_alike(self):
        def news(title, url):
            return {"id": url, "title": title, "original_title": title, "summary": title, "url": url,
                    "source": "Outlet", "published": "2026-10-24T10:00:00+00:00", "category": "Attacks"}
        # Merged as country-less before 2026-11-04 (title_plus_anchor 0.71).
        nigeria = news("Death toll from gunman attack in northeastern Nigeria rises to 62", "https://a.test/ng")
        jordan_toll = news("Death toll from church attack in Jordan rises to nine", "https://a.test/jo")
        self.assertEqual(collector.event_match(nigeria, jordan_toll)[0:3:2], (False, "country_conflict"))
        # Two developments of the Karak attack: as an anchor 'Jordanian' would
        # fold them into one record (paraphrase_entity_context 0.66); records
        # are developments, so they stay two and consolidation links them.
        visit = news("Jordanian King visits victims of Kerak church terrorist attack", "https://a.test/1")
        vow = news("Jordanian King vows severe penalties for perpetrators of terrorist attack", "https://a.test/2")
        self.assertEqual(collector.event_match(visit, vow)[0:3:2], (False, "different_event"))
        saved = collector.COUNTRY_CONFLICT_ONLY
        try:
            collector.COUNTRY_CONFLICT_ONLY = frozenset()
            self.assertEqual(collector.event_match(visit, vow)[0:3:2], (True, "paraphrase_entity_context"))
        finally:
            collector.COUNTRY_CONFLICT_ONLY = saved


if __name__ == "__main__":
    unittest.main()
