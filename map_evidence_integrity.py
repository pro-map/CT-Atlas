"""Conservative evidence safeguards and reviewed corrections. No provider calls.

Similar titles, reused incident IDs and shared secondary sources are not proof
of one real-world incident. Uncertain cases remain separate and reviewable.
"""
from __future__ import annotations
import copy
import hashlib
import json
import re
import unicodedata
from functools import lru_cache
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent
VERSION = 'map-evidence-review-20261022'
SPECIALIST = {'Radiological/Nuclear', 'Chemicals and Explosives', 'Biological Terrorism'}
ARTICLE_FIELDS = ('title','summary','original_title','original_summary','original_language','source','url','published')
# Generic actions, actors and numbers cannot anchor distinct cases together.
GENERIC = set('the this that with from into after before during following over under against about near across alleged suspected reported reports report says said more than killed kills killing dead death deaths injured attack attacks attacked terrorist terrorists terrorism terror militant militants police officer officers forces security army military troops arrest arrested arrests arresting detained detention suspects suspect operation operations weapons weapon explosive explosives bomb bombing bombs plot thwarted foiled counter raid raids seize seized seizure smuggling group groups members member leader officials official people killed two three four five houthi houthis hezbollah hamas isis isil iswap daesh qaeda taliban farc current news update latest material support investigation announces video authorities government new national state country year years children teenager teenagers'.split())


def original_article_key(event):
    """Identify the same primary article despite a changed RSS redirect/translation.

    This is deliberately narrower than incident matching: require an original
    headline, the same publisher and an exact, timezone-aware publication time.
    A matching translated headline, a day, or a secondary article is insufficient.
    """
    title = ' '.join(unicodedata.normalize('NFKC', str(event.get('original_title') or '')).casefold().split())
    source = ' '.join(unicodedata.normalize('NFKC', str(event.get('source') or '')).casefold().split())
    published = event.get('primary_source_published') or event.get('published')
    if len(title) < 25 or not source or not isinstance(published, str) or 'T' not in published:
        return None
    try:
        timestamp = datetime.fromisoformat(published.replace('Z', '+00:00'))
    except ValueError:
        return None
    if timestamp.tzinfo is None:
        return None
    return source, title, timestamp.astimezone(timezone.utc).isoformat()


def same_original_article(left, right):
    key = original_article_key(left)
    return bool(key and key == original_article_key(right))


def withdraw_unresolved_city_fallback(event):
    """Remove a capital substituted for a failed city lookup, without guessing.

    Deliberate country-level markers are untouched. The country, requested
    locality, source evidence and original AI decision remain available.
    """
    if (event.get('geolocation_validation_issue') != 'ambiguous_or_unresolved_city'
            or event.get('location_method') != 'ai_country_capital'
            or event.get('location_precision') != 'country_capital'):
        return False
    event.update(city=None, region=None, latitude=None, longitude=None,
                 location_precision='unlocated', location_confidence='low',
                 location_confidence_score=0.0,
                 location_method='unresolved_city_no_capital_fallback',
                 geolocation_review_required=True, excluded_from_map=False,
                 location_review_reason='The requested locality could not be resolved unambiguously; a country capital is not evidence of the incident location.')
    return True


def requested_city_label(requested):
    """The source's own spelling, as the live geolocation shows it ('Karak',
    'Hodeidah'), not the GeoNames main name ('Qir Moav', 'Al Hudaydah'); only
    the coordinates and the geonameid come from GeoNames."""
    import html
    return ' '.join(html.unescape(str(requested or '')).split())


def restore_requested_city_label(event):
    """Records corrected before 2026-11-04 show the GeoNames main name."""
    requested = requested_city_label(event.get('geolocation_requested_city'))
    if (event.get('location_method') != 'source_name_geonames_correction'
            or not event.get('geolocation_resolution_geonameid')
            or not requested or event.get('city') == requested):
        return False
    event['city'] = requested
    return True


