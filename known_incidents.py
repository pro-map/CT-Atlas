"""Known-incident reuse for the daily article selection. No provider calls.

Each selection request carries incidents already on the map, so the model can
say which one a candidate continues. A citation is only a suggestion: settle()
lets an article join an incident on the records' own headlines and dates, never
on a generated anchor. collector.py passes its helpers in as `engine`, so this
module does not import it.
"""
from __future__ import annotations

import copy
import hashlib
import math
import re
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

import map_evidence_integrity as mei


def weak_anchor(value):
    """A paragraph marker such as 'p2', not a description of an incident."""
    anchor = unicodedata.normalize("NFKD", str(value or "")).strip().lower()
    return bool(re.fullmatch(r"(?:p|para|paragraph|item|row|event|article|ref)[-_ ]?\d{1,4}", anchor))


ELIGIBLE_TYPES = {"ATTACK", "ATTEMPTED_ATTACK", "DISRUPTED_PLOT", "CT_OPERATION", "ARREST", "PIRACY", "CBRN"}
TYPE_FAMILIES = {"ATTACK": "attack", "ATTEMPTED_ATTACK": "attack", "DISRUPTED_PLOT": "plot", "ARREST": "plot",
                 "CT_OPERATION": "operation", "PIRACY": "piracy", "CBRN": "cbrn"}
LIST_SIZE = 60
HOT_SIZE = 30
MATCHES_PER_CANDIDATE = 3
ANCHOR_CHARS = 90
SUMMARY_CHARS = 600
RELATED_TITLES = 6
DEGENERATE_ANCHORS = {"none", "null", "unknown", "n/a"}
LIVE_WINDOW = timedelta(days=7)
HOT_WINDOW = timedelta(hours=72)
HOT_BATCH_MAX_AGE = timedelta(days=3)
BEFORE_FIRST_REPORT = timedelta(hours=48)
INITIAL_WINDOW = timedelta(hours=36)
STALE_AFTER = timedelta(days=7)
# Evidence stops growing here: every accepted headline widens what the next one
# can match, which is how a 14-alias chain formed around one Hormuz story.
EVIDENCE_RECORDS = 40
VERDICTS_KEPT = 200
NEVER = datetime.max.replace(tzinfo=timezone.utc)

KNOWN_INCIDENT_NOTE = """KNOWN INCIDENTS. known_incidents lists incidents already on the map as [ref, first_reported, type, anchor].
Set known_incident_ref to one ref only when the candidate reports a development of that SAME real-world incident: the same act at the same place, or the casualties, claim, investigation, arrests, trial, funeral or official reactions of that act.
Return "" for everything else: a NEW attack or arrest, even in the same town, by the same group or on the same day; a similar incident elsewhere; a general article; any doubt.
Copy a ref exactly; never make one up.
The list only helps you recognise incidents. Never copy a place, date, name or number from it into english_title, english_summary, canonical_event, incident_anchor or actor_group: those come from the candidate alone.
If you set a ref, use update_type INITIAL only when the candidate itself is a first report of the act.
The date in incident_anchor is the day of the incident, not of the article."""


def schema_with_ref(schema):
    """A copy with a required ref: an optional field would mostly be left out,
    and a batch sent without a list keeps the shared schema, with nothing to cite."""
    copied = copy.deepcopy(schema)
    items = copied["properties"]["results"]["items"]
    items["properties"]["known_incident_ref"] = {"type": "string"}
    items["required"].append("known_incident_ref")
    return copied


def refused_incident_id(event):
    """An id of the record's own: its anchor hash would still join the incident."""
    raw = "reuse-refused:" + str(event.get("id")) + "|" + str(event.get("url"))
    return "inc-" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def english_words(record):
    return mei.headline_words({"title": record.get("title")})


def build(events, aliases, now, weak, country_names, engine, mode="shadow"):
    """Every incident stays indexed so a cached id still resolves; only what
    for_batch offers is limited to a date window."""
    country_words = set()
    for name in {*country_names, *(record.get("country") for record in events)}:
        country_words |= mei.headline_words({"title": name})
    index = KnownIncidents(aliases, now, weak, country_words, engine, mode)
    groups = defaultdict(list)
    for record in events:
        if record.get("incident_id"):
            groups[engine.resolve_incident_alias(record["incident_id"], aliases)].append(record)
    for incident_id, records in groups.items():
        # Folding an article into a rule-bearing record makes its rule lapse.
        if (any(str(key).startswith("inc-review-") for key in (incident_id, *(r["incident_id"] for r in records)))
                or any(mei.matched_rule(record) for record in records)):
            index.blocked.add(incident_id)
            continue
        incident = index.profile(incident_id, records)
        if incident:
            index.incidents[incident_id] = incident
    return index


