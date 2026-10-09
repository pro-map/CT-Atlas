"""Standalone threat topics. Retrieval terms never establish terrorist intent.

Legacy CBRN/RADNUC records are read, not discarded. Only category fields change;
incident identity, source evidence, dates, reported status and coordinates stay.
"""
from __future__ import annotations
import json
import re
from functools import lru_cache
from pathlib import Path

RN = 'Radiological/Nuclear'
CE = 'Chemicals and Explosives'
BIO = 'Biological Terrorism'
LABELS = (RN, CE, BIO)
VERSION = 'threat-topics-v1-20261008'
LEGACY = {'CBRN', 'CBRNE'}
ALIASES = {'RADNUC': RN, 'Radiological / Nuclear': RN, 'Chemical / Explosives': CE}

@lru_cache(maxsize=1)
def vocabulary():
    data = json.loads(Path(__file__).with_name('threat-category-keywords.json').read_text(encoding='utf-8'))
    if data['category_labels'] != list(LABELS):
        raise ValueError('Threat-category vocabulary labels disagree with the taxonomy')
    return data

def canonical(value):
    value = str(value or '').strip()
    return ALIASES.get(value, value)

def text(event):
    return ' '.join(str(event.get(k) or '') for k in ('title','summary','ai_canonical_event'))

# Conservative compatibility rules for already-retained records, not an intake
# filter. New semantic AI decisions are authoritative; incidental words do not
# add a specialist category after that decision.
_BIO = re.compile(r'\b(?:bio[- ]?terror\w*|agro[- ]?terror\w*|anthrax|ricin|botulinum|biological (?:weapon\w*|attack\w*|threat\w*|plot\w*)|bacteriological (?:attack\w*|weapon\w*))\b', re.I)
_CHEM = re.compile(r'\b(?:chemical (?:weapon\w*|attack\w*|terror\w*|plot\w*)|sarin|mustard gas|nerve agent\w*|chlorine (?:attack\w*|bomb\w*)|toxic chemical attack|poison attack)\b', re.I)
_EXPLOSIVE = re.compile(r'\b(?:explosives?|improvised explosive devices?|IEDs?|pipe bombs?|car bombs?|suicide bomb\w*|bomb[- ]making|bomb[- ]?makers?)\b', re.I)

def annotate(event, result=None):
    import radnuc
    if not isinstance(event, dict):
        raise TypeError('An event must be an object')
    if result and result.get('actor_scope'):
        event['actor_scope'] = result['actor_scope']
    raw = event.get('categories') or ([event.get('category')] if event.get('category') else [])
    if not isinstance(raw, list): raw = [raw]
    raw = list(dict.fromkeys(canonical(c) for c in raw if c))
    explicit = result.get('categories') if isinstance(result, dict) else None
    legacy = any(c in LEGACY for c in raw) or bool(explicit and any(c in LEGACY for c in explicit))
    labels = [c for c in raw if c not in LEGACY]
    # Compatibility with pre-migration Gemini responses and saved checkpoints.
    subgroup = result.get('cbrn_subgroups') if isinstance(result, dict) and 'cbrn_subgroups' in result else event.get('cbrn_subgroups')
    legacy_decision = explicit is None or any(c in LEGACY for c in (explicit or [])) or bool(subgroup)
    if legacy_decision and 'RADNUC' in (subgroup or []):
        labels.append(RN)
    elif legacy and subgroup is None and radnuc.has_material(event):
        labels.append(RN)
    if legacy and (explicit is None or any(c in LEGACY for c in explicit)):
        body = text(event)
        if _BIO.search(body): labels.append(BIO)
        if _CHEM.search(body) or _EXPLOSIVE.search(body): labels.append(CE)
    elif result is None and event.get('threat_taxonomy_version') != VERSION and event.get('ai_selected') is True:
        # Previously accepted weapons/attack reporting can concern explosives,
        # but generic weapons, guns and an ordinary "attack" never suffice.
        if any(c in ('Weapons','Attacks','Counter Terrorism Action') for c in labels) and _EXPLOSIVE.search(text(event)):
            labels.append(CE)
    labels = list(dict.fromkeys(labels))
    # Do not turn interstate war into a specialist terrorism case.
    if event.get('actor_scope') == 'STATE_ONLY':
        labels = [c for c in labels if c not in LABELS]
    relevant = legacy or any(c in LABELS for c in raw+labels) or bool(subgroup)
    if relevant:
        event['categories'] = labels
        event['category'] = labels[0] if labels else ''
        event['threat_taxonomy_version'] = VERSION
        event['threat_categories'] = [c for c in labels if c in LABELS]
        if legacy:
            event.setdefault('legacy_category', 'CBRN')
            if not event['threat_categories']:
                event['category_review_required'] = True
        if event['threat_categories']:
            event.pop('category_review_required', None)
        # Backward-readable metadata only, never a user-visible hierarchy.
        event['cbrn_subgroups'] = ['RADNUC'] if RN in labels else []
    elif isinstance(result, dict) and 'cbrn_subgroups' in result:
        event['cbrn_subgroups'] = []
    if result is not None:
        event['threat_taxonomy_version'] = VERSION
    if result and result.get('reported_status') in {'CONFIRMED','SUSPECTED','ALLEGED','THREAT','HOAX','UNKNOWN'}:
        event['reported_status'] = result['reported_status']
    return event

