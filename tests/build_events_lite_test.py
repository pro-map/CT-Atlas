import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('build_events_lite', 'tools/build_events_lite.py')
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


def sample_database():
    return {
        'project': 'CT Atlas',
        'last_updated': '2026-09-26T10:00:00Z',
        'trend_summary': {'overview': 'kept as is'},
        'events': [
            {
                'id': 'a1', 'published': '2026-09-25T08:00:00Z', 'title': 'First',
                'country': 'Nigeria', 'is_attack': True, 'incident_id': 'i-1',
                'related_articles': [{'title': 'x' * 200}], 'ai_geo_model': 'm',
            },
            {
                'id': 'a2', 'published': '2026-09-24T08:00:00Z', 'title': 'Second',
                'latitude': 12.5, 'longitude': -3.25, 'brand_new_field': 'kept because not excluded',
            },
        ],
    }


class BuildLiteTest(unittest.TestCase):
    def test_removes_only_the_excluded_fields(self):
        database = sample_database()
        lite = b.build_lite(database, ['related_articles', 'ai_geo_model'])
        self.assertEqual(lite['events'][0], {
            'id': 'a1', 'published': '2026-09-25T08:00:00Z', 'title': 'First',
            'country': 'Nigeria', 'is_attack': True, 'incident_id': 'i-1',
        })

    def test_a_field_that_is_not_excluded_is_kept_even_if_the_collector_adds_it_later(self):
        lite = b.build_lite(sample_database(), ['related_articles'])
        self.assertEqual(lite['events'][1]['brand_new_field'], 'kept because not excluded')

    def test_keeps_every_top_level_key_and_marks_the_file(self):
        database = sample_database()
        lite = b.build_lite(database, ['related_articles'])
        for key in database:
            if key != 'events':
                self.assertEqual(lite[key], database[key])
        self.assertEqual(lite['lite']['format'], b.FORMAT)
        self.assertEqual(lite['lite']['source_event_count'], 2)
        self.assertEqual(lite['lite']['excluded_fields'], ['related_articles'])

    def test_does_not_modify_the_source_database(self):
        database = sample_database()
        b.build_lite(database, ['related_articles'])
        self.assertIn('related_articles', database['events'][0])

    def test_refuses_an_empty_or_malformed_source(self):
        with self.assertRaises(ValueError):
            b.build_lite({'events': []}, ['x'])
        with self.assertRaises(ValueError):
            b.build_lite({'events': 'nope'}, ['x'])
        with self.assertRaises(ValueError):
            b.build_lite({'events': [1]}, ['x'])

    def test_required_fields_cannot_be_excluded(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'excluded.json'
            for name in ('id', 'published', 'title'):
                path.write_text(json.dumps(['related_articles', name]), encoding='utf-8')
                with self.assertRaises(ValueError):
                    b.load_excluded(path)

    def test_rejects_a_bad_exclusion_list(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'excluded.json'
            for bad in ('[]', '{}', '["a", "a"]', '[1]', '[""]'):
                path.write_text(bad, encoding='utf-8')
                with self.assertRaises(ValueError, msg=bad):
                    b.load_excluded(path)

    def test_the_committed_exclusion_list_is_valid(self):
        excluded = b.load_excluded()
        self.assertGreater(len(excluded), 20)
        self.assertEqual(excluded, sorted(excluded))

    def test_validate_detects_a_lite_that_lost_something_else(self):
        database = sample_database()
        lite = b.build_lite(database, ['related_articles'])
        b.validate(lite, database)
        del lite['events'][1]['latitude']
        with self.assertRaises(ValueError):
            b.validate(lite, database)

    def test_validate_detects_a_dropped_event_or_top_level_key(self):
        database = sample_database()
        lite = b.build_lite(database, ['related_articles'])
        lite['events'].pop()
        with self.assertRaises(ValueError):
            b.validate(lite, database)
        lite = b.build_lite(database, ['related_articles'])
        del lite['trend_summary']
        with self.assertRaises(ValueError):
            b.validate(lite, database)


class MainTest(unittest.TestCase):
    def run_main(self, tmp, database_text, excluded=('related_articles',)):
        source = Path(tmp) / 'events.json'
        source.write_text(database_text, encoding='utf-8')
        excluded_path = Path(tmp) / 'excluded.json'
        excluded_path.write_text(json.dumps(list(excluded)), encoding='utf-8')
        output = Path(tmp) / 'out' / 'events-lite.json'
        code = b.main(['--input', str(source), '--output', str(output), '--excluded', str(excluded_path)])
        return code, output

    def test_writes_compact_valid_json_that_is_smaller(self):
        with tempfile.TemporaryDirectory() as tmp:
            text = json.dumps(sample_database(), indent=2)
            code, output = self.run_main(tmp, text)
            self.assertEqual(code, 0)
            written = output.read_text(encoding='utf-8')
            self.assertLess(len(written), len(text))
            self.assertNotIn('\n', written)
            events = json.loads(written)['events']
            self.assertEqual(events[0]['id'], 'a1')
            self.assertTrue(all('related_articles' not in event for event in events))

    def test_keeps_non_ascii_text_readable(self):
        with tempfile.TemporaryDirectory() as tmp:
            database = sample_database()
            database['events'][0]['title'] = 'Attentat à Ouagadougou — 内'
            code, output = self.run_main(tmp, json.dumps(database, ensure_ascii=True))
            self.assertEqual(code, 0)
            self.assertIn('Attentat à Ouagadougou — 内', output.read_text(encoding='utf-8'))

    def test_a_broken_source_builds_nothing_and_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            for text in ('{not json', '[]', '{"events": []}'):
                code, output = self.run_main(tmp, text)
                self.assertEqual(code, 1, text)
                self.assertFalse(output.exists(), text)

    def test_a_missing_source_fails_without_writing(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'events-lite.json'
            code = b.main(['--input', str(Path(tmp) / 'absent.json'), '--output', str(output)])
            self.assertEqual(code, 1)
            self.assertFalse(output.exists())

    def test_a_failed_build_never_replaces_an_existing_good_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, output = self.run_main(tmp, json.dumps(sample_database()))
            self.assertEqual(code, 0)
            good = output.read_bytes()
            source = Path(tmp) / 'events.json'
            source.write_text('{"events": []}', encoding='utf-8')
            code = b.main(['--input', str(source), '--output', str(output),
                           '--excluded', str(Path(tmp) / 'excluded.json')])
            self.assertEqual(code, 1)
            self.assertEqual(output.read_bytes(), good)
            self.assertEqual([p.name for p in output.parent.iterdir()], ['events-lite.json'])


if __name__ == '__main__':
    unittest.main()
