"""Regression coverage for large datasets and mirror publication receipts."""
import contextlib
import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import daily_publication_audit as audit
import compact_mirror_json as mirror
import build_events_lite as light
import build_events_map as map_file

POINT = {"primary_event_type": "ATTACK", "is_attack": True, "latitude": 33.3, "longitude": 44.4}


class PublicationAuditTests(unittest.TestCase):
    def setUp(self):
        # No test may read the live site; PublicationGateTests covers this check.
        offline = patch.object(audit, "shrink_problems", return_value=[])
        offline.start()
        self.addCleanup(offline.stop)

    def test_dataset_over_40_mib_is_verified_using_expected_size(self):
        data = {"events": [{"id": "a", "summary": "x" * (40 * 1024 * 1024)}]}
        raw = json.dumps(data).encode()
        with tempfile.TemporaryDirectory() as directory:
            expected = Path(directory) / "manifest.json"
            output = Path(directory) / "receipt.json"
            audit.write(expected, {"files": {"events.json": {
                "sha256_canonical_json": audit.digest(data), "record_count": 1, "size_bytes": len(raw)
            }}})
            with patch.object(audit.urllib.request, "urlopen", return_value=io.BytesIO(raw)):
                self.assertTrue(audit.verify("https://example.test", expected, output, attempts=1)["publication_confirmed"])
            with patch.object(audit.urllib.request, "urlopen", return_value=io.BytesIO(raw + b" ")):
                with self.assertRaises(RuntimeError):
                    audit.verify("https://example.test", expected, output, attempts=1)
            self.assertFalse(audit.read(output)["publication_confirmed"])

    def test_manifest_covers_reconstructed_full_dataset_and_derived_files(self):
        data = {"events": [{"id": "a", "title": "A source", "published": "2026-11-01", "summary": "Example", **POINT}]}
        lite = light.build_lite(data, light.load_excluded())
        mapped = {"events": lite["events"], "recent_events": []}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.json"
            source.write_text(json.dumps(data, indent=2))
            mirror.write_mirror_copy(source, root / "events.json", limit=60, chunk_bytes=50)
            audit.write(root / "events-lite.json", lite)
            audit.write(root / "events-map.json", mapped)
            result = audit.manifest(root, root / "publication-manifest.json")
            self.assertEqual(result["files"]["events.json"]["record_count"], 1)
            self.assertEqual(result["files"]["events.json"]["sha256_canonical_json"], audit.digest(data))
            compact = mirror.compact_json_bytes(source.read_bytes())
            self.assertEqual(result["files"]["events.json"]["size_bytes"], len(compact))
            self.assertEqual(result["files"]["events.json"]["sha256_bytes"], hashlib.sha256(compact).hexdigest())
            self.assertEqual(result["files"]["events-map.json"]["sha256_bytes"],
                             hashlib.sha256((root / "events-map.json").read_bytes()).hexdigest())
            self.assertEqual(set(result["files"]), set(audit.FILES))

    def test_manifest_accepts_a_dataset_with_stamped_follow_ups(self):
        # A field added to events-lite.json fails validate(), and the builder's
        # failure path deletes the file: the unguarded manifest step then blocks
        # the whole publication.
        attack = {**POINT, "incident_id": "inc-1", "summary": "Example"}
        data = {"events": [
            {"id": "a", "title": "Attack", "published": "2026-11-01T08:00:00Z", "update_type": "INITIAL", **attack},
            {"id": "b", "title": "Funeral", "published": "2026-11-02T08:00:00Z", "update_type": "FOLLOW_UP", **attack},
            {"id": "c", "title": "Arrest", "published": "2026-11-02T08:00:00Z", "primary_event_type": "ARREST",
             "latitude": 33.3, "longitude": 44.4},
        ]}
        excluded = light.load_excluded()
        lite = light.build_lite(data, excluded)
        mapped = map_file.build_map(data, excluded, now=datetime(2026, 11, 3, tzinfo=timezone.utc))
        map_file.validate(mapped, data)
        self.assertEqual([event["id"] for event in mapped["events"]], ["a"])
        self.assertEqual([event["id"] for event in mapped["recent_events"]], ["b", "c"])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            audit.write(root / "events.json", data)
            audit.write(root / "events-lite.json", lite)
            audit.write(root / "events-map.json", mapped)
            result = audit.manifest(root, root / "publication-manifest.json")
        self.assertEqual(result["files"]["events-lite.json"]["record_count"], 3)
        self.assertEqual(result["files"]["events-map.json"]["record_count"], 3)

    def test_manifest_accepts_a_point_drawn_on_a_sibling_record_only(self):
        attack = {"primary_event_type": "ATTACK", "is_attack": True, "incident_id": "inc-1", "summary": "Example",
                  "country_code": "JO"}
        data = {"events": [
            {"id": "a", "title": "Attack", "published": "2026-10-23T08:00:00Z", "update_type": "INITIAL", "city": "Amman",
             "latitude": 31.95, "longitude": 35.93, "location_precision": "country_capital", **attack},
            {"id": "b", "title": "Arrest", "published": "2026-10-24T08:00:00Z", "update_type": "FOLLOW_UP", "city": "Karak",
             "latitude": 31.18, "longitude": 35.70, "location_precision": "city", **attack},
        ]}
        excluded = light.load_excluded()
        mapped = map_file.build_map(data, excluded, now=datetime(2026, 11, 3, tzinfo=timezone.utc))
        self.assertEqual(mapped["events"][0]["latitude"], 31.18)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            audit.write(root / "events.json", data)
            audit.write(root / "events-lite.json", light.build_lite(data, excluded))
            audit.write(root / "events-map.json", mapped)
            audit.manifest(root, root / "publication-manifest.json")
            mapped["events"][0]["latitude"] = 1.0
            audit.write(root / "events-map.json", mapped)
            with self.assertRaisesRegex(ValueError, "Derived data differs"):
                audit.manifest(root, root / "publication-manifest.json")

    def test_manifest_reconstructs_chunked_derived_files(self):
        # The mirror chunks events-lite.json and events-map.json once they
        # outgrow the asset cap; the manifest must still read and check them.
        data = {"events": [{"id": "a", "title": "A source", "published": "2026-11-01", "summary": "Example " * 8, **POINT}]}
        lite = light.build_lite(data, light.load_excluded())
        mapped = {"events": lite["events"], "recent_events": []}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, document in (("events.json", data), ("events-lite.json", lite), ("events-map.json", mapped)):
                source = root / ("source-" + name)
                source.write_text(json.dumps(document, indent=2))
                mirror.write_mirror_copy(source, root / name, limit=60, chunk_bytes=50)
                self.assertFalse((root / name).exists())
            result = audit.manifest(root, root / "publication-manifest.json")
            for name in audit.FILES:
                compact = mirror.compact_json_bytes((root / ("source-" + name)).read_bytes())
                self.assertEqual(result["files"][name]["sha256_bytes"], hashlib.sha256(compact).hexdigest())
            self.assertEqual(result["files"]["events-map.json"]["record_count"], 1)

    def test_served_revision_reads_the_deployed_manifest_and_never_guesses(self):
        revision = "0123456789abcdef0123456789abcdef01234567"
        def served(body):
            with patch.object(audit.urllib.request, "urlopen", return_value=io.BytesIO(body)) as opened:
                result = audit.served_revision("https://mirror.example.test/")
            self.assertTrue(opened.call_args[0][0].full_url.startswith(
                "https://mirror.example.test/publication-manifest.json?integrity="))
            return result
        self.assertEqual(served(json.dumps({"source_revision": revision}).encode()), revision)
        # Anything unexpected means "unknown", so the mirror deploys instead of skipping.
        for body in (b"{}", b"not json", json.dumps({"source_revision": "HEAD"}).encode(),
                     json.dumps({"source_revision": revision.upper()}).encode()):
            with self.subTest(body=body):
                self.assertIsNone(served(body))
        with patch.object(audit.urllib.request, "urlopen", side_effect=OSError("offline")):
            self.assertIsNone(audit.served_revision("https://mirror.example.test"))
        with self.assertRaises(ValueError):
            audit.served_revision("http://mirror.example.test")


