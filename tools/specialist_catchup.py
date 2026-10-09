#!/usr/bin/env python3
"""Time-boxed same-day catch-up controls. No providers or secrets are accessed.

A successful publication may dispatch the next checkpointed batch. The chain
stops on completion, provider refusal, no progress, the round cap or Paris
midnight. Outside this window the ordinary daily settings automatically return.
"""
from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = 'specialist-catchup.json'
STATE = 'archive/threat-catchup-control.json'
STATUS = 'archive/threat-enrichment-status.json'
LABELS = ('Radiological/Nuclear', 'Chemicals and Explosives', 'Biological Terrorism')
NORMAL = {'minutes': 45, 'searches': 600, 'requests': 60, 'daily': 100}


def read(root, filename):
    path = Path(root) / filename
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}


def write(root, filename, data):
    path = Path(root) / filename
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    tmp.replace(path)


def stamp(value):
    now = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if now.tzinfo is None:
        raise ValueError('Catch-up timestamps must include their time zone')
    return now


def active(config, now):
    return bool(config.get('enabled')) and stamp(config['start_at']) <= now < stamp(config['end_at'])


def remaining(report):
    categories = report.get('categories') or {}
    if set(categories) != set(LABELS):
        return None
    return sum(int(row.get('pending_searches', 0)) + int(row.get('queued_candidates', 0))
               for row in categories.values())


def configure(root, now, run_id, event='workflow_dispatch', continuation=False):
    config = read(root, CONFIG)
    control = read(root, STATE)
    live = active(config, now)
    if control.get('end_at') != config.get('end_at'):
        control = {'end_at': config.get('end_at'), 'runs': []}
    runs = control.get('runs') or []
    # Late automatically queued jobs never revert to an extra ordinary run.
    enabled = not continuation or live
    if live and len(runs) >= int(config['max_rounds']) and run_id not in runs:
        enabled = False
    latest = read(root, STATUS)
    if continuation and remaining(latest) == 0:
        enabled = False
    values = dict(NORMAL)
    if live:
        values = {
            'minutes': min(int(config.get('first_round_minutes',config['minutes_per_round']) if not runs else config['minutes_per_round']), max(0, int((stamp(config['end_at'])-now).total_seconds()/60)-2)),
            'searches': min(int(config['searches_per_round']), 2400),
            'requests': min(int(config['ai_requests_per_round']), 120),
            'daily': min(int(config['enrichment_daily_allocation']), 600),
        }
        enabled = enabled and values['minutes'] > 0
    if enabled and live:
        if run_id not in runs:
            runs.append(run_id)
        control.update({'runs': runs, 'last_started_at': now.isoformat(), 'last_run_id': run_id,
                        'mode': 'same-day catch-up', 'settings': values})
        write(root, STATE, control)
    return {**values, 'enabled': enabled, 'catchup': live,
            'round': len(runs), 'end_at': config.get('end_at'), 'event': event}


def continuation_decision(root, now):
    config = read(root, CONFIG)
    if not active(config, now):
        return False, 'Same-day acceleration window ended; normal daily schedule remains.'
    control = read(root, STATE)
    if len(control.get('runs') or []) >= int(config['max_rounds']):
        return False, 'Same-day round safety limit reached; saved work remains intact.'
    report = read(root, STATUS)
    count = remaining(report)
    if count is None:
        return False, 'Incomplete status snapshot; do not dispatch from an unverified checkpoint.'
    if count == 0:
        return False, ('Backfill complete.' if report.get('complete') else
                       'Configured search work processed, but source coverage limitations remain; not marked complete.')
    if report.get('batch_status') in ('running','interrupted','failed','blocked'):
        return False, 'Batch did not finish productively; inspect the saved checkpoint before resuming.'
    stops = [str(row.get('last_run', {}).get('stop', '')) for row in report['categories'].values()]
    if any('AISelectionQuotaError' in stop or 'daily allocation already used' in stop for stop in stops):
        return False, 'Provider or daily request allowance reached; not bypassed and not marked complete.'
    work = sum(sum(int(row.get('last_run', {}).get(k, 0)) for k in ('fetched', 'reviewed', 'tasks_done'))
               for row in report['categories'].values())
    if not work:
        return False, 'No processing progress in the last batch; inspect source/AI errors rather than loop.'
    return True, f'{count} pending task/candidate units remain; resume from the saved checkpoint now.'


