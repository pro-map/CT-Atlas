"""events_store.py: the monthly store of the database (docs/STORAGE_MIGRATION.md).

Byte round trips on awkward records, the seals, the three modes (legacy, dual,
store) and the four migrations in throwaway Git repositories, two clones racing,
a `git revert` that must fail closed, and the real database."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
for folder in (ROOT, ROOT / "tools"):
    if str(folder) not in sys.path:
        sys.path.insert(0, str(folder))
import events_store as store  # noqa: E402

STRANGE = "Ünïcode — 東京   line  sep \r carriage \"quoted\" \\ back"


def event(identifier, published, **extra):
    return {"id": identifier, "title": f"Event {identifier}", "published": published, **extra}


def database(*events, **metadata):
    value = {"last_updated": "2026-11-11T00:00:00+00:00", "number_of_events": len(events), "events": list(events),
             "geolocation": {"located": len(events)}}
    value.update(metadata)
    value["number_of_events"] = len(value["events"])
    return value


SEED = [
    event("n1", "2026-11-05T10:00:00+00:00", summary=STRANGE, latitude=1e-05, longitude=1.0),
    event("n2", "2026-11-01T08:00:00Z", related_articles=[{"url": "https://a.test/1", "title": STRANGE}]),
    {"published": "2026-10-30T00:00:00+00:00", "id": "o1", "z": None, "a": [1, 2.5, -0.0, 10 ** 20]},
    event("o2", "2026-10-02T00:00:00+00:00"),
    event("s1", "2026-09-15T00:00:00+00:00", country="Côte d'Ivoire"),
    event("u1", None),
]


def changed(value, identifier, **fields):
    copy = json.loads(json.dumps(value))
    for item in copy["events"]:
        if item["id"] == identifier:
            item.update(fields)
    return copy


def without(value, *identifiers):
    copy = json.loads(json.dumps(value))
    copy["events"] = [item for item in copy["events"] if item["id"] not in identifiers]
    copy["number_of_events"] = len(copy["events"])
    return copy


class FormatTests(unittest.TestCase):
    def test_the_month_files_rebuild_the_same_bytes(self):
        value = database(*SEED)
        meta, files, regrouped, moved = store.split(value, "events.json")
        self.assertEqual(moved, [])
        self.assertEqual(list(files), ["2026-11", "2026-10", "2026-09", "undated"])
        self.assertEqual(store.canonical(regrouped), store.canonical(value))
        body, rebuilt = store.rebuild(store.parse(store.canonical(meta), "meta"), files.get)
        self.assertEqual(body, store.canonical(value))
        self.assertEqual(rebuilt, value)
        for data in files.values():
            # One record per line: only the final newline ends a line, and no raw CR is written.
            self.assertNotIn(b"\r", data)
            self.assertEqual(data.count(b"\n"), len(data[:-1].split(b"\n")))
        self.assertIn(" ".encode("utf-8"), files["2026-11"], "U+2028 stays a raw character inside a line")
        self.assertIn(b'"latitude":1e-05,"longitude":1.0', files["2026-11"])
        self.assertTrue(files["2026-10"].startswith(b'{"published":'), "a record keeps its own key order")

    def test_the_split_is_deterministic(self):
        first, second = store.split(database(*SEED), "events.json"), store.split(database(*SEED), "events.json")
        self.assertEqual(store.canonical(first[0]), store.canonical(second[0]))
        self.assertEqual(first[1], second[1])

    def test_a_record_out_of_month_order_is_moved_next_to_its_month(self):
        shuffled = [SEED[0], SEED[3], SEED[1], SEED[2], SEED[4], SEED[5]]
        meta, files, regrouped, moved = store.split(database(*shuffled), "events.json")
        self.assertEqual(moved, ["n2"])
        self.assertEqual([item["id"] for item in regrouped["events"]], ["n1", "n2", "o2", "o1", "s1", "u1"])
        body, _ = store.rebuild(store.parse(store.canonical(meta), "meta"), files.get)
        self.assertEqual(body, store.canonical(regrouped))

    def test_nan_and_infinity_are_refused(self):
        for constant in (b"NaN", b"Infinity", b"-Infinity"):
            with self.subTest(constant=constant), self.assertRaises(store.StoreError):
                store.parse(b'{"events": [{"id": "a", "x": ' + constant + b"}]}", "events.json")

    def test_the_writers_produce_the_same_bytes(self):
        import collector
        import finalize_daily_status
        value = database(*SEED)
        with tempfile.TemporaryDirectory() as folder:
            first, second = Path(folder, "a.json"), Path(folder, "b.json")
            collector.atomic_json_write(str(first), value)
            finalize_daily_status.atomic_write(second, value)
            # Both write in text mode: CRLF on Windows (stage rewrites that copy), LF on the runners.
            expected = store.canonical(value).replace(b"\n", os.linesep.encode("ascii"))
            self.assertEqual(first.read_bytes(), expected)
            self.assertEqual(second.read_bytes(), expected)


class SealTests(unittest.TestCase):
    def setUp(self):
        self.meta, self.files, _, _ = store.split(database(*SEED), "events.json")

    def rebuild(self, meta=None, files=None):
        meta = store.parse(store.canonical(meta or self.meta), "meta")
        return store.rebuild(meta, (files or self.files).get)

    def resealed(self, files):
        meta = json.loads(json.dumps(self.meta))
        for month, data in files.items():
            meta["months"][month] = {"events": data.count(b"\n"), "bytes": len(data), "sha256": store.sha256(data)}
        return meta

    def test_edited_bytes_break_the_seal(self):
        files = dict(self.files, **{"2026-10": self.files["2026-10"].replace(b"Event o2", b"Event O2")})
        with self.assertRaisesRegex(store.StoreError, "seal"):
            self.rebuild(files=files)

    def test_crlf_line_endings_break_the_seal(self):
        files = dict(self.files, **{"2026-09": self.files["2026-09"].replace(b"\n", b"\r\n")})
        with self.assertRaisesRegex(store.StoreError, "LF"):
            self.rebuild(files=files)

    def test_a_wrong_count_or_whole_file_hash_is_refused(self):
        meta = json.loads(json.dumps(self.meta))
        meta["months"]["2026-11"]["events"] = 3
        with self.assertRaisesRegex(store.StoreError, "holds 2 records"):
            self.rebuild(meta)
        meta = json.loads(json.dumps(self.meta))
        meta["events_sha256"] = "0" * 64
        with self.assertRaisesRegex(store.StoreError, "events_sha256"):
            self.rebuild(meta)

    def test_a_record_in_the_wrong_month_is_refused(self):
        line = self.files["2026-09"]
        files = dict(self.files, **{"2026-10": self.files["2026-10"] + line})
        with self.assertRaisesRegex(store.StoreError, "belongs to 2026-09"):
            self.rebuild(self.resealed(files), files)

    def test_an_id_in_two_files_is_refused(self):
        twin = store.record_line(event("o2", "2026-09-01T00:00:00Z"))
        files = dict(self.files, **{"2026-09": self.files["2026-09"] + twin})
        with self.assertRaisesRegex(store.StoreError, "o2 twice"):
            self.rebuild(self.resealed(files), files)

    def test_a_missing_month_file_is_refused(self):
        files = {month: data for month, data in self.files.items() if month != "2026-10"}
        with self.assertRaisesRegex(store.StoreError, "2026-10.jsonl is missing"):
            self.rebuild(files=files)

    def test_the_key_order_is_sealed_too(self):
        meta = json.loads(json.dumps(self.meta))
        meta["top_level_keys"] = ["events", "last_updated", "number_of_events", "geolocation"]
        with self.assertRaisesRegex(store.StoreError, "events_sha256"):
            self.rebuild(meta)


class Repository:
    """A throwaway clone with the project's line-ending rules."""

    def __init__(self, path):
        self.path = Path(path)

    def git(self, *args, check=True):
        result = subprocess.run(["git", *args], cwd=self.path, capture_output=True, text=True)
        if check and result.returncode:
            raise AssertionError(f"git {' '.join(args)}: {result.stderr}")
        return result

    def configure(self):
        self.git("config", "user.email", "test@example.test")
        self.git("config", "user.name", "Test")
        self.git("config", "commit.gpgsign", "false")

    def write(self, value):
        (self.path / "events.json").write_bytes(store.canonical(value))

    def read(self):
        return json.loads((self.path / "events.json").read_text(encoding="utf-8"))

    def commit(self, message):
        self.git("commit", "--quiet", "-m", message)
        return self.git("rev-parse", "HEAD").stdout.strip()

    def staged(self):
        return set(self.git("diff", "--cached", "--name-only").stdout.split())

    def head(self, path):
        return store.blob(self.path, "HEAD", path)


class StoreRepositoryTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.temp = Path(folder.name)
        self.remote = self.temp / "remote.git"
        subprocess.run(["git", "init", "--quiet", "--bare", "--initial-branch=main", str(self.remote)], check=True)
        self.repo = self.clone("writer", seed=True)
        self.quiet = mock.patch.dict(os.environ, {"GITHUB_ACTIONS": ""})
        self.quiet.start()
        self.addCleanup(self.quiet.stop)

    def clone(self, name, seed=False):
        path = self.temp / name
        if seed:
            path.mkdir()
            repo = Repository(path)
            repo.git("init", "--quiet", "--initial-branch=main")
            repo.configure()
            shutil.copyfile(ROOT / ".gitattributes", path / ".gitattributes")
            (path / ".gitignore").write_text("/events.json.store-base\n", encoding="utf-8", newline="\n")
            repo.write(database(*SEED))
            repo.git("add", "-A")
            repo.commit("Seed")
            repo.git("remote", "add", "origin", str(self.remote))
            repo.git("push", "--quiet", "origin", "HEAD:main")
            repo.git("branch", "--quiet", "--set-upstream-to=origin/main")
            return repo
        subprocess.run(["git", "clone", "--quiet", str(self.remote), str(path)], check=True, capture_output=True)
        repo = Repository(path)
        repo.configure()
        return repo

    def run_quietly(self, function, *args, **kwargs):
        with mock.patch("sys.stdout", new=open(os.devnull, "w", encoding="utf-8")) as sink:
            try:
                return function(*args, **kwargs)
            finally:
                sink.close()

    def expand(self, repo=None):
        repo = repo or self.repo
        summary = self.run_quietly(store.migrate, repo.path, "expand")
        repo.commit(summary["message"])
        return summary

    def contract(self, repo=None):
        repo = repo or self.repo
        summary = self.run_quietly(store.migrate, repo.path, "contract")
        repo.commit(summary["message"])
        return summary

    def stage(self, repo=None, **env):
        repo = repo or self.repo
        with mock.patch.dict(os.environ, env):
            return self.run_quietly(store.stage, repo.path)

    # ---- legacy

    def test_legacy_stage_adds_only_events_json_and_rehearses_the_split(self):
        self.repo.write(database(event("n0", "2026-11-09T00:00:00Z"), *SEED))
        with mock.patch("sys.stdout", new_callable=lambda: open(self.temp / "out.txt", "w", encoding="utf-8")) as out:
            store.stage(self.repo.path)
            out.close()
        self.assertEqual(self.repo.staged(), {"events.json"})
        self.assertFalse((self.repo.path / "data").exists())
        self.assertIn("shadow round trip OK", (self.temp / "out.txt").read_text(encoding="utf-8"))
        self.assertEqual(store.mode(self.repo.path), "legacy")
        self.assertEqual(self.run_quietly(store.check, self.repo.path), "legacy")

    def test_legacy_materialize_requires_events_json(self):
        (self.repo.path / "events.json").unlink()
        with self.assertRaisesRegex(store.StoreError, "git checkout -- events.json"):
            self.run_quietly(store.materialize, self.repo.path)
        store.require_materialized(self.repo.path)  # no store: the readers' own guards decide

    # ---- expand and dual-write

    def test_expand_writes_the_month_files_next_to_events_json(self):
        before = (self.repo.path / "events.json").read_bytes()
        summary = self.expand()
        self.assertEqual(summary["s0"], store.sha256(before))
        self.assertIn(f"(sha256 {summary['s0']}, 6 events)", summary["message"])
        self.assertEqual(store.mode(self.repo.path), "dual")
        self.assertEqual(self.repo.head("events.json"), before)
        names = store.tree_names(self.repo.path, "HEAD", store.STORE)
        self.assertEqual(names, {"meta.json", "2026-11.jsonl", "2026-10.jsonl", "2026-09.jsonl", "undated.jsonl"})
        self.assertEqual(self.run_quietly(store.check, self.repo.path), "dual")
        self.assertEqual(self.run_quietly(store.materialize, self.repo.path), "dual")
        self.assertEqual(json.loads(self.repo.head(store.META))["authority"], "events.json")

    def test_dual_write_stages_only_the_months_that_changed(self):
        self.expand()
        self.repo.write(changed(database(*SEED), "n2", title="Event n2, corrected"))
        self.stage()
        self.assertEqual(self.repo.staged(), {"events.json", "data/events/2026-11.jsonl", "data/events/meta.json"})
        self.repo.commit("Correct n2")
        self.assertEqual(self.run_quietly(store.check, self.repo.path), "dual")

    def test_a_status_only_change_stages_meta_json_and_events_json(self):
        self.expand()
        self.repo.write(database(*SEED, collection_status={"status": "complete"}))
        self.stage()
        self.assertEqual(self.repo.staged(), {"events.json", "data/events/meta.json"})

    def test_an_unchanged_database_stages_nothing_and_rewrites_nothing(self):
        self.expand()
        folder = self.repo.path / store.STORE
        times = {path.name: path.stat().st_mtime_ns for path in folder.iterdir()}
        self.stage()
        self.assertEqual(self.repo.staged(), set())
        self.assertEqual({path.name: path.stat().st_mtime_ns for path in folder.iterdir()}, times)

    def test_a_month_that_ages_out_is_deleted(self):
        self.expand()
        self.repo.write(without(database(*SEED), "s1"))
        self.stage(ALLOW_SHRINK="1")
        self.assertIn("data/events/2026-09.jsonl", self.repo.staged())
        self.assertFalse((self.repo.path / store.STORE / "2026-09.jsonl").exists())
        self.repo.commit("Age out September")
        self.assertEqual(self.run_quietly(store.check, self.repo.path), "dual")

    def test_a_large_shrink_needs_allow_shrink(self):
        self.expand()
        self.repo.write(without(database(*SEED), "s1"))
        with self.assertRaisesRegex(store.StoreError, "ALLOW_SHRINK=1"):
            self.stage(ALLOW_SHRINK="")
        self.assertEqual(self.repo.staged(), set())

    def test_a_record_count_that_disagrees_is_refused_once_the_store_exists(self):
        self.expand()
        value = database(*SEED)
        value["number_of_events"] = 5
        self.repo.write(value)
        with self.assertRaisesRegex(store.StoreError, "number_of_events is 5"):
            self.stage()

    def test_events_json_changed_without_stage_fails_materialize_and_check(self):
        self.expand()
        self.repo.write(changed(database(*SEED), "o1", z="edited"))
        with self.assertRaisesRegex(store.StoreError, "disagree"):
            self.run_quietly(store.materialize, self.repo.path)
        self.repo.git("add", "--", "events.json")
        self.repo.commit("Bypass stage")
        with self.assertRaisesRegex(store.StoreError, "disagree at HEAD"):
            self.run_quietly(store.check, self.repo.path)

    def test_reconcile_rewrites_the_store_from_events_json(self):
        self.expand()
        self.repo.write(changed(database(*SEED), "o1", z="edited"))
        self.run_quietly(store.reconcile, self.repo.path, "events.json")
        self.assertEqual(self.run_quietly(store.materialize, self.repo.path), "dual")

    def test_verify_compares_record_by_record_and_writes_a_receipt(self):
        self.expand()
        copy, receipt = self.temp / "copy.json", self.temp / "receipt.json"
        copy.write_bytes((self.repo.path / "events.json").read_bytes())
        result = self.run_quietly(store.verify, self.repo.path, copy, receipt=receipt)
        self.assertTrue(result["identical"])
        self.assertEqual(json.loads(receipt.read_text(encoding="utf-8"))["events"], 6)
        copy.write_bytes(store.canonical(changed(database(*SEED), "s1", title="Other")))
        with self.assertRaisesRegex(store.StoreError, "record s1 differs"):
            self.run_quietly(store.verify, self.repo.path, copy, receipt=receipt)
        self.assertFalse(json.loads(receipt.read_text(encoding="utf-8"))["identical"])

    def test_collapse_removes_the_store_and_keeps_events_json(self):
        before = (self.repo.path / "events.json").read_bytes()
        self.expand()
        summary = self.run_quietly(store.migrate, self.repo.path, "collapse")
        self.repo.commit(summary["message"])
        self.assertEqual(store.mode(self.repo.path), "legacy")
        self.assertEqual(self.repo.head("events.json"), before)
        self.assertEqual(store.tree_names(self.repo.path, "HEAD", store.STORE), set())

    def test_a_dry_run_changes_nothing(self):
        for direction in ("expand",):
            summary = self.run_quietly(store.migrate, self.repo.path, direction, dry_run=True)
            self.assertTrue(summary["dry_run"])
            self.assertEqual(self.repo.staged(), set())
            self.assertFalse((self.repo.path / "data").exists())
        self.expand()
        summary = self.run_quietly(store.migrate, self.repo.path, "contract", dry_run=True,
                                   receipt=self.temp / "contract.json")
        self.assertTrue(summary["verification"]["identical"])
        self.assertEqual(self.repo.staged(), set())
        self.assertEqual(store.mode(self.repo.path), "dual")

    # ---- contract and store mode

    def test_contract_untracks_events_json_and_materialize_rebuilds_it(self):
        self.expand()
        before = (self.repo.path / "events.json").read_bytes()
        summary = self.contract()
        self.assertEqual(store.mode(self.repo.path), "store")
        self.assertIsNone(self.repo.head("events.json"))
        self.assertIn(store.IGNORE_BLOCK, self.repo.head(".gitignore").decode("utf-8"))
        receipt = json.loads(self.repo.head(summary["receipt_path"]))
        self.assertEqual(receipt["s0"], store.sha256(before))
        self.assertEqual(self.run_quietly(store.check, self.repo.path), "store")
        (self.repo.path / "events.json").unlink()
        with self.assertRaisesRegex(RuntimeError, "not materialized"):
            store.require_materialized(self.repo.path)
        self.run_quietly(store.materialize, self.repo.path)
        self.assertEqual((self.repo.path / "events.json").read_bytes(), before)
        self.assertEqual(self.repo.git("status", "--porcelain").stdout, "", "events.json and its sidecar are ignored")

    def test_store_mode_commits_only_the_month_files(self):
        self.expand()
        self.contract()
        self.repo.write(database(event("n0", "2026-11-10T00:00:00Z"), *SEED))
        self.stage()
        self.assertEqual(self.repo.staged(), {"data/events/2026-11.jsonl", "data/events/meta.json"})
        self.repo.commit("Add n0")
        self.assertEqual(self.run_quietly(store.check, self.repo.path), "store")
        self.assertEqual(store.build_ref(self.repo.path, "HEAD"), (self.repo.path / "events.json").read_bytes())

    def test_a_retracked_events_json_is_refused(self):
        self.expand()
        self.contract()
        self.repo.git("add", "-f", "--", "events.json")
        with self.assertRaisesRegex(store.StoreError, "tracked again"):
            self.stage()
        self.repo.commit("Track it again by hand")
        with self.assertRaisesRegex(store.StoreError, "tracked again at HEAD"):
            self.run_quietly(store.check, self.repo.path)

    def test_local_edits_are_not_overwritten_without_force(self):
        self.expand()
        before = (self.repo.path / "events.json").read_bytes()
        self.contract()
        self.repo.write(changed(database(*SEED), "s1", title="Local edit"))
        with self.assertRaisesRegex(store.StoreError, "materialize --force"):
            self.run_quietly(store.materialize, self.repo.path)
        self.run_quietly(store.materialize, self.repo.path, force=True)
        self.assertEqual((self.repo.path / "events.json").read_bytes(), before)

    def test_a_copy_built_from_an_older_store_cannot_be_staged(self):
        self.expand()
        self.contract()
        self.repo.git("push", "--quiet", "origin", "HEAD:main")
        other = self.clone("other")
        self.run_quietly(store.materialize, other.path)
        other.write(database(event("n0", "2026-11-10T00:00:00Z"), *SEED))
        self.stage(other)
        other.commit("Add n0")
        other.git("push", "--quiet", "origin", "HEAD:main")
        # The writer pulls the new store, keeps its old local events.json, edits it and stages.
        self.repo.git("pull", "--quiet", "--ff-only")
        self.repo.write(changed(database(*SEED), "s1", title="Edit on a stale copy"))
        with self.assertRaisesRegex(store.StoreError, "older data/events"):
            self.stage()

    def test_uncontract_tracks_events_json_again(self):
        self.expand()
        self.contract()
        self.repo.write(database(event("n0", "2026-11-10T00:00:00Z"), *SEED))
        self.stage()
        self.repo.commit("Add n0")
        newest = store.build_ref(self.repo.path, "HEAD")
        summary = self.run_quietly(store.migrate, self.repo.path, "uncontract")
        self.repo.commit(summary["message"])
        self.assertEqual(store.mode(self.repo.path), "dual")
        self.assertEqual(self.repo.head("events.json"), newest)
        self.assertNotIn(store.IGNORE_BLOCK, self.repo.head(".gitignore").decode("utf-8"))
        self.assertEqual(self.run_quietly(store.check, self.repo.path), "dual")

    def test_reverting_the_contract_after_a_data_commit_fails_closed(self):
        self.expand()
        contract = self.contract()
        contract_sha = self.repo.git("rev-parse", "HEAD").stdout.strip()
        self.repo.write(database(event("n0", "2026-11-10T00:00:00Z"), *SEED))
        self.stage()
        self.repo.commit("Add n0")
        newest = store.build_ref(self.repo.path, "HEAD")
        (self.repo.path / "events.json").unlink()
        # The authority line sits next to events_sha256, which every data commit changes.
        revert = self.repo.git("revert", "--no-edit", contract_sha, check=False)
        self.assertNotEqual(revert.returncode, 0, "the revert should stop on meta.json")
        self.repo.git("revert", "--abort")
        self.assertEqual(self.run_quietly(store.check, self.repo.path), "store")
        # Forced through by hand: the old events.json is back, the store is newer. Refused, nothing lost.
        self.repo.git("checkout", f"{contract_sha}^", "--", "events.json")
        meta = json.loads((self.repo.path / store.META).read_text(encoding="utf-8"))
        meta["authority"] = "events.json"
        (self.repo.path / store.META).write_bytes(store.canonical(meta))
        self.repo.git("add", "-f", "--", "events.json", store.META)
        self.repo.commit("A hand-made revert of the contract")
        with self.assertRaisesRegex(store.StoreError, "disagree at HEAD"):
            self.run_quietly(store.check, self.repo.path)
        with self.assertRaisesRegex(store.StoreError, "disagree"):
            self.run_quietly(store.materialize, self.repo.path)
        self.assertEqual(store.build_ref(self.repo.path, "HEAD~1"), newest)
        self.assertTrue(contract["message"].startswith("Stop tracking events.json"))

    def test_build_ref_reads_every_layout(self):
        legacy = self.repo.git("rev-parse", "HEAD").stdout.strip()
        legacy_bytes = (self.repo.path / "events.json").read_bytes()
        self.expand()
        self.contract()
        self.repo.write(database(event("n0", "2026-11-10T00:00:00Z"), *SEED))
        self.stage()
        self.repo.commit("Add n0")
        self.assertEqual(store.build_ref(self.repo.path, legacy), legacy_bytes)
        self.assertEqual(store.build_ref(self.repo.path, "HEAD~2"), legacy_bytes)  # the expand commit
        self.assertEqual(store.build_ref(self.repo.path, "HEAD~1"), legacy_bytes)  # the contract commit
        self.assertEqual(json.loads(store.build_ref(self.repo.path, "HEAD"))["number_of_events"], 7)
        # What finalize_daily_status does after a failed collection, in store mode.
        self.repo.write(changed(database(*SEED), "s1", title="Broken run"))
        store.restore(self.repo.path)
        self.assertEqual((self.repo.path / "events.json").read_bytes(), store.build_ref(self.repo.path, "HEAD"))
        self.assertEqual(json.loads(store.committed_bytes(self.repo.path))["number_of_events"], 7)

    # ---- two writers

    def test_concurrent_changes_to_different_months_always_conflict(self):
        self.expand()
        self.repo.git("push", "--quiet", "origin", "HEAD:main")
        other = self.clone("other")
        self.repo.write(changed(database(*SEED), "n1", title="Edited in November"))
        self.stage()
        self.repo.commit("November")
        self.repo.git("push", "--quiet", "origin", "HEAD:main")
        other.write(changed(database(*SEED), "s1", title="Edited in September"))
        self.stage(other)
        other.commit("September")
        other.git("fetch", "--quiet", "origin")
        rebase = other.git("rebase", "origin/main", check=False)
        self.assertNotEqual(rebase.returncode, 0, "two store commits merged silently")
        conflicted = set(other.git("diff", "--name-only", "--diff-filter=U").stdout.split())
        self.assertIn("data/events/meta.json", conflicted)
        other.git("rebase", "--abort")


