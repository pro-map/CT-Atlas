"""Public news searches and article keys for the daily RadNuc background job:
Google News and GDELT over one explicit date window. Nothing is saved here."""
from __future__ import annotations

import hashlib
import json
import os
import time
import unicodedata
from datetime import date, timedelta
from urllib.parse import quote_plus, urlencode

WEEK = timedelta(days=7)
GOOGLE_SPACING_SECONDS = float(os.getenv("ENRICH_GOOGLE_SPACING_SECONDS", "3"))
GDELT_SPACING_SECONDS = float(os.getenv("ENRICH_GDELT_SPACING_SECONDS", "10"))
# Consecutive refusals after which a source is left alone for the rest of the run.
MAX_CONSECUTIVE_FAILURES = 3
# A search returning this many items was cut short by the source.
GOOGLE_FULL = 95
GDELT_MAX_RECORDS = 250
# GDELT answers its rate limit in plain text ("Please limit requests to one
# every 5 seconds ..."); any other plain text is a rejected query.
GDELT_RATE_LIMIT_TEXT = "limit requests to one every"
# GDELT also refuses requests from shared addresses (GitHub's runners) with
# HTTP 429 well under that rate: wait and ask again this many times, longer
# each time, before the search is left for the next run.
GDELT_RATE_LIMIT_RETRIES = int(os.getenv("ENRICH_GDELT_RATE_LIMIT_RETRIES", "2"))
GDELT_RATE_LIMIT_BACKOFF_SECONDS = float(os.getenv("ENRICH_GDELT_RATE_LIMIT_BACKOFF_SECONDS", "30"))
# Headlines shorter than this (letters and digits) also need the outlet to
# identify an article.
MIN_KEY_CHARACTERS = 12


def window(task):
    if task.get("start"):
        return date.fromisoformat(task["start"]), date.fromisoformat(task["end"])
    start = date.fromisoformat(task["week"])
    return start, start + WEEK


def google_url(collector, task):
    start, end = window(task)
    # before: is exclusive; one extra day catches late time zones (the
    # caller's window check trims what falls outside).
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
    """The source refused or failed: the task stays open for the next run.
    rate_limited: the source turned every request away, whatever the query,
    so the task itself is not at fault and is never given up for it."""

    def __init__(self, message, rate_limited=False):
        super().__init__(message)
        self.rate_limited = rate_limited


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

    def _failed(self, source, message, rate_limited=False):
        self.failures[source] += 1
        raise SourceUnavailable(message, rate_limited)

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

    def _gdelt_answer(self, task):
        """GDELT's JSON for a task, or None when it is rate limiting."""
        collector = self.collector
        self._space("gdelt", GDELT_SPACING_SECONDS)
        try:
            response = collector.requests.get(
                gdelt_url(collector, task), headers={"User-Agent": "Mozilla/5.0 CT-Atlas-Collector/1.0"}, timeout=30)
        except collector.requests.RequestException as error:
            self._failed("gdelt", f"GDELT request failed: {error}")
        if response.status_code == 429:
            return None
        if response.status_code != 200:
            self._failed("gdelt", f"GDELT HTTP {response.status_code}.")
        try:
            return response.json()
        except ValueError:
            raw = str(getattr(response, "text", "") or "")
            text = " ".join(raw.split())
            if GDELT_RATE_LIMIT_TEXT in text.lower():
                return None
            if raw.lstrip().startswith(("{", "[")):
                # GDELT's JSON sometimes carries raw control characters in titles.
                try:
                    return json.loads(raw, strict=False)
                except ValueError:
                    self._failed("gdelt", "GDELT sent broken JSON.")
            raise QueryRejected(f"GDELT rejected the query: {text[:160]}")

    def _gdelt(self, task):
        collector = self.collector
        for attempt in range(getattr(self, "gdelt_rate_limit_retries", GDELT_RATE_LIMIT_RETRIES) + 1):
            if attempt:
                self.sleep(GDELT_RATE_LIMIT_BACKOFF_SECONDS * attempt)
            payload = self._gdelt_answer(task)
            if payload is not None:
                break
        else:
            self._failed("gdelt", "GDELT rate limit.", rate_limited=True)
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


def _word_character(ch):
    """Letters, digits and combining marks: the vowel signs and viramas of
    Hindi or Bengali tell two headlines apart."""
    return unicodedata.category(ch)[0] in "LMN"


def article_key(title, source, legacy=False):
    """The headline, in any script: Google News links change between fetches
    and GDELT names an outlet by its domain where Google News uses its name,
    so neither identifies an article. A copy of a headline in another outlet
    is the same story anyway; only short headlines add the outlet.
    legacy: the key runs stored before 2026-10-04, without combining marks."""
    keep = str.isalnum if legacy else _word_character
    folded = unicodedata.normalize("NFKC", str(title or "")).casefold()
    text = "".join(ch for ch in folded if keep(ch))
    if not text:
        return ""
    if len(text) < MIN_KEY_CHARACTERS:
        outlet = "".join(ch for ch in unicodedata.normalize("NFKC", str(source or "")).casefold() if ch.isalnum())
        text = f"{text}|{outlet}"
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]


def article_keys(title, source):
    """Today's key first, then the legacy one (the seen files hold both)."""
    keys = [article_key(title, source), article_key(title, source, legacy=True)]
    return [key for index, key in enumerate(keys) if key and key not in keys[:index]]