class KnownIncidents:
    def __init__(self, aliases, now, weak, country_words, engine, mode):
        self.aliases = aliases
        self.now = now
        self.weak = weak
        self.country_words = country_words
        self.engine = engine
        self.mode = mode
        self.incidents = {}
        self.blocked = set()
        self.offered = set()
        self.stats = defaultdict(int, mode=mode, verdicts=[])

    def resolve(self, incident_id):
        return self.engine.resolve_incident_alias(incident_id, self.aliases)

    def get(self, incident_id):
        return self.incidents.get(self.resolve(incident_id)) if incident_id else None

    def usable_anchor(self, anchor):
        text = self.engine.clean_text(anchor or "")
        if not text or text.casefold() in DEGENERATE_ANCHORS or weak_anchor(text):
            return ""
        return text[:ANCHOR_CHARS]

    def profile(self, incident_id, records):
        when = self.engine.event_datetime
        kinds = Counter(r.get("primary_event_type") for r in records if r.get("primary_event_type") in ELIGIBLE_TYPES)
        ordered = sorted(records, key=lambda r: (when(r) or NEVER, str(r.get("id"))))
        anchors = [(r, self.usable_anchor(r.get("incident_anchor"))) for r in ordered]
        anchors = [(r, anchor) for r, anchor in anchors if anchor]
        if not kinds or not anchors:
            return None
        counts = Counter(anchor for _, anchor in anchors)
        anchor = next((a for r, a in anchors if r.get("update_type") == "INITIAL"),
                      min(counts, key=lambda a: (-counts[a], a)))
        evidence = sorted(ordered, key=lambda r: r.get("update_type") != "INITIAL")[:EVIDENCE_RECORDS]
        dates = [when(r) for r in ordered if when(r)]
        size = lambda r: 1 + len(r.get("related_articles") or [])
        return {"id": incident_id, "anchor": anchor, "type": min(kinds, key=lambda k: (-kinds[k], k)),
                "first": min(dates, default=None), "last": max(dates, default=None),
                "records": list(records), "evidence": evidence, "founders": set(), "run": False, "words": None,
                "countries": tuple(sorted({mei._country_key(r) for r in evidence} - {""})),
                "articles": sum(size(r) for r in records),
                "recent": sum(size(r) for r in records if when(r) and when(r) >= self.now - HOT_WINDOW)}

    def incident_words(self, incident):
        """Relevance only, never evidence, so an anchor may count here."""
        if incident["words"] is None:
            parts = [incident["anchor"]]
            for record in incident["records"]:
                parts += [record.get("title"), record.get("original_title")]
                for article in (record.get("related_articles") or [])[:RELATED_TITLES]:
                    if isinstance(article, dict):
                        parts += [article.get("title"), article.get("original_title")]
            words = mei.headline_words({"title": " ".join(str(part or "") for part in parts)})
            incident["words"] = words - self.weak.common
        return incident["words"]

    def candidate_words(self, payload):
        parts = [payload.get("title"), str(payload.get("summary") or "")[:SUMMARY_CHARS]]
        parts += [a.get("title") for a in payload.get("related_articles") or [] if isinstance(a, dict)]
        return mei.headline_words({"title": " ".join(str(part or "") for part in parts)}) - self.weak.common

    def for_batch(self, batch):
        """The list for one request, as (rows, ref_ids). A backlog batch gets
        the incidents of its own period rather than today's."""
        newest = max(filter(None, map(self.engine.event_datetime, batch)), default=self.now)
        live = [incident for incident in self.incidents.values()
                if incident["first"] and incident["last"] >= newest - LIVE_WINDOW
                and incident["first"] <= newest + timedelta(days=1)]
        hot = []
        if newest >= self.now - HOT_BATCH_MAX_AGE:
            hot = sorted(live, key=lambda i: (-i["recent"], -i["articles"], -i["last"].timestamp(), i["id"]))[:HOT_SIZE]
        postings = defaultdict(list)
        for incident in live:
            for word in self.incident_words(incident):
                postings[word].append(incident["id"])
        best, first_choices = {}, set()
        for payload in batch:
            scores = defaultdict(float)
            for word in sorted(self.candidate_words(payload)):
                for incident_id in postings.get(word, ()):
                    scores[incident_id] += math.log(1 + len(live) / len(postings[word]))
            top = sorted(scores.items(), key=lambda item: (-item[1], item[0]))[:MATCHES_PER_CANDIDATE]
            first_choices.update(incident_id for incident_id, _ in top[:1])
            for incident_id, score in top:
                best[incident_id] = max(best.get(incident_id, 0), score)
        by_score = lambda incident_id: (-best[incident_id], incident_id)
        chosen = [incident["id"] for incident in hot] + sorted(first_choices, key=by_score) + sorted(best, key=by_score)
        chosen = list(dict.fromkeys(chosen))[:LIST_SIZE]
        self.offered.update(chosen)
        self.stats["offered"] += len(chosen)
        refs = {f"K{number}": incident_id for number, incident_id in enumerate(chosen, 1)}
        rows = [[ref, self.incidents[incident_id]["first"].date().isoformat(), self.incidents[incident_id]["type"],
                 self.incidents[incident_id]["anchor"]] for ref, incident_id in refs.items()]
        return rows, refs

    def translate(self, results, refs):
        """A ref means another incident in the next call, so the cache and the
        checkpoints may only ever hold the stable id it stands for here."""
        for result in results:
            if not isinstance(result, dict):
                continue
            result.pop("known_incident_id", None)
            ref = str(result.pop("known_incident_ref", "") or "").strip()
            if not ref:
                continue
            self.stats["refs_set"] += 1
            if ref in refs:
                result["known_incident_id"] = refs[ref]
            else:
                self.stats["refs_unknown"] += 1

    def view(self, event, result):
        """The candidate as evidence, usable before and after apply_ai_selection
        translates the event."""
        clean = self.engine.clean_text
        view = {"id": event.get("id"), "title": clean(result.get("english_title") or "") or event.get("title"),
                "original_title": event.get("original_title") or event.get("title"),
                "original_summary": event.get("original_summary") or event.get("summary"),
                "url": event.get("url"), "published": event.get("published"),
                "update_type": clean(result.get("update_type") or "").upper(),
                "primary_event_type": clean(result.get("primary_event_type") or "OTHER_CT").upper()}
        view["title"] = mei.grounded_title(view)
        return view

    def targets(self, view, cited, own_id):
        """What the article must pass to join: the incident it cites, then the
        one its own anchor hashes to when the model was shown it, because a
        copied anchor reaches that incident with no citation at all."""
        wanted = self.get(cited)
        own_key = self.resolve(own_id) if own_id else None
        shown = own_key in self.offered or (wanted is not None and wanted["id"] == own_key)
        own = self.incidents.get(own_key) if shown else None
        if own is not None and view["url"] in own["founders"]:
            own = None
        return wanted, own, [target for target in (wanted, own if own is not wanted else None) if target is not None]

    def refusal(self, event, view, target):
        """Why the article may not join target, or None. Anchors, canonical
        events, cities and related articles never count as evidence."""
        if mei.matched_rule(event):
            return "isolated"
        published = self.engine.event_datetime(view)
        if published is None or target["first"] is None:
            return "no_date"
        if published < target["first"] - BEFORE_FIRST_REPORT:
            return "before_incident"
        # INITIAL labels cannot tell a first report from a re-report, and a new
        # attack in the same town would fold into the old one: a swallowed
        # attack is worse than a duplicate consolidation can still merge.
        guarded = view["update_type"] == "INITIAL" and view["primary_event_type"] != "OTHER_CT"
        if guarded:
            if published - target["first"] > INITIAL_WINDOW:
                return "initial_too_late"
            if TYPE_FAMILIES.get(view["primary_event_type"]) != TYPE_FAMILIES[target["type"]]:
                return "initial_other_type"
        elif published > target["last"] + STALE_AFTER:
            return "stale"
        evidence = [record for record in target["evidence"]
                    if not view["url"] or record.get("url") != view["url"]]
        if not any(mei.consolidation_pair_supported(view, record, self.weak) for record in evidence):
            return "no_primary_evidence"
        if guarded:
            shared = english_words(view) & set().union(*map(english_words, evidence))
            if len(shared - self.country_words) < 2 or not self.weak.distinctive(shared, *target["countries"]):
                return "initial_needs_two_words"
        return None

    def record_verdict(self, view, target, outcome, cited):
        self.stats[outcome] += 1
        if len(self.stats["verdicts"]) < VERDICTS_KEPT:
            self.stats["verdicts"].append({
                "outcome": outcome, "via": "cited" if cited else "copied_anchor", "target": target["id"],
                "anchor": target["anchor"], "title": view["title"], "original_title": view["original_title"],
                "update_type": view["update_type"], "url": view["url"]})
            print(f"   Known incident [{self.mode}] {outcome}: {str(view['title'])[:80]} -> {target['anchor']}")

    def settle(self, event, result):
        """Called once per fresh incident id, after the scope check, so rejected
        articles and ids consolidation settled on are never touched."""
        view = self.view(event, result)
        cited = result.get("known_incident_id")
        wanted, own, targets = self.targets(view, cited, event.get("incident_id"))
        if cited and wanted is None:
            self.stats["target_unknown"] += 1
        if not targets:
            return
        reason = None
        for target in targets:
            reason = self.refusal(event, view, target)
            if reason is None:
                self.accept(event, view, target, target is wanted)
                return
        self.record_verdict(view, targets[-1], reason, targets[-1] is wanted)
        if targets[-1] is not wanted:
            # In shadow this copied anchor still joins the incident by hash:
            # above zero, a new attack may have lost its own id and map point.
            self.stats["copied_anchor_refused"] += 1
        if self.mode == "on":
            event["incident_reuse_refused"] = reason
            if own is not None:
                event["incident_id"] = refused_incident_id(event)

    def accept(self, event, view, target, cited):
        self.record_verdict(view, target, "accepted", cited)
        if not cited:
            self.stats["copied_anchor"] += 1
        if self.engine.latin_letter_share(view["original_title"]) < 0.5:
            self.stats["accepted_non_latin"] += 1
        if self.mode == "on":
            event.update(incident_id=target["id"], incident_anchor=target["anchor"],
                         incident_reuse="cited" if cited else "copied_anchor")

    def add(self, incident, view, event):
        articles = 1 + len(event.get("related_articles") or [])
        incident["articles"] += articles
        incident["recent"] += articles
        incident["records"].append(view)
        incident["words"] = None
        if len(incident["evidence"]) < EVIDENCE_RECORDS:
            incident["evidence"].append(view)
        published = self.engine.event_datetime(view)
        if published:
            incident["last"] = max(incident["last"] or published, published)

    def observe(self, event, result, threshold):
        """A kept result of this run, so later batches can cite it: 40% of later
        records have their first report in the same or the previous run."""
        clean = self.engine.clean_text
        try:
            score = int(result.get("relevance_score", 0))
        except (TypeError, ValueError):
            return
        kind = clean(result.get("primary_event_type") or "").upper()
        if (score < threshold or result.get("is_current_ct_event") is not True
                or kind not in ELIGIBLE_TYPES or mei.matched_rule(event)):
            return
        view = self.view(event, result)
        anchor = clean(result.get("incident_anchor") or result.get("canonical_event")
                       or result.get("english_title") or "")
        own_id = self.engine.anchor_incident_id(anchor) if anchor else None
        _, own, targets = self.targets(view, result.get("known_incident_id"), own_id)
        for target in targets:
            # Only after the gate: an entry must never vouch for itself.
            if self.refusal(event, view, target) is None:
                self.add(target, view, event)
                return
        key = self.resolve(own_id) if own_id else None
        anchor = self.usable_anchor(anchor)
        if own is not None or not key or not anchor or key in self.blocked:
            return
        incident = self.incidents.get(key)
        if incident is None:
            published = self.engine.event_datetime(view)
            incident = self.incidents[key] = {
                "id": key, "anchor": anchor, "type": kind, "first": published, "last": published,
                "records": [], "evidence": [], "founders": set(), "run": True, "words": None,
                "countries": (), "articles": 0, "recent": 0}
        elif not incident["run"]:
            return
        if view["url"]:
            incident["founders"].add(view["url"])
        self.add(incident, view, event)


