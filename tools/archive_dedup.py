"""One copy per story in the D1 background archive.

The archive (table background_articles) feeds the Report Generator, Deep
Search and Atlas AI with reporting that is not on the map. Two copies of the
same article -- or of the same story reworded by another outlet -- would reach
those tools as independent sources, so the sync (tools/sync_background_corpus.py)
plans its rows through `plan_archive`:

- noise: candidates Gemini scored 0 (off-topic: no counter-terrorism content)
  are never kept;
- duplicate_story: among rows telling the same story, only the best one is kept
  (a real article link before a URL-less review, a related article before a
  removed event, a candidate before a review, the higher score, the dated row,
  then the most recent).

A row that repeats an event of the map is NOT a duplicate here: the map forgets
its events after 180 days while the archive keeps 730, so that row becomes the
story's only trace. The Worker never sends it next to the event it repeats
(background-corpus.js, toContextItems).

"Same story" is the rule of cloudflare-worker/shared.js (isSameStory): within
5 days, the same link, the same normalised title, or titles sharing at least 4
significant words with a Jaccard similarity >= 0.62 or a containment >= 0.78
(>= 0.8 Jaccard when neither headline has a usable case signal: Title Case,
all caps, or a script without capital letters) -- unless
their counts differ (6 vs 49 killed) or each names a place or person the other
does not (Tyumen vs Chuvashia resident, Hamburg vs Munich station). When in
doubt the rule keeps two stories: a spare copy costs less than a lost incident.
tests/same_story_cases.json locks the two implementations together.

Standard library only; importable without collector.py.
"""
from __future__ import annotations

import re
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone

NEAR_DUPLICATE_WINDOW_DAYS = 5
MIN_SHARED_TOKENS = 4
MIN_JACCARD = 0.62
MIN_CONTAINMENT = 0.78

# The English filler words Deep Search's normalizeTitle removes.
TITLE_STOPWORDS = frozenset(
    "the a an and or of to in on at for from with after over into as by is are was were be "
    "says said new latest report reports update updates".split()
)

NOISE_KINDS = frozenset({"historical_review", "rejected_candidate"})
# Lower is better when choosing which copy of a story to keep.
KIND_RANK = {"related_article": 0, "removed_event": 1, "rejected_candidate": 2, "historical_review": 3}

_ACCENTS_RE = re.compile("[\u0300-\u036f]")
_URL_RE = re.compile(r"https?://\S+")
_NOT_WORD_RE = re.compile(r"[^\w\s]|_")


def normalize_title(value):
    """shared.js normalizeTitle: accents folded, lower case, links and
    punctuation removed, English filler words dropped, any script kept."""
    text = _ACCENTS_RE.sub("", unicodedata.normalize("NFKD", str(value or ""))).lower()
    text = _URL_RE.sub(" ", text)
    text = _NOT_WORD_RE.sub(" ", text)
    return " ".join(token for token in text.split() if token not in TITLE_STOPWORDS)


def title_tokens(value):
    return {token for token in normalize_title(value).split() if len(token) >= 3}


_WORD_SPLIT_RE = re.compile(r"[^\w]+|_")
_APOSTROPHES_RE = re.compile("(?<=\\w)['\u2019\u02bc](?=\\w)")
_COUNT_RE = re.compile(r"[0-9]+")
# Zero code points of the decimal digit blocks headlines use (ASCII,
# Arabic-Indic, Persian, N'Ko, Indic scripts, Thai, Lao, Tibetan, Myanmar,
# Khmer, Mongolian, fullwidth); shared.js maps the same blocks.
DIGIT_ZEROS = (0x30, 0x660, 0x6F0, 0x7C0, 0x966, 0x9E6, 0xA66, 0xAE6, 0xB66, 0xBE6, 0xC66, 0xCE6,
               0xD66, 0xDE6, 0xE50, 0xED0, 0xF20, 0x1040, 0x1090, 0x17E0, 0x1810, 0xFF10)

# Opening words that name nothing ("Breaking:", "Eilmeldung:").
GENERIC_OPENERS = frozenset(
    "breaking urgent update updated exclusive watch video live latest flash alert analysis opinion "
    "editorial explainer photos eilmeldung aktuell urgente ultima dernier derniere alerte info "
    "son dakika srochno".split()
)
NUMBER_WORDS = {
    word: str(index + 1)
    for index, word in enumerate(
        "one two three four five six seven eight nine ten eleven twelve thirteen fourteen "
        "fifteen sixteen seventeen eighteen nineteen twenty".split()
    )
}
# Mostly-capitalised headlines (Title Case, all caps) carry no case signal.
TITLE_CASE_SHARE = 0.7
# Without a case signal on either side the names guard cannot work, so the
# shared words alone must be overwhelming (Donetsk / Volzhsky "Resident
# Detained for Justifying Terrorism" share 4 of 7 words).
NO_CASE_SIGNAL_MIN_JACCARD = 0.8


