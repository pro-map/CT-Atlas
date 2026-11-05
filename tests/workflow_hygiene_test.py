"""CI gates in front of the scheduled collection, and no workflow left pointing
at a deleted script. Reads the workflow files only; nothing is dispatched."""
import ast
import os
import re
import subprocess
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github/workflows"


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
                             "tools/**", "tests/**", "darkweb-collector/**", "requirements.txt"):
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
