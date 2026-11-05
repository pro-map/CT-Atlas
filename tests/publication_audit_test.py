"""Regression coverage for large datasets and mirror publication receipts."""
import hashlib
import io
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import daily_publication_audit as audit
import compact_mirror_json as mirror
import build_events_lite as light
import build_events_map as map_file


class PublicationAuditTests(unittest.TestCase):
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
        data = {"events": [{"id": "a", "title": "A source", "published": "2026-11-01", "summary": "Example"}]}
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
        attack = {"primary_event_type": "ATTACK", "is_attack": True, "incident_id": "inc-1", "summary": "Example"}
        data = {"events": [
            {"id": "a", "title": "Attack", "published": "2026-11-01T08:00:00Z", "update_type": "INITIAL", **attack},
            {"id": "b", "title": "Funeral", "published": "2026-11-02T08:00:00Z", "update_type": "FOLLOW_UP", **attack},
            {"id": "c", "title": "Arrest", "published": "2026-11-02T08:00:00Z", "primary_event_type": "ARREST"},
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
        data = {"events": [{"id": "a", "title": "A source", "published": "2026-11-01", "summary": "Example " * 8}]}
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


if __name__ == "__main__":
    unittest.main()
