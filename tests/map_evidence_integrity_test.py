import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import map_evidence_integrity as m

class IntegrityTests(unittest.TestCase):
 def test_exact_original_article_ignores_rss_token_and_translation(self):
  a={'id':'a','source':'Daily News','original_title':'Police arrest three suspects in the named village','published':'2026-11-01T08:13:27Z','title':'Translation A','url':'https://news.google.com/rss/articles/one','custom_metadata':{'retained':True}}
  b=dict(a,id='b',source='DAILY NEWS',title='Translation B',url='https://news.google.com/rss/articles/two',incident_id='other-generated-id')
  self.assertTrue(m.same_original_article(a,b))
  with patch.object(m,'decisions',return_value={'rules':{},'merges':[]}):
   result,report=m.repair_document({'events':[copy.deepcopy(a),copy.deepcopy(b)]})
   self.assertEqual(len(result['events']),1)
   canonical=result['events'][0]
   self.assertEqual({canonical['url']}|{x['url']for x in canonical['related_articles']},{a['url'],b['url']})
   self.assertEqual(canonical['duplicate_record_evidence'][0]['custom_metadata'],{'retained':True})
   self.assertEqual(report['removed'][0]['disposition'],'verified_duplicate')
   self.assertEqual(report['removed'][0]['record'],b)
   twice,report2=m.repair_document(copy.deepcopy(result))
   self.assertEqual(twice,result)
   self.assertEqual(report2['changes'],[])
 def test_original_article_identity_never_uses_only_date_or_translated_title(self):
  a={'source':'Daily News','original_title':'Police arrest suspects after an attack in a named village','published':'2026-11-01T08:13:27Z'}
  self.assertFalse(m.same_original_article(a,dict(a,published='2026-11-02T08:13:27Z')))
  self.assertFalse(m.same_original_article(a,dict(a,source='Other News')))
  self.assertFalse(m.same_original_article(a,dict(a,original_title='Another original article on the same incident')))
  self.assertIsNone(m.original_article_key(dict(a,published='2026-11-01')))
  self.assertIsNone(m.original_article_key(dict(a,original_title='',title=a['original_title'])))
 def test_unresolved_city_capital_is_withdrawn_but_deliberate_country_marker_survives(self):
  a={'country_code':'CO','city':'Bogotá','latitude':4.6,'longitude':-74.1,'location_precision':'country_capital','location_method':'ai_country_capital','geolocation_validation_issue':'ambiguous_or_unresolved_city','geolocation_requested_city':'Puerto Guzmán','ai_geo_reason':'Source city'}
  before=copy.deepcopy(a)
  self.assertTrue(m.withdraw_unresolved_city_fallback(a))
  self.assertIsNone(a['latitude']);self.assertEqual(a['country_code'],'CO');self.assertEqual(a['geolocation_requested_city'],'Puerto Guzmán')
  self.assertEqual(a['ai_geo_reason'],'Source city');self.assertFalse(m.withdraw_unresolved_city_fallback(a))
  before.pop('geolocation_validation_issue'); original=copy.deepcopy(before)
  self.assertFalse(m.withdraw_unresolved_city_fallback(before));self.assertEqual(before,original)
 def test_normalized_city_repair_requires_unique_same_country_resolution(self):
  e={'country_code':'CO','geolocation_validation_issue':'ambiguous_or_unresolved_city','geolocation_requested_city':'C&#xfa;cuta'}
  self.assertFalse(m.repair_unresolved_city(e,lambda *args:None))
  self.assertFalse(m.repair_unresolved_city(e,lambda *args:{'countrycode':'MX'}))
  c={'name':'Cúcuta','countrycode':'CO','latitude':7.90745,'longitude':-72.5049,'geonameid':3685533}
  self.assertTrue(m.repair_unresolved_city(e,lambda *args:c))
  self.assertEqual(e['city'],'Cúcuta');self.assertFalse(e['geolocation_review_required'])
  self.assertNotIn('geolocation_validation_issue',e)
 def test_city_repair_shows_the_source_spelling_not_the_geonames_main_name(self):
  karak={'name':'Qīr Moāv','countrycode':'JO','latitude':31.18248,'longitude':35.69999,'geonameid':250624}
  e={'country_code':'JO','geolocation_validation_issue':'ambiguous_or_unresolved_city','geolocation_requested_city':' Karak '}
  self.assertTrue(m.repair_unresolved_city(e,lambda *args:karak))
  self.assertEqual((e['city'],e['latitude'],e['geolocation_resolution_geonameid']),('Karak',31.18248,250624))
  self.assertFalse(m.restore_requested_city_label(e))
  # Records corrected before the fix carry the GeoNames main name.
  old=dict(e,city='Qīr Moāv');self.assertTrue(m.restore_requested_city_label(old));self.assertEqual(old['city'],'Karak')
  self.assertFalse(m.restore_requested_city_label(old))
  for other in (dict(old,city='Qīr Moāv',location_method='ai_city'),dict(old,city='Garsten',geolocation_requested_city=None),
                dict(old,city='Qīr Moāv',geolocation_resolution_geonameid=None)):
   before=copy.deepcopy(other);self.assertFalse(m.restore_requested_city_label(other));self.assertEqual(other,before)
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
 def test_promoted_primary_keeps_own_publication_time_for_duplicate_replay(self):
  import collector
  low={'id':'low','title':'Police report a raid in the named village','original_title':'Police report a raid in the named village','summary':'Initial report','source':'Low','url':'https://low.test/one','categories':['Arrests'],'published':'2026-11-01T08:00:00Z'}
  high={'id':'high','title':'Three suspects arrested in the named village','original_title':'Three suspects arrested in the named village','summary':'Confirmed report','source':'High','url':'https://high.test/two','categories':['Arrests'],'published':'2026-11-01T09:00:00Z'}
  replay=copy.deepcopy(high)
  with patch.object(collector,'source_rank',side_effect=lambda name:10 if name=='High'else 1):
   collector.merge_event(low,high)
  self.assertEqual(low['published'],'2026-11-01T08:00:00Z')
  self.assertEqual(low['primary_source_published'],'2026-11-01T09:00:00Z')
  self.assertTrue(m.same_original_article(low,replay))
  old_source=next(a for a in low['related_articles']if a['source']=='Low')
  self.assertEqual(old_source['published'],'2026-11-01T08:00:00Z')
  self.assertEqual(m.independent_article(low)['published'],'2026-11-01T09:00:00Z')
 def test_earlier_incoming_report_does_not_change_unchanged_primary_timestamp(self):
  import collector
  existing={'id':'high','title':'Named village arrest confirmed by police','original_title':'Named village arrest confirmed by police','source':'High','url':'https://high.test/two','published':'2026-11-01T09:00:00Z'}
  new={'id':'low','title':'First report of the named village arrest','source':'Low','url':'https://low.test/one','published':'2026-11-01T08:00:00Z'}
  with patch.object(collector,'source_rank',side_effect=lambda name:10 if name=='High'else 1):
   collector.merge_event(existing,new)
  self.assertEqual(existing['published'],'2026-11-01T08:00:00Z')
  self.assertEqual(existing['primary_source_published'],'2026-11-01T09:00:00Z')

