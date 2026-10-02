#!/usr/bin/env python3
"""Enrich the background archive with the last six months of reporting the
daily collection never reviewed: languages it does not search (Hindi, Bengali,
Indonesian, Mozambique Portuguese, Somali, Hausa), GDELT's Persian, Urdu,
Pashto, Hausa, Somali and Swahili sources, and week-by-week searches of the
languages it does.

Each run works through a fixed plan of tasks (one search over one week),
most valuable first: the new languages, then GDELT, then the daily profiles'
own queries, then English; newest week first within each group. A week joins
the plan once it ended SETTLE_DAYS ago (newer reporting is the daily
collection's), so every task is searched once and finished. The new
languages and GDELT keep going week after week; the daily profiles' queries
and English only cover the weeks before the collection's own reviews start
(REPLAY_UNTIL): after that, the collection and its overflow review them.
A search that comes back full (Google News stops at 100 items, GDELT at 250)
is split into shorter windows rather than cut short.

The run searches only as much as it can review: candidates go to the map's
own Gemini selection (tools/archive_review.py: Gemini 3.1 Flash Lite, at
most --max-posts requests a run and ENRICH_DAILY_POSTS a Pacific day, 6 s
apart). Before Gemini, a candidate is skipped when the repository already
holds the article (map events and their other reports, archive files), when
the collection or the enrichment already reviewed it, and when the
collector's own rules reject it (out-of-scope headlines, opinion pieces).

Output, saved after every batch:
  archive/enriched-articles-<UTC date>.json  reviews scoring above 0, which the
      nightly sync files as archived incidents (the map's threshold or more)
      or reporting outside the map's scope, one copy per story;
  archive/enrichment-seen-<UTC date>.txt  articles reviewed and found
      off-topic (or never answered): never sent to Gemini again;
  archive/enrichment-state.json  finished tasks and per-language statistics;
  quota/gemini-3.1-enrichment.json  this Pacific day's requests.

A task is finished once its search succeeded and every candidate it found
was reviewed or skipped. A search that failed leaves its task for the next
run. The daily collection, events.json and the selection cache are never
written.

    GEMINI_API_KEY=... py -3.11 tools/enrich_archive.py [--max-posts N] [--max-fetches N] [--dry-run]
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import os
import sys
import time
import unicodedata
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote_plus, urlencode

sys.path.insert(0, str(Path(__file__).resolve().parent))
import archive_review  # noqa: E402

ROOT = archive_review.ROOT
STATE_FILE = "archive/enrichment-state.json"
STATE_VERSION = 2
# Monday of the first week searched (the map's 180-day window began in April).
FIRST_WEEK = date(2026, 3, 30)
WEEK = timedelta(days=7)
# A week is planned once it ended this long ago; the daily collection (which
# looks three days back) covers anything newer.
SETTLE_DAYS = 3
MAX_POSTS = int(os.getenv("ENRICH_MAX_POSTS", "100"))
DAILY_POSTS = int(os.getenv("ENRICH_DAILY_POSTS", "100"))
MAX_FETCHES = int(os.getenv("ENRICH_MAX_FETCHES", "300"))
DEADLINE_MINUTES = float(os.getenv("ENRICH_DEADLINE_MINUTES", "110"))
GOOGLE_SPACING_SECONDS = float(os.getenv("ENRICH_GOOGLE_SPACING_SECONDS", "3"))
GDELT_SPACING_SECONDS = float(os.getenv("ENRICH_GDELT_SPACING_SECONDS", "10"))
# Consecutive refusals after which a source is left alone for the rest of the run.
MAX_CONSECUTIVE_FAILURES = 3
# Runs a task may fail before it is given up (recorded in the statistics).
MAX_TASK_FAILURES = 4
# The daily collection's selection cache holds every review since this day:
# the daily profiles' queries and English are only replayed before it.
REPLAY_UNTIL = date(2026, 9, 1)
# A search returning this many items was cut short by the source.
GOOGLE_FULL = 95
GDELT_MAX_RECORDS = 250
# GDELT answers its rate limit in plain text ("Please limit requests to one
# every 5 seconds ..."); any other plain text is a rejected query.
GDELT_RATE_LIMIT_TEXT = "limit requests to one every"

# Languages the daily collection does not search. Somali and Hausa have no
# Google News edition of their own: their own-language queries run on the
# English edition Google redirects to, like the collector's Dari/Pashto ones.
NEW_LANGUAGE_PROFILES = [
    {"code": "hi", "name": "Hindi", "hl": "hi", "gl": "IN", "ceid": "IN:hi", "queries": [
        {"term": "(आतंकी OR आतंकवादी OR आतंकवाद) (हमला OR धमाका OR मुठभेड़)", "category": "Attacks"},
        {"term": "(आतंकी OR आतंकवादी) (गिरफ्तार OR साजिश OR मॉड्यूल OR NIA)", "category": "Arrests"},
        {"term": "(नक्सली OR माओवादी) (हमला OR मुठभेड़ OR IED)", "category": "Attacks"},
    ]},
    {"code": "bn", "name": "Bengali", "hl": "bn", "gl": "BD", "ceid": "BD:bn", "queries": [
        {"term": "(জঙ্গি OR সন্ত্রাসী OR সন্ত্রাসবাদ) (হামলা OR বিস্ফোরণ OR নিহত)", "category": "Attacks"},
        {"term": "(জঙ্গি OR সন্ত্রাসী) (গ্রেপ্তার OR গ্রেফতার OR আটক)", "category": "Arrests"},
    ]},
    {"code": "id", "name": "Indonesian", "hl": "id", "gl": "ID", "ceid": "ID:id", "queries": [
        {"term": "(teroris OR terorisme OR \"Densus 88\") (serangan OR bom OR ditangkap)", "category": "Attacks"},
        {"term": "(KKB OR OPM) (serangan OR tembak OR tewas)", "category": "Attacks"},
        {"term": "(JAD OR \"Jamaah Islamiyah\" OR ISIS) (ditangkap OR jaringan OR teroris)", "category": "Arrests"},
    ]},
    {"code": "pt", "name": "Portuguese / Mozambique", "hl": "pt-PT", "gl": "PT", "ceid": "PT:pt-150", "queries": [
        {"term": "(\"Cabo Delgado\" OR Moçambique) (insurgentes OR terroristas OR jihadistas OR ataque)", "category": "Attacks"},
        {"term": "(Niassa OR Nampula OR Mocímboa OR Macomia) (ataque OR insurgentes OR terroristas)", "category": "Attacks"},
    ]},
    {"code": "so", "name": "Somali", "hl": "en-US", "gl": "US", "ceid": "US:en", "queries": [
        {"term": "(Al-Shabaab OR Shabaab) (weerar OR qarax OR dagaal OR dilay)", "category": "Attacks"},
        {"term": "(argagixiso OR argagixisada) (weerar OR qarax OR xabsi)", "category": "Attacks"},
    ]},
    # No Swahili: Google News returned nothing for Swahili terms on any edition
    # (US, KE, TZ; tested 2026-10-02). GDELT's swahili sources are searched below.
    {"code": "ha", "name": "Hausa", "hl": "en-NG", "gl": "NG", "ceid": "NG:en", "queries": [
        {"term": "(\"Boko Haram\" OR ISWAP OR \"'yan ta'adda\") (hari OR kashe OR sace)", "category": "Attacks"},
        {"term": "(\"'yan bindiga\" OR ta'addanci) (hari OR kashe OR sace)", "category": "Attacks"},
    ]},
]

# GDELT's translingual index matches these English terms in each source
# language's machine translation.
GDELT_TERMS = ("(terrorist OR terrorism OR militants OR jihadist OR \"suicide bombing\" "
               "OR \"Islamic State\" OR insurgents)")
GDELT_LANGUAGES = [
    {"sourcelang": "persian", "code": "fa", "name": "Persian"},
    {"sourcelang": "urdu", "code": "ur", "name": "Urdu"},
    {"sourcelang": "pashto", "code": "ps", "name": "Pashto"},
    {"sourcelang": "hausa", "code": "ha", "name": "Hausa"},
    {"sourcelang": "somali", "code": "so", "name": "Somali"},
    {"sourcelang": "swahili", "code": "sw", "name": "Swahili"},
]

ENGLISH_PROFILE = {"code": "en", "name": "English", "hl": "en-US", "gl": "US", "ceid": "US:en", "queries": [
    {"term": "(terrorist OR terrorism OR jihadist) (attack OR bombing OR killed)", "category": "Attacks"},
    {"term": "(\"terror plot\" OR \"terrorism charges\" OR \"terrorist arrested\" OR \"terror suspect\")", "category": "Arrests"},
    {"term": "(\"Islamic State\" OR ISIS OR \"al-Qaeda\" OR al-Shabaab OR JNIM OR ISWAP) (attack OR killed OR ambush)",
     "category": "Attacks"},
    {"term": "(piracy OR pirates) (vessel OR ship OR hijacked OR boarded)", "category": "Maritime Piracy"},
]}


# ---------------------------------------------------------------- the plan

def week_starts(today):
    """Mondays from FIRST_WEEK to the last week that ended SETTLE_DAYS ago,
    newest first."""
    weeks = []
    start = FIRST_WEEK
    while start + WEEK + timedelta(days=SETTLE_DAYS) <= today:
        weeks.append(start)
        start += WEEK
    return list(reversed(weeks))


def task_key(task):
    """Stable across deployments: the search itself and its window, nothing else."""
    parts = [task["source"], task["locale"], task["query"], task["week"]]
    if task.get("start"):
        parts.append(f"{task['start']}/{task['end']}")
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:16]


def plan_tasks(today, collector):
    """Every task, most valuable first."""
    weeks = week_starts(today)

    def replayed(tasks):
        """Weeks before the collection's own reviews."""
        return [task for task in tasks if date.fromisoformat(task["week"]) + WEEK <= REPLAY_UNTIL]

    def google_tasks(profiles, group):
        return [
            {"group": group, "source": "google", "week": week.isoformat(),
             "locale": f"{profile['hl']}|{profile['gl']}|{profile['ceid']}",
             "query": query["term"], "category": query.get("category") or "Attacks",
             "code": profile["code"], "name": profile["name"],
             "hl": profile["hl"], "gl": profile["gl"], "ceid": profile["ceid"]}
            for week in weeks for profile in profiles for query in profile.get("queries") or []
        ]

    groups = [
        google_tasks(NEW_LANGUAGE_PROFILES, "new_language"),
        # Week by week across the languages: one rejected query cannot fill
        # the run's consecutive-failure window by itself.
        [{"group": "gdelt", "source": "gdelt", "week": week.isoformat(), "locale": language["sourcelang"],
          "query": f"{GDELT_TERMS} sourcelang:{language['sourcelang']}", "category": "Attacks",
          "code": language["code"], "name": language["name"]}
         for week in weeks for language in GDELT_LANGUAGES],
        replayed(google_tasks(collector.MULTILINGUAL_PROFILES, "daily_profile")),
        replayed(google_tasks([ENGLISH_PROFILE], "english")),
    ]
    tasks = [task for group in groups for task in group]
    for task in tasks:
        task["key"] = task_key(task)
    return tasks


