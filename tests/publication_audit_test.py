"""Regression coverage for large datasets and mirror publication receipts."""
import hashlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import daily_publication_audit as audit
import compact_mirror_json as mirror
import build_events_lite as light


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


if __name__ == "__main__":
    unittest.main()
