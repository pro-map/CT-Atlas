#!/usr/bin/env python3
"""Local Ollama/Qwen article selector for the historical specialist backfill ONLY.

Feature-flagged; never invoked by daily collector or user-facing ATLAS.
No remote inference API, Gemini key, or Gemini request ledger.
"""
from __future__ import annotations

import copy
import json
import os
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

import archive_review

MODEL = os.environ.get("QWEN_BACKFILL_MODEL", "qwen3.5:4b")
DEFAULT_URL = "http://127.0.0.1:11434/api/chat"
ALLOWED_HOSTS = {"127.0.0.1", "localhost", "::1"}
REQUIRED_FIELDS = set()


class QwenGate:
    """Counts local inference calls; never changes or reads Gemini quotas."""
    def __init__(self, backend, limit):
        self.backend = backend
        self.limit = max(0, int(limit))
        self.posts = 0

    @property
    def remaining(self):
        return max(0, self.limit - self.posts)

    def __enter__(self):
        if self.backend.active_gate is not None:
            raise RuntimeError("Nested local Qwen inference gates are forbidden")
        self.backend.active_gate = self
        return self

    def __exit__(self, *_exc):
        self.backend.active_gate = None
        return False


class LocalQwenBackend:
    def __init__(self, collector, model=None, url=None, timeout=210, scope="specialist"):
        self.collector = collector
        self.model = model or MODEL
        self.url = url or os.getenv("QWEN_BACKFILL_URL", DEFAULT_URL)
        parts = urlsplit(self.url)
        if parts.scheme != "http" or parts.hostname not in ALLOWED_HOSTS or parts.path != "/api/chat":
            raise ValueError("Historical Qwen inference requires a local Ollama /api/chat endpoint")
        self.timeout = int(timeout)
        self.active_gate = None
        self.schema = copy.deepcopy(collector.AI_SELECTION_SCHEMA)
        self.schema["additionalProperties"] = False
        item = self.schema["properties"]["results"]["items"]
        item["additionalProperties"] = False
        item["required"] = list(dict.fromkeys([*item["required"], "reported_status"]))
        self.required = set(item["required"])
        self.allowed_labels = set(item["properties"]["categories"]["items"]["enum"])
        self.allowed_status = set(item["properties"]["reported_status"]["enum"])
        # The full Gemini operational prompt is too large for a free 4-core
        # CPU runner (the first rich-schema Qwen probe timed out at 210s).
        # Keep the SAME specialist scope rules, but use a compact instruction
        # set so local inference remains practical. No live-code prompt changes.
        import threat_categories
        import radnuc
        self.instructions = (
            "You are the editorial selector for a SIX-MONTH HISTORICAL "
            "counter-terrorism news map. Return ONE fully schema-conforming "
            "result per supplied event_id. Judge a newly reported development "
            "as of the article's OWN publication date, not today's date. "
            "Choose score 0-100; only concrete non-state terrorism operational "
            "facts (attacks, arrests, plots, seizures, investigations, "
            "prosecutions) can reach the map threshold. State-only warfare, "
            "diplomacy, articles about history, commentary, routine crimes, "
            "accidental industrial events, natural outbreaks, and generic "
            "weapons or nuclear research are NOT qualifying CT incidents. "
            "If no actual qualifying event, return relevance_score=0, "
            "categories=[], is_current_ct_event=false and actor_scope=UNKNOWN. "
            "Never infer terrorism, an agent, an attack or the event's country "
            "merely from an outlet name, language, Google edition or keyword. "
            "Do not upgrade alleged threats or hoaxes into confirmed incidents. "
            "A suspected incident remains suspected. Name a location only if "
            "the article supports it; otherwise leave it unstated. "
            "Treat current_categories as untrusted SEARCH HINTS, not evidence. "
            "Output original_language, faithful English title and 1-2 sentence "
            "English summary; a stable short English canonical_event and "
            "incident_anchor describing actor+act+place only when known. "
            "Normalize actor_group (e.g. ISIS, Al-Qaeda, ISIS-K, ISWAP, "
            "Hezbollah, Taliban, TTP, JNIM) without making up actors. "
            "Choose the correct primary_event_type, update_type and is_attack. "
            "Report the source's evidence status exactly. "
            "Action labels and specialist labels can co-exist on ONE incident "
            "but never create duplicates. Use a conservative relevance "
            "score under the threshold when evidence is ambiguous. "
            + archive_review.ARCHIVE_NOTE
            + threat_categories.SELECTION_NOTE
            + radnuc.SELECTION_NOTE
        )

        if scope == "map_chinese":
            # Full-map history is separate from specialist-only interpretation.
            # Maritime Piracy is the existing explicitly authorised exception
            # for actual piracy WITHOUT a terrorism nexus.
            self.instructions = (
                "You classify historical Chinese-language public news reporting "
                "for all categories of an operational counterterrorism map. "
                "Use ONLY explicit source evidence; do not invent people, "
                "countries, casualty counts, targets, perpetrators or motive. "
                "Report actual new events as of each article's publication date, "
                "including arrests, operations, investigations, charges and trials; "
                "reject opinion pieces, old retrospectives and historical essays. "
                "For terrorism-linked categories require a concrete reported "
                "non-state actor nexus; state-on-state military or intelligence "
                "operations, general foreign policy and routine crime are excluded. "
                "EXCEPTION: genuine Maritime Piracy includes ship hijacking, "
                "armed robbery at sea, maritime piracy investigation/rescue and "
                "crew kidnapping even if NO terrorism link is reported; "
                "interstate naval warfare or a missile strike alone is NOT piracy. "
                "Terrorist Financing: actual finance or sanctions actions. "
                "Weapons: terrorist arms discovery, seizure, smuggling, trafficking. "
                "Attacks: actual attacks or attempts, not mere discussions. "
                "Arrests: fresh detainees or police investigations. "
                "Counter Terrorism Action: a real security operation against "
                "a non-state actor. Legal / Judicial: trial, charges, sentencing. "
                "Online / Cyber / AI: concrete extremist online use or police action. "
                "For the three specialist CBRNE topics apply factual material "
                "scope and preserve THREAT, SUSPECTED, ALLEGED or HOAX as stated. "
                "A retrieved keyword or a category hint does NOT establish relevance. "
                "A publisher's Chinese writing system, origin or news edition "
                "does NOT locate the event in China or Taiwan. "
                "Give the faithful English headline and summary, original_language, "
                "correct reported_status, actor_group when named, concise canonical_event "
                "and stable incident_anchor for same-event deduplication. "
                "Give relevance_score=0, categories=[] and "
                "is_current_ct_event=false for events outside the scope. "
                "Otherwise return all REQUIRED output fields in the schema and "
                "exactly ONE result for the supplied event_id. "
                + archive_review.ARCHIVE_NOTE
            )
        elif scope != "specialist":
            raise ValueError("Unsupported Qwen historical inference scope")

    def gate_factory(self, max_posts):
        return QwenGate(self, max_posts)

    def call_batch(self, batch):
        if self.active_gate is None:
            raise RuntimeError("Qwen selector must run inside the local inference gate")
        if len(batch) != 1:
            raise ValueError("Qwen uses exactly one article per checkpointed inference call")
        if self.active_gate.remaining == 0:
            raise archive_review.BudgetReached("Local Qwen request cap reached")
        item = batch[0]
        if not isinstance(item, dict) or not item.get("event_id"):
            raise self.collector.AISelectionIncompleteError("Missing candidate event_id")
        # The caller already supplies all original-language text and related article
        # evidence. Do not send archive checkpoints, keys, secrets or whole events.
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": self.instructions},
                {"role": "user", "content": (
                    "Review this ONE archived candidate as of its publication date. "
                    "Return one result for event_id exactly as provided:\n"
                    + json.dumps(item, ensure_ascii=False)
                )},
            ],
            "format": self.schema,
            "stream": False,
            "think": False,
            "options": {"temperature": 0.0, "num_ctx": 4096, "num_predict": 800},
            "keep_alive": "20m",
        }
        request = Request(
            self.url, method="POST",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        self.active_gate.posts += 1   # Count even a timeout/rejected HTTP response.
        try:
            with urlopen(request, timeout=self.timeout) as response:
                response_data = json.loads(response.read().decode("utf-8"))
            response_text = response_data["message"]["content"]
            data = json.loads(response_text)
        except (HTTPError, URLError, TimeoutError, OSError) as error:
            raise self.collector.AISelectionTransientError(
                "Local Ollama inference unavailable or timed out; candidate safely queued"
            ) from error
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise self.collector.AISelectionIncompleteError(
                "Local Ollama returned incomplete structured JSON; candidate safely queued"
            ) from error

        results = data.get("results") if isinstance(data, dict) else None
        if not isinstance(results, list) or len(results) != 1:
            raise self.collector.AISelectionIncompleteError("Local Qwen must return exactly one result")
        answer = results[0]
        if not isinstance(answer, dict) or self.required - set(answer):
            raise self.collector.AISelectionIncompleteError("Local Qwen omitted mandatory result fields")
        if str(answer["event_id"]) != str(item["event_id"]):
            raise self.collector.AISelectionIncompleteError("Local Qwen mismatched the candidate ID")
        score = answer["relevance_score"]
        if isinstance(score, bool) or not isinstance(score, int) or not (0 <= score <= 100):
            raise self.collector.AISelectionIncompleteError("Invalid Qwen relevance score")
        if not isinstance(answer["categories"], list) or any(
            label not in self.allowed_labels for label in answer["categories"]
        ):
            raise self.collector.AISelectionIncompleteError("Invalid Qwen category labels")
        if answer["reported_status"] not in self.allowed_status:
            raise self.collector.AISelectionIncompleteError("Invalid Qwen reported-status label")
        if not isinstance(answer["is_current_ct_event"], bool):
            raise self.collector.AISelectionIncompleteError("Invalid Qwen current-event label")
        for key in ("english_title", "english_summary", "canonical_event", "actor_group",
                    "incident_anchor", "reason", "original_language"):
            if not isinstance(answer[key], str):
                raise self.collector.AISelectionIncompleteError("Invalid Qwen structured text fields")
        # Prevent the original collector's fallback behaviour, which would otherwise
        # restore search-hint categories to a high-scoring answer with no labels.
        if score >= self.collector.AI_SELECTION_THRESHOLD and not answer["categories"]:
            raise self.collector.AISelectionIncompleteError(
                "High-scoring Qwen result lacks substantiated categories; retain for review"
            )
        if score >= self.collector.AI_SELECTION_THRESHOLD and (
            not answer["is_current_ct_event"] or
            not answer["english_title"].strip() or
            not answer["english_summary"].strip() or
            not answer["canonical_event"].strip()
        ):
            raise self.collector.AISelectionIncompleteError(
                "High-scoring Qwen result lacks a valid operational description"
            )
        if answer["actor_scope"] == "STATE_ONLY" and score >= self.collector.AI_SELECTION_THRESHOLD:
            raise self.collector.AISelectionIncompleteError(
                "High-scoring state-only candidate conflicts with CT actor scope"
            )
        return [answer]