class PublicationGateTests(unittest.TestCase):
    """The audit ran the real builders on 7 damaged copies of events.json (6 Nov 2026):
    all 7 exited 0 and would have deployed. The site it compares with is 100 records."""
    NOW = datetime(2026, 11, 6, 12, tzinfo=timezone.utc)

    def setUp(self):
        self.live = {"files": {name: {"record_count": 100} for name in audit.FILES}}
        served = patch.object(audit, "served_manifest", side_effect=lambda url: self.live)
        self.served = served.start()
        self.addCleanup(served.stop)
        directory = tempfile.TemporaryDirectory()
        self.root = Path(directory.name)
        self.addCleanup(directory.cleanup)

    def database(self, count=100):
        return {"last_updated": "2026-11-05T23:10:25+00:00", "events": [
            {"id": f"e{index}", "title": "Record", "summary": "Example", "published": "2026-11-01T08:00:00Z",
             "incident_id": f"incident-{index}", **POINT} for index in range(count)]}

    def publish(self, data, damage_map=None, env=None):
        excluded = light.load_excluded()
        mapped = map_file.build_map(data, excluded, now=self.NOW)
        if damage_map:
            damage_map(mapped)
        audit.write(self.root / "events.json", data)
        audit.write(self.root / "events-lite.json", light.build_lite(data, excluded))
        audit.write(self.root / "events-map.json", mapped)
        with patch.dict(os.environ, env or {}), contextlib.redirect_stdout(io.StringIO()) as printed:
            result = audit.manifest(self.root, self.root / "publication-manifest.json", now=self.NOW)
        self.assertEqual(result, audit.read(self.root / "publication-manifest.json"))
        return printed.getvalue()

    def refused(self, data, reason, damage_map=None):
        with self.assertRaisesRegex(ValueError, reason):
            self.publish(data, damage_map)
        self.assertFalse((self.root / "publication-manifest.json").exists(),
                         "A refused publication must leave no manifest behind")

    def test_an_intact_dataset_passes(self):
        self.publish(self.database())
        self.assertEqual(self.served.call_args[0][0], "https://ct-atlas.com")

    def test_a_map_missing_one_record_of_its_window_is_refused(self):
        # mapped.keys() <= full.keys() accepted any subset: with every date unreadable
        # the map kept 1,917 of 6,381 records and still passed.
        data = self.database()
        data["events"].append({"id": "arrest", "title": "Arrest", "published": "2026-11-02T08:00:00Z",
                               "primary_event_type": "ARREST", "latitude": 33.3, "longitude": 44.4})
        self.publish(data)
        (self.root / "publication-manifest.json").unlink()
        self.refused(data, "1 records inside the map window are not in the map, such as arrest",
                     lambda mapped: mapped.update(recent_events=[]))

    def test_a_record_older_than_the_window_may_leave_the_map(self):
        data = self.database()
        window = self.NOW - timedelta(days=map_file.RECENT_DAYS)
        data["events"].append({"id": "old", "title": "Arrest", "published": (window - timedelta(hours=1)).isoformat(),
                               "primary_event_type": "ARREST", "latitude": 33.3, "longitude": 44.4})
        data["events"].append({"id": "edge", "title": "Arrest", "published": (window + timedelta(hours=1)).isoformat(),
                               "primary_event_type": "ARREST", "latitude": 33.3, "longitude": 44.4})
        self.publish(data)
        mapped = audit.read(self.root / "events-map.json")
        self.assertEqual([event["id"] for event in mapped["recent_events"]], ["edge"])

    def test_a_shrink_of_more_than_ten_percent_is_refused(self):
        # The audit's 10-events, half-the-events and nothing-after-September copies.
        for count in (10, 50, 89):
            with self.subTest(count=count):
                self.refused(self.database(count), f"events.json has {count} records, the live site 100")
        self.publish(self.database(90))

    def test_every_published_file_is_compared_with_the_live_site(self):
        self.live["files"]["events-map.json"]["record_count"] = 500
        self.refused(self.database(), "events-map.json has 100 records, the live site 500")

    def test_allow_shrink_lets_the_judicial_retirement_through(self):
        # The largest drop in 353 commits: -21.2%, deliberate. The next was -5.6%.
        self.refused(self.database(79), "events.json has 79 records")
        self.assertEqual(self.publish(self.database(79), env={"ALLOW_SHRINK": "1"}), "")
        self.publish(self.database(95))
        for other in ("0", "true", ""):
            with self.subTest(value=other), self.assertRaises(ValueError):
                self.publish(self.database(79), env={"ALLOW_SHRINK": other})

    def test_the_shrink_rule_is_skipped_only_when_the_live_manifest_cannot_be_read(self):
        for live in (None, {}, {"files": {}}, {"files": {"events.json": {}}}, {"files": []},
                     {"files": {name: {"record_count": "100"} for name in audit.FILES}}):
            with self.subTest(live=live):
                self.live = live
                self.assertIn("::warning::The live manifest could not be read", self.publish(self.database(10)))

    def test_every_coordinate_lost_is_refused(self):
        data = self.database()
        for event in data["events"]:
            event.update(latitude=None, longitude=None, excluded_from_map=True)
        self.refused(data, "only 0 of 100 records are located")

    def test_located_share_stops_at_one_half(self):
        data = self.database()
        for event in data["events"][:50]:
            event.update(latitude=None, longitude=None)
        self.publish(data)
        (self.root / "publication-manifest.json").unlink()
        data["events"][50].update(location_precision="unlocated")
        self.refused(data, "only 49 of 100 records are located")

    def test_unreadable_dates_stop_at_one_percent(self):
        data = self.database()
        data["events"][0]["published"] = "not a date"
        self.publish(data)
        (self.root / "publication-manifest.json").unlink()
        data["events"][1]["published"] = ""
        self.refused(data, "2 of 100 published dates are unreadable")

    def test_every_date_unreadable_is_refused(self):
        data = self.database()
        for event in data["events"]:
            event["published"] = "not a date"
        self.refused(data, "100 of 100 published dates are unreadable")

    def test_a_map_with_no_attack_point_is_refused(self):
        data = self.database()
        for event in data["events"]:
            event.update(primary_event_type="ARREST", is_attack=False)
        self.refused(data, "the map has no attack point")

    def test_attacks_that_cannot_be_drawn_are_not_a_point(self):
        data = self.database()
        data["events"][0].update(primary_event_type="ATTACK")
        for event in data["events"][1:]:
            event.update(primary_event_type="ARREST", is_attack=False)
        data["events"][0].update(latitude=None, longitude=None, excluded_from_map=True)
        self.refused(data, "the map has no attack point")

    def test_an_old_last_updated_is_no_reason_to_refuse(self):
        # A failed collection must still publish its honest status.
        data = self.database()
        data["last_updated"] = "2026-06-01T00:00:00+00:00"
        self.publish(data)


