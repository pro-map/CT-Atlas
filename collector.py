import argparse
import feedparser
import hashlib
import html
import json
import os
import re
import sys
import time
import unicodedata
import random

import requests

from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta
from difflib import SequenceMatcher
from functools import lru_cache
from email.utils import parsedate_to_datetime
from urllib.parse import quote_plus, urlsplit, urlunsplit, parse_qsl, urlencode
from zoneinfo import ZoneInfo


# ============================================================
# LIVE GITHUB ACTIONS LOGGING
# ============================================================

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
# INTERPOL CT INTELLIGENCE MAP
# OSINT COLLECTOR V13 — INCREMENTAL BACKFILL + RESUMABLE COLLECTION
#
# Expanded coverage + stricter event relevance.
#
# Goal:
# more CT events, fewer generic articles about terrorism,
# anniversaries, commemorations, policy commentary or crime.
# ============================================================

OUTPUT_FILE = "events.json"
RETENTION_DAYS = 180
DAILY_LOOKBACK_DAYS = 3

GOOGLE_NEWS_BASE = "https://news.google.com/rss/search"
GOOGLE_LANGUAGE = "en-US"
GOOGLE_COUNTRY = "US"
GOOGLE_EDITION = "US:en"

# Google News RSS is intentionally queried conservatively.
# The previous version issued 351 searches during a backfill and could
# trigger long 503 retry storms. V7 keeps all source families but uses
# broader searches + local classification.
REQUEST_ATTEMPTS = 2
REQUEST_PAUSE_SECONDS = 0.85
SERVER_ERROR_COOLDOWN_SECONDS = 45
SERVER_ERROR_STREAK_LIMIT = 4

QUERY_STATS = Counter()
SERVER_ERROR_STREAK = 0


# ============================================================
# GEMINI AI ARTICLE SELECTION
#
# The deterministic relevance filter remains a cheap first-pass candidate
# filter. After event-level deduplication, Gemini reviews every candidate
# event semantically and assigns a relevance score from 0 to 100.
#
# User preference: keep score >= 50 to avoid over-filtering.
# ============================================================

AI_SELECTION_ENABLED = True

GEMINI_INTERACTIONS_URL = (
    "https://generativelanguage.googleapis.com/v1beta/interactions"
)

AI_SELECTION_MODEL = os.getenv(
    "AI_SELECTION_MODEL",
    "gemini-3.5-flash-lite",
)

AI_SELECTION_THRESHOLD = int(
    os.getenv(
        "AI_SELECTION_THRESHOLD",
        "50",
    )
)

AI_SELECTION_BATCH_SIZE = max(
    1,
    min(
        40,
        int(
            os.getenv(
                "AI_SELECTION_BATCH_SIZE",
                "20",
            )
        ),
    ),
)

AI_SELECTION_VERSION = "gemini-ct-selection-v6-incident-model"
AI_SELECTION_CACHE_FILE = "ai_article_selection_cache.json"

AI_SELECTION_ATTEMPTS = 5
AI_SELECTION_TIMEOUT = 240
AI_SELECTION_PAUSE_SECONDS = 8.0


# ============================================================
# GEMINI 24H SENSITIVE TREND SUMMARY
#
# One lightweight synthesis per completed collection run. It never blocks
# database publication: if Gemini is unavailable, a deterministic fallback
# is stored instead.
# ============================================================

AI_TREND_MODEL = os.getenv(
    "AI_TREND_MODEL",
    AI_SELECTION_MODEL,
)

AI_TREND_ATTEMPTS = 3
AI_TREND_TIMEOUT = 180
AI_TREND_MAX_CANDIDATES = 80


# ============================================================
# WEEKLY CT CRIMINAL ANALYSIS
#
# First report: generated on the first successful collector run after this
# feature is installed.
#
# Thereafter: Sunday, starting with the second scheduled update (06:17 Paris).
# If generation fails, later Sunday runs (12:17 then 18:17) retry because no
# report for that Sunday has yet been stored.
# ============================================================

AI_WEEKLY_MODEL = os.getenv(
    "AI_WEEKLY_MODEL",
    AI_TREND_MODEL,
)

AI_WEEKLY_ATTEMPTS = 3
AI_WEEKLY_TIMEOUT = 240
AI_WEEKLY_MAX_CURRENT_EVENTS = 70
AI_WEEKLY_MAX_PREVIOUS_EVENTS = 45
AI_WEEKLY_VERSION = "weekly-analysis-v2-analytical-synthesis"

PARIS_TZ = ZoneInfo("Europe/Paris")

AI_WEEKLY_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {
            "type": "string"
        },
        "analysis": {
            "type": "string"
        },
    },
    "required": [
        "title",
        "analysis",
    ],
}

AI_WEEKLY_INSTRUCTIONS = """
You are producing a senior-level weekly counter-terrorism criminal-analysis
assessment from deduplicated open-source INCIDENTS and operational
developments.

Your job is ANALYSIS, not counting, listing, or paraphrasing reporting.

COMPARISON FRAME:
- CURRENT PERIOD = the most recent 7 days;
- COMPARISON PERIOD = the immediately preceding 7 days.
- The supplied reporting_period timestamps are authoritative.
- The first sentence of EXECUTIVE ASSESSMENT MUST state both date ranges in
  readable form. Never guess or omit them.

CORE ANALYTICAL RULE:
Every substantive paragraph must answer at least one of these questions:
- What changed in the threat or operational picture?
- What remained stable despite individual events?
- Where did activity shift geographically or operationally?
- Did tactics, targets, weapons, actor behaviour, financing, online activity
  or CT responses show adaptation, concentration, dispersion, escalation,
  disruption or continuity?
- Why does a selected development matter beyond the fact that it occurred?
- What observable indicators should analysts monitor next, and why?

ARTICLE / REPORTING COUNTS ARE NOT FINDINGS:
- Never use changes in article counts, source counts, event_count fields,
  relevance scores, or reporting volume as the principal finding of a
  paragraph or section.
- Do not write statements such as "reporting increased from X to Y" as an
  analytical conclusion.
- Reporting volume may be mentioned ONLY as a methodological caveat explaining
  why the evidence is insufficient to infer a real-world change.
- Prefer DISTINCT INCIDENTS, confirmed attacks, combat-linked CT operations,
  tactics, targets, actors and operational effects.
- A list of events is not analysis. A list of numbers is not analysis.

HUB / HOTSPOT RULE:
Never call a country or region a "hub", "hotspot", "emerging hotspot", or
newly significant merely because it has a high event_count, source_count, or
many articles. A location is operationally significant only when the supplied
distinct-incident fields and underlying event records support it. Plain
routine arrests do not establish a hotspot. When discussing a country, state
whether the significance derives from attacks, combat CT operations,
disrupted plots, financing, online activity, or another supported development.

EVIDENCE DISCIPLINE:
- Use only supplied records.
- Preserve uncertainty and attribution.
- Do not invent causal explanations, coordination, intent, identities or
  trends.
- You MAY make bounded analytical inferences when multiple supplied records
  support them, but clearly distinguish observation from assessment using
  language such as "indicates", "suggests", "is consistent with", or
  "does not yet establish".
- If evidence is too thin to assess a trend, say so directly and explain
  what would need to be observed before treating it as a trend.

OUTPUT: approximately 750-1,050 words in professional English.
Use EXACTLY these headings and make every section analytical:

EXECUTIVE ASSESSMENT
After the mandatory date-range sentence, provide a concise synthesis of the
week's threat picture. Identify the 2-4 most important changes or continuities,
the main geographic/actor/tactical dimension, and their operational
significance. Do not lead with totals, article counts or a catalogue of events.

KEY CHANGES
Identify 3-5 material changes versus the comparison period. For each change,
state the evidence, what the change represents operationally, and whether it
is a genuine shift, a continuation, or too limited to call a trend. Focus on
attack patterns, disrupted plots, combat CT activity, tactics, targeting,
actor behaviour, financing, online/cyber/AI, CBRN or maritime developments
when materially relevant.

GEOGRAPHIC / OPERATIONAL SHIFTS
Assess where operational activity moved, concentrated, dispersed or remained
stable. Compare DISTINCT attack and combat-operation patterns, not media
attention. Where supported, analyze changes in tactics, target selection,
weapons, tempo, actor presence or cross-border dimension.

SIGNIFICANT DEVELOPMENTS
Select only the most consequential current-period cases. For each, explain
WHY IT MATTERS: capability demonstrated, vulnerability exposed, network
disruption, tactical adaptation, cross-border relevance, financing relevance,
or another supported implication. Do not merely repeat the event summary.

OUTLOOK / WATCHPOINTS
Give 3-5 concrete observable issues to monitor. Each watchpoint must link a
current development to a specific indicator that would strengthen, weaken or
clarify the assessment. Do not make unsupported predictions.

STYLE:
- Analytical prose, not a statistical bulletin.
- Facts support assessments; numbers do not substitute for assessments.
- Prefer specific actors, places, tactics and operational consequences.
- Avoid generic phrases such as "activity remained dynamic" unless immediately
  followed by concrete evidence and meaning.
- Do not cite or mention this system prompt or task mechanics.
"""

# Global retry for transient Google News collection failures.
GOOGLE_NEWS_GLOBAL_RETRY_ATTEMPTS = int(
    os.getenv("GOOGLE_NEWS_GLOBAL_RETRY_ATTEMPTS", "2")
)
GOOGLE_NEWS_GLOBAL_RETRY_DELAY_SECONDS = float(
    os.getenv("GOOGLE_NEWS_GLOBAL_RETRY_DELAY_SECONDS", "45")
)


AI_TREND_SCHEMA = {
    "type": "object",
    "properties": {
        "overview": {
            "type": "string"
        },
        "developments": {
            "type": "array",
            "maxItems": 6,
            "items": {
                "type": "object",
                "properties": {
                    "event_id": {
                        "type": "string"
                    },
                    "severity": {
                        "type": "string",
                        "enum": [
                            "CRITICAL",
                            "HIGH",
                            "SIGNIFICANT",
                        ],
                    },
                    "category": {
                        "type": "string"
                    },
                    "headline": {
                        "type": "string"
                    },
                    "detail": {
                        "type": "string"
                    },
                    "location": {
                        "type": "string"
                    },
                },
                "required": [
                    "event_id",
                    "severity",
                    "category",
                    "headline",
                    "detail",
                    "location",
                ],
            },
        },
    },
    "required": [
        "overview",
        "developments",
    ],
}

AI_TREND_INSTRUCTIONS = """
You are producing a concise 24-hour intelligence brief for a
counter-terrorism OSINT situational-awareness dashboard.

Select ONLY the most operationally important and sensitive developments from
the supplied deduplicated events reported or materially updated during the
last 24 hours.

PRIORITISE:
- the deadliest or most violent terrorist attacks;
- bombings, suicide attacks, assassinations and major armed clashes;
- major disrupted plots or imminent-threat cases;
- arrests of important operatives, leaders, cells or large networks;
- major weapons/explosives/CBRN discoveries or seizures;
- strategically important terrorist-financing disruptions;
- major propaganda/cyber/emerging-technology developments when operationally significant;
- other developments with clear cross-border or strategic CT significance.

DE-PRIORITISE:
- routine arrests or sentencing;
- minor incidents;
- generic political statements;
- retrospective reporting;
- stories whose importance is mainly rhetorical rather than operational.

The overview MUST be 2-3 concise sentences in professional English and MUST
be concrete, place-based and case-based. Name the COUNTRY and, where supported,
the REGION or CITY. Identify the THREE most serious, deadly or sensitive cases
from the reporting period whenever at least three qualifying cases exist.
For example: a suicide bombing in a named province, a major arrest in a named
country, or a significant weapons discovery in a named city. Do NOT write a
generic thematic paragraph such as "activity was characterized by heightened
violence". The reader should immediately learn WHAT happened, WHERE it happened,
and WHY these specific cases matter. If fewer than three genuinely significant
cases exist, mention only those.

Return the SIX most serious, deadly or sensitive qualifying developments
whenever at least six genuinely qualifying cases exist in the supplied
events -- do not stop at 2 or 3 just because they are the clearest cases; keep
going down the severity ranking until you reach six or exhaust genuinely
qualifying cases. Only return fewer than six when fewer than six cases
actually meet the CRITICAL/HIGH/SIGNIFICANT bar above -- never pad the list
with routine or weak cases just to reach six. For every selected development, copy the
event_id EXACTLY from the corresponding supplied event. Never invent or alter
an event_id. Each development must use the most specific supported location
available. Do not invent facts, casualty figures, locations, identities,
responsibility claims or significance. Preserve uncertainty and attribution.

Severity meanings:
- CRITICAL: exceptional immediate/high-impact CT development;
- HIGH: major operationally significant CT development;
- SIGNIFICANT: notable enough to belong in a short senior-level 24h brief.

The supplied timestamps indicate reporting/update recency. Do not state that
an incident itself occurred within the last 24 hours unless the event text
supports that conclusion.
"""


CATEGORIES = {
    "Terrorist Financing": [
        '"terrorist financing"',
        '"terror financing"',
        '"financing terrorism"',
        '"terrorist funding"',
        '"terror finance network"',
        '"terrorist fundraising"',
        '"terrorist crowdfunding"',
        '"terrorist donations"',
        '"terrorist cryptocurrency"',
        '"terrorism cryptocurrency"',
        '"terrorist crypto financing"',
        '"terrorist crypto fundraising"',
        '"terrorist bitcoin"',
        '"terrorist money laundering"',
        '"terror financing money laundering"',
        '"terrorist financial network"',
        '"terrorist financial facilitator"',
        '"terrorist assets frozen"',
        '"terrorist assets seized"',
        '"terror financing sanctions"',
        '"terrorism financing sanctions"',
        '"terrorist bank accounts"',
        '"terrorist hawala"',
        '"extremist financing" terrorism',
    ],

    "Weapons": [
        '"terrorist weapons"',
        '"terrorist arms"',
        '"terrorist firearms"',
        '"weapons smuggling" terrorism',
        '"arms trafficking" terrorism',
        '"weapons trafficking" terrorism',
        '"terrorist explosives"',
        '"terrorist bomb making"',
        '"terrorist bomb-making"',
        '"terrorist explosive device"',
        '"terrorist IED"',
        '"terrorist drone"',
        '"terrorist drones"',
        '"terrorist weaponized drone"',
        '"terrorist weaponised drone"',
        '"terrorist drone attack"',
        '"terrorist rocket"',
        '"terrorist missiles"',
        '"terrorist ammunition"',
        '"terrorist weapons cache"',
        '"terrorist arms cache"',
        '"terrorist 3D printed weapon"',
        '"terrorist 3D-printed weapon"',
    ],

    "CBRN": [
        '"chemical terrorism"',
        '"biological terrorism"',
        '"radiological terrorism"',
        '"nuclear terrorism"',
        '"CBRN terrorism"',
        '"CBRN terrorist"',
        '"chemical terrorist attack"',
        '"biological terrorist attack"',
        '"radiological terrorist attack"',
        '"nuclear terrorist attack"',
        '"terrorist chemical weapon"',
        '"terrorist biological weapon"',
        '"terrorist radiological weapon"',
        '"terrorist nuclear material"',
        '"terrorist radioactive material"',
        '"terrorist poison"',
        '"terrorist toxic chemical"',
        '"terrorist ricin"',
        '"terrorist sarin"',
        '"terrorist chlorine attack"',
        '"terrorist dirty bomb"',
        '"extremist chemical weapon"',
        '"extremist biological weapon"',
    ],

    "Online Radicalization / Cyberterrorism": [
        '"online radicalization" terrorism',
        '"online radicalisation" terrorism',
        '"online extremist radicalization"',
        '"online extremist radicalisation"',
        '"terrorist propaganda" online',
        '"terrorist propaganda" social media',
        '"terrorist recruitment" online',
        '"terrorist recruitment" social media',
        '"terrorist social media"',
        '"terrorist messaging app"',
        '"terrorist encrypted messaging"',
        '"terrorist online network"',
        '"terrorist online forum"',
        '"terrorist online community"',
        '"terrorist livestream"',
        '"terrorist live stream"',
        '"terrorist video platform"',
        '"cyberterrorism"',
        '"cyber terrorism"',
        '"terrorist cyber attack"',
        '"terrorist cyberattack"',
        '"terrorist hacking"',
        '"terrorist hacker"',
        '"extremist propaganda online"',
        '"extremist recruitment online"',
    ],

    "Maritime Piracy": [
        '"maritime piracy"',
        '"pirate attack" ship',
        '"pirate attacks" vessel',
        '"armed robbery at sea"',
        'pirates hijacked vessel',
        'pirates hijacked ship',
        'pirates boarded vessel',
        'pirates kidnapped crew',
        'piracy merchant vessel',
        'piracy tanker',
        'piracy cargo ship',
    ],

    "Attacks": [
        '"terrorist attack"',
        '"terror attacks"',
        '"terror attack"',
        '"terrorist bombing"',
        '"terrorist bomb attack"',
        '"suicide bombing" terrorism',
        '"suicide bomber" terrorism',
        '"IED attack" terrorism',
        '"improvised explosive device" terrorism',
        '"car bomb" terrorism',
        '"vehicle bomb" terrorism',
        '"truck bomb" terrorism',
        '"terrorist shooting"',
        '"terrorist gun attack"',
        '"terrorist stabbing"',
        '"terrorist knife attack"',
        '"terrorist vehicle attack"',
        '"terrorist ramming attack"',
        '"terrorist assassination"',
        '"terrorist ambush"',
        '"terrorist kidnapping"',
        '"terrorist hostage attack"',
        '"terrorist rocket attack"',
        '"terrorist drone attack"',
        '"jihadist attack"',
        '"jihadist bombing"',
        '"extremist terrorist attack"',
    ],

    "Arrests": [
        '"terrorist arrested"',
        '"terrorists arrested"',
        '"terror suspect arrested"',
        '"terror suspects arrested"',
        '"terrorism arrest"',
        '"terrorism arrests"',
        '"terror suspect detained"',
        '"terrorism suspect detained"',
        '"terror suspects detained"',
        '"terrorist detained"',
        '"terror cell arrested"',
        '"terrorist cell arrested"',
        '"terror plot arrests"',
        '"terrorism raid arrests"',
        '"terror suspect captured"',
        '"terrorist captured"',
        '"terrorism investigation arrest"',
        '"jihadist arrested"',
        '"extremist arrested" terrorism',
        '"ISIS suspect arrested"',
        '"ISIL suspect arrested"',
        '"al Qaeda suspect arrested"',
    ],

    "Counter Terrorism Action": [
        '"security forces kill" terrorist',
        '"security forces killed" militants',
        '"troops kill" terrorists',
        '"militants killed in raid"',
        '"terrorists killed in raid"',
        '"terrorist killed in operation"',
        '"militants killed in operation"',
        '"killed in counter-terrorism operation"',
        '"counter-terrorism raid"',
        '"anti-terrorism operation"',
        '"militants killed in gunfight"',
        '"terrorist killed in shootout"',
        '"forces neutralize" terrorist',
        '"forces neutralise" terrorist',
        '"eliminated" terrorist commander',
        '"jihadists killed in raid"',
        '"ISIS commander killed"',
        '"al Qaeda commander killed"',
        '"militant hideout raided"',
        '"terrorist hideout stormed"',
    ],

    "Legal / Judicial": [
        '"terrorism trial"',
        '"terrorist trial"',
        '"terrorist sentenced"',
        '"terrorist sentencing"',
        '"terrorist convicted"',
        '"terrorism conviction"',
        '"terrorism convictions"',
        '"terror suspect charged"',
        '"terrorism suspect charged"',
        '"terrorism charges"',
        '"terrorist charged"',
        '"terrorism prosecution"',
        '"terrorist prosecution"',
        '"terrorism court"',
        '"terrorist court case"',
        '"terrorism guilty"',
        '"terrorist guilty"',
        '"terrorism prison sentence"',
        '"terrorist prison sentence"',
        '"terrorism appeal"',
        '"terrorist appeal"',
        '"terrorism indictment"',
        '"terrorist indictment"',
        '"jihadist sentenced"',
    ],

    "Disinformation / Emerging Technologies / AI": [
        '"terrorist artificial intelligence"',
        '"terrorism artificial intelligence"',
        '"terrorist use of AI"',
        '"terrorists using AI"',
        '"terrorist generative AI"',
        '"extremist generative AI"',
        '"terrorist AI propaganda"',
        '"terrorist AI recruitment"',
        '"terrorist AI content"',
        '"terrorist chatbot"',
        '"terrorist deepfake"',
        '"terrorist deepfakes"',
        '"extremist deepfake"',
        '"terrorist disinformation"',
        '"terrorist misinformation"',
        '"terrorist emerging technology"',
        '"terrorism emerging technology"',
        '"terrorist autonomous weapon"',
        '"terrorist autonomous drone"',
        '"terrorist facial recognition"',
        '"terrorist 3D printing"',
        '"terrorist virtual reality"',
        '"terrorist metaverse"',
        '"terrorist synthetic media"',
        '"terrorist voice cloning"',
        '"extremist artificial intelligence"',
    ],
}


# ============================================================
# COMPACT CORE SEARCH BANK
#
# These are discovery queries, not the taxonomy itself.
# Articles are still locally tested against the full category relevance
# rules. Six strong searches per category provide broad recall without
# issuing hundreds of near-duplicate Google News requests.
# ============================================================

CORE_SEARCH_QUERIES = {

    "Terrorist Financing": [
        '"terrorist financing"',
        '"terrorist funding"',
        '"terrorist cryptocurrency"',
        '"terrorist sanctions"',
        '"terrorist money laundering"',
        '"terrorist fundraising"',
    ],

    "Weapons": [
        '"terrorist weapons"',
        '"terrorist explosives"',
        '"terrorist drone"',
        '"weapons trafficking" terrorism',
        '"terrorist IED"',
        '"terrorist weapons cache"',
    ],

    "CBRN": [
        '"chemical terrorism"',
        '"biological terrorism"',
        '"radiological terrorism"',
        '"nuclear terrorism"',
        '"dirty bomb" terrorism',
        '"CBRN" terrorism',
    ],

    "Online Radicalization / Cyberterrorism": [
        '"online radicalization" terrorism',
        '"terrorist propaganda" online',
        '"terrorist recruitment" online',
        '"terrorist encrypted messaging"',
        '"cyberterrorism"',
        '"terrorist hacking"',
    ],

    "Maritime Piracy": [
        '"maritime piracy"',
        '"armed robbery at sea"',
        '"pirate attack" ship',
        'pirates hijacked vessel',
        'pirates boarded vessel',
        'pirates kidnapped crew',
    ],

    "Attacks": [
        '"terrorist attack"',
        '"terrorist bombing"',
        '"suicide bombing" terrorism',
        '"jihadist attack"',
        '"ISIS attack"',
        '"terrorist shooting"',
    ],

    "Arrests": [
        '"terror suspect arrested"',
        '"terrorism arrests"',
        '"ISIS suspect arrested"',
        '"terrorist cell arrested"',
        '"jihadist arrested"',
        '"terrorism raid" arrests',
    ],

    "Counter Terrorism Action": [
        '"militants killed in raid"',
        '"terrorists killed in operation"',
        '"counter-terrorism raid"',
        '"security forces kill" terrorist',
        '"militants killed in gunfight"',
        '"terrorist hideout stormed"',
    ],

    "Legal / Judicial": [
        '"terrorism trial"',
        '"terrorist sentenced"',
        '"terrorist convicted"',
        '"terror suspect charged"',
        '"terrorism indictment"',
        '"terrorism prosecution"',
    ],

    "Disinformation / Emerging Technologies / AI": [
        '"terrorist artificial intelligence"',
        '"terrorist deepfake"',
        '"terrorist disinformation"',
        '"terrorism emerging technology"',
        '"terrorist autonomous drone"',
        '"terrorist synthetic media"',
    ],
}


# ============================================================
# OFFICIAL / PRIMARY CT SOURCES
#
# These are deliberately queried through the SAME Google News
# RSS mechanism as the rest of the collector.  No API keys or
# credentials are required.
#
# The site: restriction gives us a second acquisition channel
# focused on authoritative primary reporting:
#   - U.S. Department of Justice
#   - U.S. Treasury / OFAC
#   - Europol
#   - UK Government / Counter-Terrorism
#   - INTERPOL English News
#
# Results still pass through the normal CT relevance filter and
# the intelligent event deduplication layer, so the same incident
# is not duplicated simply because an official source and media
# outlets both reported it.
# ============================================================

OFFICIAL_SOURCE_QUERIES = {

    "Terrorist Financing": [

        'site:home.treasury.gov/news/press-releases '
        '(terrorist OR terrorism OR ISIS OR ISIL OR Hamas OR Hizballah OR Hezbollah OR al-Qaeda) '
        '(sanctions OR designation OR designated OR financing OR financial OR facilitator OR network)',

        'site:justice.gov '
        '(terrorist OR terrorism OR ISIS OR ISIL OR Hamas OR Hizballah OR Hezbollah OR al-Qaeda) '
        '("material support" OR financing OR funding OR money laundering OR cryptocurrency)',

        'site:interpol.int/en/News-and-Events/News '
        '("terrorism financing" OR "terrorist financing")',

    ],


    "Weapons": [

        'site:europol.europa.eu/media-press/newsroom '
        '(terrorism OR terrorist OR extremist) '
        '(weapons OR firearms OR explosives OR bomb OR drone)',

        'site:justice.gov '
        '(terrorist OR terrorism OR ISIS OR extremist) '
        '(weapon OR weapons OR firearms OR explosives OR bomb OR drone)',

        'site:interpol.int/en/News-and-Events/News '
        '(terrorism OR terrorist) '
        '(weapons OR firearms OR explosives)',

    ],


    "CBRN": [

        'site:gov.uk/government/news '
        '(terrorism OR terrorist OR extremism) '
        '(chemical OR biological OR radiological OR nuclear OR CBRN)',

        'site:counterterrorism.police.uk/news '
        '(terrorism OR terrorist OR extremist) '
        '(chemical OR biological OR radiological OR nuclear OR CBRN)',

        'site:justice.gov '
        '(terrorism OR terrorist OR extremist) '
        '(chemical OR biological OR radiological OR nuclear OR CBRN)',

    ],


    "Online Radicalization / Cyberterrorism": [

        'site:europol.europa.eu/media-press/newsroom '
        '(terrorism OR terrorist OR extremist OR Terrorgram) '
        '(online OR propaganda OR radicalisation OR radicalization OR platform OR cyber)',

        'site:gov.uk/government/news '
        '(terrorism OR terrorist OR extremism OR extremist) '
        '(online OR radicalisation OR radicalization OR propaganda OR AI)',

        'site:counterterrorism.police.uk/news '
        '(terrorism OR terrorist OR extremist) '
        '(online OR radicalised OR radicalized OR propaganda OR social-media)',

        'site:interpol.int/en/News-and-Events/News '
        '(terrorism OR terrorist) '
        '(online OR social-media OR cyber OR technology)',

    ],


    "Attacks": [

        'site:justice.gov '
        '(terrorist OR terrorism OR ISIS OR ISIL OR al-Qaeda) '
        '(attack OR attacks OR plot OR bombing OR shooting OR stabbing)',

        'site:gov.uk/government/news '
        '(terrorism OR terrorist) '
        '(attack OR plot OR bombing OR shooting OR stabbing)',

        'site:counterterrorism.police.uk/news '
        '(terrorism OR terrorist) '
        '(attack OR plot OR bombing OR shooting OR stabbing)',

        'site:interpol.int/en/News-and-Events/News '
        '(terrorism OR terrorist) '
        '(attack OR attacks OR operation)',

    ],


    "Arrests": [

        'site:justice.gov '
        '(terrorist OR terrorism OR ISIS OR ISIL OR Hamas OR al-Qaeda) '
        '(arrested OR arrests OR detained OR captured)',

        'site:europol.europa.eu/media-press/newsroom '
        '(terrorism OR terrorist OR extremist) '
        '(arrested OR arrests OR detained OR operation)',

        'site:gov.uk/government/news '
        '(terrorism OR terrorist) '
        '(arrested OR arrest OR detained OR charged)',

        'site:counterterrorism.police.uk/news '
        '(terrorism OR terrorist OR extremist) '
        '(arrested OR arrest OR detained OR charged)',

        'site:interpol.int/en/News-and-Events/News '
        '(terrorism OR terrorist) '
        '(arrest OR arrests OR apprehended)',

    ],


    "Counter Terrorism Action": [

        'site:justice.gov '
        '(terrorist OR terrorism OR ISIS OR ISIL OR al-Qaeda) '
        '(raid OR operation OR neutralized OR neutralised OR killed)',

        'site:gov.uk/government/news '
        '(terrorism OR terrorist) '
        '(raid OR operation OR neutralised OR eliminated)',

        'site:counterterrorism.police.uk/news '
        '(terrorism OR terrorist) '
        '(raid OR operation OR neutralised OR eliminated)',

        'site:interpol.int/en/News-and-Events/News '
        '(terrorism OR terrorist) '
        '(raid OR operation OR neutralized)',

    ],


    "Legal / Judicial": [

        'site:justice.gov '
        '(terrorist OR terrorism OR ISIS OR ISIL OR Hamas OR al-Qaeda) '
        '(charged OR convicted OR sentenced OR indicted OR indictment OR trial)',

        'site:europol.europa.eu/media-press/newsroom '
        '(terrorism OR terrorist OR extremist) '
        '(convicted OR sentenced OR court OR prosecution OR trial)',

        'site:gov.uk/government/news '
        '(terrorism OR terrorist) '
        '(charged OR convicted OR sentenced OR prosecution OR trial)',

        'site:counterterrorism.police.uk/news '
        '(terrorism OR terrorist OR extremist) '
        '(charged OR convicted OR sentenced OR jailed OR trial)',

    ],


    "Disinformation / Emerging Technologies / AI": [

        'site:europol.europa.eu/media-press/newsroom '
        '(terrorism OR terrorist OR extremist) '
        '("artificial intelligence" OR AI OR deepfake OR cyber OR technology)',

        'site:gov.uk/government/news '
        '(terrorism OR terrorist OR extremism OR extremist) '
        '("artificial intelligence" OR AI OR online OR technology)',

        'site:interpol.int/en/News-and-Events/News '
        '(terrorism OR terrorist) '
        '("artificial intelligence" OR AI OR technology OR emerging)',

    ],

}


