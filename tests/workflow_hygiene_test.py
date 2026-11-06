"""CI gates in front of the scheduled collection, and no workflow left pointing
at a deleted script. Reads the workflow files only; nothing is dispatched."""
import ast
import json
import os
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github/workflows"
COMPOSITE = "./.github/actions/build-events-lite"


def read(name):
    return (WORKFLOWS / name).read_text(encoding="utf-8")


def steps(source):
    return re.split(r"(?m)^      - (?=name: )", source)[1:]


def step_name(step):
    return step.split("\n", 1)[0][len("name: "):].strip()


def trigger_paths(source, event):
    block = source.split("\n  " + event + ":\n", 1)[1]
    block = re.split(r"(?m)^  \S", block, 1)[0]
    return re.findall(r'(?m)^      - "([^"]+)"', block)


def jobs(source):
    parts = re.split(r"(?m)^  ([\w-]+):\n", source.split("\njobs:\n", 1)[1])
    return dict(zip(parts[1::2], parts[2::2]))


def action_source(path):
    return (ROOT / path / "action.yml").read_text(encoding="utf-8")


def run_order(block):
    """The steps of a job or composite as the runner meets them: the unnamed ones
    too, and a local composite's own steps in its place."""
    body = re.split(r"(?m)^ *steps:\n", block, maxsplit=1)[1]
    indent = re.search(r"(?m)^( *)- ", body)[1]
    order = []
    for step in re.split(rf"(?m)^{indent}- ", body)[1:]:
        local = re.search(r"(?m)^ *uses: (\./\S+)", step)
        order += run_order(action_source(local[1])) if local else [step]
    return order


def python_commands(step):
    # Comments do not count: one that matched got python-tests.yml pinned for nothing.
    script = re.split(r"(?m)^ *run: ?", step, maxsplit=1)[1:]
    return [line.strip() for text in script for line in text.splitlines()
            if re.search(r"\bpython3?\s+[-\w./]", line) and not line.lstrip().startswith("#")]


def undeclared_python(source):
    """{job: commands that reach the image's Python where they must not}. That
    Python is allowed on a pinned image, in a job that never sets up another."""
    found = {}
    for name, block in jobs(source).items():
        commands, declared = [], False
        for step in run_order(block):
            if re.search(r"(?m)^ *uses: actions/setup-python@", step):
                declared = True
            elif not declared:
                commands += python_commands(step)
        if commands and (declared or re.search(r"(?m)^    runs-on: ubuntu-latest$", block)):
            found[name] = commands
    return found


def workflow(runner, *job_steps):
    return f"on: push\njobs:\n  check:\n    runs-on: {runner}\n    steps:\n" + \
        "".join(f"      - {step}\n" for step in job_steps)


LOCAL = {**{p.stem: p for p in (ROOT / "tools").glob("*.py")}, **{p.stem: p for p in ROOT.glob("*.py")}}


def local_imports(path):
    """(import-time, mid-run) repository modules a file imports. Importing the
    file loads only the first set; the second is imported inside functions."""
    tree = ast.parse(path.read_text(encoding="utf-8"))

    def names(nodes):
        found = set()
        for node in nodes:
            if isinstance(node, ast.Import):
                found |= {alias.name.split(".")[0] for alias in node.names}
            elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
                found.add(node.module.split(".")[0])
        return found & set(LOCAL)

    top = []
    pending = list(tree.body)
    while pending:
        node = pending.pop()
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        top.append(node)
        for field in ("body", "orelse", "finalbody", "handlers"):
            pending.extend(getattr(node, field, []) or [])
    return names(top), names(ast.walk(tree)) - names(top)


def loaded_by_importing(modules):
    loaded, pending = set(), list(modules)
    while pending:
        name = pending.pop()
        if name not in loaded and name in LOCAL:
            loaded.add(name)
            pending.extend(local_imports(LOCAL[name])[0])
    return loaded


