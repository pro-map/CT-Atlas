"""Which runs republish the site, and that every Pages publisher reaches the mirror.

Offline text checks of the workflow files (no YAML dependency, no network).
"""
import fnmatch
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github/workflows"
MIRROR = "deploy-cloudflare-mirror.yml"
UI = "deploy-current-ct-atlas-ui.yml"
REFRESH = "refresh-daily-status.yml"
# A finished one-shot patch whose Pages steps are being retired: the UI deploy
# already publishes the same files, with verification. It must not be listed.
NOT_MIRRORED = {"apply-usage-upgrade.yml"}
UI_GLOBS = {"*.html", "*.js", "*.css", "*.svg", "*.png"}


def read(name):
    return (WORKFLOWS / name).read_text(encoding="utf-8")


def workflow_name(source):
    match = re.search(r"(?m)^name:[ \t]*(.+?)[ \t]*$", source)
    return match[1].strip("\"'") if match else None


def trigger(source, event):
    """The indented lines of one event under the top-level on: block."""
    match = re.search(rf"(?m)^  {event}:[ \t]*\n((?:(?:    .*)?\n)*)", source)
    return match[1] if match else ""


def items(block, key):
    match = re.search(rf"(?m)^    {key}:[ \t]*\n((?:      - .*\n|[ \t]*#.*\n)*)", block)
    return [value.strip("\"'") for value in re.findall(r"(?m)^      - (.+?)[ \t]*$", match[1])] if match else []


def steps(source):
    return re.split(r"(?m)^      - ", source)[1:]


def step(source, name):
    found = [text for text in steps(source) if text.startswith(f"name: {name}\n")]
    if len(found) != 1:
        raise AssertionError(f"Expected one step named {name!r}, found {len(found)}")
    return found[0]


def step_if(text):
    match = re.search(r"(?m)^        if: (.+)$", text)
    return match[1].strip() if match else ""


def deploys_pages(source):
    return re.search(r"(?m)^[ \t]*(?:- )?uses: actions/deploy-pages@", source) is not None


