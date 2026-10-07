import hashlib
import json
import math
import os
import random
import re
import sys
import time
import unicodedata
from collections import Counter, defaultdict
from difflib import SequenceMatcher

import geonamescache
import requests


# ============================================================
# INTERPOL CT INTELLIGENCE MAP
# GEMINI AI-FIRST GEOLOCATION V5.3 — SOURCE-FIDELITY + NEW EVENTS ONLY
#
# Principle:
#   - Gemini decides the event location for EVERY event.
#   - No city/country is ever selected merely because a word happens
#     to match a geographic name (e.g. Worth, Mobile, Reading, Police).
#   - GeoNames is used AFTER the AI decision only to validate/resolve
#     the chosen place into coordinates.
#
# Cost control:
#   - Events are sent to Gemini in batches.
#   - Each event is cached using a content fingerprint.
#   - Daily runs only call the API for new/changed events.
#   - A backfill rebuild naturally calls AI for the whole database.
#
# Environment variables:
#   GEMINI_API_KEY      required
#   GEMINI_GEO_MODEL    optional, default: gemini-3.5-flash-lite
#   GEMINI_RESCUE_MODELS optional, comma-separated, tried in turn;
#                        default: gemini-3.7-flash,gemini-3.8-flash,gemini-3.5-flash
#   AI_GEO_BATCH_SIZE   optional, default: 20
#   AI_GEO_FORCE        optional, "1"/"true" to refresh every event
#   AI_GEO_PRESERVE_IDS_FILE optional JSON list of protected existing event IDs
# ============================================================


INPUT_FILE = "events.json"
OUTPUT_FILE = "events.json"

GEMINI_INTERACTIONS_URL = (
    "https://generativelanguage.googleapis.com/v1beta/interactions"
)

GEMINI_MODEL = os.getenv(
    "GEMINI_GEO_MODEL",
    "gemini-3.5-flash-lite",
)

# The rescue runs on Flash models no user-facing feature relies on, one after
# the other: each has its own free quota (20 requests/day, 5/minute). Gemini
# 3.6 Flash stays reserved as the Report Generator / Deep Search fallback.
GEMINI_RESCUE_MODELS = [
    model.strip()
    for model in os.getenv(
        "GEMINI_RESCUE_MODELS",
        "gemini-3.7-flash,gemini-3.8-flash,gemini-3.5-flash",
    ).split(",")
    if model.strip()
]

# The rescue model in use; it moves to the next one when a quota is reached.
GEMINI_RESCUE_MODEL = GEMINI_RESCUE_MODELS[0]

# New cache version: every event must be geolocated by the current AI engine.
AI_GEO_VERSION = "gemini-ai-first-v5.3-source-faithful"
BATCH_SIZE = max(
    1,
    min(
        30,
        int(
            os.getenv(
                "AI_GEO_BATCH_SIZE",
                "20",
            )
        ),
    ),
)

FORCE_AI = (
    os.getenv(
        "AI_GEO_FORCE",
        "",
    )
    .strip()
    .lower()
    in {
        "1",
        "true",
        "yes",
        "y",
    }
)

REQUEST_ATTEMPTS = 5
REQUEST_TIMEOUT = 240
REQUEST_PAUSE_SECONDS = 10.0

try:
    sys.stdout.reconfigure(
        line_buffering=True,
        write_through=True,
    )
    sys.stderr.reconfigure(
        line_buffering=True,
        write_through=True,
    )
except Exception:
    pass


# ============================================================
# GEONAMES
# ============================================================

gc = geonamescache.GeonamesCache(
    min_city_population=1000
)

CITIES = gc.get_cities()
COUNTRIES = gc.get_countries()

COUNTRY_BY_CODE = {}
COUNTRY_BY_NAME = {}

for country in COUNTRIES.values():
    code = (
        country.get("iso")
        or ""
    ).upper()

    if code:
        COUNTRY_BY_CODE[code] = country

    name = (
        country.get("name")
        or ""
    ).strip()

    if name:
        COUNTRY_BY_NAME[
            name.casefold()
        ] = country


COUNTRY_NAME_ALIASES = {
    "usa": "US",
    "u.s.": "US",
    "u.s.a.": "US",
    "united states of america": "US",
    "america": "US",

    "uk": "GB",
    "u.k.": "GB",
    "britain": "GB",
    "great britain": "GB",

    "russia": "RU",
    "iran": "IR",
    "syria": "SY",
    "south korea": "KR",
    "north korea": "KP",
    "laos": "LA",
    "moldova": "MD",
    "bolivia": "BO",
    "venezuela": "VE",
    "tanzania": "TZ",
    "brunei": "BN",

    "palestine": "PS",
    "palestinian territory": "PS",
    "palestinian territories": "PS",

    "ivory coast": "CI",
    "cote d'ivoire": "CI",
    "côte d’ivoire": "CI",

    "drc": "CD",
    "dr congo": "CD",
    "democratic republic of the congo": "CD",
    "congo-kinshasa": "CD",

    "congo-brazzaville": "CG",

    "uae": "AE",
    "u.a.e.": "AE",

    "czech republic": "CZ",
    "burma": "MM",
}


def normalize_name(value):
    value = str(
        value
        or
        ""
    ).strip()

    value = unicodedata.normalize(
        "NFKD",
        value
    )

    value = "".join(
        character
        for character in value
        if not unicodedata.combining(
            character
        )
    )

    value = value.casefold()

    value = re.sub(
        r"[^a-z0-9]+",
        " ",
        value
    )

    return re.sub(
        r"\s+",
        " ",
        value
    ).strip()


CITY_INDEX = defaultdict(list)

for city in CITIES.values():
    country_code = (
        city.get(
            "countrycode"
        )
        or
        ""
    ).upper()

    names = set()

    primary_name = city.get(
        "name"
    )

    if primary_name:
        names.add(
            primary_name
        )

    alternate_names = city.get(
        "alternatenames"
    )

    if isinstance(
        alternate_names,
        str
    ):
        alternate_names = [
            name.strip()
            for name
            in alternate_names.split(",")
            if name.strip()
        ]

    if isinstance(
        alternate_names,
        list
    ):
        for alternate in alternate_names:
            if alternate:
                names.add(
                    str(
                        alternate
                    )
                )

    for name in names:
        key = normalize_name(
            name
        )

        if len(key) < 2:
            continue

        CITY_INDEX[
            key
        ].append(
            city
        )