class RunnerImageTests(unittest.TestCase):
    def test_every_workflow_running_the_node_tests_declares_node_24(self):
        # ubuntu-24.04 ships Node 22 and ubuntu-26.04 Node 24, and the image must not
        # choose which Node runs the suite: the same commit passed in one job and
        # failed in another.
        for path in WORKFLOWS.glob("*.yml"):
            source = path.read_text(encoding="utf-8")
            suite = re.search(r"(?m)^[^#\n]*\bnode --test\b", source)
            with self.subTest(workflow=path.name):
                if suite:
                    setup = re.search(r'actions/setup-node@v\d+\s+with:\s+node-version: "24"', source)
                    self.assertIsNotNone(setup)
                    self.assertLess(setup.start(), suite.start())

    def test_no_job_on_the_system_python_rides_the_moving_label(self):
        # During a migration ubuntu-latest changes image job by job: one commit would
        # meet two system python3 versions. A pinned image is fine, but Python run before
        # a later setup, such as the composite's, would give one job two versions.
        for path in WORKFLOWS.glob("*.yml"):
            with self.subTest(workflow=path.name):
                self.assertEqual(undeclared_python(path.read_text(encoding="utf-8")), {})

    def test_the_publication_composite_first_declares_the_python_ci_tests_on(self):
        first = run_order(action_source(COMPOSITE))[0]
        self.assertIn("uses: actions/setup-python@v6", first)
        version = r'python-version: "([\d.]+)"'
        self.assertEqual(re.search(version, first)[1], re.search(version, read("python-tests.yml"))[1])

    def test_a_composite_without_setup_python_fails_the_deploy_jobs(self):
        stripped = re.sub(r"(?s)    - name: Set up Python\n.*?(?=    - name: Build events-lite)", "",
                          action_source(COMPOSITE))
        self.assertNotIn("setup-python", stripped)
        with mock.patch(__name__ + ".action_source", return_value=stripped):
            for name in ("update-map.yml", "cleanup-events.yml", "reconcile-daily-integrity.yml",
                         "repair-map-evidence.yml"):
                with self.subTest(workflow=name):
                    commands = undeclared_python(read(name))["deploy"]
                    self.assertIn("if python3 tools/build_events_lite.py; then", commands)

    def test_the_scan_fails_a_job_on_the_system_python(self):
        setup = "uses: actions/setup-python@v6"
        command = "python3 tools/check.py"
        self.assertEqual(undeclared_python(workflow("ubuntu-latest", "run: " + command)), {"check": [command]})
        self.assertIn("check", undeclared_python(workflow("ubuntu-latest", "run: python -u tools/check.py", setup)))
        self.assertIn("check", undeclared_python(workflow("ubuntu-24.04", "run: " + command, "uses: " + COMPOSITE)))
        # What a scan per file could not see: another job's setup says nothing about this one.
        deploy = f"  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: {command}\n"
        self.assertEqual(undeclared_python(workflow("ubuntu-latest", setup) + deploy), {"deploy": [command]})

    def test_the_scan_accepts_a_declared_python_and_a_pinned_image(self):
        command = "run: python3 tools/check.py"
        for source in (workflow("ubuntu-latest", "uses: actions/setup-python@v6", command),
                       workflow("ubuntu-latest", "uses: " + COMPOSITE, command),
                       workflow("ubuntu-24.04", command),
                       workflow("ubuntu-latest", "run: |\n          # python3 tools/check.py\n          true")):
            with self.subTest(source=source):
                self.assertEqual(undeclared_python(source), {})

    def test_the_worker_deploy_names_the_failing_stage(self):
        names = [step_name(step) for step in steps(read("deploy-report-worker.yml"))]
        for name in ("Validate Worker JavaScript", "Run the Node regression suite",
                     "Run the Python release checks"):
            self.assertLess(names.index(name), names.index("Deploy Worker"))


class PythonTestTriggerTests(unittest.TestCase):
    def test_python_ci_runs_for_every_root_module_json_and_workflow_change(self):
        # collector.py imports daily_pipeline, daily_source_retry,
        # map_evidence_integrity and retired_categories, geolocate.py imports
        # daily_reliability: none of them used to trigger the Python tests.
        source = read("python-tests.yml")
        for event in ("push", "pull_request"):
            with self.subTest(event=event):
                paths = trigger_paths(source, event)
                for glob in ("*.py", "*.json", ".github/workflows/**", ".github/actions/**",
                             "tools/**", "tests/**", "requirements.txt"):
                    self.assertIn(glob, paths)