class CommandLineTests(unittest.TestCase):
    def test_check_exits_one_with_an_annotation_on_an_inconsistent_tree(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = Repository(folder)
            repo.git("init", "--quiet", "--initial-branch=main")
            repo.configure()
            (repo.path / "events.json").write_text('{"events": [{"id": "a"}, {"id": "a"}]}\n', encoding="utf-8")
            repo.git("add", "-A")
            repo.commit("Twice")
            result = subprocess.run([sys.executable, str(ROOT / "events_store.py"), "--root", folder, "check"],
                                    capture_output=True, text=True, env={**os.environ, "GITHUB_ACTIONS": "true"})
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn("::error title=events_store.py check::", result.stdout)
            self.assertIn("a twice", result.stdout)


class ReadersTests(unittest.TestCase):
    def test_the_collector_stops_on_a_store_that_was_never_materialized(self):
        import collector
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / store.STORE).mkdir(parents=True)
            (Path(folder) / store.META).write_text("{}\n", encoding="utf-8")
            with mock.patch.object(collector, "OUTPUT_FILE", str(Path(folder) / "events.json")), \
                    self.assertRaisesRegex(RuntimeError, "not materialized"):
                collector.load_database_strict()


class RealDatabaseTests(unittest.TestCase):
    def test_the_real_database_round_trips_byte_for_byte(self):
        path = ROOT / "events.json"
        if not path.exists():
            self.skipTest("events.json is not materialized here")
        raw = path.read_bytes()
        value = store.parse(raw, "events.json")
        meta, files, regrouped, moved = store.split(value, "events.json")
        self.assertEqual(moved, [], "the real database is in month order")
        body, _ = store.rebuild(store.parse(store.canonical(meta), "meta"), files.get)
        self.assertEqual(body, raw)
        if (ROOT / store.META).exists() and store.in_git(ROOT):
            with mock.patch("sys.stdout", new=open(os.devnull, "w", encoding="utf-8")) as sink:
                store.check(ROOT)
                sink.close()


if __name__ == "__main__":
    unittest.main()
