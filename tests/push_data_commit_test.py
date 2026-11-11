"""tools/push_data_commit.sh against real Git repositories: a bare repository
stands for GitHub and two clones for two writers. Nothing reaches the network,
and the script's sleeps are recorded instead of slept. Then the workflows that
commit data, which must all push through it."""
import json
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "tools/push_data_commit.sh"
WORKFLOWS = ROOT / ".github/workflows"
# Records each pause instead of waiting, in the bash that runs the script.
RUN = 'sleep() { echo "$1" >> "$SLEEP_LOG"; }; export -f sleep; exec bash "$0"'
# The other writer pushes once, after the script's fetch and before its push.
# Not a pre-push hook: its push runs nested inside the script's, and that hung on Windows.
RACE = ('git() { if [ "$1" = push ] && [ ! -e "$RACE_FLAG" ]; then : > "$RACE_FLAG"; '
        'command git -C "$OTHER" push --quiet origin HEAD:main; fi; command git "$@"; }; export -f git; ')
DATA_WORKFLOWS = {
    "update-map.yml", "refresh-daily-status.yml", "consolidate-incidents.yml", "cleanup-events.yml",
    "repair-map-evidence.yml", "reconcile-daily-integrity.yml", "retire-judicial.yml", "refresh-sanctions.yml",
    "review-archive-backlog.yml", "daily-radnuc-background.yml",
}
# They commit index.html, code rather than data.
CODE_WORKFLOWS = {"refresh-logo-only.yml"}


def git(*args, cwd):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def database(*events):
    """events.json as every writer formats it, from (id, title) pairs."""
    value = {"last_updated": "2026-11-07T00:00:00+00:00", "number_of_events": len(events),
             "events": [{"id": key, "title": title} for key, title in events]}
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


SEED = [(key, f"Event {key}") for key in "abcde"]


class PushDataCommitTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.temp = Path(folder.name)
        self.remote = self.temp / "remote.git"
        self.sleeps = self.temp / "sleeps.txt"
        git("init", "--quiet", "--bare", "--initial-branch=main", str(self.remote), cwd=self.temp)
        seed = self.clone("seed")
        self.commit(seed, {"events.json": database(*SEED), "sanctions-crypto.json": "{}\n"}, "Seed")
        git("push", "--quiet", "origin", "HEAD:main", cwd=seed)
        self.writer = self.clone("writer")
        self.other = self.clone("other")

    def clone(self, name):
        path = self.temp / name
        git("clone", "--quiet", str(self.remote), str(path), cwd=self.temp)
        git("config", "user.email", "test@example.test", cwd=path)
        git("config", "user.name", "Test", cwd=path)
        return path

    def commit(self, repo, files, message):
        for name, text in files.items():
            if text is None:
                (repo / name).unlink()
            else:
                (repo / name).write_text(text, encoding="utf-8", newline="\n")
        git("add", "-A", cwd=repo)
        git("commit", "--quiet", "-m", message, cwd=repo)
        return git("rev-parse", "HEAD", cwd=repo)

    def hook(self, repo, name, body):
        hooks = self.temp / f"{repo.name}-hooks"
        hooks.mkdir(exist_ok=True)
        (hooks / name).write_text("#!/bin/sh\n" + body, encoding="utf-8", newline="\n")
        # Git on Linux skips a hook that is not executable.
        (hooks / name).chmod(0o755)
        git("config", "core.hooksPath", hooks.as_posix(), cwd=repo)

    def push(self, repo, stubs="", **env):
        return subprocess.run(["bash", "-c", stubs + RUN, SCRIPT.as_posix()], cwd=repo, capture_output=True, text=True,
                              env={**os.environ, "SLEEP_LOG": self.sleeps.as_posix(), **env}, timeout=600)

    def remote_main(self):
        return git("rev-parse", "main", cwd=self.remote)

    def recorded_sleeps(self):
        return [int(line) for line in self.sleeps.read_text().split()] if self.sleeps.exists() else []

    def test_a_clean_commit_is_pushed(self):
        head = self.commit(self.writer, {"events.json": database(*SEED, ("f", "Event f"))}, "Add f")
        result = self.push(self.writer)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.remote_main(), head)
        self.assertEqual(self.recorded_sleeps(), [])

    def test_a_commit_behind_main_is_rebased_onto_it_and_pushed(self):
        edited = [(key, "Event c, corrected" if key == "c" else title) for key, title in SEED]
        theirs = self.commit(self.other, {"events.json": database(*edited)}, "Correct c")
        git("push", "--quiet", "origin", "HEAD:main", cwd=self.other)
        self.commit(self.writer, {"events.json": database(*SEED, ("f", "Event f"))}, "Add f")
        result = self.push(self.writer)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(git("rev-parse", "main^", cwd=self.remote), theirs)
        self.assertEqual(git("show", "main:events.json", cwd=self.remote) + "\n",
                         database(*edited, ("f", "Event f")))

    def test_a_push_that_loses_the_race_after_its_fetch_is_tried_again(self):
        edited = [(key, "Event c, corrected" if key == "c" else title) for key, title in SEED]
        theirs = self.commit(self.other, {"events.json": database(*edited)}, "Correct c")
        flag = self.temp / "raced"
        self.commit(self.writer, {"events.json": database(*SEED, ("f", "Event f"))}, "Add f")
        result = self.push(self.writer, RACE, RACE_FLAG=flag.as_posix(), OTHER=self.other.as_posix())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(flag.exists())
        self.assertIn("Try 1 to push to main failed", result.stderr)
        self.assertEqual(self.recorded_sleeps(), [4])
        self.assertEqual(git("rev-parse", "main^", cwd=self.remote), theirs)
        self.assertEqual(git("show", "main:events.json", cwd=self.remote) + "\n",
                         database(*edited, ("f", "Event f")))

    def test_a_conflict_aborts_the_rebase_and_pushes_nothing(self):
        theirs = self.commit(self.other, {"events.json": database(
            *[(key, "Event c, by them" if key == "c" else title) for key, title in SEED])}, "Their c")
        git("push", "--quiet", "origin", "HEAD:main", cwd=self.other)
        ours = self.commit(self.writer, {"events.json": database(
            *[(key, "Event c, by us" if key == "c" else title) for key, title in SEED])}, "Our c")
        result = self.push(self.writer)
        self.assertEqual(result.returncode, 1)
        self.assertIn("does not rebase onto main", result.stderr)
        self.assertEqual(self.remote_main(), theirs)
        self.assertEqual(git("rev-parse", "HEAD", cwd=self.writer), ours)
        self.assertEqual(git("status", "--porcelain", cwd=self.writer), "", "the rebase was aborted")
        self.assertEqual(self.recorded_sleeps(), [], "a conflict is not tried again")

    def test_a_clean_rebase_that_duplicates_an_id_pushes_nothing(self):
        # Two edits far apart in the text merge without a conflict, into two "x".
        theirs = self.commit(self.other, {"events.json": database(("x", "Event x"), *SEED[1:])}, "a becomes x")
        git("push", "--quiet", "origin", "HEAD:main", cwd=self.other)
        self.commit(self.writer, {"events.json": database(*SEED[:-1], ("x", "Event x"))}, "e becomes x")
        result = self.push(self.writer)
        self.assertEqual(result.returncode, 1)
        self.assertIn("holds the id x twice after the rebase", result.stderr)
        self.assertEqual(self.remote_main(), theirs)
        self.assertEqual(self.recorded_sleeps(), [])

    def test_a_database_that_fails_the_check_after_the_rebase_is_not_pushed(self):
        seed = self.remote_main()
        cases = {
            "truncated": ('{\n  "events": [\n', "no longer parses after the rebase"),
            "deleted": (None, "missing from the rebased commit"),
            "not a database": ('{"events": {}}\n', "no events list"),
            "an event without an id": (database(*SEED).replace('"id": "c"', '"id": ""'), "without an id"),
        }
        for name, (text, reason) in cases.items():
            with self.subTest(case=name):
                git("reset", "--quiet", "--hard", "origin/main", cwd=self.writer)
                self.commit(self.writer, {"events.json": text}, name)
                result = self.push(self.writer)
                self.assertEqual(result.returncode, 1)
                self.assertIn(reason, result.stderr)
                self.assertEqual(self.remote_main(), seed)

    def test_a_commit_that_leaves_events_json_alone_does_not_answer_for_it(self):
        # Only a commit that changes events.json can break it: the OFAC refresh
        # is not held back by a database it never touched.
        self.commit(self.other, {"events.json": "{\n"}, "Broken by hand")
        git("push", "--quiet", "origin", "HEAD:main", cwd=self.other)
        head = self.commit(self.writer, {"sanctions-crypto.json": '{"addresses": ["T1"]}\n'}, "New list")
        result = self.push(self.writer)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(git("show", "--name-only", "--format=", "main", cwd=self.remote), "sanctions-crypto.json")
        self.assertNotEqual(self.remote_main(), head, "rebased onto the newer main")

    def test_five_refused_pushes_give_up_with_nothing_pushed(self):
        seed = self.remote_main()
        attempts = self.temp / "attempts.txt"
        self.hook(self.remote, "pre-receive", f'echo refused >> "{attempts.as_posix()}"\nexit 1\n')
        self.commit(self.writer, {"events.json": database(*SEED, ("f", "Event f"))}, "Add f")
        result = self.push(self.writer)
        self.assertEqual(result.returncode, 1)
        self.assertIn("failed 5 times", result.stderr)
        self.assertEqual(attempts.read_text().split(), ["refused"] * 5)
        self.assertEqual(self.recorded_sleeps(), [4, 8, 12, 16])
        self.assertEqual(self.remote_main(), seed)

    def test_an_unreachable_remote_is_tried_five_times(self):
        git("remote", "set-url", "origin", str(self.temp / "missing.git"), cwd=self.writer)
        self.commit(self.writer, {"events.json": database(*SEED, ("f", "Event f"))}, "Add f")
        result = self.push(self.writer)
        self.assertEqual(result.returncode, 1)
        self.assertIn("failed 5 times", result.stderr)
        self.assertEqual(self.recorded_sleeps(), [4, 8, 12, 16])


