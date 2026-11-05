"""Shared user-supplied RN vocabulary for daily retrieval and incremental history.

This adds discovery queries; it does not weaken the existing CT publication
criteria. The old multilingual queries and saved task identities remain intact.
"""
from __future__ import annotations
import json
from functools import lru_cache
from pathlib import Path
from tools.backfill_query import gdelt_queries

CONFIG = Path(__file__).with_name('radnuc-keywords.json')


@lru_cache(maxsize=1)
def vocabulary():
    data = json.loads(CONFIG.read_text(encoding='utf-8'))
    if data.get('category') != 'Radiological/Nuclear':
        raise ValueError('Incorrect RN category in keyword configuration')
    groups = data.get('keyword_groups') or []
    terms = [term for group in groups for term in group.get('terms', [])]
    if not terms or any(not isinstance(t,str) or not t.strip() for t in terms):
        raise ValueError('Invalid or empty RN keyword')
    if len({t.casefold() for t in terms}) != len(terms):
        raise ValueError('Duplicate RN keywords; retain one canonical spelling per entry')
    for group in groups:
        if group.get('retrieval') not in ('incident_context_required','specific_phrase'):
            raise ValueError('Unknown RN retrieval mode')
    return data


def all_terms():
    return [term for group in vocabulary()['keyword_groups'] for term in group['terms']]


def quote(term):
    if '"' in term or '\n' in term:
        raise ValueError('Unsupported quote or newline in curated query term')
    return '"'+term+'"' if any(c.isspace() for c in term) else term


@lru_cache(maxsize=4)
def _queries(code='en'):
    if code != 'en':
        return ()  # Existing native-language searches remain managed by radnuc.py.
    config = vocabulary()
    contextual, direct = [], []
    overrides = set(config.get('contextual_overrides', []))
    for group in config['keyword_groups']:
        for term in group['terms']:
            target = contextual if group['retrieval']=='incident_context_required' or term in overrides else direct
            target.append(term)
    raw = []
    for terms, contexts in ((direct,[[]]),(contextual,config['context_groups'])):
        for start in range(0,len(terms),6):
            material = '('+' OR '.join(map(quote,terms[start:start+6]))+')'
            for context in contexts:
                query = material + (' ('+' OR '.join(map(quote,context))+')' if context else '')
                raw.extend(gdelt_queries(query))
    # One provider-compatible vocabulary powers every entry point, including
    # daily GDELT queries. No short single tokens incorrectly quoted as phrases.
    return tuple(dict.fromkeys(raw))


def queries(code='en'):
    if code in CHINESE_SUPPLEMENT_QUERIES:
        return list(CHINESE_SUPPLEMENT_QUERIES[code]['queries'])
    return list(_queries(code))


# Complementary Chinese-language Google News searches for the SAME user-supplied
# 181-term RN collection. These are curated native equivalents of select material
# classes, NOT a claim that all 181 English names have been individually translated.
# The unchanged full 181-entry vocabulary continues through English Google News
# and GDELT's multilingual index, including Chinese-indexed reporting.
# Shared by daily retrieval and the fixed six-month supplemental backfill.
CHINESE_SUPPLEMENT_QUERIES = {
    "zh": {
        "name": "Chinese (Simplified) RN supplement",
        "hl": "zh-CN", "gl": "CN", "ceid": "CN:zh-Hans",
        "queries": [
            '(高浓缩铀 OR 低浓缩铀 OR 铀-235 OR 钚-239 OR 铯-137) (恐怖主义 OR 恐怖分子 OR 走私 OR 查获 OR 逮捕 OR 调查)',
            '(放射性同位素 OR 放射性核素 OR 钴-60 OR 镭-226 OR "脏弹") (恐怖袭击 OR 极端组织 OR 非法贩运 OR 被盗 OR 查获 OR 调查)',
            '(核燃料 OR 乏核燃料 OR 黄饼 OR 放射性废物) (恐怖主义 OR 极端组织 OR 走私 OR 盗窃 OR 查获)',
        ],
    },
    "zh-Hant": {
        "name": "Chinese (Traditional) RN supplement",
        "hl": "zh-TW", "gl": "TW", "ceid": "TW:zh-Hant",
        "queries": [
            '(高濃縮鈾 OR 低濃縮鈾 OR 鈾-235 OR 鈽-239 OR 銫-137) (恐怖主義 OR 恐怖份子 OR 走私 OR 查獲 OR 逮捕 OR 調查)',
            '(放射性同位素 OR 放射性核種 OR 鈷-60 OR 鐳-226 OR "髒彈") (恐怖襲擊 OR 極端組織 OR 非法販運 OR 遭竊 OR 查獲 OR 調查)',
            '(核燃料 OR 用過核燃料 OR 黃餅 OR 放射性廢物) (恐怖主義 OR 極端組織 OR 走私 OR 竊盜 OR 查獲)',
        ],
    },
}
