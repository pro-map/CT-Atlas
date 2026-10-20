"""Deterministic daily safety helpers. No provider calls, secrets, or quota changes."""
from __future__ import annotations
import copy
import hashlib
import json
import math
import random
import re
import unicodedata
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

LABELS = ('Radiological/Nuclear', 'Chemicals and Explosives', 'Biological Terrorism')
SLOTS = ('17 10 * * *', '17 18 * * *')
PACIFIC = ZoneInfo('America/Los_Angeles')
PARIS = ZoneInfo('Europe/Paris')


def normal_name(value):
    # Keep non-Latin letters; transliterations come from GeoNames aliases.
    value = unicodedata.normalize('NFKD', str(value or '')).casefold()
    return ' '.join(''.join(ch if ch.isalnum() else ' ' for ch in value
                           if not unicodedata.combining(ch)).split())


def canonical_city(candidates, name, country):
    """Never resolve into another country or choose a namesake by population."""
    wanted = normal_name(name)
    if not wanted or not country:
        return None
    pool = {str(c.get('geonameid') or (c.get('name'), c.get('latitude'), c.get('longitude'))): c
            for c in candidates if str(c.get('countrycode', '')).upper() == country.upper()}
    exact = [c for c in pool.values() if normal_name(c.get('name')) == wanted
             or normal_name(c.get('asciiname')) == wanted]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        return None
    aliases = []
    for c in pool.values():
        names = c.get('alternatenames') or []
        if isinstance(names, str):
            names = names.split(',')
        if wanted in {normal_name(n) for n in names}:
            aliases.append(c)
    return aliases[0] if len(aliases) == 1 else None


def city_resolution_guard(event, result, city_index, normalize):
    """Return an inert copy; uncertain city matching falls back only to a known country.

    A country marker is not an exact arrest site. This validates resolution, not
    the independent truth of the source or the semantic correctness of Gemini.
    """
    result = copy.deepcopy(result)
    if result.get('precision') != 'city':
        return result
    name = str(result.get('city') or '')
    country = str(result.get('country_code') or '').upper()
    # The model normally supplies country_code; its absence must not cause us
    # to invent a code from the publisher. The caller can resolve a real name.
    pool = city_index.get(normalize(name), [])
    chosen = canonical_city(pool, name, country)
    if chosen is not None:
        return result
    # Even when no city is indexed, unchecked AI coordinates are not a verified
    # urban location. Preserve the claimed name and evidence in the audit fields.
    result['_city_validation_issue'] = 'ambiguous_or_unresolved_city'
    result['_requested_city'] = name
    result['precision'] = 'country' if country else 'unknown'
    result['city'] = ''
    result['latitude'] = result['longitude'] = None
    result['confidence'] = min(float(result.get('confidence') or 0), 0.5)
    return result


def metadata_repair(event):
    """Reconcile derived fields only when a modern validated category list exists."""
    cats = event.get('categories')
    if not isinstance(cats, list) or not all(isinstance(c, str) for c in cats):
        return None
    if not (event.get('ai_selection_complete') is True or event.get('ai_selected') is True):
        return None
    if not event.get('threat_taxonomy_version') or any(c in {'CBRN', 'CBRNE', 'RADNUC'} for c in cats):
        return None
    expected = list(dict.fromkeys(c for c in cats if c in LABELS))
    fields = {'threat_categories': expected,
              'cbrn_subgroups': ['RADNUC'] if LABELS[0] in expected else []}
    if not expected and not any(k in event for k in fields):
        return None
    changes = {k: {'before': copy.deepcopy(event.get(k)), 'after': v}
               for k, v in fields.items() if event.get(k) != v}
    for key, value in fields.items():
        event[key] = value
    return changes or None


def recovery_caps(usage, day, primary_run, primary_day, overflow_run, overflow_day):
    """Reserve every not-yet-completed ordinary daily slot; malformed usage closes recovery."""
    if not isinstance(usage, dict) or usage.get('pacific_day') != day:
        return (0, 0)
    values = [usage.get('calls'), usage.get('overflow_calls')]
    if any(type(v) is not int or v < 0 for v in values):
        return (0, 0)
    slots = usage.get('completed_daily_slots', [])
    if not isinstance(slots, list) or any(s not in SLOTS for s in slots):
        return (0, 0)
    reserved_slots = len(SLOTS) - len(set(slots))
    return (min(primary_run, max(0, primary_day-values[0]-reserved_slots*primary_run)),
            min(overflow_run, max(0, overflow_day-values[1]-reserved_slots*overflow_run)))


