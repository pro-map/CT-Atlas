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
