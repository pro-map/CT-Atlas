"""Map publication retries select their own artifact and preserve prior evidence."""
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
# apply-usage-upgrade.yml no longer publishes Pages (its unverified duplicate
# deploy was removed on 2026-11-04); workflow_concurrency_test.py checks that.
PUBLISHERS = (
    "update-map.yml", "deploy-current-ct-atlas-ui.yml", "repair-map-evidence.yml",
    "refresh-daily-status.yml", "reconcile-daily-integrity.yml",
)

# Manual publishers are re-run too; the logo refresh used the default artifact name.
MANUAL_PUBLISHERS = ("refresh-logo-only.yml",)
WORKFLOWS = {name: (ROOT / ".github/workflows" / name).read_text(encoding="utf-8")
             for name in PUBLISHERS + MANUAL_PUBLISHERS}


def action_steps(source, action):
    return [step for step in re.split(r"(?m)^      - ", source) if re.search(
        rf"(?m)^[ \t]*uses: {re.escape(action)}@", step)]


def step_input(step, key, default=None):
    value = re.search(rf"(?m)^          {re.escape(key)}: (.+)$", step)
    return value[1].strip().strip("\"'") if value else default


def render(template, run_id, attempt):
    return (template.replace("${{ github.run_id }}", str(run_id))
            .replace("${{ github.run_attempt }}", str(attempt)))


class MapPublicationRetryTests(unittest.TestCase):
    def test_rerun_selects_only_its_own_pages_artifact(self):
        for name, source in WORKFLOWS.items():
            with self.subTest(workflow=name):
                upload_steps = action_steps(source, "actions/upload-pages-artifact")
                deploy_steps = action_steps(source, "actions/deploy-pages")
                self.assertEqual(len(upload_steps), 1)
                self.assertEqual(len(deploy_steps), 1)
                upload = step_input(upload_steps[0], "name", "github-pages")
                deploy = step_input(deploy_steps[0], "artifact_name", "github-pages")
                # Keep the first upload when simulating a rerun, as GitHub does.
                # deploy-pages rejects multiple artifacts matching artifact_name.
                artifacts = []
                for attempt in (1, 2):
                    current = {"name": render(upload, 41350576341, attempt), "attempt": attempt}
                    artifacts.append(current)
                    selected = [artifact for artifact in artifacts
                                if artifact["name"] == render(deploy, 41350576341, attempt)]
                    self.assertEqual(selected, [current],
                                     "A rerun must not collide with or deploy an earlier attempt")

    def test_recovery_and_proof_names_identify_each_run_and_attempt(self):
        for name, source in WORKFLOWS.items():
            for step in action_steps(source, "actions/upload-artifact"):
                with self.subTest(workflow=name, step=step.splitlines()[0]):
                    proof = step_input(step, "name")
                    self.assertIsNotNone(proof)
                    names = {render(proof, run_id, attempt)
                             for run_id in (41350576341, 41350576342) for attempt in (1, 2)}
                    self.assertEqual(len(names), 4, "Earlier attempt proofs must remain distinct")
                    self.assertNotEqual(step_input(step, "overwrite", "false"), "true",
                                        "Do not delete a previous attempt's evidence")

    def test_repair_report_and_staged_path_preserve_every_attempt(self):
        for name, prefix in (("repair-map-evidence.yml", "map-evidence-repair"),
                             ("reconcile-daily-integrity.yml", "daily-integrity-repair")):
            with self.subTest(workflow=name):
                source = WORKFLOWS[name]
                written = re.search(r'--(?:report|output) "(archive/' + re.escape(prefix) + r'[^"\n]+)"', source)
                staged = re.search(r'git add -- events.json "(archive/[^"\n]+)"', source)
                self.assertIsNotNone(written)
                self.assertIsNotNone(staged)
                self.assertEqual(written[1], staged[1])
                paths = {written[1].replace("${GITHUB_RUN_ID}", str(run_id))
                         .replace("${GITHUB_RUN_ATTEMPT}", str(attempt))
                         for run_id in (41350576341, 41350576342) for attempt in (1, 2)}
                self.assertEqual(len(paths), 4, "Repair retries must not replace an earlier report")


if __name__ == "__main__":
    unittest.main()
