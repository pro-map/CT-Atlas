"""Exercise script imports without pytest's repository path masking errors."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class CollectorEntrypointTests(unittest.TestCase):
    def isolated_python(self, *args):
        env = os.environ.copy()
        for name in ("GEMINI_API_KEY", "CLOUDFLARE_API_TOKEN", "PYTHONPATH"):
            env.pop(name, None)
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                [sys.executable, "-P", *args], cwd=directory, env=env,
                capture_output=True, text=True, timeout=60,
            )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    def test_direct_collector_scripts_start_outside_repository(self):
        for script in (
            "consolidate_incidents.py", "cleanup_existing_events.py",
            "sync_background_corpus.py",
        ):
            with self.subTest(script=script):
                output = self.isolated_python(str(ROOT / "tools" / script), "--help")
                self.assertIn("usage:", output)

    def test_archive_jobs_load_collector_with_its_sibling_module(self):
        script = ROOT / "tools" / "archive_review.py"
        output = self.isolated_python("-c", (
            f"import runpy; module = runpy.run_path({str(script)!r}); "
            "collector = module['load_collector'](); "
            "assert collector.radnuc.KEYWORDS; print('RADNUC loaded')"
        ))
        self.assertIn("RADNUC loaded", output)

    def test_consolidation_dry_run_preserves_input_and_state(self):
        event = {
            "id": "test", "title": "Terror suspect arrested", "summary": "A suspect was arrested.",
            "published": "2026-10-07T10:00:00Z", "category": "Arrests",
            "country": "France", "url": "https://example.com/incident",
        }
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "events.json"
            state = Path(directory) / "state.json"
            content = json.dumps({"events": [event], "number_of_events": 1})
            source.write_text(content, encoding="utf-8")
            output = self.isolated_python(
                str(ROOT / "tools" / "consolidate_incidents.py"), "--dry-run",
                "--input", str(source), "--state", str(state),
            )
            self.assertIn("Dry run: nothing written.", output)
            self.assertEqual(source.read_text(encoding="utf-8"), content)
            self.assertFalse(state.exists())


if __name__ == "__main__":
    unittest.main()
