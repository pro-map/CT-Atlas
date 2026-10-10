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
    def __init__(self, collector, model=None, url=None, timeout=210):
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
        self.instructions = (
            collector.AI_SELECTION_INSTRUCTIONS
            + archive_review.ARCHIVE_NOTE
            + "\nHISTORICAL QWEN SELECTION: One news candidate per request. "
            "Return exactly one schema-conforming result for its event_id. "
            "Treat source category hints as unverified search metadata. "
            "Do NOT copy a tentative category without reported evidence. "
            "If the article lacks an operational fact and a qualifying non-state "
            "terrorism nexus, output relevance_score=0, categories=[], "
            "is_current_ct_event=false, actor_scope=UNKNOWN. "
            "The news event was CURRENT at its own publication date if it "
            "reported a NEW development then. No geopolitical conjecture, "
            "no inferred locations or false confirmations. "
            "In particular, merely seeing a biological, chemical, radioactive "
            "or explosives keyword is not sufficient."
        )

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
            "options": {"temperature": 0.0, "num_ctx": 8192, "num_predict": 1600},
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
