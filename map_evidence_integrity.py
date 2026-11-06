"""Conservative evidence safeguards and reviewed corrections. No provider calls.

Similar titles, reused incident IDs and shared secondary sources are not proof
of one real-world incident. Uncertain cases remain separate and reviewable.
"""
from __future__ import annotations
import copy
import hashlib
import html
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


# Spellings stored with a lost byte (audit of 2026-11-05).
TEXT_REPAIRS = (('Bogot3', 'Bogotá'), ('Choc3', 'Chocó'), ('Alcald3a', 'Alcaldía'),
                ('Baden-W¼rttemberg', 'Baden-Württemberg'), ('Nari\x11o', 'Nariño'), ('S\x92gou', 'Ségou'))
CONTROL_CHARACTERS = re.compile('[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]')


def repair_text(value):
    """Decode entities, restore TEXT_REPAIRS and drop control characters."""
    text = html.unescape(str(value or ''))
    for broken, word in TEXT_REPAIRS:
        text = text.replace(broken, word)
    return CONTROL_CHARACTERS.sub('', text)


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


def event_place_text(event):
    """The record's own words about its place, not its folded articles'."""
    fields = [event.get(key) for key in ('title', 'summary', 'original_title', 'original_summary')]
    return ' '.join(str(value) for value in [*fields, *(event.get('location_evidence') or [])] if value)


def repair_unresolved_city(event, resolve_city):
    """Reapply only an exact country-locked lookup after text normalization fixes,
    then with the state the record's own text names, for a namesake."""
    if event.get('geolocation_validation_issue') != 'ambiguous_or_unresolved_city':
        return False
    requested = repair_text(event.get('geolocation_requested_city'))
    country = event.get('country_code')
    if not requested or not country:
        return False
    reason = 'The previously requested locality now resolves uniquely in its recorded country after Unicode/HTML normalization; no new location was inferred.'
    city = resolve_city(requested, country)
    if not city:
        reason = "The record's text names the state of exactly one same-country namesake of the requested locality; no new location was inferred."
        city = resolve_city(requested, country, None, None, event_place_text(event))
    if not city or city.get('countrycode') != country:
        return False
    event.update(city=requested_city_label(requested) or city['name'], region=None, latitude=float(city['latitude']),
                 longitude=float(city['longitude']), location_precision='city',
                 location_method='source_name_geonames_correction',
                 location_confidence='medium', location_confidence_score=0.75,
                 geolocation_review_required=False,
                 geolocation_resolution_geonameid=city.get('geonameid'),
                 location_review_reason=reason)
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
    if isolated_pair(left, right):
        return False
    if same_primary_identity(left, right):
        return True
    a, b = str(left.get('title')or '').casefold().strip(), str(right.get('title')or '').casefold().strip()
    # Use source-language headlines too; do not substitute generated incident anchors.
    at = words(a+' '+str(left.get('original_title')or ''))
    bt = words(b+' '+str(right.get('original_title')or ''))
    return bool(at & bt)


def isolated_pair(left, right):
    """A reviewed isolated_incident record pairs with no other record."""
    for e, other in ((left,right),(right,left)):
        rule = matched_rule(e)
        if rule and rule.get('isolated_incident') and e.get('id') != other.get('id'):
            return True
    return False


def same_primary_identity(left, right):
    """Same original article, same URL, or one headline extending the other."""
    if same_original_article(left, right):
        return True
    if left.get('url') and left.get('url') == right.get('url'):
        return True
    a, b = str(left.get('title')or '').casefold().strip(), str(right.get('title')or '').casefold().strip()
    return bool(a and b and (a==b or (min(len(a),len(b))>=8 and (a.startswith(b+' ') or b.startswith(a+' ')))))


# Two places named in headlines are different incidents when every point of one
# is further than this from every point of the other: Abu Dhabi and Dubai (120 km)
# or Dadaab and Garissa (90 km) can name one attack, Hama and Jaramana cannot.
PLACE_FAR_KM = 150
# Words that introduce the place of an event, in the languages collected.
PLACE_CUES = frozenset('in at near outside around en dans bei nahe im em no na perto cerca à au aux sur vicino presso dekat di'.split())
PLACE_CONNECTORS = frozenset('de del la el al an am ad as ar ash bin ibn abu of the y do da dos das san santa sidi ben bir ras tel tell'.split())
PLACE_LIST_WORDS = frozenset('and y et und e ve'.split())
# The name before these is a region or an organisation, not the town of that
# name: Saratov Oblast, the Mopti region, the Sinaloa Cartel.
NOT_A_TOWN_AFTER = frozenset('oblast region province state krai county governorate department prefecture republic territory departamento provincia estado cartel cartels gang clan brigade brigades front faction'.split())
HEADLINE_WORD = re.compile(r"[^\W\d_]+(?:['’\-][^\W\d_]+)*")
TURKISH_LOCATIVE = re.compile(r'(?:n?[dt][ae])(?:ki)?')


