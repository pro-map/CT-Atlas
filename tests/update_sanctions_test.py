import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

# No network is needed: the updater is exercised against a small synthetic sdn.xml
# that mirrors the real file's structure (default XML namespace, idList records).
spec = importlib.util.spec_from_file_location('update_sanctions', 'tools/update_sanctions.py')
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)

NS = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML'
BTC = '1HB5XMLmzFVj8ALj6mfBsbifRoD4miY36v'
EVM_MIXED = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01'
TRON = 'TA3941uFAvmVibSkQ6fMJXxmaSNovX86mz'


def entry(uid, name, programs, addresses, sdn_type='Entity'):
    ids = ''.join(
        f'<id><uid>{uid}0{i}</uid><idType>Digital Currency Address - {cur}</idType><idNumber>{addr}</idNumber></id>'
        for i, (cur, addr) in enumerate(addresses)
    )
    progs = ''.join(f'<program>{p}</program>' for p in programs)
    return (
        f'<sdnEntry><uid>{uid}</uid><lastName>{name}</lastName><sdnType>{sdn_type}</sdnType>'
        f'<programList>{progs}</programList><idList>{ids}</idList></sdnEntry>'
    )


def sdn_xml(entries, published='09/23/2026'):
    return (
        f'<?xml version="1.0" encoding="UTF-8"?><sdnList xmlns="{NS}">'
        f'<publshInformation><Publish_Date>{published}</Publish_Date><Record_Count>{len(entries)}</Record_Count></publshInformation>'
        + ''.join(entries) + '</sdnList>'
    ).encode('utf-8')


class ParseTests(unittest.TestCase):
    def setUp(self):
        self.raw = sdn_xml([
            entry('1', 'TERROR FUND', ['SDGT', 'FTO'], [('XBT', BTC + '.'), ('ETH', EVM_MIXED), ('USDT', TRON)]),
            entry('2', 'IRAN BANK', ['IRAN'], [('XBT', BTC), ('XMR', '4' + 'A' * 94)]),
            # A non-crypto designation must not produce any record.
            '<sdnEntry><uid>3</uid><lastName>NO CRYPTO</lastName><sdnType>Individual</sdnType>'
            '<programList><program>SDGT</program></programList>'
            '<idList><id><uid>30</uid><idType>Passport</idType><idNumber>X123</idNumber></id></idList></sdnEntry>',
        ])
        self.doc = u.build_document(self.raw, 'https://example.test/sdn.xml',
                                    datetime(2026, 9, 24, 12, 0, 0, tzinfo=timezone.utc))

    def test_only_entries_with_crypto_addresses_are_kept(self):
        self.assertEqual([e['name'] for e in self.doc['entities']], ['TERROR FUND', 'IRAN BANK'])
        self.assertEqual(self.doc['sources'][0]['published'], '2026-09-23')

    def test_trailing_period_artifact_is_stripped_and_duplicates_are_merged(self):
        btc = [a for a in self.doc['addresses'] if a['f'] == 'bitcoin']
        self.assertEqual(len(btc), 1, 'the same address under two entities must be one record')
        self.assertEqual(btc[0]['a'], BTC)
        self.assertEqual(btc[0]['e'], [0, 1], 'both listing entities must be preserved')

    def test_evm_is_lowercased_and_families_are_classified(self):
        by_family = {a['f']: a for a in self.doc['addresses']}
        self.assertEqual(by_family['evm']['a'], EVM_MIXED.lower())
        self.assertEqual(by_family['tron']['a'], TRON)
        self.assertEqual(by_family['other']['c'], 'XMR')

    def test_terrorism_programs_are_distinguished_from_other_programs(self):
        flags = {e['name']: e['terrorism'] for e in self.doc['entities']}
        self.assertTrue(flags['TERROR FUND'])
        self.assertFalse(flags['IRAN BANK'], 'IRAN-program listings must not be labelled terrorism')

    def test_output_is_deterministic_and_sorted(self):
        again = u.build_document(self.raw, 'https://example.test/sdn.xml',
                                 datetime(2026, 9, 24, 12, 0, 0, tzinfo=timezone.utc))
        self.assertEqual(json.dumps(self.doc, sort_keys=True), json.dumps(again, sort_keys=True))
        keys = [(a['f'], a['a']) for a in self.doc['addresses']]
        self.assertEqual(keys, sorted(keys))


