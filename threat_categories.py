"""Standalone threat topics. Retrieval terms never establish terrorist intent.

Legacy CBRN/RADNUC records are read, not discarded. Only category fields change;
incident identity, source evidence, dates, reported status and coordinates stay.
"""
from __future__ import annotations
import json
import re
import unicodedata
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


@lru_cache(maxsize=1)
def bio_monitoring_vocabulary():
    """Provisional daily-only incident queries supplied by the Bio colleague."""
    return json.loads(Path(__file__).with_name('bio-monitoring-keywords.json').read_text(encoding='utf-8'))


def _monitoring_text(value):
    value = unicodedata.normalize('NFKC', str(value or '')).casefold()
    return re.sub(r'\s+', ' ', re.sub(r'[‐‑‒–—-]', ' ', value)).strip()


def _monitoring_pattern(term):
    term = _monitoring_text(term)
    # Chinese text does not separate words with spaces. Other scripts still
    # need whole terms: "meth" must not match "method" or "methane".
    if re.search(r'[\u3400-\u9fff]', term):
        return re.escape(term)
    return r'(?<!\w)' + re.escape(term) + r'(?!\w)'


@lru_cache(maxsize=1)
def _bio_monitoring_patterns():
    item = bio_monitoring_vocabulary()
    exclusions = item['noise_exclusions'] + [term for language in item['languages'].values()
                                           for term in language.get('noise_exclusions', [])]
    noise = re.compile('|'.join(_monitoring_pattern(term) for term in exclusions))
    languages = []
    for code, language in item['languages'].items():
        patterns = {key: re.compile('|'.join(_monitoring_pattern(term) for term in language[key]))
                    for key in ('powder', 'response', 'mail', 'mail_context', 'targeted', 'target')}
        # Ordinary inflections preserve the colleague's English response words.
        if code == 'en':
            patterns['response'] = re.compile(patterns['response'].pattern + r'|\b(?:evacuat\w*|cordon\w*|decontaminat\w*|quarantin\w*)\b')
        elif code == 'fr':
            patterns['response'] = re.compile(patterns['response'].pattern + r'|\b(?:évacu\w*|decontamin\w*|décontamin\w*)\b')
        languages.append(patterns)
    return noise, languages


def bio_monitoring_match(title, summary=''):
    """Cheap candidate gate; the AI must still establish a current incident.

    No agent confirmation or terrorism attribution is required for this narrow
    daily monitoring scope. The three pairs preserve the supplied Boolean ANDs.
    """
    body = _monitoring_text(str(title or '') + ' ' + str(summary or ''))
    noise, languages = _bio_monitoring_patterns()
    if noise.search(body):
        return False
    for groups in languages:
        if ((groups['powder'].search(body) and groups['response'].search(body))
                or (groups['mail'].search(body) and groups['mail_context'].search(body))
                or (groups['targeted'].search(body) and groups['target'].search(body))):
            return True
    return False


def bio_noise_match(title, summary=''):
    noise, _ = _bio_monitoring_patterns()
    return bool(noise.search(_monitoring_text(str(title or '') + ' ' + str(summary or ''))))