def window(task):
    if task.get("start"):
        return date.fromisoformat(task["start"]), date.fromisoformat(task["end"])
    start = date.fromisoformat(task["week"])
    return start, start + WEEK


def split(task):
    """Two shorter searches covering a window a source cut short, or [] when
    the window is a single day already."""
    start, end = window(task)
    days = (end - start).days
    if days <= 1:
        return []
    middle = start + timedelta(days=(days + 1) // 2)
    children = []
    for low, high in ((start, middle), (middle, end)):
        child = {key: value for key, value in task.items() if key != "key"}
        child.update({"start": low.isoformat(), "end": high.isoformat()})
        child["key"] = task_key(child)
        children.append(child)
    return children


# ---------------------------------------------------------------- searching

def google_url(collector, task):
    start, end = window(task)
    # before: is exclusive; one extra day catches late time zones (the
    # window check below trims what falls outside).
    query = f"{task['query']} after:{start.isoformat()} before:{(end + timedelta(days=1)).isoformat()}"
    return (f"{collector.GOOGLE_NEWS_BASE}?q={quote_plus(query)}"
            f"&hl={task['hl']}&gl={task['gl']}&ceid={task['ceid']}")


def gdelt_url(collector, task):
    start, end = window(task)
    params = {
        "query": task["query"], "mode": "artlist", "format": "json", "maxrecords": str(GDELT_MAX_RECORDS),
        "startdatetime": start.strftime("%Y%m%d000000"), "enddatetime": end.strftime("%Y%m%d000000"),
    }
    return collector.GDELT_DOC_SEARCH_URL + "?" + urlencode(params)


class SourceUnavailable(RuntimeError):
    """The source refused or failed: the task stays open for the next run."""


class QueryRejected(RuntimeError):
    """GDELT rejected the query itself: retrying it would fail the same way."""


class Searcher:
    def __init__(self, collector, sleep=time.sleep, clock=time.monotonic):
        self.collector = collector
        self.sleep = sleep
        self.clock = clock
        self.last = {}
        self.failures = {"google": 0, "gdelt": 0}
        self.fetches = 0

    def available(self, source):
        return self.failures[source] < MAX_CONSECUTIVE_FAILURES

    def _space(self, source, seconds):
        last = self.last.get(source)
        if last is not None:
            wait = last + seconds - self.clock()
            if wait > 0:
                self.sleep(wait)
        self.last[source] = self.clock()

    def _failed(self, source, message):
        self.failures[source] += 1
        raise SourceUnavailable(message)

    def search(self, task):
        """(candidate events, full) for a task; full when the source sent as
        many items as it ever does, so the window may hold more. Raises
        SourceUnavailable when the source failed (retry next run) and
        QueryRejected when the query is at fault (do not retry)."""
        self.fetches += 1
        if task["source"] == "gdelt":
            return self._gdelt(task)
        return self._google(task)

    def _google(self, task):
        collector = self.collector
        self._space("google", GOOGLE_SPACING_SECONDS)
        response = collector.request_google_news(google_url(collector, task), label=f"enrichment {task['name']}")
        if response is None:
            self._failed("google", "Google News did not answer.")
        feed = collector.feedparser.parse(response.content)
        if not getattr(feed, "version", "") and not feed.entries:
            self._failed("google", "Google News sent something that is not a feed.")
        self.failures["google"] = 0
        full = len(feed.entries) >= GOOGLE_FULL
        events = []
        for entry in feed.entries:
            event = collector.entry_to_event(
                entry, [task["category"]],
                acquisition_channel="archive_enrichment",
                original_language_hint=task["code"],
                collection_language_name=task["name"],
                collection_locale=task["ceid"],
            )
            if event:
                events.append(event)
        return events, full

    def _gdelt(self, task):
        collector = self.collector
        self._space("gdelt", GDELT_SPACING_SECONDS)
        try:
            response = collector.requests.get(
                gdelt_url(collector, task), headers={"User-Agent": "Mozilla/5.0 CT-Atlas-Collector/1.0"}, timeout=30)
        except collector.requests.RequestException as error:
            self._failed("gdelt", f"GDELT request failed: {error}")
        if response.status_code != 200:
            self._failed("gdelt", f"GDELT HTTP {response.status_code}.")
        try:
            payload = response.json()
        except ValueError:
            text = " ".join(str(getattr(response, "text", "") or "").split())
            if GDELT_RATE_LIMIT_TEXT in text.lower():
                self._failed("gdelt", "GDELT rate limit.")
            raise QueryRejected(f"GDELT rejected the query: {text[:160]}")
        self.failures["gdelt"] = 0
        articles = (payload or {}).get("articles") or []
        full = len(articles) >= GDELT_MAX_RECORDS
        events = []
        for article in articles:
            event = collector.gdelt_article_to_event(article, [task["category"]])
            if event:
                event.update({"original_language": task["code"], "collection_language": task["code"],
                              "collection_language_name": task["name"], "acquisition_channel": "archive_enrichment"})
                events.append(event)
        return events, full


# ---------------------------------------------------------------- filtering

# Headlines shorter than this (letters and digits) also need the outlet to
# identify an article.
MIN_KEY_CHARACTERS = 12


def article_key(title, source):
    """The headline, in any script: Google News links change between fetches
    and GDELT names an outlet by its domain where Google News uses its name,
    so neither identifies an article. A copy of a headline in another outlet
    is the same story anyway; only short headlines add the outlet."""
    folded = unicodedata.normalize("NFKC", str(title or "")).casefold()
    text = "".join(ch for ch in folded if ch.isalnum())
    if not text:
        return ""
    if len(text) < MIN_KEY_CHARACTERS:
        outlet = "".join(ch for ch in unicodedata.normalize("NFKC", str(source or "")).casefold() if ch.isalnum())
        text = f"{text}|{outlet}"
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]


