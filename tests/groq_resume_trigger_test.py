"""Static regressions for the explicit, bounded history-resume trigger.

No workflow is dispatched and no source/model/credential is accessed here.
"""
from pathlib import Path
import ast
import unittest

ROOT = Path(__file__).resolve().parents[1]


class GroqResumeTriggerTest(unittest.TestCase):
    def test_only_explicit_main_push_enables_normal_history_budgets(self):
        text = (ROOT / ".github/workflows/groq-free-backfill.yml").read_text()
        for name, argument, limit in (("SPECIALIST_POSTS_INPUT", "specialist_posts", 5),):
            expected = (name + ": ${{ github.event_name == 'push' && "
                        "!startsWith(github.event.head_commit.message, '[resume-groq-history]') "
                        "&& '0' || inputs." + argument + " || '" + str(limit) + "' }}")
            self.assertIn(expected, text)
        self.assertNotIn("CHINESE_POSTS_INPUT", text)
        self.assertNotIn("inputs.chinese_posts", text)
        self.assertNotIn("id: chinese", text)
        push = text.split("  push:", 1)[1].split("  schedule:", 1)[0]
        self.assertIn("branches: [main]", push)
        self.assertIn("paths:\n      - .github/workflows/groq-free-backfill.yml", push)
        self.assertNotIn("pull_request", text)

    def test_authorized_cadence_retains_lock_limits_and_publication_gates(self):
        text = (ROOT / ".github/workflows/groq-free-backfill.yml").read_text()
        for required in ('cron: "45 */2 * * *"', "timezone: Europe/Paris",
                         "group: ct-map-update-main", "cancel-in-progress: false",
                         '(("SPECIALIST_POSTS_INPUT",5),)',
                         "backfill_publication_guard.py finalize",
                         "backfill_publication_guard.py verify",
                         "needs.backfill.outputs.publication_ready == 'true'",
                         "steps.checkpoint.outputs.publication_ready != 'true'"):
            self.assertIn(required, text)
        self.assertNotIn("repository_dispatch", text)

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