def _words(value):
    """The headline's words, accents folded, in-word apostrophes removed
    (Sana'a -> Sanaa), original case kept."""
    text = _ACCENTS_RE.sub("", unicodedata.normalize("NFKD", str(value or "")))
    text = _APOSTROPHES_RE.sub("", _URL_RE.sub(" ", text))
    return [word for word in _WORD_SPLIT_RE.split(text) if word]


def _is_name_word(word):
    return word[0].isupper() and (len(word) >= 3 or (len(word) == 2 and word.isupper()))


def has_case_signal(value):
    """Capital letters mark names only in a sentence-case headline: not in a
    Title Case or all-caps one, nor in a script without case."""
    significant = [word for word in _words(value) if len(word) >= 3 and word.lower() not in TITLE_STOPWORDS]
    cased = [word for word in significant if word[0].isupper() or word[0].islower()]
    if not cased:
        return False
    capitalised = sum(1 for word in cased if word[0].isupper())
    return capitalised / len(cased) < TITLE_CASE_SHARE


def proper_noun_tokens(value):
    """The places and people a headline names: its capitalised significant
    words (two-letter acronyms such as KP included, the first word too unless
    it is a generic opener), lower-cased. None from a headline without a case
    signal (shared.js properNounTokens)."""
    if not has_case_signal(value):
        return set()
    words = _words(value)
    names = set()
    for position, word in enumerate(words):
        lowered = word.lower()
        if not _is_name_word(word) or lowered in TITLE_STOPWORDS:
            continue
        if position == 0 and lowered in GENERIC_OPENERS:
            continue
        names.add(lowered)
    return names


def _word_space(value):
    return title_tokens(value) | {word.lower() for word in _words(value) if len(word) >= 2}


def _shares_word(word, words):
    for other in words:
        if other == word:
            return True
        if len(word) >= 5 and len(other) >= 5 and other[:5] == word[:5]:
            return True
    return False


def names_differ(a, b):
    """The headlines name different places or people ("...in Hamburg station"
    / "...in Munich station"): two stories (shared.js namesDiffer). Each must
    name something the other lacks; when one has no case signal (a Title Case
    "Chuvashia Resident Sentenced..."), a name of the other missing from it is
    enough ("Tyumen resident sentenced...")."""
    a_space, b_space = _word_space(a), _word_space(b)
    only_a = [word for word in proper_noun_tokens(a) if not _shares_word(word, b_space)]
    only_b = [word for word in proper_noun_tokens(b) if not _shares_word(word, a_space)]
    a_signal, b_signal = has_case_signal(a), has_case_signal(b)
    if a_signal and b_signal:
        return bool(only_a) and bool(only_b)
    return bool(only_a) or bool(only_b)


def ascii_digits(text):
    """Decimal digits of the usual scripts as ASCII (Arabic 3 and Persian 3 are 3)."""
    out = []
    for ch in str(text or ""):
        code = ord(ch)
        for zero in DIGIT_ZEROS:
            if zero <= code <= zero + 9:
                ch = chr(0x30 + code - zero)
                break
        out.append(ch)
    return "".join(out)


def title_counts(value):
    """The counts a headline gives (digits of any usual script, or English
    number words up to twenty), leading zeros dropped (shared.js titleCounts)."""
    text = str(value or "")
    counts = {match.lstrip("0") or "0" for match in _COUNT_RE.findall(ascii_digits(text))}
    counts |= {NUMBER_WORDS[word] for word in normalize_title(text).split() if word in NUMBER_WORDS}
    return counts


def counts_differ(a, b):
    """Both headlines give counts and none is common: "6 terrorists killed"
    and "49 terrorists killed" are two operations (shared.js countsDiffer)."""
    a_counts, b_counts = title_counts(a), title_counts(b)
    return bool(a_counts) and bool(b_counts) and not (a_counts & b_counts)


def similar_titles(a, b, shared, a_size, b_size):
    """The shared-words part of the same-story rule, given the shared count
    (shared.js similarTitles)."""
    if shared < MIN_SHARED_TOKENS:
        return False
    union = a_size + b_size - shared
    jaccard = shared / union if union else 0.0
    containment = shared / min(a_size, b_size)
    if not has_case_signal(a) and not has_case_signal(b):
        if jaccard < NO_CASE_SIGNAL_MIN_JACCARD:
            return False
    elif jaccard < MIN_JACCARD and containment < MIN_CONTAINMENT:
        return False
    return not counts_differ(a, b) and not names_differ(a, b)