def link_key(url):
    """An article's own link (not a Google News redirect, which changes)."""
    url = str(url or "")
    if not url.startswith("http") or "news.google.com" in url:
        return ""
    return "url:" + hashlib.sha1(url.encode("utf-8")).hexdigest()[:16]


def known_article_keys(root):
    """Articles the repository already holds: map events and their other
    reports, and every archive file (former events, reviews, enrichment)."""
    keys = set()

    def add(item):
        if not isinstance(item, dict):
            return
        for title in {item.get("original_title"), item.get("title")}:
            key = article_key(title, item.get("source"))
            if key:
                keys.add(key)
        if link_key(item.get("url")):
            keys.add(link_key(item.get("url")))

    database = archive_review.read_json(Path(root) / "events.json") or {}
    for event in database.get("events") or []:
        add(event)
        for article in event.get("related_articles") or []:
            add(article)
    for path in glob.glob(str(Path(root) / "archive" / "*.json")):
        data = archive_review.read_json(path) or {}
        for field in ("events", "articles"):
            for item in data.get(field) or []:
                add(item)
                if isinstance(item, dict):
                    for article in item.get("related_articles") or []:
                        add(article)
    return keys


def reviewed_fingerprints(root, collector):
    """Candidates the daily collection already reviewed (read-only: the
    selection cache is the collection's file)."""
    cache = archive_review.read_json(Path(root) / collector.AI_SELECTION_CACHE_FILE) or {}
    return set((cache.get("items") or {}).keys())


