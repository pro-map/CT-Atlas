"""Offline mirror size regression tests; no provider calls or data changes."""
import contextlib
import hashlib
import io
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
        try:
            self.target.symlink_to(self.source)
        except OSError:
            pass  # Windows without the symlink privilege: the hard link below still checks aliasing.
        else:
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
        compact = 'tools/compact_mirror_json.py --input events.json --output "$STAGING/events.json" --allow-chunks'
        size_check = 'tools/compact_mirror_json.py --check-directory "$STAGING"'
        self.assertIn(compact, script)
        self.assertIn(size_check, script)
        deploy = '(cd "$STAGING" && python3 ../tools/wrangler_retry.py deploy)'
        self.assertIn(deploy, script)
        self.assertLess(script.index(compact), script.index(deploy))
        self.assertLess(script.index(size_check), script.index(deploy))

    def test_deploy_script_stages_derived_files_through_chunking_and_worker(self):
        # events-lite.json and events-map.json grow with the database like
        # events.json; written whole, either one over 25 MiB failed every deploy.
        script = (ROOT / "tools/deploy_mirror.sh").read_text(encoding="utf-8")
        deploy = script.index('(cd "$STAGING" && python3 ../tools/wrangler_retry.py deploy)')
        for name, builder in (("events-lite.json", "build_events_lite"), ("events-map.json", "build_events_map")):
            with self.subTest(name=name):
                build = f'python3 tools/{builder}.py --input events.json --output "$DERIVED/{name}"'
                stage = (f'python3 tools/compact_mirror_json.py --input "$DERIVED/{name}" '
                         f'--output "$STAGING/{name}" --allow-chunks')
                self.assertIn(build, script)
                self.assertIn(stage, script)
                self.assertLess(script.index(build), script.index(stage))
                self.assertLess(script.index(stage), deploy)
                self.assertEqual(script.count(f'--output "$STAGING/{name}"'), 1,
                                 "Only the chunking step may write it into the staging directory")
        self.assertIn('run_worker_first = ["/events.json", "/events-lite.json", "/events-map.json"]', script)

    def test_deploy_script_copies_the_logo_the_pages_request(self):
        # The other pages use CT-ATLAS.png; the lowercase duplicate would keep
        # serving an old logo after a logo-only update. The map and the hub
        # serve the 256 px copy, which the logo workflow versions.
        script = (ROOT / "tools/deploy_mirror.sh").read_text(encoding="utf-8")
        self.assertIn('cp CT-ATLAS.png "$STAGING/CT-ATLAS.png"', script)
        self.assertIn('cp CT-ATLAS-256.png "$STAGING/CT-ATLAS-256.png"', script)
        self.assertNotIn("cp ct-atlas.png", script)
        self.assertIn('src="CT-ATLAS-256.png', (ROOT / "index.html").read_text(encoding="utf-8"))
        self.assertIn('src="CT-ATLAS.png', (ROOT / "crypto.html").read_text(encoding="utf-8"))
        logo = (ROOT / ".github/workflows/refresh-logo-only.yml").read_text(encoding="utf-8")
        self.assertIn('Path("CT-ATLAS-256.png")', logo)
        self.assertIn("CT-ATLAS-256|", logo, "The workflow must still find the URLs it rewrites")

    def test_deploy_script_stages_the_map_libraries(self):
        script = (ROOT / "tools/deploy_mirror.sh").read_text(encoding="utf-8")
        self.assertIn('cp -R vendor "$STAGING/vendor"', script)
        self.assertLess(script.index('cp -R vendor "$STAGING/vendor"'), script.index("--check-directory"))

    def test_every_publication_file_over_the_asset_cap_is_chunked_losslessly(self):
        row = json.dumps({"summary": "عربي 中文 😀 " * 64, "n": 1.5}, ensure_ascii=False,
                         separators=(",", ":")).encode()
        source = self.root / "oversized.json"
        source.write_bytes(b'{"events": [\n' + b",\n".join([row] * (mirror.MAX_ASSET_BYTES // len(row) + 1))
                           + b'\n], "n": 1.2300e+04}')
        compact = mirror.compact_json_bytes(source.read_bytes())
        self.assertGreater(len(compact), mirror.MAX_ASSET_BYTES)
        for name in mirror.CHUNKED_FILES:
            with self.subTest(name=name):
                staging = self.root / ("staging-" + name)
                target = staging / name
                report = mirror.write_mirror_copy(source, target)
                self.assertFalse(target.exists(), "An oversized whole copy must not be uploaded")
                manifest = json.loads((staging / mirror.shard_manifest_name(name)).read_bytes())
                self.assertEqual(manifest["filename"], name)
                self.assertEqual(report["format"], mirror.SHARD_FORMAT)
                stem = name[:-len(".json")]
                for index, part in enumerate(manifest["parts"]):
                    self.assertEqual(part["path"], f"_events/{stem}-{manifest['sha256'][:16]}-{index:05d}.bin")
                self.assertGreater(len(manifest["parts"]), 1)
                self.assertEqual(mirror.read_mirror_bytes(staging, name), compact)
                mirror.check_asset_sizes(staging)
        # The deployed Worker and its tests already use these events.json names.
        self.assertEqual(mirror.shard_manifest_name("events.json"), mirror.SHARD_MANIFEST)

    def test_derived_files_share_one_staging_directory_without_mixing_chunks(self):
        staging = self.target.parent
        for name in mirror.CHUNKED_FILES:
            source = self.root / ("source-" + name)
            source.write_bytes(json.dumps({"events": [{"id": name, "summary": "a long string " * 4}]}).encode())
            mirror.write_mirror_copy(source, staging / name, limit=30, chunk_bytes=16)
        for name in mirror.CHUNKED_FILES:
            with self.subTest(name=name):
                self.assertEqual(json.loads(mirror.read_mirror_bytes(staging, name))["events"][0]["id"], name)
        lite_manifest = staging / mirror.shard_manifest_name("events-lite.json")
        manifest = json.loads(lite_manifest.read_bytes())
        manifest["filename"] = "events.json"
        lite_manifest.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "manifest"):
            mirror.read_mirror_bytes(staging, "events-lite.json")

    def test_only_publication_routes_can_be_chunked_or_reconstructed(self):
        self.source.write_bytes(b'{"events":[]}')
        with self.assertRaises(ValueError):
            mirror.write_mirror_copy(self.source, self.target.parent / "daily-collection-status.json")
        with self.assertRaisesRegex(ValueError, "Missing publication dataset"):
            mirror.read_mirror_bytes(self.target.parent, "events-map.json")
        with self.assertRaisesRegex(ValueError, "Missing publication dataset"):
            mirror.read_mirror_bytes(self.target.parent, "daily-collection-status.json")

    def test_full_repository_snapshot_preserved_when_present(self):
        source = ROOT / "events.json"
        if not source.exists():
            self.skipTest("Repository snapshot not present")
        raw = source.read_bytes()
        compact = mirror.compact_json_bytes(raw)
        self.assertEqual(mirror._decode(raw), mirror._decode(compact))
        self.assertEqual(source.read_bytes(), raw)
        self.assertEqual(len(json.loads(raw)["events"]), len(json.loads(compact)["events"]))
        mirror.write_mirror_copy(source, self.target)
        self.assertEqual(mirror.read_mirror_bytes(self.target.parent), compact)
        mirror.check_asset_sizes(self.target.parent)

    def test_oversized_json_uses_exact_bytes_even_across_unicode_and_numbers(self):
        raw = '{"events":[{"id":"a","summary":"عربي 中文 😀"}],"n":1.2300e+04}'.encode()
        self.source.write_bytes(raw)
        self.target.write_bytes(b"old oversized asset")
        report = mirror.write_mirror_copy(self.source, self.target, limit=30, chunk_bytes=7)
        self.assertFalse(self.target.exists())
        self.assertEqual(report["format"], mirror.SHARD_FORMAT)
        self.assertGreater(len(report["parts"]), 1)
        for part in report["parts"]:
            self.assertLessEqual((self.target.parent / part["path"]).stat().st_size, 7)
        self.assertEqual(mirror.read_mirror_bytes(self.target.parent), mirror.compact_json_bytes(raw))
        self.assertEqual(self.source.read_bytes(), raw)

    def test_chunk_content_damage_and_path_escape_are_refused(self):
        self.source.write_bytes(b'{"events":[{"id":"a","summary":"a long string"}]}')
        report = mirror.write_mirror_copy(self.source, self.target, limit=30, chunk_bytes=10)
        part = self.target.parent / report["parts"][0]["path"]
        original = part.read_bytes()
        part.write_bytes(b"x" * len(original))
        with self.assertRaisesRegex(ValueError, "content"):
            mirror.read_mirror_bytes(self.target.parent)
        part.write_bytes(original)
        manifest_path = self.target.parent / mirror.SHARD_MANIFEST
        manifest = json.loads(manifest_path.read_bytes())
        manifest["parts"][0]["path"] = "../events.json"
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "path"):
            mirror.read_mirror_bytes(self.target.parent)

    def test_small_document_keeps_ordinary_full_json(self):
        self.source.write_bytes(b'{"events":[{"id":"a"}]}')
        report = mirror.write_mirror_copy(self.source, self.target)
        self.assertEqual(report["format"], "single-json")
        self.assertTrue(self.target.exists())
        self.assertFalse((self.target.parent / mirror.SHARD_MANIFEST).exists())

    def test_a_rehearsal_may_lower_the_chunking_cap_but_never_raise_it(self):
        # tests/mirror-stage-e2e.test.cjs takes the chunked path with small files this way.
        with patch.dict(os.environ):
            os.environ.pop(mirror.REHEARSAL_CAP_VARIABLE, None)
            self.assertEqual(mirror.chunking_limit(), mirror.MAX_ASSET_BYTES)
        for value, limit in (("1", 1), (str(mirror.MAX_ASSET_BYTES), mirror.MAX_ASSET_BYTES)):
            with self.subTest(value=value), patch.dict(os.environ, {mirror.REHEARSAL_CAP_VARIABLE: value}):
                self.assertEqual(mirror.chunking_limit(), limit)
        for value in ("", "0", "-1", "1e6", str(mirror.MAX_ASSET_BYTES + 1)):
            with self.subTest(value=value), patch.dict(os.environ, {mirror.REHEARSAL_CAP_VARIABLE: value}):
                with self.assertRaises(ValueError):
                    mirror.chunking_limit()

    def test_the_command_chunks_at_the_rehearsal_cap_and_refuses_a_higher_one(self):
        self.source.write_bytes(b'{"events":[{"id":"a","summary":"a long string"}]}')
        argv = ["compact_mirror_json.py", "--input", str(self.source), "--output", str(self.target), "--allow-chunks"]
        with patch.object(sys, "argv", argv), patch.dict(os.environ, {mirror.REHEARSAL_CAP_VARIABLE: "16"}), \
                contextlib.redirect_stdout(io.StringIO()):
            mirror.main()
        self.assertFalse(self.target.exists())
        self.assertEqual(json.loads(mirror.read_mirror_bytes(self.target.parent))["events"][0]["id"], "a")
        too_high = str(mirror.MAX_ASSET_BYTES + 1)
        with patch.object(sys, "argv", argv), patch.dict(os.environ, {mirror.REHEARSAL_CAP_VARIABLE: too_high}), \
                contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as refused:
            mirror.main()
        self.assertEqual(refused.exception.code, 1)

    def test_chunk_failure_keeps_preexisting_full_asset(self):
        self.source.write_bytes(b'{"events":[{"id":"a","summary":"a long string"}]}')
        self.target.write_bytes(b"previous")
        with patch.object(mirror, "_atomic_write", side_effect=OSError("test")):
            with self.assertRaises(OSError):
                mirror.write_mirror_copy(self.source, self.target, limit=20)
        self.assertEqual(self.target.read_bytes(), b"previous")


if __name__ == "__main__":
    unittest.main()
