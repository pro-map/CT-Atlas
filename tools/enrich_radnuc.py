#!/usr/bin/env python3
"""Resumable 180-day RADNUC enrichment, integrated into the live event database.
Uses the existing search, translation, relevance, quota and deduplication code.
The dedicated state never resets ordinary archive enrichment's progress.
"""
from __future__ import annotations
import argparse
import copy
import json
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'tools'))
import radnuc
import radnuc_vocabulary
import threat_categories
import archive_review
import enrich_archive

STATE_FILE = 'archive/radnuc-enrichment-state.json'
STATUS_FILE = 'archive/radnuc-enrichment-status.json'
WINDOW_DAYS = 180


def profiles(collector):
    result = [enrich_archive.ENGLISH_PROFILE, *collector.MULTILINGUAL_PROFILES,
              *enrich_archive.NEW_LANGUAGE_PROFILES,
              {'code': 'sw', 'name': 'Swahili', 'hl': 'en-US', 'gl': 'US', 'ceid': 'US:en'}]
    unique = {}
    for profile in result:
        identity = (profile['code'], profile['hl'], profile['gl'], profile['ceid'])
        unique.setdefault(identity, profile)
    return list(unique.values())


def plan_tasks(today, collector):
    # A rolling six-month plan, including the current partial week: RADNUC is
    # a new topic, so no replay-before-September restriction applies.
    first = today - timedelta(days=WINDOW_DAYS)
    end = today + timedelta(days=1)
    monday = first - timedelta(days=first.weekday())
    windows = []
    while monday < end:
        windows.append((monday, max(monday, first), min(monday + timedelta(days=7), end)))
        monday += timedelta(days=7)
    tasks = []
    for week, low, high in reversed(windows):
        # GDELT's English queries search translations from ALL indexed source
        # languages, including ones with no useful Google News local edition.
        for query in radnuc.ENGLISH_QUERIES:
            tasks.append({'group': 'radnuc_gdelt', 'source': 'gdelt', 'locale': 'all',
                          'code': 'mul', 'name': 'All GDELT source languages', 'query': query,
                          'category': threat_categories.RN, 'week': week.isoformat(),
                          'start': low.isoformat(), 'end': high.isoformat()})
        for profile in profiles(collector):
            for query in radnuc.queries(profile['code']):
                tasks.append({'group': 'radnuc_google', 'source': 'google',
                              'locale': f"{profile['hl']}|{profile['gl']}|{profile['ceid']}",
                              'code': profile['code'], 'name': profile['name'],
                              'hl': profile['hl'], 'gl': profile['gl'], 'ceid': profile['ceid'],
                              'category': threat_categories.RN, 'query': query, 'week': week.isoformat(),
                              'start': low.isoformat(), 'end': high.isoformat()})
    # Supplement has its own fixed six-month window; old search keys stay intact.
    tasks.extend(radnuc_vocabulary.backfill_tasks(enrich_archive.task_key))
    unique = {}
    for task in tasks:
        task['key'] = enrich_archive.task_key(task)
        unique.setdefault(task['key'], task)
    return list(unique.values())


def screen(event, collector):
    return radnuc.state_operation_reason(event) or enrich_archive.screen(event, collector)