def published_at(event, collector):
    """The candidate's publication time: entry_to_event and the GDELT
    converter store ISO 8601 (collector.parse_date reads RSS dates only)."""
    value = str(event.get("published") or "")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        parsed = collector.parse_date(value)
    if parsed and parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def in_window(event, task, collector):
    published = published_at(event, collector)
    if not published:
        return False
    start, end = window(task)
    low = datetime.combine(start - timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc)
    high = datetime.combine(end + timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc)
    return low <= published < high


def screen(event, collector):
    """The collector's own cheap rejections, before any Gemini request."""
    if collector.out_of_scope_reason(event):
        return "out_of_scope"
    text = collector.normalize_relevance_text(f"{event.get('title') or ''} {event.get('summary') or ''}")
    if collector.has_non_event_pattern(text):
        return "opinion_or_analysis"
    return ""


# ---------------------------------------------------------------- state

def load_state(root):
    state = archive_review.read_json(Path(root) / STATE_FILE) or {}
    if state.get("version") != STATE_VERSION:
        state = {}
    return {
        "version": STATE_VERSION,
        "done": dict(state.get("done") or {}),
        # Shorter searches replacing a window a source cut short.
        "children": dict(state.get("children") or {}),
        "failures": dict(state.get("failures") or {}),
        "stats": dict(state.get("stats") or {}),
        "runs": list(state.get("runs") or [])[-30:],
    }