def repair_unresolved_city(event, resolve_city):
    """Reapply only an exact country-locked lookup after text normalization fixes."""
    if event.get('geolocation_validation_issue') != 'ambiguous_or_unresolved_city':
        return False
    requested = event.get('geolocation_requested_city')
    country = event.get('country_code')
    if not requested or not country:
        return False
    city = resolve_city(requested, country)
    if not city or city.get('countrycode') != country:
        return False
    event.update(city=requested_city_label(requested) or city['name'], region=None, latitude=float(city['latitude']),
                 longitude=float(city['longitude']), location_precision='city',
                 location_method='source_name_geonames_correction',
                 location_confidence='medium', location_confidence_score=0.75,
                 geolocation_review_required=False,
                 geolocation_resolution_geonameid=city.get('geonameid'),
                 location_review_reason='The previously requested locality now resolves uniquely in its recorded country after Unicode/HTML normalization; no new location was inferred.')
    event.pop('geolocation_validation_issue', None)
    return True


def collapse_original_article_duplicates(events):
    """Fold only repeated primary articles, retaining every source and preimage."""
    from collections import defaultdict
    groups = defaultdict(list)
    for event in events:
        key = original_article_key(event)
        if key:
            groups[key].append(event)
    removed = set()
    for group in groups.values():
        if len(group) < 2 or len({e.get('id') for e in group}) != len(group):
            continue
        # A reviewed separation always wins over automatic duplicate detection.
        if any((matched_rule(e) or {}).get('isolated_incident') for e in group):
            continue
        canonical = min(group, key=lambda e: (
            -bool(matched_rule(e)), -len(e.get('related_articles') or []),
            -int(e.get('location_precision') == 'city' and not e.get('geolocation_review_required')),
            str(e.get('id'))))
        for old in group:
            if old is canonical:
                continue
            preimage = copy.deepcopy(old)
            fingerprint_union = set(canonical.get('source_article_fingerprints') or []) | set(old.get('source_article_fingerprints') or [])
            canonical.setdefault('related_articles', []).append(independent_article(old))
            canonical['related_articles'].extend(copy.deepcopy(old.get('related_articles') or []))
            rebuild_sources(canonical)
            canonical['source_article_fingerprints'] = sorted(fingerprint_union | set(canonical['source_article_fingerprints']))
            canonical['duplicate_record_ids'] = sorted(set(canonical.get('duplicate_record_ids') or []) | set(old.get('duplicate_record_ids') or []) | {old['id']})
            snapshots = canonical.setdefault('duplicate_record_evidence', [])
            if preimage not in snapshots:
                snapshots.append(preimage)
            canonical['article_identity_deduplication'] = 'same_original_headline_publisher_and_timestamp'
            dates = [e.get(k) for e in (canonical, old) for k in ('first_reported', 'published') if e.get(k)]
            if dates:
                canonical['first_reported'] = min(dates)
            dates = [e.get(k) for e in (canonical, old) for k in ('last_reported', 'published') if e.get(k)]
            if dates:
                canonical['last_reported'] = max(dates)
            removed.add(old['id'])
    return [event for event in events if event.get('id') not in removed]