class IntegratedOutput(enrich_archive.Output):
    include_event = True

    def __init__(self, root, now, collector, category=threat_categories.RN, prefix='radnuc'):
        self.category = category
        self.prefix = prefix
        super().__init__(root, now)
        self.root = Path(root)
        self.collector = collector
        self.database = archive_review.read_json(self.root / 'events.json')
        if not isinstance(self.database, dict) or not isinstance(self.database.get('events'), list):
            raise ValueError('Invalid live database: refusing RADNUC enrichment')
        self.changed = False
        self.integrated = 0
        for event in self.database['events']:
            before = copy.deepcopy(event)
            radnuc.annotate(event)
            self.changed |= before != event
        # Selected reports saved before a killed run's checkpoint can be
        # re-integrated safely. The real incremental deduplicator merges them.
        self.recover()

    def integrate(self, events):
        events = [threat_categories.annotate(event) for event in events]
        eligible = [event for event in events if self.category in event.get('categories', [])
                    and event.get('ai_selected') is True
                    and event.get('ai_current_ct_event') is not False
                    and not threat_categories.scope_reason(event)
                    and not self.collector.out_of_scope_reason(event)]
        if not eligible:
            return
        selected = self.collector.deduplicate_events(eligible)
        # Work on a copy so a failed merge cannot corrupt the current checkpoint.
        merged = self.collector.deduplicate_incremental(copy.deepcopy(self.database['events']), selected)
        merged = self.collector.prune_old(merged)
        merged.sort(key=lambda event: event.get('published') or '', reverse=True)
        self.database['events'] = merged
        self.changed = True
        self.integrated += len(eligible)

    def recover(self):
        events = []
        for path in self.root.glob(f'archive/{self.prefix}-selected-*.json'):
            payload = archive_review.read_json(path) or {}
            events.extend(payload.get('events') or [])
        self.integrate(events)

    def add(self, rows):
        events = []
        for row in rows:
            event = row.pop('selected_event', None)
            if event:
                events.append(event)
        # Save selected normalized events for replay before the live database is
        # replaced; even a process kill between writes cannot lose the batch.
        selected_path = self.root / 'archive' / f'{self.prefix}-selected-{datetime.now(timezone.utc):%Y%m%d}.json'
        payload = archive_review.read_json(selected_path) or {'events': []}
        payload['events'].extend(event for event in events if event.get('ai_selected') is True)
        archive_review.write_json(selected_path, payload, indent=None)
        self.integrate(events)
        super().add(rows)

    def save(self):
        super().save()
        if self.changed:
            self.database['last_updated'] = datetime.now(timezone.utc).isoformat()
            self.database.setdefault('specialist_enrichment', {})[self.category] = {'window_days': WINDOW_DAYS,
                'languages': sorted(radnuc.LEXICONS) if self.category == threat_categories.RN else sorted(threat_categories.vocabulary()['biological' if self.category == threat_categories.BIO else 'chemical_explosives']['terms']), 'state_actor_operations': 'excluded',
                'pipeline': (f"{self.collector.AI_SELECTION_MODEL} specialist selection, "
                             "English translation and incremental event deduplication")}
            archive_review.write_json(self.root / 'events.json', self.database, indent=2)
            self.changed = False


def run(root=ROOT, max_posts=100, max_fetches=300, today=None, **kwargs):
    now = datetime.now(timezone.utc)
    today = today or now.date()
    collector = archive_review.prepare_collector(archive_review.load_collector(root),
                                                 threshold=archive_review.map_threshold(root))
    output = IntegratedOutput(root, now, collector)
    output.save()
    summary, stop = enrich_archive.run(root, collector, max_posts, max_fetches, today=today,
        plan_factory=plan_tasks, state_file=STATE_FILE, output_factory=lambda *_: output,
        # Share the existing enrichment allocation; do not add to its daily quota.
        ledger_job='enrichment', event_screen=screen, retry_failed_tasks=True, **kwargs)
    state = enrich_archive.load_state(root, STATE_FILE)
    plan = plan_tasks(today, collector)
    open_tasks = [t for t in plan if t['key'] not in state['done']]
    children = [t for t in state['children'].values() if t['key'] not in state['done']]
    totals = {field: sum(stats.get(field, 0) for stats in state['stats'].values())
              for field in ('query_errors', 'full_single_day', 'failed_searches', 'reviewed', 'kept')}
    status = {'updated_at': now.isoformat(), 'window_days': WINDOW_DAYS,
              'from': (today - timedelta(days=WINDOW_DAYS)).isoformat(), 'through': today.isoformat(),
              'language_codes': sorted(radnuc.LEXICONS), 'gdelt_source_languages': 'all indexed',
              'planned_searches': len(plan), 'pending_searches': len(open_tasks) + len(children),
              'complete': not open_tasks and not children and not totals['query_errors'] and not totals['full_single_day'],
              'last_run': {**summary, 'stop': stop, 'integrated_reports': output.integrated},
              'coverage': totals}
    archive_review.write_json(Path(root) / STATUS_FILE, status)
    print(json.dumps(status, ensure_ascii=False))
    return status


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--max-posts', type=int, default=100)
    parser.add_argument('--max-fetches', type=int, default=300)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    if args.dry_run:
        collector = archive_review.load_collector()
        plan = plan_tasks(date.today(), collector)
        print(json.dumps({'queries': len(plan), 'languages': sorted(radnuc.LEXICONS),
                          'sample': plan[:4]}, ensure_ascii=False, indent=2))
    else:
        run(max_posts=args.max_posts, max_fetches=args.max_fetches)


if __name__ == '__main__':
    main()