# ============================================================
# TARGETED INTERNATIONAL / SPECIALIST SOURCES
#
# Each source is queried through Google News RSS using site:
# restrictions, so the workflow needs no additional API keys.
#
# ACLED public reporting is discovered through Google News, without its API.
#
# Source targeting improves recall.  Every returned article still
# has to pass the same CT relevance filter and the same intelligent
# event-level deduplication used for all other records.
# ============================================================

TARGETED_SOURCE_SITES = [
    {"name": "ACLED", "site": "acleddata.com", "priority": 118,
     "kind": "specialist_analysis"},

    # International wire / mainstream
    {
        "name": "Reuters",
        "site": "reuters.com",
        "priority": 105,
        "kind": "international_media",
    },
    {
        "name": "Associated Press",
        "site": "apnews.com",
        "priority": 100,
        "kind": "international_media",
    },
    {
        "name": "BBC News",
        "site": "bbc.com",
        "priority": 96,
        "kind": "international_media",
    },
    {
        "name": "CNN",
        "site": "cnn.com",
        "priority": 86,
        "kind": "international_media",
    },
    {
        "name": "France 24 English",
        "site": "france24.com/en",
        "priority": 90,
        "kind": "international_media",
    },
    {
        "name": "Deutsche Welle English",
        "site": "dw.com",
        "priority": 90,
        "kind": "international_media",
    },
    {
        "name": "Al Jazeera English",
        "site": "aljazeera.com",
        "priority": 90,
        "kind": "international_media",
    },
    {
        "name": "i24NEWS",
        "site": "i24news.tv/en",
        "priority": 80,
        "kind": "regional_international_media",
    },
    {
        "name": "RT",
        "site": "rt.com/news",
        "priority": 55,
        "kind": "state_affiliated_media",
    },

    # Additional useful English-language coverage
    {
        "name": "RFI English",
        "site": "rfi.fr/en",
        "priority": 86,
        "kind": "international_media",
    },
    {
        "name": "Voice of America",
        "site": "voanews.com",
        "priority": 80,
        "kind": "international_media",
    },
    {
        "name": "Radio Free Europe / Radio Liberty",
        "site": "rferl.org",
        "priority": 82,
        "kind": "regional_international_media",
    },
    {
        "name": "Sky News",
        "site": "news.sky.com",
        "priority": 80,
        "kind": "international_media",
    },
    {
        "name": "Euronews English",
        "site": "euronews.com",
        "priority": 76,
        "kind": "international_media",
    },
    {
        "name": "The Guardian",
        "site": "theguardian.com",
        "priority": 78,
        "kind": "international_media",
    },

]



# Specialist acquisition uses topic-specific terms instead of requiring a
# terrorism keyword in every headline. Category hints are provisional: Gemini
# determines actual event relevance and final categories. No direct API or
# restricted incident database access is implied by these public-news targets.
MARITIME_SOURCE_TERMS = (
    '(piracy OR pirate OR pirates OR hijacked OR hijacking OR "armed robbery" '
    'OR "crew kidnapped" OR "crew abducted" OR "vessel boarded" '
    'OR "ship boarded" OR "boarding incident" OR "attempted boarding")'
)
CBRN_SOURCE_TERMS = (
    '(CBRN OR CBRNE OR bioterrorism OR "chemical weapon" OR "chemical weapons" '
    'OR "biological weapon" OR "biological weapons" OR ricin OR sarin '
    'OR "dirty bomb" OR "radiological terrorism" OR "nuclear terrorism" '
    'OR "radioactive material" OR "nuclear material" OR "anthrax attack") '
    '(attack OR plot OR threat OR arrest OR seized OR seizure OR trafficking '
    'OR smuggling OR stolen OR investigation OR prosecution OR convicted)'
)

MARITIME_SOURCE_SITES = [
    ("IMB / ICC Commercial Crime Services", "icc-ccs.org", "maritime_reporting_body"),
    ("ReCAAP ISC", "recaap.org", "maritime_reporting_body"),
    ("UKMTO", "ukmto.org", "official_maritime_source"),
    ("IMO", "imo.org", "intergovernmental_source"),
    ("EUNAVFOR Atalanta", "eunavfor.eu", "official_maritime_source"),
    ("Combined Maritime Forces", "combinedmaritimeforces.com", "official_maritime_source"),
    ("The Maritime Executive", "maritime-executive.com", "specialist_media"),
    ("gCaptain", "gcaptain.com", "specialist_media"),
    ("SAFETY4SEA", "safety4sea.com", "specialist_media"),
    ("Splash 247", "splash247.com", "specialist_media"),
    ("TradeWinds", "tradewindsnews.com", "specialist_media"),
    ("Seatrade Maritime", "seatrade-maritime.com", "specialist_media"),
    ("Dryad Global / Verihelm", "dryadglobal.com", "commercial_risk_analysis"),
    ("MarineLink", "marinelink.com", "specialist_media"),
]
CBRN_SOURCE_SITES = [
    ("OPCW", "opcw.org", "intergovernmental_source"),
    ("IAEA public reporting", "iaea.org", "intergovernmental_source"),
    ("FBI CBRN reporting", "fbi.gov", "official_law_enforcement"),
    ("DOJ CBRN reporting", "justice.gov", "official_law_enforcement"),
    ("INTERPOL CBRN reporting", "interpol.int", "official_law_enforcement"),
    ("Europol CBRN reporting", "europol.europa.eu", "official_law_enforcement"),
    ("UK Government CBRN reporting", "gov.uk", "official_government"),
    ("CBRNe World", "cbrneworld.com", "specialist_media"),
    ("Nuclear Threat Initiative", "nti.org", "specialist_research"),
    ("Arms Control Association", "armscontrol.org", "specialist_research"),
    ("James Martin CNS", "nonproliferation.org", "specialist_research"),
    ("Johns Hopkins Center for Health Security", "centerforhealthsecurity.org", "specialist_research"),
]
for _category, _terms, _sources in (
    ("Maritime Piracy", MARITIME_SOURCE_TERMS, MARITIME_SOURCE_SITES),
    ("CBRN", CBRN_SOURCE_TERMS, CBRN_SOURCE_SITES),
):
    for _name, _site, _kind in _sources:
        TARGETED_SOURCE_SITES.append({
            "name": _name, "site": _site, "kind": _kind,
            "priority": 85, "query_terms": [_terms],
            "category_hint": _category,
        })


# Compact category-specific query components used with each site.
# Keeping these narrower than the broad query bank limits noise and
# makes the targeted-source pass operationally manageable.
TARGETED_MEDIA_CATEGORY_TERMS = {

    "Terrorist Financing":
        '(terrorist OR terrorism OR ISIS OR ISIL OR Daesh OR "Islamic State" '
        'OR "al-Qaeda" OR Hamas OR Hezbollah OR extremist) '
        '(financing OR funding OR sanctions OR assets OR cryptocurrency '
        'OR money-laundering OR fundraising OR donations)',

    "Weapons":
        '(terrorist OR terrorism OR ISIS OR ISIL OR Daesh OR "Islamic State" '
        'OR "al-Qaeda" OR extremist) '
        '(weapons OR firearms OR explosives OR bomb OR IED OR drone '
        'OR arms-trafficking OR weapons-cache)',

    "CBRN":
        '(terrorist OR terrorism OR extremist OR ISIS OR ISIL) '
        '(CBRN OR chemical OR biological OR radiological OR nuclear '
        'OR radioactive OR ricin OR sarin OR chlorine OR "dirty bomb")',

    "Online Radicalization / Cyberterrorism":
        '(terrorist OR terrorism OR extremist OR extremism OR ISIS OR ISIL '
        'OR "Islamic State" OR "al-Qaeda") '
        '(online OR propaganda OR recruitment OR radicalization '
        'OR radicalisation OR cyber OR hacking OR Telegram OR encrypted '
        'OR social-media)',

    "Maritime Piracy":
        '("maritime piracy" OR piracy OR pirates OR "armed robbery at sea") '
        '(ship OR vessel OR tanker OR crew OR maritime OR hijacked OR boarded)',

    "Attacks":
        '(terrorist OR terrorism OR ISIS OR ISIL OR Daesh OR "Islamic State" '
        'OR jihadist OR extremist OR "al-Qaeda" OR "al-Shabaab" '
        'OR "Boko Haram") '
        '(attack OR bombing OR blast OR shooting OR stabbing OR ambush '
        'OR kidnapping OR hostage OR IED OR "suicide bomber" OR drone)',

    "Arrests":
        '(terrorist OR terrorism OR ISIS OR ISIL OR Daesh OR "Islamic State" '
        'OR jihadist OR extremist OR "al-Qaeda") '
        '(arrest OR arrested OR arrests OR detained OR captured OR raid '
        'OR suspects OR cell)',

    "Counter Terrorism Action":
        '(terrorist OR terrorism OR ISIS OR ISIL OR Daesh OR "Islamic State" '
        'OR jihadist OR extremist OR "al-Qaeda" OR militant OR militants) '
        '(raid OR operation OR neutralized OR neutralised OR eliminated '
        'OR gunfight OR shootout OR "special forces")',

    "Legal / Judicial":
        '(terrorist OR terrorism OR ISIS OR ISIL OR Daesh OR "Islamic State" '
        'OR jihadist OR extremist OR "al-Qaeda") '
        '(charged OR convicted OR sentenced OR trial OR court OR indicted '
        'OR indictment OR prosecution OR jailed)',

    "Disinformation / Emerging Technologies / AI":
        '(terrorist OR terrorism OR extremist OR extremism OR ISIS OR ISIL '
        'OR "Islamic State" OR "al-Qaeda") '
        '("artificial intelligence" OR AI OR deepfake OR disinformation '
        'OR misinformation OR autonomous OR technology OR "synthetic media" '
        'OR "voice cloning")',

}


def targeted_source_query(
    source,
    category
):
    terms = TARGETED_MEDIA_CATEGORY_TERMS[
        category
    ]

    return (
        "site:"
        +
        source[
            "site"
        ]
        +
        " "
        +
        terms
    )



# ============================================================
# THROTTLE-SAFE SOURCE DISCOVERY
#
# Official sources: one broad CT query per domain.
# Targeted media: one query per source, with a second theme only for
# high-volume sources. Results are classified locally into the 8 categories.
# ============================================================

OFFICIAL_BROAD_QUERIES = [
    {
        "name": "U.S. Department of Justice",
        "query": 'site:justice.gov (terrorism OR terrorist OR ISIS OR ISIL OR "material support")',
    },
    {
        "name": "U.S. Treasury / OFAC",
        "query": 'site:home.treasury.gov (terrorism OR terrorist OR ISIS OR Hamas OR Hezbollah OR "al-Qaeda")',
    },
    {
        "name": "Europol",
        "query": 'site:europol.europa.eu (terrorism OR terrorist OR extremist)',
    },
    {
        "name": "Counter Terrorism Policing UK",
        "query": 'site:counterterrorism.police.uk (terrorism OR terrorist OR extremist)',
    },
    {
        "name": "GOV.UK",
        "query": 'site:gov.uk/government/news (terrorism OR terrorist OR extremism)',
    },
    {
        "name": "INTERPOL",
        "query": 'site:interpol.int/en/News-and-Events/News (terrorism OR terrorist OR "foreign terrorist fighters")',
    },
]

SOURCE_QUERY_THEME_PRIMARY = (
    '(terrorism OR terrorist OR ISIS OR ISIL OR Daesh OR "Islamic State" '
    'OR "al-Qaeda" OR "maritime piracy" OR "armed robbery at sea" OR pirates)'
)

SOURCE_QUERY_THEME_SECONDARY = (
    '(extremist OR jihadist OR "al-Shabaab" OR "Boko Haram" OR Taliban '
    'OR Hamas OR Hezbollah)'
)

DEEP_SCAN_SOURCES = {
    "ACLED",
    "Reuters",
    "Associated Press",
    "BBC News",
    "CNN",
    "France 24 English",
    "Deutsche Welle English",
    "Al Jazeera English",
    "i24NEWS",
}


def targeted_source_queries(source):
    if source.get("query_terms"):
        return [f"site:{source['site']} {terms}" for terms in source["query_terms"]]
    queries = [
        (
            "site:"
            +
            source["site"]
            +
            " "
            +
            SOURCE_QUERY_THEME_PRIMARY
        )
    ]

    if source["name"] in DEEP_SCAN_SOURCES:
        queries.append(
            "site:"
            +
            source["site"]
            +
            " "
            +
            SOURCE_QUERY_THEME_SECONDARY
        )

    return queries


# ============================================================
# MULTILINGUAL CT DISCOVERY
#
# Google News is queried in local-language editions. These records are NOT
# rejected by the English keyword filter: Gemini is the semantic final judge.
# Every retained record is normalized to English before final deduplication.
# ============================================================

MULTILINGUAL_PROFILES = [
    {
        "code": "fr", "name": "French", "hl": "fr", "gl": "FR", "ceid": "FR:fr",
        "queries": [
            {"term": '(terrorisme OR terroriste OR djihadiste OR attentat OR Daech)', "category": "Attacks"},
            {"term": '(\"financement du terrorisme\" OR radicalisation OR propagande djihadiste OR cyberterrorisme OR arrestation terroriste)', "category": "Terrorist Financing"},
        ],
        "sites": ["lemonde.fr", "france24.com/fr"],
        "site_terms": '(terrorisme OR terroriste OR djihadiste OR Daech OR attentat)',
    },
    {
        "code": "ar", "name": "Arabic", "hl": "ar", "gl": "SA", "ceid": "SA:ar",
        "queries": [
            {"term": '(إرهاب OR إرهابي OR داعش OR القاعدة OR جهادي OR هجوم إرهابي)', "category": "Attacks"},
            {"term": '(تمويل الإرهاب OR اعتقال إرهابي OR تطرف OR تجنيد إرهابي OR دعاية إرهابية)', "category": "Terrorist Financing"},
        ],
        "sites": ["aljazeera.net", "alarabiya.net"],
        "site_terms": '(إرهاب OR إرهابي OR داعش OR القاعدة OR جهادي)',
    },
    {
        "code": "de", "name": "German", "hl": "de", "gl": "DE", "ceid": "DE:de",
        "queries": [
            {"term": '(Terrorismus OR Terrorist OR Dschihadist OR Anschlag OR IS-Terror)', "category": "Attacks"},
            {"term": '(Terrorfinanzierung OR Terrorverdächtiger OR Radikalisierung OR Cyberterrorismus OR Festnahme)', "category": "Arrests"},
        ],
        "sites": ["tagesschau.de", "spiegel.de"],
        "site_terms": '(Terrorismus OR Terrorist OR Dschihadist OR Anschlag)',
    },
    {
        "code": "es", "name": "Spanish", "hl": "es", "gl": "ES", "ceid": "ES:es",
        "queries": [
            {"term": '(terrorismo OR terrorista OR yihadista OR atentado OR Estado Islámico)', "category": "Attacks"},
            {"term": '(financiación del terrorismo OR radicalización OR detenido terrorismo OR propaganda yihadista)', "category": "Terrorist Financing"},
        ],
        "sites": ["elpais.com", "elmundo.es"],
        "site_terms": '(terrorismo OR terrorista OR yihadista OR atentado)',
    },
    {
        "code": "it", "name": "Italian", "hl": "it", "gl": "IT", "ceid": "IT:it",
        "queries": [
            {"term": '(terrorismo OR terrorista OR jihadista OR attentato OR Stato Islamico)', "category": "Attacks"},
            {"term": '(finanziamento terrorismo OR radicalizzazione OR arrestato terrorismo OR propaganda jihadista)', "category": "Arrests"},
        ],
        "sites": ["ansa.it", "repubblica.it"],
        "site_terms": '(terrorismo OR terrorista OR jihadista OR attentato)',
    },
    {
        "code": "tr", "name": "Turkish", "hl": "tr", "gl": "TR", "ceid": "TR:tr",
        "queries": [
            {"term": '(terör OR terörist OR DEAŞ OR IŞİD OR terör saldırısı)', "category": "Attacks"},
            {"term": '(terör finansmanı OR terör operasyonu OR terör şüphelisi OR radikalleşme OR terör propagandası)', "category": "Arrests"},
        ],
        "sites": ["aa.com.tr/tr", "trthaber.com"],
        "site_terms": '(terör OR terörist OR DEAŞ OR IŞİD)',
    },
    {
        "code": "ru", "name": "Russian", "hl": "ru", "gl": "RU", "ceid": "RU:ru",
        "queries": [
            {"term": '(терроризм OR террорист OR теракт OR ИГИЛ OR джихадист)', "category": "Attacks"},
            {"term": '(финансирование терроризма OR задержан террорист OR радикализация OR террористическая пропаганда)', "category": "Arrests"},
        ],
        "sites": ["interfax.ru", "kommersant.ru"],
        "site_terms": '(терроризм OR террорист OR теракт OR ИГИЛ)',
    },
    {
        "code": "ur", "name": "Urdu", "hl": "ur", "gl": "PK", "ceid": "PK:ur",
        "queries": [
            {"term": '(دہشت گردی OR دہشت گرد OR داعش OR القاعدہ OR دہشت گرد حملہ)', "category": "Attacks"},
            {"term": '(دہشت گردی کی مالی معاونت OR دہشت گرد گرفتار OR شدت پسندی OR دہشت گرد پروپیگنڈا)', "category": "Terrorist Financing"},
        ],
        "sites": ["jang.com.pk", "express.pk"],
        "site_terms": '(دہشت گردی OR دہشت گرد OR داعش OR القاعدہ)',
    },
    {
        "code": "fa", "name": "Persian", "hl": "fa", "gl": "IR", "ceid": "IR:fa",
        "queries": [
            {"term": '(تروریسم OR تروریست OR داعش OR القاعده OR حمله تروریستی)', "category": "Attacks"},
            {"term": '(تامین مالی تروریسم OR بازداشت تروریست OR افراط گرایی OR تبلیغات تروریستی)', "category": "Terrorist Financing"},
        ],
        "sites": ["iranintl.com", "bbc.com/persian"],
        "site_terms": '(تروریسم OR تروریست OR داعش OR القاعده)',
    },
    {
        "code": "he", "name": "Hebrew", "hl": "he", "gl": "IL", "ceid": "IL:he",
        "queries": [
            {"term": '(טרור OR מחבל OR פיגוע OR דאעש OR אל-קאעדה)', "category": "Attacks"},
            {"term": '(מימון טרור OR נעצר חשוד בטרור OR הקצנה OR תעמולת טרור)', "category": "Terrorist Financing"},
        ],
        "sites": ["ynet.co.il", "haaretz.co.il"],
        "site_terms": '(טרור OR מחבל OR פיגוע OR דאעש)',
    },
]



# Regional source expansion. Domains are discovery targets, not guaranteed feeds.
# Google News indexing varies; no result from a site does not mean no incidents.
# Group names are retrieval hints only: Gemini must assess each actual event.
ARABIC_CT_TERMS = (
    '(إرهاب OR إرهابي OR إرهابيين OR داعش OR القاعدة OR تفجير OR تفجيرات '
    'OR "خلية إرهابية" OR "بوكو حرام" OR "حركة الشباب" '
    'OR "جماعة نصرة الإسلام والمسلمين" OR "تنظيم الدولة")'
)
AFRICA_FR_CT_TERMS = (
    '(terrorisme OR terroriste OR terroristes OR djihadiste OR djihadistes '
    'OR jihadistes OR attentat OR JNIM OR GSIM OR EIGS OR ISSP OR ISWAP '
    'OR "Boko Haram" OR shebab OR shabaab OR "État islamique" '
    'OR "groupe armé" OR "groupes armés" OR embuscade)'
)
AFRICA_EN_CT_TERMS = (
    '(terrorism OR terrorist OR terrorists OR insurgents OR jihadist '
    'OR "Boko Haram" OR ISWAP OR JNIM OR ISSP OR "al-Qaeda" '
    'OR "al-Shabaab" OR "Al Shabab" OR "Islamic State" OR ADF '
    'OR Ansaru OR Lakurawa OR "Cabo Delgado")'
)

# 26 Arabic-language targets: regional outlets, local reporting and agencies.
ARABIC_SOURCE_SITES = [
    "aljazeera.net", "alarabiya.net", "skynewsarabia.com", "asharq.com",
    "aawsat.com", "alquds.co.uk", "alaraby.co.uk", "france24.com/ar",
    "bbc.com/arabic", "aa.com.tr/ar", "independentarabia.com",
    "alhurra.com", "alsumaria.tv", "shafaq.com/ar", "ina.iq",
    "rudawarabia.net", "enabbaladi.net", "syria.tv", "sana.sy",
    "almasdaronline.com", "sabanew.net", "alwasat.ly", "alraimedia.com",
    "hespress.com", "mosaiquefm.net/ar", "akhbaralaane.net",
]

# Sahel / Lake Chad plus Central Africa. French local reporting matters here.
AFRICA_FR_SOURCE_SITES = [
    "studiotamani.org", "studiokalangou.org", "studioyafa.bf",
    "maliweb.net", "malijet.com", "aib.media", "lefaso.net",
    "burkina24.com", "actuniger.com", "anp.ne", "tchadinfos.com",
    "alwihdainfo.com", "crtv.cm", "actucameroun.com", "radiookapi.net",
    "actualite.cd", "rfi.fr/fr", "jeuneafrique.com", "sahel-intelligence.com",
]

AFRICA_EN_SOURCE_SITES = [
    "humanglemedia.com", "dailytrust.com", "premiumtimesng.com",
    "channelstv.com", "punchng.com", "vanguardngr.com", "thecable.ng",
    "leadership.ng", "zagazola.org", "shabellemedia.com", "hiiraan.com",
    "garoweonline.com/en", "goobjoog.com", "sonna.so/en", "nation.africa",
    "standardmedia.co.ke", "the-star.co.ke", "theeastafrican.co.ke",
    "monitor.co.ug", "clubofmozambique.com",
]

for _profile in MULTILINGUAL_PROFILES:
    if _profile["code"] == "ar":
        _profile["sites"] = ARABIC_SOURCE_SITES
        _profile["site_terms"] = ARABIC_CT_TERMS
        _profile["queries"].extend([
            {"term": '("بوكو حرام" OR "ولاية غرب أفريقيا" OR "ولاية غرب إفريقيا" OR "إيسواب")', "category": "Attacks"},
            {"term": '("جماعة نصرة الإسلام والمسلمين" OR "داعش الساحل" OR "ولاية الساحل" OR "أنصار الإسلام")', "category": "Attacks"},
            {"term": '("حركة الشباب" OR "الشباب الصومالية" OR "داعش الصومال")', "category": "Attacks"},
            {"term": '("خلية إرهابية" OR "خلايا داعش" OR "عبوة ناسفة" OR "تمويل الإرهاب") (العراق OR سوريا OR اليمن OR ليبيا)', "category": "Arrests"},
        ])

MULTILINGUAL_PROFILES.extend([
    {
        "code": "fr", "name": "French / Africa", "hl": "fr", "gl": "FR", "ceid": "FR:fr",
        "sites": AFRICA_FR_SOURCE_SITES, "site_terms": AFRICA_FR_CT_TERMS,
        "queries": [
            {"term": '(JNIM OR GSIM OR EIGS OR ISSP OR "État islamique" OR djihadistes) (Mali OR Niger OR Burkina OR Sahel)', "category": "Attacks"},
            {"term": '("Boko Haram" OR ISWAP) (Nigeria OR Niger OR Tchad OR Cameroun)', "category": "Attacks"},
            {"term": '(terroristes OR djihadistes OR "groupe armé") (Bénin OR Togo OR "Côte d’Ivoire")', "category": "Attacks"},
            {"term": '(ADF OR "Forces démocratiques alliées" OR shebab OR "Cabo Delgado") (attaque OR arrestation OR attentat)', "category": "Attacks"},
        ],
    },
    {
        "code": "en", "name": "English / Africa", "hl": "en-NG", "gl": "NG", "ceid": "NG:en",
        "sites": AFRICA_EN_SOURCE_SITES, "site_terms": AFRICA_EN_CT_TERMS,
        "queries": [
            {"term": '("Boko Haram" OR ISWAP OR Ansaru OR Lakurawa) (attack OR arrest OR ambush OR raid OR financing)', "category": "Attacks"},
            {"term": '(JNIM OR ISSP OR "Islamic State Sahel") (Mali OR Niger OR Burkina OR Benin OR Togo)', "category": "Attacks"},
        ],
    },
    {
        "code": "en", "name": "English / East Africa", "hl": "en-KE", "gl": "KE", "ceid": "KE:en",
        "sites": [], "site_terms": AFRICA_EN_CT_TERMS,
        "queries": [
            {"term": '("al-Shabaab" OR "Al Shabab" OR "Islamic State Somalia") (attack OR raid OR arrest OR bombing OR financing)', "category": "Attacks"},
            {"term": '(ADF OR "Allied Democratic Forces" OR "Islamic State" OR insurgents) (Uganda OR Congo OR Mozambique OR "Cabo Delgado")', "category": "Attacks"},
        ],
    },
])