class MirrorTriggerTests(unittest.TestCase):
    def test_mirror_follows_exactly_the_workflows_that_deploy_pages(self):
        # The list named five workflows that no longer exist and missed six
        # manual Pages publishers, so their output never reached the mirror.
        names, deployers = {}, set()
        for path in sorted(WORKFLOWS.glob("*.yml")):
            source = path.read_text(encoding="utf-8")
            names[workflow_name(source)] = path.name
            if deploys_pages(source):
                deployers.add(path.name)
        listed = items(trigger(read(MIRROR), "workflow_run"), "workflows")
        self.assertGreaterEqual(len(listed), 6)
        self.assertEqual(len(listed), len(set(listed)), "Duplicate trigger names")
        self.assertEqual([name for name in listed if name not in names], [],
                         "These names match no workflow's name: and never trigger the mirror")
        files = {names[name] for name in listed}
        self.assertEqual(sorted(files - deployers), [], "Listed workflows that do not deploy Pages")
        self.assertEqual(sorted(deployers - NOT_MIRRORED - files), [],
                         "These workflows deploy Pages but the mirror does not follow them")
        self.assertEqual(files & NOT_MIRRORED, set())

    def test_mirror_runs_only_after_a_successful_trusted_trigger(self):
        source = read(MIRROR)
        self.assertIn("github.event.workflow_run.conclusion == 'success'", source)
        self.assertIn("Deploy current CT Atlas UI", items(trigger(source, "workflow_run"), "workflows"))

    def test_ui_files_reach_the_mirror_only_through_the_tested_ui_deploy(self):
        # Pushed UI files used to deploy the mirror directly, with no test run.
        mirror_paths = items(trigger(read(MIRROR), "push"), "paths")
        self.assertTrue(mirror_paths, "The mirror push trigger was not found")
        self.assertEqual(sorted(UI_GLOBS & set(mirror_paths)), [])
        # Only the database and the mirror's own tooling deploy it directly: any
        # other site file in a mixed push would ship the UI before its tests.
        site_files = [path for path in mirror_paths if "/" not in path
                      and not path.endswith(".py") and path != "events.json"]
        self.assertEqual(site_files, [])
        ui_paths = items(trigger(read(UI), "push"), "paths")
        script = (ROOT / "tools/deploy_mirror.sh").read_text(encoding="utf-8")
        block = re.search(r'cp index\.html[\s\S]*?"\$STAGING"/', script)[0]
        staged = re.findall(r"[\w-]+\.(?:html|json|js|css|svg|txt)\b", block)
        staged += re.findall(r'(?m)^cp ([\w.-]+\.png) "\$STAGING/', script)
        self.assertIn("privacy.html", staged)
        self.assertIn("CT-ATLAS.png", staged)
        unwatched = [name for name in staged
                     if not any(fnmatch.fnmatchcase(name, pattern) for pattern in ui_paths + mirror_paths)]
        self.assertEqual(unwatched, [], "A push changing these files would reach neither Pages nor the mirror")

    def test_mirror_proof_names_identify_each_run_and_attempt(self):
        proof = re.search(r"(?m)^          name: (mirror-publication-proof-.+)$", read(MIRROR))[1]
        rendered = {proof.replace("${{ github.run_id }}", str(run)).replace("${{ github.run_attempt }}", str(attempt))
                    for run in (41350576341, 41350576342) for attempt in (1, 2)}
        self.assertEqual(len(rendered), 4, "A re-run must not reuse an earlier attempt's proof name")

    def test_mirror_skips_only_a_revision_it_already_serves(self):
        # A status refresh that commits nothing still completes successfully;
        # its mirror run must not redeploy the revision already served.
        source = read(MIRROR)
        check = step(source, "Skip a revision the mirror already serves")
        self.assertIn("id: current", check)
        self.assertIn("github.event_name == 'workflow_run'", step_if(check))
        self.assertIn("daily_publication_audit.py served-revision", check)
        self.assertIn('[ "$served" = "$(git rev-parse HEAD)" ]', check)
        self.assertIn('[ -n "$served" ]', check, "An unknown revision must deploy")
        order = [text.split("\n", 1)[0] for text in steps(source)]
        self.assertLess(order.index("name: Checkout the exact main revision"),
                        order.index("name: Skip a revision the mirror already serves"))
        for name in ("Deploy identical static mirror", "Verify the data actually served by the mirror"):
            with self.subTest(step=name):
                self.assertIn("steps.current.outputs.skip != 'true'", step_if(step(source, name)))


class StatusRefreshPublicationTests(unittest.TestCase):
    def test_refresh_follows_the_map_update_and_not_the_radnuc_archive(self):
        # RadNuc finishes during the map update, whose own refresh publishes its
        # row; a RadNuc-triggered refresh only queued one more lock member.
        listed = items(trigger(read(REFRESH), "workflow_run"), "workflows")
        if not listed:
            listed = re.findall(r'"([^"]+)"', re.search(r"(?m)^    workflows: (\[.*\])", read(REFRESH))[1])
        self.assertEqual(listed, ["Daily CT Intelligence Map Update"])
        finalize = (ROOT / "tools/finalize_daily_status.py").read_text(encoding="utf-8")
        self.assertIn('default=ROOT / "archive/radnuc-background-status.json"', finalize)
        self.assertIn("archive/radnuc-background-status.json", read("daily-radnuc-background.yml"))
        self.assertIn("tools/finalize_daily_status.py", read("update-map.yml"))

    def test_commit_reports_a_change_only_after_its_push_succeeds(self):
        commit = step(read(REFRESH), "Commit verified progress")
        self.assertIn("id: commit", commit)
        self.assertEqual(commit.count('echo "changed=true" >> "$GITHUB_OUTPUT"'), 1)
        push = commit.index("if ! bash tools/push_data_commit.sh; then")
        self.assertIn("exit 1", commit[push:commit.index("          fi\n", push)], "a failed push stops here")
        self.assertLess(push, commit.index('echo "changed=true"'))
        self.assertLess(commit.index("if git diff --cached --quiet; then"), push)

    def test_pages_steps_run_only_for_a_change_or_a_safety_net(self):
        source = read(REFRESH)
        decision = step(source, "Decide whether GitHub Pages needs this refresh")
        self.assertIn("id: publish", decision)
        for condition in ('CHANGED: ${{ steps.commit.outputs.changed }}', '[ "$CHANGED" = "true" ]',
                          '[ "$EVENT" = "workflow_dispatch" ]', '[ "$TRIGGER_CONCLUSION" != "success" ]'):
            self.assertIn(condition, decision)
        for name in ("Configure GitHub Pages", "Build active map and Database data", "Upload website",
                     "Deploy GitHub Pages", "Verify the data actually served by GitHub Pages",
                     "Retain Pages publication proof"):
            with self.subTest(step=name):
                self.assertIn("steps.publish.outputs.pages == 'true'", step_if(step(source, name)))

    def test_refresh_deploy_is_verified_like_the_map_update(self):
        source = read(REFRESH)
        order = [text.split("\n", 1)[0] for text in steps(source)]
        self.assertLess(order.index("name: Deploy GitHub Pages"),
                        order.index("name: Verify the data actually served by GitHub Pages"))
        verify = step(source, "Verify the data actually served by GitHub Pages")
        self.assertIn('tools/daily_publication_audit.py verify --url "${{ steps.deployment.outputs.page_url }}" '
                      '--expected publication-manifest.json', verify)