class CollectionFailFastTests(unittest.TestCase):
    def setUp(self):
        self.source = read("update-map.yml")
        self.steps = steps(self.source.split("\n  update:", 1)[1])
        self.names = [step_name(step) for step in self.steps]

    def smoke(self):
        return self.steps[self.names.index("Check the pipeline modules compile and import")]

    def test_compile_and_import_check_runs_after_the_snapshots_right_before_collection(self):
        # After the data snapshot and the preserve list, before the collection:
        # a module that no longer imports leaves the collection 'skipped', and
        # finalize, the audit and the commit still publish the failed status.
        index = self.names.index("Check the pipeline modules compile and import")
        self.assertEqual(self.names[index - 1], "Record already processed locations before collection")
        self.assertEqual(self.names[index + 1], "Collect multilingual and AI-select CT events")
        smoke = self.smoke()
        # A test subset here would let a flaky test skip a map update.
        self.assertNotIn("pytest", smoke)
        self.assertNotIn("unittest", smoke)
        self.assertNotIn("continue-on-error", smoke)
        self.assertNotIn("if:", smoke)

    def test_every_pipeline_module_is_compiled_and_imported(self):
        smoke = self.smoke()
        compiled = re.search(r"python -m py_compile ([^\n]+)", smoke)[1].split()
        imported = re.search(r'python -c "[^"]*?import ([\w, ]+)"', smoke)[1].replace(" ", "").split(",")
        expected = ["collector.py", "geolocate.py", "daily_pipeline.py", "daily_reliability.py",
                    "daily_source_retry.py", "map_evidence_integrity.py", "retired_categories.py",
                    "attack_points.py", "tools/run_collector_quota_safe.py"]
        self.assertEqual(compiled, expected)
        for path in compiled:
            self.assertTrue((ROOT / path).is_file(), path)
        self.assertEqual(imported, [Path(path).stem for path in compiled])
        loaded = loaded_by_importing(imported)
        for entry in ("collector.py", "geolocate.py", "tools/run_collector_quota_safe.py"):
            with self.subTest(entry=entry):
                missing = local_imports(ROOT / entry)[1] - loaded
                self.assertEqual(missing, set(), "imported mid-run only; add it to the fail-fast import")

    def test_geolocation_step_has_no_branch_for_the_rejected_backfill_mode(self):
        # validate_mode and the collect step reject backfill-new-sources.
        geolocate = self.steps[self.names.index("Gemini geolocation with existing-location protection")]
        self.assertNotIn("backfill-new-sources", geolocate)
        self.assertIn('if [ "$COLLECTION_MODE" = "resume-pending" ]; then', geolocate)
        self.assertEqual(geolocate.count("python -u geolocate.py"), 3)


def job(source, name):
    block = source.split(f"\n  {name}:\n", 1)[1]
    return re.split(r"(?m)^  \S", block, 1)[0]