# Topic discovery also covers regional reporting outside the specialist list.
for _profile in MULTILINGUAL_PROFILES:
    if _profile["name"] == "Arabic":
        _profile["queries"].extend([
            {"term": '("قرصنة بحرية" OR "قراصنة البحر" OR "اختطاف سفينة" OR "اختطاف ناقلة" OR "سطو مسلح") (سفينة OR سفن OR بحري OR طاقم)', "category": "Maritime Piracy"},
            {"term": '("أسلحة كيميائية" OR "أسلحة بيولوجية" OR "مواد مشعة" OR "قنبلة قذرة" OR ريسين OR سارين) (إرهاب OR داعش OR هجوم OR اعتقال OR تهريب OR ضبط)', "category": "CBRN"},
        ])
    elif _profile["name"] == "French":
        _profile["queries"].extend([
            {"term": '("piraterie maritime" OR "navire détourné" OR "marins enlevés" OR "brigandage maritime" OR "vol à main armée") (navire OR mer OR équipage)', "category": "Maritime Piracy"},
            {"term": '(NRBC OR NRBC-E OR "arme chimique" OR "armes chimiques" OR "arme biologique" OR "matières radioactives" OR ricine OR sarin) (terrorisme OR attentat OR arrestation OR trafic OR saisie OR enquête)', "category": "CBRN"},
        ])
    elif _profile["name"] == "English / Africa":
        _profile["queries"].extend([
            {"term": '(piracy OR pirates OR "crew kidnapped" OR "vessel hijacked") ("Gulf of Guinea" OR Somalia OR "Gulf of Aden" OR "Indian Ocean")', "category": "Maritime Piracy"},
            {"term": '("armed robbery" OR piracy OR "vessel boarded") ("Singapore Strait" OR Malacca OR Sulu OR Celebes)', "category": "Maritime Piracy"},
            {"term": CBRN_SOURCE_TERMS, "category": "CBRN"},
        ])



# Afghan/Syrian local and country-focused media, including exile-based outlets.
# Distinct publishers are counted once even when searched in several languages.
AFGHANISTAN_LOCAL_SOURCES = {
    "tolonews.com": "TOLOnews", "pajhwok.com": "Pajhwok Afghan News",
    "amu.tv": "Amu TV", "8am.media": "Hasht-e Subh / 8AM",
    "kabulnow.com": "KabulNow", "etilaatroz.com": "Etilaat Roz",
    "khaama.com": "Khaama Press", "ariananews.af": "Ariana News",
    "afintl.com": "Afghanistan International", "swn.af": "Salam Watandar",
}
SYRIA_LOCAL_SOURCES = {
    "enabbaladi.net": "Enab Baladi", "syria.tv": "Syria TV",
    "sana.sy": "SANA", "npasyria.com": "North Press Agency",
    "deirezzor24.net": "Deir Ezzor 24", "daraa24.org": "Daraa 24",
    "syriahr.com": "Syrian Observatory for Human Rights",
    "zamanalwsl.net": "Zaman al-Wasl", "rozana.fm": "Rozana",
    "syrianobserver.com": "The Syrian Observer",
    "syriadirect.org": "Syria Direct", "sy-24.com": "SY24",
}
AFGHAN_DARI_TERMS = (
    '(داعش OR "داعش خراسان" OR القاعده OR تروریسم OR تروریستی '
    'OR انفجار OR انتحاری OR "حمله مسلحانه" OR "حمله انتحاری")'
)
AFGHAN_PASHTO_TERMS = (
    '(داعش OR "داعش خراسان" OR القاعده OR چاودنه OR چاودنې '
    'OR "ځانمرګی برید" OR "ځانمرګي برید" OR "وسله وال برید" OR ترهګري)'
)
AFGHAN_ENGLISH_TERMS = (
    '("ISIS-K" OR ISKP OR "Islamic State Khorasan" OR "al-Qaeda" '
    'OR bombing OR "suicide attack" OR "terror plot" OR "terrorist cell")'
)
SYRIAN_ARABIC_TERMS = (
    '(داعش OR "تنظيم الدولة" OR "خلايا التنظيم" OR "خلية إرهابية" '
    'OR "خلايا نائمة" OR "عبوة ناسفة" OR "هجوم مسلح" OR اغتيال '
    'OR تفجير OR انتحاري OR "مكافحة الإرهاب")'
)

MULTILINGUAL_PROFILES.extend([
    {
        "code": "fa", "name": "Dari / Afghanistan",
        # Native query text controls retrieval language. Use a supported English
        # edition rather than inventing an Afghan Google News edition.
        "hl": "en-US", "gl": "US", "ceid": "US:en",
        "sites": [site for site in AFGHANISTAN_LOCAL_SOURCES if site != "kabulnow.com"],
        "site_terms": AFGHAN_DARI_TERMS,
        "queries": [
            {"term": '("داعش خراسان" OR "شاخه خراسان") (حمله OR بازداشت OR انفجار OR تمویل)', "category": "Attacks"},
            {"term": '(القاعده OR "شبکه حقانی") (افغانستان OR کابل OR ننگرهار) (حمله OR بازداشت OR تروریسم)', "category": "Arrests"},
        ],
    },
    {
        "code": "ps", "name": "Pashto / Afghanistan",
        "hl": "en-US", "gl": "US", "ceid": "US:en",
        "sites": ["tolonews.com", "pajhwok.com", "ariananews.af", "afintl.com", "swn.af"],
        "site_terms": AFGHAN_PASHTO_TERMS,
        "queries": [
            {"term": '(داعش OR القاعده) (افغانستان OR کابل OR ننګرهار OR کندهار) (برید OR چاودنه OR نیول)', "category": "Attacks"},
        ],
    },
    {
        "code": "en", "name": "English / Afghanistan",
        "hl": "en-US", "gl": "US", "ceid": "US:en",
        "sites": ["tolonews.com", "pajhwok.com", "amu.tv", "8am.media", "kabulnow.com", "khaama.com", "ariananews.af"],
        "site_terms": AFGHAN_ENGLISH_TERMS,
        "queries": [
            {"term": '("ISIS-K" OR ISKP OR "Islamic State Khorasan") (Afghanistan OR Kabul OR Nangarhar OR Kandahar) (attack OR arrest OR financing OR recruitment)', "category": "Attacks"},
        ],
    },
    {
        "code": "ar", "name": "Arabic / Syria",
        "hl": "ar", "gl": "SA", "ceid": "SA:ar",
        "sites": [site for site in SYRIA_LOCAL_SOURCES if site != "syrianobserver.com"],
        "site_terms": SYRIAN_ARABIC_TERMS,
        "queries": [
            {"term": '(داعش OR "خلايا نائمة" OR "تنظيم الدولة") ("دير الزور" OR الرقة OR الحسكة OR البادية)', "category": "Attacks"},
            {"term": '("خلية إرهابية" OR "عبوة ناسفة" OR "هجوم انتحاري") (درعا OR السويداء OR دمشق OR إدلب OR حلب)', "category": "Attacks"},
        ],
    },
    {
        "code": "en", "name": "English / Syria",
        "hl": "en-US", "gl": "US", "ceid": "US:en",
        "sites": ["syrianobserver.com", "syriadirect.org", "npasyria.com", "syriahr.com"],
        "site_terms": '(ISIS OR ISIL OR "Islamic State" OR "terrorist cell" OR "sleeper cell" OR "suicide bombing")',
        "queries": [],
    },
])



# Run only the publisher additions from this expansion:
# python collector.py backfill-new-sources
# Equivalent: python collector.py backfill --scope regional-additions
# Existing daily and ordinary incremental-backfill commands keep their scope.
COLLECTION_SCOPE = "all"
REGIONAL_BACKFILL_PROFILE_NAMES = {
    "Arabic", "French / Africa", "English / Africa",
    "Dari / Afghanistan", "Pashto / Afghanistan", "English / Afghanistan",
    "Arabic / Syria", "English / Syria",
}


def regional_backfill_profiles():
    profiles = []
    seen = set()
    for profile in MULTILINGUAL_PROFILES:
        if profile["name"] not in REGIONAL_BACKFILL_PROFILE_NAMES:
            continue
        sites = []
        for site in profile.get("sites", []):
            # These two Arabic publishers predate the source expansion.
            if profile["name"] == "Arabic" and site in {"aljazeera.net", "alarabiya.net"}:
                continue
            identity = (site, profile["code"], profile["ceid"], profile["site_terms"])
            if identity not in seen:
                seen.add(identity)
                sites.append(site)
        if sites:
            # Only site-restricted requests; broad discovery could query old sources.
            profiles.append(dict(profile, sites=sites, queries=[]))
    return profiles


def planned_collection_query_count():
    if COLLECTION_SCOPE == "regional-additions":
        return sum(len(profile["sites"]) for profile in regional_backfill_profiles())
    return (sum(len(v) for v in CORE_SEARCH_QUERIES.values())
            + len(OFFICIAL_BROAD_QUERIES)
            + sum(len(targeted_source_queries(source)) for source in TARGETED_SOURCE_SITES)
            + multilingual_query_count())


def parse_collection_mode(argv=None):
    parser = argparse.ArgumentParser(description="Incremental CT news collector")
    parser.add_argument("mode", nargs="?", default="daily",
                        choices=["daily", "backfill", "backfill-new-sources"])
    parser.add_argument("--scope", choices=["all", "regional-additions"], default=None)
    args = parser.parse_args(argv)
    scope = args.scope or "all"
    if args.mode == "backfill-new-sources":
        if args.scope == "all":
            parser.error("backfill-new-sources cannot use --scope all")
        scope = "regional-additions"
    if args.mode == "daily" and scope != "all":
        parser.error("regional-additions scope requires a backfill mode")
    return args.mode != "daily", scope


def multilingual_query_count():
    return sum(
        len(profile.get("queries", []))
        + len(profile.get("sites", []))
        for profile in MULTILINGUAL_PROFILES
    )


SOURCE_PRIORITY = {
    "U.S. Department of Justice": 130,
    "US Department of Justice": 130,
    "Department of Justice": 130,
    "Justice Department": 130,
    "U.S. Department of the Treasury": 128,
    "US Department of the Treasury": 128,
    "Department of the Treasury": 128,
    "U.S. Treasury": 128,
    "Counter Terrorism Policing": 127,
    "Europol": 126,
    "GOV.UK": 124,
    "UK Government": 124,
    "Home Office": 124,
    "INTERPOL": 122,
    "ACLED": 118,
    "Reuters": 105,
    "Associated Press": 100,
    "AP News": 100,
    "BBC": 96,
    "BBC News": 96,
    "France 24": 90,
    "France24": 90,
    "Deutsche Welle": 90,
    "DW": 90,
    "Al Jazeera": 90,
    "Al Jazeera English": 90,
    "CNN": 86,
    "RFI": 86,
    "Radio France Internationale": 86,
    "Radio Free Europe": 82,
    "Radio Free Europe/Radio Liberty": 82,
    "RFE/RL": 82,
    "Voice of America": 80,
    "VOA": 80,
    "i24NEWS": 80,
    "i24 News": 80,
    "Sky News": 80,
    "The Guardian": 78,
    "Euronews": 76,
    "RT": 55,
    "Russia Today": 55,
    "ABC News": 66,
    "NBC News": 65,
    "CBS News": 65,
}


STOPWORDS = {
    "the","a","an","and","or","of","to","in","on","at","for","from",
    "with","after","over","into","as","by","is","are","was","were","be",
    "this","that","these","those","says","say","said","new","latest",
    "report","reports","update","updates",
}


CT_ANCHORS = {
    "terror","terrorism","terrorist","terrorists",
    "extremist","extremists","extremism",
    "jihadist","jihadists","jihadism",
    "isis","isil","daesh",
    "al-qaeda","al qaeda","alqaeda",
    "al-shabaab","al shabaab",
    "boko haram","islamic state",
    "hezbollah","hizballah","hizbollah",
    "hamas","taliban",
}


CATEGORY_RELEVANCE = {
    "Terrorist Financing": {
        "finance","financing","funding","fundraising","money","bank","account",
        "asset","assets","sanction","sanctions","crypto","cryptocurrency",
        "bitcoin","hawala","donation","donations","crowdfunding","laundering",
        "financial",
    },

    "Weapons": {
        "weapon","weapons","arms","firearm","firearms","gun","rifle",
        "ammunition","explosive","explosives","bomb","ied","drone","drones",
        "rocket","missile","smuggling","trafficking","cache",
    },

    "CBRN": {
        "chemical","biological","radiological","radioactive","nuclear","cbrn",
        "toxic","poison","ricin","sarin","chlorine","dirty bomb","pathogen",
    },

    "Online Radicalization / Cyberterrorism": {
        "online","internet","social media","telegram","platform","messaging",
        "encrypted","propaganda","recruitment","radicalization","radicalisation",
        "cyber","cyberattack","cyber attack","hacking","hacker","livestream",
        "forum",
    },

    "Maritime Piracy": {
        "maritime piracy","piracy","pirate","pirates","armed robbery at sea",
        "ship","ships","vessel","vessels","tanker","crew","seafarer",
        "maritime","hijack","hijacked","boarded",
    },

    "Attacks": {
        "attack","attacks","attacked","bomb","bombing","blast","explosion",
        "shooting","stabbing","ramming","assassination","ambush","kidnapping",
        "hostage","ied","suicide bomber","suicide bombing","rocket","drone",
        "killed","wounded",
    },

    "Arrests": {
        "arrest","arrested","arrests","detained","detention","captured",
        "raid","raided","suspect","suspects","cell","investigation",
    },

    "Counter Terrorism Action": {
        "raid","raided","operation","neutralized","neutralised","eliminated",
        "gunfight","firefight","clash","clashed","shootout","cordon","stormed",
        "commando","special forces","killed","wounded","captured",
    },

    "Legal / Judicial": {
        "trial","court","charged","charges","convicted","conviction","sentenced",
        "sentence","prosecution","prosecutor","indicted","indictment","guilty",
        "prison","appeal",
    },

    "Disinformation / Emerging Technologies / AI": {
        "artificial intelligence","generative ai","deepfake","deepfakes",
        "chatbot","machine learning","synthetic media","voice cloning",
        "disinformation","misinformation","emerging technology","autonomous",
        "facial recognition","3d printing","virtual reality","metaverse",
    },
}


# Articles that mention terrorism historically/politically but are not
# current CT events should be rejected unless stronger event evidence exists.
NON_EVENT_PATTERNS = [
    r"\banniversary\b",
    r"\bcommemorat(?:e|es|ed|ing|ion)\b",
    r"\bmark(?:s|ed|ing)?\s+\d+(?:st|nd|rd|th)?\s+anniversary\b",
    r"\b9/11 memorial\b",
    r"\b9/11 anniversary\b",
    r"\bremember(?:s|ed|ing)?\s+9/11\b",
    r"\btribute\b",
    r"\bretrospective\b",
    r"\bhistory of\b",
    r"\bdocumentary\b",
    r"\bbook review\b",
    r"\bopinion\b",
    r"\bcommentary\b",
]


ACTION_TERMS = {
    "Terrorist Financing": {
        "arrested","charged","convicted","sentenced","sanctioned","frozen",
        "seized","blocked","funded","financed","raised","transferred",
        "laundered","investigation","prosecution",
    },
    "Weapons": {
        "seized","found","recovered","smuggled","trafficked","arrested",
        "charged","used","attack","plot","cache",
    },
    "CBRN": {
        "seized","found","plot","attack","arrested","charged","used",
        "attempted","threatened","investigation",
    },
    "Online Radicalization / Cyberterrorism": {
        "arrested","charged","convicted","recruited","radicalized","radicalised",
        "propaganda","attack","campaign","network","disrupted","removed",
    },
    "Maritime Piracy": {
        "attack","attacked","hijack","hijacked","boarded","seized",
        "kidnapped","abducted","robbed","hostage","rescued","intercepted",
    },
    "Attacks": {
        "attack","attacked","bombing","blast","explosion","shooting","stabbing",
        "ramming","ambush","kidnapping","killed","wounded","hostage",
    },
    "Arrests": {
        "arrest","arrested","detained","captured","raid","raided","seized",
    },
    "Counter Terrorism Action": {
        "raided","killed","eliminated","neutralized","neutralised","captured",
        "stormed","clashed","operation",
    },
    "Legal / Judicial": {
        "trial","charged","convicted","sentenced","indicted","guilty",
        "prosecution","appeal","court",
    },
    "Disinformation / Emerging Technologies / AI": {
        "used","using","generated","created","deployed","propaganda",
        "recruitment","deepfake","campaign","investigation","arrested",
    },
}


# ============================================================
# MERGED DIGITAL TAXONOMY
# ============================================================

DIGITAL_CATEGORY = "Online / Cyber / AI"
LEGACY_DIGITAL_CATEGORIES = (
    "Online Radicalization / Cyberterrorism",
    "Disinformation / Emerging Technologies / AI",
)


def _merge_taxonomy_values(first, second):
    if isinstance(first, list) and isinstance(second, list):
        return list(dict.fromkeys(first + second))

    if isinstance(first, set) and isinstance(second, set):
        return set(first) | set(second)

    if isinstance(first, str) and isinstance(second, str):
        return f"{first} {second}"

    if isinstance(first, dict) and isinstance(second, dict):
        merged = dict(first)
        merged.update(second)
        return merged

    return second if second is not None else first


def _merge_digital_taxonomy(mapping):
    first = mapping.get(LEGACY_DIGITAL_CATEGORIES[0])
    second = mapping.get(LEGACY_DIGITAL_CATEGORIES[1])

    if first is None and second is None:
        return

    if first is None:
        merged = second
    elif second is None:
        merged = first
    else:
        merged = _merge_taxonomy_values(first, second)

    mapping[DIGITAL_CATEGORY] = merged

    for legacy in LEGACY_DIGITAL_CATEGORIES:
        mapping.pop(legacy, None)


for _taxonomy_mapping in (
    CATEGORIES,
    CORE_SEARCH_QUERIES,
    OFFICIAL_SOURCE_QUERIES,
    TARGETED_MEDIA_CATEGORY_TERMS,
    CATEGORY_RELEVANCE,
    ACTION_TERMS,
):
    _merge_digital_taxonomy(_taxonomy_mapping)


def normalize_category_name(category):
    value = clean_text(category)

    if value in LEGACY_DIGITAL_CATEGORIES:
        return DIGITAL_CATEGORY

    return value


def normalize_categories(categories):
    normalized = []

    for category in categories or []:
        category = normalize_category_name(category)

        if (
            category
            and
            category not in normalized
        ):
            normalized.append(category)

    return normalized


session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0 CT-Intelligence-Map/3.0"
})


def clean_text(text):
    if not text:
        return ""

    text = html.unescape(text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def normalize_title(title):
    title = clean_text(title).lower()
    title = re.sub(r"[^a-z0-9\s]", " ", title)

    words = [
        word
        for word in title.split()
        if word not in STOPWORDS
    ]

    return " ".join(words)


def normalize_relevance_text(text):
    return " " + clean_text(text).lower() + " "


def contains_term(text, term):
    term = term.lower().strip()

    if " " in term:
        return term in text

    pattern = (
        r"(?<![a-z0-9])"
        + re.escape(term)
        + r"(?![a-z0-9])"
    )

    return bool(
        re.search(pattern, text)
    )


def has_non_event_pattern(text):
    return any(
        re.search(pattern, text)
        for pattern in NON_EVENT_PATTERNS
    )



# Conservative, offline scope guard. It also applies to legacy cached decisions
# and stored English-normalized events, without invalidating every AI cache.
_SCOPE_NONSTATE = re.compile(
    r"\b(?:isis(?:-k)?|isil|daesh|islamic state|al[- ]qa(?:e|i)da|al[- ]shab(?:a|aa)b|"
    r"boko haram|iswap|jnim|hamas|hezbollah|houthi\w*|pjak|pkk|ttp|"
    r"terror(?:ist)? cells?|terror(?:ist)? networks?|terrorist organi[sz]ations?|"
    r"terrorist groups?|terrorists|terror modules?|militants?|insurgents?|militias?|jihad(?:ist|i)s?|"
    r"extremists?|gunmen|assailants?|bandits?|settlers?|armed civilians?|"
    r"terrorist financing|terrorist propaganda|terrorist hideout|terrorist leaders?|"
    r"terrorist plan|terrorist in|jihad|red notice|indictment|perpetrators?|"
    r"man|woman|individuals?|terrorism financing|bomb attack|anarch\w*|ipob|mordisco|"
    r"suspects?|defendants?|suspected|charged|convicted|sentenced|indicted|"
    r"bomb plots?|bombings?|stabbing|shooting|attacker|sailors held|crew held|"
    r"lone[- ](?:actor|wolf)|pirates?|piracy|hijack\w*|kidnap\w*|"
    r"terror(?:ist)? attack plots?|terror(?:ist)? attacks?)\b|"
    r"داعش|القاعدة|بوكو حرام|حزب الله|حماس|الحوثي|خلية إرهابية|قراصنة|قرصنة|"
    r"\b(?:cellule terroriste|groupe armé|milice|piraterie)\b", re.I)
_SCOPE_STATE = re.compile(
    r"\b(?:iran\w*|tehran|united states|u\.?s\.?|american\w*|washington|"
    r"israel\w*|russia\w*|ukrain\w*|china|chinese|pakistan\w*|india\w*|"
    r"irgc|revolutionary guards?|mossad|idf|army|navy|air force|military|"
    r"bahrain\w*|kuwait\w*|qatar\w*|emirat\w*|uae|saudi\w*)\b|"
    r"إيران|إسرائيل|الولايات المتحدة|روسيا|أوكرانيا|الحرس الثوري|"
    r"\b(?:états.unis|armée|iranien\w*|israélien\w*)\b", re.I)
_SCOPE_WAR = re.compile(
    r"\b(?:war|strikes?|raids?|bomb\w*|missile\w*|drones?|retaliat\w*|"
    r"attack\w*|targets?|targeting|intercept\w*|offensive|military operation|"
    r"tanker.for.tanker|seiz\w*|chemical weapons|nuclear programme?|"
    r"nuclear program|cyberwar|cyber threat|rocket launchers?)\b|"
    r"\b(?:guerre|frappes?|bombard\w*|représailles)\b|"
    r"غارات|قصف|حرب|صواريخ|ضربات|استهداف", re.I)
_SCOPE_DIPLOMACY = re.compile(
    r"\b(?:diploma\w*|summit|foreign.policy|condemn\w*|ceasefire talks|"
    r"peace talks|nuclear talks|memorandum of understanding|mou expired|"
    r"sanctions?|warns?|threatens?|vows?|appeals? for|calls? for|"
    r"redrawing.{0,30}influence|public duty)\b|"
    r"\b(?:diplomatie|sommet|condamn\w*|négociations)\b|"
    r"دبلوماس|قمة|مفاوضات|إدانة|تنديد", re.I)

def out_of_scope_reason(event):
    title = clean_text(event.get("title") or "")
    summary = clean_text(event.get("summary") or "")
    text = title + " " + summary
    # Concrete Taliban security events in Afghanistan are explicitly exempt.
    afghan = str(event.get("country_code") or "").upper() == "AF" or re.search(
        r"afghan|أفغانستان", text, re.I)
    if afghan and re.search(r"taliban|طالبان", text, re.I) and re.search(
        r"attack|raid|arrest|kill|execut|repress|detain|clash|terror|security operation|اعتقال|قتل|هجوم", title, re.I):
        return ""
    # Condemnation-only headlines are political reactions, not new incidents.
    if re.search(r"^[^:]{0,100}\b(?:condemns?|condemnations?|condamne l.attaque)\b|^(?:يدين|تدين|إدانة)", title, re.I):
        return "diplomatic condemnation rather than a new operational event"
    # A concrete non-state actor in the headline protects operational stories.
    # AI still has to reject incidental/analytical references semantically.
    if _SCOPE_NONSTATE.search(title):
        return ""
    # Preserve a concrete non-state nexus supplied by the summary (e.g. a raid
    # against an unnamed cell), but not a background group name alone.
    if _SCOPE_NONSTATE.search(summary):
        return ""
    if _SCOPE_DIPLOMACY.search(title):
        return "politics/diplomacy without a concrete non-state actor nexus"
    state_mentions = {m.group(0).lower() for m in _SCOPE_STATE.finditer(title)}
    explicit_state_action = re.search(
        r"^(?:iran\w*|russia\w*|ukrain\w*|israel\w*|us|u\.s\.|united states|washington|tehran|idf|irgc)"
        r".{0,45}\b(?:strikes?|attacks?|targets?|responds?|bombs?|raids?|retaliat\w*|seiz\w*)\b", title, re.I)
    if _SCOPE_WAR.search(title) and (len(state_mentions) >= 2 or explicit_state_action):
        return "state military/security activity without a concrete non-state actor nexus"
    return ""


def is_relevant_article(
    category,
    title,
    summary,
):
    if out_of_scope_reason({"title": title, "summary": summary}):
        return False

    combined = normalize_relevance_text(
        title + " " + summary
    )

    title_text = normalize_relevance_text(
        title
    )

    has_anchor = any(
        contains_term(combined, anchor)
        for anchor in CT_ANCHORS
    )

    # Maritime piracy is explicitly in scope even when no terrorism nexus is
    # reported. Require strong maritime-piracy + action evidence instead.
    if category == "Maritime Piracy":
        category_terms = CATEGORY_RELEVANCE.get(category, set())
        action_terms = ACTION_TERMS.get(category, set())
        category_hits = [
            term for term in category_terms if contains_term(combined, term)
        ]
        action_hits = [
            term for term in action_terms if contains_term(combined, term)
        ]
        piracy_anchor = any(
            contains_term(combined, term)
            for term in (
                "maritime piracy", "piracy", "pirate", "pirates",
                "armed robbery at sea"
            )
        )
        maritime_anchor = any(
            contains_term(combined, term)
            for term in (
                "ship", "ships", "vessel", "vessels", "tanker",
                "crew", "seafarer", "maritime", "at sea"
            )
        )
        if not (piracy_anchor and maritime_anchor and action_hits):
            return False
        if has_non_event_pattern(combined):
            return False
        return True

    if not has_anchor:
        return False

    category_terms = CATEGORY_RELEVANCE.get(
        category,
        set(),
    )

    category_hits = [
        term
        for term in category_terms
        if contains_term(combined, term)
    ]

    if not category_hits:
        return False

    action_terms = ACTION_TERMS.get(
        category,
        set(),
    )

    action_hits = [
        term
        for term in action_terms
        if contains_term(combined, term)
    ]

    title_anchor = any(
        contains_term(title_text, anchor)
        for anchor in CT_ANCHORS
    )

    title_category = any(
        contains_term(title_text, term)
        for term in category_terms
    )

    title_action = any(
        contains_term(title_text, term)
        for term in action_terms
    )

    # Reject obvious memorial/history/commentary pieces unless they
    # contain strong current action evidence in the title.
    if has_non_event_pattern(combined):
        if not (
            title_anchor
            and
            title_action
        ):
            return False

    # Best signal: CT anchor + category + event/action in headline.
    if (
        title_anchor
        and
        title_category
        and
        title_action
    ):
        return True

    # Headline has CT anchor, and article body has action evidence.
    if (
        title_anchor
        and
        len(category_hits) >= 1
        and
        len(action_hits) >= 1
    ):
        return True

    # Headline has category/action, CT anchor may only appear in summary.
    if (
        title_category
        and
        title_action
        and
        len(category_hits) >= 2
    ):
        return True

    # Require stronger body evidence when headline is vague.
    if (
        len(category_hits) >= 2
        and
        len(action_hits) >= 2
    ):
        return True

    return False



def classify_article_categories(
    title,
    summary,
):
    """
    Classify one broad-source result locally instead of asking Google News
    once per source x category.

    The full existing relevance rules remain authoritative.
    """
    categories = []

    for category in CATEGORIES.keys():
        if is_relevant_article(
            category,
            title,
            summary,
        ):
            categories.append(
                category
            )

    return categories


def get_source(entry):
    try:
        return clean_text(
            entry.source.get(
                "title",
                "",
            )
        )
    except Exception:
        return ""


def remove_source_suffix(
    title,
    source,
):
    title = clean_text(title)
    source = clean_text(source)

    if source:
        suffix = " - " + source

        if title.endswith(suffix):
            title = title[:-len(suffix)]

    return title.strip()


def parse_date(value):
    if not value:
        return None

    try:
        dt = parsedate_to_datetime(value)

        if dt.tzinfo is None:
            dt = dt.replace(
                tzinfo=timezone.utc
            )

        return dt.astimezone(
            timezone.utc
        )

    except Exception:
        return None


def create_event_id(
    title,
    published,
):
    key = (
        normalize_title(title)
        + "|"
        + str(published)[:10]
    )

    return hashlib.sha256(
        key.encode("utf-8")
    ).hexdigest()[:16]


def source_rank(source):
    if not source:
        return 0

    source_lower = source.lower()

    for name, score in SOURCE_PRIORITY.items():
        if name.lower() in source_lower:
            return score

    return 10


def build_google_url(
    term,
    days,
    language=None,
    country=None,
    edition=None,
):
    query = (
        term
        + f" when:{days}d"
    )

    encoded = quote_plus(query)

    language = language or GOOGLE_LANGUAGE
    country = country or GOOGLE_COUNTRY
    edition = edition or GOOGLE_EDITION

    return (
        f"{GOOGLE_NEWS_BASE}"
        f"?q={encoded}"
        f"&hl={language}"
        f"&gl={country}"
        f"&ceid={edition}"
    )



# Incremental backfill state lives in the two files already used by the workflow:
# events.json: completed historical query manifest (only published after AI).
# ai_article_selection_cache.json: successful RSS snapshots and AI checkpoints.
# The workflow must restore and persist these files, including cache on failure.
BACKFILL_ACTIVE = False
BACKFILL_COMPLETED_QUERIES = {}
BACKFILL_PENDING_QUERIES = {}
BACKFILL_RSS_SNAPSHOTS = {}
BACKFILL_STATS = Counter()
COLLECTION_QUERY_VERSION = "query-coverage-v1"


def atomic_json_write(path, data):
    temporary = str(path) + ".tmp"
    try:
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)