def story_order(pending, batch_size):
    """Newest-first candidates regrouped so one story's articles share a batch.

    An article is only pulled forward, so anything a run budget cuts off is
    older than every seed before it.
    """
    tokens = []
    for payload in pending:
        titles = [payload.get("title")] + [a.get("title") for a in payload.get("related_articles") or []
                                           if isinstance(a, dict)]
        tokens.append(mei.headline_words({"title": " ".join(str(title or "") for title in titles)}))
    frequency = Counter(token for words in tokens for token in words)
    ceiling = max(6, len(pending) // 25)
    postings = defaultdict(list)
    for position, words in enumerate(tokens):
        for token in words:
            if 2 <= frequency[token] <= ceiling:
                postings[token].append(position)
    used = [False] * len(pending)
    order = []
    for seed in range(len(pending)):
        if used[seed]:
            continue
        used[seed] = True
        group = [seed]
        bag = {token for token in tokens[seed] if token in postings}
        for _ in range(2):
            shared = Counter(other for token in bag for other in postings[token] if not used[other])
            for other, count in sorted(shared.items(), key=lambda item: (-item[1], item[0])):
                if len(group) >= 2 * batch_size:
                    break
                if count >= 2:
                    used[other] = True
                    group.append(other)
                    bag |= {token for token in tokens[other] if token in postings}
        order.extend(group)
    return [pending[position] for position in order]