for key in CITY_INDEX:
    CITY_INDEX[
        key
    ].sort(
        key=lambda city:
            city.get(
                "population",
                0
            )
            or
            0,
        reverse=True,
    )


# ============================================================
# EVENT INPUT / CACHE
# ============================================================

def compact_text(
    text,
    max_chars
):
    text = re.sub(
        r"<[^>]+>",
        " ",
        str(
            text
            or
            ""
        )
    )

    text = re.sub(
        r"\s+",
        " ",
        text
    ).strip()

    if len(
        text
    ) <= max_chars:
        return text

    return (
        text[
            :max_chars
        ].rstrip()
        +
        "…"
    )


def event_categories(
    event
):
    categories = event.get(
        "categories"
    )

    if isinstance(
        categories,
        list
    ):
        return [
            str(
                category
            )
            for category
            in categories
            if category
        ]

    category = event.get(
        "category"
    )

    return (
        [
            str(
                category
            )
        ]
        if category
        else []
    )


def related_article_context(
    event
):
    related = event.get(
        "related_articles"
    )

    if not isinstance(
        related,
        list
    ):
        return []

    output = []

    for article in related[:3]:
        if not isinstance(
            article,
            dict
        ):
            continue

        title = compact_text(
            article.get(
                "title"
            ),
            300,
        )

        source = compact_text(
            article.get(
                "source"
            ),
            120,
        )

        original_title = compact_text(
            article.get(
                "original_title"
            ),
            300,
        )

        original_summary = compact_text(
            article.get(
                "original_summary"
            ),
            500,
        )

        if title or original_title:
            output.append(
                {
                    "title":
                        title,
                    "original_title":
                        original_title,
                    "original_summary":
                        original_summary,
                    "source":
                        source,
                }
            )

    return output


def event_ai_payload(
    event,
    index
):
    event_id = str(
        event.get(
            "id"
        )
        or
        f"event-{index}"
    )

    return {
        "event_id":
            event_id,

        "title":
            compact_text(
                event.get(
                    "title"
                ),
                650,
            ),

        "original_title":
            compact_text(
                event.get(
                    "original_title"
                ),
                650,
            ),

        "summary":
            compact_text(
                event.get(
                    "summary"
                ),
                900,
            ),

        "original_summary":
            compact_text(
                event.get(
                    "original_summary"
                ),
                900,
            ),

        "source":
            compact_text(
                event.get(
                    "source"
                ),
                180,
            ),

        "categories":
            event_categories(
                event
            ),

        "published":
            str(
                event.get(
                    "published"
                )
                or
                ""
            ),

        "related_articles":
            related_article_context(
                event
            ),
    }


def event_fingerprint(
    payload
):
    material = json.dumps(
        {
            "title":
                payload[
                    "title"
                ],
            "original_title":
                payload[
                    "original_title"
                ],
            "summary":
                payload[
                    "summary"
                ],
            "original_summary":
                payload[
                    "original_summary"
                ],
            "source":
                payload[
                    "source"
                ],
            "categories":
                payload[
                    "categories"
                ],
            "related_articles":
                payload[
                    "related_articles"
                ],
        },
        ensure_ascii=False,
        sort_keys=True,
    )

    return hashlib.sha256(
        material.encode(
            "utf-8"
        )
    ).hexdigest()


def is_cached(
    event,
    fingerprint
):
    """
    Automatic runs are NEW-EVENTS-ONLY.

    Once Gemini has completed geolocation for an event, that decision is
    frozen for all normal scheduled/daily runs. A later merge, translated
    title change, added source, category change, or fingerprint change does
    NOT send that historical event back to Gemini.

    The only exception is an explicit manual run with AI_GEO_FORCE=1.
    """

    if FORCE_AI:
        return False

    return (
        event.get(
            "ai_geo_complete"
        )
        is True
    )


# ============================================================
# STRUCTURED OUTPUT SCHEMA
# ============================================================

GEOLOCATION_SCHEMA = {
    "type": "object",
    "properties": {
        "results": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "event_id": {
                        "type": "string"
                    },
                    "country": {
                        "type": "string"
                    },
                    "country_iso2": {
                        "type": "string"
                    },
                    "city": {
                        "type": "string"
                    },
                    "region": {
                        "type": "string"
                    },
                    "precision": {
                        "type": "string",
                        "enum": [
                            "city",
                            "region",
                            "country",
                            "unknown",
                        ],
                    },
                    "confidence": {
                        "type": "number"
                    },
                    "latitude": {
                        "type": "number"
                    },
                    "longitude": {
                        "type": "number"
                    },
                    "location_is_inferred": {
                        "type": "boolean"
                    },
                    "evidence": {
                        "type": "string"
                    },
                    "reason": {
                        "type": "string"
                    },
                },
                "required": [
                    "event_id",
                    "country",
                    "country_iso2",
                    "city",
                    "region",
                    "precision",
                    "confidence",
                    "latitude",
                    "longitude",
                    "location_is_inferred",
                    "evidence",
                    "reason",
                ],
            },
        },
    },
    "required": [
        "results"
    ],
}


