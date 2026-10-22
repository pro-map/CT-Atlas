import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import map_evidence_integrity as m

class IntegrityTests(unittest.TestCase):
 def test_numbers_and_secondary_sources_do_not_establish_same_incident(self):
  a={'title':'Lebanese army seizes 200 kilograms of explosives','related_articles':[{'url':'same'}]}
  b={'title':'200 spectators attend football match in Brazil','related_articles':[{'url':'same'}]}
  self.assertFalse(m.primary_pair_supported(a,b))
 def test_primary_anchor_allows_existing_matcher_to_decide(self):
  self.assertTrue(m.primary_pair_supported({'title':'Flydubai aircraft diverted after attack'},{'title':'Flydubai passengers subdue attacker'}))
 def test_shared_actor_alone_does_not_merge_arrest_and_war(self):
  self.assertFalse(m.primary_pair_supported({'title':'US employee arrested for Houthi support'},{'title':'Houthi forces kill 80 in Taiz fighting'}))
 def test_explicit_natural_rationale_rejected_but_powders_preserved(self):
  r={'categories':['Biological Terrorism'],'english_title':'Ebola health ministry alert','reason':'Natural/epidemiological rather than terrorist'}
  self.assertTrue(m.explicit_category_conflict({},r))
  r['english_title']='Suspicious powder letter prompts office evacuation';self.assertFalse(m.explicit_category_conflict({},r))
 def test_correction_is_bound_to_source_evidence(self):
  e={'id':'x','url':'a','title':'Gun seizure','summary':'Pistol','categories':['Chemicals and Explosives']}
  plan={'rules':{'x':{'expected_primary_evidence':m.evidence_key(e),'reason':'firearms only','categories':['Weapons']}},'merges':[]}
  with patch.object(m,'decisions',return_value=plan):
   m.apply_rule(e);self.assertEqual(e['categories'],['Weapons']);before=copy.deepcopy(e);m.apply_rule(e);self.assertEqual(before,e)
   e['url']='new-evidence';e['categories']=['Chemicals and Explosives'];m.apply_rule(e);self.assertEqual(e['categories'],['Chemicals and Explosives'])
 def test_geo_withdrawal_does_not_invent_capital(self):
  e={'id':'x','title':'Mambasa','url':'a','summary':'DRC','country_code':'CD','latitude':-4.05,'longitude':39.66}
  plan={'rules':{'x':{'expected_primary_evidence':m.evidence_key(e),'reason':'Wrong-country point','clear_geography':True}},'merges':[]}
  with patch.object(m,'decisions',return_value=plan):
   m.apply_rule(e);self.assertIsNone(e['latitude']);self.assertEqual(e['country_code'],'CD');self.assertTrue(e['geolocation_review_required'])
 def test_quarantine_and_merge_are_auditable_not_discoveries(self):
  a={'id':'a','url':'a','title':'Emilio Zapata arrested','summary':'same','categories':['Arrests'],'published':'2026-10-14'}
  b=dict(a,id='b',url='b');c=dict(a,id='c',url='c',title='Natural cholera')
  plan={'rules':{'c':{'expected_primary_evidence':m.evidence_key(c),'reason':'natural','action':'quarantine'}},'merges':[{'canonical_id':'a','retired_id':'b','expected_canonical_evidence':m.evidence_key(a),'expected_retired_evidence':m.evidence_key(b),'reason':'reviewed duplicate'}]}
  with patch.object(m,'decisions',return_value=plan):
   result,report=m.repair_document({'events':[a,b,c]})
   self.assertEqual([e['id']for e in result['events']],['a']);self.assertEqual(report['added_record_ids'],[])
   self.assertEqual({r['id']for r in report['removed']},{'b','c'})
   self.assertIn('b',{x['url']for x in result['events'][0]['related_articles']})
   twice,report2=m.repair_document(copy.deepcopy(result));self.assertEqual(report2['changes'],[]);self.assertEqual(report2['removed'],[])
 def test_incident_record_merge_rejects_unrelated_reused_id(self):
  import collector
  a={'id':'a','title':'Nobel economics prize awarded','incident_id':'inc-x','published':'2026-10-12T10:00:00Z','update_type':'INITIAL'}
  b={'id':'b','title':'Lebanese explosives seized','incident_id':'inc-x','published':'2026-10-12T11:00:00Z','update_type':'INITIAL'}
  self.assertEqual(len(collector.merge_incident_records([a,b])),2)
 def test_primary_promotion_does_not_keep_old_raw_evidence(self):
  import collector
  a={'id':'a','title':'Football match','summary':'Football','original_title':'Old football','original_summary':'Old football raw','source':'Low','url':'https://x.test/old','categories':['Arrests']}
  b={'id':'b','title':'Suspect arrested','summary':'Suspect arrested in a plot','source':'High','url':'https://x.test/new','categories':['Arrests']}
  with patch.object(collector,'source_rank',side_effect=lambda name:10 if name=='High'else 1):collector.merge_event(a,b)
  self.assertEqual(a['original_title'],'Suspect arrested');self.assertEqual(a['original_summary'],b['summary'])
if __name__=='__main__':unittest.main()
