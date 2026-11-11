"""Protect queued map repairs/collections from another workflow replacing them.

GitHub's default queue: single cancels pending members of the same group even
when cancel-in-progress is false. The contract must hold for EVERY member,
including manual/retired workflows: queue behavior is not owned by the daily job.
https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GROUP = "ct-map-update-main"


def concurrency_blocks(source):
    """Read simple concurrency blocks without introducing a CI YAML dependency.

    Include workflow and job scopes. A compact/scalar declaration referencing
    the shared group is retained and will fail the explicit-policy assertions.
    """
    lines = source.splitlines()
    for index, line in enumerate(lines):
        match = re.match(r"^( *)concurrency:\s*(.*?)\s*$", line)
        if not match:
            continue
        indent, inline = len(match[1]), match[2]
        block = [inline] if inline and not inline.startswith("#") else []
        if not block:
            for child in lines[index + 1:]:
                if not child.strip() or child.lstrip().startswith("#"):
                    continue
                if len(child) - len(child.lstrip(" ")) <= indent:
                    break
                block.append(child.strip())
        yield "\n".join(block)


class WorkflowConcurrencyTests(unittest.TestCase):
    def test_every_shared_map_lock_member_preserves_queued_work(self):
        members = set()
        problems = []
        for path in sorted((ROOT / ".github/workflows").iterdir()):
            if path.suffix not in (".yml", ".yaml"):
                continue
            for block in concurrency_blocks(path.read_text(encoding="utf-8")):
                # GitHub compares group names case-insensitively. Looking at
                # the entire declaration also catches unsupported shorthand.
                if GROUP not in block.casefold():
                    continue
                members.add(path.name)
                explicit_group = re.search(r'^group:\s*[\'"]?ct-map-update-main[\'"]?\s*(?:#.*)?$', block, re.M | re.I)
                queued = re.search(r'^queue:\s*[\'"]?max[\'"]?\s*(?:#.*)?$', block, re.M)
                not_cancelled = re.search(r'^cancel-in-progress:\s*false\s*(?:#.*)?$', block, re.M)
                if not (explicit_group and queued and not_cancelled):
                    problems.append(path.name)
        required = {
            "update-map.yml", "repair-map-evidence.yml", "refresh-daily-status.yml",
            "reconcile-daily-integrity.yml", "deploy-current-ct-atlas-ui.yml",
            "refresh-sanctions.yml", "migrate-events-store.yml",
        }
        self.assertTrue(required <= members, f"Critical publishers lost their common lock: {sorted(required - members)}")
        self.assertEqual(problems, [],
                         "Every shared-lock member needs queue: max AND cancel-in-progress: false; "
                         "otherwise a UI/manual workflow can cancel pending repairs and daily runs")


    # The October 7 repair-source-geolocation migration was deleted (it could
    # only fail or replay stale corrections); its dispatch-only test went too.
    def test_completed_migrations_are_manual(self):
        for name in ("retire-judicial.yml",):
            with self.subTest(workflow=name):
                source = (ROOT / ".github/workflows" / name).read_text(encoding="utf-8")
                triggers = re.search(r"^on:\n((?:[ \t].*\n|\n)+)", source, re.M)
                self.assertIsNotNone(triggers)
                self.assertEqual(re.findall(r"^  ([\w-]+):", triggers[1], re.M), ["workflow_dispatch"],
                                 "A push replayed the migration and redeployed Pages without verification")


if __name__ == "__main__":
    unittest.main()
