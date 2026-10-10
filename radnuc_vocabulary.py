"""Shared user-supplied RN vocabulary for daily retrieval and incremental history.

This adds discovery queries; it does not weaken the existing CT publication
criteria. The old multilingual queries and saved task identities remain intact.
"""
from __future__ import annotations
import json
from datetime import date, timedelta
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
    return list(_queries(code))


# Complementary Chinese-language Google News searches for the SAME user-supplied
# 181-term RN collection. These are curated native equivalents of select material
# classes, NOT a claim that all 181 English names have been individually translated.
# The unchanged full 181-entry vocabulary continues through English Google News
# and GDELT's multilingual index, including Chinese-indexed reporting.
# Only the fixed six-month supplemental backfill uses these extra native queries.
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


def backfill_tasks(key_function):
    config = vocabulary()
    anchor = date.fromisoformat(config['backfill']['anchor'])
    first, through = anchor-timedelta(days=int(config['backfill']['window_days'])), anchor+timedelta(days=1)
    monday = first-timedelta(days=first.weekday())
    windows = []
    while monday < through:
        windows.append((monday,max(monday,first),min(monday+timedelta(days=7),through)))
        monday += timedelta(days=7)
    tasks = []
    for week, low, high in reversed(windows):
        for source in ('google','gdelt'):
            for query in queries():
                task = {'group':'radnuc_supplement_'+source,'source':source,'query':query,
                        'category':'Radiological/Nuclear','week':week.isoformat(),
                        'start':low.isoformat(),'end':high.isoformat(),
                        'supplemental_vocabulary':config['version']}
                if source=='google':
                    task.update(locale='en-US|US|US:en',code='en',name='English RN supplement',
                                hl='en-US',gl='US',ceid='US:en')
                else:
                    task.update(locale='all',code='mul',name='All indexed GDELT source languages')
                task['key'] = key_function(task)
                tasks.append(task)
        # Separate Chinese script editions are searchable without creating
        # new keywords or resetting any prior English/GDELT task identity.
        for code, profile in CHINESE_SUPPLEMENT_QUERIES.items():
            for query in profile['queries']:
                task = {'group':'radnuc_supplement_google_chinese',
                        'source':'google','query':query,
                        'category':'Radiological/Nuclear','week':week.isoformat(),
                        'start':low.isoformat(),'end':high.isoformat(),
                        'supplemental_vocabulary':config['version'],
                        'locale':f"{profile['hl']}|{profile['gl']}|{profile['ceid']}",
                        'code':code,'name':profile['name'],
                        'hl':profile['hl'],'gl':profile['gl'],'ceid':profile['ceid']}
                task['key'] = key_function(task)
                tasks.append(task)
    return list({task['key']:task for task in tasks}.values())


def progress(plan,state):
    config = vocabulary()
    selected = [t for t in plan if t.get('supplemental_vocabulary')==config['version']]
    roots = {t['key'] for t in selected}
    done = set(state.get('done') or {})
    children = [t for t in (state.get('children') or {}).values()
                if t.get('supplemental_vocabulary')==config['version'] and t['key'] not in done]
    reviews = [item for item in (state.get('pending_reviews') or [])
               if item.get('_task',{}).get('supplemental_vocabulary')==config['version']]
    pending = (roots-done) | {t['key'] for t in children} | {x['_task']['key'] for x in reviews}
    anchor = date.fromisoformat(config['backfill']['anchor'])
    return {'version':config['version'],'supplied_keywords':len(all_terms()),
            'from':(anchor-timedelta(days=config['backfill']['window_days'])).isoformat(),
            'through':anchor.isoformat(),'planned_searches':len(roots),
            'completed_searches':len(roots & done),'pending_searches':len(pending),
            'queued_candidates':len(reviews),'processing_complete':bool(roots) and not pending}