class DeliberateShrinkTests(unittest.TestCase):
    def test_only_the_workflows_that_shrink_on_purpose_may_skip_the_shrink_rule(self):
        skipping = {path.name for path in WORKFLOWS.glob("*.yml") if "ALLOW_SHRINK" in path.read_text(encoding="utf-8")}
        self.assertEqual(skipping, {"retire-judicial.yml", "cleanup-events.yml"})
        for path in (ROOT / ".github/actions").rglob("*.yml"):
            self.assertNotIn("ALLOW_SHRINK", path.read_text(encoding="utf-8"))

    def test_each_of_them_publishes_its_own_shrink(self):
        # cleanup-events.yml only committed: the next daily publication, which has no
        # ALLOW_SHRINK, would then have met the gate. The flag must sit on the job
        # that builds the manifest, and the mirror must follow that job.
        listed = items(trigger(read(MIRROR), "workflow_run"), "workflows")
        for name in ("retire-judicial.yml", "cleanup-events.yml"):
            with self.subTest(workflow=name):
                source = read(name)
                deploy = source[source.index("\n  deploy:\n"):]
                self.assertIn('ALLOW_SHRINK: "1"', deploy[:deploy.index("    steps:\n")])
                self.assertIn("uses: ./.github/actions/build-events-lite", deploy)
                self.assertTrue(deploys_pages(deploy))
                self.assertIn(workflow_name(source), listed)


class LiveMapAlarmTests(unittest.TestCase):
    def test_the_scheduled_smoke_run_checks_the_map_on_both_sites(self):
        # live-smoke ran green 51 of 51 times through the 7-day mirror failure and the
        # starved 5 Nov: it never fetched events-map.json or publication-manifest.json.
        source = read("live-smoke.yml")
        self.assertIn("schedule:", source)
        job = source[source.index("\n  map-publication:\n"):]
        self.assertNotRegex(job.split("    steps:\n")[0], r"(?m)^    if:", "The alarm must run on every smoke run")
        self.assertNotIn("continue-on-error", job, "A stale map must turn the run red")
        command = step(job, "Check the map served by ct-atlas.com and the mirror")
        self.assertIn('daily_publication_audit.py live --url "https://ct-atlas.com" '
                      '--mirror-url "https://ct-atlas-mirror.fairpeace.workers.dev"', command)

    def test_the_job_outlasts_its_retries(self):
        # Eleven minutes of retries cover Pages' max-age=600.
        job = read("live-smoke.yml").split("\n  map-publication:\n")[1]
        self.assertGreater(int(re.search(r"timeout-minutes: (\d+)", job)[1]), 12)


if __name__ == "__main__":
    unittest.main()
