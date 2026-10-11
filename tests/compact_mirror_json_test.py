"""Offline mirror size regression tests; no provider calls or data changes."""
import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import compact_mirror_json as mirror


class CompactMirrorJsonTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "events.json"
        self.target = self.root / "staging" / "events.json"
        self.target.parent.mkdir()

    def test_every_field_and_unicode_string_preserved(self):
        data = {"events": [{"id": "a", "title": "عربي 中文 é", "summary": 'two  spaces\nline\t"quoted"\\tail',
                            "latitude": 6.5833, "longitude": None, "selected": True,
                            "sources": [{"url": "https://example.test/a?q=a%20b"}]}],
                "unknown_future_field": [False, 0, ""]}
        raw = json.dumps(data, ensure_ascii=False, indent=4).encode()
        result = mirror.compact_json_bytes(raw)
        self.assertEqual(json.loads(result), data)
        self.assertIn(json.dumps(data["events"][0]["summary"]).encode(), result)
        self.assertLess(len(result), len(raw))

    def test_number_and_escape_lexemes_are_unchanged(self):
        raw = br' { "n": 1.2300e+04, "zero": -0, "huge": 123456789012345678901234567890, "s": "a \u4e2d \/ \\\" z" } '
        result = mirror.compact_json_bytes(raw)
        for token in (b'1.2300e+04', b'-0', b'123456789012345678901234567890', br'\u4e2d', br'\/'):
            self.assertIn(token, result)
        self.assertEqual(mirror.compact_json_bytes(result), result)

    def test_invalid_json_refused_without_overwriting(self):
        for raw in (b'{"x":', b'{"x": NaN}', b'{"x": Infinity}', b'{"x":1,"x":2}', b'{"s":"\xff"}'):
            with self.subTest(raw=raw):
                self.source.write_bytes(raw)
                self.target.write_bytes(b"previous")
                with self.assertRaises(ValueError):
                    mirror.write_compact_copy(self.source, self.target)
                self.assertEqual(self.target.read_bytes(), b"previous")

    def test_only_staged_copy_changes_and_repeated_output_is_stable(self):
        raw = b'{\n  "events": [{"id": "a", "summary": "A  B"}]\n}\n'
        self.source.write_bytes(raw)
        first = mirror.write_compact_copy(self.source, self.target)
        second = mirror.write_compact_copy(self.source, self.target)
        self.assertEqual(first, second)
        self.assertEqual(self.source.read_bytes(), raw)
        self.assertEqual(first["asset_sha256"], hashlib.sha256(self.target.read_bytes()).hexdigest())

    def test_reject_source_path_symlink_and_hardlink(self):
        self.source.write_bytes(b'{"events":[]}')
        with self.assertRaises(ValueError):
            mirror.write_compact_copy(self.source, self.source)
        self.target.symlink_to(self.source)
        with self.assertRaises(ValueError):
            mirror.write_compact_copy(self.source, self.target)
        self.target.unlink()
        os.link(self.source, self.target)
        with self.assertRaises(ValueError):
            mirror.write_compact_copy(self.source, self.target)

    def test_limit_enforced_on_compacted_bytes_no_truncation(self):
        self.source.write_bytes(b'{ "events": [1,2,3] }')
        self.target.write_bytes(b"previous")
        size = len(mirror.compact_json_bytes(self.source.read_bytes()))
        with self.assertRaises(ValueError):
            mirror.write_compact_copy(self.source, self.target, limit=size - 1)
        self.assertEqual(self.target.read_bytes(), b"previous")
        mirror.write_compact_copy(self.source, self.target, limit=size)

    def test_atomic_failure_keeps_previous_asset(self):
        self.source.write_bytes(b'{"events":[]}')
        self.target.write_bytes(b"previous")
        with patch.object(mirror.os, "replace", side_effect=OSError("test")):
            with self.assertRaises(OSError):
                mirror.write_compact_copy(self.source, self.target)
        self.assertEqual(self.target.read_bytes(), b"previous")
        self.assertEqual(list(self.target.parent.glob("*.tmp")), [])

    def test_preflight_checks_all_files_including_nested_assets(self):
        self.target.write_bytes(b"1234")
        self.assertEqual(mirror.check_asset_sizes(self.target.parent, limit=4), 1)
        nested = self.target.parent / "nested"
        nested.mkdir()
        (nested / "oversize.bin").write_bytes(b"12345")
        with self.assertRaises(ValueError):
            mirror.check_asset_sizes(self.target.parent, limit=4)

    def test_empty_or_missing_staging_refused(self):
        with self.assertRaises(ValueError):
            mirror.check_asset_sizes(self.root / "missing")
        with self.assertRaises(ValueError):
            mirror.check_asset_sizes(self.target.parent)

    def test_deploy_script_uses_compaction_and_size_check_before_upload(self):
        script = (ROOT / "tools/deploy_mirror.sh").read_text()
        compact = 'tools/compact_mirror_json.py --input events.json --output "$STAGING/events.json"'
        size_check = 'tools/compact_mirror_json.py --check-directory "$STAGING"'
        self.assertIn(compact, script)
        self.assertIn(size_check, script)
        self.assertLess(script.index(compact), script.index('npx wrangler'))
        self.assertLess(script.index(size_check), script.index('npx wrangler'))

    def test_full_repository_snapshot_preserved_when_present(self):
        source = ROOT / "events.json"
        if not source.exists():
            self.skipTest("Repository snapshot not present")
        raw = source.read_bytes()
        compact = mirror.compact_json_bytes(raw)
        self.assertEqual(mirror._decode(raw), mirror._decode(compact))
        self.assertEqual(source.read_bytes(), raw)
        self.assertLessEqual(len(compact), mirror.MAX_ASSET_BYTES)
        self.assertEqual(len(json.loads(raw)["events"]), len(json.loads(compact)["events"]))


if __name__ == "__main__":
    unittest.main()