class ConsolidationSupportTests(unittest.TestCase):
 """Gemini proposes; the headlines decide which keys of its group merge."""
 def test_accents_fold_and_only_headlines_count(self):
  e={'title':'Attaque à Kerák','original_title':'هجوم الكرك','incident_anchor':'Amman attack','city':'Amman','summary':'Amman'}
  self.assertEqual(m.headline_words(e),{'attaque','kerak','هجوم','الكرك'})
 def test_country_names_and_widespread_words_are_weak(self):
  week=lambda n:f'2026-{9+n//4:02d}-{1+7*(n%4):02d}T10:00:00+00:00'
  # 'atentado': 4 countries x 3 weeks = 12 (country, week) pairs.
  events=[{'title':f'Atentado contra patrol {c}{n}','country':c,'country_code':c[:2].upper(),'published':week(n)}
          for c in ('Spain','Colombia','Mexico','Peru') for n in range(3)]
  # 'borno' comes back in 6 Nigerian weeks: weak in Nigeria only.
  events+=[{'title':f'Borno ambush {n}','country':'Nigeria','country_code':'NG','published':week(n)} for n in range(6)]
  # One incident's name reported from 6 countries in its week stays distinctive.
  events+=[{'title':'Flydubai copilot attack','country':c,'country_code':c,'published':week(0)} for c in ('AE','IL','AU','IN','SA','OM')]
  events.append({'title':'Karak church attack','country':'Jordan','country_code':'JO','published':week(0)})
  weak=m.consolidation_weak_words(events,['jordanian'])
  self.assertTrue({'atentado','contra','patrol','spain','jordan','jordanian'}<=weak.common)
  self.assertEqual(weak.distinctive({'borno','karak','flydubai','copilot'},'NG'),{'karak','flydubai','copilot'})
  self.assertEqual(weak.distinctive({'borno','karak','flydubai'},'JO'),{'borno','karak','flydubai'})
 def test_accented_and_plain_spellings_support_each_other(self):
  self.assertTrue(m.consolidation_pair_supported({'id':'a','title':'Gunmen strike in Kerák'},{'id':'b','title':'Kerak mourning continues'},set()))
 def test_a_weak_shared_word_is_not_support_but_identity_still_is(self):
  a={'id':'a','title':'Nigerian army kills bandit leaders'};b={'id':'b','title':'Nigerian customs intercept cocaine'}
  self.assertTrue(m.primary_pair_supported(a,b));self.assertFalse(m.consolidation_pair_supported(a,b,{'nigerian'}))
  self.assertTrue(m.consolidation_pair_supported(a,dict(b,title='Nigerian army kills bandit leaders in Zamfara'),{'nigerian'}))
  self.assertTrue(m.consolidation_pair_supported(a,dict(b,title='Zamfara bandits',url='u'),set()) is False)
  self.assertTrue(m.consolidation_pair_supported(dict(a,url='u'),dict(b,url='u'),{'nigerian'}))
 def test_an_isolated_record_is_never_supported(self):
  a={'id':'a','title':'Karak church attack'};b={'id':'b','title':'Karak church mourning'}
  self.assertTrue(m.consolidation_pair_supported(a,b,set()))
  with patch.object(m,'matched_rule',lambda e:{'isolated_incident':'inc-review-a'} if e['id']=='a' else None):
   self.assertFalse(m.consolidation_pair_supported(a,b,set()))
 def test_components_keep_the_supported_keys_and_leave_out_a_one_link_intruder(self):
  edges={frozenset(p) for p in ('ab','ac','ad','ae','bc','bd','be','cd','ce','de','ex')}
  linked=lambda x,y:frozenset((x,y)) in edges
  self.assertEqual(m.supported_incident_components(list('abcdex'),linked),([list('abcde')],['x']))
  # Two cases Gemini put in one group stay two cases; an unlinked key stays alone.
  edges={frozenset(p) for p in ('ab','cd')}
  self.assertEqual(m.supported_incident_components(list('abcdz'),linked),([['a','b'],['c','d']],['z']))
  # A short chain is a real case (a real group of 3 rarely has all 3 pairs).
  edges={frozenset(p) for p in ('ab','bc')}
  self.assertEqual(m.supported_incident_components(list('abc'),linked),([['a','b','c']],[]))
  self.assertEqual(m.supported_incident_components([],linked),([],[]))
  self.assertEqual(m.supported_incident_components(list('abab'),linked),([['a','b']],[]))
 def test_an_intruder_does_not_evict_a_genuine_member(self):
  # Chain a-b-c-d (time order) and x linked to a only: x leaves, d stays.
  edges={frozenset(p) for p in ('ab','bc','cd','ax')}
  linked=lambda x,y:frozenset((x,y)) in edges
  self.assertEqual(m.supported_incident_components(list('abcdx'),linked),([list('abcd')],['x']))
 def test_a_hub_keeps_its_earliest_links_and_a_ring_stays_merged_in_parts(self):
  edges={frozenset(('h',leaf)) for leaf in '123456789'}
  linked=lambda x,y:frozenset((x,y)) in edges
  self.assertEqual(m.supported_incident_components(list('h123456789'),linked),([list('h123')],list('456789')))
  ring='abcdefgh';edges={frozenset((ring[n],ring[(n+1)%8])) for n in range(8)}
  self.assertEqual(m.supported_incident_components(list(ring),linked),([list('abcd')],list('efgh')))
 def test_set_aside_keys_are_not_grouped_among_themselves(self):
  # Re-grouping them built 40- to 130-key false incidents when Gemini lumped
  # a whole window into one group (2026-11-04 stress test).
  edges={frozenset(p) for p in ('ab','bc','cd','de','ex')}
  linked=lambda x,y:frozenset((x,y)) in edges
  self.assertEqual(m.supported_incident_components(list('abcdex'),linked),([list('abcd')],['e','x']))
 def test_a_lumped_window_is_refused_whole(self):
  keys=[f'k{n:03d}' for n in range(m.CONSOLIDATION_MAX_GROUP_KEYS+1)]
  self.assertEqual(m.supported_incident_components(keys,lambda x,y:True),([],keys))
  self.assertEqual(m.supported_incident_components(keys[:-1],lambda x,y:True),([keys[:-1]],[]))
 def test_foreign_country_names_and_one_language_generic_words_are_weak(self):
  weak=m.consolidation_weak_words([])
  for word in ('الاردن','jordanie','francia','nuevo','המחבלים','patlayici'):
   self.assertIn(word,weak.common,word)
  self.assertEqual(m.headline_words({'title':'هجوم في الأردن'})-weak.common,{'هجوم'})
 def test_a_key_linked_to_a_third_of_its_component_stays(self):
  # 7 keys: core a-f fully linked, g linked to a and b (2 of 6 = 1/3).
  edges={frozenset((x,y)) for x in 'abcdef' for y in 'abcdef' if x<y}|{frozenset(('g',x)) for x in 'ab'}
  linked=lambda x,y:frozenset((x,y)) in edges
  self.assertEqual(m.supported_incident_components(list('abcdefg'),linked),([list('abcdefg')],[]))
  edges.discard(frozenset('gb'))
  self.assertEqual(m.supported_incident_components(list('abcdefg'),linked),([list('abcdef')],['g']))
if __name__=='__main__':unittest.main()
