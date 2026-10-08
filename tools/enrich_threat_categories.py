#!/usr/bin/env python3
"""Six-month specialist backfill. Fixed windows, separate checkpoints, fair quotas.

Daily intake lives in collector.py and reads the SAME vocabulary. This runner
never replaces daily intake with repeated six-month searches. Completed searches
are not repeated, RN progress survives, unavailable providers stay incomplete.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
sys.path.insert(0,str(ROOT/'tools'))
import threat_categories as topics
import archive_review
import enrich_archive
import enrich_radnuc

MANIFEST = 'archive/threat-enrichment-plan.json'
STATUS = 'archive/threat-enrichment-status.json'
PREFIXES = {topics.RN:'radnuc',topics.CE:'chemical-explosives',topics.BIO:'biological'}

def manifest(root, today):
    """Freeze the initial window; an unchanged daily rerun cannot restart it."""
    path = Path(root)/MANIFEST
    saved = archive_review.read_json(path)
    if not saved:
        saved = {'version':1,'anchor':today.isoformat(),
                 'from':(today-timedelta(days=180)).isoformat(),
                 'through':today.isoformat(), 'window_days':180}
        archive_review.write_json(path,saved)
    if saved.get('version') != 1:
        raise ValueError('Unsupported specialist backfill checkpoint version')
    return saved

def plan_tasks(category, anchor, collector):
    # Preserve the existing RN task identities and done/children state exactly.
    if category == topics.RN:
        return enrich_radnuc.plan_tasks(anchor,collector)
    first, end = anchor-timedelta(days=180), anchor+timedelta(days=1)
    monday = first-timedelta(days=first.weekday())
    weeks = []
    while monday < end:
        weeks.append((monday,max(monday,first),min(monday+timedelta(days=7),end)))
        monday += timedelta(days=7)
    tasks = []
    prefix = PREFIXES[category]
    profiles = enrich_radnuc.profiles(collector)
    for week, low, high in reversed(weeks):
        # Native searches first; a refused GDELT call cannot hold up all languages.
        for profile in profiles:
            for query in topics.queries(category,profile['code']):
                tasks.append({'group':prefix+'_google','source':'google',
                    'locale':f"{profile['hl']}|{profile['gl']}|{profile['ceid']}",
                    'code':profile['code'],'name':profile['name'],
                    'hl':profile['hl'],'gl':profile['gl'],'ceid':profile['ceid'],
                    'category':category,'query':query,'week':week.isoformat(),
                    'start':low.isoformat(),'end':high.isoformat()})
        for query in topics.queries(category):
            tasks.append({'group':prefix+'_gdelt','source':'gdelt','locale':'all',
                'code':'mul','name':'All indexed source languages','category':category,
                'query':query,'week':week.isoformat(),'start':low.isoformat(),'end':high.isoformat()})
    unique = {}
    for task in tasks:
        task['key'] = enrich_archive.task_key(task)
        unique.setdefault(task['key'],task)
    return list(unique.values())

def known_map_keys(root):
    """Do not let an old rejected/archive-only review hide new specialist cases.
    New reviews have a separate seen namespace; already-published articles and
    their source variants are skipped. Ambiguous legacy categories may be reviewed.
    """
    database = archive_review.read_json(Path(root)/'events.json') or {}
    keys = set()
    for event in database.get('events',[]):
        if event.get('category_review_required'): continue
        for item in [event,*(event.get('related_articles') or [])]:
            if not isinstance(item,dict): continue
            for title in {item.get('original_title'),item.get('title')}:
                keys.update(enrich_archive.article_keys(title,item.get('source')))
            link = enrich_archive.link_key(item.get('url'))
            if link: keys.add(link)
    return keys

def progress(root, category, plan, summary=None):
    state = enrich_archive.load_state(root,f'archive/{PREFIXES[category]}-enrichment-state.json')
    pending = [t for t in plan if t['key'] not in state['done']]
    children = [t for t in state['children'].values() if t['key'] not in state['done']]
    issues = {k:sum(int(s.get(k,0)) for s in state['stats'].values())
              for k in ('query_errors','full_single_day','failed_searches')}
    return {'planned_searches':len(plan),'pending_searches':len(pending)+len(children),
            'completed_searches':len(plan)-len(pending),
            'complete':not pending and not children and not issues['query_errors'] and not issues['full_single_day'],
            'coverage_issues':issues,'last_run':summary or {},
            'native_query_languages':sorted({t['code'] for t in plan if t['source']=='google'}),
            'gdelt_scope':'all source languages indexed by the provider; not exhaustive web coverage'}

def run(root=ROOT, max_posts=60, max_fetches=600, today=None, deadline_minutes=75,
        categories=None, searcher_factory=None, gate_factory=None, call_batch=None, log=print):
    root = Path(root)
    now = datetime.now(timezone.utc)
    today = today or now.date()
    frozen = manifest(root,today)
    anchor = date.fromisoformat(frozen['anchor'])
    collector = archive_review.prepare_collector(archive_review.load_collector(root),
                                                 threshold=archive_review.map_threshold(root))
    chosen = list(categories or topics.LABELS)
    if any(c not in topics.LABELS for c in chosen): raise ValueError('Unknown specialist category')
    # Rotate first place daily, while guaranteeing each category a bounded slice.
    rotation = today.toordinal() % len(chosen)
    chosen = chosen[rotation:]+chosen[:rotation]
    started = time.monotonic()
    report = {'updated_at':now.isoformat(),**frozen,'taxonomy_version':topics.VERSION,
              'daily_collection':'collector.py; shared keyword vocabulary; regular daily schedule',
              'chemical_keywords':topics.vocabulary()['chemical_explosives']['status'],
              'categories':{}}
    start_ledger = archive_review.DailyLedger(archive_review.ledger_path('enrichment',root),100,now=now)
    spent, fetched = 0, 0
    for index, category in enumerate(chosen):
        prefix = PREFIXES[category]
        plan = plan_tasks(category,anchor,collector)
        before = progress(root,category,plan)
        output = enrich_radnuc.IntegratedOutput(root,now,collector,category=category,prefix=prefix)
        output.save()  # Reclassification/recovery is safe even when quota is exhausted.
        if before['pending_searches'] == 0:
            report['categories'][category] = before
            archive_review.write_json(root/STATUS,report)
            continue
        remaining_categories = len(chosen)-index
        requests = max(0,(max_posts-spent)//remaining_categories)
        searches = max(0,(max_fetches-fetched)//remaining_categories)
        minutes = max(0,deadline_minutes-(time.monotonic()-started)/60)
        if not requests or not searches or minutes <= 0:
            before['last_run'] = {'stop':'run budget reached; checkpoint preserved'}
            report['categories'][category] = before
            archive_review.write_json(root/STATUS,report)
            continue
        searcher = searcher_factory(collector) if searcher_factory else enrich_archive.Searcher(collector)
        summary, stop = enrich_archive.run(root,collector,requests,searches,today=today,now=now,
            plan_factory=lambda _today,_collector:plan,
            state_file=f'archive/{prefix}-enrichment-state.json',output_factory=lambda *_:output,
            event_screen=enrich_radnuc.screen,ledger_job='enrichment',retry_failed_tasks=True,
            known_keys_factory=known_map_keys,reuse_previous_reviews=False,
            seen_prefix=f'{prefix}-v1',searcher=searcher,gate_factory=gate_factory,
            call_batch=call_batch,deadline_minutes=minutes / remaining_categories,log=log)
        ledger = archive_review.DailyLedger(archive_review.ledger_path('enrichment',root),100,now=now)
        spent = max(0,ledger.used-start_ledger.used)
        fetched += searcher.fetches
        report['categories'][category] = progress(root,category,plan,
            {**summary,'stop':stop,'integrated_reports':output.integrated})
        archive_review.write_json(root/STATUS,report)
    report['complete'] = all(c['complete'] for c in report['categories'].values())
    report['requests_this_run'] = spent
    report['searches_this_run'] = fetched
    report['completion_meaning'] = 'Configured searches processed, not a guarantee that all real-world cases were found.'
    archive_review.write_json(root/STATUS,report)
    log(json.dumps(report,ensure_ascii=False))
    return report

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--max-posts',type=int,default=60)
    p.add_argument('--max-fetches',type=int,default=600)
    p.add_argument('--deadline-minutes',type=float,default=75)
    p.add_argument('--dry-run',action='store_true')
    args = p.parse_args()
    if args.dry_run:
        collector = archive_review.load_collector(ROOT)
        frozen = archive_review.read_json(ROOT/MANIFEST) or {'anchor':date.today().isoformat()}
        anchor = date.fromisoformat(frozen['anchor'])
        print(json.dumps({c:{'queries':len(plan_tasks(c,anchor,collector)),'sample':plan_tasks(c,anchor,collector)[:1]}
                          for c in topics.LABELS},ensure_ascii=False,indent=2))
    else:
        if args.max_posts < 0 or args.max_fetches < 0 or args.deadline_minutes <= 0:
            p.error('Budgets must be nonnegative; deadline must be positive')
        run(max_posts=min(args.max_posts,60),max_fetches=args.max_fetches,deadline_minutes=args.deadline_minutes)

if __name__ == '__main__': main()
