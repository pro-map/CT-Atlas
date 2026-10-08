#!/usr/bin/env python3
"""Idempotent category migration; never deletes or fabricates an incident."""
from __future__ import annotations
import argparse
import copy
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT)); sys.path.insert(0,str(ROOT/'tools'))
import threat_categories
from archive_review import read_json, write_json

def migrate(path, write=False):
    data = read_json(path)
    if not isinstance(data,dict) or not isinstance(data.get('events'),list) or not data['events']:
        raise ValueError('Invalid database; migration refused')
    changed, counts, pending = 0, Counter(), []
    for event in data['events']:
        original = copy.deepcopy(event)
        threat_categories.annotate(event)
        changed += original != event
        allowed = {'category','categories','threat_taxonomy_version','threat_categories',
                   'legacy_category','category_review_required','cbrn_subgroups'}
        assert {k:v for k,v in original.items() if k not in allowed} == {k:v for k,v in event.items() if k not in allowed}, 'Migration changed incident evidence'
        assert not set(event.get('categories',[])) & {'CBRN','CBRNE'}, 'Legacy parent survived'
        counts.update(c for c in event.get('categories',[]) if c in threat_categories.LABELS)
        if event.get('category_review_required'): pending.append(event.get('id'))
    report = {'version':threat_categories.VERSION,'events_preserved':len(data['events']),
              'records_reclassified':changed,'category_counts':dict(counts),'needs_semantic_review':len(pending),
              'note':'Counts overlap when the same incident has multiple relevant topics.'}
    if write:
        if changed:
            data['last_updated'] = datetime.now(timezone.utc).isoformat()
        data['threat_taxonomy_version'] = threat_categories.VERSION
        if changed or 'threat_category_migration' not in data:
            data['threat_category_migration'] = report
        write_json(path,data,indent=2)
    return report

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--input',default=str(ROOT/'events.json'))
    p.add_argument('--write',action='store_true')
    a=p.parse_args()
    print(json.dumps(migrate(Path(a.input),a.write),ensure_ascii=False,indent=2))
if __name__ == '__main__':main()
