"""Regression coverage for large datasets and mirror publication receipts."""
import hashlib
import io
import json
import sys
import tempfile
import unittest
import contextlib
import os
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


if __name__ == "__main__":
    unittest.main()