class ShippedFileTests(unittest.TestCase):
    """Guards against the original sdn.csv bug: its Remarks column is length-capped,
    silently truncating the last address of long entries."""

    def test_shipped_addresses_have_valid_full_length_formats(self):
        data = json.loads(Path('sanctions-crypto.json').read_text(encoding='utf-8'))
        for item in data['addresses']:
            if item['f'] == 'evm':
                self.assertRegex(item['a'], r'^0x[0-9a-f]{40}$')
            elif item['f'] == 'tron':
                self.assertRegex(item['a'], r'^T[1-9A-HJ-NP-Za-km-z]{33}$')
            elif item['f'] == 'bitcoin':
                self.assertEqual(u.classify(item['a']), 'bitcoin', item['a'])
            self.assertFalse(item['a'].endswith('.'), item['a'])


class MainTests(unittest.TestCase):
    def run_main(self, raw, output):
        source = Path(output).with_suffix('.xml')
        source.write_bytes(raw)
        return u.main(['--input', str(source), '--output', str(output)])

    def test_writes_then_skips_an_unchanged_list(self):
        raw = sdn_xml([entry('1', 'A', ['SDGT'], [('XBT', BTC)])])
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / 'sanctions.json'
            self.assertEqual(self.run_main(raw, out), 0)
            first = out.read_text(encoding='utf-8')
            self.assertEqual(self.run_main(raw, out), 0)
            self.assertEqual(out.read_text(encoding='utf-8'), first, 'identical list must not be rewritten')

    def test_rewrites_when_the_list_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / 'sanctions.json'
            self.run_main(sdn_xml([entry('1', 'A', ['SDGT'], [('XBT', BTC)])]), out)
            self.run_main(sdn_xml([entry('1', 'A', ['SDGT'], [('XBT', BTC), ('USDT', TRON)])]), out)
            self.assertEqual(len(json.loads(out.read_text(encoding='utf-8'))['addresses']), 2)

    def test_refuses_empty_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / 'sanctions.json'
            self.assertEqual(self.run_main(sdn_xml([]), out), 1)
            self.assertFalse(out.exists())

    def test_refuses_to_overwrite_with_a_suspiciously_smaller_list(self):
        many = [entry(str(i), f'E{i}', ['SDGT'], [('ETH', '0x' + f'{i:040x}')]) for i in range(1, 11)]
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / 'sanctions.json'
            self.assertEqual(self.run_main(sdn_xml(many), out), 0)
            before = out.read_text(encoding='utf-8')
            self.assertEqual(self.run_main(sdn_xml(many[:3]), out), 1)
            self.assertEqual(out.read_text(encoding='utf-8'), before, 'the existing list must be kept')


class UnchangedTests(unittest.TestCase):
    def doc(self, published='2026-09-23'):
        return {'sources': [{'published': published}], 'entities': [{'id': '1'}], 'addresses': [{'a': 'x'}]}

    def test_identical_recent_list_is_unchanged(self):
        now = datetime(2026, 9, 24, tzinfo=timezone.utc)
        existing = {**self.doc(), 'retrieved_at': '2026-09-23T10:00:00Z'}
        self.assertTrue(u.is_unchanged(existing, self.doc(), now))

    def test_old_timestamp_forces_a_refresh_so_staleness_stays_meaningful(self):
        now = datetime(2026, 9, 24, tzinfo=timezone.utc)
        existing = {**self.doc(), 'retrieved_at': (now - timedelta(days=4)).strftime('%Y-%m-%dT%H:%M:%SZ')}
        self.assertFalse(u.is_unchanged(existing, self.doc(), now))

    def test_new_publish_date_or_content_is_a_change(self):
        now = datetime(2026, 9, 24, tzinfo=timezone.utc)
        existing = {**self.doc(), 'retrieved_at': '2026-09-23T10:00:00Z'}
        self.assertFalse(u.is_unchanged(existing, self.doc(published='2026-09-24'), now))
        changed = self.doc()
        changed['addresses'] = [{'a': 'y'}]
        self.assertFalse(u.is_unchanged(existing, changed, now))

    def test_missing_or_garbled_existing_file_is_a_change(self):
        now = datetime(2026, 9, 24, tzinfo=timezone.utc)
        self.assertFalse(u.is_unchanged(None, self.doc(), now))
        self.assertFalse(u.is_unchanged({**self.doc(), 'retrieved_at': 'garbage'}, self.doc(), now))


if __name__ == '__main__':
    unittest.main()
