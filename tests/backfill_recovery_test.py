"""The Boolean query splitter behind the RadNuc vocabulary and GDELT queries."""
import itertools
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT/'tools')]
import backfill_query as q


class QueryCompatibility(unittest.TestCase):
    def terms(self, query):
        return {tuple(term.strip('"') for term in pair) for pair in itertools.product(*q.groups(query))}

    def test_short_acronyms_unquoted_but_phrases_preserved(self):
        result=q.gdelt_queries('("ABC" OR "chemical incident") ("arrested" OR "investigation")')
        self.assertEqual(result,['(ABC OR "chemical incident") (arrested OR investigation)'])

    def test_splitting_is_equivalent_not_truncation_or_context_removal(self):
        source='("one long material phrase" OR "another long material phrase" OR "third specific phrase") ("arrested" OR "investigation" OR "prosecution")'
        result=q.gdelt_queries(source,max_bytes=85)
        self.assertGreater(len(result),1)
        self.assertTrue(all(len(x.encode())<=85 for x in result))
        self.assertEqual(set().union(*(self.terms(x) for x in result)),self.terms(source))

    def test_nested_unsupported_expression_is_not_silently_modified(self):
        with self.assertRaises(ValueError):q.gdelt_queries('((alpha OR beta) OR gamma) delta')


if __name__=='__main__':unittest.main()
