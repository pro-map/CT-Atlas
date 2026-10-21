"""Operator controls for historical retrieval only; never used by daily intake."""
import json
from pathlib import Path

CONFIG = 'backfill-control.json'


def history_enabled(root):
    """Global historical-discovery switch; daily intake remains independent."""
    path = Path(root) / CONFIG
    data = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    enabled = data.get('historical_enabled', True)
    if type(enabled) is not bool:
        raise ValueError('Invalid global historical backfill control')
    return enabled


def disabled_categories(root):
    path = Path(root) / CONFIG
    data = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    disabled = data.get('disabled_categories', [])
    if not isinstance(disabled, list) or any(not isinstance(c, str) for c in disabled):
        raise ValueError('Invalid historical backfill controls')
    return set(disabled)


def enabled(root, category):
    return history_enabled(root) and category not in disabled_categories(root)


def disabled_lanes(root):
    path = Path(root) / CONFIG
    data = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    lanes = data.get('disabled_lanes', [])
    if not isinstance(lanes, list) or any(not isinstance(lane, str) for lane in lanes):
        raise ValueError('Invalid historical backfill lane controls')
    return set(lanes)


def lane_enabled(root, lane):
    return history_enabled(root) and lane not in disabled_lanes(root)


def task_disabled(task, categories, lanes):
    return (task.get('category') in categories or
            ('chinese_map' in lanes and
             (task.get('group') == 'gemini_chinese_map' or
              (task.get('code') in ('zh', 'zh-Hant') and task.get('category') not in
               ('Radiological/Nuclear', 'Chemicals and Explosives', 'Biological Terrorism')))))


def active_rows(report):
    return [row for row in report.get('categories', {}).values()
            if row.get('backfill_status') != 'cancelled']


def apply_to_collector(namespace, root):
    """Remove only cancelled historical discovery queries, after mode selection."""
    disabled = disabled_categories(root)
    lanes = disabled_lanes(root)
    for name in ('CATEGORIES', 'CORE_SEARCH_QUERIES', 'OFFICIAL_SOURCE_QUERIES',
                 'TARGETED_MEDIA_CATEGORY_TERMS'):
        for category in disabled:
            namespace[name].pop(category, None)
    for profile in namespace['MULTILINGUAL_PROFILES']:
        profile['queries'] = [q for q in profile.get('queries', [])
                              if not task_disabled({**q, 'code':profile['code']}, disabled, lanes)]
