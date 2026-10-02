"""Gemini 3.1 Flash Lite work for the background jobs, shared by
tools/review_pending_archive.py (former map events), tools/enrich_archive.py
(the six-month enrichment) and tools/consolidate_incidents.py.

Gemini 3.1 Flash Lite's free quota (500 requests a Pacific day, 15 a minute)
is shared by those jobs, the collection's overflow and the interactive
features' last fallback. So every job here:

  - keeps its own per-Pacific-day ledger (quota/gemini-3.1-<job>.json) and
    never spends more than its daily allocation, however often it runs;
  - counts every HTTP request to Gemini, not every batch;
  - spaces requests at least 6 s apart (10 a minute);
  - on a 429 for the minute, waits a minute and tries once more; on a 429
    for the day, stops: that quota is spent until midnight Pacific;
  - hands every finished batch to the caller, which saves it at once.

Article reviews use the map's own selection prompt, with the map's real
threshold (ct-atlas-runtime.json, as the collection's wrapper does) and a
note that the articles are judged as of their own publication date. The
collector module is loaded fresh, never through
tools/run_collector_quota_safe.py, and its selection cache, D1 and
events.json helpers are never called here.
"""
from __future__ import annotations

import copy
import importlib.util
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
REVIEW_MODEL = os.getenv("ARCHIVE_REVIEW_MODEL", "gemini-3.1-flash-lite")
BATCH_SIZE = 25
SECONDS_BETWEEN_POSTS = float(os.getenv("ARCHIVE_REVIEW_SECONDS_BETWEEN_CALLS", "6"))
PER_MINUTE_WAIT_SECONDS = 60
GEMINI_HOST = "generativelanguage.googleapis.com"
PACIFIC = ZoneInfo("America/Los_Angeles")
DEFAULT_THRESHOLD = 60

# Appended to the selection instructions in the reviewing process only: the
# archive reviews never read or write the selection cache, so its version is
# untouched.
ARCHIVE_NOTE = """

ARCHIVE REVIEW: these candidates were published during the last six months
and are being reviewed now for CT Atlas's archive, not for today's map. Judge
each one as of its own published date: a report of an event that was new when
it was published counts as a CURRENT event here. Still reject retrospectives,
anniversaries, commentary and out-of-scope items exactly as usual.
"""


class BudgetReached(RuntimeError):
    """This run has used every Gemini request it was allowed."""


def load_collector(root=ROOT):
    spec = importlib.util.spec_from_file_location("collector", Path(root) / "collector.py")
    collector = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(collector)
    return collector


