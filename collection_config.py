"""Effective collector configuration: language inventory and validation.

The vocabularies are threat-category-keywords.json, radnuc.py and
radnuc-keywords.json. This module adds only the specialist source editions
missing from the daily collector. It never calls a provider or writes data.
"""
from __future__ import annotations
import copy
import json
from pathlib import Path

VERSION = "shared-collection-v1-20261012"
ROOT = Path(__file__).resolve().parent
# Same identities and ordering as the existing historical profiles. Locales
# select search editions, NOT incident locations. No invented local editions.
SPECIALIST_PROFILE_EXTENSIONS = (
    {"code":"hi","name":"Hindi","hl":"hi","gl":"IN","ceid":"IN:hi"},
    {"code":"bn","name":"Bengali","hl":"bn","gl":"BD","ceid":"BD:bn"},
    {"code":"id","name":"Indonesian","hl":"id","gl":"ID","ceid":"ID:id"},
    {"code":"pt","name":"Portuguese / Mozambique","hl":"pt-PT","gl":"PT","ceid":"PT:pt-150"},
    {"code":"so","name":"Somali","hl":"en-US","gl":"US","ceid":"US:en"},
    {"code":"ha","name":"Hausa","hl":"en-NG","gl":"NG","ceid":"NG:en"},
    {"code":"sw","name":"Swahili","hl":"en-US","gl":"US","ceid":"US:en"},
)


def extend_specialist_profiles(profiles):
    """Append independent, initially empty specialist profiles exactly once."""
    identity = lambda p: tuple(p[k] for k in ('code','hl','gl','ceid'))
    existing = {identity(p) for p in profiles}
    for profile in SPECIALIST_PROFILE_EXTENSIONS:
        if identity(profile) not in existing:
            profiles.append({**copy.deepcopy(profile), 'queries': [], 'sites': []})
            existing.add(identity(profile))


def language_metadata(profiles):
    codes = sorted({p['code'] for p in profiles if p.get('queries') or p.get('sites')})
    languages = {code.split('-')[0] for code in codes}
    return {
        'collection_languages': len(languages),
        'translated_languages': len(languages - {'en'}),
        'language_variants': len(codes),
        'translated_language_variants': len(set(codes) - {'en'}),
        'language_codes': codes,
    }


def effective(namespace):
    """Describe loaded queries, not an initial constant or completed coverage."""
    import threat_categories as topics
    profiles = namespace['MULTILINGUAL_PROFILES']
    meta = language_metadata(profiles)
    coverage = {}
    for label in topics.LABELS:
        per_code = {}
        for profile in profiles:
            per_code.setdefault(profile['code'], set()).update(
                q['term'] for q in profile.get('queries', []) if q.get('category') == label)
        per_code.setdefault('en', set()).update(namespace['CORE_SEARCH_QUERIES'].get(label, []))
        coverage[label] = {code: len(queries) for code, queries in sorted(per_code.items())}
    return {
        'version': VERSION, **meta,
        'specialist_categories': list(topics.LABELS),
        'specialist_queries_by_code': coverage,
        'vocabulary_sources': {
            topics.RN: ['radnuc.py', 'radnuc-keywords.json', 'radnuc_vocabulary.py'],
            topics.CE: ['threat-category-keywords.json'],
            topics.BIO: ['threat-category-keywords.json'],
        },
        'coverage_note': 'Configured queries, not completed retrieval or exhaustive coverage. Some added daily editions search specialist topics only; one Chinese language uses two writing systems.',
    }


def validate_runtime(namespace, path=None):
    """Fail before collection if runtime labels or loaded source queries drift."""
    report = effective(namespace)
    runtime = json.loads(Path(path or ROOT / 'ct-atlas-runtime.json').read_text(encoding='utf-8'))
    expected = language_metadata(namespace['MULTILINGUAL_PROFILES'])
    for key, value in expected.items():
        if runtime.get(key) != value:
            raise ValueError(f'Runtime language metadata disagrees with loaded collector: {key}')
    import threat_categories as topics
    if set(namespace['CATEGORIES']) & topics.LEGACY:
        raise ValueError('Legacy CBRN parent remains in active categories')
    for label, counts in report['specialist_queries_by_code'].items():
        if set(counts) != set(expected['language_codes']) or not all(counts.values()):
            raise ValueError(f'Missing native specialist search coverage: {label}')
    return report