def save_state(root, state, plan_keys=None):
    """plan_keys: the current plan's tasks; finished tasks the plan no longer
    has (an edited query) are dropped, so the file never grows with them."""
    if plan_keys is not None:
        keep = set(plan_keys) | set(state["children"])
        state["done"] = {key: value for key, value in state["done"].items() if key in keep}
        state["failures"] = {key: value for key, value in state["failures"].items() if key in keep}
    archive_review.write_json(Path(root) / STATE_FILE,
                              {**state, "updated_at": datetime.now(timezone.utc).isoformat()}, indent=None)


def load_seen(root):
    seen = set()
    for path in glob.glob(str(Path(root) / "archive" / "enrichment-seen-*.txt")):
        with open(path, encoding="utf-8") as handle:
            seen.update(line.strip() for line in handle if line.strip())
    return seen


def save_seen(root, now, keys):
    """Today's off-topic keys, one small file a day (cheap to commit)."""
    if not keys:
        return
    path = Path(root) / "archive" / f"enrichment-seen-{now.strftime('%Y%m%d')}.txt"
    existing = set()
    if path.exists():
        existing = {line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()}
    tmp = Path(str(path) + ".tmp")
    tmp.write_text("".join(f"{key}\n" for key in sorted(existing | set(keys))), encoding="utf-8")
    os.replace(tmp, path)


