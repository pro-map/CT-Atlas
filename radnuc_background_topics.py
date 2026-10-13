"""Daily archive-only RADNUC background vocabulary, separate from CT discovery.

This module supplies public-news queries and review criteria only. It neither
fetches articles nor changes the Map selector, daily CT vocabulary or backfill.
Native searches are curated broad discovery queries, not a claim that every
English term has been translated into all languages.
"""
from __future__ import annotations

import copy
import json
from functools import lru_cache
from pathlib import Path

CONFIG = Path(__file__).with_name('radnuc-background-keywords.json')
EXPECTED_CODES = frozenset((
    'en', 'fr', 'ar', 'de', 'es', 'it', 'tr', 'ru', 'ur', 'fa', 'ps',
    'he', 'pt', 'hi', 'bn', 'id', 'so', 'ha', 'sw', 'zh', 'zh-Hant',
))
TOPIC_IDS = (
    'regulation_and_licensing', 'emergency_exercises',
    'safety_security_meetings', 'industry_supply_chain',
    'civilian_facility_protests', 'iaea_guidance', 'facility_cybersecurity',
    'industry_ai_applications', 'frontier_ai_cbrn_guardrails',
    'science_and_technology',
)


def _validate_query(query):
    if not isinstance(query, str) or not query.strip() or '\n' in query:
        raise ValueError('Empty or invalid RN background query')
    if query.count('"') % 2:
        raise ValueError('Unbalanced quotation marks in RN background query')
    depth = 0
    quoted = False
    for char in query:
        if char == '"':
            quoted = not quoted
        elif not quoted:
            depth += (char == '(') - (char == ')')
            if depth < 0:
                raise ValueError('Unbalanced RN background query parentheses')
    if depth:
        raise ValueError('Unbalanced RN background query parentheses')


@lru_cache(maxsize=1)
def vocabulary():
    data = json.loads(CONFIG.read_text(encoding='utf-8'))
    if (data.get('category') != 'Radiological/Nuclear'
            or data.get('record_type') != 'background'
            or data.get('archive_only') is not True
            or data.get('collection') != 'daily_only'
            or data.get('screening_basis') != 'title_and_excerpt'):
        raise ValueError('RN background must remain daily and archive-only')
    topics = data.get('topics', [])
    if tuple(topic.get('id') for topic in topics) != TOPIC_IDS:
        raise ValueError('RN background requires the ten requested topics')
    if set(data.get('native_queries', {})) | {'en'} != EXPECTED_CODES:
        raise ValueError('RN background native language coverage disagrees')
    for topic in topics:
        if any(not topic.get(field) for field in ('label', 'include', 'exclude')):
            raise ValueError('Missing RN background topic review criteria')
        _validate_query(topic.get('query'))
    for native_queries in data['native_queries'].values():
        if not isinstance(native_queries, list) or not 1 <= len(native_queries) <= 2:
            raise ValueError('RN background requires 1-2 native discovery queries')
        for query in native_queries:
            _validate_query(query)
    return data


def queries(code='en'):
    """Return a fresh list of exact English or curated native Google queries."""
    data = vocabulary()
    if code == 'en':
        return [topic['query'] for topic in data['topics']]
    if code not in EXPECTED_CODES:
        raise ValueError(f'Unsupported RN background language: {code}')
    return list(data['native_queries'][code])


def topic_ids():
    return list(TOPIC_IDS)


def topic_metadata():
    """Return isolated review metadata, so callers cannot mutate cached config."""
    return copy.deepcopy(vocabulary()['topics'])


def selection_note():
    """High-level title/excerpt review instruction; this is not Map selection."""
    data = vocabulary()
    lines = [
        'Review only the supplied public-news title and source excerpt.',
        'Select dated Radiological/Nuclear BACKGROUND updates for the daily',
        'archive only. Never classify these records as CT Map incidents.',
        'No terrorism/criminal nexus is required. Do not infer missing facts.',
        *data['include_rules'], *data['exclude_rules'],
        'Eligible topic IDs and criteria:',
    ]
    for topic in data['topics']:
        lines.append(f"{topic['id']}: {topic['include']} Exclude: {topic['exclude']}")
    return '\n'.join(lines)


SELECTION_NOTE = selection_note()