def is_link(url):
    return str(url or "").lower().startswith(("http://", "https://"))


def row_time(row):
    for field in ("published", "collected_at"):
        value = str(row.get(field) or "").strip()
        if not value:
            continue
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            continue
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    return None


def score_of(row):
    try:
        return int(row.get("ai_relevance_score"))
    except (TypeError, ValueError):
        return None


def is_noise(row):
    """A candidate Gemini judged entirely off-topic (score 0)."""
    return row.get("kind") in NOISE_KINDS and score_of(row) == 0


def preference(row):
    """Sort key, best copy first; among equals the most recent, which carries
    the latest figures (a toll rising from 14 to 16 dead)."""
    time = row_time(row)
    score = score_of(row)
    return (
        0 if is_link(row.get("url")) else 1,
        KIND_RANK.get(row.get("kind"), 9),
        -(score if score is not None else -1),
        0 if row.get("published") else 1,
        -time.timestamp() if time else float("inf"),
        str(row.get("url") or ""),
    )


class StoryIndex:
    """Stories seen so far, searchable by link, exact title and shared words."""

    def __init__(self):
        self._stories = []
        self._by_url = {}
        self._by_title = defaultdict(list)
        self._by_token = defaultdict(list)

    def __len__(self):
        return len(self._stories)

    def add(self, title, url="", time=None, owner=None):
        index = len(self._stories)
        normalized = normalize_title(title)
        tokens = title_tokens(title)
        self._stories.append(
            {"title": title, "normalized": normalized, "tokens": tokens, "time": time, "owner": owner}
        )
        if is_link(url):
            self._by_url.setdefault(str(url), index)
        if normalized:
            self._by_title[normalized].append(index)
        for token in tokens:
            self._by_token[token].append(index)
        return index

    def _within_window(self, index, time):
        other = self._stories[index]["time"]
        if time is None or other is None:
            return True
        return abs((time - other).total_seconds()) <= NEAR_DUPLICATE_WINDOW_DAYS * 86400

    def find(self, title, url="", time=None):
        """The owner of the story this title repeats, or None."""
        if is_link(url) and str(url) in self._by_url:
            index = self._by_url[str(url)]
            if self._within_window(index, time):
                return self._stories[index]["owner"]

        normalized = normalize_title(title)
        for index in self._by_title.get(normalized, ()) if normalized else ():
            if self._within_window(index, time):
                return self._stories[index]["owner"]

        tokens = title_tokens(title)
        if len(tokens) < MIN_SHARED_TOKENS:
            return None
        shared_counts = Counter()
        for token in tokens:
            shared_counts.update(self._by_token.get(token, ()))
        for index, shared in shared_counts.most_common():
            if shared < MIN_SHARED_TOKENS:
                break
            if not self._within_window(index, time):
                continue
            story = self._stories[index]
            if similar_titles(title, story["title"], shared, len(tokens), len(story["tokens"])):
                return story["owner"]
        return None


def plan_archive(existing_rows, new_rows):
    """Decide what the archive should hold.

    existing_rows: rows already in D1 (dicts with url, kind, title, published,
    collected_at, ai_relevance_score, and optionally original_title).
    new_rows: candidate rows not yet in D1.
    Returns (insert, delete): the new rows to insert, and a list of
    (url, reason, kept_url) for existing rows to remove. A new row never
    replaces an existing row with the same link (the link is the table key).
    """
    existing_urls = {str(row.get("url")) for row in existing_rows if row.get("url")}
    candidates = [(row, True) for row in existing_rows] + [
        (row, False) for row in new_rows if row.get("url") and str(row.get("url")) not in existing_urls
    ]
    candidates.sort(key=lambda item: preference(item[0]))

    stories = StoryIndex()
    insert, delete = [], []
    seen_new_urls = set()
    for row, stored in candidates:
        url = str(row.get("url") or "")
        # The English headline and, when the row carries it, the original
        # one: a translation and its untranslated twin are one story.
        titles = [title for title in dict.fromkeys((row.get("title"), row.get("original_title"))) if title]
        time = row_time(row)

        reason, kept = None, ""
        if is_noise(row):
            reason = "noise"
        elif not stored and url in seen_new_urls:
            reason = "duplicate_story"
        else:
            for title in titles or [""]:
                owner = stories.find(title, url, time)
                if owner is not None:
                    reason, kept = "duplicate_story", owner
                    break

        if reason is None:
            for title in titles or [""]:
                stories.add(title, url, time, url)
            if not stored:
                insert.append(row)
                seen_new_urls.add(url)
        elif stored:
            delete.append((url, reason, kept))
    return insert, delete


def summarize(delete):
    return dict(Counter(reason for _, reason, _ in delete))
