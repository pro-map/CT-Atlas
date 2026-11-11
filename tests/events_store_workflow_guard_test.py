"""Static guard for the monthly store (docs/STORAGE_MIGRATION.md): every job that
reads events.json rebuilds it first, nothing stages events.json but
events_store.py, and only events_store.py reads the database from Git history.

Once the contract commit stops tracking events.json, a reader that skips
`events_store.py materialize` finds no file, and a writer that runs
`git add events.json` brings back the 100 MiB file. This test fails on both
before they can reach main."""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github/workflows"
COMPOSITE = ROOT / ".github/actions/build-events-lite/action.yml"
MATERIALIZE = "events_store.py materialize"
# Tools that open the checkout's events.json, when they are run (not grepped).
RUN = r"\bpython3?(?:\s+-u)?\s+"
READER_TOOLS = re.compile(
    RUN + r"(?:tools/)?(?:run_collector_quota_safe|collector|geolocate|finalize_daily_status|"
    r"consolidate_incidents|cleanup_existing_events|repair_map_evidence|retire_judicial|"
    r"enrich_radnuc_background|sync_background_corpus|build_events_lite|build_events_map|"
    r"normalize_actor_group|recover_from_history|compact_mirror_json)\.py"
    r"|" + RUN + r"tools/daily_publication_audit\.py (?:snapshot|repair|receipt|manifest)"
    # The whole suites read the real file; single test files run by the data jobs do not.
    r"|node --test tests/\*\.test\.cjs|pytest tests/")
# A bare events.json (not /tmp/events.json or a URL) inside an inline Python script.
BARE_DATABASE = re.compile(r"(?<![\w/.-])events\.json\b")
# They materialize themselves.
SELF_MATERIALIZING = ("uses: ./.github/actions/build-events-lite", "bash tools/deploy_mirror.sh")


def jobs(source):
    body = re.split(r"(?m)^jobs:[ \t]*\n", source, maxsplit=1)[1]
    blocks = re.split(r"(?m)^  (?=[^\s#])", body)[1:]
    return {block.split(":", 1)[0].strip(): block for block in blocks}


def steps(job):
    if not re.search(r"(?m)^    steps:\n", job):
        return []
    body = re.split(r"(?m)^    steps:\n", job, maxsplit=1)[1]
    return re.split(r"(?m)^      - ", body)[1:]


def code(step):
    """The step without its comment lines."""
    return "\n".join(line for line in step.splitlines() if not line.lstrip().startswith("#"))


def inline_python(step):
    return re.findall(r"<<'PY'\n(.*?)\n *PY\b", step, re.S)


def reads_database(step):
    text = code(step)
    if any(marker in text for marker in SELF_MATERIALIZING):
        return False
    return bool(READER_TOOLS.search(text)) or any(BARE_DATABASE.search(script) for script in inline_python(text))


