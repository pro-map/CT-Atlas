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
        "id": title[:20], "title": title, "summary": title, "published": published,
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


if __name__ == "__main__":
    unittest.main()
