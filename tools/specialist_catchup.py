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
            'minutes': min(int(config['minutes_per_round']), max(0, int((stamp(config['end_at'])-now).total_seconds()/60)-2)),
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
    stops = [str(row.get('last_run', {}).get('stop', '')) for row in report['categories'].values()]
    if any('AISelectionQuotaError' in stop or 'daily allocation already used' in stop for stop in stops):
        return False, 'Provider or daily request allowance reached; not bypassed and not marked complete.'
    work = sum(sum(int(row.get('last_run', {}).get(k, 0)) for k in ('tasks_done', 'reviewed', 'split'))
               for row in report['categories'].values())
    if not work:
        return False, 'No processing progress in the last batch; inspect source/AI errors rather than loop.'
    return True, f'{count} pending task/candidate units remain; resume from the saved checkpoint now.'


def summary(root):
    report = read(root, STATUS)
    control = read(root, STATE)
    lines = ['# Specialist six-month backfill', '', f"Last checkpoint (UTC): {report.get('updated_at', 'Not available')}",
             '', '**A successful batch is not completion of the whole backfill.**', '',
             '| Category | Main searches processed | Pending searches | Candidates awaiting review | Complete |',
             '|---|---:|---:|---:|---|']
    for name in LABELS:
        row = (report.get('categories') or {}).get(name, {})
        lines.append(f"| {name} | {row.get('completed_searches', 0)} / {row.get('planned_searches', 0)} | "
                     f"{row.get('pending_searches', '?')} | {row.get('queued_candidates', 0)} | "
                     f"{'Yes' if row.get('complete') else 'No'} |")
    lines += ['', f"Catch-up rounds started: {len(control.get('runs') or [])}. Acceleration ends at {control.get('end_at', 'not configured')}.",
              '', '## Latest batch / source limitations']
    for name in LABELS:
        row = (report.get('categories') or {}).get(name, {})
        last = row.get('last_run', {})
        # Render as JSON code, not unescaped externally sourced Markdown.
        lines += ['', f'### {name}', '```json', json.dumps({'stop': last.get('stop'),
                  'reviewed_this_batch': last.get('reviewed', 0), 'coverage_issues': row.get('coverage_issues', {})}, indent=2), '```']
    lines += ['', 'Keyword matching does not establish terrorism. Existing source validation, English translation, incident deduplication and reported-status safeguards remain enabled.', '']
    text = '\n'.join(lines)
    path = Path(root) / 'archive/threat-enrichment-status.md'
    path.write_text(text, encoding='utf-8')
    target = os.getenv('GITHUB_STEP_SUMMARY')
    if target:
        with open(target, 'a', encoding='utf-8') as handle:
            handle.write(text)
    return text


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['configure', 'next', 'summary'])
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
    else:
        print(summary(ROOT))


if __name__ == '__main__':
    main()