class LivePublicationTests(unittest.TestCase):
    """The times and counts are real, from the stored versions of events.json."""
    MAIN, MIRROR = "https://ct-atlas.com", "https://ct-atlas-mirror.fairpeace.workers.dev"

    def records(self, count, published):
        return [{"id": f"e{index}", "published": published} for index in range(count)]

    def site(self, url, *, updated="2026-11-04T23:36:00+00:00", attempt="2026-11-04T22:37:00+00:00",
             created="2026-11-04T23:39:00+00:00", database="same", events=None):
        document = {"last_updated": updated, "collection_status": {"last_attempt_at": attempt},
                    "events": self.records(88, "2026-11-04T12:00:00+00:00") if events is None else events,
                    "recent_events": []}
        payload = hashlib.sha256(json.dumps(document).encode()).hexdigest()
        return {"url": url, "map": document, "sha256_bytes": payload,
                "manifest": {"created_at": created, "files": {"events.json": {"sha256_canonical_json": database},
                                                              "events-map.json": {"sha256_bytes": payload}}}}

    def problems(self, now, main=None, mirror=None):
        return audit.live_problems(main or self.site(self.MAIN), mirror or self.site(self.MIRROR),
                                   datetime.fromisoformat(now))

    def test_a_healthy_publication_is_green(self):
        self.assertEqual(self.problems("2026-11-05T06:47:00+00:00"), [])

    def test_the_longest_gap_github_produced_is_not_an_alarm(self):
        # GitHub starts slot 1 up to 10.2 h late: 18.7 h overnight is the norm, and the
        # next update after 29 Oct 17:25 came 23.8 h later, across a failed run.
        for now in ("2026-11-05T18:18:00+00:00", "2026-11-05T23:24:00+00:00"):
            with self.subTest(now=now):
                self.assertEqual(self.problems(now), [])

    def test_a_frozen_map_turns_the_run_red(self):
        found = self.problems("2026-11-06T02:00:00+00:00")
        self.assertEqual(len(found), 1)
        self.assertIn("the map was last updated 26.4 h ago", found[0])

    def test_the_starved_runs_of_5_nov_turn_the_run_red(self):
        # Green all day: the header said Published 6 Nov and the card said partial, as
        # it does every day. 21 records, then 7, against a median of 92.
        for count, attempt, updated in ((21, "2026-11-05T17:26:00+00:00", "2026-11-05T18:04:00+00:00"),
                                        (7, "2026-11-05T22:40:00+00:00", "2026-11-05T23:10:00+00:00")):
            with self.subTest(count=count):
                main = self.site(self.MAIN, attempt=attempt, updated=updated,
                                 events=self.records(count, "2026-11-05T12:00:00+00:00"))
                found = self.problems("2026-11-06T00:47:00+00:00", main)
                self.assertEqual(found, [f"only {count} records were published in the 24 h before the last collection run"])

    def test_the_count_stops_at_30_and_ignores_older_records(self):
        recent = self.records(30, "2026-11-04T12:00:00+00:00")
        older = self.records(500, "2026-11-03T22:36:00+00:00")
        self.assertEqual(self.problems("2026-11-05T06:47:00+00:00", self.site(self.MAIN, events=recent + older)), [])
        self.assertEqual(len(self.problems("2026-11-05T06:47:00+00:00", self.site(self.MAIN, events=recent[1:] + older))), 1)

    def test_the_count_is_not_measured_from_now(self):
        # The run of 2 Nov 20:33: 22.5 h after the one before. A smoke run just before it
        # finds 24 h back from now almost empty, on a healthy map.
        main = self.site(self.MAIN, updated="2026-11-01T22:04:00+00:00", attempt="2026-11-01T21:10:00+00:00",
                         created="2026-11-01T22:08:00+00:00", events=self.records(83, "2026-11-01T14:00:00+00:00"))
        mirror = self.site(self.MIRROR, created="2026-11-01T22:09:00+00:00")
        self.assertEqual(self.problems("2026-11-02T18:47:00+00:00", main, mirror), [])

    def test_the_count_is_not_measured_from_last_updated(self):
        # A write outside collection moves last_updated and keeps last_attempt_at, as
        # tools/repair_map_evidence.py does today. A checkpoint of 19 Oct 13:59, late in
        # the overnight gap, read 14 records from last_updated and 73 from the run.
        main = self.site(self.MAIN, updated="2026-10-19T13:59:00+00:00", attempt="2026-10-18T18:37:00+00:00",
                         events=self.records(73, "2026-10-18T12:00:00+00:00"))
        self.assertEqual(self.problems("2026-10-19T14:47:00+00:00", main), [])

    def test_a_map_that_is_not_the_one_its_manifest_names_is_a_problem(self):
        for label, side in (("ct-atlas.com", "main"), ("workers.dev", "mirror")):
            with self.subTest(side=side):
                broken = self.site(self.MAIN if side == "main" else self.MIRROR)
                broken["sha256_bytes"] = "0" * 64
                found = self.problems("2026-11-05T06:47:00+00:00", **{side: broken})
                self.assertEqual(len(found), 1)
                self.assertIn(label, found[0])
                self.assertIn("is not the file its manifest names", found[0])

    def test_the_seven_day_mirror_failure_turns_the_run_red(self):
        # 36 failed mirror runs, 25 Oct to 1 Nov, with live-smoke green throughout.
        main = self.site(self.MAIN, created="2026-10-26T17:30:00+00:00", database="new",
                         updated="2026-10-26T17:23:00+00:00", attempt="2026-10-26T16:30:00+00:00",
                         events=self.records(84, "2026-10-26T12:00:00+00:00"))
        mirror = self.site(self.MIRROR, created="2026-10-25T20:40:00+00:00", database="old")
        found = self.problems("2026-10-26T19:47:00+00:00", main, mirror)
        self.assertEqual(len(found), 1)
        self.assertIn("the mirror still serves the publication of 2026-10-25T20:40:00+00:00", found[0])

    def test_a_mirror_about_to_follow_pages_is_not_lag(self):
        # After an 18.7 h gap the two created_at are 18.7 h apart until the mirror deploys.
        main = self.site(self.MAIN, created="2026-11-04T18:11:00+00:00", database="new",
                         updated="2026-11-04T18:09:00+00:00", attempt="2026-11-04T17:17:00+00:00",
                         events=self.records(62, "2026-11-04T12:00:00+00:00"))
        mirror = self.site(self.MIRROR, created="2026-11-03T23:29:00+00:00", database="old")
        self.assertEqual(self.problems("2026-11-04T18:47:00+00:00", main, mirror), [])

    def test_a_mirror_ahead_of_pages_is_not_lag(self):
        # The mirror builds from main, which a commit may move after the Pages deploy.
        mirror = self.site(self.MIRROR, created="2026-11-05T01:00:00+00:00", database="newer")
        self.assertEqual(self.problems("2026-11-05T06:47:00+00:00", mirror=mirror), [])

    def test_same_data_on_a_different_build_is_not_lag(self):
        # A UI or a status-free commit changes the revision, not what the map shows.
        mirror = self.site(self.MIRROR, created="2026-11-04T10:00:00+00:00")
        self.assertEqual(self.problems("2026-11-05T06:47:00+00:00", mirror=mirror), [])

    def check(self, reads, **options):
        with patch.object(audit, "read_live", side_effect=reads) as reader, contextlib.redirect_stdout(io.StringIO()) as printed:
            pauses = []
            try:
                audit.live_check(self.MAIN, self.MIRROR, sleep=pauses.append,
                                 now=datetime(2026, 11, 5, 6, 47, tzinfo=timezone.utc), **options)
            finally:
                self.calls = [call[0][0] for call in reader.call_args_list]
                self.pauses = pauses
                self.printed = printed.getvalue()

    def test_the_gap_between_two_cached_files_is_waited_out(self):
        # Pages' files can sit up to max-age=600 apart right after a publication.
        skewed = self.site(self.MAIN)
        skewed["sha256_bytes"] = "0" * 64
        self.check([skewed, self.site(self.MIRROR), self.site(self.MAIN), self.site(self.MIRROR)])
        self.assertEqual(self.calls, [self.MAIN, self.MIRROR] * 2)
        self.assertEqual(self.pauses, [60])
        self.assertIn("Live map consistent: updated 2026-11-04T23:36:00+00:00, 88 records", self.printed)

    def test_retries_outlast_the_cdn_cache_and_then_fail(self):
        skewed = self.site(self.MAIN)
        skewed["sha256_bytes"] = "0" * 64
        with self.assertRaisesRegex(RuntimeError, "Live publication check failed: .*not the file its manifest names"):
            self.check([skewed, self.site(self.MIRROR)] * 12)
        self.assertGreater(sum(self.pauses), 600)

    def test_a_site_that_cannot_be_read_fails_the_check(self):
        # The mirror is there for networks that block the main domain.
        down = RuntimeError(self.MIRROR + ": HTTPError: HTTP Error 503")
        with self.assertRaisesRegex(RuntimeError, "workers.dev: HTTPError"):
            self.check([self.site(self.MAIN), down] * 2, attempts=2)

    def test_a_map_without_its_dates_fails_the_check(self):
        broken = self.site(self.MAIN)
        del broken["map"]["collection_status"]
        with self.assertRaisesRegex(RuntimeError, "Live publication check failed: KeyError"):
            self.check([broken, self.site(self.MIRROR)], attempts=1)

    def test_only_https_urls_are_read(self):
        for urls in (("http://ct-atlas.com", self.MIRROR), (self.MAIN, ""), ("", "")):
            with self.subTest(urls=urls), patch.object(audit, "read_live") as reader:
                with self.assertRaises(ValueError):
                    audit.live_check(*urls, attempts=1)
                reader.assert_not_called()

    def test_the_sites_are_read_at_the_urls_users_fetch(self):
        # verify reads ?integrity= URLs, which bypass the CDN cache users go through.
        body = json.dumps({"events": []}).encode()
        requests = []
        def opened(request, timeout):
            requests.append(request)
            return io.BytesIO(body)
        with patch.object(audit.urllib.request, "urlopen", side_effect=opened):
            result = audit.read_live("https://ct-atlas.com/")
        self.assertEqual([request.full_url for request in requests],
                         ["https://ct-atlas.com/publication-manifest.json", "https://ct-atlas.com/events-map.json"])
        self.assertEqual(result["sha256_bytes"], hashlib.sha256(body).hexdigest())
        self.assertEqual(result["map"], {"events": []})
        with patch.object(audit.urllib.request, "urlopen", return_value=io.BytesIO(b"<html>")):
            with self.assertRaisesRegex(RuntimeError, "https://ct-atlas.com: JSONDecodeError"):
                audit.read_live("https://ct-atlas.com")


if __name__ == "__main__":
    unittest.main()