def retry_delay(attempt, response=None, jitter=None):
    """Bounded exponential wait; a long Retry-After is deferred, never shortened."""
    delay = min(60.0, 4.0 * 2 ** min(max(0, attempt), 4))
    headers = getattr(response, 'headers', {})
    if isinstance(headers, Mapping):
        try:
            requested = float(headers.get('Retry-After', 0))
            if requested > 120:
                return None
            if requested >= 0:
                delay = max(delay, requested)
        except (TypeError, ValueError):
            pass
    return delay + (random.uniform(0, 2) if jitter is None else jitter)


def rows(document, map_file=False):
    if not isinstance(document, dict):
        raise ValueError('Expected a dataset object')
    result = document.get('events')
    if not isinstance(result, list):
        raise ValueError('Expected events list')
    result = result + document.get('recent_events', []) if map_file else result
    by_id = {}
    for row in result:
        if not isinstance(row, dict) or not isinstance(row.get('id'), str) or not row['id']:
            raise ValueError('Missing stable event identifier')
        if row['id'] in by_id:
            raise ValueError('Duplicate event identifier: ' + row['id'])
        by_id[row['id']] = row
    return by_id


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def publication_delta(before, after):
    old, new = rows(before), rows(after)
    common = old.keys() & new.keys()
    fields = ('title', 'summary', 'categories', 'threat_categories', 'url', 'articles',
              'related_articles', 'source_article_fingerprints', 'source_count')
    changed = sorted(i for i in common if any(old[i].get(k) != new[i].get(k) for k in fields))
    removed = sorted(old.keys()-new.keys())
    return {'before_count': len(old), 'after_count': len(new),
            'added_record_ids': sorted(new.keys()-old.keys()), 'changed_record_ids': changed,
            'removed_record_ids': removed, 'removed_reason': 'requires_expiry_or_merge_evidence' if removed else None,
            'independent_incidents_verified': False, 'publication_confirmed': False,
            'dataset_sha256': digest(after)}


def timing(schedule, created_at, started_at):
    result = {'schedule_expression': schedule or None, 'run_created_at': created_at,
              'processing_started_at': started_at, 'scheduled_at_estimate': None,
              'schedule_attribution': 'unknown'}
    if schedule not in SLOTS or not created_at:
        return result
    created = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
    local = created.astimezone(PARIS)
    hour = int(schedule.split()[1])
    expected = local.replace(hour=hour, minute=17, second=0, microsecond=0)
    if expected > local:
        expected -= timedelta(days=1)
    result.update(scheduled_at_estimate=expected.isoformat(),
                  schedule_attribution='latest_possible_slot_not_proof_of_scheduler_cause',
                  creation_delay_seconds=(local-expected).total_seconds())
    return result


def repair_known_city(event, resolve):
    """One explicitly audited contradictory record, never a global geolocation refresh."""
    if event.get('id') != '82b5e133d2a54751' or event.get('country_code') != 'AT':
        return None
    text = ' '.join(str(event.get(k) or '') for k in ('original_title','title','summary'))
    if not re.search(r'\bgarsten\b', normal_name(text)) or normal_name(event.get('city')) != 'windischgarsten':
        return None
    candidate = resolve('Garsten','AT')
    values = {'geolocation_review_required': True, 'location_confidence': 'low',
              'location_confidence_score': 0.0, 'city': None, 'latitude': None, 'longitude': None,
              'location_precision': 'unlocated', 'location_method': 'quarantined_conflicting_place'}
    if candidate and normal_name(candidate.get('name'))=='garsten' and candidate.get('countrycode')=='AT':
        values.update(city=candidate['name'], latitude=float(candidate['latitude']),longitude=float(candidate['longitude']),
                      location_precision='city',location_method='source_name_geonames_correction',
                      location_confidence='medium',location_confidence_score=0.75,
                      geolocation_review_required=False)
    changes = {k:{'before':copy.deepcopy(event.get(k)),'after':v} for k,v in values.items() if event.get(k)!=v}
    event.update(values)
    return changes or None