class CheckpointSurvivalTests(unittest.TestCase):
    """The commit step's real Python block, in a throwaway Git repository."""

    def setUp(self):
        self.source = read("update-map.yml")
        update = job(self.source, "update")
        self.step = next(step for step in steps(update) if step_name(step) == "Commit database and checkpoints safely")
        self.script = textwrap.dedent(self.step.split("python - <<'PY'\n", 1)[1].split("\n          PY\n", 1)[0])
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.refusal = self.root.parent / (self.root.name + "-refusal.txt")
        self.addCleanup(lambda: self.refusal.unlink(missing_ok=True))
        self.git("init", "--quiet")
        self.git("config", "user.email", "test@example.test")
        self.git("config", "user.name", "Test")
        self.write(cache=0, queue=["reviewed", "waiting"], events=[])
        self.git("add", ".")
        self.git("commit", "--quiet", "-m", "Published snapshot")

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True, text=True).stdout

    def write(self, *, cache, queue, events):
        (self.root / "ai_article_selection_cache.json").write_text(json.dumps(
            {"items": {}, "selection_quota_usage": {"calls": cache}}), encoding="utf-8")
        (self.root / "daily_candidate_queue.json").write_text(json.dumps(
            {"version": 1, "events": [{"id": key} for key in queue]}), encoding="utf-8")
        (self.root / "events.json").write_text(json.dumps(
            {"events": [{"id": key} for key in events], "collection_status": {"status": "partial"}}), encoding="utf-8")

    def commit_step(self, *, collect="success", reconcile="success", audit="success", status="success"):
        # After the run: 30 calls spent, "reviewed" published and out of the queue.
        self.write(cache=30, queue=["waiting"], events=["reviewed"])
        result = subprocess.run([sys.executable, "-c", self.script], cwd=self.root, capture_output=True, text=True,
                                env={**os.environ, "COLLECT_OUTCOME": collect, "RECONCILE_OUTCOME": reconcile,
                                     "AUDIT_OUTCOME": audit, "STATUS_OUTCOME": status, "REFUSAL_FILE": str(self.refusal)})
        self.assertEqual(result.returncode, 0, result.stderr)
        return set(self.git("diff", "--cached", "--name-only").split()), \
            self.refusal.read_text(encoding="utf-8") if self.refusal.exists() else None

    def test_a_failed_geolocation_no_longer_skips_reconciliation(self):
        # The implicit success() skipped this step after a geolocation crash, and
        # the commit then refused the run: up to 55 calls of reviews, the queue
        # and the ledger were lost, so the next run overspent the daily cap.
        update = job(self.source, "update")
        step = next(step for step in steps(update) if step_name(step).startswith("Reconcile validated"))
        self.assertIn("if: ${{ !cancelled() && steps.collect.outcome == 'success' }}", step)

    def test_a_run_whose_geolocation_crashed_publishes_like_any_other(self):
        staged, refusal = self.commit_step()
        self.assertIsNone(refusal)
        self.assertEqual(staged, {"ai_article_selection_cache.json", "daily_candidate_queue.json", "events.json"})

    def test_a_refused_publication_keeps_the_ledger_and_the_reviews(self):
        for failure in ({"reconcile": "failure"}, {"reconcile": "skipped"}, {"audit": "failure"}, {"status": "failure"}):
            with self.subTest(failure=failure):
                self.git("reset", "--quiet", "--hard")
                self.refusal.unlink(missing_ok=True)
                staged, refusal = self.commit_step(**failure)
                self.assertTrue(refusal)
                self.assertEqual(staged, {"ai_article_selection_cache.json"},
                                 "this queue lost the reviewed articles the refused database carries")

    def test_a_failed_collection_keeps_its_queue_too(self):
        # Its queue was saved before any review, so nothing can be lost by it.
        staged, refusal = self.commit_step(collect="failure", audit="failure")
        self.assertTrue(refusal)
        self.assertEqual(staged, {"ai_article_selection_cache.json", "daily_candidate_queue.json"})

    def test_the_refused_checkpoint_is_pushed_and_the_step_still_fails(self):
        self.assertIn('git commit -m "Keep the AI checkpoint of a run that could not publish"', self.step)
        self.assertIn("git checkout -- .", self.step, "git rebase refuses a dirty worktree")
        finish = self.step.split("finish() {", 1)[1].split("\n          }\n", 1)[0]
        self.assertIn('[ -s "$REFUSAL_FILE" ]', finish)
        self.assertIn("exit 1", finish)


class AutomaticRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.source = read("update-map.yml")
        self.job = job(self.source, "recovery")

    def test_recovery_follows_the_publication_and_needs_a_pushed_ledger(self):
        self.assertIn("needs: [update, deploy]", self.job)
        self.assertIn("needs.update.outputs.checkpoint_outcome == 'success'", self.job)
        self.assertIn("needs.update.outputs.recovery_wanted == 'true'", self.job)
        self.assertIn("recovery_wanted: ${{ steps.finalize_status.outputs.recovery_wanted }}", job(self.source, "update"))

    def test_only_a_timed_slot_dispatches_so_a_recovery_run_never_chains(self):
        condition = re.search(r"(?m)^    if: (.+)$", self.job).group(1)
        self.assertIn("github.event_name == 'schedule' || (inputs.mode == 'daily' && inputs.slot != '')", condition)
        self.assertNotIn("github.event_name == 'workflow_dispatch'", condition)
        self.assertNotIn("resume-pending", condition)
        self.assertIn("-f mode=resume-pending", self.job)
        self.assertNotIn("-f slot=", self.job, "a slot would make the recovery run look like a timed one")

    def test_only_the_recovery_job_can_write_to_actions(self):
        self.assertEqual(self.source.count("actions: write"), 1)
        self.assertIn("    permissions:\n      actions: write\n", self.job)
        self.assertIn("permissions:\n  actions: read\n", self.source)
        self.assertNotIn("actions/checkout", self.job, "no repository code runs with that permission")