def bio_monitoring_queries(code='en'):
    """Split equivalent OR groups to fit provider limits, retaining every AND."""
    item = bio_monitoring_vocabulary()
    language = item['languages'].get(code)
    if not language:
        return []
    exclusions = list(dict.fromkeys(item['noise_exclusions'] + language.get('noise_exclusions', [])))
    noise = ' '.join('-"' + term.replace('"', '') + '"' for term in exclusions)
    result = []

    def bounded(left, right):
        query = query_group(left) + ' ' + query_group(right) + ' ' + noise
        if len(query) <= 680:
            result.append(query)
            return
        # Splitting an OR side into separate queries leaves the union identical.
        target = left if len(query_group(left)) >= len(query_group(right)) else right
        if len(target) < 2:
            raise ValueError(f'Bio monitoring query exceeds provider limit: {code}')
        midpoint = len(target) // 2
        if target is left:
            bounded(left[:midpoint], right)
            bounded(left[midpoint:], right)
        else:
            bounded(left, right[:midpoint])
            bounded(left, right[midpoint:])

    for left, right in (('powder', 'response'), ('mail', 'mail_context'), ('targeted', 'target')):
        bounded(language[left], language[right])
    return list(dict.fromkeys(result))

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
    explicit = result.get('categories') if isinstance(result, dict) else None
    raw = explicit if explicit is not None else event.get('categories') or ([event.get('category')] if event.get('category') else [])
    if not isinstance(raw, list): raw = [raw]
    raw = list(dict.fromkeys(canonical(c) for c in raw if c))
    explicit = result.get('categories') if isinstance(result, dict) else None
    legacy = any(c in LEGACY for c in raw) or bool(explicit and any(c in LEGACY for c in explicit))
    labels = [c for c in raw if c not in LEGACY]
    # Compatibility with pre-migration Gemini responses and saved checkpoints.
    subgroup = result.get('cbrn_subgroups') if isinstance(result, dict) and 'cbrn_subgroups' in result else event.get('cbrn_subgroups')
    # Accept a compatibility subgroup only from this decision, never from
    # stale event metadata once an explicit modern decision was returned.
    current_radnuc = isinstance(result, dict) and 'RADNUC' in (result.get('cbrn_subgroups') or [])
    legacy_decision = explicit is None or any(c in LEGACY for c in (explicit or [])) or current_radnuc
    if not legacy_decision:
        subgroup = ['RADNUC'] if RN in raw else []
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
        # Derived fields must also be cleared after a validated non-specialist decision.
        event['categories'] = labels
        event['category'] = labels[0] if labels else ''
        event['threat_categories'] = [c for c in labels if c in LABELS]
        event['cbrn_subgroups'] = ['RADNUC'] if RN in labels else []
        event['threat_taxonomy_version'] = VERSION
    if result and result.get('reported_status') in {'CONFIRMED','SUSPECTED','ALLEGED','THREAT','HOAX','UNKNOWN'}:
        event['reported_status'] = result['reported_status']
    return event

def scope_reason(event, result=None):
    import radnuc
    cats = set(event.get('categories') or [])
    wanted = {canonical(c) for c in (result or {}).get('categories', [])}
    if BIO in cats | wanted and bio_noise_match(event.get('title'), event.get('summary')):
        return 'Bio monitoring noise exclusion from the supplied keyword filter'
    if (cats | wanted) & set(LABELS) or wanted & LEGACY or event.get('legacy_category') in LEGACY:
        if (result or {}).get('actor_scope',event.get('actor_scope')) == 'STATE_ONLY':
            return 'Specialist terrorism topics exclude operations by states or regular armed forces'
        if RN in cats or 'RADNUC' in (result or {}).get('cbrn_subgroups',[]):
            return radnuc.state_operation_reason(event, (result or {}).get('actor_scope'))
    return ''

def queries(category, code='en'):
    """Curated query groups; collection_queries also includes shared native seeds."""
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

def query_group(terms):
    if not terms or any(not isinstance(t, str) or not t.strip()
                        or any(ch in t for ch in ('"', '\n', '\r')) for t in terms):
        raise ValueError('Invalid native discovery term')
    if len(set(terms)) != len(terms):
        raise ValueError('Repeated native discovery term')
    return '(' + ' OR '.join('"' + term + '"' for term in terms) + ')'


def seed_queries(category, code):
    """Shared native seeds; the old historical query strings remain identical."""
    key = {CE: 'chemical_explosives', BIO: 'biological'}.get(category)
    if key is None:
        return []
    item = vocabulary()[key]
    groups = item.get('native_query_groups', {}).get(code, [])
    context = item.get('native_query_context', {}).get(code, [])
    if not groups and not context:
        return []
    if not groups or not context:
        raise ValueError(f'Incomplete specialist seed vocabulary: {category}/{code}')
    return [query_group(group) + ' ' + query_group(context) for group in groups]


def collection_queries(category, code='en'):
    """Authoritative complete query API shared by daily and historical intake."""
    return queries(category, code) or seed_queries(category, code)


