#!/usr/bin/env python3
"""Dataset receipts and post-deploy checks. No model calls or runtime quota changes."""
from __future__ import annotations
import argparse
import copy
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from daily_reliability import digest, metadata_repair, publication_delta, rows, timing, repair_known_city
FILES = ('events.json', 'events-lite.json', 'events-map.json')


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def write(path, value):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)+'\n', encoding='utf-8')
    tmp.replace(path)


def snapshot(path):
    rows(read('events.json'))
    shutil.copyfile('events.json', path)


def repair(path, audit, apply=False, repair_geography=False):
    data = read(path); original = copy.deepcopy(data); by_id = rows(data)
    changes = []
    geography_ids = []
    for event in data['events']:
        change = metadata_repair(event)
        if change:
            changes.append({'id': event['id'], 'reason': 'derived_labels_reconciled_with_validated_categories', 'fields': change})
        if repair_geography and event.get('id')=='82b5e133d2a54751':
            import geolocate
            geo_change=repair_known_city(event, geolocate.resolve_city)
            if geo_change:
                geography_ids.append(event['id'])
                changes.append({'id':event['id'],'reason':'audited_Garsten_Windischgarsten_contradiction','fields':geo_change})
    # Forbid collateral changes; repairs are not discoveries or incident additions.
    for old, new in zip(original['events'], data['events']):
        for key in set(old)|set(new):
            allowed={'threat_categories','cbrn_subgroups'}
            if old.get('id') in geography_ids:
                allowed.update(('city','latitude','longitude','location_precision','location_method',
                    'location_confidence','location_confidence_score','geolocation_review_required'))
            if key not in allowed and old.get(key) != new.get(key):
                raise ValueError('Repair altered protected field: '+key)
    report = {'created_at': datetime.now(timezone.utc).isoformat(), 'mode': 'apply' if apply else 'dry_run',
              'new_records': 0, 'deleted_records': 0, 'repaired_entries': len(changes), 'geography_changed_ids':geography_ids, 'changes': changes}
    write(audit, report)
    if apply and changes:
        write(path, data)
    return report


def receipt(before, output):
    report = publication_delta(read(before), read('events.json'))
    created = None
    if os.getenv('GITHUB_RUN_ID') and os.getenv('GH_TOKEN'):
        # Only run metadata. Never log the token or any response headers.
        try:
            url = 'https://api.github.com/repos/'+os.environ['GITHUB_REPOSITORY']+'/actions/runs/'+os.environ['GITHUB_RUN_ID']
            req = urllib.request.Request(url, headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'], 'Accept':'application/vnd.github+json'})
            with urllib.request.urlopen(req, timeout=15) as response:
                created = json.load(response).get('created_at')
        except Exception:
            pass
    report['timing'] = timing(os.getenv('CT_ATLAS_SCHEDULE'), created, os.getenv('CT_ATLAS_RUN_STARTED_AT'))
    report['run_id'] = os.getenv('GITHUB_RUN_ID')
    report['source_revision'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    report['collection_status'] = read('events.json').get('collection_status', {})
    write(output, report)
    summary = os.getenv('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as stream:
            stream.write('\n### Dataset receipt (not a deployment confirmation)\n')
            stream.write(f"Added record IDs: {len(report['added_record_ids'])}; changed: {len(report['changed_record_ids'])}; removed: {len(report['removed_record_ids'])}.\n")
            stream.write('Record additions are not independently corroborated incidents.\n')
    return report


def manifest(directory, output):
    root = Path(directory); documents = {name: read(root/name) for name in FILES}
    import build_events_lite as light
    from retired_categories import active_event, is_retired_judicial_event
    light.validate(documents['events-lite.json'], documents['events.json'])
    full = {e['id']:active_event(e) for e in documents['events.json']['events'] if not is_retired_judicial_event(e)}
    lite, mapped = rows(documents['events-lite.json']), rows(documents['events-map.json'],True)
    if full.keys() != lite.keys() or not mapped.keys() <= full.keys():
        raise ValueError('Derived dataset identifiers do not match the full dataset')
    for name, subset in [('events-lite.json', lite), ('events-map.json', mapped)]:
        for identifier, row in subset.items():
            for field in ('title', 'summary', 'categories', 'threat_categories', 'latitude', 'longitude'):
                if field in row and row[field] != full[identifier].get(field):
                    raise ValueError(f'Derived data differs: {name}/{identifier}/{field}')
    result = {'version': 1, 'created_at': datetime.now(timezone.utc).isoformat(),
              'source_revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
              'files': {name: {'sha256_canonical_json': digest(document),
                              'record_count': len(rows(document, name=='events-map.json'))}
                        for name, document in documents.items()}}
    write(output, result)
    return result


def verify(url, expected_path, output, attempts=5, sleep=time.sleep):
    if not url.startswith('https://'):
        raise ValueError('An HTTPS deployment URL is required')
    expected = read(expected_path); result = {'url': url, 'publication_confirmed': False, 'files': {}}
    for attempt in range(attempts):
        errors = {}; verified = {}
        for name, target in expected['files'].items():
            if name not in FILES:
                raise ValueError('Unexpected manifest path')
            try:
                request = urllib.request.Request(url.rstrip('/')+'/'+name+'?integrity='+str(time.time_ns()),
                    headers={'Cache-Control': 'no-cache', 'User-Agent':'CT-Atlas-Publication-Check/1.0'})
                with urllib.request.urlopen(request, timeout=30) as response:
                    content = response.read(40*1024*1024+1)
                if len(content)>40*1024*1024:
                    raise ValueError('Published dataset exceeds audit read limit')
                data = json.loads(content)
                if digest(data) != target['sha256_canonical_json'] or len(rows(data, name=='events-map.json')) != target['record_count']:
                    raise ValueError('Published data differs from expected deployment')
                verified[name] = target
            except Exception as error:
                errors[name] = type(error).__name__+': '+str(error)[:160]
        result.update(checked_at=datetime.now(timezone.utc).isoformat(), attempt=attempt+1,
                      files=verified, errors=errors, publication_confirmed=not errors)
        write(output, result)
        if not errors:
            return result
        if attempt+1 < attempts:
            sleep(min(60, 4*2**attempt))
    raise RuntimeError('Deployment content verification failed; see receipt')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('mode', choices=['snapshot', 'repair', 'receipt', 'manifest', 'verify'])
    p.add_argument('--before', default=os.getenv('RUNNER_TEMP', '.')+'/daily-before.json')
    p.add_argument('--output', default='publication-audit.json')
    p.add_argument('--directory', default='.')
    p.add_argument('--url')
    p.add_argument('--expected', default='publication-manifest.json')
    p.add_argument('--apply', action='store_true')
    p.add_argument('--repair-known-geography', action='store_true')
    a = p.parse_args()
    if a.mode=='snapshot': snapshot(a.before)
    elif a.mode=='repair': print(json.dumps(repair('events.json', a.output, a.apply, a.repair_known_geography)))
    elif a.mode=='receipt': receipt(a.before, a.output)
    elif a.mode=='manifest': manifest(a.directory, a.output)
    elif a.mode=='verify': verify(a.url or '', a.expected, a.output)

if __name__=='__main__': main()
