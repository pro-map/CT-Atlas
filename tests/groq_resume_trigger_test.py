"""Offline regressions for cancelled history and preserved daily/maintenance work.

No workflow is dispatched and no source/model/credential is accessed here.
"""
from pathlib import Path
import ast
import os
import subprocess
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[1]


class GroqResumeTriggerTest(unittest.TestCase):
    def test_legacy_resume_allocation_remains_bounded_and_maintenance_push_is_scoped(self):
        text = (ROOT / ".github/workflows/groq-free-backfill.yml").read_text()
        for name, argument, limit in (("SPECIALIST_POSTS_INPUT", "specialist_posts", 5),):
            expected = (name + ": ${{ github.event_name == 'push' && "
                        "!startsWith(github.event.head_commit.message, '[resume-groq-history]') "
                        "&& '0' || inputs." + argument + " || '" + str(limit) + "' }}")
            self.assertIn(expected, text)
        self.assertNotIn("CHINESE_POSTS_INPUT", text)
        self.assertNotIn("inputs.chinese_posts", text)
        self.assertNotIn("id: chinese", text)
        push = text.split("  push:", 1)[1].split("  workflow_dispatch:", 1)[0]
        self.assertIn("branches: [main]", push)
        self.assertIn("paths:\n      - .github/workflows/groq-free-backfill.yml", push)
        self.assertNotIn("pull_request", text)

    def test_cancelled_history_has_no_schedule_and_retains_publication_guards(self):
        text = (ROOT / ".github/workflows/groq-free-backfill.yml").read_text()
        self.assertNotIn("  schedule:", text)
        self.assertIn("(cancelled)", text.splitlines()[0])
        for required in ("group: ct-map-update-main", "cancel-in-progress: false",
                         '(("SPECIALIST_POSTS_INPUT",5),)',
                         "backfill_publication_guard.py finalize",
                         "backfill_publication_guard.py verify",
                         "needs.backfill.outputs.publication_ready == 'true'",
                         "steps.checkpoint.outputs.publication_ready != 'true'"):
            self.assertIn(required, text)
        self.assertNotIn("repository_dispatch", text)

    def test_general_archive_history_has_no_schedule_but_existing_review_still_does(self):
        history = (ROOT / ".github/workflows/enrich-archive.yml").read_text()
        review = (ROOT / ".github/workflows/review-archive-backlog.yml").read_text()
        self.assertNotIn("  schedule:", history)
        self.assertIn("  workflow_dispatch:", history)
        self.assertIn("(cancelled)", history.splitlines()[0])
        self.assertIn("  schedule:", review)
        self.assertIn("tools/review_pending_archive.py", review)

    def test_daily_rejects_historical_dispatch_before_setup_and_accepts_daily_recovery(self):
        workflow = (ROOT / ".github/workflows/update-map.yml").read_text()
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

    def test_authorized_caps_have_one_source_and_model_pacing_stay_unchanged(self):
        tree = ast.parse((ROOT / "tools/groq_backfill.py").read_text())
        assignments = {target.id: node.value for node in tree.body if isinstance(node, ast.Assign)
                       for target in node.targets if isinstance(target, ast.Name)}
        runtime_tree = ast.parse((ROOT / "tools/groq_backfill_runtime.py").read_text())
        runtime_constants = {target.id: node.value.value for node in runtime_tree.body
                             if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant)
                             for target in node.targets if isinstance(target, ast.Name)}
        for name, shared_name, expected in (("MAX_POSTS_PER_UTC_DAY", "REQUEST_CAP", 32),
                                           ("MAX_RESERVED_TOKENS_PER_UTC_DAY", "RESERVED_TOKEN_CAP", 160000)):
            self.assertEqual(ast.unparse(assignments[name]), "history_runtime." + shared_name)
            self.assertEqual(runtime_constants[shared_name], expected)
        for name, expected in (("BATCH_SIZE", 3), ("MIN_INTERVAL_SECONDS", 72),
                               ("REQUEST_TPM_BUDGET", 7000), ("MODEL", "openai/gpt-oss-120b")):
            self.assertEqual(ast.literal_eval(assignments[name]), expected)


if __name__ == "__main__":
    unittest.main()