def load_database_strict():
    if not os.path.exists(OUTPUT_FILE):
        return {"events": []}
    try:
        with open(OUTPUT_FILE, encoding="utf-8") as handle:
            data = json.load(handle)
        if not isinstance(data, dict) or not isinstance(data.get("events"), list):
            raise ValueError("invalid events database")
        if any(not isinstance(event, dict) for event in data["events"]):
            raise ValueError("invalid event record")
        return data
    except (OSError, ValueError) as exc:
        raise RuntimeError("Cannot read existing events.json; refusing to replace it.") from exc


def initialize_incremental_state(is_backfill):
    global BACKFILL_ACTIVE, BACKFILL_COMPLETED_QUERIES
    global BACKFILL_PENDING_QUERIES, BACKFILL_RSS_SNAPSHOTS
    BACKFILL_ACTIVE = is_backfill
    BACKFILL_STATS.clear()
    database = load_database_strict()
    manifest = database.get("backfill_completed_queries", {})
    BACKFILL_COMPLETED_QUERIES = manifest if isinstance(manifest, dict) else {}
    BACKFILL_PENDING_QUERIES = {}
    # A valid empty database may still record queries whose results were rejected.
    cache = load_selection_cache()
    snapshots = cache.get("backfill_rss_snapshots", {})
    today = datetime.now(timezone.utc).date().isoformat()
    # Relative Google News windows are only replayable on the same UTC day.
    BACKFILL_RSS_SNAPSHOTS = {
        key: row for key, row in snapshots.items()
        if isinstance(row, dict) and row.get("day") == today
    } if isinstance(snapshots, dict) else {}


def reviewed_article_fingerprints(events):
    fingerprints = set()
    for event in events:
        if not event.get("ai_selection_complete"):
            continue
        fingerprints.update(event.get("source_article_fingerprints", []))
        # Migration for previously translated records, using their original text.
        for article in [event] + list(event.get("related_articles") or []):
            if not isinstance(article, dict) or not article.get("url"):
                continue
            original = dict(article)
            original["title"] = article.get("original_title") or article.get("title", "")
            original["summary"] = article.get("original_summary") or article.get("summary", "")
            fingerprints.add(selection_fingerprint(original))
    return fingerprints


def exclude_reviewed_articles(fresh, existing):
    known = reviewed_article_fingerprints(existing)
    pending = []
    seen = set()
    for event in fresh:
        fingerprint = selection_fingerprint(event)
        if fingerprint in known:
            BACKFILL_STATS["already_reviewed_articles"] += 1
            continue
        if fingerprint in seen:
            BACKFILL_STATS["duplicate_input_articles"] += 1
            continue
        seen.add(fingerprint)
        pending.append(event)
    print(f"Already reviewed unchanged articles skipped before Gemini: "
          f"{BACKFILL_STATS['already_reviewed_articles']}")
    return pending


def request_google_news(url, label="query"):
    if not BACKFILL_ACTIVE:
        return _request_google_news_network(url, label=label)
    now = datetime.now(timezone.utc)
    today = now.date()
    parts = urlsplit(url)
    params = dict(parse_qsl(parts.query))
    query = params.get("q", "")
    match = re.search(r" when:(\d+)d$", query)
    if not match:
        return _request_google_news_network(url, label=label)
    requested_days = int(match.group(1))
    bare_query = query[:match.start()]
    identity = dict(params, q=bare_query, coverage_version=COLLECTION_QUERY_VERSION)
    key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    completed = BACKFILL_COMPLETED_QUERIES.get(key, {})
    days = requested_days
    try:
        checked = datetime.fromisoformat(completed["checked_at"]).date()
        gap = (today - checked).days
        if 0 <= gap < requested_days and completed.get("window_days", 0) >= requested_days:
            # Revisit recent days for delayed indexing; no historical recollection.
            days = min(requested_days, max(DAILY_LOOKBACK_DAYS, gap + 1))
            BACKFILL_STATS["historical_queries_reused"] += 1
    except (KeyError, TypeError, ValueError):
        pass
    if days == requested_days:
        BACKFILL_STATS["historical_queries_requested"] += 1
    params["q"] = f"{bare_query} when:{days}d"
    effective_url = urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(params), parts.fragment))
    snapshot_key = hashlib.sha256(f"{today}|{effective_url}".encode()).hexdigest()
    snapshot = BACKFILL_RSS_SNAPSHOTS.get(snapshot_key)
    response = None
    if snapshot:
        candidate = feedparser.parse(snapshot.get("rss", ""))
        if candidate.get("version") and not candidate.bozo:
            response = requests.Response()
            response.status_code = 200
            response._content = snapshot["rss"].encode("utf-8")
            BACKFILL_STATS["rss_checkpoints_replayed"] += 1
            QUERY_STATS["successful"] += 1
            print(f"      Resuming cached RSS: {label}")
    if response is None:
        response = _request_google_news_network(effective_url, label=label)
        if response is None:
            raise RuntimeError(f"Backfill paused: query failed ({label}); database unchanged, successful RSS checkpoints retained.")
        parsed = feedparser.parse(response.content)
        if parsed.bozo or not parsed.get("version"):
            raise RuntimeError(f"Backfill paused: invalid RSS ({label}); query not marked complete.")
        BACKFILL_RSS_SNAPSHOTS[snapshot_key] = {
            "day": str(today), "rss": response.content.decode("utf-8"),
        }
        # Save each successful query, before moving to the next network request.
        save_selection_cache(load_selection_cache())
    BACKFILL_PENDING_QUERIES[key] = {
        "checked_at": now.isoformat(), "window_days": requested_days,
        "query": bare_query, "locale": params.get("ceid", ""),
    }
    return response


def _request_google_news_network(
    url,
    label="query",
):
    """
    Execute one Google News request with a short retry policy and a global
    circuit breaker for repeated 429/503 responses.

    This prevents hundreds of pointless retry loops when Google is throttling
    the GitHub Actions runner.
    """
    global SERVER_ERROR_STREAK

    for attempt in range(
        1,
        REQUEST_ATTEMPTS + 1,
    ):
        try:
            response = session.get(
                url,
                timeout=30,
            )

            if response.status_code in {
                429,
                503,
            }:
                QUERY_STATS["throttled"] += 1
                SERVER_ERROR_STREAK += 1

                retry_after = response.headers.get(
                    "Retry-After"
                )

                if retry_after:
                    try:
                        delay = min(
                            120,
                            max(
                                5,
                                int(
                                    retry_after
                                )
                            )
                        )
                    except Exception:
                        delay = 10
                else:
                    delay = (
                        8
                        +
                        attempt * 5
                        +
                        random.uniform(
                            0,
                            3
                        )
                    )

                print(
                    f"      Google News returned "
                    f"{response.status_code} "
                    f"({label}) — cooldown "
                    f"{delay:.0f}s"
                )

                if (
                    SERVER_ERROR_STREAK
                    >=
                    SERVER_ERROR_STREAK_LIMIT
                ):
                    print(
                        "      Repeated throttling detected — "
                        f"global cooldown "
                        f"{SERVER_ERROR_COOLDOWN_SECONDS}s"
                    )

                    time.sleep(
                        SERVER_ERROR_COOLDOWN_SECONDS
                    )

                    SERVER_ERROR_STREAK = 0

                else:
                    time.sleep(
                        delay
                    )

                continue

            response.raise_for_status()

            SERVER_ERROR_STREAK = 0
            QUERY_STATS["successful"] += 1

            time.sleep(
                REQUEST_PAUSE_SECONDS
                +
                random.uniform(
                    0,
                    0.25
                )
            )

            return response

        except requests.RequestException as error:
            QUERY_STATS["request_errors"] += 1

            print(
                f"      Request attempt "
                f"{attempt}/"
                f"{REQUEST_ATTEMPTS} failed "
                f"({label}): "
                f"{error}"
            )

            if attempt < REQUEST_ATTEMPTS:
                time.sleep(
                    5
                    +
                    random.uniform(
                        0,
                        2
                    )
                )

    QUERY_STATS["failed"] += 1

    return None


def entry_to_event(
    entry,
    categories,
    acquisition_channel=None,
    targeted_source=None,
    targeted_source_kind=None,
    original_language_hint="en",
    collection_language_name="English",
    collection_locale=None,
):
    article_url = entry.get(
        "link"
    )

    if not article_url:
        return None

    source = get_source(
        entry
    )

    title = remove_source_suffix(
        entry.get(
            "title",
            "",
        ),
        source,
    )

    if not title:
        return None

    summary = clean_text(
        entry.get(
            "summary",
            "",
        )
    )

    published_dt = parse_date(
        entry.get(
            "published",
            "",
        )
    )

    published = (
        published_dt.isoformat()
        if published_dt
        else None
    )

    primary_category = (
        categories[0]
        if categories
        else None
    )

    if not primary_category:
        return None

    event = {
        "id":
            create_event_id(
                title,
                published,
            ),
        "category":
            primary_category,
        "categories":
            categories,
        "title":
            title,
        "summary":
            summary,
        "original_title":
            title,
        "original_summary":
            summary,
        "original_language":
            original_language_hint or "en",
        "collection_language":
            original_language_hint or "en",
        "collection_language_name":
            collection_language_name or "English",
        "collection_locale":
            collection_locale,
        "published":
            published,
        "source":
            source,
        "source_count":
            1,
        "url":
            article_url,
        "collector":
            "Google News RSS",
        "country":
            None,
        "country_code":
            None,
        "city":
            None,
        "region":
            None,
        "latitude":
            None,
        "longitude":
            None,
        "location_precision":
            "unknown",
        "location_confidence":
            "low",
    }

    if acquisition_channel:
        event[
            "acquisition_channel"
        ] = acquisition_channel

    if targeted_source:
        event[
            "targeted_source"
        ] = targeted_source

    if targeted_source_kind:
        event[
            "targeted_source_kind"
        ] = targeted_source_kind

    event["source_article_fingerprints"] = [selection_fingerprint(event)]
    return event


def collect_query(
    category,
    term,
    days,
):
    url = build_google_url(
        term,
        days,
    )

    response = request_google_news(
        url,
        label=category,
    )

    if response is None:
        return []

    feed = feedparser.parse(
        response.content
    )

    results = []
    rejected = 0

    for entry in feed.entries:
        source = get_source(
            entry
        )

        title = remove_source_suffix(
            entry.get(
                "title",
                "",
            ),
            source,
        )

        summary = clean_text(
            entry.get(
                "summary",
                "",
            )
        )

        if not is_relevant_article(
            category,
            title,
            summary,
        ):
            rejected += 1
            continue

        event = entry_to_event(
            entry,
            [category],
        )

        if event:
            results.append(
                event
            )

    if rejected:
        print(
            f"      rejected → "
            f"{rejected}"
        )

    return results


def collect_broad_query(
    term,
    days,
    label,
    acquisition_channel,
    targeted_source=None,
    targeted_source_kind=None,
    category_hint=None,
):
    """
    One broad source query can yield articles for any of the merged CT categories.
    Classification is performed locally, which is the key reduction in
    Google News request volume.
    """
    url = build_google_url(
        term,
        days,
    )

    response = request_google_news(
        url,
        label=label,
    )

    if response is None:
        return []

    feed = feedparser.parse(
        response.content
    )

    results = []
    rejected = 0

    for entry in feed.entries:
        source = get_source(
            entry
        )

        title = remove_source_suffix(
            entry.get(
                "title",
                "",
            ),
            source,
        )

        if not title:
            continue

        summary = clean_text(
            entry.get(
                "summary",
                "",
            )
        )

        categories = classify_article_categories(
            title,
            summary,
        )

        # These tightly scoped specialist searches must reach semantic review
        # even when source terminology fails the general English keyword gate.
        # With AI disabled, keep the original deterministic filtering behavior.
        if AI_SELECTION_ENABLED and category_hint in {"Maritime Piracy", "CBRN"}:
            if category_hint not in categories:
                categories.append(category_hint)

        if not categories:
            rejected += 1
            continue

        event = entry_to_event(
            entry,
            categories,
            acquisition_channel=
                acquisition_channel,
            targeted_source=
                targeted_source,
            targeted_source_kind=
                targeted_source_kind,
        )

        if event:
            results.append(
                event
            )

    if rejected:
        print(
            f"      locally rejected → "
            f"{rejected}"
        )

    return results


# ============================================================
# GDELT DOC 2.0 DISCOVERY (additional source, not a replacement)
#
# This is GDELT's article-SEARCH product (real titles/domains/timestamps),
# not the raw bulk Event Database. The Event Database was evaluated against
# live sample exports and rejected for this purpose: even at the strictest
# possible thresholds (CAMEO root codes 18/19/20, extreme Goldstein score,
# high article counts) the real data was still dominated by unrelated
# stories (DUI arrests, unrelated murder trials, house fires) because GDELT's
# automated CAMEO coding has no access to the article's actual text. DOC 2.0
# gives a real headline, so results still pass through the same local
# classify_article_categories()/is_relevant_article() gate as every other
# broad-source query below -- no separate, lower bar for this source.
#
# GDELT enforces roughly one request every 5 seconds; queries here are
# spaced well above that and run once per CT Atlas category per collection
# run (not once per language), since GDELT has no per-language query mode
# and mixes languages in one response, tagged via each article's own
# reported language field.
# ============================================================

GDELT_DOC_SEARCH_URL = "https://api.gdeltproject.org/api/v2/doc/doc"
GDELT_DOC_RESULTS_PER_QUERY = 75
GDELT_DOC_TERMS_PER_CATEGORY = 5
GDELT_DOC_QUERY_SPACING_SECONDS = 6.0

GDELT_LANGUAGE_NAME_TO_CODE = {
    "english": "en", "french": "fr", "arabic": "ar", "german": "de",
    "spanish": "es", "italian": "it", "turkish": "tr", "russian": "ru",
    "persian": "fa", "dari": "fa", "urdu": "ur", "hebrew": "he", "pashto": "ps",
}
GDELT_LANGUAGE_CODE_TO_NAME = {
    "en": "English", "fr": "French", "ar": "Arabic", "de": "German",
    "es": "Spanish", "it": "Italian", "tr": "Turkish", "ru": "Russian",
    "fa": "Dari / Persian", "ur": "Urdu", "he": "Hebrew", "ps": "Pashto",
}


def gdelt_doc_category_query(category):
    terms = CATEGORIES.get(category, [])[:GDELT_DOC_TERMS_PER_CATEGORY]
    if not terms:
        return ""
    return "(" + " OR ".join(terms) + ")"


def gdelt_doc_url(query, days=None, start_dt=None, end_dt=None):
    params = {
        "query": query,
        "mode": "artlist",
        "format": "json",
        "maxrecords": str(GDELT_DOC_RESULTS_PER_QUERY),
    }
    # An explicit date range (used by the historical backfill to slice 180
    # days into monthly chunks, since maxrecords caps each single query at
    # GDELT_DOC_RESULTS_PER_QUERY regardless of window length) takes priority
    # over the relative "last N days" window the daily collector uses.
    if start_dt and end_dt:
        params["startdatetime"] = start_dt.strftime("%Y%m%d%H%M%S")
        params["enddatetime"] = end_dt.strftime("%Y%m%d%H%M%S")
    else:
        params["timespan"] = f"{min(max(int(days or 1), 1), 365)}d"
    return GDELT_DOC_SEARCH_URL + "?" + urlencode(params)


def fetch_gdelt_doc_articles(query, days=None, start_dt=None, end_dt=None, label="gdelt"):
    url = gdelt_doc_url(query, days=days, start_dt=start_dt, end_dt=end_dt)
    try:
        response = requests.get(
            url,
            headers={"User-Agent": "Mozilla/5.0 CT-Atlas-Collector/1.0"},
            timeout=20,
        )
    except requests.RequestException as exc:
        print(f"   GDELT DOC request failed for {label}: {exc}")
        return []
    if response.status_code != 200:
        print(f"   GDELT DOC HTTP {response.status_code} for {label}")
        return []
    try:
        payload = response.json()
    except ValueError:
        print(f"   GDELT DOC returned non-JSON for {label}")
        return []
    articles = payload.get("articles")
    return articles if isinstance(articles, list) else []


def parse_gdelt_seendate(value):
    digits = re.sub(r"\D", "", str(value or ""))
    if len(digits) < 14:
        return None
    try:
        return datetime.strptime(digits[:14], "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def gdelt_article_to_event(article, categories):
    url = clean_text(article.get("url") or article.get("url_mobile") or "")
    title = clean_text(article.get("title", ""))
    primary_category = categories[0] if categories else None
    if not url or not title or not primary_category:
        return None

    published_dt = parse_gdelt_seendate(article.get("seendate"))
    published = published_dt.isoformat() if published_dt else None
    language_code = GDELT_LANGUAGE_NAME_TO_CODE.get(
        clean_text(article.get("language", "")).lower(), "en"
    )

    event = {
        "id": create_event_id(title, published),
        "category": primary_category,
        "categories": categories,
        "title": title,
        "summary": "",
        "original_title": title,
        "original_summary": "",
        "original_language": language_code,
        "collection_language": language_code,
        "collection_language_name": GDELT_LANGUAGE_CODE_TO_NAME.get(language_code, "English"),
        "collection_locale": None,
        "published": published,
        "source": clean_text(article.get("domain", "")) or "GDELT source",
        "source_count": 1,
        "url": url,
        "collector": "GDELT DOC 2.0",
        "acquisition_channel": "gdelt_doc_search",
        "country": None,
        "country_code": None,
        "city": None,
        "region": None,
        "latitude": None,
        "longitude": None,
        "location_precision": "unknown",
        "location_confidence": "low",
    }
    event["source_article_fingerprints"] = [selection_fingerprint(event)]
    return event


def collect_gdelt_category_query(category, days=None, start_dt=None, end_dt=None):
    # GDELT's own full-text search already confirmed one of this category's
    # exact CT Atlas phrases (the same phrases CATEGORY_RELEVANCE/is_relevant_
    # article look for) appears somewhere in the real article body -- a
    # stronger check than our local classifier can repeat, since artlist mode
    # gives no summary/snippet, only the headline. Re-demanding the full
    # anchor+category+action combination against headline-only text would
    # reject most real matches simply because a headline paraphrases rather
    # than repeats the matched phrase. So GDELT's query category is trusted
    # as the relevance signal; classify_article_categories() only ENRICHES it
    # when the headline itself is clear enough to add or refine categories,
    # and out_of_scope_reason() still screens out state-vs-state war
    # reporting, diplomatic condemnations and similar non-CT-Atlas framing
    # using the same title-based guard every other source is held to.
    query = gdelt_doc_category_query(category)
    if not query:
        return []
    articles = fetch_gdelt_doc_articles(
        query, days=days, start_dt=start_dt, end_dt=end_dt, label=f"gdelt:{category}"
    )
    results = []
    rejected = 0
    for article in articles:
        title = clean_text(article.get("title", ""))
        if not title:
            continue
        if out_of_scope_reason({"title": title, "summary": ""}):
            rejected += 1
            continue
        categories_matched = classify_article_categories(title, "") or [category]
        event = gdelt_article_to_event(article, categories_matched)
        if event:
            results.append(event)
        else:
            rejected += 1
    if rejected:
        print(f"      locally rejected → {rejected}")
    return results


def collect_multilingual_query(
    term,
    days,
    profile,
    category_hint,
    targeted_source=None,
):
    """
    Collect a local-language Google News query without the English lexical
    relevance filter. Query specificity gives us candidates; Gemini later
    decides semantic CT relevance and translates retained events to English.
    """

    url = build_google_url(
        term,
        days,
        language=profile["hl"],
        country=profile["gl"],
        edition=profile["ceid"],
    )

    label = (
        f"{profile['name']}"
        + (
            f" / {targeted_source}"
            if targeted_source
            else ""
        )
    )

    response = request_google_news(
        url,
        label=label,
    )

    if response is None:
        return []

    feed = feedparser.parse(
        response.content
    )

    results = []

    for entry in feed.entries:
        event = entry_to_event(
            entry,
            [category_hint],
            acquisition_channel=(
                "multilingual_targeted_source"
                if targeted_source
                else "multilingual_discovery"
            ),
            targeted_source=targeted_source,
            targeted_source_kind=(
                "local_language_media"
                if targeted_source
                else None
            ),
            original_language_hint=profile["code"],
            collection_language_name=profile["name"],
            collection_locale=profile["ceid"],
        )

        if event:
            results.append(event)

    return results


def collect_multilingual(days, profiles=None):
    profiles = MULTILINGUAL_PROFILES if profiles is None else profiles
    records = []
    language_counts = Counter()

    print()
    print("=" * 70)
    print("MULTILINGUAL CT DISCOVERY")
    print("=" * 70)

    for number, profile in enumerate(
        profiles,
        start=1,
    ):
        print()
        print(
            f"[LANGUAGE {number}/{len(profiles)}] "
            f"{profile['name']} ({profile['code']})"
        )

        subtotal = 0

        for query_number, query in enumerate(
            profile.get("queries", []),
            start=1,
        ):
            print(
                f"   Discovery query {query_number}/"
                f"{len(profile.get('queries', []))}"
            )

            results = collect_multilingual_query(
                query["term"],
                days,
                profile,
                query["category"],
            )

            records.extend(results)
            subtotal += len(results)

            print(
                f"      candidates → {len(results)}"
            )

        for site in profile.get("sites", []):
            query = (
                "site:"
                + site
                + " "
                + profile["site_terms"]
            )

            print(
                f"   Targeted local source: {site}"
            )

            results = collect_multilingual_query(
                query,
                days,
                profile,
                "Attacks",
                targeted_source=site,
            )

            records.extend(results)
            subtotal += len(results)

            print(
                f"      candidates → {len(results)}"
            )

        language_counts[profile["code"]] += subtotal

        print(
            f"   LANGUAGE TOTAL: {subtotal}"
        )

    print()
    print(
        "Multilingual candidate records: "
        f"{len(records)}"
    )

    if language_counts:
        print(
            "By collection language: "
            + ", ".join(
                f"{code}={count}"
                for code, count
                in sorted(language_counts.items())
            )
        )

    return records


def _collect_all_once(days):
    if COLLECTION_SCOPE == "regional-additions":
        if not BACKFILL_ACTIVE:
            raise RuntimeError("Regional-only collection requires incremental backfill mode.")
        profiles = regional_backfill_profiles()
        print(f"TARGETED REGIONAL BACKFILL: {planned_collection_query_count()} publisher/language queries; {days} days")
        print("Sources: Arabic additions, Africa, Afghanistan and Syria only.")
        return collect_multilingual(days, profiles=profiles)
    print()
    print("=" * 70)
    print("INTERPOL CT Intelligence Map")
    print("OSINT Collector V13 — incremental backfill and resumable collection")
    print("=" * 70)
    print(f"Window: {days} days")
    print("Collection languages: English + French + Arabic + German + Spanish + Italian + Turkish + Russian + Urdu + Persian/Dari + Pashto + Hebrew")
    print("Relevance filter: strict event mode")
    print(
        "Acquisition strategy: compact discovery + local source classification"
    )

    records = []

    # ========================================================
    # 1. COMPACT GENERAL DISCOVERY
    # ========================================================

    print()
    print("=" * 70)
    print("CORE CT DISCOVERY")
    print("=" * 70)

    for category_number, (
        category,
        terms,
    ) in enumerate(
        CORE_SEARCH_QUERIES.items(),
        start=1,
    ):
        print()
        print(
            f"[{category_number}/"
            f"{len(CORE_SEARCH_QUERIES)}] "
            f"{category}"
        )

        subtotal = 0

        for query_number, term in enumerate(
            terms,
            start=1,
        ):
            print(
                f"   Query "
                f"{query_number}/"
                f"{len(terms)}"
            )

            results = collect_query(
                category,
                term,
                days,
            )

            records.extend(
                results
            )

            subtotal += len(
                results
            )

            print(
                f"      accepted → "
                f"{len(results)}"
            )

        print(
            f"   CATEGORY TOTAL: "
            f"{subtotal}"
        )

    # ========================================================
    # 2. OFFICIAL / PRIMARY SOURCES
    #    6 broad queries instead of 29 category-specific ones.
    # ========================================================

    print()
    print("=" * 70)
    print("OFFICIAL / PRIMARY CT SOURCES")
    print("=" * 70)

    official_total = 0

    for source in OFFICIAL_BROAD_QUERIES:
        print()
        print(
            f"[OFFICIAL] "
            f"{source['name']}"
        )

        results = collect_broad_query(
            source[
                "query"
            ],
            days,
            label=
                source[
                    "name"
                ],
            acquisition_channel=
                "official_primary_source_query",
            targeted_source=
                source[
                    "name"
                ],
            targeted_source_kind=
                "official_primary_source",
        )

        records.extend(
            results
        )

        official_total += len(
            results
        )

        print(
            f"      accepted → "
            f"{len(results)}"
        )

    # ========================================================
    # 3. TARGETED INTERNATIONAL / SPECIALIST SOURCES
    #    One query per source; selected high-volume sources get
    #    a second complementary query.
    # ========================================================

    print()
    print("=" * 70)
    print("TARGETED INTERNATIONAL / SPECIALIST SOURCES")
    print("=" * 70)

    targeted_total = 0

    for source_number, source in enumerate(
        TARGETED_SOURCE_SITES,
        start=1,
    ):
        print()
        print(
            f"[SOURCE "
            f"{source_number}/"
            f"{len(TARGETED_SOURCE_SITES)}] "
            f"{source['name']}"
        )

        source_total = 0
        source_queries = targeted_source_queries(
            source
        )

        for query_number, query in enumerate(
            source_queries,
            start=1,
        ):
            print(
                f"   Source query "
                f"{query_number}/"
                f"{len(source_queries)}"
            )

            results = collect_broad_query(
                query,
                days,
                label=
                    source[
                        "name"
                    ],
                acquisition_channel=
                    "targeted_source_query",
                targeted_source=
                    source[
                        "name"
                    ],
                targeted_source_kind=
                    source[
                        "kind"
                    ],
                category_hint=source.get("category_hint"),
            )

            records.extend(
                results
            )

            source_total += len(
                results
            )

            targeted_total += len(
                results
            )

            print(
                f"      accepted → "
                f"{len(results)}"
            )

        print(
            f"   SOURCE TOTAL: "
            f"{source_total}"
        )

    # ========================================================
    # 4. GDELT DOC 2.0 DISCOVERY (additional source, not a replacement)
    #    One query per CT Atlas category, spaced to respect GDELT's
    #    ~1 request/5 seconds limit.
    # ========================================================

    print()
    print("=" * 70)
    print("GDELT DOC 2.0 DISCOVERY")
    print("=" * 70)

    gdelt_total = 0
    gdelt_categories = list(CATEGORIES.keys())

    for category_number, category in enumerate(gdelt_categories, start=1):
        print()
        print(
            f"[GDELT {category_number}/{len(gdelt_categories)}] "
            f"{category}"
        )

        results = collect_gdelt_category_query(category, days)

        records.extend(results)
        gdelt_total += len(results)

        print(f"      accepted → {len(results)}")

        if category_number < len(gdelt_categories):
            time.sleep(GDELT_DOC_QUERY_SPACING_SECONDS)

    print()
    print(f"GDELT TOTAL: {gdelt_total}")

    # ========================================================
    # 5. MULTILINGUAL DISCOVERY
    # ========================================================

    multilingual_records = collect_multilingual(
        days
    )

    records.extend(
        multilingual_records
    )

    multilingual_total = len(
        multilingual_records
    )

    print()
    print("=" * 70)
    print("ACQUISITION SUMMARY")
    print("=" * 70)
    print(
        f"Raw accepted records: "
        f"{len(records)}"
    )
    print(
        f"Official-source records: "
        f"{official_total}"
    )
    print(
        f"Targeted-source records: "
        f"{targeted_total}"
    )
    print(
        f"GDELT DOC 2.0 records: "
        f"{gdelt_total}"
    )
    print(
        f"Multilingual records: "
        f"{multilingual_total}"
    )
    print(
        f"Successful Google News requests: "
        f"{QUERY_STATS['successful']}"
    )
    print(
        f"Failed Google News requests: "
        f"{QUERY_STATS['failed']}"
    )
    print(
        f"Throttle responses (429/503): "
        f"{QUERY_STATS['throttled']}"
    )

    total_requests = (
        QUERY_STATS[
            "successful"
        ]
        +
        QUERY_STATS[
            "failed"
        ]
    )

    # Never silently build a backfill from a severely throttled sample.
    # A failed workflow leaves the previous events.json untouched.
    if (
        total_requests >= 10
        and
        QUERY_STATS[
            "failed"
        ]
        /
        total_requests
        >
        0.20
    ):
        raise RuntimeError(
            "Too many Google News queries failed "
            f"({QUERY_STATS['failed']}/{total_requests}). "
            "Database not replaced to avoid an incomplete backfill."
        )

    return records



# ============================================================
# GEMINI AI EVENT SELECTION ENGINE
# ============================================================

AI_SELECTION_SCHEMA = {
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
                    "relevance_score": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 100,
                    },
                    "is_current_ct_event": {
                        "type": "boolean"
                    },
                    "categories": {
                        "type": "array",
                        "items": {
                            "type": "string",
                            "enum": [
                                "Terrorist Financing",
                                "Weapons",
                                "Maritime Piracy",
                                "CBRN",
                                "Online / Cyber / AI",
                                "Attacks",
                                "Counter Terrorism Action",
                                "Arrests",
                                "Legal / Judicial",
                            ],
                        },
                    },
                    "original_language": {
                        "type": "string"
                    },
                    "english_title": {
                        "type": "string"
                    },
                    "english_summary": {
                        "type": "string"
                    },
                    "canonical_event": {
                        "type": "string"
                    },
                    "actor_group": {
                        "type": "string"
                    },
                    "primary_event_type": {
                        "type": "string",
                        "enum": [
                            "ATTACK",
                            "ATTEMPTED_ATTACK",
                            "DISRUPTED_PLOT",
                            "CT_OPERATION",
                            "ARREST",
                            "JUDICIAL",
                            "FINANCING",
                            "WEAPONS",
                            "ONLINE_CYBER_AI",
                            "CBRN",
                            "PIRACY",
                            "OTHER_CT"
                        ]
                    },
                    "is_attack": {
                        "type": "boolean"
                    },
                    "incident_anchor": {
                        "type": "string"
                    },
                    "update_type": {
                        "type": "string",
                        "enum": ["INITIAL", "FOLLOW_UP", "ARREST_UPDATE", "INVESTIGATION_UPDATE", "JUDICIAL_UPDATE", "OTHER_UPDATE"]
                    },
                    "reason": {
                        "type": "string"
                    },
                },
                "required": [
                    "event_id",
                    "relevance_score",
                    "is_current_ct_event",
                    "categories",
                    "original_language",
                    "english_title",
                    "english_summary",
                    "canonical_event",
                    "actor_group",
                    "primary_event_type",
                    "is_attack",
                    "incident_anchor",
                    "update_type",
                    "reason",
                ],
            },
        },
    },
    "required": [
        "results"
    ],
}