class StarvedRunTests(unittest.TestCase):
    def setUp(self):
        self.source = read("update-map.yml")
        self.job = job(self.source, "health")

    def test_a_starved_run_fails_last_after_everything_is_published(self):
        # On 5 November both runs ended green and GitHub told nobody.
        self.assertIn("needs: [update, deploy, recovery]", self.job)
        self.assertIn("if: ${{ always() && needs.update.outputs.map_health == 'starved' }}", self.job)
        self.assertIn("exit 1", self.job)
        self.assertEqual(self.source.rindex("\n  health:\n") > self.source.rindex("\n  recovery:\n"), True)

    def test_the_gate_runs_no_repository_code_and_holds_no_permission(self):
        self.assertIn("permissions: {}", self.job)
        self.assertNotIn("actions/checkout", self.job)
        self.assertNotIn("secrets.", self.job)
        self.assertIn("SUMMARY: ${{ needs.update.outputs.map_health_summary }}", self.job,
                      "the text reaches the shell through the environment, never into the script")

    def test_a_red_run_still_reaches_the_mirror_through_the_status_refresh(self):
        refresh = read("refresh-daily-status.yml")
        self.assertIn('workflows: ["Daily CT Intelligence Map Update"]', refresh)
        self.assertIn("types: [completed]", refresh, "it runs after any conclusion, red included")
        self.assertIn('[ "$TRIGGER_CONCLUSION" != "success" ]', refresh, "and then republishes main")
        mirror = read("deploy-cloudflare-mirror.yml")
        self.assertIn('- "Refresh daily collection status"', mirror)


class SelectionCapacityTests(unittest.TestCase):
    def setUp(self):
        self.source = read("update-map.yml")

    def value(self, name):
        return int(re.search(rf'(?m)^          {name}: "(\d+)"$', self.source).group(1))

    def test_one_run_can_clear_a_backlog_like_that_of_5_november(self):
        # About 2,500 reviews a day met about 2,600 arrivals, and 2,616 waiting
        # articles took 4 to 6 runs to clear.
        per_run = self.value("AI_SELECTION_MAX_CALLS_PER_RUN") + self.value("AI_SELECTION_OVERFLOW_MAX_CALLS_PER_RUN")
        self.assertEqual((self.value("AI_SELECTION_BATCH_SIZE"), per_run), (40, 85))
        self.assertGreater(per_run * self.value("AI_SELECTION_BATCH_SIZE"), 2616)

    def test_the_wrapper_accepts_the_batch_size_as_set(self):
        wrapper = (ROOT / "tools/run_collector_quota_safe.py").read_text(encoding="utf-8")
        self.assertIn('BATCH=max(1,min(40,int(os.getenv("AI_SELECTION_BATCH_SIZE","25"))))', wrapper)

    def test_each_timed_slot_keeps_its_whole_reservation(self):
        for run, day in (("AI_SELECTION_MAX_CALLS_PER_RUN", "AI_SELECTION_DAILY_CALL_BUDGET"),
                         ("AI_SELECTION_OVERFLOW_MAX_CALLS_PER_RUN", "AI_SELECTION_OVERFLOW_DAILY_CALL_BUDGET")):
            self.assertEqual(self.value(day), 2 * self.value(run))

    def test_background_use_of_31_flash_lite_stays_under_the_contract(self):
        # The owner's contract keeps it under 400 a day; enrichment's 100 are gone.
        self.assertFalse((WORKFLOWS / "enrich-archive.yml").exists())
        archive = int(re.search(r'ARCHIVE_REVIEW_DAILY_CALLS: "(\d+)"', read("review-archive-backlog.yml")).group(1))
        radnuc = int(re.search(r'ARCHIVE_REVIEW_DAILY_CALLS: "(\d+)"', read("daily-radnuc-background.yml")).group(1))
        consolidation = 120
        geolocation_fallback = 3 * 12  # two slots and a recovery run, at most the whole cap each
        total = archive + radnuc + consolidation + self.value("AI_SELECTION_OVERFLOW_DAILY_CALL_BUDGET") + geolocation_fallback
        self.assertLess(total, 400)

    def test_older_work_stays_a_share_of_the_run_not_of_the_reservation(self):
        self.assertEqual(self.value("AI_SELECTION_HISTORICAL_MAX_CALLS_PER_RUN"), 20)
        self.assertLess(self.value("AI_SELECTION_HISTORICAL_MAX_CALLS_PER_RUN"),
                        self.value("AI_SELECTION_MAX_CALLS_PER_RUN") + self.value("AI_SELECTION_OVERFLOW_MAX_CALLS_PER_RUN"))


