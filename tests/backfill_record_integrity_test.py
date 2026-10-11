import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import backfill_record_integrity as integrity


def record(suffix='one', **values):
    data = {'id': 'legacy', 'url': 'https://example.org/' + suffix,
            'original_title': 'عنوان ' + suffix, 'published': '2026-09-07T12:00:00+00:00',
            'title': 'Translated headline', 'incident_id': 'inc-real-case',
            'latitude': 35.0, 'longitude': 44.0}
    data.update(values)
    return data


class RecordIntegrityTest(unittest.TestCase):
    def test_all_records_and_every_non_id_field_preserved(self):
        events = [record(), record('two', country='different'), record('three', id='unique')]
        before = copy.deepcopy(events)
        fixed, ledger, stats = integrity.plan(events)
        self.assertEqual(events, before)
        self.assertEqual(stats['records_rekeyed'], 2)
        self.assertEqual(len({e['id'] for e in fixed}), 3)
        self.assertEqual(fixed[2], events[2])
        for old, new in zip(events, fixed):
            self.assertEqual({k: v for k, v in old.items() if k != 'id'},
                             {k: v for k, v in new.items() if k != 'id'})
        self.assertEqual(len(ledger['migrations']), 2)

    def test_stable_on_reorder_and_second_pass(self):
        events = [record(), record('two')]
        fixed, ledger, _ = integrity.plan(events)
        reverse, reverse_ledger, _ = integrity.plan(list(reversed(events)))
        self.assertEqual(fixed, list(reversed(reverse)))
        self.assertEqual(ledger, reverse_ledger)
        second, second_ledger, stats = integrity.plan(fixed, ledger)
        self.assertEqual(stats['records_rekeyed'], 0)
        self.assertEqual(second, fixed)
        self.assertEqual(second_ledger, ledger)

    def test_same_incident_different_source_records_not_merged(self):
        fixed, _, _ = integrity.plan([record(), record('followup', update_type='FOLLOW_UP')])
        self.assertNotEqual(fixed[0]['id'], fixed[1]['id'])
        self.assertEqual(fixed[0]['incident_id'], fixed[1]['incident_id'])

    def test_exact_copy_requires_review_not_new_id(self):
        events = [record(), record()]
        with self.assertRaises(ValueError):
            integrity.plan(events)
        self.assertEqual(events[0], events[1])

    def test_same_source_different_ai_fields_also_refused(self):
        with self.assertRaises(ValueError):
            integrity.plan([record(), record(latitude=0, title='Different translation')])

    def test_missing_or_invalid_evidence_no_mutation(self):
        for field, value in [('id', ''), ('url', ''), ('url', 'file:///data'),
                             ('original_title', None), ('published', 'invalid')]:
            records = [record(), record('two', **{field: value})]
            before = copy.deepcopy(records)
            with self.subTest(field=field), self.assertRaises(ValueError):
                integrity.plan(records)
            self.assertEqual(records, before)

    def test_malformed_database(self):
        for data in ([], {}, [None], [{'id': 7}]):
            with self.subTest(data=data), self.assertRaises(ValueError):
                integrity.plan(data)

    def test_existing_singletons_unchanged_even_without_source(self):
        events = [{'id': 'unique', 'legacy': 'metadata'}]
        fixed, _, stats = integrity.plan(events)
        self.assertEqual(fixed, events)
        self.assertEqual(stats['records_rekeyed'], 0)

    def test_existing_and_planned_replacement_collisions_refused(self):
        events = [record(), record('two')]
        replacement = integrity.replacement_id('legacy', integrity.fingerprint(events[0]))
        with self.assertRaises(ValueError):
            integrity.plan(events + [record('three', id=replacement)])
        with patch.object(integrity, 'replacement_id', return_value='constant'):
            with self.assertRaises(ValueError):
                integrity.plan(events)

    def test_ambiguous_live_reference_refuses(self):
        events = [record(), record('two'), record('three', id='unique', parent_event_id='legacy')]
        with self.assertRaises(ValueError):
            integrity.plan(events)

    def test_incident_reference_is_not_a_record_reference(self):
        events = [record(incident_id='legacy'), record('two', incident_id='legacy')]
        fixed, _, _ = integrity.plan(events)
        self.assertEqual([e['incident_id'] for e in fixed], ['legacy', 'legacy'])

    def test_known_replay_after_interrupted_migration_stable(self):
        events = [record(), record('two')]
        fixed, ledger, _ = integrity.plan(events)
        again, _, _ = integrity.plan(events, ledger)
        self.assertEqual(again, fixed)
        replay, _, _ = integrity.plan([events[0]], ledger)
        self.assertEqual(replay, fixed[:1])

    def test_unknown_retired_identity_and_duplicate_replay_fail_closed(self):
        fixed, ledger, _ = integrity.plan([record(), record('two')])
        with self.assertRaises(ValueError):
            integrity.plan([record('new-source')], ledger)
        with self.assertRaises(ValueError):
            integrity.plan(fixed + [record()], ledger)

    def test_malformed_ledger_refused(self):
        _, ledger, _ = integrity.plan([record(), record('two')])
        variants = [{}, {'version': 'wrong', 'migrations': []}, copy.deepcopy(ledger)]
        variants[-1]['migrations'][0]['new_id'] = 'wrong'
        for value in variants:
            with self.subTest(value=value), self.assertRaises(ValueError):
                integrity.plan([record()], value)

    def test_check_has_no_writes_and_rejects_duplicates(self):
        with tempfile.TemporaryDirectory() as folder:
            path, ledger = Path(folder)/'events.json', Path(folder)/'ledger.json'
            path.write_text(json.dumps({'events': [record()]}))
            before = path.read_bytes()
            integrity.run(path, ledger, check=True)
            self.assertEqual(path.read_bytes(), before)
            self.assertFalse(ledger.exists())
            path.write_text(json.dumps({'events': [record(), record('two')]}))
            with self.assertRaises(ValueError):
                integrity.run(path, ledger, check=True)

    def test_file_write_metadata_and_idempotence(self):
        with tempfile.TemporaryDirectory() as folder:
            path, ledger = Path(folder)/'events.json', Path(folder)/'ledger.json'
            path.write_text(json.dumps({'last_updated': 'unchanged', 'events': [record(), record('two')]}))
            before = path.read_bytes()
            integrity.run(path, ledger)
            self.assertEqual(path.read_bytes(), before)
            self.assertFalse(ledger.exists())
            integrity.run(path, ledger, apply=True)
            first = path.read_bytes(), ledger.read_bytes()
            self.assertEqual(json.loads(first[0])['last_updated'], 'unchanged')
            integrity.run(path, ledger, apply=True)
            self.assertEqual(first, (path.read_bytes(), ledger.read_bytes()))
            integrity.run(path, ledger, check=True)

    def test_failed_database_replace_recoverable_from_durable_ledger(self):
        with tempfile.TemporaryDirectory() as folder:
            path, ledger = Path(folder)/'events.json', Path(folder)/'ledger.json'
            path.write_text(json.dumps({'events': [record(), record('two')]}))
            before = path.read_bytes()
            real_replace = integrity.os.replace
            def fail_db(source, destination):
                if Path(destination) == path:
                    raise OSError('Simulated interruption after ledger saved')
                real_replace(source, destination)
            with patch.object(integrity.os, 'replace', side_effect=fail_db):
                with self.assertRaises(OSError):
                    integrity.run(path, ledger, apply=True)
            self.assertEqual(path.read_bytes(), before)
            self.assertTrue(ledger.exists())
            self.assertEqual(list(Path(folder).glob('*.tmp')), [])
            integrity.run(path, ledger, apply=True)
            self.assertEqual(len({e['id'] for e in json.loads(path.read_text())['events']}), 2)

    def test_check_rejects_singleton_retired_key(self):
        with tempfile.TemporaryDirectory() as folder:
            path, ledger_path = Path(folder)/'events.json', Path(folder)/'ledger.json'
            _, ledger, _ = integrity.plan([record(), record('two')])
            ledger_path.write_text(json.dumps(ledger))
            path.write_text(json.dumps({'events': [record()]}))
            with self.assertRaises(ValueError):
                integrity.run(path, ledger_path, check=True)

    def test_file_proof_matches_written_git_blob(self):
        import hashlib
        with tempfile.TemporaryDirectory() as folder:
            path, ledger = Path(folder)/'events.json', Path(folder)/'ledger.json'
            path.write_text(json.dumps({'events': [record(), record('two')]}))
            integrity.run(path, ledger, apply=True)
            raw = path.read_bytes()
            expected = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
            proof = json.loads(ledger.read_text())['last_migration']
            self.assertEqual(proof['output_blob_sha'], expected)
            self.assertFalse(proof['publication_confirmed'])

    def test_failed_ledger_write_never_changes_database(self):
        with tempfile.TemporaryDirectory() as folder:
            path, ledger = Path(folder)/'events.json', Path(folder)/'ledger.json'
            path.write_text(json.dumps({'events': [record(), record('two')]}))
            before = path.read_bytes()
            with patch.object(integrity.os, 'replace', side_effect=OSError('Ledger failure')):
                with self.assertRaises(OSError):
                    integrity.run(path, ledger, apply=True)
            self.assertEqual(path.read_bytes(), before)
            self.assertFalse(ledger.exists())


if __name__ == '__main__':
    unittest.main()