SYSTEM_INSTRUCTIONS = """
You are the geographic intelligence component of a counter-terrorism
situational-awareness map.

Your job is to determine WHERE THE EVENT DESCRIBED IN EACH NEWS ITEM OCCURRED,
or the best geographic location to which the event itself belongs.

This is a semantic reasoning task. Never assign a location merely because a
word is also the name of a city. For example, ordinary words such as Worth,
Mobile, Reading, Police, Nice, Orange, Bath, Sale, Union, Hope, State, or
Justice MUST NOT become cities unless the article context clearly uses them as
a geographic place.

Use all available context intelligently:
- explicit city, district, province, region, country;
- demonyms and nationalities;
- police/security/judicial institutions;
- terrorist or militant organisations;
- government bodies;
- public personalities;
- landmarks and facilities;
- related article titles from the same deduplicated event;
- geopolitical context and well-known entity-country relationships.

SOURCE-FIDELITY RULES:
- original_title and original_summary are source-of-record fields. title and
  summary may be AI-normalized English translations.
- If an English-normalized title/summary contains a city or country that is
  absent from, or conflicts with, the original-language source text, do not
  treat that generated place as evidence unless another independent article or
  concrete event fact supports it.
- A publisher's home country, website domain, ccTLD, language, Google News
  edition or query locale is not event-location evidence by itself.
- A related article can support geography only when it is clearly about the
  same real-world event. Do not let an unrelated article drag the event to the
  publisher's country.
- When geography remains unsupported after these checks, return unknown rather
  than pinning the event to a media outlet's country.
- MULTI-LOCATION EVENTS: when arrests, operations, seizures or attacks occur
  across several cities/regions, do not promote one city to event location
  merely because it is the capital, the newsroom, the ministry or the place
  mentioned most prominently. Return the common region or country unless the
  event has one genuine primary site.
- DIGITAL / NON-PHYSICAL EVENTS: a website shutdown, online propaganda item,
  cyber action, sanctions designation or platform/infrastructure decision does
  not automatically have a meaningful physical event location. Return unknown
  unless the event includes a concrete physical act (for example an arrest,
  raid, server seizure or attack) whose place is supported by the source.
- NATIONAL INSTITUTIONS: do not infer a capital city solely because a national
  ministry, military, police force, court or headquarters is mentioned. Use a
  city only when the text, a clearly identified facility, or independent
  event evidence supports that city; otherwise return region/country level.

IMPORTANT ORDER OF MEANING:
1. The actual place of the attack/arrest/trial/operation/financing event.
2. If no city can reasonably be determined, the relevant region.
3. If no region can reasonably be determined, the relevant country.
4. Never assign the publisher's home country merely because the publication is
   local/regional. Publisher geography can only corroborate a location already
   supported by the event text; it cannot create one.
5. Never use the headquarters, domain country, ccTLD or language of a media
   outlet as the event location.
6. A person's nationality or an organisation's home area is evidence, not
   automatically the event location. Use it only when the event semantics
   support that inference.
7. If several countries are mentioned, decide which country the EVENT belongs
   to, not which country merely appears first.
8. Prefer a country-level answer over inventing a city, especially for
   nationwide or multi-location reporting.
9. For a genuinely non-physical/global digital event, unknown is preferable to
   manufacturing a geographic pin from publisher, provider or sanctioning
   authority context.
10. Return unknown for physical events only when there truly is not enough
    information to associate the event with a country.

For city or region results, provide approximate latitude/longitude for that
place. For country-only results, latitude/longitude may be 0; the downstream
validator will place the event on the national capital.

country_iso2 must be a two-letter ISO 3166-1 alpha-2 code when a country is
known, otherwise an empty string.

confidence is between 0 and 1.
Keep evidence and reason concise.
"""


# ============================================================
# GEMINI INTERACTIONS API
# ============================================================

class GeminiIncompleteError(RuntimeError):
    """Interaction completed, but Gemini says the result is incomplete."""


class GeminiQuotaError(RuntimeError):
    """Free-tier quota/rate limit was reached."""


class GeminiTransientError(RuntimeError):
    """Temporary Gemini service/capacity problem after retries."""


def extract_gemini_text(
    response_json
):
    """
    Extract final model text from Gemini Interactions API.

    An `incomplete` interaction is recoverable: the caller will retry the
    same events in smaller sub-batches instead of aborting the workflow.
    """

    status = str(
        response_json.get(
            "status",
            ""
        )
        or
        ""
    ).lower()

    if status == "incomplete":
        raise GeminiIncompleteError(
            "Gemini interaction status=incomplete"
        )

    if status == "budget_exceeded":
        raise GeminiIncompleteError(
            "Gemini interaction status=budget_exceeded"
        )

    if status in {
        "failed",
        "cancelled",
    }:
        raise RuntimeError(
            "Gemini interaction ended with status "
            f"{status}: "
            f"{response_json.get('error')}"
        )

    texts = []

    for step in response_json.get(
        "steps",
        []
    ):
        if not isinstance(
            step,
            dict
        ):
            continue

        if step.get(
            "type"
        ) != "model_output":
            continue

        content = step.get(
            "content",
            []
        )

        if isinstance(
            content,
            dict
        ):
            content = [
                content
            ]

        if not isinstance(
            content,
            list
        ):
            continue

        for part in content:
            if not isinstance(
                part,
                dict
            ):
                continue

            if (
                part.get(
                    "type"
                )
                ==
                "text"
            ):
                value = part.get(
                    "text",
                    ""
                )

                if value:
                    texts.append(
                        value
                    )

    return "".join(
        texts
    ).strip()

