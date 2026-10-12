"""Compatibility API for the former historical-only native specialist seeds.

The authoritative terms now live in threat-category-keywords.json and serve
both daily intake and the historical planner. Existing query text is unchanged.
"""
import threat_categories as topics

VERSION = "historical-specialist-native-seeds-v1-20261011"
_chemical = topics.vocabulary()['chemical_explosives']
_biological = topics.vocabulary()['biological']
SEEDS = {
    code: (tuple(groups[0]), tuple(groups[1]),
           tuple(_biological['native_query_groups'][code][0]),
           tuple(_chemical['native_query_context'][code]))
    for code, groups in _chemical['native_query_groups'].items()
}
_group = topics.query_group


def queries(category, code):
    return topics.seed_queries(category, code)
