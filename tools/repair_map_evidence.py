#!/usr/bin/env python3
"""Apply reviewed map integrity corrections, with a complete reversible audit."""
import argparse,json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from map_evidence_integrity import repair_document

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--apply',action='store_true');p.add_argument('--report',required=True);a=p.parse_args()
 path=Path('events.json'); data=json.loads(path.read_text(encoding='utf-8'))
 result,report=repair_document(data)
 out=Path(a.report);out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
 if a.apply:
  temp=path.with_suffix('.json.tmp');temp.write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False)+'\n',encoding='utf-8');temp.replace(path)
 print(json.dumps({'before':report['before']['records'],'after':report['after']['records'],'removed_to_audit':len(report['removed']),'changed_records':len(report['changes']),'new_records':0,'geography_review':report['after']['geolocation_review_ids']}))
if __name__=='__main__':main()