def call_gemini_batch(
    batch,
    instructions_override=None,
    model_override=None,
):
    """
    Run one Gemini interaction.

    HTTP 429 is surfaced as GeminiQuotaError.
    Repeated 5xx/timeouts are surfaced as GeminiTransientError.
    `incomplete` is surfaced as GeminiIncompleteError so the caller can
    recursively split the batch.
    """

    api_key = os.getenv(
        "GEMINI_API_KEY"
    )

    if not api_key:
        raise RuntimeError(
            "GEMINI_API_KEY is missing. "
            "Create a GitHub Actions repository secret "
            "named GEMINI_API_KEY."
        )

    instructions = (
        instructions_override
        if instructions_override is not None
        else SYSTEM_INSTRUCTIONS
    )

    user_input = (
        "Geolocate every event below. "
        "Return exactly one result for every event_id. "
        "Do not omit an event. "
        "The location must describe the EVENT itself, "
        "not a coincidental place-name word.\n\n"
        +
        json.dumps(
            {
                "events":
                    batch
            },
            ensure_ascii=False,
        )
    )

    active_model = (
        model_override
        if model_override
        else GEMINI_MODEL
    )

    # Flash-Lite is an extraction/classification workload. Google recommends
    # minimal thinking for this use case. The rescue models get low thinking.
    thinking_level = (
        "minimal"
        if active_model
        ==
        GEMINI_MODEL
        else
        "low"
    )

    body = {
        "model":
            active_model,

        "input":
            user_input,

        "system_instruction":
            instructions,

        "store":
            False,

        "response_format": {
            "type":
                "text",

            "mime_type":
                "application/json",

            "schema":
                GEOLOCATION_SCHEMA,
        },

        "generation_config": {
            "max_output_tokens":
                24000,

            "thinking_level":
                thinking_level,
        },
    }

    headers = {
        "x-goog-api-key":
            api_key,

        "Content-Type":
            "application/json",
    }

    last_transient_status = None
    last_request_error = None

    for attempt in range(
        1,
        REQUEST_ATTEMPTS + 1,
    ):
        try:
            response = requests.post(
                GEMINI_INTERACTIONS_URL,
                headers=headers,
                json=body,
                timeout=REQUEST_TIMEOUT,
            )

            if response.status_code == 429:
                if "PerDay" in (response.text or ""):
                    # A daily quota: retrying before the reset (midnight
                    # Pacific) only wastes minutes of the workflow.
                    raise GeminiQuotaError(
                        f"Gemini daily quota reached for {active_model}."
                    )

                retry_after = response.headers.get(
                    "Retry-After"
                )

                if retry_after:
                    try:
                        delay = max(
                            10,
                            min(
                                180,
                                int(
                                    float(
                                        retry_after
                                    )
                                )
                            ),
                        )
                    except Exception:
                        delay = min(
                            120,
                            15 * attempt,
                        )
                else:
                    delay = min(
                        120,
                        (
                            15
                            *
                            attempt
                        )
                        +
                        random.uniform(
                            0,
                            5
                        ),
                    )

                print(
                    f"   Gemini quota/rate limit 429; "
                    f"attempt {attempt}/"
                    f"{REQUEST_ATTEMPTS}; "
                    f"retrying after {delay:.0f}s"
                )

                if attempt >= REQUEST_ATTEMPTS:
                    raise GeminiQuotaError(
                        "Gemini HTTP 429 quota/rate limit "
                        "after all retries."
                    )

                time.sleep(
                    delay
                )

                continue

            if response.status_code in {
                408,
                409,
                500,
                502,
                503,
                504,
            }:
                last_transient_status = (
                    response.status_code
                )

                delay = min(
                    90,
                    (
                        12
                        *
                        attempt
                    )
                    +
                    random.uniform(
                        0,
                        5
                    ),
                )

                print(
                    f"   Gemini temporary HTTP "
                    f"{response.status_code}; "
                    f"attempt {attempt}/"
                    f"{REQUEST_ATTEMPTS}; "
                    f"retrying after {delay:.0f}s"
                )

                if attempt >= REQUEST_ATTEMPTS:
                    raise GeminiTransientError(
                        "Gemini temporary HTTP "
                        f"{response.status_code} "
                        "after all retries."
                    )

                time.sleep(
                    delay
                )

                continue

            if response.status_code >= 400:
                raise RuntimeError(
                    "Gemini API error "
                    f"{response.status_code}: "
                    f"{response.text[:2200]}"
                )

            payload = response.json()

            output_text = extract_gemini_text(
                payload
            )

            if not output_text:
                raise GeminiIncompleteError(
                    "Gemini returned completed interaction "
                    "without model text."
                )

            try:
                parsed = json.loads(
                    output_text
                )

            except json.JSONDecodeError as error:
                raise GeminiIncompleteError(
                    "Gemini returned incomplete/invalid JSON: "
                    f"{error}"
                ) from error

            results = parsed.get(
                "results"
            )

            if not isinstance(
                results,
                list
            ):
                raise GeminiIncompleteError(
                    "Gemini JSON did not contain a results array."
                )

            time.sleep(
                REQUEST_PAUSE_SECONDS
            )

            return results

        except GeminiIncompleteError:
            # Do not burn five identical calls. The resilient caller will
            # immediately retry these events in smaller groups.
            raise

        except (
            requests.RequestException,
        ) as error:
            last_request_error = error

            if attempt >= REQUEST_ATTEMPTS:
                raise GeminiTransientError(
                    "Gemini network request failed after all retries: "
                    f"{error}"
                ) from error

            delay = min(
                90,
                10 * attempt,
            )

            print(
                f"   Gemini request error: "
                f"{error}; retrying in {delay}s"
            )

            time.sleep(
                delay
            )

    if last_transient_status is not None:
        raise GeminiTransientError(
            "Gemini temporary service error "
            f"{last_transient_status}."
        )

    if last_request_error is not None:
        raise GeminiTransientError(
            "Gemini request failed: "
            f"{last_request_error}"
        )

    raise GeminiTransientError(
        "Gemini batch request ended unexpectedly."
    )


def process_batch_resilient(
    batch,
    instructions_override=None,
    model_override=None,
    depth=0,
):
    """
    Process an event batch without ever failing the whole workflow merely
    because Gemini returned an incomplete result.

    Strategy:
      20 events -> if incomplete -> 10 + 10
      10 -> 5 + 5
      ...
      singleton still incomplete -> leave that one unlocated for next run.

    Quota and temporary service errors are re-raised so main() can checkpoint
    all completed work and exit cleanly.
    """

    try:
        return call_gemini_batch(
            batch,
            instructions_override=
                instructions_override,
            model_override=
                model_override,
        )

    except GeminiIncompleteError as error:
        if len(
            batch
        ) <= 1:
            event_id = (
                batch[0].get(
                    "event_id",
                    "unknown"
                )
                if batch
                else
                "unknown"
            )

            print(
                f"   Gemini still incomplete for single event "
                f"{event_id}; no usable geolocation result returned."
            )

            return []

        midpoint = max(
            1,
            len(
                batch
            )
            //
            2
        )

        left = batch[
            :midpoint
        ]

        right = batch[
            midpoint:
        ]

        print(
            f"   Gemini returned incomplete for "
            f"{len(batch)} events; splitting into "
            f"{len(left)} + {len(right)}."
        )

        left_results = process_batch_resilient(
            left,
            instructions_override=
                instructions_override,
            model_override=
                model_override,
            depth=
                depth + 1,
        )

        right_results = process_batch_resilient(
            right,
            instructions_override=
                instructions_override,
            model_override=
                model_override,
            depth=
                depth + 1,
        )

        return (
            left_results
            +
            right_results
        )