def bump(state, task, field, amount=1):
    stats = state["stats"].setdefault(f"{task['source']}:{task['code']}", {})
    stats[field] = stats.get(field, 0) + amount


# ---------------------------------------------------------------- output

def archive_row(item, result, collector, now):
    """Filed as the map's selection files a candidate (the sync turns it into
    an archived incident, or another outlet's report on a map incident, only
    when that selection kept it)."""
    return {
        **archive_review.review_record(item, result, collector),
        "reviewed_at": now.isoformat(),
        "enrichment": {"source": item["_task"]["source"], "language": item["_task"]["code"],
                       "week": item["_task"]["week"]},
    }


class Output:
    def __init__(self, root, now):
        self.path = Path(root) / "archive" / f"enriched-articles-{now.strftime('%Y%m%d')}.json"
        self.data = archive_review.read_json(self.path) or {
            "created_at": now.isoformat(),
            "source": "tools/enrich_archive.py: six months of reporting the daily collection never reviewed, "
                      "reviewed by the map's Gemini selection",
            "articles": [],
        }

    def add(self, rows):
        self.data["articles"].extend(rows)

    def save(self):
        if not self.data["articles"]:
            return
        self.data["updated_at"] = datetime.now(timezone.utc).isoformat()
        # Compact: these files are committed every night.
        archive_review.write_json(self.path, self.data, indent=None)


# ---------------------------------------------------------------- the run

