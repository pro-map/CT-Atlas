#!/usr/bin/env python3
"""Read-only full-snapshot validation of legacy record-key migration."""
import copy
import hashlib
import json
import tempfile
from collections import Counter
from pathlib import Path
import backfill_record_integrity as integrity


def blob(raw):
    return hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()


def main():
    path = Path("events.json")
    raw = path.read_bytes()
    data = json.loads(raw)
    original = copy.deepcopy(data)
    ledger_path = Path(integrity.DEFAULT_LEDGER)
    old_ledger = json.loads(ledger_path.read_text()) if ledger_path.exists() else None
    events = data["events"]
    counts = Counter(e["id"] for e in events)
    fixed, ledger, stats = integrity.plan(events, old_ledger)
    assert data == original, "Audit mutated input"
    assert len(fixed) == len(events)
    assert len({e["id"] for e in fixed}) == len(fixed)
    for old, new in zip(events, fixed):
        assert {k:v for k,v in old.items() if k != "id"} == {k:v for k,v in new.items() if k != "id"}
        if counts[old["id"]] == 1 and not old_ledger:
            assert old == new, "Singleton was changed"
    again, again_ledger, second = integrity.plan(fixed, ledger)
    assert second["records_rekeyed"] == 0 and again == fixed and again_ledger == ledger
    reverse, reverse_ledger, _ = integrity.plan(list(reversed(events)), old_ledger)
    assert list(reversed(reverse)) == fixed and reverse_ledger == ledger
    if blob(raw) == "9c2e25ba68de86eb5c661f9fa9dbb4a4ec76eee4":
        assert (len(events), stats["collision_groups_before"], stats["records_rekeyed"]) == (4242, 77, 980)
    retired = {row["old_id"] for row in ledger["migrations"]}
    integrity.references({k:v for k,v in data.items() if k != "events"}, retired)
    replay = {}
    for source in Path("archive").glob("*-selected-*.json"):
        rows = json.loads(source.read_text()).get("events", [])
        hits = sum(e.get("id") in retired for e in rows)
        if hits:
            replay[source.name] = hits
    assert not replay, "Retired record IDs occur in replay archive; inspect before migration"
    with tempfile.TemporaryDirectory() as folder:
        sample, log = Path(folder)/"events.json", Path(folder)/"ledger.json"
        sample.write_bytes(raw)
        if old_ledger:
            log.write_text(json.dumps(old_ledger))
        integrity.run(sample, log, apply=True)
        integrity.run(sample, log, check=True)
        output = sample.read_bytes()
        expected = copy.deepcopy(original)
        expected["events"] = fixed
        assert json.loads(output) == expected
        integrity.run(sample, log, apply=True)
        assert sample.read_bytes() == output, "Second file pass changed data"
    assert path.read_bytes() == raw, "Read-only audit wrote events.json"
    print("SNAPSHOT_VALIDATED " + integrity.canonical({**stats,
          "input_blob_sha": blob(raw), "output_blob_sha": blob(output),
          "all_non_id_fields_preserved": True, "second_pass_changes": 0,
          "archive_replay_conflicts": replay, "publication_confirmed": False}))


if __name__ == "__main__":
    main()