def scope_reason(event, result=None):
    import radnuc
    cats = set(event.get('categories') or [])
    wanted = {canonical(c) for c in (result or {}).get('categories', [])}
    if (cats | wanted) & set(LABELS) or wanted & LEGACY or event.get('legacy_category') in LEGACY:
        if (result or {}).get('actor_scope',event.get('actor_scope')) == 'STATE_ONLY':
            return 'Specialist terrorism topics exclude operations by states or regular armed forces'
        if RN in cats or 'RADNUC' in (result or {}).get('cbrn_subgroups',[]):
            return radnuc.state_operation_reason(event, (result or {}).get('actor_scope'))
    return ''

def queries(category, code='en'):
    """Material phrases AND context anchors; no isolated generic search terms."""
    if category == RN:
        import radnuc
        import radnuc_vocabulary
        existing = radnuc.queries(code) if code in radnuc.LEXICONS else []
        return list(dict.fromkeys(existing + radnuc_vocabulary.queries(code)))
    key = {BIO:'biological',CE:'chemical_explosives'}[category]
    item = vocabulary()[key]
    terms = item['terms'].get(code, [])
    anchors = item['context'].get(code, [])
    if not terms or not anchors: return []
    quote = lambda s: '"' + s.replace('"','') + '"'
    context = ' OR '.join(quote(t) for t in anchors)
    # Bound individual query length to provider limits. All terms participate.
    return ['(' + ' OR '.join(quote(t) for t in terms[i:i+6]) + ') (' + context + ')'
            for i in range(0,len(terms),6)]

def install_collection(namespace):
    """One vocabulary powers ordinary daily collection and specialist backfill."""
    for name in ('CATEGORIES','CORE_SEARCH_QUERIES','OFFICIAL_SOURCE_QUERIES','TARGETED_MEDIA_CATEGORY_TERMS'):
        mapping = namespace[name]
        mapping.pop('CBRN',None)
        for label in LABELS:
            q = queries(label)
            mapping[label] = q[0] if name == 'TARGETED_MEDIA_CATEGORY_TERMS' else list(q)
    for profile in namespace['MULTILINGUAL_PROFILES']:
        for label in LABELS:
            for query in queries(label,profile['code']):
                item = {'term':query,'category':label}
                if item not in profile['queries']: profile['queries'].append(item)
    for label, terms in ((RN,['radiological','radioactive','nuclear','uranium','dirty bomb']),
                         (CE,['chemical weapon','sarin','nerve agent','explosives','explosive device','ied']),
                         (BIO,['bioterrorism','biological weapon','anthrax','ricin','botulinum','agroterrorism'])):
        namespace['CATEGORY_RELEVANCE'][label] = set(terms)
        namespace['ACTION_TERMS'][label] = {'attack','plot','threat','hoax','arrested','seized','charged','convicted','investigation'}

SELECTION_NOTE = '''
STANDALONE SPECIALIST CATEGORIES (no CBRN/CBRNE parent and no subcategories):
Return Radiological/Nuclear, Chemicals and Explosives, Biological Terrorism in
categories when the relevant facts are CENTRAL to the concrete reported incident.
The existing action categories (Attacks, Arrests, Legal / Judicial etc.) may also
apply to the SAME incident; do not duplicate the incident across topic filters.
Radiological/Nuclear retains the existing non-state scope and material rules.
Chemicals and Explosives concerns chemical weapons/toxic agents deliberately
used or planned for harm and terrorist explosive devices, seizures and plots.
Firearms alone, generic weapons, drones alone and general terrorism do NOT qualify.
Biological Terrorism covers deliberate biological/toxin attacks, attempted plots,
reported threats and hoaxes, terrorism-linked possession/theft/trafficking,
investigations and judicial developments, including biological agroterrorism.
Agent/disease names alone do NOT qualify. Require related incident context and a
reported terrorism nexus. Exclude natural outbreaks, accidental contamination,
lab accidents, medicine, research, exercises, policy and ordinary crime.
Suspicious powders and food/water contamination are NOT automatically biological:
require reported biological involvement or an explicitly biological threat.
Preserve suspected/alleged/hoax status in the English summary. Never infer a
confirmed agent from a powder alert. reported_status describes the source's
reported status: CONFIRMED, SUSPECTED, ALLEGED, THREAT, HOAX or UNKNOWN.
Toxins can overlap chemical/biological scope; retain one record with both labels
only when the reporting supports both, never infer dual attribution automatically.
Do not infer any of these three categories from isolated incidental keywords.
Set cbrn_subgroups=["RADNUC"] for Radiological/Nuclear only, otherwise []: this
is legacy machine compatibility, NOT a CBRN parent or a user-facing subgroup.
'''

# Both the daily collector and the historical reviewer use this same editorial
# prompt. Configuration rules must reach it, not merely sit in a JSON comment.
SELECTION_NOTE += '\nCHEMICAL/EXPLOSIVES INCIDENT-REPORTING RULES:\n' + '\n'.join(
    vocabulary()['chemical_explosives'].get('rules', [])
) + '\n'
