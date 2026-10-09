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
import os
import signal
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
import backfill_query

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

def raw_plan_tasks(category, anchor, collector):
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

class SpecialistSearcher(enrich_archive.Searcher):
    """One provider circuit breaker shared across all three category slices."""
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Do not burn minutes retrying a shared runner IP after a rate refusal.
        # Existing source pacing remains in force; retry in a later batch.
        self.gdelt_rate_limit_retries = 0

    def _failed(self, source, message, rate_limited=False):
        if source == 'gdelt':
            self.failures[source] = enrich_archive.MAX_CONSECUTIVE_FAILURES
        return super()._failed(source, message, rate_limited)


def plan_tasks(category, anchor, collector):
    tasks = []
    for task in raw_plan_tasks(category, anchor, collector):
        tasks.extend(backfill_query.provider_tasks(task, enrich_archive.task_key))
    return list({task['key']: task for task in tasks}.values())


def repair_children(root, category, plan):
    """Convert only unfinished GDELT children; preserve reviews and native keys."""
    path = f'archive/{PREFIXES[category]}-enrichment-state.json'
    state = enrich_archive.load_state(root, path)
    repaired = {}
    for task in state['children'].values():
        for child in backfill_query.provider_tasks(task, enrich_archive.task_key):
            repaired[child['key']] = child
    if repaired != state['children']:
        state['children'] = repaired
        enrich_archive.save_state(root, state, [t['key'] for t in plan], path)


def progress(root, category, plan, summary=None):
    state = enrich_archive.load_state(root,f'archive/{PREFIXES[category]}-enrichment-state.json')
    pending = [t for t in plan if t['key'] not in state['done']]
    children = [t for t in state['children'].values() if t['key'] not in state['done']]
    pending_keys = {t['key'] for t in pending + children}
    queued = state.get('pending_reviews') or []
    pending_keys.update(item['_task']['key'] for item in queued)
    planned = {t['key'] for t in plan}
    rejected = state.get('rejected_queries') or {}
    # Rejected children are deliberately retained even after leaving the queue.
    active_rejected = {k: v for k, v in rejected.items()
                       if k in planned or v.get('task', {}).get('query_split_parent')}
    saturated = state.get('saturated_queries') or {}
    history = {k:sum(int(row.get(k,0)) for row in state['stats'].values())
               for k in ('query_errors','full_single_day','failed_searches')}
    processed = len(plan)-len(pending)
    # The historical counters are not erased by a repair. Older checkpoints did
    # not retain exact rejected/saturated identities, so never certify complete
    # source coverage merely because the remaining work queue reaches zero.
    complete = not pending_keys and not active_rejected and not saturated and not any(history.values())
    return {'planned_searches':len(plan),'pending_searches':len(pending_keys),
            'queued_candidates':len(queued), 'completed_searches':processed,
            'successful_main_queries':processed-len(planned & set(rejected)),
            'rejected_queries':len(active_rejected),
            'saturated_queries':len(saturated),
            'processing_complete':not pending_keys, 'complete':complete,
            'coverage_issues':history,
            'coverage_note':'Historical source errors are retained; processed is not an exhaustive-coverage claim.',
            'last_run':summary or {}, 'state_updated_at':(archive_review.read_json(Path(root)/f'archive/{PREFIXES[category]}-enrichment-state.json') or {}).get('updated_at'),
            'native_query_languages':sorted({t['code'] for t in plan if t['source']=='google'}),
            'gdelt_scope':'all source languages indexed by the provider; not exhaustive web coverage'}