def run(root, collector, max_posts, max_fetches, today=None, now=None, searcher=None, call_batch=None,
        gate_factory=None, log=print, deadline_minutes=DEADLINE_MINUTES, clock=time.monotonic):
    now = now or datetime.now(timezone.utc)
    today = today or now.date()
    started = clock()
    state = load_state(root)
    ledger = archive_review.DailyLedger(archive_review.ledger_path("enrichment", root), DAILY_POSTS, now=now)
    budget = ledger.budget(max_posts)
    known = known_article_keys(root)
    cached = reviewed_fingerprints(root, collector)
    seen = load_seen(root)
    new_seen = set()
    plan = plan_tasks(today, collector)
    plan_keys = [task["key"] for task in plan]
    # Shorter searches left open by an earlier run come first.
    tasks = [task for task in state["children"].values() if task["key"] not in state["done"]]
    tasks += [task for task in plan if task["key"] not in state["done"]]
    searcher = searcher or Searcher(collector)
    output = Output(root, now)
    summary = {"tasks_done": 0, "fetched": 0, "candidates": 0, "skipped": 0, "skipped_cached": 0, "reviewed": 0,
               "kept": 0, "archived_incident": 0, "unanswerable": 0, "source_failures": 0, "query_errors": 0,
               "split": 0, "given_up": 0}
    log(f"Enrichment: {len(tasks)} open task(s); Gemini budget {budget} request(s) "
        f"({ledger.used} already used this Pacific day); up to {max_fetches} searches.")
    if budget <= 0:
        return summary, "daily allocation already used"

    queue = []            # candidates waiting for review, in task order
    open_count = {}       # task key -> candidates not yet reviewed
    finished = []         # tasks searched successfully, waiting for their queue
    threshold = collector.AI_SELECTION_THRESHOLD

    def finish(task):
        state["done"][task["key"]] = now.isoformat()
        state["children"].pop(task["key"], None)
        state["failures"].pop(task["key"], None)
        summary["tasks_done"] += 1

    def close_finished():
        for task in list(finished):
            if open_count.get(task["key"], 0) == 0:
                finished.remove(task)
                finish(task)

    def save_batch(pairs, skipped):
        rows = []
        for item, result in pairs:
            score = archive_review.score_of(result)
            bump(state, item["_task"], "reviewed")
            if score > 0:
                rows.append(archive_row(item, result, collector, now))
                bump(state, item["_task"], "kept")
                summary["kept"] += 1
                if score >= threshold:
                    summary["archived_incident"] += 1
            else:
                new_seen.add(item["_key"])
            open_count[item["_task"]["key"]] -= 1
        for item in skipped:
            new_seen.add(item["_key"])
            summary["unanswerable"] += 1
            open_count[item["_task"]["key"]] -= 1
        summary["reviewed"] += len(pairs)
        output.add(rows)
        output.save()
        save_seen(root, now, new_seen)
        close_finished()
        save_state(root, state, plan_keys)

    def out_of_time():
        return (clock() - started) / 60 >= deadline_minutes

    gate = (gate_factory or (lambda posts: archive_review.GeminiGate(
        collector, posts, archive_review.SECONDS_BETWEEN_POSTS, on_post=ledger.save)))(budget)
    stop = "plan finished"
    pending = list(tasks)
    with gate:
        while True:
            # Search only while the reviews have work to wait for.
            while len(queue) < archive_review.BATCH_SIZE and gate.remaining > 0:
                if out_of_time():
                    stop = f"deadline reached ({deadline_minutes:.0f} min)"
                    break
                if searcher.fetches >= max_fetches:
                    stop = f"search budget reached ({max_fetches})"
                    break
                if not pending:
                    break
                task = pending.pop(0)
                if not searcher.available(task["source"]):
                    continue
                try:
                    result = searcher.search(task)
                except SourceUnavailable as error:
                    summary["source_failures"] += 1
                    bump(state, task, "failed_searches")
                    failures = state["failures"][task["key"]] = state["failures"].get(task["key"], 0) + 1
                    log(f"   {task['source']} {task['name']} {task['week']}: {error}")
                    if failures >= MAX_TASK_FAILURES:
                        summary["given_up"] += 1
                        bump(state, task, "given_up")
                        finish(task)
                    continue
                except QueryRejected as error:
                    # Retrying would fail the same way: finished, and logged.
                    summary["query_errors"] += 1
                    bump(state, task, "query_errors")
                    finish(task)
                    log(f"   {task['source']} {task['name']} {task['week']}: {error}")
                    continue
                events, full = result if isinstance(result, tuple) else (result, False)
                summary["fetched"] += 1
                bump(state, task, "searches")
                children = split(task) if full else []
                if children:
                    # The source cut this window short: search it in two halves now.
                    summary["split"] += 1
                    bump(state, task, "split")
                    for child in children:
                        state["children"][child["key"]] = child
                    finish(task)
                    summary["tasks_done"] -= 1
                    pending[:0] = children
                    continue
                if full:
                    bump(state, task, "full_single_day")
                added = 0
                for event in events:
                    key = article_key(event.get("original_title") or event.get("title"), event.get("source"))
                    link = link_key(event.get("url"))
                    if not key or key in known or key in seen or key in new_seen or (link and link in known) \
                            or not in_window(event, task, collector) or screen(event, collector):
                        summary["skipped"] += 1
                        continue
                    if set(event.get("source_article_fingerprints") or ()) & cached:
                        summary["skipped_cached"] += 1
                        continue
                    known.add(key)
                    if link:
                        known.add(link)
                    queue.append({**event, "_key": key, "_task": task})
                    added += 1
                bump(state, task, "candidates", added)
                summary["candidates"] += added
                open_count[task["key"]] = open_count.get(task["key"], 0) + added
                finished.append(task)
                close_finished()

            if not queue or gate.remaining <= 0 or out_of_time():
                break
            batch = queue[:archive_review.BATCH_SIZE]
            handled, stop_reason = archive_review.review_batches(batch, collector, save_batch, call_batch)
            del queue[:handled]
            if stop_reason != "done":
                stop = stop_reason
                break
        if gate.remaining <= 0 and stop == "plan finished":
            stop = f"Gemini budget used ({budget})"
        posts = gate.posts

    state["runs"] = (state["runs"] + [{"at": now.isoformat(), "posts": posts, **summary, "stop": stop}])[-30:]
    save_state(root, state, plan_keys)
    save_seen(root, now, new_seen)
    output.save()
    return summary, stop