class ReadersMaterializeFirstTests(unittest.TestCase):
    def test_every_job_materializes_before_its_first_reader(self):
        checked = 0
        for path in sorted(WORKFLOWS.glob("*.yml")):
            for name, job in jobs(path.read_text(encoding="utf-8")).items():
                ready = False
                for step in steps(job):
                    if reads_database(step):
                        checked += 1
                        with self.subTest(workflow=path.name, job=name, step=step.splitlines()[0]):
                            self.assertTrue(ready, "reads events.json before `python3 events_store.py materialize`")
                    ready = ready or MATERIALIZE in code(step)
        self.assertGreater(checked, 20, "the reader scan found too few readers to be trusted")

    def test_the_scan_sees_the_kinds_of_reader(self):
        for text in ("run: python -u tools/run_collector_quota_safe.py", "run: node --test tests/*.test.cjs",
                     "run: python tools/daily_publication_audit.py snapshot", "run: python -m pytest tests/ -q",
                     "run: |\n  python - <<'PY'\n  data = open('events.json').read()\n  PY"):
            with self.subTest(text=text):
                self.assertTrue(reads_database(text))
        for text in ("run: python3 tools/daily_publication_audit.py verify --url x",
                     "run: grep -q '^RECENT_DAYS = 181$' tools/build_events_map.py",
                     "run: python -m py_compile collector.py geolocate.py",
                     "run: |\n  python3 - <<'PY'\n  open('/tmp/events.json')\n  PY",
                     "uses: ./.github/actions/build-events-lite", "run: bash tools/deploy_mirror.sh",
                     "run: python -m unittest discover -s tests -p 'update_sanctions_test.py'"):
            with self.subTest(text=text):
                self.assertFalse(reads_database(text))

    def test_the_composite_and_the_mirror_script_materialize_first(self):
        composite = COMPOSITE.read_text(encoding="utf-8")
        first = composite.index(MATERIALIZE)
        self.assertLess(composite.index("actions/setup-python@"), first)
        self.assertLess(first, composite.index("tools/build_events_lite.py"))
        script = (ROOT / "tools/deploy_mirror.sh").read_text(encoding="utf-8")
        self.assertLess(script.index("python3 " + MATERIALIZE), script.index("--input events.json"))

    def test_the_site_never_publishes_the_store(self):
        composite = COMPOSITE.read_text(encoding="utf-8")
        self.assertIn("rm -rf data/events", composite)
        self.assertIn("rm -f events.json.store-base", composite)
        self.assertLess(composite.index("daily_publication_audit.py manifest"), composite.index("rm -rf data/events"))
        script = (ROOT / "tools/deploy_mirror.sh").read_text(encoding="utf-8")
        self.assertNotRegex(script, r"cp[^\n]*data/events", "the mirror stages files one by one; never the store")


class WritersStageTests(unittest.TestCase):
    def test_no_workflow_stages_events_json_itself(self):
        for path in sorted(WORKFLOWS.glob("*.yml")):
            source = path.read_text(encoding="utf-8")
            with self.subTest(workflow=path.name):
                self.assertNotRegex(source, r"git add[^\n]*(?<![\w/.-])events\.json")
                self.assertNotRegex(source, r'"git", "add"[^\n]*"events\.json"')
                self.assertNotRegex(source, r"(?m)git add (?:-A|--all|\.)\s*$", "a whole-tree add would stage events.json")

    def test_every_writer_of_events_json_stages_through_events_store(self):
        writers = {"update-map.yml", "refresh-daily-status.yml", "consolidate-incidents.yml", "cleanup-events.yml",
                   "repair-map-evidence.yml", "reconcile-daily-integrity.yml", "retire-judicial.yml"}
        for name in sorted(writers):
            with self.subTest(workflow=name):
                source = (WORKFLOWS / name).read_text(encoding="utf-8")
                self.assertRegex(source, r'events_store\.py stage|"events_store\.py", "stage"')
        for name in ("cleanup-events.yml", "retire-judicial.yml"):
            with self.subTest(deliberate_shrink=name):
                source = (WORKFLOWS / name).read_text(encoding="utf-8")
                commit = [step for job in jobs(source).values() for step in steps(job) if "events_store.py stage" in step]
                self.assertEqual(len(commit), 1)
                self.assertIn('ALLOW_SHRINK: "1"', commit[0])

    def test_the_archive_only_job_also_leaves_the_store_alone(self):
        source = (WORKFLOWS / "daily-radnuc-background.yml").read_text(encoding="utf-8")
        self.assertIn("git diff --quiet -- events.json events-lite.json events-map.json data/events", source)
        self.assertIn('git status --porcelain -- data/events', source)

    def test_only_events_store_reads_the_database_from_git(self):
        sources = [path for path in [*ROOT.glob("*.py"), *(ROOT / "tools").glob("*.py")] if path.name != "events_store.py"]
        for path in sources:
            for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                if re.search(r"""["'](?:show|restore|log|cat-file)["']""", line) and "events.json" in line:
                    self.fail(f"{path.name}:{number} reads events.json from Git; use events_store.build_ref")
        finalize = (ROOT / "tools/finalize_daily_status.py").read_text(encoding="utf-8")
        self.assertNotIn('"git"', finalize, "restore and baseline go through events_store")
        self.assertIn("events_store.restore(", finalize)
        self.assertIn("events_store.committed_bytes(", finalize)
        recover = (ROOT / "tools/recover_from_history.py").read_text(encoding="utf-8")
        self.assertIn("events_store.build_ref(ROOT, sha)", recover)
        self.assertIn("events_store.DATABASE, events_store.STORE", recover)

    def test_the_push_script_checks_the_store_after_every_rebase(self):
        script = (ROOT / "tools/push_data_commit.sh").read_text(encoding="utf-8")
        self.assertIn("git diff --quiet origin/main HEAD -- events.json data/events", script)
        self.assertIn("python3 events_store.py check", script)
        self.assertLess(script.index("git rebase origin/main"), script.index("check_rebased_database; then"))

    def test_python_ci_checks_the_committed_database(self):
        source = (WORKFLOWS / "python-tests.yml").read_text(encoding="utf-8")
        self.assertLess(source.index("python events_store.py check"), source.index("python -m pytest tests/"))
        self.assertEqual(source.count('      - "data/events/**"\n'), 2, "push and pull_request")
        mirror = (WORKFLOWS / "deploy-cloudflare-mirror.yml").read_text(encoding="utf-8")
        self.assertIn('      - "data/events/**"\n', mirror)
        self.assertIn('      - "events.json"\n', mirror, "kept until phase 4")


