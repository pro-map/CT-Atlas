#!/usr/bin/env python3
"""Dataset receipts and post-deploy checks. No model calls or runtime quota changes."""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from attack_points import _located, is_map_attack, published_at
from daily_reliability import digest, metadata_repair, publication_delta, rows, timing, repair_known_city
FILES = ('events.json', 'events-lite.json', 'events-map.json')
# The site the mirror follows, so both publication gates compare with it: a mirror
# compared with itself would refuse the shrink a retirement has just published.
LIVE_SITE = 'https://ct-atlas.com'
MIN_RECORD_SHARE = 0.9
MIN_LOCATED_SHARE = 0.5
MAX_UNREADABLE_DATES = 0.01
# Gaps between map updates, 5 Oct to 5 Nov: usually 18.7 h overnight, because GitHub
# starts the first slot hours late, and 23.8 h at worst, across a failed run.
MAX_MAP_AGE_HOURS = 26
# Records of the 24 h before each of 46 collection runs: median 92, lowest 47, except
# 21 and 7 on the starved runs of 5 Nov.
MIN_RECORDS_24H = 30
# The mirror followed Pages within 9 minutes on every run since its last repair.
MIRROR_CATCH_UP_HOURS = 2


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


def content_problems(full, mapped, points, cutoff):
    """Damage that matching identifiers cannot see. No freshness rule on purpose:
    a failed collection must still be able to publish its honest status."""
    dates = {identifier: published_at(event) for identifier, event in full.items()}
    lost = sorted(identifier for identifier, when in dates.items()
                  if when and when >= cutoff and identifier not in mapped)
    unreadable = sum(when is None for when in dates.values())
    located = sum(_located(event) for event in full.values())
    problems = []
    if lost:
        problems.append(f'{len(lost)} records inside the map window are not in the map, such as {lost[0]}')
    if unreadable > MAX_UNREADABLE_DATES * len(full):
        problems.append(f'{unreadable} of {len(full)} published dates are unreadable')
    if located < MIN_LOCATED_SHARE * len(full):
        problems.append(f'only {located} of {len(full)} records are located')
    if not any(is_map_attack(event) and _located(event) for event in points):
        problems.append('the map has no attack point')
    return problems


def shrink_problems(files):
    if os.getenv('ALLOW_SHRINK') == '1':
        return []
    live = served_manifest(LIVE_SITE)
    try:
        return [f"{name} has {files[name]['record_count']} records, the live site {live['files'][name]['record_count']}"
                for name in FILES if files[name]['record_count'] < MIN_RECORD_SHARE * live['files'][name]['record_count']]
    except (KeyError, TypeError):
        print('::warning::The live manifest could not be read, so the shrink check was skipped.')
        return []


def manifest(directory, output, now=None):
    now = now or datetime.now(timezone.utc)
    root = Path(directory)
    from compact_mirror_json import read_mirror_bytes
    payloads = {name: read_mirror_bytes(root, name) for name in FILES}
    documents = {name: json.loads(content) for name, content in payloads.items()}
    import build_events_lite as light
    import build_events_map as map_file
    from retired_categories import active_event, is_retired_judicial_event
    light.validate(documents['events-lite.json'], documents['events.json'])
    full = {e['id']:active_event(e) for e in documents['events.json']['events'] if not is_retired_judicial_event(e)}
    lite, mapped = rows(documents['events-lite.json']), rows(documents['events-map.json'],True)
    if full.keys() != lite.keys() or not mapped.keys() <= full.keys():
        raise ValueError('Derived dataset identifiers do not match the full dataset')
    for name, subset in [('events-lite.json', lite), ('events-map.json', mapped)]:
        for identifier, row in subset.items():
            # A map point on its incident's city shows the record that lent it.
            lender = full.get(row.get('location_from_record'), full[identifier])
            for field in ('title', 'summary', 'categories', 'threat_categories', 'latitude', 'longitude'):
                source = lender if field in ('latitude', 'longitude') else full[identifier]
                if field in row and row[field] != source.get(field):
                    raise ValueError(f'Derived data differs: {name}/{identifier}/{field}')
    result = {'version': 1, 'created_at': now.isoformat(),
              'source_revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
              'files': {name: {'sha256_canonical_json': digest(document),
                              'sha256_bytes': hashlib.sha256(payloads[name]).hexdigest(),
                              'size_bytes': len(payloads[name]),
                              'last_updated': document.get('last_updated'),
                              'collection_status_finalized_at': (document.get('collection_status') or {}).get('finalized_at'),
                              'record_count': len(rows(document, name=='events-map.json'))}
                        for name, document in documents.items()}}
    problems = content_problems(full, mapped, documents['events-map.json']['events'],
                                now - timedelta(days=map_file.RECENT_DAYS)) + shrink_problems(result['files'])
    if problems:
        raise ValueError('Publication refused: ' + '; '.join(problems))
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
                    headers={'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity',
                             'User-Agent':'CT-Atlas-Publication-Check/1.0'})
                # The local build manifest is trusted and knows the real payload size.
                # A fixed 40 MiB ceiling rejected valid deployments as the database grew.
                expected_size = target.get('size_bytes', 0)
                if not isinstance(expected_size, int) or isinstance(expected_size, bool) or expected_size < 0:
                    raise ValueError('Invalid expected dataset size')
                read_limit = max(40 * 1024 * 1024, expected_size)
                with urllib.request.urlopen(request, timeout=60) as response:
                    content = response.read(read_limit + 1)
                if len(content) > read_limit:
                    raise ValueError('Published dataset exceeds its expected size bound')
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


