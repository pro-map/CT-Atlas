#!/usr/bin/env python3
"""Apply reviewed map integrity corrections, with a complete reversible audit."""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from map_evidence_integrity import repair_document


def run(path, report_path, *, apply=False, resolve_city=None, now=None):
    path, report_path = Path(path), Path(report_path)
    data = json.loads(path.read_text(encoding='utf-8'))
    result, report = repair_document(data, resolve_city=resolve_city)
    changed = bool(report['changes'] or report['removed'])
    if changed and apply:
        timestamp = (now or datetime.now(timezone.utc)).isoformat()
        # The new version open maps and the Worker's caches key on.
        result['last_updated'] = timestamp
        status = result.get('collection_status')
        if isinstance(status, dict):
            # A new data publication is not a new collection or an AI run.
            # Preserve the collection's dates, coverage and provider counters:
            # published_at is what the page reads as the age of the data.
            status['data_maintenance'] = {
                'kind': 'reviewed_map_evidence_repair', 'applied_at': timestamp,
                'changed_records': len(report['changes']),
                'removed_records': len(report['removed']),
                'new_records': 0, 'ai_calls': 0,
            }
        report['applied_at'] = timestamp
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False)+'\n', encoding='utf-8')
    if changed and apply:
        temp = path.with_suffix('.json.tmp')
        temp.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False)+'\n', encoding='utf-8')
        temp.replace(path)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--report', required=True)
    args = parser.parse_args()
    from geolocate import resolve_city
    report = run('events.json', args.report, apply=args.apply, resolve_city=resolve_city)
    print(json.dumps({
        'before': report['before']['records'], 'after': report['after']['records'],
        'removed_to_audit': len(report['removed']), 'changed_records': len(report['changes']),
        'new_records': 0, 'geography_review': report['after']['geolocation_review_ids'],
    }))


if __name__ == '__main__':
    main()