@lru_cache(maxsize=1)
def _gazetteer():
    """geolocate and every country name. Imported here, on the first comparison
    of two located headlines: a job that never compares any does not read GeoNames."""
    import geolocate
    names = [*geolocate.COUNTRY_BY_NAME, *geolocate.COUNTRY_NAME_ALIASES]
    return geolocate, frozenset(geolocate.normalize_name(name) for name in names)


def _headline_word(word):
    """A word without its apostrophe ending, and whether that ending is the
    Turkish locative: Van'da, Hakkari'deki. L'Aquila keeps the name after it."""
    word = word.replace('’', "'")
    if "'" not in word:
        return word, False
    head, tail = word.split("'", 1)
    if len(head) <= 2:
        return tail, False
    return head, bool(TURKISH_LOCATIVE.fullmatch(tail.casefold()))


def _place_at(words, index, country):
    """(word count, name, points) of the longest place starting at a word."""
    geolocate, country_names = _gazetteer()
    for size in (3, 2, 1):
        chunk = [word for word, _ in words[index:index + size]]
        if len(chunk) < size or not chunk[-1][:1].isupper():
            continue
        if any(not word[:1].isupper() and word.casefold() not in PLACE_CONNECTORS for word in chunk):
            continue
        name = geolocate.normalize_name(' '.join(chunk))
        points = geolocate.named_place_points(name, country) if len(name) >= 4 and name not in country_names else []
        if points:
            return size, name, points
    return None


@lru_cache(maxsize=50000)
def headline_places(title, country):
    """{name: points} of the places of one country a headline says something
    happened in: only names a locative introduces ('in Hattingen', 'Hakkari'deki',
    'Karak: ...') or a list continues ('in Kaduna and Kano'). A bare capitalised
    word is not enough: Calarca is a town and a FARC commander, Orange a town and
    a Hong Kong outlet, and Moscow in a headline is often the government."""
    spans = list(HEADLINE_WORD.finditer(title))
    words = [_headline_word(span.group()) for span in spans]
    found, index, list_end = {}, 0, None
    while index < len(words):
        place = _place_at(words, index, country) if words[index][0][:1].isupper() else None
        if place is None:
            index += 1
            continue
        size, name, points = place
        end = index + size
        following = words[end][0].casefold() if end < len(words) else ''
        listed = list_end is not None and (
            (index == list_end and ',' in title[spans[index - 1].end():spans[index].start()])
            or (index == list_end + 1 and words[list_end][0].casefold() in PLACE_LIST_WORDS))
        cued = (listed or words[end - 1][1] or (index > 0 and words[index - 1][0].casefold() in PLACE_CUES)
                or (index == 0 and title[spans[end - 1].end():].lstrip().startswith(':')))
        # 'in Puerto de la Cruz': the longer name is not the town it starts with.
        longer_name = following in PLACE_CONNECTORS and end + 1 < len(words) and words[end + 1][0][:1].isupper()
        if cued and following not in NOT_A_TOWN_AFTER and not longer_name:
            found[name] = points
            list_end = end
        index = end
    return found


def _far_apart(first, second):
    from daily_reliability import distance_km
    return all(distance_km(*a, *b) > PLACE_FAR_KM for a in first for b in second)


def stored_place_names(event):
    normalize = _gazetteer()[0].normalize_name
    return {normalize(event.get(key)) for key in ('city', 'region', 'geolocation_requested_city') if event.get(key)}


@lru_cache(maxsize=None)
def country_code_for(name):
    return _gazetteer()[0].resolve_country_code({'country': name})


def far_named_place(incoming, existing, country):
    """A veto only: the two headlines name places of one country far apart, and
    the incoming one does not name the record's stored place. An article of the
    same primary identity is never vetoed. The record's own headline decides, not
    the variants folded into it: a wrong variant must not attract more articles."""
    if not country or same_primary_identity(incoming, existing):
        return False
    theirs = headline_places(str(incoming.get('title') or ''), country)
    ours = headline_places(str(existing.get('title') or ''), country) if theirs else {}
    if not ours or set(ours) & set(theirs) or set(theirs) & stored_place_names(existing):
        return False
    return all(_far_apart(a, b) for a in theirs.values() for b in ours.values())