# ============================================================
# GEO VALIDATION / RESOLUTION
# ============================================================

def confidence_label(
    score
):
    try:
        score = float(
            score
        )
    except Exception:
        score = 0.0

    if score >= 0.82:
        return "high"

    if score >= 0.58:
        return "medium"

    return "low"


def valid_coordinates(
    latitude,
    longitude
):
    try:
        latitude = float(
            latitude
        )
        longitude = float(
            longitude
        )
    except Exception:
        return False

    return (
        -90
        <=
        latitude
        <=
        90

        and

        -180
        <=
        longitude
        <=
        180

        and

        not (
            abs(
                latitude
            )
            <
            0.000001

            and

            abs(
                longitude
            )
            <
            0.000001
        )
    )


def resolve_country_code(
    result
):
    code = str(
        result.get(
            "country_iso2"
        )
        or
        ""
    ).strip().upper()

    if code in COUNTRY_BY_CODE:
        return code

    country_name = str(
        result.get(
            "country"
        )
        or
        ""
    ).strip()

    normalized = normalize_name(
        country_name
    )

    alias_code = COUNTRY_NAME_ALIASES.get(
        normalized
    )

    if (
        alias_code
        and
        alias_code
        in COUNTRY_BY_CODE
    ):
        return alias_code

    country = COUNTRY_BY_NAME.get(
        country_name.casefold()
    )

    if country:
        return (
            country.get(
                "iso"
            )
            or
            ""
        ).upper()

    # Fuzzy country-name fallback only AFTER AI has decided the country.
    best = None
    best_score = 0.0

    for name, candidate in COUNTRY_BY_NAME.items():
        score = SequenceMatcher(
            None,
            normalized,
            normalize_name(
                name
            ),
        ).ratio()

        if score > best_score:
            best_score = score
            best = candidate

    if (
        best
        and
        best_score
        >=
        0.88
    ):
        return (
            best.get(
                "iso"
            )
            or
            ""
        ).upper()

    return ""


def resolve_city(
    city_name,
    country_code
):
    key = normalize_name(
        city_name
    )

    if not key:
        return None

    candidates = CITY_INDEX.get(
        key,
        []
    )

    if country_code:
        same_country = [
            candidate
            for candidate
            in candidates
            if (
                candidate.get(
                    "countrycode"
                )
                or
                ""
            ).upper()
            ==
            country_code
        ]

        if same_country:
            return same_country[0]

    if candidates:
        return candidates[0]

    # Conservative fuzzy validation around names beginning with
    # the same first character. AI already chose the city; this step
    # merely resolves spelling/transliteration.
    best = None
    best_score = 0.0

    first = (
        key[0]
        if key
        else ""
    )

    for indexed_name, indexed_candidates in CITY_INDEX.items():
        if (
            not indexed_name
            or
            indexed_name[0]
            !=
            first
        ):
            continue

        score = SequenceMatcher(
            None,
            key,
            indexed_name,
        ).ratio()

        if score < 0.90:
            continue

        candidate_pool = indexed_candidates

        if country_code:
            candidate_pool = [
                candidate
                for candidate
                in indexed_candidates
                if (
                    candidate.get(
                        "countrycode"
                    )
                    or
                    ""
                ).upper()
                ==
                country_code
            ]

        if (
            candidate_pool
            and
            score
            >
            best_score
        ):
            best_score = score
            best = candidate_pool[0]

    return best


def resolve_capital(
    country_code
):
    country = COUNTRY_BY_CODE.get(
        country_code
    )

    if not country:
        return None

    capital = country.get(
        "capital"
    )

    if not capital:
        return None

    return resolve_city(
        capital,
        country_code
    )


def clear_location(
    event
):
    event["city"] = None
    event["region"] = None
    event["country"] = None
    event["country_code"] = None
    event["latitude"] = None
    event["longitude"] = None
    event["location_precision"] = "unlocated"
    event["location_confidence"] = "low"
    event["location_confidence_score"] = 0.0
    event["location_method"] = "ai_unlocated"
    event["location_evidence"] = []
    event["excluded_from_map"] = False