AI_SELECTION_INSTRUCTIONS = """
You are the final editorial relevance filter for an operational
counter-terrorism situational-awareness map.

For EVERY candidate event, judge whether it is genuinely useful as a CURRENT
counter-terrorism intelligence event, OR a current maritime-piracy / armed-robbery-at-sea event.

Maritime Piracy is explicitly in scope even when no terrorist nexus is stated.
Exclude ordinary maritime accidents, smuggling, fishing disputes and digital/media
piracy unless the event is actual piracy, pirate attack, vessel hijacking/boarding,
crew kidnapping or armed robbery at sea.

Specialist-source categories are provisional retrieval hints, not evidence.
Country-focused searches and publisher locations do not establish event location.
Afghan and Syrian sources may report on other countries. Extract only locations
supported by the article. Preserve claimed versus confirmed responsibility and
attribute official statements. Do not infer that all Taliban-related governance
news, Syrian armed clashes, assassinations or arrests are terrorist events.
For CBRN, retain concrete CT-relevant attacks, plots, seizures, investigations
and judicial developments. Preserve uncertainty about intent, attribution and
whether the substance or threat has been confirmed. Never infer terrorism just
from a source name, a CBRN keyword or radioactive material being reported stolen.
Exclude routine industrial accidents, natural outbreaks, exercises, conferences,
product announcements and generic preparedness or arms-control commentary.
For maritime reporting, do not relabel every missile/drone attack or suspicious
approach as piracy. Only classify as Maritime Piracy when the reported facts
support piracy, armed robbery against ships, hijacking or related crew abduction.
Relevant terrorist attacks at sea can instead belong to Attacks.
New reports about old incidents must not turn the historical incident into a
new attack; preserve the distinction between a new investigation and its subject.


MANDATORY ACTOR SCOPE (takes precedence over relevance scores):
- Keep concrete security/CT events involving non-state actors: terrorist or
  extremist groups, cells, lone actors, insurgents, armed militias, or pirates.
  State operations AGAINST such actors, their financing, recruitment, weapons,
  investigations and court cases remain eligible. State backing does not by
  itself turn a non-state group into a regular state force.
- Reject wars, strikes, retaliation, naval seizures and cyber operations solely
  between sovereign states or their regular armed forces/security services,
  including IRGC and intelligence agencies acting directly. Calling a state
  or its army "terrorist" does not establish a non-state-actor nexus.
- Reject diplomacy, summits, condemnations, ceasefire negotiations, interstate
  sanctions and political commentary unless the MAIN reported development is
  a concrete operation, plot, investigation or financing measure involving a
  non-state actor. Incidental mentions of ISIS, Hamas or Hezbollah do not count.
- Afghanistan is the ONLY governing-authority exception: concrete Taliban
  security operations, violence, repression or CT developments in Afghanistan
  may be included even when the Taliban act as the governing authority.
  This does NOT include routine Afghan diplomacy, economics or governance,
  and does NOT exempt articles about other countries from Afghan publishers.
- CBRN, weapons and cyber stories need the same concrete non-state-actor nexus;
  interstate nuclear programmes and state-to-state cyberwar are out of scope.
- Maritime Security is the DISPLAY name for the Maritime Piracy category.
  Its scope remains actual piracy/armed robbery at sea, vessel hijacking and
  related crew abduction, rescue, investigation or prosecution. Do not broaden
  it to naval warfare, state tanker seizures, accidents or trade disruption.
Out-of-scope events MUST have is_current_ct_event=false and relevance_score=0.

Score relevance from 0 to 100.

KEEPING POLICY:
- The software keeps every event with score >= 50.
- Therefore do NOT be excessively strict.
- A plausible, operationally useful CT event should normally score at least 50.
- Strong, specific current CT events should score 75-100.

HIGH-SCORING EXAMPLES:
- terrorist attack, attempted attack, disrupted plot;
- arrest, raid, wanted terrorist, terrorist cell;
- prosecution, charge, conviction, sentencing or extradition for terrorism;
- terrorist financing, sanctions, asset seizure, crypto/hawala financing;
- weapons, explosives, drones or CBRN connected to terrorists;
- terrorist propaganda, recruitment, radicalization, cyberterrorism;
- concrete terrorist use of AI, deepfakes or emerging technology;
- operational developments involving named terrorist organisations.

LOW-SCORING / REJECT EXAMPLES:
- generic political commentary mentioning terrorism only incidentally;
- ordinary crime with no meaningful terrorism nexus;
- historical retrospectives, anniversaries or commemorations;
- generic opinion pieces, book reviews or cultural references;
- broad foreign-policy stories where terrorism is not the event;
- an article that merely mentions 9/11, ISIS, Hamas, Taliban, etc. without a
  current CT event;
- unrelated cybercrime, cryptocurrency, sanctions, weapons or AI stories.

IMPORTANT:
- Do not judge relevance based only on keywords.
- Understand the event semantically.
- A named terrorist group can establish CT relevance even if the literal word
  "terrorism" is absent.
- Conversely, the word "terrorism" alone does not make an article relevant.
- Source reputation does not determine relevance.
- Evaluate the EVENT, not the publisher.
- If an event is genuinely relevant but only moderately informative, prefer a
  score just above 50 rather than rejecting it.

The input can be in English, French, Arabic, German, Spanish, Italian, Turkish,
Russian, Urdu, Persian/Dari, Pashto, Hebrew, or another language. Understand the ORIGINAL
LANGUAGE directly; do not penalize an event because it is not written in English.

For every candidate also return:
- original_language: best ISO 639-1 language code when possible;
- english_title: a faithful, concise English headline describing the event;
- english_summary: a faithful English summary in at most two sentences;
- canonical_event: a short language-neutral-in-meaning English description of
  action + main actor/group + place if stated + essential object/target. This is
  used for cross-language deduplication.
- actor_group: the primary named non-state actor, terrorist/militant
  organisation, cell or group responsible for or centrally involved in this
  event, normalized to ONE consistent canonical English name so the SAME group
  is never split into several map-filter values by alias, spelling or
  translation. Use these canonical names whenever the text refers to any of
  their aliases:
  - "ISIS" for ISIS, ISIL, Daesh, Islamic State, Islamic State of Iraq and
    Syria/the Levant -- but keep distinct regional branches under their OWN
    canonical name instead of folding them into plain "ISIS": "ISIS-K" (also
    called ISKP / Islamic State Khorasan), "ISWAP" (Islamic State West Africa
    Province), etc. -- these are operationally separate branches, not spelling
    variants.
  - "Al-Qaeda" for Al-Qaeda, AQ, al-Qaida, al-Qa'ida -- but keep "AQAP"
    (Al-Qaeda in the Arabian Peninsula), "AQIM" (Al-Qaeda in the Islamic
    Maghreb) and "JNIM" as their own separate canonical names.
  - "Hezbollah" for Hezbollah, Hizballah, Hizbollah, Hizbullah.
  - "Boko Haram" for Boko Haram, Jama'atu Ahlis Sunna Lidda'awati wal-Jihad --
    but keep "ISWAP" separate; it split from Boko Haram and is now distinct.
  - "Taliban" for the AFGHAN Taliban only -- keep "TTP" (Tehrik-i-Taliban
    Pakistan / Pakistani Taliban) as its own separate canonical name; despite
    the shared name it is a distinct organisation.
  - "Al-Shabaab" for Al-Shabaab, Al-Shabab, Harakat al-Shabaab al-Mujahideen.
  - "Houthis" for Houthis, Ansar Allah.
  - "PKK" for PKK, Kurdistan Workers' Party -- keep "PJAK" separate.
  - "ADF" for ADF, Allied Democratic Forces.
  - "ISGS" for ISGS, Islamic State Sahel Province, Islamic State in the
    Greater Sahara -- keep separate from plain "ISIS", same reasoning as
    ISIS-K/ISWAP above.
  For any other named group, cell, faction or actor not listed above:
  - decide which single form (the acronym, or the full name) is the one most
    commonly used to refer to this group in English-language open-source
    reporting, and ALWAYS use exactly that one form -- never alternate
    between the acronym and the spelled-out name for the same group across
    different events (e.g. always "JNIM", never spelling out the full name
    once an established acronym exists; conversely use the full name, not an
    obscure acronym, when English reporting overwhelmingly uses the full
    name).
  - use standard, dictionary-style capitalization every time (e.g. always
    "Antifa", never "antifa" or "ANTIFA"; always "Wagner", never "wagner").
    The exact same group must never appear with different capitalization in
    different events.
  - preserve the correct spelling/diacritics of the group's own name exactly
    (e.g. "FETÖ" keeps its Ö; do not silently drop or ASCII-fold accents,
    and do not invent alternate transliterations of the same name).
  If the event involves an unnamed or unidentified individual, cell or group
  with no specific named organisation stated (e.g. "a lone gunman",
  "unidentified militants", "a local criminal network"), or if it is a state
  actor / government operation with no non-state actor named, return an
  empty string rather than guessing.

Do not add facts that are absent from the source material. Translation must preserve
uncertainty, allegations and attribution.

Also return the most appropriate category or categories from the supplied
taxonomy. Multiple categories are allowed. Use "Online / Cyber / AI" for online
radicalization/recruitment/propaganda, cyberterrorism or terrorist cyber activity,
AI/deepfakes/disinformation, and other relevant emerging digital technologies.
Use "Maritime Piracy" for actual piracy, pirate attacks, vessel hijacking/boarding,
crew kidnapping or armed robbery at sea.

"Attacks" vs "Counter Terrorism Action" vs "Arrests" -- these three are easily
confused and must be kept separate:
- "Attacks" is for violence INITIATED BY terrorists/militants/extremists: an
  attack, attempted attack, bombing, shooting, ambush, or a terrorist who
  attacked security forces and was then killed in the ensuing fight. The
  defining feature is who started the violence.
- "Counter Terrorism Action" is for an OFFENSIVE or COMBAT operation BY
  security/military forces AGAINST terrorists: a raid, strike, siege, clearance
  operation, ambush of a terrorist position, or firefight in which militants
  are killed, wounded OR CAPTURED as the result of that operation. A raid that
  ends in a capture still belongs here, not in "Arrests" -- what matters is
  the offensive/combat nature of the operation, not whether the outcome was a
  kill or a capture.
- "Arrests" is for the plain apprehension, detention, indictment or custody of
  a suspect with NO described raid, assault, clash or combat -- e.g. a suspect
  arrested at a checkpoint, at home, or during a routine investigation. If a
  raid or firefight is described, use "Counter Terrorism Action" instead of
  "Arrests" even if an arrest also results from it.
An event can legitimately carry both "Attacks" and "Counter Terrorism Action"
when terrorists attacked first and were then killed/captured by responding
forces. A routine arrest with no combat should carry "Arrests" only, never
"Counter Terrorism Action".

INCIDENT / CASE MODEL (mandatory):
- primary_event_type is mutually exclusive and describes WHAT THE CURRENT
  RECORD ITSELF reports, not the historical event mentioned in background.
- Set is_attack=true ONLY when the current record describes an actual
  terrorist/militant act of violence that occurred. A trial, arrest,
  investigation, anniversary or later update ABOUT an attack is not an attack.
- ATTEMPTED_ATTACK means violence was attempted but the attack did not
  successfully occur; DISRUPTED_PLOT means authorities disrupted a plot before
  an attack attempt.
- CT_OPERATION means an offensive/combat counter-terrorism operation by
  authorities. ARREST is non-combat custody. JUDICIAL is charges, trial,
  conviction, sentencing, appeal or extradition.
- incident_anchor must identify the UNDERLYING real-world incident/case in a
  short stable English form, including the best-supported place and date when
  available. Follow-up reporting about the same case MUST reuse the same
  conceptual anchor rather than describing the new article. Example:
  "Solingen attack Germany 2024-08-23". If the record is an unrelated new
  arrest/case, give it its own anchor.
- update_type=INITIAL for the underlying incident itself; otherwise use the
  appropriate FOLLOW_UP/ARREST_UPDATE/INVESTIGATION_UPDATE/JUDICIAL_UPDATE.
These fields are used to count DISTINCT incidents in country analysis. Never
turn multiple articles or follow-up developments about one case into multiple
attacks.

Keep the reason concise and specific.
"""


# ============================================================
# ACTOR/GROUP CODE-LEVEL CANONICALIZATION
#
# Prompt instructions alone cannot guarantee that two independent Gemini
# calls, days apart, always spell/case the same group identically -- real
# examples found in production: "antifa" vs "Antifa", "ADF" vs "Allied
# Democratic Forces", "FETO" vs "FETÖ", "Jaish-e-Mohammad" vs
# "Jaish-e-Mohammed", "RDK" vs "Russian Volunteer Corps". This is the
# deterministic second line of defense: known aliases are always collapsed
# to one canonical value here, in code, regardless of what the model wrote.
# Extend this table whenever a new alias pair is spotted in the live data --
# see tools/normalize_actor_group.py for the one-off corrective pass applied
# to events already stored before an alias was added here.
# ============================================================

ACTOR_GROUP_ALIASES = {
    "antifa": "Antifa",
    "adf": "ADF",
    "allied democratic forces": "ADF",
    "feto": "FETÖ",
    "fetö": "FETÖ",
    "jaish-e-mohammad": "Jaish-e-Mohammed",
    "jaish-e-mohammed": "Jaish-e-Mohammed",
    "jem": "Jaish-e-Mohammed",
    "azov": "Azov",
    "azov brigade": "Azov",
    "azov regiment": "Azov",
    "764": "764",
    "network 764": "764",
    "rdk": "Russian Volunteer Corps",
    "russian volunteer corps": "Russian Volunteer Corps",
    "islamic state sahel province": "ISGS",
    "isgs": "ISGS",
    "islamic state greater sahara": "ISGS",
}


def canonicalize_actor_group(raw):
    value = clean_text(raw or "")
    if not value:
        return ""
    return ACTOR_GROUP_ALIASES.get(value.lower(), value)


class AISelectionIncompleteError(RuntimeError):
    pass


class AISelectionQuotaError(RuntimeError):
    pass


class AISelectionTransientError(RuntimeError):
    pass




# ============================================================
# LEGACY ACLED METADATA COMPATIBILITY (no API acquisition)
# Preserve identities/coordinates if an older database already contains them.
# No credentials, authentication or ACLED network requests are used.
# ============================================================
ACLED_READ_URL = "https://acleddata.com/api/acled/read"


def merge_acled_metadata(existing, new):
    """Retain ACLED source records and coordinates in mixed news clusters."""
    rows = {str(r["event_id_cnty"]): r for r in existing.get("acled_records", [])}
    for row in new.get("acled_records", []):
        key = str(row["event_id_cnty"])
        old = rows.get(key, {})
        if int(row.get("timestamp") or 0) >= int(old.get("timestamp") or 0):
            rows[key] = row
    if rows:
        existing["acled_records"] = list(rows.values())
    if new.get("geolocation_source") == "ACLED" and len(rows) == 1:
        for key in ("latitude", "longitude", "country", "city", "region",
                    "location_precision", "location_confidence", "geolocation_source"):
            existing[key] = new.get(key)



def collect_all(*args, **kwargs):
    """Retry the entire collection once if Google News broadly fails."""
    attempts = max(1, GOOGLE_NEWS_GLOBAL_RETRY_ATTEMPTS)
    last_error = None
    quality_feedback = ""

    for attempt in range(1, attempts + 1):
        try:
            if attempt > 1:
                print(
                    f"[google-news] Global collection retry "
                    f"{attempt}/{attempts} starting..."
                )
            return _collect_all_once(*args, **kwargs)

        except RuntimeError as exc:
            message = str(exc)
            last_error = exc

            # Retry ONLY the existing broad Google News failure condition.
            if "Too many Google News queries failed" not in message:
                raise

            if attempt >= attempts:
                print(
                    "[google-news] Global retry exhausted. "
                    "Aborting safely; existing database will not be replaced."
                )
                raise

            delay = GOOGLE_NEWS_GLOBAL_RETRY_DELAY_SECONDS
            print(
                f"[google-news] Abnormal Google News failure detected: {message}"
            )
            print(
                f"[google-news] Waiting {delay:.0f}s before retrying "
                "the entire collection wave..."
            )
            time.sleep(delay)

    if last_error is not None:
        raise last_error


def selection_compact_text(
    value,
    limit,
):
    value = clean_text(
        value
    )

    if len(
        value
    ) <= limit:
        return value

    return (
        value[
            :limit
        ].rstrip()
        +
        "…"
    )


def selection_payload(
    event,
    index,
):
    event_id = str(
        event.get(
            "id"
        )
        or
        f"candidate-{index}"
    )

    related = []

    for article in (
        event.get(
            "related_articles"
        )
        or
        []
    )[:4]:
        if not isinstance(
            article,
            dict
        ):
            continue

        title = selection_compact_text(
            article.get(
                "title"
            ),
            280,
        )

        source = selection_compact_text(
            article.get(
                "source"
            ),
            100,
        )

        if title:
            related.append(
                {
                    "title":
                        title,
                    "source":
                        source,
                }
            )

    return {
        "event_id":
            event_id,

        "title":
            selection_compact_text(
                event.get(
                    "title"
                ),
                650,
            ),

        "summary":
            selection_compact_text(
                event.get(
                    "summary"
                ),
                1100,
            ),

        "source":
            selection_compact_text(
                event.get(
                    "source"
                ),
                140,
            ),

        "collection_language_hint":
            str(
                event.get(
                    "original_language"
                )
                or
                event.get(
                    "collection_language"
                )
                or
                ""
            ),

        "published":
            str(
                event.get(
                    "published"
                )
                or
                ""
            ),

        "current_categories":
            list(
                event.get(
                    "categories"
                )
                or
                (
                    [
                        event.get(
                            "category"
                        )
                    ]
                    if event.get(
                        "category"
                    )
                    else []
                )
            ),

        "related_articles":
            related,
    }


def selection_fingerprint(
    event
):
    material = {
        "url":
            str(
                event.get(
                    "url"
                )
                or
                ""
            ),

        "title":
            normalize_title(
                event.get(
                    "title"
                )
                or
                ""
            ),

        "summary":
            selection_compact_text(
                event.get(
                    "summary"
                ),
                1000,
            ),
    }

    return hashlib.sha256(
        json.dumps(
            material,
            ensure_ascii=False,
            sort_keys=True,
        ).encode(
            "utf-8"
        )
    ).hexdigest()


def load_selection_cache():
    try:
        with open(
            AI_SELECTION_CACHE_FILE,
            "r",
            encoding="utf-8",
        ) as file:
            cache = json.load(
                file
            )

        if (
            cache.get(
                "version"
            )
            !=
            AI_SELECTION_VERSION
        ):
            return {
                "version":
                    AI_SELECTION_VERSION,
                "model":
                    AI_SELECTION_MODEL,
                "threshold":
                    AI_SELECTION_THRESHOLD,
                "items": {},
                "backfill_rss_snapshots": cache.get("backfill_rss_snapshots", {}),
            }

        if not isinstance(
            cache.get(
                "items"
            ),
            dict
        ):
            cache[
                "items"
            ] = {}

        return cache

    except Exception:
        return {
            "version":
                AI_SELECTION_VERSION,
            "model":
                AI_SELECTION_MODEL,
            "threshold":
                AI_SELECTION_THRESHOLD,
            "items":
                {},
        }


def save_selection_cache(
    cache
):
    cache[
        "version"
    ] = AI_SELECTION_VERSION

    cache[
        "model"
    ] = AI_SELECTION_MODEL

    cache[
        "threshold"
    ] = AI_SELECTION_THRESHOLD

    cache[
        "last_updated"
    ] = datetime.now(
        timezone.utc
    ).isoformat()

    cache["backfill_rss_snapshots"] = BACKFILL_RSS_SNAPSHOTS
    atomic_json_write(AI_SELECTION_CACHE_FILE, cache)


