"""Operator controls for historical retrieval only; never used by daily intake."""
import json
from pathlib import Path

CONFIG = 'backfill-control.json'


def disabled_categories(root):
    path = Path(root) / CONFIG
    data = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    disabled = data.get('disabled_categories', [])
    if not isinstance(disabled, list) or any(not isinstance(c, str) for c in disabled):
        raise ValueError('Invalid historical backfill controls')
    return set(disabled)


def enabled(root, category):
    return category not in disabled_categories(root)


def active_rows(report):
    return [row for row in report.get('categories', {}).values()
            if row.get('backfill_status') != 'cancelled']


def apply_to_collector(namespace, root):
    """Remove only cancelled historical discovery queries, after mode selection."""
    disabled = disabled_categories(root)
    for name in ('CATEGORIES', 'CORE_SEARCH_QUERIES', 'OFFICIAL_SOURCE_QUERIES',
                 'TARGETED_MEDIA_CATEGORY_TERMS'):
        for category in disabled:
            namespace[name].pop(category, None)
    for profile in namespace['MULTILINGUAL_PROFILES']:
        profile['queries'] = [q for q in profile.get('queries', [])
                              if q.get('category') not in disabled]