class CollectionDispatchTests(unittest.TestCase):
    def test_daily_rejects_historical_dispatch_before_setup_and_accepts_daily_recovery(self):
        workflow = read("update-map.yml")
        validation = workflow.split("  validate_mode:", 1)[1].split("\n  update:", 1)[0]
        update = workflow.split("\n  update:", 1)[1]
        self.assertIn("needs: validate_mode", update)
        self.assertNotIn("secrets.", validation)
        self.assertNotIn("actions/checkout", validation)
        self.assertNotIn("pip install", validation)
        self.assertIn('cron: "17 10 * * *"', workflow)
        self.assertIn('cron: "17 18 * * *"', workflow)
        options = workflow.split("        options:\n", 1)[1].split("      force_ai:", 1)[0]
        self.assertEqual([line.strip()[2:] for line in options.splitlines() if line.strip()],
                         ["daily", "resume-pending"])
        script = textwrap.dedent(validation.split("        run: |\n", 1)[1])
        for mode, accepted in (("daily", True), ("resume-pending", True),
                               ("backfill", False), ("backfill-new-sources", False),
                               ("unknown-mode", False)):
            with self.subTest(mode=mode):
                result = subprocess.run(["bash", "-c", script],
                                        env={**os.environ, "COLLECTION_MODE": mode},
                                        capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode == 0, accepted, result.stdout + result.stderr)

    def test_empty_review_queue_has_no_schedule(self):
        # The review queue has been empty since 2026-10-05: its daily run was
        # a no-op in the RadNuc job's concurrency group, so it is manual only.
        review = read("review-archive-backlog.yml")
        self.assertNotIn("  schedule:", review)
        self.assertNotIn("cron:", review)
        self.assertIn("  workflow_dispatch:", review)
        self.assertIn("tools/review_pending_archive.py", review)


class WorkflowScriptReferenceTests(unittest.TestCase):
    def test_every_script_a_workflow_runs_exists(self):
        # Obsolete one-off workflows were deleted with their scripts on
        # 2026-11-04; no remaining workflow may point at a removed file.
        missing = []
        for path in sorted(WORKFLOWS.glob("*.yml")):
            for script in re.findall(r"\bpython3? (?:-u )?((?:tools|experiments)/[\w/.-]+\.py)\b",
                                     path.read_text(encoding="utf-8")):
                if not (ROOT / script).is_file():
                    missing.append(f"{path.name}: {script}")
        self.assertEqual(missing, [])

    def test_obsolete_one_off_workflows_stay_removed(self):
        for name in ("repair-source-geolocation.yml", "chinese-backfill-feed-smoke.yml",
                     "apply-ct-atlas-label-cleanup.yml", "apply-deep-search-all-languages.yml",
                     "groq-free-backfill.yml", "enrich-radnuc.yml", "enrich-chinese-gemini.yml",
                     "enrich-archive.yml", "backfill-gdelt-acled.yml", "backfill-actor-group.yml",
                     "recategorize-ct-action.yml", "backfill-record-integrity.yml"):
            self.assertFalse((WORKFLOWS / name).exists(), name)


if __name__ == "__main__":
    unittest.main()