def extract_interaction_text(
    payload
):
    status = str(
        payload.get(
            "status",
            ""
        )
        or
        ""
    ).lower()

    if status in {
        "incomplete",
        "budget_exceeded",
    }:
        raise AISelectionIncompleteError(
            f"Gemini interaction status={status}"
        )

    if status in {
        "failed",
        "cancelled",
    }:
        raise RuntimeError(
            "Gemini article-selection interaction "
            f"ended with status {status}: "
            f"{payload.get('error')}"
        )

    texts = []

    for step in payload.get(
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

        for part in content:
            if (
                isinstance(
                    part,
                    dict
                )
                and
                part.get(
                    "type"
                )
                ==
                "text"
                and
                part.get(
                    "text"
                )
            ):
                texts.append(
                    part[
                        "text"
                    ]
                )

    output = "".join(
        texts
    ).strip()

    if not output:
        raise AISelectionIncompleteError(
            "Gemini returned no article-selection text."
        )

    return output


def call_ai_selection_batch(
    batch
):
    api_key = os.getenv(
        "GEMINI_API_KEY"
    )

    if not api_key:
        raise RuntimeError(
            "GEMINI_API_KEY is missing. "
            "AI article selection cannot run."
        )

    body = {
        "model":
            AI_SELECTION_MODEL,

        "input":
            (
                "Review every candidate CT event below. "
                "Return exactly one result for every event_id.\n\n"
                +
                json.dumps(
                    {
                        "events":
                            batch
                    },
                    ensure_ascii=False,
                )
            ),

        "system_instruction":
            AI_SELECTION_INSTRUCTIONS,

        "store":
            False,

        "response_format": {
            "type":
                "text",

            "mime_type":
                "application/json",

            "schema":
                AI_SELECTION_SCHEMA,
        },

        "generation_config": {
            "max_output_tokens":
                24000,

            "thinking_level":
                "minimal",
        },
    }

    headers = {
        "x-goog-api-key":
            api_key,

        "Content-Type":
            "application/json",
    }

    for attempt in range(
        1,
        AI_SELECTION_ATTEMPTS + 1,
    ):
        try:
            body["input"] = (
                base_input
                +
                (
                    "\n\nQUALITY CORRECTION FROM THE PREVIOUS ATTEMPT: "
                    + quality_feedback
                    + ". Rewrite the full report and correct this weakness."
                    if quality_feedback
                    else ""
                )
            )

            response = requests.post(
                GEMINI_INTERACTIONS_URL,
                headers=headers,
                json=body,
                timeout=AI_SELECTION_TIMEOUT,
            )

            if response.status_code == 429:
                delay = min(
                    120,
                    15 * attempt,
                )

                print(
                    f"   AI selection quota 429; "
                    f"attempt {attempt}/"
                    f"{AI_SELECTION_ATTEMPTS}; "
                    f"retrying in {delay}s"
                )

                if attempt >= AI_SELECTION_ATTEMPTS:
                    raise AISelectionQuotaError(
                        "Gemini article-selection quota reached."
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
                delay = min(
                    90,
                    12 * attempt,
                )

                print(
                    f"   AI selection temporary HTTP "
                    f"{response.status_code}; "
                    f"retrying in {delay}s"
                )

                if attempt >= AI_SELECTION_ATTEMPTS:
                    raise AISelectionTransientError(
                        "Gemini article-selection service unavailable."
                    )

                time.sleep(
                    delay
                )

                continue

            if response.status_code >= 400:
                raise RuntimeError(
                    "Gemini article-selection API error "
                    f"{response.status_code}: "
                    f"{response.text[:1800]}"
                )

            payload = response.json()

            output_text = extract_interaction_text(
                payload
            )

            try:
                parsed = json.loads(
                    output_text
                )

            except json.JSONDecodeError as error:
                raise AISelectionIncompleteError(
                    "Invalid Gemini article-selection JSON."
                ) from error

            results = parsed.get(
                "results"
            )

            if not isinstance(
                results,
                list
            ):
                raise AISelectionIncompleteError(
                    "Gemini selection result has no results array."
                )

            time.sleep(
                AI_SELECTION_PAUSE_SECONDS
            )

            return results

        except AISelectionIncompleteError:
            raise

        except requests.RequestException as error:
            if attempt >= AI_SELECTION_ATTEMPTS:
                raise AISelectionTransientError(
                    "Gemini article-selection network failure."
                ) from error

            delay = min(
                90,
                10 * attempt,
            )

            print(
                f"   AI selection network error: "
                f"{error}; retrying in {delay}s"
            )

            time.sleep(
                delay
            )

    raise AISelectionTransientError(
        "Gemini article-selection request failed."
    )


def process_ai_selection_batch(
    batch
):
    try:
        results = call_ai_selection_batch(
            batch
        )

        returned = {
            str(
                result.get(
                    "event_id"
                )
            )
            for result
            in results
            if result.get(
                "event_id"
            )
        }

        expected = {
            str(
                item.get(
                    "event_id"
                )
            )
            for item
            in batch
        }

        if returned != expected:
            raise AISelectionIncompleteError(
                "Gemini omitted one or more candidate events."
            )

        return results

    except AISelectionIncompleteError:
        if len(
            batch
        ) <= 1:
            raise

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
            f"   AI selection incomplete for "
            f"{len(batch)} events; splitting into "
            f"{len(left)} + {len(right)}."
        )

        return (
            process_ai_selection_batch(
                left
            )
            +
            process_ai_selection_batch(
                right
            )
        )


def apply_ai_selection(
    event,
    result,
):
    try:
        score = int(
            result.get(
                "relevance_score",
                0,
            )
        )
    except Exception:
        score = 0

    score = max(
        0,
        min(
            100,
            score,
        ),
    )

    categories = normalize_categories(
        result.get(
            "categories"
        )
        or
        []
    )

    categories = [
        category
        for category
        in categories
        if category
        in CATEGORIES
    ]

    if (
        score
        >=
        AI_SELECTION_THRESHOLD

        and

        not categories
    ):
        categories = normalize_categories(
            event.get(
                "categories"
            )
            or
            (
                [
                    event.get(
                        "category"
                    )
                ]
                if event.get(
                    "category"
                )
                else []
            )
        )

    event[
        "ai_selection_complete"
    ] = True

    event[
        "ai_selection_version"
    ] = AI_SELECTION_VERSION

    event[
        "ai_selection_model"
    ] = AI_SELECTION_MODEL

    event[
        "ai_relevance_score"
    ] = score

    event[
        "ai_relevance_reason"
    ] = clean_text(
        result.get(
            "reason"
        )
        or
        ""
    )

    event[
        "ai_current_ct_event"
    ] = bool(
        result.get(
            "is_current_ct_event"
        )
    )

    event[
        "ai_selected"
    ] = (
        score
        >=
        AI_SELECTION_THRESHOLD
    )

    if categories:
        event[
            "categories"
        ] = categories

        event[
            "category"
        ] = categories[
            0
        ]

    # Preserve original-language material before normalizing the map fields.
    if not event.get(
        "original_title"
    ):
        event[
            "original_title"
        ] = event.get(
            "title",
            "",
        )

    if not event.get(
        "original_summary"
    ):
        event[
            "original_summary"
        ] = event.get(
            "summary",
            "",
        )

    detected_language = clean_text(
        result.get(
            "original_language"
        )
        or
        event.get(
            "original_language"
        )
        or
        "en"
    ).lower()

    event[
        "original_language"
    ] = detected_language

    english_title = clean_text(
        result.get(
            "english_title"
        )
        or
        ""
    )

    english_summary = clean_text(
        result.get(
            "english_summary"
        )
        or
        ""
    )

    canonical_event = clean_text(
        result.get(
            "canonical_event"
        )
        or
        ""
    )

    event[
        "actor_group"
    ] = canonicalize_actor_group(
        result.get(
            "actor_group"
        )
    )

    primary_event_type = clean_text(result.get("primary_event_type") or "OTHER_CT").upper()
    allowed_primary_types = {
        "ATTACK", "ATTEMPTED_ATTACK", "DISRUPTED_PLOT", "CT_OPERATION",
        "ARREST", "JUDICIAL", "FINANCING", "WEAPONS", "ONLINE_CYBER_AI",
        "CBRN", "PIRACY", "OTHER_CT",
    }
    if primary_event_type not in allowed_primary_types:
        primary_event_type = "OTHER_CT"

    is_attack = bool(result.get("is_attack")) and primary_event_type == "ATTACK"
    incident_anchor = clean_text(result.get("incident_anchor") or canonical_event or english_title)
    update_type = clean_text(result.get("update_type") or "OTHER_UPDATE").upper()
    allowed_update_types = {
        "INITIAL", "FOLLOW_UP", "ARREST_UPDATE", "INVESTIGATION_UPDATE",
        "JUDICIAL_UPDATE", "OTHER_UPDATE",
    }
    if update_type not in allowed_update_types:
        update_type = "OTHER_UPDATE"

    event["primary_event_type"] = primary_event_type
    event["is_attack"] = is_attack
    event["incident_anchor"] = incident_anchor
    event["update_type"] = update_type

    if incident_anchor:
        normalized_anchor = unicodedata.normalize("NFKD", incident_anchor)
        normalized_anchor = "".join(ch for ch in normalized_anchor if not unicodedata.combining(ch))
        normalized_anchor = re.sub(r"[^a-z0-9]+", " ", normalized_anchor.lower()).strip()
        event["incident_id"] = "inc-" + hashlib.sha256(normalized_anchor.encode("utf-8")).hexdigest()[:16]

    event[
        "translated_to_english"
    ] = (
        detected_language
        not in {
            "en",
            "eng",
            "english",
        }
    )

    if english_title:
        event[
            "title"
        ] = english_title

    if english_summary:
        event[
            "summary"
        ] = english_summary

    event[
        "ai_canonical_event"
    ] = canonical_event

    # Give the existing smart deduplicator an additional normalized English
    # semantic variant without replacing the visible English headline.
    if canonical_event:
        variants = event.get(
            "title_variants"
        )

        if not isinstance(
            variants,
            list,
        ):
            variants = []

        if canonical_event not in variants:
            variants.append(
                canonical_event
            )

        event[
            "title_variants"
        ] = variants

    scope_reason = out_of_scope_reason(event)
    if scope_reason:
        event["ai_selected"] = False
        event["ai_current_ct_event"] = False
        event["ai_scope_rejection"] = scope_reason
        return False

    return (
        score
        >=
        AI_SELECTION_THRESHOLD
    )


def ai_select_events(
    events
):
    if not AI_SELECTION_ENABLED:
        return events

    print()
    print("=" * 70)
    print("GEMINI AI ARTICLE SELECTION")
    print("=" * 70)
    print(
        f"Candidate event clusters: "
        f"{len(events)}"
    )
    print(
        f"Model: {AI_SELECTION_MODEL}"
    )
    print(
        f"Keep threshold: "
        f"{AI_SELECTION_THRESHOLD}/100"
    )

    cache = load_selection_cache()

    event_by_id = {}
    fingerprint_by_id = {}
    pending = []
    decisions = {}

    cached_count = 0

    for index, event in enumerate(
        events
    ):
        payload = selection_payload(
            event,
            index,
        )

        event_id = payload[
            "event_id"
        ]

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

        fingerprint = selection_fingerprint(
            event
        )

        event_by_id[
            event_id
        ] = event

        fingerprint_by_id[
            event_id
        ] = fingerprint

        cached = (
            cache.get(
                "items",
                {}
            ).get(
                fingerprint
            )
        )

        if (
            isinstance(
                cached,
                dict
            )
            and
            cached.get(
                "version"
            )
            ==
            AI_SELECTION_VERSION
        ):
            decisions[
                event_id
            ] = cached[
                "result"
            ]

            cached_count += 1

        else:
            pending.append(
                payload
            )

    print(
        f"Cached AI decisions: "
        f"{cached_count}"
    )
    print(
        f"Need AI review: "
        f"{len(pending)}"
    )

    total_batches = (
        (
            len(
                pending
            )
            +
            AI_SELECTION_BATCH_SIZE
            -
            1
        )
        //
        AI_SELECTION_BATCH_SIZE
    )

    for start in range(
        0,
        len(
            pending
        ),
        AI_SELECTION_BATCH_SIZE,
    ):
        batch_number = (
            start
            //
            AI_SELECTION_BATCH_SIZE
            +
            1
        )

        batch = pending[
            start:
            start + AI_SELECTION_BATCH_SIZE
        ]

        print(
            f"AI selection batch "
            f"{batch_number}/{total_batches} "
            f"— {len(batch)} events"
        )

        try:
            results = process_ai_selection_batch(
                batch
            )

        except (
            AISelectionQuotaError,
            AISelectionTransientError,
            AISelectionIncompleteError,
        ) as error:
            save_selection_cache(
                cache
            )

            print()
            print(
                "AI article selection could not finish safely."
            )
            print(
                f"Reason: {error}"
            )
            print(
                "The current events.json will NOT be replaced."
            )
            print(
                "The AI selection cache has been saved so the next "
                "workflow run can resume."
            )

            return None

        for result in results:
            event_id = str(
                result.get(
                    "event_id"
                )
                or
                ""
            )

            if event_id not in event_by_id:
                continue

            decisions[
                event_id
            ] = result

            fingerprint = fingerprint_by_id[
                event_id
            ]

            cache[
                "items"
            ][
                fingerprint
            ] = {
                "version":
                    AI_SELECTION_VERSION,

                "reviewed_at":
                    datetime.now(
                        timezone.utc
                    ).isoformat(),

                "result":
                    result,
            }

        save_selection_cache(
            cache
        )

        print(
            f"   AI selection checkpoint saved."
        )

    selected = []
    rejected = []

    for event_id, event in event_by_id.items():
        result = decisions.get(
            event_id
        )

        if result is None:
            print(
                f"Missing AI selection decision for "
                f"{event_id}; aborting safely."
            )

            save_selection_cache(
                cache
            )

            return None

        keep = apply_ai_selection(
            event,
            result,
        )

        if keep:
            selected.append(
                event
            )
        else:
            rejected.append(
                event
            )

    score_bands = Counter()

    for event in events:
        score = event.get(
            "ai_relevance_score",
            0,
        )

        if score >= 80:
            score_bands[
                "80-100"
            ] += 1
        elif score >= 60:
            score_bands[
                "60-79"
            ] += 1
        elif score >= 50:
            score_bands[
                "50-59"
            ] += 1
        else:
            score_bands[
                "0-49"
            ] += 1

    print()
    print(
        f"AI KEPT:     "
        f"{len(selected)}"
    )
    print(
        f"AI REJECTED: "
        f"{len(rejected)}"
    )
    print(
        "Score bands: "
        +
        ", ".join(
            f"{band}={count}"
            for band, count
            in score_bands.items()
        )
    )

    if rejected:
        print()
        print(
            "Rejected examples:"
        )

        for event in sorted(
            rejected,
            key=lambda item:
                item.get(
                    "ai_relevance_score",
                    0,
                )
        )[:10]:
            print(
                f"   "
                f"{event.get('ai_relevance_score', 0):>3}/100 "
                f"— "
                f"{selection_compact_text(event.get('title'), 110)}"
            )

    save_selection_cache(
        cache
    )

    return selected


# ============================================================
# INTELLIGENT EVENT-LEVEL DEDUPLICATION V7
#
# The collector receives many different headlines about the same
# real-world event.  Deduplication therefore uses more than title
# similarity:
#
# - canonical URL
# - normalized title similarity
# - meaningful token overlap
# - title containment
# - named entities / personalities
# - terrorist organisation aliases
# - CT action families
# - explicit country clues
# - numbers / casualty counts / amounts
# - summary overlap
# - publication-time proximity
# - previously merged headline variants
#
# It deliberately avoids merging two events merely because they
# involve the same group or the same country.
# ============================================================

MAX_DEDUP_WINDOW_DAYS = 7
MAX_RELATED_ARTICLES = 24


DEDUP_GENERIC_WORDS = {
    "terror",
    "terrorism",
    "terrorist",
    "terrorists",
    "extremist",
    "extremists",
    "extremism",
    "militant",
    "militants",
    "jihadist",
    "jihadists",
    "security",
    "official",
    "officials",
    "authorities",
    "government",
    "police",
    "report",
    "reports",
    "reported",
    "news",
    "latest",
    "breaking",
    "update",
    "updates",
    "case",
    "cases",
    "suspect",
    "suspects",
}


ACTION_FAMILIES = {
    "attack": {
        "attack", "attacks", "attacked", "assault", "ambush",
        "bomb", "bombing", "blast", "explosion", "shooting",
        "shot", "stabbing", "stabbed", "ramming", "rocket",
        "drone attack", "suicide bomber", "suicide bombing",
        "killed", "wounded",
    },
    "arrest": {
        "arrest", "arrests", "arrested", "detained", "detention",
        "captured", "raid", "raided", "custody",
    },
    "legal": {
        "charged", "charges", "trial", "court", "convicted",
        "conviction", "sentenced", "sentence", "indicted",
        "indictment", "guilty", "prosecution", "appeal",
    },
    "finance": {
        "financing", "funding", "fundraising", "donation",
        "donations", "assets frozen", "assets seized",
        "sanctioned", "sanctions", "money laundering",
        "cryptocurrency", "crypto", "hawala",
    },
    "weapons": {
        "weapons", "weapon", "arms", "firearms", "ammunition",
        "explosives", "explosive", "ied", "missile", "rocket",
        "weapons cache", "arms cache", "smuggling", "trafficking",
    },
    "online": {
        "propaganda", "recruitment", "radicalization",
        "radicalisation", "cyberattack", "cyber attack",
        "hacking", "deepfake", "artificial intelligence",
        "generative ai", "social media", "encrypted messaging",
    },
    "cbrn": {
        "chemical", "biological", "radiological", "nuclear",
        "radioactive", "cbrn", "ricin", "sarin", "chlorine",
        "dirty bomb",
    },
}


ACTOR_ALIASES = {
    "islamic_state": {
        "isis", "isil", "daesh", "islamic state",
    },
    "al_qaeda": {
        "al-qaeda", "al qaeda", "alqaeda",
    },
    "al_shabaab": {
        "al-shabaab", "al shabaab",
    },
    "boko_haram": {
        "boko haram",
    },
    "iswap": {
        "iswap", "islamic state west africa province",
    },
    "taliban": {
        "taliban",
    },
    "ttp": {
        "ttp", "tehrik-i-taliban pakistan",
        "tehreek-e-taliban pakistan",
    },
    "hamas": {
        "hamas",
    },
    "hezbollah": {
        "hezbollah", "hizballah", "hizbollah",
    },
    "pij": {
        "palestinian islamic jihad", "islamic jihad",
    },
    "houthis": {
        "houthis", "houthi", "ansar allah",
    },
    "lashkar_e_taiba": {
        "lashkar-e-taiba", "lashkar e taiba", "let",
    },
    "jaish_e_mohammed": {
        "jaish-e-mohammed", "jaish e mohammed", "jem",
    },
}


COUNTRY_CANONICAL = {
    "united states": {
        "united states", "u.s.", "u.s", "usa", "america", "american",
    },
    "united kingdom": {
        "united kingdom", "u.k.", "u.k", "uk", "britain", "british",
    },
    "afghanistan": {
        "afghanistan", "afghan",
    },
    "pakistan": {
        "pakistan", "pakistani",
    },
    "india": {
        "india", "indian",
    },
    "israel": {
        "israel", "israeli",
    },
    "palestinian territory": {
        "palestine", "palestinian", "gaza", "west bank",
    },
    "lebanon": {
        "lebanon", "lebanese",
    },
    "iraq": {
        "iraq", "iraqi",
    },
    "syria": {
        "syria", "syrian",
    },
    "iran": {
        "iran", "iranian",
    },
    "turkiye": {
        "turkey", "turkiye", "türkiye", "turkish",
    },
    "russia": {
        "russia", "russian",
    },
    "ukraine": {
        "ukraine", "ukrainian",
    },
    "somalia": {
        "somalia", "somali",
    },
    "kenya": {
        "kenya", "kenyan",
    },
    "nigeria": {
        "nigeria", "nigerian",
    },
    "niger": {
        "niger", "nigerien",
    },
    "mali": {
        "mali", "malian",
    },
    "burkina faso": {
        "burkina faso", "burkinabe", "burkinabè",
    },
    "mozambique": {
        "mozambique", "mozambican",
    },
    "egypt": {
        "egypt", "egyptian",
    },
    "france": {
        "france", "french",
    },
    "germany": {
        "germany", "german",
    },
    "belgium": {
        "belgium", "belgian",
    },
    "canada": {
        "canada", "canadian",
    },
    "australia": {
        "australia", "australian",
    },
    "philippines": {
        "philippines", "philippine", "filipino",
    },
    "malaysia": {
        "malaysia", "malaysian",
    },
    "indonesia": {
        "indonesia", "indonesian",
    },
    "tunisia": {
        "tunisia", "tunisian",
    },
    "morocco": {
        "morocco", "moroccan",
    },
    "algeria": {
        "algeria", "algerian",
    },
    "libya": {
        "libya", "libyan",
    },
    "yemen": {
        "yemen", "yemeni",
    },
    "saudi arabia": {
        "saudi arabia", "saudi",
    },
    "united arab emirates": {
        "united arab emirates", "uae", "emirati",
    },
}


def ascii_text(text):
    value = clean_text(text)

    value = unicodedata.normalize(
        "NFKD",
        value,
    )

    value = "".join(
        character
        for character in value
        if not unicodedata.combining(
            character
        )
    )

    return value


def normalize_event_text(text):
    value = ascii_text(
        text
    ).lower()

    value = re.sub(
        r"https?://\S+",
        " ",
        value,
    )

    value = re.sub(
        r"[^a-z0-9$€£%'\-\s]",
        " ",
        value,
    )

    value = re.sub(
        r"\s+",
        " ",
        value,
    )

    return value.strip()


def canonical_url(url):
    # ACLED record identity is in the query; do not collapse all API links.
    if url and url.startswith(ACLED_READ_URL + "?"):
        return url
    if not url:
        return ""

    try:
        parts = urlsplit(
            url
        )

        return urlunsplit(
            (
                parts.scheme.lower(),
                parts.netloc.lower(),
                parts.path.rstrip("/"),
                "",
                "",
            )
        )

    except Exception:
        return str(url).strip()


def meaningful_tokens(text):
    normalized = normalize_event_text(
        text
    )

    tokens = []

    for token in normalized.split():
        if token in STOPWORDS:
            continue

        if token in DEDUP_GENERIC_WORDS:
            continue

        if len(token) <= 2:
            continue

        tokens.append(
            token
        )

    return set(
        tokens
    )


def jaccard(
    values1,
    values2,
):
    set1 = set(
        values1
    )

    set2 = set(
        values2
    )

    if not set1 or not set2:
        return 0.0

    return (
        len(
            set1 & set2
        )
        /
        len(
            set1 | set2
        )
    )


def containment_similarity(
    values1,
    values2,
):
    set1 = set(
        values1
    )

    set2 = set(
        values2
    )

    if not set1 or not set2:
        return 0.0

    shared = len(
        set1 & set2
    )

    return shared / min(
        len(set1),
        len(set2),
    )


def extract_named_entities(text):
    """
    Lightweight named-entity extraction for headlines.
    Multi-word capitalized names and acronyms are strong dedup clues.
    """

    original = clean_text(
        text
    )

    candidates = re.findall(
        r"\b(?:[A-Z][A-Za-zÀ-ÿ'\-]{2,}|[A-Z]{2,})"
        r"(?:\s+(?:[A-Z][A-Za-zÀ-ÿ'\-]{2,}|[A-Z]{2,})){0,4}\b",
        original,
    )

    entities = set()

    for candidate in candidates:
        normalized = normalize_event_text(
            candidate
        )

        words = normalized.split()

        if not words:
            continue

        if all(
            word in STOPWORDS
            or
            word in DEDUP_GENERIC_WORDS
            for word in words
        ):
            continue

        if (
            len(words) == 1
            and
            len(words[0]) < 4
            and
            not candidate.isupper()
        ):
            continue

        entities.add(
            normalized
        )

    return entities


def extract_actor_families(text):
    normalized = (
        " "
        +
        normalize_event_text(
            text
        )
        +
        " "
    )

    actors = set()

    for canonical, aliases in ACTOR_ALIASES.items():
        for alias in aliases:
            pattern = (
                r"(?<![a-z0-9])"
                +
                re.escape(
                    normalize_event_text(
                        alias
                    )
                )
                +
                r"(?![a-z0-9])"
            )

            if re.search(
                pattern,
                normalized,
            ):
                actors.add(
                    canonical
                )
                break

    return actors


def extract_action_families(text):
    normalized = (
        " "
        +
        normalize_event_text(
            text
        )
        +
        " "
    )

    actions = set()

    for family, terms in ACTION_FAMILIES.items():
        for term in terms:
            normalized_term = normalize_event_text(
                term
            )

            if (
                " "
                +
                normalized_term
                +
                " "
            ) in normalized:
                actions.add(
                    family
                )
                break

            pattern = (
                r"(?<![a-z0-9])"
                +
                re.escape(
                    normalized_term
                )
                +
                r"(?![a-z0-9])"
            )

            if re.search(
                pattern,
                normalized,
            ):
                actions.add(
                    family
                )
                break

    return actions


def extract_country_families(text):
    normalized = (
        " "
        +
        normalize_event_text(
            text
        )
        +
        " "
    )

    found = set()

    for canonical, aliases in COUNTRY_CANONICAL.items():
        for alias in aliases:
            normalized_alias = normalize_event_text(
                alias
            )

            pattern = (
                r"(?<![a-z0-9])"
                +
                re.escape(
                    normalized_alias
                )
                +
                r"(?![a-z0-9])"
            )

            if re.search(
                pattern,
                normalized,
            ):
                found.add(
                    canonical
                )
                break

    return found


def extract_numbers(text):
    normalized = normalize_event_text(
        text
    )

    numbers = set(
        re.findall(
            r"(?:[$€£]\s*)?\b\d+(?:[.,]\d+)?(?:\s*(?:million|billion|thousand|m|bn))?\b",
            normalized,
        )
    )

    # Years are weak evidence and can make unrelated stories look alike.
    return {
        number
        for number in numbers
        if not re.fullmatch(
            r"(?:19|20)\d{2}",
            number.strip(),
        )
    }


@lru_cache(
    maxsize=50000
)
def _event_datetime_cached(
    published
):
    if not published:
        return None

    try:
        dt = datetime.fromisoformat(
            published
        )

        if dt.tzinfo is None:
            dt = dt.replace(
                tzinfo=timezone.utc
            )

        return dt.astimezone(
            timezone.utc
        )

    except Exception:
        return None


def event_datetime(event):
    return _event_datetime_cached(
        str(
            event.get(
                "published"
            )
            or
            ""
        )
    )


def event_variants(event):
    variants = [
        {
            "title":
                event.get(
                    "title",
                    "",
                ),
            "summary":
                event.get(
                    "summary",
                    "",
                ),
            "source":
                event.get(
                    "source",
                    "",
                ),
            "url":
                event.get(
                    "url",
                    "",
                ),
            "published":
                event.get(
                    "published",
                ),
        }
    ]

    for title_variant in event.get(
        "title_variants",
        [],
    ):
        if not title_variant:
            continue

        variants.append(
            {
                "title":
                    title_variant,
                "summary":
                    event.get(
                        "summary",
                        "",
                    ),
                "source":
                    event.get(
                        "source",
                        "",
                    ),
                "url":
                    event.get(
                        "url",
                        "",
                    ),
                "published":
                    event.get(
                        "published",
                    ),
            }
        )

    for article in event.get(
        "related_articles",
        [],
    ):
        if not isinstance(
            article,
            dict,
        ):
            continue

        variants.append(
            {
                "title":
                    article.get(
                        "title",
                        "",
                    ),
                "summary":
                    article.get(
                        "summary",
                        "",
                    ),
                "source":
                    article.get(
                        "source",
                        "",
                    ),
                "url":
                    article.get(
                        "url",
                        "",
                    ),
                "published":
                    article.get(
                        "published",
                    ),
            }
        )

    return variants[
        :MAX_RELATED_ARTICLES
    ]


@lru_cache(
    maxsize=100000
)
def _build_profile_cached(
    title,
    summary,
    url,
):
    title = clean_text(
        title
    )

    summary = clean_text(
        summary
    )

    combined = (
        title
        +
        " "
        +
        summary
    )

    normalized_title = normalize_event_text(
        title
    )

    return {
        "normalized_title":
            normalized_title,

        "title_tokens":
            meaningful_tokens(
                title
            ),

        "summary_tokens":
            meaningful_tokens(
                summary
            ),

        "entities":
            extract_named_entities(
                title
            ),

        "actors":
            extract_actor_families(
                combined
            ),

        "actions":
            extract_action_families(
                combined
            ),

        "countries":
            extract_country_families(
                combined
            ),

        "numbers":
            extract_numbers(
                combined
            ),

        "url":
            canonical_url(
                url
            ),
    }


def build_profile(event):
    """
    Profile construction is one of the most expensive parts of event matching.
    The same title/summary variants are compared repeatedly during dedup, so
    cache immutable profiles by their text and URL.
    """

    return _build_profile_cached(
        str(
            event.get(
                "title",
                "",
            )
            or
            ""
        ),
        str(
            event.get(
                "summary",
                "",
            )
            or
            ""
        ),
        str(
            event.get(
                "url",
                "",
            )
            or
            ""
        ),
    )


def profile_pair_score(
    event1,
    event2,
):
    profile1 = build_profile(
        event1
    )

    profile2 = build_profile(
        event2
    )

    if (
        profile1[
            "url"
        ]
        and
        profile1[
            "url"
        ]
        ==
        profile2[
            "url"
        ]
    ):
        return (
            True,
            1.0,
            "same_url",
        )

    title1 = profile1[
        "normalized_title"
    ]

    title2 = profile2[
        "normalized_title"
    ]

    if not title1 or not title2:
        return (
            False,
            0.0,
            "missing_title",
        )

    if title1 == title2:
        return (
            True,
            0.99,
            "same_normalized_title",
        )

    dt1 = event_datetime(
        event1
    )

    dt2 = event_datetime(
        event2
    )

    day_gap = None

    if dt1 and dt2:
        day_gap = abs(
            (
                dt1
                -
                dt2
            ).total_seconds()
        ) / 86400.0

        if day_gap > MAX_DEDUP_WINDOW_DAYS:
            return (
                False,
                0.0,
                "outside_time_window",
            )

    sequence = SequenceMatcher(
        None,
        title1,
        title2,
    ).ratio()

    title_jaccard = jaccard(
        profile1[
            "title_tokens"
        ],
        profile2[
            "title_tokens"
        ],
    )

    title_containment = containment_similarity(
        profile1[
            "title_tokens"
        ],
        profile2[
            "title_tokens"
        ],
    )

    lexical = max(
        sequence,
        title_jaccard,
        title_containment,
    )

    summary_overlap = jaccard(
        profile1[
            "summary_tokens"
        ],
        profile2[
            "summary_tokens"
        ],
    )

    entity_overlap = containment_similarity(
        profile1[
            "entities"
        ],
        profile2[
            "entities"
        ],
    )

    actor_overlap = containment_similarity(
        profile1[
            "actors"
        ],
        profile2[
            "actors"
        ],
    )

    action_overlap = containment_similarity(
        profile1[
            "actions"
        ],
        profile2[
            "actions"
        ],
    )

    country_overlap = containment_similarity(
        profile1[
            "countries"
        ],
        profile2[
            "countries"
        ],
    )

    number_overlap = containment_similarity(
        profile1[
            "numbers"
        ],
        profile2[
            "numbers"
        ],
    )

    shared_title_tokens = len(
        profile1[
            "title_tokens"
        ]
        &
        profile2[
            "title_tokens"
        ]
    )

    # Two articles that clearly concern different countries should
    # not be merged merely because the same organisation is involved.
    country_conflict = (
        bool(
            profile1[
                "countries"
            ]
        )
        and
        bool(
            profile2[
                "countries"
            ]
        )
        and
        not (
            profile1[
                "countries"
            ]
            &
            profile2[
                "countries"
            ]
        )
    )

    if country_conflict:
        return (
            False,
            lexical,
            "country_conflict",
        )

    weighted = (
        lexical
        *
        0.42
        +
        summary_overlap
        *
        0.12
        +
        entity_overlap
        *
        0.16
        +
        actor_overlap
        *
        0.10
        +
        action_overlap
        *
        0.08
        +
        country_overlap
        *
        0.07
        +
        number_overlap
        *
        0.05
    )

    if day_gap is not None:
        if day_gap <= 1.0:
            weighted += 0.06

        elif day_gap <= 2.0:
            weighted += 0.03

        elif day_gap >= 5.0:
            weighted -= 0.04

    strong_anchor = (
        entity_overlap >= 0.50
        or
        actor_overlap >= 1.0
        or
        country_overlap >= 1.0
    )

    same_action_context = (
        action_overlap >= 1.0
        or
        not profile1[
            "actions"
        ]
        or
        not profile2[
            "actions"
        ]
    )

    # Very similar headline: usually the same wire story or rewrite.
    if lexical >= 0.86:
        return (
            True,
            max(
                weighted,
                lexical,
            ),
            "very_high_title_similarity",
        )

    # Strong lexical match + meaningful shared words + contextual anchor.
    if (
        lexical >= 0.70
        and
        shared_title_tokens >= 4
        and
        strong_anchor
    ):
        return (
            True,
            max(
                weighted,
                lexical,
            ),
            "title_plus_anchor",
        )

    # Strong CT signature even when editors radically rewrite the title.
    # Same actor + same country + same action, with at least two shared
    # meaningful headline tokens, is a strong indication of one event.
    if (
        actor_overlap >= 1.0
        and
        country_overlap >= 1.0
        and
        action_overlap >= 1.0
        and
        shared_title_tokens >= 2
        and
        lexical >= 0.35
        and
        (
            day_gap is None
            or
            day_gap <= 3.0
        )
        and
        weighted >= 0.45
    ):
        return (
            True,
            weighted,
            "actor_country_action_signature",
        )

    # Paraphrased headline: same entities/actor, same CT action and
    # compatible geography within a short time window.
    if (
        lexical >= 0.44
        and
        strong_anchor
        and
        same_action_context
        and
        (
            actor_overlap >= 1.0
            or
            country_overlap >= 1.0
            or
            (
                entity_overlap >= 0.50
                and
                shared_title_tokens >= 4
            )
        )
        and
        (
            day_gap is None
            or
            day_gap <= 3.0
        )
        and
        weighted >= 0.56
    ):
        return (
            True,
            weighted,
            "paraphrase_entity_context",
        )

    # Titles may be radically rewritten while summaries preserve the
    # same facts.
    if (
        summary_overlap >= 0.58
        and
        strong_anchor
        and
        same_action_context
        and
        (
            day_gap is None
            or
            day_gap <= 3.0
        )
    ):
        return (
            True,
            max(
                weighted,
                summary_overlap,
            ),
            "summary_fact_overlap",
        )

    # Very strong combination of entity + actor + place/action.
    if (
        entity_overlap >= 0.70
        and
        (
            actor_overlap >= 1.0
            or
            country_overlap >= 1.0
        )
        and
        same_action_context
        and
        weighted >= 0.50
        and
        (
            day_gap is None
            or
            day_gap <= 2.0
        )
    ):
        return (
            True,
            weighted,
            "entity_actor_event_signature",
        )

    return (
        False,
        weighted,
        "different_event",
    )


def event_match(
    incoming,
    existing,
):
    best_match = (
        False,
        0.0,
        "different_event",
    )

    incoming_variants = event_variants(
        incoming
    )

    existing_variants = event_variants(
        existing
    )

    for incoming_variant in incoming_variants:
        for existing_variant in existing_variants:
            match = profile_pair_score(
                incoming_variant,
                existing_variant,
            )

            if match[1] > best_match[1]:
                best_match = match

            if (
                match[0]
                and
                match[1] >= 0.90
            ):
                return match

    return best_match


def same_event(
    event1,
    event2,
):
    return event_match(
        event1,
        event2,
    )[0]


def article_identity(article):
    url = canonical_url(
        article.get(
            "url",
            "",
        )
    )

    if url:
        return (
            "url:"
            +
            url
        )

    return (
        "title:"
        +
        normalize_event_text(
            article.get(
                "title",
                "",
            )
        )
        +
        "|"
        +
        str(
            article.get(
                "published",
                "",
            )
        )[:10]
    )


def ensure_event_metadata(event):
    sources = event.get(
        "sources"
    )

    if not isinstance(
        sources,
        list,
    ):
        sources = []

    source = clean_text(
        event.get(
            "source",
            "",
        )
    )

    if (
        source
        and
        source not in sources
    ):
        sources.append(
            source
        )

    event[
        "sources"
    ] = sources

    related = event.get(
        "related_articles"
    )

    if not isinstance(
        related,
        list,
    ):
        related = []

    event[
        "related_articles"
    ] = related[
        :MAX_RELATED_ARTICLES
    ]

    event[
        "source_count"
    ] = len(
        set(
            sources
        )
    )

    event[
        "article_count"
    ] = max(
        int(
            event.get(
                "article_count",
                1,
            )
            or
            1
        ),
        1,
    )

    if not event.get(
        "first_reported"
    ):
        event[
            "first_reported"
        ] = event.get(
            "published"
        )

    if not event.get(
        "last_reported"
    ):
        event[
            "last_reported"
        ] = event.get(
            "published"
        )


def merge_event(
    existing,
    new,
    match_score=None,
    match_method=None,
):
    ensure_event_metadata(
        existing
    )

    ensure_event_metadata(
        new
    )

    existing_categories = normalize_categories(
        (
            existing.get(
                "categories",
                [
                    existing.get(
                        "category"
                    )
                ],
            )
            +
            new.get(
                "categories",
                [
                    new.get(
                        "category"
                    )
                ],
            )
        )
    )

    existing[
        "categories"
    ] = existing_categories

    existing["source_article_fingerprints"] = sorted(set(
        existing.get("source_article_fingerprints", [])
        + new.get("source_article_fingerprints", [])
    ))
    merge_acled_metadata(existing, new)

    # Keep a history of genuinely different articles/headlines.
    known_article_ids = {
        article_identity(
            {
                "title":
                    existing.get(
                        "title",
                        "",
                    ),
                "url":
                    existing.get(
                        "url",
                        "",
                    ),
                "published":
                    existing.get(
                        "published",
                    ),
            }
        )
    }

    for article in existing.get(
        "related_articles",
        [],
    ):
        known_article_ids.add(
            article_identity(
                article
            )
        )

    candidate_article = {
        "title":
            new.get(
                "title",
                "",
            ),
        "original_title":
            new.get(
                "original_title",
                "",
            ),
        "original_language":
            new.get(
                "original_language",
                "",
            ),
        "summary":
            new.get(
                "summary",
                "",
            ),
        "published":
            new.get(
                "published"
            ),
        "source":
            new.get(
                "source",
                "",
            ),
        "url":
            new.get(
                "url",
                "",
            ),
    }

    candidate_id = article_identity(
        candidate_article
    )

    new_unique_article = (
        candidate_id
        not in known_article_ids
    )

    if new_unique_article:
        existing[
            "related_articles"
        ].append(
            candidate_article
        )

        existing[
            "related_articles"
        ] = existing[
            "related_articles"
        ][
            :MAX_RELATED_ARTICLES
        ]

        existing[
            "article_count"
        ] = (
            existing.get(
                "article_count",
                1,
            )
            +
            1
        )

    for source in new.get(
        "sources",
        [],
    ):
        if (
            source
            and
            source not in existing[
                "sources"
            ]
        ):
            existing[
                "sources"
            ].append(
                source
            )

    existing[
        "source_count"
    ] = len(
        set(
            existing[
                "sources"
            ]
        )
    )

    # Keep the best editorial representative as the cluster headline.
    if (
        source_rank(
            new.get(
                "source",
                "",
            )
        )
        >
        source_rank(
            existing.get(
                "source",
                "",
            )
        )
    ):
        old_representative = {
            "title":
                existing.get(
                    "title",
                    "",
                ),
            "original_title":
                existing.get(
                    "original_title",
                    "",
                ),
            "original_language":
                existing.get(
                    "original_language",
                    "",
                ),
            "summary":
                existing.get(
                    "summary",
                    "",
                ),
            "published":
                existing.get(
                    "published"
                ),
            "source":
                existing.get(
                    "source",
                    "",
                ),
            "url":
                existing.get(
                    "url",
                    "",
                ),
        }

        old_id = article_identity(
            old_representative
        )

        related_ids = {
            article_identity(
                article
            )
            for article in existing.get(
                "related_articles",
                [],
            )
        }

        if (
            old_id
            not in related_ids
            and
            old_id
            !=
            candidate_id
        ):
            existing[
                "related_articles"
            ].append(
                old_representative
            )

        existing[
            "source"
        ] = new.get(
            "source"
        )

        existing[
            "url"
        ] = new.get(
            "url"
        )

        existing[
            "title"
        ] = new.get(
            "title"
        )

        existing[
            "summary"
        ] = new.get(
            "summary"
        )

        for field in (
            "original_title",
            "original_summary",
            "original_language",
            "collection_language",
            "collection_language_name",
            "collection_locale",
            "translated_to_english",
            "ai_canonical_event",
            "actor_group",
        ):
            if field in new:
                existing[
                    field
                ] = new.get(
                    field
                )

    dates = [
        value
        for value in (
            existing.get(
                "first_reported"
            ),
            existing.get(
                "published"
            ),
            new.get(
                "published"
            ),
        )
        if value
    ]

    if dates:
        existing[
            "first_reported"
        ] = min(
            dates
        )

        existing[
            "published"
        ] = existing[
            "first_reported"
        ]

        existing[
            "last_reported"
        ] = max(
            dates
            +
            [
                existing.get(
                    "last_reported"
                )
            ]
            if existing.get(
                "last_reported"
            )
            else dates
        )

    if match_score is not None:
        existing[
            "dedup_confidence"
        ] = round(
            max(
                float(
                    existing.get(
                        "dedup_confidence",
                        0.0,
                    )
                    or
                    0.0
                ),
                float(
                    match_score
                ),
            ),
            3,
        )

    if match_method:
        methods = existing.get(
            "dedup_methods",
            [],
        )

        if not isinstance(
            methods,
            list,
        ):
            methods = []

        if match_method not in methods:
            methods.append(
                match_method
            )

        existing[
            "dedup_methods"
        ] = methods


def deduplicate_events(records):
    print()
    print(
        "Deduplicating events with multi-signal event clustering..."
    )

    print(
        f"   Preparing {len(records)} accepted records..."
    )

    prepared = []

    for record in records:
        ensure_event_metadata(
            record
        )

        prepared.append(
            record
        )

    # Chronological ordering makes candidate comparison much cheaper:
    # once an existing cluster is more than MAX_DEDUP_WINDOW_DAYS away,
    # older clusters do not need to be checked.
    prepared.sort(
        key=lambda event:
            (
                event_datetime(
                    event
                )
                or
                datetime.min.replace(
                    tzinfo=timezone.utc
                )
            )
    )

    events = []

    method_counts = Counter()

    for number, record in enumerate(
        prepared,
        start=1,
    ):
        record_dt = event_datetime(
            record
        )

        best_existing = None
        best_score = 0.0
        best_method = None

        for existing in reversed(
            events
        ):
            existing_dt = event_datetime(
                existing
            )

            if (
                record_dt
                and
                existing_dt
            ):
                gap_days = (
                    record_dt
                    -
                    existing_dt
                ).total_seconds() / 86400.0

                if gap_days > MAX_DEDUP_WINDOW_DAYS:
                    break

            matched, score, method = event_match(
                record,
                existing,
            )

            if (
                matched
                and
                score > best_score
            ):
                best_existing = existing
                best_score = score
                best_method = method

                if score >= 0.98:
                    break

        if best_existing is None:
            events.append(
                record
            )

        else:
            merge_event(
                best_existing,
                record,
                best_score,
                best_method,
            )

            method_counts[
                best_method
            ] += 1

        if number % 50 == 0:
            print(
                f"   Processed "
                f"{number}/"
                f"{len(prepared)}"
            )

    for event in events:
        ensure_event_metadata(
            event
        )

    print(
        f"Raw accepted records: "
        f"{len(records)}"
    )

    print(
        f"Unique event clusters: "
        f"{len(events)}"
    )

    print(
        f"Articles merged: "
        f"{len(records) - len(events)}"
    )

    if method_counts:
        print(
            "Merge methods:"
        )

        for method, count in method_counts.most_common():
            print(
                f"   {method}: "
                f"{count}"
            )

    return events


def load_existing():
    events = load_database_strict()["events"]
    for event in events:
        categories = normalize_categories(event.get("categories") or
            ([event["category"]] if event.get("category") else []))
        if categories:
            event["categories"] = categories
            event["category"] = categories[0]
    return events


def _dedup_day_key(
    event
):
    dt = event_datetime(
        event
    )

    if not dt:
        return None

    return dt.date()


def _quick_signature(
    event
):
    """
    Cheap event signature used only to choose plausible candidates for the
    expensive event_match() function.

    It never decides that two events are duplicates by itself.
    """

    profile = build_profile(
        event
    )

    canonical = normalize_event_text(
        event.get(
            "ai_canonical_event",
            ""
        )
        or
        ""
    )

    title = profile[
        "normalized_title"
    ]

    return {
        "title":
            title,

        "canonical":
            canonical,

        "tokens":
            set(
                profile[
                    "title_tokens"
                ]
            ),

        "actors":
            set(
                profile[
                    "actors"
                ]
            ),

        "actions":
            set(
                profile[
                    "actions"
                ]
            ),

        "countries":
            set(
                profile[
                    "countries"
                ]
            ),

        "entities":
            set(
                profile[
                    "entities"
                ]
            ),

        "url":
            profile[
                "url"
            ],
    }


def _quick_candidate_compatible(
    incoming_signature,
    existing_signature,
):
    """
    Conservative pre-filter.

    Returning False means the pair is clearly implausible.
    Returning True only means it deserves the full event_match() analysis.
    """

    incoming_url = incoming_signature[
        "url"
    ]

    existing_url = existing_signature[
        "url"
    ]

    if (
        incoming_url
        and
        existing_url
        and
        incoming_url
        ==
        existing_url
    ):
        return True

    incoming_title = incoming_signature[
        "title"
    ]

    existing_title = existing_signature[
        "title"
    ]

    if (
        incoming_title
        and
        incoming_title
        ==
        existing_title
    ):
        return True

    incoming_canonical = incoming_signature[
        "canonical"
    ]

    existing_canonical = existing_signature[
        "canonical"
    ]

    if (
        incoming_canonical
        and
        existing_canonical
        and
        incoming_canonical
        ==
        existing_canonical
    ):
        return True

    incoming_countries = incoming_signature[
        "countries"
    ]

    existing_countries = existing_signature[
        "countries"
    ]

    # Explicitly incompatible geography is never worth the expensive match.
    if (
        incoming_countries
        and
        existing_countries
        and
        not (
            incoming_countries
            &
            existing_countries
        )
    ):
        return False

    shared_actors = (
        incoming_signature[
            "actors"
        ]
        &
        existing_signature[
            "actors"
        ]
    )

    shared_actions = (
        incoming_signature[
            "actions"
        ]
        &
        existing_signature[
            "actions"
        ]
    )

    shared_countries = (
        incoming_countries
        &
        existing_countries
    )

    shared_entities = (
        incoming_signature[
            "entities"
        ]
        &
        existing_signature[
            "entities"
        ]
    )

    shared_tokens = (
        incoming_signature[
            "tokens"
        ]
        &
        existing_signature[
            "tokens"
        ]
    )

    # Strong semantic anchors.
    if (
        shared_actors
        and
        (
            shared_actions
            or
            shared_countries
        )
    ):
        return True

    if (
        shared_countries
        and
        shared_actions
        and
        len(
            shared_tokens
        )
        >=
        2
    ):
        return True

    if (
        shared_entities
        and
        len(
            shared_tokens
        )
        >=
        2
    ):
        return True

    # English-normalized/canonical titles allow a cheap lexical rescue for
    # rewritten multilingual coverage of the same event.
    if (
        incoming_title
        and
        existing_title
    ):
        lexical = SequenceMatcher(
            None,
            incoming_title,
            existing_title,
        ).ratio()

        if lexical >= 0.52:
            return True

    if (
        incoming_canonical
        and
        existing_canonical
    ):
        canonical_similarity = SequenceMatcher(
            None,
            incoming_canonical,
            existing_canonical,
        ).ratio()

        if canonical_similarity >= 0.55:
            return True

    return False


def deduplicate_incremental(
    existing_events,
    fresh_records,
):
    """
    Fast indexed daily update.

    Previous implementation scanned every eligible existing event and ran the
    full multi-variant event_match() against it. With multilingual clusters,
    one event can contain many title/article variants, making that approach
    extremely expensive.

    V9.1:
      1. indexes existing events by day, exact URL and normalized title;
      2. restricts candidates to the +/- MAX_DEDUP_WINDOW_DAYS window;
      3. applies a cheap semantic compatibility test;
      4. calls the original full event_match() only on that shortlist.

    The final duplicate decision is STILL made by the same intelligent
    event_match() logic, so matching quality is preserved.
    """

    print()
    print(
        "FAST indexed incremental deduplication..."
    )
    print(
        f"   Existing event clusters: "
        f"{len(existing_events)}"
    )
    print(
        f"   Fresh accepted records:  "
        f"{len(fresh_records)}"
    )

    events = []

    day_index = defaultdict(
        set
    )

    url_index = defaultdict(
        set
    )

    title_index = defaultdict(
        set
    )

    signatures = {}

    def index_event(
        index,
        event
    ):
        ensure_event_metadata(
            event
        )

        signature = _quick_signature(
            event
        )

        signatures[
            index
        ] = signature

        day = _dedup_day_key(
            event
        )

        if day is not None:
            day_index[
                day
            ].add(
                index
            )

        url = signature[
            "url"
        ]

        if url:
            url_index[
                url
            ].add(
                index
            )

        title = signature[
            "title"
        ]

        if title:
            title_index[
                title
            ].add(
                index
            )

        # Exact title variants are cheap and valuable.
        for variant in event.get(
            "title_variants",
            []
        )[:MAX_RELATED_ARTICLES]:
            normalized = normalize_event_text(
                variant
            )

            if normalized:
                title_index[
                    normalized
                ].add(
                    index
                )

    for event in existing_events:
        index = len(
            events
        )

        events.append(
            event
        )

        index_event(
            index,
            event
        )

    method_counts = Counter()
    merged_count = 0

    total_full_comparisons = 0
    total_shortlisted = 0

    for number, record in enumerate(
        fresh_records,
        start=1,
    ):
        ensure_event_metadata(
            record
        )

        incoming_signature = _quick_signature(
            record
        )

        candidates = set()

        # ----------------------------------------------------
        # Exact anchors first.
        # ----------------------------------------------------

        incoming_url = incoming_signature[
            "url"
        ]

        if incoming_url:
            candidates.update(
                url_index.get(
                    incoming_url,
                    set()
                )
            )

        incoming_title = incoming_signature[
            "title"
        ]

        if incoming_title:
            candidates.update(
                title_index.get(
                    incoming_title,
                    set()
                )
            )

        # ----------------------------------------------------
        # Time-window candidates.
        # ----------------------------------------------------

        record_day = _dedup_day_key(
            record
        )

        time_candidates = set()

        if record_day is not None:
            for offset in range(
                -MAX_DEDUP_WINDOW_DAYS,
                MAX_DEDUP_WINDOW_DAYS + 1,
            ):
                day = (
                    record_day
                    +
                    timedelta(
                        days=offset
                    )
                )

                time_candidates.update(
                    day_index.get(
                        day,
                        set()
                    )
                )

        else:
            # Rare legacy/no-date case: preserve recall.
            time_candidates.update(
                range(
                    len(
                        events
                    )
                )
            )

        # ----------------------------------------------------
        # Cheap semantic shortlist.
        # ----------------------------------------------------

        for candidate_index in time_candidates:
            if candidate_index in candidates:
                continue

            existing_signature = signatures.get(
                candidate_index
            )

            if existing_signature is None:
                continue

            if _quick_candidate_compatible(
                incoming_signature,
                existing_signature,
            ):
                candidates.add(
                    candidate_index
                )

        total_shortlisted += len(
            candidates
        )

        best_existing = None
        best_existing_index = None
        best_score = 0.0
        best_method = None

        # Exact matches are usually at the beginning after sorting.
        candidate_list = list(
            candidates
        )

        candidate_list.sort(
            key=lambda candidate_index:
                (
                    0
                    if (
                        incoming_url
                        and
                        signatures[
                            candidate_index
                        ][
                            "url"
                        ]
                        ==
                        incoming_url
                    )
                    else
                    1,

                    0
                    if (
                        incoming_title
                        and
                        signatures[
                            candidate_index
                        ][
                            "title"
                        ]
                        ==
                        incoming_title
                    )
                    else
                    1,
                )
        )

        for candidate_index in candidate_list:
            existing = events[
                candidate_index
            ]

            total_full_comparisons += 1

            matched, score, method = event_match(
                record,
                existing,
            )

            if (
                matched
                and
                score
                >
                best_score
            ):
                best_existing = existing
                best_existing_index = (
                    candidate_index
                )
                best_score = score
                best_method = method

                if score >= 0.98:
                    break

        if best_existing is None:
            new_index = len(
                events
            )

            events.append(
                record
            )

            index_event(
                new_index,
                record
            )

        else:
            merge_event(
                best_existing,
                record,
                best_score,
                best_method,
            )

            merged_count += 1

            method_counts[
                best_method
            ] += 1

            # Refresh the quick signature/index so subsequent fresh events can
            # benefit from the newly merged title/source variants.
            index_event(
                best_existing_index,
                best_existing,
            )

        if (
            number % 20 == 0
            or
            number
            ==
            len(
                fresh_records
            )
        ):
            average_candidates = (
                total_shortlisted
                /
                number
                if number
                else
                0
            )

            print(
                f"   Processed fresh records: "
                f"{number}/"
                f"{len(fresh_records)} "
                f"| avg shortlist "
                f"{average_candidates:.1f} "
                f"| full matches "
                f"{total_full_comparisons}"
            )

    print(
        f"   New standalone clusters: "
        f"{len(events) - len(existing_events)}"
    )
    print(
        f"   Fresh records merged:     "
        f"{merged_count}"
    )
    print(
        f"   Full expensive comparisons: "
        f"{total_full_comparisons}"
    )

    if method_counts:
        print(
            "   Merge methods:"
        )

        for method, count in method_counts.most_common():
            print(
                f"      {method}: "
                f"{count}"
            )

    return events


def prune_old(events):
    cutoff = (
        datetime.now(
            timezone.utc
        )
        -
        timedelta(
            days=RETENTION_DAYS
        )
    )

    result = []

    for event in events:
        if out_of_scope_reason(event):
            continue
        published = event.get(
            "published"
        )

        if not published:
            continue

        try:
            dt = datetime.fromisoformat(
                published
            )

            if dt >= cutoff:
                result.append(event)

        except Exception:
            pass

    return result



def _parse_iso_utc(value):
    if not value:
        return None

    try:
        dt = datetime.fromisoformat(
            str(value).replace(
                "Z",
                "+00:00",
            )
        )

        if dt.tzinfo is None:
            dt = dt.replace(
                tzinfo=timezone.utc
            )

        return dt.astimezone(
            timezone.utc
        )

    except Exception:
        return None


def _trend_recency(event):
    return (
        _parse_iso_utc(
            event.get(
                "last_reported"
            )
        )
        or
        _parse_iso_utc(
            event.get(
                "published"
            )
        )
    )


def _trend_priority(event):
    score = float(
        event.get(
            "ai_relevance_score",
            50,
        )
        or
        50
    )

    categories = set(
        event.get(
            "categories"
        )
        or
        ([event.get("category")] if event.get("category") else [])
    )

    if "Attacks" in categories:
        score += 18
    if "Counter Terrorism Action" in categories:
        score += 15
    if "Weapons" in categories:
        score += 7
    if "CBRN" in categories:
        score += 10
    if "Arrests" in categories:
        score += 5
    if "Terrorist Financing" in categories:
        score += 5

    score += min(
        15,
        max(
            0,
            int(
                event.get(
                    "source_count",
                    1,
                )
                or
                1
            )
            -
            1
        )
        *
        3,
    )

    return score


def _trend_payload(event, index):
    return {
        "event_id":
            str(
                event.get("id")
                or
                f"trend-{index}"
            ),
        "title":
            selection_compact_text(
                event.get("title"),
                450,
            ),
        "summary":
            selection_compact_text(
                event.get("summary"),
                850,
            ),
        "categories":
            list(
                event.get("categories")
                or
                ([event.get("category")] if event.get("category") else [])
            ),
        "country":
            clean_text(
                event.get("country", "")
            ),
        "region":
            clean_text(
                event.get("region", "")
            ),
        "city":
            clean_text(
                event.get("city", "")
            ),
        "first_reported":
            str(
                event.get("first_reported")
                or
                event.get("published")
                or
                ""
            ),
        "last_reported":
            str(
                event.get("last_reported")
                or
                event.get("published")
                or
                ""
            ),
        "ai_relevance_score":
            int(
                event.get("ai_relevance_score", 0)
                or
                0
            ),
        "source_count":
            int(
                event.get("source_count", 1)
                or
                1
            ),
        "article_count":
            int(
                event.get("article_count", 1)
                or
                1
            ),
        "primary_source":
            clean_text(
                event.get("source", "")
            ),
    }


def _trend_fallback(candidates, generated_at, reason=""):
    developments = []

    for event in candidates[:5]:
        relevance = int(
            event.get(
                "ai_relevance_score",
                0,
            )
            or
            0
        )

        if relevance >= 90:
            severity = "HIGH"
        else:
            severity = "SIGNIFICANT"

        categories = list(
            event.get("categories")
            or
            ([event.get("category")] if event.get("category") else [])
        )

        location = ", ".join(
            value
            for value in [
                clean_text(event.get("city", "")),
                clean_text(event.get("region", "")),
                clean_text(event.get("country", "")),
            ]
            if value
        )

        developments.append(
            {
                "event_id": str(
                    event.get("id")
                    or
                    event.get("_mapKey")
                    or
                    ""
                ),
                "severity": severity,
                "category": (
                    categories[0]
                    if categories
                    else
                    "CT Development"
                ),
                "headline": selection_compact_text(
                    event.get("title"),
                    220,
                ),
                "detail": selection_compact_text(
                    event.get("summary"),
                    420,
                ),
                "location": location,
            }
        )

    return {
        "status": "fallback",
        "model": AI_TREND_MODEL,
        "window_hours": 24,
        "generated_at": generated_at,
        "candidate_events": len(candidates),
        "overview": (
            "AI trend synthesis was unavailable for this update. "
            "The highest-relevance CT events reported or updated in the last "
            "24 hours are shown below without additional analytical synthesis."
        ),
        "developments": developments,
        "warning": reason,
    }


def generate_24h_trend_summary(events):
    generated_at = datetime.now(
        timezone.utc
    ).isoformat()

    cutoff = datetime.now(
        timezone.utc
    ) - timedelta(
        hours=24
    )

    recent = []

    for event in events:
        recency = _trend_recency(
            event
        )

        if (
            recency is not None
            and
            recency >= cutoff
        ):
            recent.append(
                event
            )

    recent.sort(
        key=_trend_priority,
        reverse=True,
    )

    recent = recent[
        :AI_TREND_MAX_CANDIDATES
    ]

    print()
    print("=" * 70)
    print("GEMINI 24H SENSITIVE TREND SUMMARY")
    print("=" * 70)
    print(
        f"Recent candidate events: {len(recent)}"
    )
    print(
        f"Trend model: {AI_TREND_MODEL}"
    )

    if not recent:
        print(
            "No CT events reported/updated in the last 24 hours."
        )

        return {
            "status": "ok",
            "model": AI_TREND_MODEL,
            "window_hours": 24,
            "generated_at": generated_at,
            "candidate_events": 0,
            "overview": (
                "No significant CT developments were available for the "
                "24-hour trend brief at the time of this update."
            ),
            "developments": [],
        }

    api_key = os.getenv(
        "GEMINI_API_KEY"
    )

    if not api_key:
        print(
            "Trend summary fallback: GEMINI_API_KEY unavailable."
        )
        return _trend_fallback(
            recent,
            generated_at,
            "GEMINI_API_KEY unavailable",
        )

    batch = [
        _trend_payload(
            event,
            index,
        )
        for index, event in enumerate(
            recent
        )
    ]

    body = {
        "model": AI_TREND_MODEL,
        "input": (
            "Produce the 24-hour sensitive CT developments brief from the "
            "deduplicated events below. Use only these records.\n\n"
            +
            json.dumps(
                {"events": batch},
                ensure_ascii=False,
            )
        ),
        "system_instruction": AI_TREND_INSTRUCTIONS,
        "store": False,
        "response_format": {
            "type": "text",
            "mime_type": "application/json",
            "schema": AI_TREND_SCHEMA,
        },
        "generation_config": {
            "max_output_tokens": 8000,
            "thinking_level": "minimal",
        },
    }

    headers = {
        "x-goog-api-key": api_key,
        "Content-Type": "application/json",
    }

    last_error = None

    for attempt in range(
        1,
        AI_TREND_ATTEMPTS + 1,
    ):
        try:
            response = requests.post(
                GEMINI_INTERACTIONS_URL,
                headers=headers,
                json=body,
                timeout=AI_TREND_TIMEOUT,
            )

            if response.status_code == 429:
                last_error = "Gemini trend quota exceeded (429)"
                print(
                    f"   Trend attempt {attempt}/{AI_TREND_ATTEMPTS}: 429"
                )
                time.sleep(
                    attempt * 5
                )
                continue

            if response.status_code >= 500:
                last_error = (
                    "Gemini trend temporary error "
                    f"{response.status_code}"
                )
                print(
                    f"   Trend attempt {attempt}/{AI_TREND_ATTEMPTS}: "
                    f"HTTP {response.status_code}"
                )
                time.sleep(
                    attempt * 4
                )
                continue

            response.raise_for_status()

            output_text = extract_interaction_text(
                response.json()
            )

            result = json.loads(
                output_text
            )

            developments = result.get(
                "developments",
                []
            )

            if not isinstance(
                developments,
                list,
            ):
                developments = []

            result[
                "developments"
            ] = developments[:6]

            result.update(
                {
                    "status": "ok",
                    "model": AI_TREND_MODEL,
                    "window_hours": 24,
                    "generated_at": generated_at,
                    "candidate_events": len(recent),
                }
            )

            print(
                f"Trend summary generated: {len(result['developments'])} "
                "priority developments."
            )

            return result

        except Exception as error:
            last_error = str(
                error
            )
            print(
                f"   Trend attempt {attempt}/{AI_TREND_ATTEMPTS} failed: "
                f"{error}"
            )
            time.sleep(
                attempt * 3
            )

    print(
        "Trend summary AI unavailable; using safe fallback."
    )

    return _trend_fallback(
        recent,
        generated_at,
        last_error or "Unknown Gemini trend error",
    )




def load_existing_weekly_analysis():
    try:
        with open(
            OUTPUT_FILE,
            "r",
            encoding="utf-8",
        ) as file:
            data = json.load(
                file
            )

        weekly = data.get(
            "weekly_analysis"
        )

        return (
            weekly
            if isinstance(
                weekly,
                dict,
            )
            else
            {}
        )

    except Exception:
        return {}


def _weekly_event_time(event):
    """
    Prefer explicit occurrence/incident dates when available.
    Fall back to the event's report/update recency so the weekly analysis
    remains usable for records that do not yet carry a structured event date.
    """
    for field in (
        "event_date",
        "occurrence_date",
        "occurred_at",
        "incident_date",
        "attack_date",
    ):
        dt = _parse_iso_utc(
            event.get(
                field
            )
        )

        if dt is not None:
            return dt

    return _trend_recency(
        event
    )


def _weekly_geo_breakdown(events, field_name, limit=8):
    """
    Incident-based geographic picture. Raw records/articles never determine
    operational significance. Distinct incident_id values are counted once,
    with attacks counted only when is_attack is explicitly true.
    """
    records = Counter()
    incident_sets = defaultdict(lambda: defaultdict(set))

    for event in events:
        location = clean_text(event.get(field_name, ""))
        if not location:
            continue

        records[location] += 1
        incident_id = clean_text(event.get("incident_id") or event.get("id") or "")
        if not incident_id:
            continue

        primary = clean_text(event.get("primary_event_type") or "OTHER_CT").upper()
        if bool(event.get("is_attack")) and primary == "ATTACK":
            incident_sets[location]["ATTACK"].add(incident_id)
        elif primary in {
            "CT_OPERATION", "ATTEMPTED_ATTACK", "DISRUPTED_PLOT", "ARREST",
            "JUDICIAL", "FINANCING", "WEAPONS", "ONLINE_CYBER_AI", "CBRN",
            "PIRACY", "OTHER_CT",
        }:
            incident_sets[location][primary].add(incident_id)

    def count(location, kind):
        return len(incident_sets[location].get(kind, set()))

    ranked = sorted(
        records.keys(),
        key=lambda location: (
            -count(location, "ATTACK"),
            -count(location, "CT_OPERATION"),
            -count(location, "DISRUPTED_PLOT"),
            location,
        ),
    )[:limit]

    return [
        {
            "name": location,
            "unique_attacks": count(location, "ATTACK"),
            "attempted_attacks": count(location, "ATTEMPTED_ATTACK"),
            "disrupted_plots": count(location, "DISRUPTED_PLOT"),
            "unique_ct_operations": count(location, "CT_OPERATION"),
            "arrest_cases": count(location, "ARREST"),
            "judicial_cases": count(location, "JUDICIAL"),
            "financing_cases": count(location, "FINANCING"),
            "weapons_cases": count(location, "WEAPONS"),
            "reporting_records": records[location],
        }
        for location in ranked
    ]


def _weekly_category_counts(events):
    counter = Counter()

    for event in events:
        categories = (
            event.get(
                "categories"
            )
            or
            (
                [
                    event.get(
                        "category"
                    )
                ]
                if event.get(
                    "category"
                )
                else
                []
            )
        )

        for category in set(
            categories
        ):
            if category:
                counter[
                    category
                ] += 1

    return dict(
        counter
    )


def _weekly_stats(events):
    return {
        "event_count":
            len(
                events
            ),
        "categories":
            _weekly_category_counts(
                events
            ),
        "top_countries_by_incident_activity":
            _weekly_geo_breakdown(
                events,
                "country",
                10,
            ),
        "top_regions_by_incident_activity":
            _weekly_geo_breakdown(
                events,
                "region",
                8,
            ),
    }


def _weekly_compact_event(event, index):
    return {
        "event_id":
            str(
                event.get(
                    "id"
                )
                or
                f"weekly-{index}"
            ),
        "title":
            selection_compact_text(
                event.get(
                    "title"
                ),
                320,
            ),
        "summary":
            selection_compact_text(
                event.get(
                    "summary"
                ),
                600,
            ),
        "categories":
            list(
                event.get(
                    "categories"
                )
                or
                (
                    [
                        event.get(
                            "category"
                        )
                    ]
                    if event.get(
                        "category"
                    )
                    else
                    []
                )
            ),
        "country":
            clean_text(
                event.get(
                    "country",
                    ""
                )
            ),
        "region":
            clean_text(
                event.get(
                    "region",
                    ""
                )
            ),
        "city":
            clean_text(
                event.get(
                    "city",
                    ""
                )
            ),
        "event_or_report_time":
            (
                _weekly_event_time(
                    event
                ).isoformat()
                if _weekly_event_time(
                    event
                )
                else
                ""
            ),
        "ai_relevance_score":
            int(
                event.get(
                    "ai_relevance_score",
                    0,
                )
                or
                0
            ),
        "source_count":
            int(
                event.get(
                    "source_count",
                    1,
                )
                or
                1
            ),
        "primary_event_type":
            clean_text(
                event.get(
                    "primary_event_type",
                    ""
                )
            ),
        "incident_id":
            clean_text(
                event.get(
                    "incident_id",
                    ""
                )
            ),
        "is_attack":
            bool(
                event.get(
                    "is_attack",
                    False
                )
            ),
        "canonical_event":
            selection_compact_text(
                event.get(
                    "ai_canonical_event",
                    ""
                ),
                360,
            ),
        "actor_or_group":
            selection_compact_text(
                event.get("group")
                or event.get("actor")
                or event.get("organization")
                or event.get("perpetrator")
                or "",
                180,
            ),
        "target":
            selection_compact_text(
                event.get("target")
                or event.get("target_type")
                or "",
                180,
            ),
        "tactics_or_weapons":
            selection_compact_text(
                event.get("modus_operandi")
                or event.get("attack_type")
                or event.get("weapons")
                or event.get("weapon")
                or "",
                220,
            ),
        "primary_source":
            clean_text(
                event.get(
                    "source",
                    ""
                )
            ),
    }


def _weekly_windows(events):
    now_utc = datetime.now(
        timezone.utc
    )

    current_start = (
        now_utc
        -
        timedelta(
            days=7
        )
    )

    previous_start = (
        now_utc
        -
        timedelta(
            days=14
        )
    )

    current = []
    previous = []

    for event in events:
        dt = _weekly_event_time(
            event
        )

        if dt is None:
            continue

        if (
            current_start
            <=
            dt
            <=
            now_utc
        ):
            current.append(
                event
            )

        elif (
            previous_start
            <=
            dt
            <
            current_start
        ):
            previous.append(
                event
            )

    current.sort(
        key=_trend_priority,
        reverse=True,
    )

    previous.sort(
        key=_trend_priority,
        reverse=True,
    )

    return {
        "now":
            now_utc,
        "current_start":
            current_start,
        "previous_start":
            previous_start,
        "current":
            current,
        "previous":
            previous,
    }


def _weekly_sunday_key(now_paris):
    return now_paris.date().isoformat()


WEEKLY_REQUIRED_SECTIONS = (
    "EXECUTIVE ASSESSMENT",
    "KEY CHANGES",
    "GEOGRAPHIC / OPERATIONAL SHIFTS",
    "SIGNIFICANT DEVELOPMENTS",
    "OUTLOOK / WATCHPOINTS",
)


def _weekly_analysis_quality_issue(analysis):
    text = clean_text(analysis)
    upper = text.upper()

    if not text:
        return "empty analysis"

    missing = [
        section
        for section in WEEKLY_REQUIRED_SECTIONS
        if section not in upper
    ]
    if missing:
        return "missing required section(s): " + ", ".join(missing)

    words = re.findall(r"\b[\w'’-]+\b", text)
    if len(words) < 600:
        return f"analysis is too short ({len(words)} words); analytical depth is insufficient"

    reporting_terms = re.findall(
        r"\b(?:articles?|source[_ ]?counts?|event[_ ]?counts?|reporting volume|reports? increased|reports? decreased)\b",
        text,
        flags=re.IGNORECASE,
    )
    if len(reporting_terms) > 4:
        return "report is too dependent on article/reporting counts rather than operational assessment"

    analytical_markers = re.findall(
        r"\b(?:indicat(?:e|es|ed)|suggest(?:s|ed)?|reflect(?:s|ed)?|"
        r"consistent with|operational(?:ly)?|significance|implication|"
        r"shift|continuity|adaptation|dispersion|concentration|disruption|"
        r"capability|vulnerability|pattern|trajectory|watchpoint)\b",
        text,
        flags=re.IGNORECASE,
    )
    if len(analytical_markers) < 8:
        return "report is too descriptive; it lacks explicit analytical interpretation"

    return ""


def should_generate_weekly_analysis(existing_weekly):
    """
    First-ever report: generate immediately on the next collector run.

    Subsequent reports:
      Sunday after 06:00 Europe/Paris.
      If 06:17 generation fails, the report key remains old/missing, so
      the 12:17 and 18:17 Sunday runs automatically retry.
    """
    if not existing_weekly:
        return True, "first_report"

    if existing_weekly.get("version") != AI_WEEKLY_VERSION:
        return True, "analytical_quality_upgrade"

    now_paris = datetime.now(
        PARIS_TZ
    )

    if (
        now_paris.weekday()
        !=
        6
    ):
        return False, "not_sunday"

    if (
        now_paris.hour
        <
        6
    ):
        return False, "before_second_sunday_update"

    expected_key = _weekly_sunday_key(
        now_paris
    )

    if (
        existing_weekly.get(
            "sunday_key"
        )
        ==
        expected_key
    ):
        return False, "already_generated_this_sunday"

    return True, "scheduled_sunday"


def generate_weekly_analysis(events, existing_weekly=None):
    existing_weekly = (
        existing_weekly
        if isinstance(
            existing_weekly,
            dict,
        )
        else
        {}
    )

    should_generate, reason = should_generate_weekly_analysis(
        existing_weekly
    )

    if not should_generate:
        print()
        print("=" * 70)
        print("WEEKLY ANALYSIS")
        print("=" * 70)
        print(
            f"No weekly generation required: {reason}"
        )
        return existing_weekly

    windows = _weekly_windows(
        events
    )

    now_utc = windows[
        "now"
    ]

    current = windows[
        "current"
    ]

    previous = windows[
        "previous"
    ]

    now_paris = datetime.now(
        PARIS_TZ
    )
    print()
    print("=" * 70)
    print("GEMINI WEEKLY CT CRIMINAL ANALYSIS")
    print("=" * 70)
    print(
        f"Trigger: {reason}"
    )
    print(
        f"Current 7-day events: {len(current)}"
    )
    print(
        f"Previous 7-day events: {len(previous)}"
    )

    api_key = os.getenv(
        "GEMINI_API_KEY"
    )

    if not api_key:
        print(
            "Weekly analysis not generated: GEMINI_API_KEY unavailable."
        )
        return existing_weekly

    current_payload = [
        _weekly_compact_event(
            event,
            index,
        )
        for index, event in enumerate(
            current[
                :AI_WEEKLY_MAX_CURRENT_EVENTS
            ]
        )
    ]

    previous_payload = [
        _weekly_compact_event(
            event,
            index,
        )
        for index, event in enumerate(
            previous[
                :AI_WEEKLY_MAX_PREVIOUS_EVENTS
            ]
        )
    ]

    payload = {
        "reporting_period": {
            "current_start":
                windows[
                    "current_start"
                ].isoformat(),
            "current_end":
                now_utc.isoformat(),
            "comparison_start":
                windows[
                    "previous_start"
                ].isoformat(),
            "comparison_end":
                windows[
                    "current_start"
                ].isoformat(),
        },
        "current_period_stats":
            _weekly_stats(
                current
            ),
        "comparison_period_stats":
            _weekly_stats(
                previous
            ),
        "current_priority_events":
            current_payload,
        "comparison_priority_events":
            previous_payload,
    }

    base_input = (
        "Produce the weekly comparative CT criminal-analysis assessment using "
        "only the supplied data. Treat the statistics as diagnostic context, "
        "not as findings. Build the assessment from the underlying distinct "
        "incidents and explain operational meaning.\n\n"
        +
        json.dumps(
            payload,
            ensure_ascii=False,
        )
    )

    body = {
        "model":
            AI_WEEKLY_MODEL,
        "input":
            base_input,
        "system_instruction":
            AI_WEEKLY_INSTRUCTIONS,
        "store":
            False,
        "response_format": {
            "type":
                "text",
            "mime_type":
                "application/json",
            "schema":
                AI_WEEKLY_SCHEMA,
        },
        "generation_config": {
            "max_output_tokens":
                9000,
            "thinking_level":
                "minimal",
        },
    }

    headers = {
        "x-goog-api-key":
            api_key,
        "Content-Type":
            "application/json",
    }

    last_error = None

    for attempt in range(
        1,
        AI_WEEKLY_ATTEMPTS + 1,
    ):
        try:
            response = requests.post(
                GEMINI_INTERACTIONS_URL,
                headers=headers,
                json=body,
                timeout=AI_WEEKLY_TIMEOUT,
            )

            if response.status_code == 429:
                last_error = "Gemini weekly quota exceeded (429)"
                print(
                    f"Weekly attempt {attempt}/{AI_WEEKLY_ATTEMPTS}: 429"
                )
                time.sleep(
                    attempt
                    *
                    7
                )
                continue

            if response.status_code >= 500:
                last_error = (
                    "Gemini weekly temporary error "
                    f"{response.status_code}"
                )
                print(
                    f"Weekly attempt {attempt}/{AI_WEEKLY_ATTEMPTS}: "
                    f"HTTP {response.status_code}"
                )
                time.sleep(
                    attempt
                    *
                    5
                )
                continue

            response.raise_for_status()

            result = json.loads(
                extract_interaction_text(
                    response.json()
                )
            )

            title = selection_compact_text(
                result.get(
                    "title"
                ),
                180,
            )

            analysis = clean_text(
                result.get(
                    "analysis"
                )
            )

            if not analysis:
                raise RuntimeError(
                    "Gemini weekly analysis returned no analysis text."
                )

            quality_issue = _weekly_analysis_quality_issue(
                analysis
            )
            if quality_issue:
                quality_feedback = quality_issue
                raise RuntimeError(
                    "Gemini weekly analysis failed analytical quality control: "
                    + quality_issue
                )

            weekly = {
                "status":
                    "ok",
                "version":
                    AI_WEEKLY_VERSION,
                "model":
                    AI_WEEKLY_MODEL,
                "generated_at":
                    now_utc.isoformat(),
                "sunday_key":
                    (
                        _weekly_sunday_key(
                            now_paris
                        )
                        if now_paris.weekday() == 6
                        else ""
                    ),
                "trigger":
                    reason,
                "title":
                    (
                        title
                        or
                        "Weekly CT Criminal Analysis"
                    ),
                "analysis":
                    analysis,
                "current_period_start":
                    windows[
                        "current_start"
                    ].isoformat(),
                "current_period_end":
                    now_utc.isoformat(),
                "comparison_period_start":
                    windows[
                        "previous_start"
                    ].isoformat(),
                "comparison_period_end":
                    windows[
                        "current_start"
                    ].isoformat(),
                "current_event_count":
                    len(
                        current
                    ),
                "comparison_event_count":
                    len(
                        previous
                    ),
            }

            print(
                "Weekly analysis generated successfully."
            )

            return weekly

        except Exception as error:
            last_error = str(
                error
            )
            print(
                f"Weekly attempt {attempt}/{AI_WEEKLY_ATTEMPTS} failed: "
                f"{error}"
            )
            time.sleep(
                attempt
                *
                4
            )

    print(
        "Weekly analysis generation failed. "
        "Previous report is preserved; a later eligible Sunday run can retry."
    )

    if last_error:
        print(
            f"Last weekly error: {last_error}"
        )

    return existing_weekly


def save_database(events, trend_summary=None, weekly_analysis=None):
    output = {
        "project":
            "INTERPOL CT Intelligence Map",
        "database_type":
            "Rolling CT situational awareness",
        "retention_days":
            RETENTION_DAYS,
        "default_map_period":
            30,
        "daily_lookback_days":
            DAILY_LOOKBACK_DAYS,
        "language":
            "English display; multilingual source collection",
        "source_languages":
            [
                "en", "fr", "ar", "de", "es", "it",
                "tr", "ru", "ur", "fa", "he", "ps"
            ],
        "collector":
            "Google News RSS multilingual + expanded Arabic/Africa and maritime/CBRN sources + Gemini selection/translation",
        "relevance_filter":
            "Deterministic CT candidate filter + Gemini semantic final selection",

        "trend_summary":
            trend_summary
            or
            {},

        "weekly_analysis":
            weekly_analysis
            or
            {},

        "ai_article_selection": {
            "enabled":
                AI_SELECTION_ENABLED,
            "model":
                AI_SELECTION_MODEL,
            "threshold":
                AI_SELECTION_THRESHOLD,
            "version":
                AI_SELECTION_VERSION,
        },
        "deduplication":
            "Multi-signal event clustering V4",
        "search_query_count":
            (
                sum(
                    len(terms)
                    for terms
                    in CORE_SEARCH_QUERIES.values()
                )
                +
                len(
                    OFFICIAL_BROAD_QUERIES
                )
                +
                sum(
                    len(
                        targeted_source_queries(
                            source
                        )
                    )
                    for source
                    in TARGETED_SOURCE_SITES
                )
                +
                multilingual_query_count()
            ),
        "general_search_query_count":
            sum(
                len(terms)
                for terms
                in CORE_SEARCH_QUERIES.values()
            ),
        "official_source_query_count":
            len(
                OFFICIAL_BROAD_QUERIES
            ),
        "targeted_source_query_count":
            sum(
                len(
                    targeted_source_queries(
                        source
                    )
                )
                for source
                in TARGETED_SOURCE_SITES
            ),
        "multilingual_query_count":
            multilingual_query_count(),
        "multilingual_languages":
            [
                profile[
                    "name"
                ]
                for profile
                in MULTILINGUAL_PROFILES
            ],
        "targeted_sources":
            [
                source[
                    "name"
                ]
                for source
                in TARGETED_SOURCE_SITES
            ],
        "multilingual_source_sites": {
            profile["name"]: list(profile.get("sites", []))
            for profile in MULTILINGUAL_PROFILES
        },
        "backfill_completed_queries": {
            **BACKFILL_COMPLETED_QUERIES, **BACKFILL_PENDING_QUERIES,
        },
        "incremental_collection_stats": dict(BACKFILL_STATS),
        "last_collection_scope": COLLECTION_SCOPE,
        "last_planned_query_count": planned_collection_query_count(),
        "specialist_coverage": {
            "maritime_sources": [name for name, site, kind in MARITIME_SOURCE_SITES],
            "cbrn_sources": [name for name, site, kind in CBRN_SOURCE_SITES],
            "acquisition": "Public Google News results; no direct incident-database API.",
            "category_hints": "Provisional; Gemini decides relevance and final categories.",
        },
        "country_focused_sources": {
            "Afghanistan": AFGHANISTAN_LOCAL_SOURCES,
            "Syria": SYRIA_LOCAL_SOURCES,
            "note": "Local and country-focused reporting, including exile-based media; publishers may have multiple language queries.",
        },
        "regional_coverage": {
            "arabic_target_sites": len(ARABIC_SOURCE_SITES),
            "africa_french_target_sites": len(AFRICA_FR_SOURCE_SITES),
            "africa_english_target_sites": len(AFRICA_EN_SOURCE_SITES),
            "note": "Discovery targets through Google News; indexing and yield vary by publisher.",
        },
        "acled_collection": {"status": "api_removed"},
        "acled_mode":
            "Public ACLED reporting via Google News only; no event-data API",
        "official_sources":
            [
                "U.S. Department of Justice",
                "U.S. Department of the Treasury / OFAC",
                "Counter Terrorism Policing UK",
                "Europol",
                "UK Government / Counter-Terrorism",
                "INTERPOL English News",
            ],
        "last_updated":
            datetime.now(
                timezone.utc
            ).isoformat(),
        "number_of_events":
            len(events),
        "events":
            events,
    }

    atomic_json_write(OUTPUT_FILE, output)


def main():
    global COLLECTION_SCOPE
    is_backfill, COLLECTION_SCOPE = parse_collection_mode()
    existing_weekly_analysis = load_existing_weekly_analysis()

    initialize_incremental_state(is_backfill)

    if is_backfill:
        print(
            "180-DAY INCREMENTAL BACKFILL MODE"
        )

        days = RETENTION_DAYS
        existing = load_existing()

    else:
        print(
            "DAILY UPDATE MODE"
        )

        days = DAILY_LOOKBACK_DAYS
        existing = load_existing()

        print(
            f"Existing database loaded: "
            f"{len(existing)} events"
        )

    # Progressive migration of the retained six-month database to the
    # incident/case model. Prioritise legacy records whose old category could
    # distort attack/CT-operation counts. ai_select_events mutates the supplied
    # event objects in place, so we keep the historical record even if a fresh
    # relevance decision would no longer select it.
    legacy_incident_records = [
        event for event in existing
        if not event.get("primary_event_type") or not event.get("incident_id")
    ]

    def _incident_backfill_priority(event):
        categories = set(event.get("categories") or ([event.get("category")] if event.get("category") else []))
        if "Attacks" in categories:
            tier = 0
        elif "Counter Terrorism Action" in categories:
            tier = 1
        elif "Arrests" in categories:
            tier = 2
        elif "Legal / Judicial" in categories:
            tier = 3
        else:
            tier = 4
        dt = event_datetime(event) or datetime.min.replace(tzinfo=timezone.utc)
        return (tier, -dt.toordinal())

    if legacy_incident_records:
        legacy_incident_records.sort(key=_incident_backfill_priority)
        incident_backfill_batch = legacy_incident_records[:120]
        print(
            f"Incident-model migration: reclassifying {len(incident_backfill_batch)} "
            f"of {len(legacy_incident_records)} legacy records (attack-related first)."
        )
        migrated = ai_select_events(incident_backfill_batch)
        if migrated is None:
            print("Incident-model migration incomplete this run; preserving existing records and retrying later.")
        else:
            print("Incident-model migration batch completed.")

    fresh = exclude_reviewed_articles(collect_all(days), existing)

    print()
    print(
        f"Collection returned "
        f"{len(fresh)} deterministic candidate records."
    )

    # --------------------------------------------------------
    # Deduplicate BEFORE AI review.
    #
    # This prevents Gemini from reviewing 30-50 copies of the same
    # underlying story found through different Google News searches.
    # --------------------------------------------------------

    print()
    print(
        "Clustering fresh candidate records before AI selection..."
    )

    fresh_clusters = deduplicate_events(
        fresh
    )

    print(
        f"Fresh candidate event clusters: "
        f"{len(fresh_clusters)}"
    )

    selected_fresh = ai_select_events(
        fresh_clusters
    )

    if selected_fresh is None:
        print()
        print("=" * 70)
        print("COLLECTION PAUSED — AI SELECTION INCOMPLETE")
        print("=" * 70)
        print(
            "events.json has not been replaced."
        )
        print(
            f"Progress is preserved in "
            f"{AI_SELECTION_CACHE_FILE}."
        )

        # Non-zero exit lets the workflow stop before geolocation.
        # A dedicated `if: always()` workflow step commits the cache.
        raise SystemExit(
            75
        )

    print()
    print(
        f"Gemini selected "
        f"{len(selected_fresh)}/"
        f"{len(fresh_clusters)} "
        f"candidate event clusters."
    )

    # Gemini has now normalized every retained candidate into English. Run the
    # smart deduplicator again so French/Arabic/German/etc. reports of the same
    # event can converge into one multilingual event cluster.
    print()
    print(
        "Cross-language deduplication on AI-normalized English events..."
    )

    selected_fresh = deduplicate_events(
        selected_fresh
    )

    print(
        f"Post-translation event clusters: "
        f"{len(selected_fresh)}"
    )

    print("Merging new selected events into the existing database, preserving coordinates.")
    events = deduplicate_incremental(existing, selected_fresh)

    events = prune_old(
        events
    )

    events.sort(
        key=lambda event:
            event.get(
                "published",
                "",
            ),
        reverse=True,
    )

    trend_summary = generate_24h_trend_summary(
        events
    )

    weekly_analysis = generate_weekly_analysis(
        events,
        existing_weekly=existing_weekly_analysis,
    )

    save_database(
        events,
        trend_summary=trend_summary,
        weekly_analysis=weekly_analysis,
    )
    print()
    print("=" * 70)
    print("COLLECTION COMPLETE")
    print("=" * 70)
    print(
        f"Database events: "
        f"{len(events)}"
    )
    print(
        f"Retention: "
        f"{RETENTION_DAYS} days"
    )
    print(
        f"Search queries: "
        f"{planned_collection_query_count()}"
    )
    print(
        f"AI article threshold: "
        f"{AI_SELECTION_THRESHOLD}/100"
    )
    print(
        f"Saved to: "
        f"{OUTPUT_FILE}"
    )
    print("=" * 70)


if __name__ == "__main__":
    main()