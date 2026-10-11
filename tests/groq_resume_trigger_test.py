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
        for name, argument, limit in (("SPECIALIST_POSTS_INPUT", "specialist_posts", 5),
                                      ("CHINESE_POSTS_INPUT", "chinese_posts", 4)):
            expected = (name + ": ${{ github.event_name == 'push' && "
                        "!startsWith(github.event.head_commit.message, '[resume-groq-history]') "
                        "&& '0' || inputs." + argument + " || '" + str(limit) + "' }}")
            self.assertIn(expected, text)
        push = text.split("  push:", 1)[1].split("  schedule:", 1)[0]
        self.assertIn("branches: [main]", push)
        self.assertIn("paths:\n      - .github/workflows/groq-free-backfill.yml", push)
        self.assertNotIn("pull_request", text)

    def test_schedule_lock_limits_and_publication_gates_remain(self):
        text = (ROOT / ".github/workflows/groq-free-backfill.yml").read_text()
        for required in ('cron: "45 11,17,23 * * *"', "timezone: Europe/Paris",
                         "group: ct-map-update-main", "cancel-in-progress: false",
                         '(("SPECIALIST_POSTS_INPUT",5),("CHINESE_POSTS_INPUT",4))',
                         "backfill_publication_guard.py finalize",
                         "backfill_publication_guard.py verify",
                         "needs.backfill.outputs.publication_ready == 'true'",
                         "steps.checkpoint.outputs.publication_ready != 'true'"):
            self.assertIn(required, text)
        self.assertNotIn("repository_dispatch", text)

    def test_daily_cap_and_model_constants_are_unchanged(self):
        tree = ast.parse((ROOT / "tools/groq_backfill.py").read_text())
        constants = {}
        for node in tree.body:
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        constants[target.id] = node.value.value
        self.assertEqual(constants["MAX_POSTS_PER_UTC_DAY"], 24)
        self.assertEqual(constants["MAX_RESERVED_TOKENS_PER_UTC_DAY"], 120000)
        self.assertEqual(constants["BATCH_SIZE"], 3)
        self.assertEqual(constants["MODEL"], "openai/gpt-oss-120b")


if __name__ == "__main__":
    unittest.main()
