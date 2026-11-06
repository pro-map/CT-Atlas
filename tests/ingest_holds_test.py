"""Re-dated archive articles, marked at ingest (audit of 2026-11-05). The mark
travels with the record; attack_points decides at publication, so a second outlet
ends the hold without anything rewriting the stored record."""
import contextlib
import io
import unittest

import attack_points
import collector


def item(title, source='Le Monde.fr', published='2026-11-04T17:11:00+00:00', **fields):
    return {'title': title, 'original_title': title, 'summary': '', 'url': 'https://example.test/' + title.replace(' ', '-'),
            'source': source, 'published': published, 'collector': 'Google News RSS', **fields}


def marked(records):
    collector.COLLECTION_STATS.clear()
    with contextlib.redirect_stdout(io.StringIO()):
        return collector.mark_corroboration_holds(records)


class MarkAtIngestTests(unittest.TestCase):
    def test_four_items_of_one_outlet_in_one_minute_are_marked(self):
        records = marked([item(f'Headline {n}') for n in range(4)] + [item('Other minute', published='2026-11-04T17:12:00+00:00')])
        self.assertEqual([record.get('corroboration_hold') for record in records],
                         ['same_minute_burst'] * 4 + [None])

    def test_three_items_are_not_and_one_article_found_by_many_queries_counts_once(self):
        self.assertFalse(any('corroboration_hold' in record for record in marked([item(f'Headline {n}') for n in range(3)])))
        self.assertFalse(any('corroboration_hold' in record for record in marked([item('Same headline') for _ in range(9)])))

    def test_the_date_only_stamps_of_the_daily_queue_are_no_burst(self):
        # 2026-11-05 queue: Daily Trust, seven candidates on 2026-09-04 at 07:00:00.
        records = marked([item(f'Headline {n}', 'Daily Trust', '2026-09-04T07:00:00+00:00') for n in range(7)])
        self.assertFalse(any('corroboration_hold' in record for record in records))

    def test_gdelt_crawl_times_are_no_burst(self):
        records = marked([item(f'Headline {n}', 'dw.com', collector='GDELT DOC 2.0') for n in range(6)])
        self.assertFalse(any('corroboration_hold' in record for record in records))

    def test_every_item_of_a_listed_outlet_is_marked(self):
        records = marked([item('Van\'da terör saldırısı', 'Haber 7'), item('Au moins 235 morts', 'Orange Actualités')])
        self.assertEqual({record['corroboration_hold'] for record in records}, {'listed_outlet'})

    def test_the_mark_leaves_cached_decisions_valid(self):
        record = item('Headline')
        fingerprint = collector.selection_fingerprint(record)
        marked([record] * 1 + [item(f'Other {n}') for n in range(3)])
        self.assertEqual(record['corroboration_hold'], 'same_minute_burst')
        self.assertEqual(collector.selection_fingerprint(record), fingerprint)


class MergeTests(unittest.TestCase):
    def test_a_second_outlet_merged_into_the_record_ends_the_hold(self):
        held = item('Headline', 'Haber 7', corroboration_hold='listed_outlet')
        self.assertEqual(attack_points.held_indexes([held]), {0})
        collector.merge_event(held, item('Rewrite', 'TRT Haber'))
        self.assertEqual(held['sources'], ['Haber 7', 'TRT Haber'])
        self.assertEqual(attack_points.held_indexes([held]), set())

    def test_the_mark_survives_when_the_marked_article_is_not_the_lead(self):
        lead = item('Lead', 'verify-sy.com')
        collector.merge_event(lead, item('Folded', 'verify-sy.com', corroboration_hold='same_minute_burst'))
        self.assertEqual(lead['corroboration_hold'], 'same_minute_burst')
        self.assertEqual(attack_points.held_indexes([lead]), {0})


if __name__ == '__main__':
    unittest.main()