def headline_leaves_location(new, existing):
    """Whether new's headline, promoted onto a geolocated record, would sit on a
    point it does not describe: geolocation answers once per record, so the point
    would stay on the old headline's place ('Debris falls in Jeddah' on Sanaa)."""
    country = existing.get('country_code')
    if existing.get('ai_geo_complete') is not True or existing.get('latitude') is None or not country:
        return False
    if new.get('country_code') and new['country_code'] != country:
        return True
    stored = (float(existing['latitude']), float(existing['longitude']))
    precise = existing.get('location_precision') in ('city', 'region')
    if precise and new.get('location_precision') in ('city', 'region') and new.get('latitude') is not None:
        return _far_apart([stored], [(float(new['latitude']), float(new['longitude']))])
    places = headline_places(str(new.get('title') or ''), country)
    if not places or set(places) & stored_place_names(existing):
        return False
    if precise:
        return all(_far_apart(points, [stored]) for points in places.values())
    return far_named_place(new, existing, country)


# Shared vocabulary is not evidence that two keys are one case. A word is weak
# everywhere when its headlines span WEAK_WORD_MIN_COUNTRIES countries and
# WEAK_WORD_MIN_BUCKETS (country, ISO week) pairs ('atentado', 'Anschlag',
# 'church'), and weak inside one country when it comes back there in
# WEAK_WORD_MIN_WEEKS_IN_COUNTRY weeks ('Borno', 'Balochistan', 'Moscow',
# 'disidencias'). One incident's own name stays distinctive, even reported from
# six countries in its week or two (Flydubai, Starlink), as does a town hit
# once (Karak, Trappes). Measured on the 2026-11-04 dataset.
WEAK_WORD_MIN_COUNTRIES = 3
WEAK_WORD_MIN_BUCKETS = 12
WEAK_WORD_MIN_WEEKS_IN_COUNTRY = 6
# Seen tying different cases together in the 2026-11-04 stress test, below
# those spreads: country names in other languages and generic words of one or
# two languages. Accents and Arabic hamza are folded, as in headline_words.
CONSOLIDATION_WEAK = frozenset('''
الاردن الأردن الاردني الأردني jordanie jordania jordanien urdun السعودية السعودي سوريا السوري العراق
العراقي اليمن اليمني لبنان مصر المصري اسرائيل إسرائيل الاسرائيلي فلسطين الفلسطيني ليبيا الجزائر
تونس المغرب تركيا ايران إيران باكستان افغانستان أفغانستان الصومال نيجيريا فرنسا المانيا ألمانيا روسيا
باريس موسكو francia franca fransa allemagne alemania deutschland almanya espagne spanien ispanya
italie italien italya russie rusia russland rusya россия россии российской москве москва turquie
turquia turkei inde indien hindistan colombie kolumbien kolombiya mexique mexiko meksika nigeria
pakistan
nuevo nueva nuevos nuevas hombre hombres jefe acusan muerto muertos captura nacional violencia policias
policia segundo zwei deutsche deutschen patlayici patlayıcı imha guncelleme daki הפיגוע המחבלים המחבל
مصدر اشتباكات الهجوم severe
'''.split())
# A Gemini group this large is a lumped window, not one incident: the
# largest genuine group in the 2026-11-04 data had 32 keys.
CONSOLIDATION_MAX_GROUP_KEYS = 40


def headline_words(event):
    """Headline words, accents folded ('Kerák' = 'kerak'). Primary and
    source-language headlines only: never anchors, places or related articles."""
    value = unicodedata.normalize('NFKD', ' '.join(str(event.get(k) or '') for k in ('title', 'original_title')))
    value = ''.join(ch for ch in value if not unicodedata.combining(ch)).casefold()
    return {x for x in re.findall(r'[^\W\d_]+', value) if len(x) >= 4 and x not in GENERIC}


def grounded_title(event):
    """A generated English title less the words a Latin-script source's own
    title and summary do not contain: a place the model took from a list of
    known incidents must not prove the article belongs to one. Other scripts
    cannot be compared word by word, so their title stays whole."""
    def fold(value):
        value = unicodedata.normalize('NFKD', str(value or ''))
        return ''.join(ch for ch in value if not unicodedata.combining(ch)).casefold()
    title, original = str(event.get('title') or ''), fold(event.get('original_title'))
    letters = [ch for ch in original if ch.isalpha()]
    if not letters or sum(ch.isascii() for ch in letters) / len(letters) < 0.5:
        return title
    source = original + ' ' + fold(event.get('original_summary'))
    return ' '.join(re.sub(r'[^\W\d_]+', lambda word: word.group() if fold(word.group()) in source else '', title).split())


def _country_key(event):
    return str(event.get('country_code') or event.get('country') or '').upper()


def _iso_week(value):
    try:
        moment = datetime.fromisoformat(str(value or '').replace('Z', '+00:00'))
    except ValueError:
        return None
    if moment.tzinfo is not None:
        moment = moment.astimezone(timezone.utc)
    return tuple(moment.isocalendar()[:2])