class DataWorkflowTests(unittest.TestCase):
    def commit_steps(self, name):
        steps = re.split(r"(?m)^      - ", (WORKFLOWS / name).read_text(encoding="utf-8"))[1:]
        return [step for step in steps if "git commit" in step]

    def test_every_data_commit_is_pushed_by_the_script_alone(self):
        # Repair and reconcile pushed once, and retire tried 3 times without a pause.
        committing = {path.name for path in WORKFLOWS.glob("*.yml") if "git commit" in path.read_text(encoding="utf-8")}
        self.assertEqual(committing - CODE_WORKFLOWS, DATA_WORKFLOWS)
        for name in sorted(DATA_WORKFLOWS):
            with self.subTest(workflow=name):
                self.assertNotRegex((WORKFLOWS / name).read_text(encoding="utf-8"), r"\bgit (?:fetch|rebase|push)\b")
                [step] = self.commit_steps(name)
                self.assertLess(step.rindex("git commit"), step.index("bash tools/push_data_commit.sh"))

    def test_staged_sizes_are_checked_before_every_data_commit(self):
        for name in sorted(DATA_WORKFLOWS):
            for step in self.commit_steps(name):
                for commit in re.finditer(r"git commit", step):
                    with self.subTest(workflow=name, at=commit.start()):
                        check = step.rfind("python3 tools/check_committed_sizes.py", 0, commit.start())
                        self.assertGreater(check, step.rfind("git add", 0, commit.start()),
                                           "measured once everything is staged")


if __name__ == "__main__":
    unittest.main()