def summary(root):
    report = read(root, STATUS)
    outcome = os.getenv('BACKFILL_STEP_OUTCOME', '')
    # Recover real counters from durable state; never invent 0/0 for a category
    # that was not reached before an interruption. This performs no searches.
    if (set(report.get('categories') or {}) != set(LABELS)
            or outcome in ('cancelled','failure')):
        from enrich_threat_categories import refresh_status
        report = refresh_status(root, 'interrupted' if outcome == 'cancelled' else
                                'failed' if outcome == 'failure' else report.get('batch_status','interrupted'))
    control = read(root, STATE)
    state = report.get('batch_status','unknown')
    lines = ['# Specialist six-month backfill', '',
             f"Last checkpoint (UTC): {report.get('updated_at', 'Not available')}",
             '', f"**Batch result: {state}. Whole backfill complete: {'YES' if report.get('complete') else 'NO'}.**", '',
             '| Category | Root queries processed / planned | Rejected queries | Pending work | Awaiting AI review | New event records this batch |',
             '|---|---:|---:|---:|---:|---:|']
    for name in LABELS:
        row = (report.get('categories') or {}).get(name)
        if row is None:
            lines.append(f'| {name} | Not available | ? | ? | ? | ? |')
            continue
        lines.append(f"| {name} | {row.get('completed_searches','?')} / {row.get('planned_searches','?')} | "
                     f"{row.get('rejected_queries','?')} | {row.get('pending_searches','?')} | "
                     f"{row.get('queued_candidates','?')} | {row.get('last_run',{}).get('new_event_records',0)} |")
    lines += ['', 'Processed roots include windows replaced by narrower queries. Rejected queries are NOT successful retrievals. '
              'Pending work includes these replacement queries and tasks awaiting review.',
              '', f"Catch-up rounds started: {len(control.get('runs') or [])}. Acceleration ends at {control.get('end_at','not configured')}.",
              '', '## Latest batch / source limitations']
    supplement = (report.get('categories') or {}).get('Radiological/Nuclear',{}).get('supplemental_vocabulary')
    if supplement:
        lines += ['', '### Additional Radiological/Nuclear keyword backfill', '```json', json.dumps(supplement,indent=2), '```']
    for name in LABELS:
        row = (report.get('categories') or {}).get(name, {})
        last = row.get('last_run', {})
        lines += ['', f'### {name}', '```json', json.dumps({'stop':last.get('stop','Not reached'),
                  'reviewed_this_batch':last.get('reviewed',0),
                  'successful_fetches_this_batch':last.get('fetched',0),
                  'rejected_queries':row.get('rejected_queries'),
                  'unresolved_saturated_queries':row.get('saturated_queries'),
                  'historical_coverage_issues':row.get('coverage_issues',{})},indent=2), '```']
    lines += ['', 'Keyword matching does not establish terrorism. Source validation, English translation, '
              'incident deduplication and reported-status safeguards remain enabled.', '']
    text = '\n'.join(lines)
    path = Path(root)/'archive/threat-enrichment-status.md'
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(text,encoding='utf-8')
    target = os.getenv('GITHUB_STEP_SUMMARY')
    if target:
        with open(target,'a',encoding='utf-8') as handle: handle.write(text)
    return text


def health(root):
    report = read(root, STATUS)
    state = report.get('batch_status','unknown')
    if set(report.get('categories') or {}) != set(LABELS):
        print('::error title=Incomplete backfill report::Missing category counters; checkpoint needs repair.')
        return 1
    if state in ('running','failed','interrupted','blocked','unknown'):
        print(f'::error title=Backfill not productive::Batch state {state}; checkpoint preserved, not a completed backfill.')
        return 1
    if not report.get('complete'):
        print('::warning title=Backfill incomplete::Batch processed work but historical searches or source coverage limitations remain. See Summary.')
    return 0

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['configure', 'next', 'summary', 'health'])
    args = parser.parse_args()
    now = datetime.now(timezone.utc)
    if args.command == 'configure':
        result = configure(ROOT, now, os.getenv('GITHUB_RUN_ID', 'manual'),
                           os.getenv('GITHUB_EVENT_NAME', ''), os.getenv('CATCHUP_CONTINUATION', 'false') == 'true')
        if os.getenv('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as out:
                out.write(f"enabled={str(result['enabled']).lower()}\n")
        if os.getenv('GITHUB_ENV'):
            names = {'minutes': 'ENRICH_DEADLINE_MINUTES', 'searches': 'ENRICH_MAX_FETCHES',
                     'requests': 'ENRICH_MAX_POSTS', 'daily': 'ENRICH_DAILY_POSTS'}
            with open(os.environ['GITHUB_ENV'], 'a', encoding='utf-8') as out:
                for key, name in names.items():
                    out.write(f'{name}={result[key]}\n')
        print(json.dumps(result))
    elif args.command == 'next':
        yes, reason = continuation_decision(ROOT, now)
        print(reason)
        if os.getenv('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as out:
                out.write(f"continue={str(yes).lower()}\n")
    elif args.command == 'health':
        raise SystemExit(health(ROOT))
    else:
        print(summary(ROOT))


if __name__ == '__main__':
    main()