class WeakWords:
    """Words that cannot link two incidents: everywhere, or in one country."""

    def __init__(self, common=(), by_country=None):
        self.common = set(common)
        self.by_country = by_country or {}

    def distinctive(self, words, *countries):
        words = set(words) - self.common
        for country in countries:
            words -= self.by_country.get(country, set())
        return words


def consolidation_weak_words(events, extra_words=()):
    """WeakWords for these records: GENERIC, country names (the records' own
    countries plus extra_words such as demonyms) and the vocabulary measured
    as described at WEAK_WORD_MIN_COUNTRIES."""
    from collections import defaultdict
    weeks = defaultdict(lambda: defaultdict(set))
    common = set()
    for event in events:
        country, week = _country_key(event), _iso_week(event.get('published'))
        for word in headline_words(event):
            weeks[word][country].add(week)
        common |= headline_words({'title': event.get('country')})
    for word in [*extra_words, *CONSOLIDATION_WEAK]:
        common |= headline_words({'title': word})
    by_country = defaultdict(set)
    for word, per_country in weeks.items():
        if (len(per_country) >= WEAK_WORD_MIN_COUNTRIES
                and sum(len(found) for found in per_country.values()) >= WEAK_WORD_MIN_BUCKETS):
            common.add(word)
        for country, found in per_country.items():
            if len(found) >= WEAK_WORD_MIN_WEEKS_IN_COUNTRY:
                by_country[country].add(word)
    return WeakWords(common, dict(by_country))


def consolidation_pair_supported(left, right, weak):
    """Whether two records' own headlines tie them to one incident, for
    consolidation: the isolated-incident veto and the primary-identity checks
    of primary_pair_supported, then a shared DISTINCTIVE headline word (see
    WeakWords). A country name or shared vocabulary does not tie two keys:
    'nigerian' tied a Borno army raid to a Lagos cocaine seizure."""
    if not isinstance(weak, WeakWords):
        weak = WeakWords(weak or ())
    if isolated_pair(left, right):
        return False
    if same_primary_identity(left, right):
        return True
    shared = headline_words(left) & headline_words(right)
    return bool(weak.distinctive(shared, _country_key(left), _country_key(right)))


def supported_incident_components(keys, linked, min_support=1/3, max_keys=CONSOLIDATION_MAX_GROUP_KEYS):
    """Split one Gemini group into the sets of keys the headlines can carry.

    linked(a, b) says whether two keys share distinctive headline evidence.
    Within each connected set, the least linked key is set aside, one at a
    time, while it is linked to fewer than min_support of the others: an
    intruder Gemini added through one word leaves, the genuine keys stay.
    Set-aside keys stay apart (re-grouping them built false incidents when
    Gemini lumped a window). Groups of 4 keys or fewer are protected by the
    distinctive-word check alone, and a hub with many single-link leaves keeps
    its 3 earliest. A group over max_keys is refused whole. keys should come
    in time order: on a tie the latest key is set aside first. The rule this
    replaces rejected a whole group for any one unsupported pair.
    Returns (components of 2+ keys, keys left out), both in the given order."""
    import math
    keys = list(dict.fromkeys(keys))
    if len(keys) > max_keys:
        return [], keys
    order = {key: index for index, key in enumerate(keys)}
    edges = {key: {other for other in keys if other != key and linked(key, other)} for key in keys}

    def connected(nodes):
        parts, seen = [], set()
        for start in sorted(nodes, key=order.get):
            if start in seen:
                continue
            part, todo = set(), [start]
            while todo:
                key = todo.pop()
                if key not in part:
                    part.add(key)
                    todo.extend(edges[key] & (nodes - part))
            seen |= part
            parts.append(part)
        return parts

    components, left_out = [], []
    pending = [set(keys)] if keys else []
    while pending:
        for part in connected(pending.pop()):
            while len(part) >= 2:
                need = math.ceil(min_support * (len(part) - 1))
                degree = {key: len(edges[key] & part) for key in part}
                weakest = [key for key in part if degree[key] < need]
                if not weakest:
                    break
                victim = min(weakest, key=lambda key: (degree[key], -order[key]))
                part = part - {victim}
                left_out.append(victim)
                pieces = connected(part)
                if len(pieces) > 1:
                    # Each piece is judged on its own size.
                    pending.extend(pieces)
                    part = set()
            if len(part) >= 2:
                components.append(sorted(part, key=order.get))
            else:
                left_out.extend(part)
    return (sorted(components, key=lambda part: order[part[0]]),
            sorted(set(left_out), key=order.get))


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