def served_manifest(url):
    """The manifest a deployment serves now; None when it cannot be read."""
    if not url.startswith('https://'):
        raise ValueError('An HTTPS deployment URL is required')
    try:
        request = urllib.request.Request(url.rstrip('/')+'/publication-manifest.json?integrity='+str(time.time_ns()),
            headers={'Cache-Control': 'no-cache', 'User-Agent': 'CT-Atlas-Publication-Check/1.0'})
        with urllib.request.urlopen(request, timeout=30) as response:
            document = json.loads(response.read(1024 * 1024))
    except Exception:
        return None
    return document if isinstance(document, dict) else None


def served_revision(url):
    """Source revision of the manifest a deployment serves now; None when unknown."""
    # Unknown means "deploy": a skipped redeploy must never hide a stale site.
    revision = (served_manifest(url) or {}).get('source_revision')
    if isinstance(revision, str) and len(revision) == 40 and all(c in '0123456789abcdef' for c in revision):
        return revision
    return None


def read_live(url):
    """What a site serves at the URLs users fetch, so through the CDN cache."""
    def fetch(name):
        request = urllib.request.Request(url.rstrip('/')+'/'+name,
            headers={'Accept-Encoding': 'identity', 'User-Agent': 'CT-Atlas-Publication-Check/1.0'})
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read()
    try:
        document, payload = json.loads(fetch('publication-manifest.json')), fetch('events-map.json')
        return {'url': url, 'manifest': document, 'map': json.loads(payload),
                'sha256_bytes': hashlib.sha256(payload).hexdigest()}
    except Exception as error:
        raise RuntimeError(f'{url}: {type(error).__name__}: {str(error)[:160]}') from error


def moment(value):
    return published_at({'published': value})


def records_24h(document):
    """Records of the 24 h before the last collection run. Not before now: late in a long
    gap that window holds hours no run has reached yet, and a healthy map looks starved.
    Not before last_updated either: a repair moves it without collecting anything."""
    since = moment(document['collection_status']['last_attempt_at']) - timedelta(hours=24)
    dates = [published_at(event) for event in document['events'] + document['recent_events']]
    return sum(1 for when in dates if when and when >= since)


def live_problems(main, mirror, now):
    problems = [f"{site['url']}: events-map.json is not the file its manifest names"
                for site in (main, mirror)
                if site['sha256_bytes'] != site['manifest']['files']['events-map.json']['sha256_bytes']]
    updated = main['map']['last_updated']
    age = (now - moment(updated)).total_seconds() / 3600
    if age > MAX_MAP_AGE_HOURS:
        problems.append(f'the map was last updated {age:.1f} h ago, at {updated}')
    count = records_24h(main['map'])
    if count < MIN_RECORDS_24H:
        problems.append(f'only {count} records were published in the 24 h before the last collection run')
    # Comparing the two created_at alone would read an 18.7 h overnight gap as lag in
    # the minute before the mirror follows Pages, so the clock starts at the publication.
    ours, theirs = main['manifest'], mirror['manifest']
    if ours['files']['events.json']['sha256_canonical_json'] != theirs['files']['events.json']['sha256_canonical_json']:
        published, mirrored = moment(ours['created_at']), moment(theirs['created_at'])
        if mirrored < published and now - published > timedelta(hours=MIRROR_CATCH_UP_HOURS):
            problems.append(f"the mirror still serves the publication of {theirs['created_at']}, "
                            f"the site that of {ours['created_at']}")
    return problems


def live_check(url, mirror_url, attempts=12, sleep=time.sleep, now=None):
    """Fail while the public map is stale or the sites disagree. Retried for 11 minutes
    because Pages can serve a new manifest beside the old map until max-age=600 ends."""
    if not (url.startswith('https://') and mirror_url.startswith('https://')):
        raise ValueError('An HTTPS deployment URL is required')
    for attempt in range(attempts):
        try:
            main, mirror = read_live(url), read_live(mirror_url)
            problems = live_problems(main, mirror, now or datetime.now(timezone.utc))
        except Exception as error:
            problems = [f'{type(error).__name__}: {str(error)[:240]}']
        if not problems:
            print(f"Live map consistent: updated {main['map']['last_updated']}, "
                  f"{records_24h(main['map'])} records in the 24 h before its last collection run.")
            return
        print(f'Attempt {attempt+1} of {attempts}: ' + '; '.join(problems), flush=True)
        if attempt+1 < attempts:
            sleep(60)
    raise RuntimeError('Live publication check failed: ' + '; '.join(problems))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('mode', choices=['snapshot', 'repair', 'receipt', 'manifest', 'verify', 'served-revision', 'live'])
    p.add_argument('--before', default=os.getenv('RUNNER_TEMP', '.')+'/daily-before.json')
    p.add_argument('--output', default='publication-audit.json')
    p.add_argument('--directory', default='.')
    p.add_argument('--url')
    p.add_argument('--mirror-url')
    p.add_argument('--expected', default='publication-manifest.json')
    p.add_argument('--apply', action='store_true')
    p.add_argument('--repair-known-geography', action='store_true')
    a = p.parse_args()
    if a.mode=='snapshot': snapshot(a.before)
    elif a.mode=='repair': print(json.dumps(repair('events.json', a.output, a.apply, a.repair_known_geography)))
    elif a.mode=='receipt': receipt(a.before, a.output)
    elif a.mode=='manifest': manifest(a.directory, a.output)
    elif a.mode=='verify': verify(a.url or '', a.expected, a.output)
    elif a.mode=='served-revision': print(served_revision(a.url or '') or '')
    elif a.mode=='live': live_check(a.url or '', a.mirror_url or '')

if __name__=='__main__': main()
