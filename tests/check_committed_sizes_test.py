"""tools/check_committed_sizes.py in a throwaway Git repository, with the
thresholds scaled down so that no test writes 100 MiB."""
import contextlib
import importlib.util
import io
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("check_committed_sizes", ROOT / "tools/check_committed_sizes.py")
sizes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sizes)


class CommittedSizeTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.git("init", "--quiet")
        self.git("config", "user.email", "test@example.test")
        self.git("config", "user.name", "Test")
        self.write("README", 10)
        self.git("add", ".")
        self.git("commit", "--quiet", "-m", "Start")
        cwd = os.getcwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, cwd)

    def git(self, *args):
        subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True)

    def write(self, name, size):
        (self.root / name).write_bytes(b"x" * size)

    def check(self, files=None):
        out = io.StringIO()
        with mock.patch.object(sizes, "WARN_BYTES", 500), mock.patch.object(sizes, "LIMIT_BYTES", 1000), \
                contextlib.redirect_stdout(out):
            status = sizes.main(files)
        return status, out.getvalue()

    def test_a_staged_file_at_the_limit_is_an_error(self):
        self.write("events.json", 1000)
        self.git("add", "events.json")
        status, output = self.check()
        self.assertEqual(status, 1)
        self.assertIn("::error title=File too large for GitHub::events.json is ", output)

    def test_a_staged_file_past_the_warning_size_only_warns(self):
        self.write("events.json", 999)
        self.git("add", "events.json")
        status, output = self.check()
        self.assertEqual(status, 0)
        self.assertIn("::warning title=File approaching GitHub's 100 MiB limit::events.json is ", output)

    def test_files_under_the_warning_size_say_nothing(self):
        self.write("events.json", 499)
        self.git("add", "events.json")
        self.assertEqual(self.check(), (0, ""))

    def test_the_commit_is_measured_not_the_working_tree(self):
        # The workflows stage and then keep working: the working tree can differ.
        self.write("events.json", 1200)
        self.git("add", "events.json")
        self.write("events.json", 10)
        self.assertEqual(self.check()[0], 1, "the commit would hold 1200 bytes")
        self.write("small.json", 10)
        self.git("add", "small.json")
        self.write("small.json", 1200)
        status, output = self.check(["small.json"])
        self.assertEqual((status, output), (0, ""), "the commit would hold 10 bytes")

    def test_a_staged_rename_is_measured(self):
        self.write("big.json", 1200)
        self.git("add", "big.json")
        self.git("commit", "--quiet", "-m", "Big")
        self.git("mv", "big.json", "moved.json")
        status, output = self.check()
        self.assertEqual(status, 1)
        self.assertIn("moved.json", output)

    def test_deleted_unstaged_and_untracked_files_are_not_measured(self):
        self.write("tracked.json", 1200)
        self.git("add", "tracked.json")
        self.git("commit", "--quiet", "-m", "Tracked")
        self.git("rm", "--quiet", "tracked.json")
        self.write("README", 1200)
        self.write("untracked.json", 1200)
        self.assertEqual(self.check(), (0, ""))
        self.assertEqual(self.check(["untracked.json"]), (0, ""))

    def test_the_command_line_warns_at_the_configured_size_and_still_succeeds(self):
        self.write("events.json", 2048)
        self.git("add", "events.json")
        result = subprocess.run([sys.executable, str(ROOT / "tools/check_committed_sizes.py")], cwd=self.root,
                                capture_output=True, text=True, env={**os.environ, "COMMITTED_FILE_WARN_MIB": "0.001"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("::warning title=File approaching GitHub's 100 MiB limit::events.json is 0.0 MiB.", result.stdout)

    def test_the_error_is_at_githubs_limit_and_the_warning_at_80_mib(self):
        env = {key: value for key, value in os.environ.items() if key != "COMMITTED_FILE_WARN_MIB"}
        script = (f"import runpy; m = runpy.run_path({str(ROOT / 'tools/check_committed_sizes.py')!r}); "
                  "print(m['WARN_BYTES'], m['LIMIT_BYTES'])")
        result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, env=env, check=True)
        self.assertEqual(result.stdout.split(), [str(80 * 1024 * 1024), str(100 * 1024 * 1024)])


if __name__ == "__main__":
    unittest.main()
