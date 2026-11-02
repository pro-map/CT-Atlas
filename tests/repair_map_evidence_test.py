"""Maintenance publication updates are distinct from collection attempts."""
import copy
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import map_evidence_integrity as integrity
from tools import repair_map_evidence as repair


class RepairPublicationTests(unittest.TestCase):
    def test_applied_repair_updates_snapshot_date_once_and_preserves_collection(self):
        event = {'id':'keep','country_code':'CO','city':'Bogotá','latitude':4.6,
                 'longitude':-74.1,'location_precision':'country_capital',
                 'location_method':'ai_country_capital','ai_geo_complete':True,
                 'geolocation_validation_issue':'ambiguous_or_unresolved_city',
                 'geolocation_requested_city':'Unresolved locality'}
        status = {'last_attempt_at':'2026-11-01T10:00:00+00:00',
                  'published_at':'2026-11-01T11:00:00+00:00',
                  'recent':{'reviewed':10},'source':{'errors':2},
                  'geolocation':{'located':1,'unlocated':0}}
        before = {'events':[event],'number_of_events':1,'collection_status':status,
                  'last_updated':status['published_at']}
        now = datetime(2026,11,2,12,tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as tmp, patch.object(integrity,'decisions',return_value={'rules':{},'merges':[]}):
            path, report = Path(tmp)/'events.json', Path(tmp)/'report.json'
            path.write_text(json.dumps(before),encoding='utf-8')
            original_bytes = path.read_bytes()
            repair.run(path,report)
            self.assertEqual(path.read_bytes(),original_bytes)
            repair.run(path,report,apply=True,now=now)
            after=json.loads(path.read_text())
            self.assertEqual(after['last_updated'],now.isoformat())
            self.assertEqual(after['collection_status']['published_at'],now.isoformat())
            for key in ('last_attempt_at','recent','source'):
                self.assertEqual(after['collection_status'][key],before['collection_status'][key])
            self.assertEqual(after['collection_status']['geolocation']['located'],0)
            self.assertEqual(after['collection_status']['geolocation']['unlocated'],1)
            self.assertEqual(after['collection_status']['data_maintenance']['ai_calls'],0)
            applied_bytes=path.read_bytes()
            repeated=repair.run(path,report,apply=True,now=datetime(2026,11,3,tzinfo=timezone.utc))
            self.assertEqual(path.read_bytes(),applied_bytes)
            self.assertFalse(repeated['changes']);self.assertFalse(repeated['removed'])


if __name__=='__main__':
    unittest.main()