def read_json(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def write_json(path, data, indent=1):
    """Atomic: a run killed mid-write never leaves a truncated file behind."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(str(path) + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=indent) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def map_threshold(root=ROOT):
    """The score a review needs to reach the map (ct-atlas-runtime.json)."""
    runtime = read_json(Path(root) / "ct-atlas-runtime.json") or {}
    try:
        return int(runtime.get("ai_selection_threshold"))
    except (TypeError, ValueError):
        return DEFAULT_THRESHOLD


def apply_threshold(collector, threshold):
    """The collector's prompt is written for its code default (50); the
    collection's wrapper rewrites it for the map's real threshold. Reviews
    for the archive must score against the same bar, or borderline incidents
    land just below the map's threshold and are filed as background."""
    text = collector.AI_SELECTION_INSTRUCTIONS
    for phrase in ("score >= 50", "at least 50", "just above 50"):
        text = text.replace(phrase, phrase.replace("50", str(threshold)))
    collector.AI_SELECTION_INSTRUCTIONS = text
    collector.AI_SELECTION_THRESHOLD = int(threshold)
    return collector


def prepare_collector(collector, model=REVIEW_MODEL, threshold=None):
    """Point this collector instance at the review model and the map's
    threshold, let the gate do the pacing, and add the archive note (once)."""
    collector.AI_SELECTION_MODEL = model
    collector.AI_SELECTION_PAUSE_SECONDS = 0
    apply_threshold(collector, map_threshold() if threshold is None else threshold)
    if ARCHIVE_NOTE.strip() not in collector.AI_SELECTION_INSTRUCTIONS:
        collector.AI_SELECTION_INSTRUCTIONS = collector.AI_SELECTION_INSTRUCTIONS + ARCHIVE_NOTE
    return collector


def pacific_day(now=None):
    return (now or datetime.now(timezone.utc)).astimezone(PACIFIC).date().isoformat()


class DailyLedger:
    """One job's Gemini requests in the current Pacific day (the free quota's
    day: it starts at 09:00 Paris, 08:00 for a week around the clock changes)."""

    def __init__(self, path, allocation, now=None):
        self.path = Path(path)
        self.allocation = max(0, int(allocation))
        self.day = pacific_day(now)
        data = read_json(self.path) or {}
        self.used = int(data.get("posts") or 0) if data.get("pacific_day") == self.day else 0

    @property
    def left(self):
        return max(0, self.allocation - self.used)

    def budget(self, requested):
        return max(0, min(int(requested), self.left))

    def save(self, posts_this_run):
        write_json(self.path, {
            "pacific_day": self.day, "posts": self.used + int(posts_this_run), "allocation": self.allocation,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        })


def ledger_path(job, root=ROOT):
    return Path(root) / "quota" / f"gemini-3.1-{job}.json"


def is_daily_quota(response):
    """Gemini names the quota a 429 hit; anything else counts as the minute's."""
    try:
        return "PerDay" in str(getattr(response, "text", "") or "")
    except Exception:  # noqa: BLE001
        return False


class GeminiGate:
    """Wraps requests.post for the reviewing process (the collector calls the
    module-wide requests.post). Only requests to Gemini are counted, paced and
    checked; D1 and every other POST pass straight through."""

    def __init__(self, collector, max_posts, min_interval=SECONDS_BETWEEN_POSTS,
                 sleep=time.sleep, clock=time.monotonic, on_post=None):
        self.collector = collector
        self.max_posts = max(0, int(max_posts))
        self.min_interval = max(0.0, float(min_interval))
        self.sleep = sleep
        self.clock = clock
        self.on_post = on_post
        self.posts = 0
        self.quota_hit = False
        self._last = None
        self._original = None

    def install(self):
        if self._original is None:
            self._original = self.collector.requests.post
            self.collector.requests.post = self.post
        return self

    def uninstall(self):
        if self._original is not None:
            self.collector.requests.post = self._original
            self._original = None

    def __enter__(self):
        return self.install()

    def __exit__(self, *exc):
        self.uninstall()
        return False

    @property
    def remaining(self):
        return max(0, self.max_posts - self.posts)

    def _send(self, url, args, kwargs):
        if self.posts >= self.max_posts:
            raise BudgetReached(f"Gemini request budget reached ({self.max_posts}).")
        if self._last is not None:
            wait = self._last + self.min_interval - self.clock()
            if wait > 0:
                self.sleep(wait)
        self._last = self.clock()
        self.posts += 1
        if self.on_post:
            self.on_post(self.posts)
        return self._original(url, *args, **kwargs)

    def post(self, url, *args, **kwargs):
        if GEMINI_HOST not in str(url):
            return self._original(url, *args, **kwargs)
        if self.quota_hit:
            raise self.collector.AISelectionQuotaError("Gemini's daily quota is already reached in this run.")
        response = self._send(url, args, kwargs)
        if getattr(response, "status_code", None) == 429 and not is_daily_quota(response):
            # The minute's quota: another job or a user shares the model.
            self.sleep(PER_MINUTE_WAIT_SECONDS)
            response = self._send(url, args, kwargs)
        if getattr(response, "status_code", None) == 429:
            self.quota_hit = True
            model = (kwargs.get("json") or {}).get("model", "the review model")
            raise self.collector.AISelectionQuotaError(f"Gemini returned 429 on {model}.")
        return response


def score_of(result):
    try:
        return int((result or {}).get("relevance_score") or 0)
    except (TypeError, ValueError):
        return 0


def review_record(item, result, collector):
    """An archive row for a reviewed item, filed exactly as the map's
    selection files a candidate: collector.apply_ai_selection on a copy (the
    English headline and summary, categories, actor, event type, incident id,
    and the scope check it makes once the headline is translated). The sync
    turns it into an archived incident only when that selection kept it."""
    event = copy.deepcopy({key: value for key, value in item.items() if not str(key).startswith("_")})
    selected = bool(collector.apply_ai_selection(event, result))
    return {
        "url": item.get("url"),
        "title": event.get("title") or item.get("title"),
        "summary": event.get("summary") or "",
        "original_title": item.get("original_title") or item.get("title"),
        "original_language": (result.get("original_language") or item.get("original_language") or "").lower() or None,
        "source": item.get("source"),
        "published": item.get("published"),
        "category": event.get("category"),
        "categories": event.get("categories") or [],
        "actor_group": event.get("actor_group"),
        "primary_event_type": event.get("primary_event_type"),
        "incident_id": event.get("incident_id"),
        "ai_relevance_score": score_of(result),
        "ai_relevance_reason": result.get("reason"),
        "ai_selected": selected,
        "ai_scope_rejection": event.get("ai_scope_rejection"),
        "map_threshold": collector.AI_SELECTION_THRESHOLD,
    }


def _ask(collector, call_batch, pairs):
    """One request for [(offset, item)]: {offset: result} for those answered.
    Wire ids are positions (p0..p24): stored event ids are not unique."""
    payload = [collector.selection_payload({**item, "id": f"p{offset}"}, offset) for offset, item in pairs]
    results = call_batch(payload)
    by_id = {str(result.get("event_id")): result for result in results or [] if isinstance(result, dict)}
    return {offset: by_id[f"p{offset}"] for offset, _ in pairs if f"p{offset}" in by_id}


def _answer(collector, call_batch, pairs):
    """Answers for a batch in at most four requests: the batch; if its JSON
    cannot be read, its two halves once each; then the items Gemini left out,
    once."""
    try:
        answers = _ask(collector, call_batch, pairs)
    except collector.AISelectionIncompleteError:
        answers = {}
        if len(pairs) > 1:
            middle = len(pairs) // 2
            for half in (pairs[:middle], pairs[middle:]):
                try:
                    answers.update(_ask(collector, call_batch, half))
                except collector.AISelectionIncompleteError:
                    pass
    missing = [pair for pair in pairs if pair[0] not in answers]
    if answers and missing:
        try:
            answers.update(_ask(collector, call_batch, missing))
        except collector.AISelectionIncompleteError:
            pass
    return answers


def review_batches(items, collector, on_batch, call_batch=None, batch_size=BATCH_SIZE):
    """Review items in order, batch by batch. After every batch,
    on_batch(pairs, skipped) receives [(item, result)] for the items reviewed
    and the items Gemini still left out after a second request (skipped for
    good rather than blocking the queue). A batch with no answer at all stops
    the run and stays for the next one. Returns (handled, stop_reason):
    handled is how many leading items were reviewed or skipped."""
    call_batch = call_batch or collector.call_ai_selection_batch
    handled = 0
    for start in range(0, len(items), batch_size):
        batch = items[start:start + batch_size]
        try:
            answers = _answer(collector, call_batch, list(enumerate(batch)))
        except BudgetReached as error:
            return handled, str(error)
        except Exception as error:  # noqa: BLE001 -- quota, transient or malformed: stop, keep progress
            return handled, f"stopped by {type(error).__name__}: {str(error)[:200]}"
        if not answers:
            return handled, "Gemini answered none of the batch"
        pairs = [(item, answers[offset]) for offset, item in enumerate(batch) if offset in answers]
        skipped = [item for offset, item in enumerate(batch) if offset not in answers]
        on_batch(pairs, skipped)
        handled += len(batch)
    return handled, "done"