def refresh_status(root=ROOT, phase=None):
    """Rebuild ALL category counters from durable state, without any collection."""
    root = Path(root)
    report = archive_review.read_json(root/STATUS) or {}
    frozen = archive_review.read_json(root/MANIFEST)
    if not frozen:
        return report
    collector = archive_review.load_collector(root)
    anchor = date.fromisoformat(frozen['anchor'])
    previous = report.get('categories') or {}
    report['categories'] = {category: progress(root, category, plan_tasks(category, anchor, collector),
        previous.get(category, {}).get('last_run') or {'stop':'Not processed in this batch; restored from saved state'})
        for category in topics.LABELS}
    report.update(frozen)
    report['updated_at'] = datetime.now(timezone.utc).isoformat()
    report['complete'] = all(row['complete'] for row in report['categories'].values())
    report['processing_complete'] = all(row['processing_complete'] for row in report['categories'].values())
    if phase:
        report['batch_status'] = phase
    if report.get('batch_status') in ('interrupted','failed'):
        report['complete'] = False
    archive_review.write_json(root/STATUS,report)
    return report


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
    rotation = today.toordinal() % len(chosen)
    chosen = chosen[rotation:]+chosen[:rotation]
    plans = {category:plan_tasks(category,anchor,collector) for category in topics.LABELS}
    for category in topics.LABELS:
        repair_children(root,category,plans[category])
    report = {'updated_at':now.isoformat(),**frozen,'taxonomy_version':topics.VERSION,
              'batch_started_at':now.isoformat(), 'batch_status':'running',
              'run_id':os.getenv('GITHUB_RUN_ID','local'),
              'daily_collection':'collector.py; shared keyword vocabulary; regular daily schedule',
              'chemical_keywords':topics.vocabulary()['chemical_explosives']['status'],
              'categories':{category:progress(root,category,plans[category],
                  {'stop':'Not processed in this batch; previous progress preserved'}) for category in topics.LABELS},
              'complete':False,'processing_complete':False,'requests_this_run':0,'searches_this_run':0}
    archive_review.write_json(root/STATUS,report)
    started = time.monotonic()
    start_ledger = archive_review.DailyLedger(archive_review.ledger_path('enrichment',root),enrich_archive.DAILY_POSTS,now=now)
    spent, fetched = 0, 0
    shared_searcher = None if searcher_factory else SpecialistSearcher(collector)
    try:
        for index, category in enumerate(chosen):
            prefix, plan = PREFIXES[category], plans[category]
            before = progress(root,category,plan)
            report['current_category'] = category
            report['categories'][category] = {**before,'last_run':{'stop':'Processing saved reviews before new searches'}}
            archive_review.write_json(root/STATUS,report)
            output = enrich_radnuc.IntegratedOutput(root,now,collector,category=category,prefix=prefix)
            output.save()
            initial_ids = {str(e.get('id')) for e in output.database['events']}
            if before['pending_searches'] == 0:
                report['categories'][category] = before
                continue
            remaining_categories = len(chosen)-index
            requests = max(0,(max_posts-spent)//remaining_categories)
            searches = max(0,(max_fetches-fetched)//remaining_categories)
            minutes = max(0,deadline_minutes-(time.monotonic()-started)/60)
            if not requests or not searches or minutes <= 0:
                before['last_run'] = {'stop':'run budget reached; checkpoint preserved'}
                report['categories'][category] = before
                continue
            searcher = searcher_factory(collector) if searcher_factory else shared_searcher
            fetched_before = searcher.fetches
            def checkpoint(summary):
                report['categories'][category] = progress(root,category,plan,
                    {**summary,'stop':'Running; reviewed candidates checkpointed',
                     'new_event_records':len({str(e.get('id')) for e in output.database['events']}-initial_ids)})
                report['updated_at'] = datetime.now(timezone.utc).isoformat()
                archive_review.write_json(root/STATUS,report)
            summary, stop = enrich_archive.run(root,collector,requests,searches,today=today,now=now,
                plan_factory=lambda _today,_collector:plan,
                state_file=f'archive/{prefix}-enrichment-state.json',output_factory=lambda *_:output,
                event_screen=enrich_radnuc.screen,ledger_job='enrichment',retry_failed_tasks=True,
                known_keys_factory=known_map_keys,reuse_previous_reviews=False,
                seen_prefix=f'{prefix}-v1',searcher=searcher,gate_factory=gate_factory,
                call_batch=call_batch,deadline_minutes=minutes / remaining_categories,log=log,
                review_first=True,prioritize_native=True,refine_saturated=True,on_checkpoint=checkpoint)
            ledger = archive_review.DailyLedger(archive_review.ledger_path('enrichment',root),enrich_archive.DAILY_POSTS,now=now)
            spent = max(0,ledger.used-start_ledger.used)
            fetched += searcher.fetches-fetched_before
            report['categories'][category] = progress(root,category,plan,
                {**summary,'stop':stop,'integrated_reports':output.integrated,
                 'new_event_records':len({str(e.get('id')) for e in output.database['events']}-initial_ids)})
            report.update({'updated_at':datetime.now(timezone.utc).isoformat(),
                           'requests_this_run':spent,'searches_this_run':fetched})
            archive_review.write_json(root/STATUS,report)
            log(f"{category}: {summary.get('reviewed',0)} reviewed; {report['categories'][category]['pending_searches']} pending; {stop}")
            if 'AISelectionQuotaError' in stop or 'daily allocation already used' in stop:
                for deferred in chosen[index+1:]:
                    report['categories'][deferred]['last_run'] = {'stop':stop,'reviewed':0,'tasks_done':0}
                break
        report['complete'] = all(row['complete'] for row in report['categories'].values())
        report['processing_complete'] = all(row['processing_complete'] for row in report['categories'].values())
        work = sum(sum(row.get('last_run',{}).get(k,0) for k in ('reviewed','fetched'))
                   for row in report['categories'].values())
        report['batch_status'] = 'complete' if report['complete'] else (
            'processed_with_coverage_limits' if report['processing_complete'] else 'partial' if work else 'blocked')
        report['completion_meaning'] = 'Configured queries processed, not a guarantee that all real-world cases were found.'
    except BaseException as error:
        report['batch_status'] = 'interrupted' if isinstance(error,(KeyboardInterrupt,SystemExit)) else 'failed'
        report['error_type'] = type(error).__name__
        raise
    finally:
        report['updated_at'] = datetime.now(timezone.utc).isoformat()
        report['current_category'] = None
        # Refresh every category from its actual saved state, including the one
        # interrupted between retrieval and review. Do not reset other rows.
        for category in topics.LABELS:
            report['categories'][category] = progress(root,category,plans[category],
                report['categories'][category].get('last_run'))
        if report['batch_status'] in ('interrupted','failed'):
            report['complete'] = False
            report['processing_complete'] = False
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
        run(max_posts=min(args.max_posts,enrich_archive.DAILY_POSTS),max_fetches=args.max_fetches,deadline_minutes=args.deadline_minutes)

if __name__ == '__main__':
    # GitHub sends SIGINT/SIGTERM on cancellation; finally preserves all rows.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    main()