def main(argv=None):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--max-posts", type=int, default=MAX_POSTS, help="Gemini requests this run.")
    parser.add_argument("--max-fetches", type=int, default=MAX_FETCHES, help="Searches this run.")
    parser.add_argument("--dry-run", action="store_true", help="Show the plan without searching or calling Gemini.")
    args = parser.parse_args(argv)

    collector = archive_review.prepare_collector(archive_review.load_collector(ROOT), archive_review.REVIEW_MODEL,
                                                 threshold=archive_review.map_threshold(ROOT))
    if args.dry_run:
        state = load_state(ROOT)
        tasks = plan_tasks(datetime.now(timezone.utc).date(), collector)
        open_tasks = [task for task in tasks if task["key"] not in state["done"]]
        by_group = {}
        for task in open_tasks:
            by_group[task["group"]] = by_group.get(task["group"], 0) + 1
        print(f"{len(open_tasks)} of {len(tasks)} tasks open: {by_group}")
        for task in open_tasks[:5]:
            print(f"  next: {task['source']} {task['name']} week {task['week']}: {task['query'][:70]}")
        return 0

    summary, stop = run(ROOT, collector, args.max_posts, args.max_fetches)
    print(f"::notice title=Archive enrichment::{summary['reviewed']} reviewed, {summary['kept']} kept "
          f"({summary['archived_incident']} archived incidents), {summary['candidates']} new candidates from "
          f"{summary['fetched']} searches, {summary['skipped'] + summary['skipped_cached']} skipped before Gemini, "
          f"{summary['tasks_done']} tasks finished, {summary['source_failures']} searches to retry; {stop}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
