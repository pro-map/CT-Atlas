#!/usr/bin/env python3
"""Print effective loaded collection settings without network calls or writes."""
import argparse
import json
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import collector
import collection_config


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Fail if runtime metadata disagrees with loaded collection')
    args = parser.parse_args()
    report = (collection_config.validate_runtime(vars(collector)) if args.check
              else collection_config.effective(vars(collector)))
    report['scheduled_selection_threshold'] = json.loads((ROOT / 'ct-atlas-runtime.json').read_text())['ai_selection_threshold']
    report['planned_daily_requests'] = collector.planned_collection_query_count()
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