class MigrationWorkflowTests(unittest.TestCase):
    source = (WORKFLOWS / "migrate-events-store.yml").read_text(encoding="utf-8")

    def test_it_holds_the_data_lock_and_runs_only_on_the_owners_dispatch(self):
        self.assertRegex(self.source, r"(?m)^concurrency:\n  group: ct-map-update-main\n  cancel-in-progress: false\n  queue: max\n")
        triggers = re.search(r"(?m)^on:\n((?:[ \t].*\n|\n)+)", self.source)[1]
        self.assertEqual(re.findall(r"(?m)^  ([\w-]+):", triggers), ["workflow_dispatch"])
        self.assertIn("    environment: data-migration\n", self.source)
        self.assertRegex(self.source, r"dry_run:\n(?:.*\n){1,3}        default: true\n")
        self.assertIn('if [ "$DRY_RUN" != "true" ] && [ "$CONFIRM" != "$DIRECTION" ]; then', self.source)

    def test_it_verifies_before_it_commits_and_pushes_only_for_real(self):
        order = [self.source.index(text) for text in (
            "python3 events_store.py build --ref HEAD --out",       # S0
            "retention-days: 90",                                   # its artifact
            'python3 events_store.py migrate "$DIRECTION"',
            'cmp "$RUNNER_TEMP/before/events.json"',                # same bytes after
            "Verify record by record, independently",
            "Publication dry run",
            'git commit -m "$message"',
            'if [ "$DRY_RUN" = "true" ]; then',
            "bash tools/push_data_commit.sh",
        )]
        self.assertEqual(order, sorted(order))
        independent = self.source.split("independently of events_store.py\n", 1)[1].split("\n      - name:", 1)[0]
        self.assertNotIn("events_store", independent, "the independent verifier shares no code with the codec")
        self.assertNotRegex(self.source, r"(?m)^[^#\n]*git revert")


class AgentRulesTests(unittest.TestCase):
    def test_the_agent_rules_explain_the_store(self):
        rules = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
        for text in ("events_store.py materialize", "events_store.py stage", "git revert", "migrate-events-store.yml",
                     "docs/STORAGE_MIGRATION.md"):
            self.assertIn(text, rules)
        self.assertIn("@AGENTS.md", (ROOT / "CLAUDE.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
