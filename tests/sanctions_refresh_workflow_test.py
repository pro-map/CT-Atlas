"""The OFAC refresh workflow: its schedule, its lock, the only writer of
sanctions-crypto.json, a loud failure and a quiet unchanged list.

On 2026-11-06 OFAC published at 19:33 UTC; the list was refreshed only by the
map update's morning slot, so ct-atlas.com served the 11-05 list into the next
day. The shell steps run here against stubs; nothing reaches the network.
"""
import os
import re
import subprocess
import tempfile
import textwrap
import unittest
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github/workflows"
NAME = "refresh-sanctions.yml"
SOURCE = (WORKFLOWS / NAME).read_text(encoding="utf-8")
DISPATCHER = (ROOT / "cloudflare-worker/schedule-dispatcher.js").read_text(encoding="utf-8")


def job(name):
    block = SOURCE.split(f"\n  {name}:\n", 1)[1]
    return re.split(r"(?m)^  \S", block, maxsplit=1)[0]


def step(name):
    found = [text for text in re.split(r"(?m)^      - ", SOURCE)[1:] if text.startswith(f"name: {name}\n")]
    if len(found) != 1:
        raise AssertionError(f"Expected one step named {name!r}, found {len(found)}")
    return found[0]


def script(name):
    """The run: | block of a step, as the runner's bash receives it."""
    lines = []
    for line in step(name).split("        run: |\n", 1)[1].splitlines():
        if line.strip() and not line.startswith("          "):
            break
        lines.append(line)
    return textwrap.dedent("\n".join(lines)) + "\n"


def bash(text, cwd, env=None, stubs=""):
    """Runs a step's script after shell functions that stand in for its commands."""
    return subprocess.run(["bash", "-c", stubs + "\n" + text], cwd=cwd, capture_output=True, text=True,
                          env={**os.environ, **(env or {})}, check=False)


def cron_hours(field):
    hours = set()
    for part in field.split(","):
        if part == "*":
            return set(range(24))
        start, _, end = part.partition("-")
        hours.update(range(int(start), int(end or start) + 1))
    return hours


class ScheduleTests(unittest.TestCase):
    def paris_slots(self):
        triggers = SOURCE.split("\non:\n", 1)[1].split("\npermissions:", 1)[0]
        self.assertIn("  workflow_dispatch:", triggers)
        crons = re.findall(r'(?m)^    - cron: "([^"]+)"\n      timezone: "Europe/Paris"$', triggers)
        self.assertEqual(len(crons), triggers.count("- cron:"), "every slot is a Paris time, like the dispatcher's")
        slots = set()
        for cron in crons:
            minute, hours, *days = cron.split()
            self.assertEqual(days, ["*", "*", "*"], "every day")
            slots.update((hour, int(minute)) for hour in cron_hours(hours))
        return slots

    def test_it_runs_several_times_a_day_and_after_the_us_afternoon_in_both_seasons(self):
        slots = self.paris_slots()
        self.assertGreaterEqual(len(slots), 4)
        for day in ("2026-11-06", "2027-07-06"):
            with self.subTest(day=day):
                utc = sorted(datetime.fromisoformat(f"{day}T{hour:02d}:{minute:02d}")
                             .replace(tzinfo=ZoneInfo("Europe/Paris")).astimezone(timezone.utc)
                             for hour, minute in slots)
                self.assertTrue([time for time in utc if time.hour >= 20], "OFAC published at 19:33 UTC on 2026-11-06")
                minutes = [time.hour * 60 + time.minute for time in utc]
                gaps = [(later - earlier) % 1440 for earlier, later in zip(minutes, minutes[1:] + minutes[:1])]
                self.assertLessEqual(max(gaps), 8 * 60, "a new list never waits most of a day")

    def test_the_dispatcher_can_start_every_slot_on_time(self):
        # GitHub's own schedule starts this repository's runs 3-10 hours late and
        # never creates some; the dispatcher starts the same slots on time.
        dispatched = {(int(hour), int(minute)) for hour, minute in re.findall(
            r'\{ workflow: "refresh-sanctions\.yml", hour: (\d+), minute: (\d+) \}', DISPATCHER)}
        self.assertEqual(dispatched, self.paris_slots())