def apply_ai_result(
    event,
    result,
    fingerprint
):
    clear_location(
        event
    )

    confidence = max(
        0.0,
        min(
            1.0,
            float(
                result.get(
                    "confidence"
                )
                or
                0.0
            ),
        ),
    )

    precision = str(
        result.get(
            "precision"
        )
        or
        "unknown"
    ).strip().lower()

    country_code = resolve_country_code(
        result
    )

    country = COUNTRY_BY_CODE.get(
        country_code
    )

    city_name = str(
        result.get(
            "city"
        )
        or
        ""
    ).strip()

    region_name = str(
        result.get(
            "region"
        )
        or
        ""
    ).strip()

    evidence = str(
        result.get(
            "evidence"
        )
        or
        ""
    ).strip()

    reason = str(
        result.get(
            "reason"
        )
        or
        ""
    ).strip()

    event["ai_geo_version"] = (
        AI_GEO_VERSION
    )

    event["ai_geo_complete"] = True

    event["ai_geo_fingerprint"] = (
        fingerprint
    )

    event["ai_geo_model"] = (
        GEMINI_MODEL
    )

    event["ai_geo_reason"] = reason

    event["ai_geo_inferred"] = bool(
        result.get(
            "location_is_inferred"
        )
    )

    event["location_confidence_score"] = (
        round(
            confidence,
            3
        )
    )

    event["location_confidence"] = (
        confidence_label(
            confidence
        )
    )

    event["location_evidence"] = (
        [
            evidence
        ]
        if evidence
        else []
    )

    if country:
        event["country"] = (
            country.get(
                "name"
            )
        )

        event["country_code"] = (
            country_code
        )

    # --------------------------------------------------------
    # CITY
    # --------------------------------------------------------

    if (
        precision
        ==
        "city"

        and

        country_code

        and

        city_name
    ):
        city = resolve_city(
            city_name,
            country_code
        )

        if city:
            event["city"] = (
                city.get(
                    "name"
                )
            )

            event["latitude"] = float(
                city.get(
                    "latitude"
                )
            )

            event["longitude"] = float(
                city.get(
                    "longitude"
                )
            )

            event["location_precision"] = (
                "city"
            )

            event["location_method"] = (
                "ai_city_geonames"
            )

            return

        # AI chose the city semantically but GeoNames could not resolve
        # its English/transliterated name. Use AI's coordinates when they
        # are valid instead of throwing away the semantic decision.
        if valid_coordinates(
            result.get(
                "latitude"
            ),
            result.get(
                "longitude"
            ),
        ):
            event["city"] = city_name

            event["latitude"] = float(
                result[
                    "latitude"
                ]
            )

            event["longitude"] = float(
                result[
                    "longitude"
                ]
            )

            event["location_precision"] = (
                "city"
            )

            event["location_method"] = (
                "ai_city_coordinates"
            )

            return

    # --------------------------------------------------------
    # REGION
    # --------------------------------------------------------

    if (
        precision
        ==
        "region"

        and

        country_code
    ):
        if valid_coordinates(
            result.get(
                "latitude"
            ),
            result.get(
                "longitude"
            ),
        ):
            event["region"] = (
                region_name
                or
                city_name
                or
                event[
                    "country"
                ]
            )

            event["latitude"] = float(
                result[
                    "latitude"
                ]
            )

            event["longitude"] = float(
                result[
                    "longitude"
                ]
            )

            event["location_precision"] = (
                "region"
            )

            event["location_method"] = (
                "ai_region_coordinates"
            )

            return

    # --------------------------------------------------------
    # COUNTRY / FALLBACK TO CAPITAL
    #
    # Also used when AI identified the country correctly but the city
    # could not be validated.
    # --------------------------------------------------------

    if country_code:
        capital = resolve_capital(
            country_code
        )

        if capital:
            event["city"] = (
                capital.get(
                    "name"
                )
            )

            event["latitude"] = float(
                capital.get(
                    "latitude"
                )
            )

            event["longitude"] = float(
                capital.get(
                    "longitude"
                )
            )

            event["location_precision"] = (
                "country_capital"
            )

            event["location_method"] = (
                "ai_country_capital"
            )

            return

    # --------------------------------------------------------
    # TRUE UNKNOWN
    # --------------------------------------------------------

    event["location_precision"] = (
        "unlocated"
    )

    event["location_method"] = (
        "ai_unlocated"
    )


# ============================================================
# QUOTA-SAFE CHECKPOINTS
# ============================================================

def save_checkpoint(data, label):
    """Atomically preserve completed geolocation batches for the next run."""
    temporary = str(OUTPUT_FILE) + ".tmp"
    try:
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, OUTPUT_FILE)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)
    print(f"   Checkpoint saved: {label}")


def quota_or_capacity_error(
    error,
):
    message = str(
        error
    ).casefold()

    return (
        "429" in message
        or
        "resource_exhausted" in message
        or
        "too_many_requests" in message
        or
        "quota" in message
        or
        "rate limit" in message
        or
        "rate-limit" in message
    )


def prepare_pending_event(
    event,
):
    """
    AI-only mapping safeguard.

    Any event not yet processed by this AI version has its old/legacy
    geolocation removed before API processing. If quota is reached, remaining
    events stay unlocated (and therefore hidden from the map) rather than
    showing a lexical false positive.
    """

    clear_location(
        event
    )

    event["ai_geo_complete"] = False
    event["ai_geo_rescue_complete"] = False
    event["ai_geo_rescue_status"] = None
    event["ai_geo_rescue_model"] = None
    event["ai_geo_rescue_reason"] = None
    event["ai_geo_version"] = AI_GEO_VERSION
    event["ai_geo_model"] = None
    event["ai_geo_reason"] = (
        "Awaiting Gemini semantic geolocation"
    )
    event["location_method"] = (
        "awaiting_ai_geolocation"
    )


# ============================================================
# RESCUE PASS
# ============================================================

def mark_rescue_complete(
    event,
    status,
    reason=None,
    model=None,
):
    """
    Freeze the automatic rescue decision for this event.

    Normal scheduled runs will never send it to the rescue model again.
    AI_GEO_FORCE=1 resets the rescue state through prepare_pending_event().
    """
    event["ai_geo_rescue_complete"] = True
    event["ai_geo_rescue_status"] = status
    event["ai_geo_rescue_model"] = model or GEMINI_RESCUE_MODEL
    event["ai_geo_rescue_reason"] = (
        str(reason)[:1000]
        if reason
        else None
    )


RESCUE_INSTRUCTIONS = """
You are doing a second-pass geographic inference for counter-terrorism news
events that the first AI pass could not associate with a country.

For each event, make a strong but reasoned attempt to identify the MOST LIKELY
country to which the event itself belongs. Use semantic knowledge of people,
organisations, security agencies, courts, local media, regions, landmarks,
demonym/nationality and geopolitical context. Do not mistake ordinary English
words for place names.

Prefer country-level inference over returning unknown. Do NOT invent a city if
only the country can be supported.

Return unknown only when even the country genuinely cannot be inferred.
"""


def rescue_unknown_events(
    unresolved
):
    """
    Return (results, completed_attempt_ids), where completed_attempt_ids
    maps each event id to the rescue model that handled it.

    An event is added to completed_attempt_ids only when its rescue batch
    completed without quota/transient failure. Those events may therefore be
    frozen after this one automatic rescue. If Gemini is unavailable, the
    affected batch is NOT frozen and may be retried on a later run.
    """
    if not unresolved:
        return [], set()

    batches = []

    for start in range(
        0,
        len(
            unresolved
        ),
        BATCH_SIZE,
    ):
        batches.append(
            unresolved[
                start:
                start + BATCH_SIZE
            ]
        )

    results = []
    completed_attempt_ids = {}

    rescue_instructions = (
        SYSTEM_INSTRUCTIONS
        +
        "\n\n"
        +
        RESCUE_INSTRUCTIONS
    )

    global GEMINI_RESCUE_MODEL
    models = list(GEMINI_RESCUE_MODELS)

    for number, batch in enumerate(
        batches,
        start=1,
    ):
        print(
            f"   Gemini rescue batch "
            f"{number}/{len(batches)} "
            f"({len(batch)} events)"
        )

        try:
            while True:
                GEMINI_RESCUE_MODEL = models[0]
                try:
                    batch_results = process_batch_resilient(
                        batch,
                        instructions_override=
                            rescue_instructions,
                        model_override=
                            GEMINI_RESCUE_MODEL,
                    )
                    break
                except GeminiQuotaError as error:
                    # This model's free quota is spent: the next one has its own.
                    models.pop(0)
                    if not models:
                        raise
                    print(
                        f"   Rescue quota reached on {GEMINI_RESCUE_MODEL} ({error}); "
                        f"switching to {models[0]}."
                    )

            results.extend(
                batch_results
            )

            completed_attempt_ids.update(
                (
                    str(
                        item.get(
                            "event_id"
                        )
                    ),
                    GEMINI_RESCUE_MODEL,
                )
                for item in batch
                if item.get(
                    "event_id"
                )
            )

        except (
            GeminiQuotaError,
            GeminiTransientError,
        ) as error:
            print(
                "   Gemini rescue unavailable for the rest "
                f"of this run: {error}"
            )
            print(
                "   Keeping all valid primary-model locations."
            )
            break

    return results, completed_attempt_ids