def evidence_key(event):
    material = [event.get('url',''), event.get('original_title') or event.get('title',''),
                event.get('original_summary') or event.get('summary','')]
    return hashlib.sha256(json.dumps(material,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()


@lru_cache(maxsize=1)
def decisions():
    result = json.loads((ROOT/'map-integrity-decisions.json').read_text(encoding='utf-8'))
    if result.get('version') != 1 or not isinstance(result.get('rules'),dict):
        raise ValueError('Invalid reviewed map-integrity decisions')
    return result


def matched_rule(event):
    rule = decisions()['rules'].get(str(event.get('id')))
    if rule and 'reviewed_article_urls' in rule:
        urls={a.get('url') for a in [event]+event.get('related_articles',[]) if a.get('url')}
        if not urls <= set(rule['reviewed_article_urls']):
            return None
    if rule and ((event.get('integrity_review_version') == VERSION and
                  event.get('integrity_source_evidence') == evidence_key(event))
                 or evidence_key(event) == rule['expected_primary_evidence']):
        return rule
    return None


def words(value):
    value = unicodedata.normalize('NFKD', str(value or '')).casefold()
    return {x for x in re.findall(r'[^\W\d_]+',value) if len(x)>=4 and x not in GENERIC}


def primary_pair_supported(left, right):
    """A veto only, not a sufficient merge decision. Never inspect secondary URLs.

    Existing matcher/date/stage checks still decide whether a supported pair
    should merge. Missing comparable anchors preserve both records.
    """
    for e, other in ((left,right),(right,left)):
        rule = matched_rule(e)
        if rule and rule.get('isolated_incident') and e.get('id') != other.get('id'):
            return False
    if same_original_article(left, right):
        return True
    if left.get('url') and left.get('url') == right.get('url'):
        return True
    a, b = str(left.get('title')or '').casefold().strip(), str(right.get('title')or '').casefold().strip()
    if a and b and (a==b or (min(len(a),len(b))>=8 and (a.startswith(b+' ') or b.startswith(a+' ')))):
        return True
    # Use source-language headlines too; do not substitute generated incident anchors.
    at = words(a+' '+str(left.get('original_title')or ''))
    bt = words(b+' '+str(right.get('original_title')or ''))
    return bool(at & bt)


def explicit_category_conflict(event, result):
    """Reject only explicit contradictions, not absence of English keywords.

    Suspicious mail/powders/hoaxes remain in the provisional Bio monitoring scope.
    Unclear specialist evidence is reviewable, not inferred from retrieval labels.
    """
    cats = set(result.get('categories')or [])
    if 'Biological Terrorism' not in cats:
        return ''
    reason = str(result.get('reason')or '').lower()
    text = ' '.join(str(result.get(k)or '') for k in ('english_title','english_summary')).lower()
    if re.search(r'letter|envelope|package|powder|hoax|deliberate|intentional|attack|weapon|poison|contaminat',text):
        return ''
    if re.search(r'(?:natural[/ -]epidemiological|natural outbreak|not (?:a )?terrorist|no terrorist (?:nexus|involvement)|public.health (?:alert|monitoring))',reason) and re.search(r'outbreak|health ministry|plague|ebola|cholera|lab(?:oratory)? worker',text):
        return 'Biological classification explicitly contradicted by the retained epidemiological rationale'
    return ''


def independent_article(event):
    article = {k:copy.deepcopy(event[k]) for k in ARTICLE_FIELDS if k in event}
    if event.get('primary_source_published'):
        article['published'] = event['primary_source_published']
    return article


def rebuild_sources(event):
    """Discard only redundant associations, not unlinked evidence in the audit."""
    from collector import selection_fingerprint
    seen={event.get('url')}; related=[]
    for article in event.get('related_articles')or []:
        key=article.get('url') or json.dumps(article,sort_keys=True,ensure_ascii=False)
        if key in seen: continue
        seen.add(key);related.append(article)
    event['related_articles']=related
    articles=[independent_article(event)]+related
    event['sources']=list(dict.fromkeys(a.get('source') for a in articles if a.get('source')))
    event['source_count']=len(event['sources'])
    event['article_count']=len(articles)
    event['source_article_fingerprints']=sorted({selection_fingerprint(dict(a,title=a.get('original_title')or a.get('title'),summary=a.get('original_summary')or a.get('summary'))) for a in articles})
    event['title_variants']=list(dict.fromkeys(a.get('title') for a in articles if a.get('title')))


def apply_rule(event):
    rule=matched_rule(event)
    if not rule: return False
    before=copy.deepcopy(event)
    if rule.get('detach_urls'):
        excluded=set(rule['detach_urls'])
        event['related_articles']=[a for a in event.get('related_articles',[]) if a.get('url') not in excluded]
    if rule.get('promote_article_url') and event.get('url') != rule['promote_article_url']:
        match=next((a for a in event.get('related_articles',[]) if a.get('url')==rule['promote_article_url']),None)
        if match:
            # Record date remains the cluster's report date; article date is separate.
            event['primary_source_published']=match.get('published')
            for field in ARTICLE_FIELDS:
                if field=='published': continue
                event[field]=copy.deepcopy(match.get(field,''))
            event['original_summary']=match.get('original_summary')or match.get('summary','')
    for field in ('title','summary'):
        if field in rule: event[field]=rule[field]
    if 'categories' in rule:
        event['categories']=list(rule['categories'])
        event['category']=event['categories'][0] if event['categories'] else ''
        event['threat_categories']=[c for c in event['categories'] if c in SPECIALIST]
        event['cbrn_subgroups']=['RADNUC'] if 'Radiological/Nuclear' in event['categories'] else []
    if type(rule.get('ai_current_ct_event')) is bool:
        event['ai_current_ct_event'] = rule['ai_current_ct_event']
    if rule.get('clear_geography'):
        # No invented replacement point. Preserve known country and source text.
        event.update(city=None,region=None,latitude=None,longitude=None,
                     location_precision='unlocated',location_confidence='low',
                     location_confidence_score=0.0,location_method='reviewed_unsupported_point_withdrawn',
                     geolocation_review_required=True,ai_geo_complete=True,excluded_from_map=False)
        if rule.get('country_override'): event.update(rule['country_override'])
        event['location_review_reason']=rule['reason']
    if rule.get('isolated_incident'):
        event['incident_id']=rule['isolated_incident']
    event['integrity_review_version']=VERSION
    event['integrity_review_reason']=rule['reason']
    event['integrity_source_evidence']=evidence_key(event)
    if rule.get('detach_urls') or rule.get('promote_article_url'):
        rebuild_sources(event)
    return event != before


def filter_reviewed(events):
    """Preserve manual quarantine and duplicate decisions against cached replay."""
    result=[]
    for event in events:
        rule=matched_rule(event)
        if rule and rule.get('action')=='quarantine': continue
        apply_rule(event)
        withdraw_unresolved_city_fallback(event)
        result.append(event)
    by_id={str(e.get('id')):e for e in result}
    removed=set()
    for decision in decisions()['merges']:
        old=by_id.get(decision['retired_id']); canonical=by_id.get(decision['canonical_id'])
        if not old or not canonical: continue
        if (evidence_key(old)!=decision['expected_retired_evidence'] or
            evidence_key(canonical)!=decision['expected_canonical_evidence']): continue
        # Do not erase a newly extended old record blindly. Preserve every article.
        combined=canonical.setdefault('related_articles',[])
        combined.append(independent_article(old))
        combined.extend(copy.deepcopy(old.get('related_articles',[])))
        rebuild_sources(canonical)
        canonical['integrity_review_version']=VERSION
        canonical['integrity_review_reason']=decision['reason']
        canonical['duplicate_record_ids']=sorted(set(canonical.get('duplicate_record_ids',[])+[old['id']]))
        dates=[d for d in (canonical.get('first_reported'),old.get('first_reported'),canonical.get('published'),old.get('published')) if d]
        if dates: canonical['first_reported']=min(dates)
        dates=[d for d in (canonical.get('last_reported'),old.get('last_reported'),canonical.get('published'),old.get('published')) if d]
        if dates: canonical['last_reported']=max(dates)
        removed.add(old['id'])
    return collapse_original_article_duplicates([e for e in result if e.get('id') not in removed])


def audit(events):
    from collections import Counter,defaultdict
    ids=Counter(str(e.get('id')) for e in events)
    groups=defaultdict(list)
    for e in events:
        if e.get('incident_id'): groups[(e['incident_id'],e.get('update_type'))].append(e)
    unresolved=[]
    for (incident,stage),group in groups.items():
        for n,left in enumerate(group):
            for right in group[n+1:]:
                if not primary_pair_supported(left,right):
                    unresolved.append({'ids':[left['id'],right['id']],'incident_id':incident,'stage':stage,'reason':'No comparable primary-headline anchor; do not auto-merge'})
    article_groups=defaultdict(list)
    for e in events:
        key=original_article_key(e)
        if key: article_groups[key].append(e['id'])
    return {'records':len(events),'duplicate_ids':[i for i,n in ids.items() if n>1],
            'duplicate_original_article_groups':[group for group in article_groups.values() if len(group)>1],
            'category_field_mismatches':[e['id'] for e in events if set(e.get('threat_categories',[]))!=set(e.get('categories',[]))&SPECIALIST],
            'geolocation_review_ids':[e['id'] for e in events if e.get('geolocation_review_required')],
            'country_level_markers':sum(e.get('location_precision')=='country_capital' for e in events),
            'unlocated':sum(e.get('latitude') is None or e.get('longitude') is None for e in events),
            'ambiguous_incident_pairs':unresolved,
            'scope':'Structural scan and reviewed source-excerpt corrections; not independent verification of every incident or location.'}


def repair_document(data, resolve_city=None):
    original=copy.deepcopy(data); old={e['id']:copy.deepcopy(e) for e in data['events']}
    if resolve_city is not None:
        for event in data['events']:
            repair_unresolved_city(event, resolve_city) or restore_requested_city_label(event)
    data['events']=filter_reviewed(data['events']); new={e['id']:e for e in data['events']}
    if len(new)!=len(data['events']) or not set(new)<=set(old):
        raise ValueError('Repair introduced or duplicated record identifiers')
    changes=[];removed=[]
    for identifier,previous in old.items():
        if identifier not in new:
            rule=decisions()['rules'].get(identifier,{})
            merge=next((m for m in decisions()['merges'] if m['retired_id']==identifier),None)
            if not merge:
                canonical=next((e for e in new.values() if identifier in e.get('duplicate_record_ids',[])),None)
                if canonical:
                    merge={'canonical_id':canonical['id'],'reason':'Same original primary headline, publisher and exact publication timestamp; different RSS URL or generated translation.'}
            removed.append({'id':identifier,'disposition':'verified_duplicate' if merge else 'quarantined_outside_active_map',
                            'reason':merge['reason'] if merge else rule.get('reason'),
                            'canonical_id':merge['canonical_id'] if merge else None,'record':previous})
        elif previous!=new[identifier]:
            fields={k:{'before':previous.get(k),'after':new[identifier].get(k)} for k in set(previous)|set(new[identifier]) if previous.get(k)!=new[identifier].get(k)}
            changes.append({'id':identifier,'fields':fields,'before_record':previous})
    data['number_of_events']=len(data['events'])
    report={'version':1,'review_version':VERSION,'before':audit(original['events']),'after':audit(data['events']),
            'added_record_ids':[],'removed':removed,'changes':changes}
    # Honest geolocation totals without re-labelling this maintenance as an AI run.
    geo=data.get('geolocation')
    if isinstance(geo,dict):
        from collections import Counter
        c=Counter(e.get('location_precision')for e in data['events'])
        for key in ('city','region','country_capital','unlocated'): geo[key]=c[key]
        geo['mapped_total']=sum(e.get('latitude') is not None and e.get('longitude') is not None for e in data['events'])
        geo['methods']=dict(Counter(e.get('location_method','unknown')for e in data['events']))
        for level in ('high','medium','low'): geo[level+'_confidence']=sum(e.get('location_confidence')==level for e in data['events'])
    status_geo=(data.get('collection_status') or {}).get('geolocation')
    if isinstance(status_geo,dict):
        status_geo['located']=sum(e.get('latitude') is not None and e.get('longitude') is not None for e in data['events'])
        status_geo['unlocated']=report['after']['unlocated']
        status_geo['completed_unlocated']=sum(e.get('ai_geo_complete') is True and (e.get('latitude') is None or e.get('longitude') is None) for e in data['events'])
        status_geo['review_required']=len(report['after']['geolocation_review_ids'])
    if changes or removed:
        data['map_integrity_audit']={'version':VERSION,'new_events':0,'quarantined_records':sum(x['disposition']=='quarantined_outside_active_map'for x in removed),
                                    'folded_duplicate_records':sum(x['disposition']=='verified_duplicate'for x in removed),
                                    'review_required':len(report['after']['geolocation_review_ids']),
                                    'scope':report['after']['scope']}
    return data,report