class LockTests(unittest.TestCase):
    def test_it_holds_the_data_update_lock_from_checkout_through_deployment(self):
        block = SOURCE.split("\nconcurrency:\n", 1)[1].split("\n\n", 1)[0]
        lines = [line.strip() for line in block.splitlines() if not line.strip().startswith("#")]
        self.assertEqual(lines, ["group: ct-map-update-main", "cancel-in-progress: false", "queue: max"])
        self.assertEqual(SOURCE.count("concurrency:"), 1, "no job may leave the workflow's lock")

    def test_the_deploy_publishes_the_pushed_commit_and_the_mirror_does_not_redeploy_for_it(self):
        deploy = job("deploy")
        self.assertIn("needs: refresh", deploy)
        self.assertIn("if: ${{ needs.refresh.outputs.pages == 'true' }}", deploy)
        self.assertIn("ref: ${{ needs.refresh.outputs.data_sha }}", deploy)
        self.assertIn("uses: ./.github/actions/build-events-lite", deploy)
        self.assertIn("uses: actions/deploy-pages@", deploy)
        # The mirror does not stage the list, and the Worker reads it from ct-atlas.com.
        mirror = (WORKFLOWS / "deploy-cloudflare-mirror.yml").read_text(encoding="utf-8")
        self.assertNotIn('      - "Refresh OFAC sanctions list"\n', mirror)
        self.assertNotIn("sanctions-crypto.json", (ROOT / "tools/deploy_mirror.sh").read_text(encoding="utf-8"))
        self.assertIn('SANCTIONS_URL = "https://ct-atlas.com/sanctions-crypto.json"',
                      (ROOT / "cloudflare-worker/wrangler.toml").read_text(encoding="utf-8"))
        self.assertIn("name: Refresh OFAC sanctions list\n", SOURCE)

    def test_the_deploy_checks_that_pages_serves_the_committed_list(self):
        verify = script("Verify the list actually served by GitHub Pages")
        self.assertIn('sha256sum < sanctions-crypto.json', verify)
        self.assertIn('"${PAGE_URL%/}/sanctions-crypto.json?integrity=', verify)
        self.assertIn("::error title=OFAC list not published::", verify)


class SingleWriterTests(unittest.TestCase):
    def test_no_other_workflow_writes_or_stages_the_list(self):
        # The map update used to refresh it too, and its refusal path dropped
        # the new list before staging it.
        sources = {path.name: path.read_text(encoding="utf-8") for path in WORKFLOWS.glob("*.yml") if path.name != NAME}
        sources.update({str(path.relative_to(ROOT)): path.read_text(encoding="utf-8")
                        for path in (ROOT / ".github/actions").rglob("*.yml")})
        self.assertIn("update-map.yml", sources)
        for name, text in sources.items():
            with self.subTest(workflow=name):
                # A path that triggers a workflow, or a comment, writes nothing.
                code = "\n".join(line for line in text.splitlines()
                                 if not re.fullmatch(r'\s*(?:#.*|- "sanctions-crypto\.json")', line))
                self.assertNotIn("tools/update_sanctions.py", code)
                self.assertNotIn("sanctions-crypto.json", code)

    def test_this_workflow_commits_the_list_and_nothing_else(self):
        self.assertEqual(re.findall(r"git add[^\n]*", SOURCE), ["git add -- sanctions-crypto.json"])
        self.assertEqual(SOURCE.count("python -u tools/update_sanctions.py"), 1)


class LoudFailureTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.temp = folder.name

    def refresh(self, stub):
        return bash(script("Refresh the OFAC list"), ROOT, {"RUNNER_TEMP": Path(self.temp).as_posix()}, stubs=stub)

    def test_nothing_in_the_workflow_may_fail_quietly(self):
        self.assertNotIn("continue-on-error", SOURCE)

    def test_a_refused_refresh_fails_the_run_and_names_its_reason(self):
        refusal = ("Refusing to overwrite: new list has 3 addresses vs 1058 before (below 60% retention) "
                   "-- likely a truncated or changed source.")
        result = self.refresh(f"python() {{ echo 'An earlier line' >&2; echo '{refusal}' >&2; return 1; }}")
        self.assertEqual(result.returncode, 1)
        self.assertIn(f"::error title=OFAC refresh failed::{refusal}\n", result.stdout)
        self.assertIn("An earlier line", result.stderr, "the whole message stays in the log")

    def test_a_refresh_that_dies_silently_still_fails_with_a_named_error(self):
        result = self.refresh("python() { return 1; }")
        self.assertEqual(result.returncode, 1)
        self.assertIn("::error title=OFAC refresh failed::tools/update_sanctions.py failed without saying why",
                      result.stdout)

    def test_a_failing_updater_test_blocks_the_refresh_with_a_named_error(self):
        result = bash(script("Validate the updater"), ROOT, stubs="python() { return 1; }")
        self.assertEqual(result.returncode, 1)
        self.assertIn("::error title=OFAC refresh failed::", result.stdout)

    def test_a_push_that_never_lands_fails_with_a_named_error(self):
        repo = Path(self.temp) / "work"
        subprocess.run(["git", "init", "--quiet", str(repo)], check=True)
        for key, value in (("user.email", "test@example.test"), ("user.name", "Test")):
            subprocess.run(["git", "config", key, value], cwd=repo, check=True)
        (repo / "sanctions-crypto.json").write_text("{}\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=repo, check=True)
        subprocess.run(["git", "commit", "--quiet", "-m", "list"], cwd=repo, check=True)
        subprocess.run(["git", "remote", "add", "origin", str(Path(self.temp) / "missing.git")], cwd=repo, check=True)
        (repo / "sanctions-crypto.json").write_text('{"new":1}\n', encoding="utf-8")
        output = Path(self.temp) / "output.txt"
        result = bash(script("Commit the new list"), repo, {"GITHUB_OUTPUT": output.as_posix()}, stubs="sleep() { :; }")
        self.assertEqual(result.returncode, 1)
        self.assertIn("::error title=OFAC list not published::", result.stdout)
        self.assertNotIn("changed=true", output.read_text(encoding="utf-8") if output.exists() else "")

    def test_a_failed_deploy_is_named_too(self):
        failed = step("Name the failed publication")
        self.assertIn("if: failure()", failed)
        self.assertIn("::error title=OFAC list not published::", failed)
        self.assertGreater(SOURCE.index("name: Name the failed publication"), SOURCE.index("name: Deploy GitHub Pages"))


class QuietUnchangedTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.temp = Path(folder.name)
        self.origin = self.temp / "origin.git"
        self.repo = self.temp / "work"
        subprocess.run(["git", "init", "--quiet", "--bare", "--initial-branch=main", str(self.origin)], check=True)
        subprocess.run(["git", "clone", "--quiet", str(self.origin), str(self.repo)], check=True, capture_output=True)
        self.git("symbolic-ref", "HEAD", "refs/heads/main")
        self.git("config", "user.email", "test@example.test")
        self.git("config", "user.name", "Test")
        (self.repo / "sanctions-crypto.json").write_text('{"addresses":[]}\n', encoding="utf-8")
        self.git("add", ".")
        self.git("commit", "--quiet", "-m", "Published list")
        self.git("push", "--quiet", "origin", "main")
        self.output = self.temp / "github-output.txt"
        self.output.write_text("", encoding="utf-8")

    def git(self, *args, cwd=None):
        return subprocess.run(["git", *args], cwd=cwd or self.repo, check=True, capture_output=True, text=True).stdout

    def run_step(self, name, env=None, stubs=""):
        result = bash(script(name), self.repo, {"GITHUB_OUTPUT": self.output.as_posix(), **(env or {})}, stubs=stubs)
        return result, self.output.read_text(encoding="utf-8")

    def test_an_unchanged_refresh_says_so_and_raises_nothing(self):
        result = bash(script("Refresh the OFAC list"), ROOT, {"RUNNER_TEMP": self.temp.as_posix()},
                      stubs="python() { echo \"Unchanged: OFAC's list is still the one of Fri, 06 Nov 2026 19:33:11 GMT\"; }")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("::", result.stdout + result.stderr)

    def test_an_unchanged_list_makes_no_commit(self):
        head = self.git("rev-parse", "HEAD").strip()
        result, output = self.run_step("Commit the new list")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("changed=true", output)
        self.assertIn(f"data_sha={head}\n", output)
        self.assertEqual(self.git("rev-parse", "HEAD").strip(), head)
        self.assertNotIn("::", result.stdout + result.stderr)

    def test_a_new_list_is_pushed_alone_and_reported_after_the_push(self):
        (self.repo / "sanctions-crypto.json").write_text('{"addresses":["T1"]}\n', encoding="utf-8")
        (self.repo / "unrelated.txt").write_text("not mine\n", encoding="utf-8")
        result, output = self.run_step("Commit the new list")
        self.assertEqual(result.returncode, 0, result.stderr)
        pushed = self.git("rev-parse", "main", cwd=self.origin).strip()
        self.assertIn("changed=true\n", output)
        self.assertIn(f"data_sha={pushed}\n", output)
        self.assertEqual(self.git("show", "--name-only", "--format=", pushed, cwd=self.origin).split(),
                         ["sanctions-crypto.json"])

    def decide(self, served=None, changed="", event="schedule", slot=""):
        served_file = self.temp / "served.json"
        if served is not None:
            served_file.write_bytes(served)
        curl = f'curl() {{ cat "{served_file.as_posix()}"; }}' if served is not None else "curl() { return 22; }"
        return self.run_step("Decide whether GitHub Pages needs the list",
                             {"CHANGED": changed, "EVENT": event, "SLOT": slot}, curl)

    def test_a_list_pages_already_serves_is_not_redeployed(self):
        # A dispatched slot is a timed run: otherwise each one would deploy Pages and the mirror.
        current = (self.repo / "sanctions-crypto.json").read_bytes()
        for name, case in {"scheduled run": {},
                           "dispatched slot": {"event": "workflow_dispatch", "slot": "47 22 * * *"}}.items():
            with self.subTest(case=name):
                self.output.write_text("", encoding="utf-8")
                result, output = self.decide(served=current, **case)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn("pages=true", output)
                self.assertNotIn("::", result.stdout + result.stderr)

    def test_a_new_list_a_manual_run_or_an_unpublished_list_deploys(self):
        current = (self.repo / "sanctions-crypto.json").read_bytes()
        cases = {
            "pushed just now": {"served": current, "changed": "true"},
            "manual run": {"served": current, "event": "workflow_dispatch"},
            "an earlier deploy failed": {"served": b'{"addresses":["old"]}\n'},
            "an earlier deploy failed, seen by a dispatched slot":
                {"served": b'{"addresses":["old"]}\n', "event": "workflow_dispatch", "slot": "47 22 * * *"},
            "ct-atlas.com unreachable": {},
        }
        for name, case in cases.items():
            with self.subTest(case=name):
                self.output.write_text("", encoding="utf-8")
                result, output = self.decide(**case)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("pages=true\n", output)


if __name__ == "__main__":
    unittest.main()