def daily_queries(category, code='en'):
    """Daily provisional monitoring never expands the frozen historical plan."""
    base = collection_queries(category, code)
    return list(dict.fromkeys(base + (bio_monitoring_queries(code) if category == BIO else [])))


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
            # Retain the legacy general-archive replay surface; the Chinese
            # supplement already has its own historical checkpoint cohort.
            if label == RN and profile['code'] in ('zh', 'zh-Hant'):
                import radnuc
                replay_queries = radnuc.queries(profile['code'])
            else:
                replay_queries = queries(label, profile['code'])
            for query in replay_queries:
                item = {'term':query,'category':label}
                if item not in profile['queries']: profile['queries'].append(item)
    # Freeze the PRE-ALIGNMENT daily replay surface for the older general
    # archive planner. Expanding daily intake must not recreate historical work.
    import copy
    import collection_config
    namespace.setdefault('HISTORICAL_REPLAY_PROFILES', copy.deepcopy(namespace['MULTILINGUAL_PROFILES']))
    collection_config.extend_specialist_profiles(namespace['MULTILINGUAL_PROFILES'])
    for profile in namespace['MULTILINGUAL_PROFILES']:
        for label in LABELS:
            for query in daily_queries(label, profile['code']):
                item = {'term': query, 'category': label}
                if item not in profile['queries']:
                    profile['queries'].append(item)
    for name in ('CATEGORIES', 'CORE_SEARCH_QUERIES', 'OFFICIAL_SOURCE_QUERIES', 'TARGETED_MEDIA_CATEGORY_TERMS'):
        namespace[name][BIO] = daily_queries(BIO)[0] if name == 'TARGETED_MEDIA_CATEGORY_TERMS' else daily_queries(BIO)
    for label, terms in ((RN,['radiological','radioactive','nuclear','uranium','dirty bomb']),
                         (CE,['chemical weapon','sarin','nerve agent','explosives','explosive device','ied']),
                         (BIO,['bioterrorism','biological weapon','anthrax','ricin','botulinum','agroterrorism'])):
        namespace['CATEGORY_RELEVANCE'][label] = set(terms)
        namespace['ACTION_TERMS'][label] = {'attack','plot','threat','hoax','arrested','seized','investigation'}

SELECTION_NOTE = '''
STANDALONE SPECIALIST CATEGORIES (no CBRN/CBRNE parent and no subcategories):
Return Radiological/Nuclear, Chemicals and Explosives, Biological Terrorism in
categories when the relevant facts are CENTRAL to the concrete reported incident.
The existing action categories (Attacks, Arrests etc.) may also
apply to the SAME incident; do not duplicate the incident across topic filters.
Radiological/Nuclear retains the existing non-state scope and material rules.
Chemicals and Explosives concerns chemical weapons/toxic agents deliberately
used or planned for harm and terrorist explosive devices, seizures and plots.
Firearms alone, generic weapons, drones alone and general terrorism do NOT qualify.
Biological Terrorism covers deliberate biological/toxin attacks, attempted plots,
reported threats and hoaxes, terrorism-linked possession/theft/trafficking,
investigations, including biological agroterrorism. Its provisional DAILY
monitoring scope ALSO includes current suspicious-mail and unidentified-powder
incidents as detailed below, pending advice from the specialised unit.
Standalone judicial developments are excluded from every specialist category.
Agent/disease names alone do NOT qualify. Require related incident context and a
reported terrorism nexus EXCEPT for the provisional suspicious-mail/powder
monitoring scope below. Exclude natural outbreaks, accidental contamination,
lab accidents, medicine, research, exercises, policy and unrelated ordinary crime.
Food/water contamination still requires reported biological involvement or an
explicitly biological threat; suspicious-mail/powder monitoring does not.
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

SELECTION_NOTE += '\nPROVISIONAL BIO DAILY MONITORING RULES (pending specialised advice):\n' + '\n'.join(
    vocabulary()['biological'].get('rules', [])
) + '\n'