# ============================================================
# MAIN
# ============================================================

def load_preserved_event_ids():
    """Optional per-run protection of pre-existing locations/AI decisions."""
    path = os.getenv("AI_GEO_PRESERVE_IDS_FILE", "")
    if not path:
        return set()
    if FORCE_AI:
        raise RuntimeError("Existing-location protection cannot be combined with forced geolocation.")
    with open(path, encoding="utf-8") as handle:
        ids = json.load(handle)
    if not isinstance(ids, list) or any(not isinstance(value, str) for value in ids):
        raise RuntimeError("Invalid existing-location protection file; geolocation stopped.")
    return set(ids)


def main():
    preserved_event_ids = load_preserved_event_ids()
    print()
    print("=" * 72)
    print("INTERPOL CT Intelligence Map")
    print("GEMINI AI-FIRST GEOLOCATION V5.2 — ONE-SHOT RESCUE + CHECKPOINTS")
    print("=" * 72)
    print(
        f"Primary model: {GEMINI_MODEL}"
    )
    print(
        f"Rescue models: {', '.join(GEMINI_RESCUE_MODELS)}"
    )
    print(
        f"Batch size: {BATCH_SIZE}"
    )
    print(
        f"Force refresh: {FORCE_AI}"
    )

    print(
        "Automatic mode: NEW EVENTS ONLY"
        if not FORCE_AI
        else
        "Automatic mode overridden: FULL MANUAL AI REFRESH"
    )
    print(
        "Primary thinking: minimal"
    )
    print(
        "Incomplete handling: recursive batch split"
    )

    if not os.getenv(
        "GEMINI_API_KEY"
    ):
        raise RuntimeError(
            "GEMINI_API_KEY is not available to geolocate.py."
        )

    with open(
        INPUT_FILE,
        "r",
        encoding="utf-8",
    ) as file:
        data = json.load(
            file
        )

    events = data.get(
        "events",
        []
    )

    print(
        f"Events loaded: {len(events)}"
    )

    pending = []
    fingerprints = {}
    payload_by_id = {}
    event_by_id = {}

    cached_count = 0

    for index, event in enumerate(
        events
    ):
        # Protected events never enter primary or rescue processing.
        if str(event.get("id", "")) in preserved_event_ids:
            cached_count += 1
            continue

        payload = event_ai_payload(
            event,
            index,
        )

        event_id = payload[
            "event_id"
        ]

        # Ensure uniqueness even if legacy records share an id.
        if event_id in event_by_id:
            event_id = (
                event_id
                +
                "-"
                +
                str(
                    index
                )
            )

            payload[
                "event_id"
            ] = event_id

        fingerprint = event_fingerprint(
            payload
        )

        fingerprints[
            event_id
        ] = fingerprint

        payload_by_id[
            event_id
        ] = payload

        event_by_id[
            event_id
        ] = event

        if is_cached(
            event,
            fingerprint
        ):
            cached_count += 1
            continue

        prepare_pending_event(
            event
        )

        pending.append(
            payload
        )

    if pending:
        save_checkpoint(
            data,
            "pending legacy locations cleared",
        )

    print(
        f"Gemini cached: {cached_count}"
    )

    print(
        f"Gemini to process: {len(pending)}"
    )

    completed = 0

    if pending:
        total_batches = math.ceil(
            len(
                pending
            )
            /
            BATCH_SIZE
        )

        for start in range(
            0,
            len(
                pending
            ),
            BATCH_SIZE,
        ):
            batch_number = (
                start
                //
                BATCH_SIZE
                +
                1
            )

            batch = pending[
                start:
                start + BATCH_SIZE
            ]

            print()
            print(
                f"Gemini batch "
                f"{batch_number}/{total_batches} "
                f"— {len(batch)} events"
            )

            try:
                results = process_batch_resilient(
                    batch,
                    model_override=
                        GEMINI_MODEL,
                )

            except (
                GeminiQuotaError,
                GeminiTransientError,
            ) as error:
                print()
                print(
                    "Gemini quota/capacity temporarily unavailable."
                )
                print(
                    f"Reason: {error}"
                )
                print(
                    "Progress is saved. The next workflow run will "
                    "resume with only the remaining unprocessed events."
                )

                save_checkpoint(
                    data,
                    "quota/capacity-safe partial progress",
                )

                break

            result_by_id = {
                str(
                    result.get(
                        "event_id"
                    )
                ):
                    result
                for result
                in results
                if result.get(
                    "event_id"
                )
            }

            missing = []

            for payload in batch:
                event_id = payload[
                    "event_id"
                ]

                result = result_by_id.get(
                    event_id
                )

                if result is None:
                    missing.append(
                        event_id
                    )
                    continue

                apply_ai_result(
                    event_by_id[
                        event_id
                    ],
                    result,
                    fingerprints[
                        event_id
                    ],
                )

                completed += 1

            if missing:
                print(
                    f"   Gemini omitted {len(missing)} event(s) "
                    "from this batch; they remain unlocated and "
                    "will be retried on a later run."
                )

                print(
                    "   Missing IDs: "
                    +
                    ", ".join(
                        missing[:10]
                    )
                )

            print(
                f"   Gemini geolocated: "
                f"{completed}/{len(pending)}"
            )

            save_checkpoint(
                data,
                (
                    f"primary batch "
                    f"{batch_number}/{total_batches}"
                ),
            )

    # --------------------------------------------------------
    # AI RESCUE: AI AGAIN, NOT LEXICAL RULES.
    # --------------------------------------------------------

    unresolved_payloads = []

    for event_id, event in event_by_id.items():
        if (
            event.get(
                "ai_geo_complete"
            )
            is True

            and

            event.get(
                "ai_geo_rescue_complete"
            )
            is not True

            and

            (
                event.get(
                    "location_precision"
                )
                ==
                "unlocated"

                or

                float(
                    event.get(
                        "location_confidence_score"
                    )
                    or
                    0.0
                )
                <
                0.55
            )

            and

            event_id in payload_by_id
        ):
            unresolved_payloads.append(
                payload_by_id[
                    event_id
                ]
            )

    if unresolved_payloads:
        print()
        print(
            f"Gemini rescue pass for "
            f"{len(unresolved_payloads)} "
            f"unlocated events..."
        )

        (
            rescue_results,
            rescue_attempted_ids,
        ) = rescue_unknown_events(
            unresolved_payloads
        )

        rescue_result_by_id = {
            str(
                result.get(
                    "event_id"
                )
                or
                ""
            ):
                result
            for result in rescue_results
            if result.get(
                "event_id"
            )
        }

        rescue_located = 0
        rescue_exhausted = 0

        for event_id in rescue_attempted_ids:
            if event_id not in event_by_id:
                continue

            event = event_by_id[
                event_id
            ]

            result = rescue_result_by_id.get(
                event_id
            )

            if (
                result is not None
                and
                resolve_country_code(
                    result
                )
            ):
                apply_ai_result(
                    event,
                    result,
                    fingerprints[
                        event_id
                    ],
                )

                mark_rescue_complete(
                    event,
                    "located",
                    result.get(
                        "reason"
                    ),
                    model=rescue_attempted_ids[
                        event_id
                    ],
                )

                rescue_located += 1
                continue

            # One automatic rescue has completed without a usable country.
            # Keep the event in events.json for lists/reports, but never send
            # it to Gemini rescue again during normal scheduled runs.
            if result is not None:
                reason = (
                    result.get(
                        "reason"
                    )
                    or
                    result.get(
                        "evidence"
                    )
                    or
                    "Gemini rescue could not infer a reliable country."
                )
            else:
                reason = (
                    "Gemini rescue completed but returned no usable "
                    "result for this event."
                )

            mark_rescue_complete(
                event,
                "unlocated_final",
                reason,
                model=rescue_attempted_ids[
                    event_id
                ],
            )

            event["location_precision"] = "unlocated"
            event["location_method"] = "ai_unlocated_final"
            event["excluded_from_map"] = True

            rescue_exhausted += 1

        if rescue_attempted_ids:
            print(
                f"   Rescue located: {rescue_located}"
            )
            print(
                f"   Rescue permanently unlocated: "
                f"{rescue_exhausted}"
            )

        save_checkpoint(
            data,
            "Gemini 3.6 one-shot rescue pass",
        )

    # --------------------------------------------------------
    # SUMMARY
    # --------------------------------------------------------

    precision_counts = Counter(
        event.get(
            "location_precision",
            "unlocated",
        )
        for event in events
    )

    method_counts = Counter(
        event.get(
            "location_method",
            "unknown",
        )
        for event in events
    )

    rescue_status_counts = Counter(
        event.get(
            "ai_geo_rescue_status",
            "not_attempted",
        )
        for event in events
    )

    confidence_counts = Counter(
        event.get(
            "location_confidence",
            "low",
        )
        for event in events
    )

    mapped_total = (
        len(
            events
        )
        -
        precision_counts[
            "unlocated"
        ]
    )

    data[
        "geolocation"
    ] = {
        "method":
            "Gemini AI-first semantic geolocation",

        "version":
            AI_GEO_VERSION,

        "primary_model":
            GEMINI_MODEL,

        "rescue_model":
            GEMINI_RESCUE_MODEL,

        "rescue_models":
            GEMINI_RESCUE_MODELS,

        "rescue_policy":
            "one_automatic_rescue_then_freeze",

        "rescue_unlocated_final":
            rescue_status_counts.get(
                "unlocated_final",
                0,
            ),

        "ai_for_every_event":
            True,

        "cached_events":
            cached_count,

        "ai_processed_this_run":
            completed,

        "ai_pending_at_start":
            len(
                pending
            ),

        "city":
            precision_counts[
                "city"
            ],

        "region":
            precision_counts[
                "region"
            ],

        "country_capital":
            precision_counts[
                "country_capital"
            ],

        "unlocated":
            precision_counts[
                "unlocated"
            ],

        "mapped_total":
            mapped_total,

        "high_confidence":
            confidence_counts[
                "high"
            ],

        "medium_confidence":
            confidence_counts[
                "medium"
            ],

        "low_confidence":
            confidence_counts[
                "low"
            ],

        "methods":
            dict(
                method_counts
            ),
    }

    save_checkpoint(data, "geolocation complete")

    print()
    print("=" * 72)
    print("GEMINI GEOLOCATION COMPLETE")
    print("=" * 72)
    print(
        f"City:              "
        f"{precision_counts['city']}"
    )
    print(
        f"Region:            "
        f"{precision_counts['region']}"
    )
    print(
        f"Country → capital: "
        f"{precision_counts['country_capital']}"
    )
    print(
        f"Unlocated:         "
        f"{precision_counts['unlocated']}"
    )
    print(
        f"Rescue exhausted:  "
        f"{rescue_status_counts.get('unlocated_final', 0)}"
    )
    print(
        f"Mapped total:      "
        f"{mapped_total}/{len(events)}"
    )
    print(
        f"Gemini cached:         "
        f"{cached_count}"
    )
    print(
        f"Gemini processed:      "
        f"{len(pending)}"
    )
    print("=" * 72)


if __name__ == "__main__":
    main()
