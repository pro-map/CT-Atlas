"""Bounded historical Groq scheduling, redacted telemetry and validated replay.

No billing changes, no model fallback, no relaxation of selection/publication.
Only the existing public-news history backend imports the recovery functions.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import backfill_control

# Operator-authorized allocation, NOT Groq's public or account-specific limits.
REQUEST_CAP = 32
RESERVED_TOKEN_CAP = 160_000
MIN_RUN_RESERVATION = 5_500
CACHE_FILE = "archive/groq-history-review-cache-v1.json"
TELEMETRY_DIR = "quota/groq-history-telemetry"
SAFE_INPUT_FIELDS = ("title", "summary", "published", "collection_language_hint",
                     "current_categories", "related_articles", "source")
ERROR_CODES = frozenset(("json_validate_failed", "context_length_exceeded",
                        "invalid_api_key", "model_not_found", "rate_limit_exceeded",
                        "invalid_request_error", "content_filter", "content_policy_violation"))
ERROR_TYPES = frozenset(("invalid_request_error", "authentication_error",
                        "rate_limit_error", "server_error", "tokens"))
ERROR_PARAMS = frozenset(("max_completion_tokens", "max_tokens", "response_format",
                         "messages", "model", "temperature", "reasoning_effort"))


def read_json(path: Path, default):
    if not path.exists():
        return copy.deepcopy(default)
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, mode="w", encoding="utf-8",
                                         delete=False, suffix=".tmp") as handle:
            temporary = Path(handle.name)
            json.dump(value, handle, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def nonnegative_integer(value):
    return value if type(value) is int and 0 <= value <= 10**9 else None


def safe_response_metadata(reply) -> dict:
    """Never retain server messages, failed_generation, content, IDs or secrets."""
    status = getattr(reply, "status_code", None)
    result = {"http_status": status if type(status) is int else None}
    try:
        wire = reply.json()
    except (ValueError, TypeError, AttributeError):
        wire = {}
    if not isinstance(wire, dict):
        wire = {}
    error = wire.get("error")
    if isinstance(error, dict):
        for key, allowed in (("code", ERROR_CODES), ("type", ERROR_TYPES), ("param", ERROR_PARAMS)):
            value = error.get(key)
            result["error_" + key] = value if isinstance(value, str) and value in allowed else "unclassified"
        message = error.get("message")
        message = message.lower() if isinstance(message, str) else ""
        # Classification into fixed constants only; never copy free-form text.
        if "max_completion_tokens" in message or "max_tokens" in message or "length limit" in message:
            result["error_kind"] = "output_or_context_limit"
        elif "schema" in message or "generate json" in message or "json validation" in message:
            result["error_kind"] = "structured_output"
        else:
            result["error_kind"] = "unclassified"
    usage = wire.get("usage")
    result["provider_usage"] = {}
    if isinstance(usage, dict):
        for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
            value = nonnegative_integer(usage.get(key))
            if value is not None:
                result["provider_usage"][key] = value
    result["rate_headers"] = {}
    headers = getattr(reply, "headers", {})
    if hasattr(headers, "get"):
        for key in ("x-ratelimit-limit-requests", "x-ratelimit-remaining-requests",
                    "x-ratelimit-limit-tokens", "x-ratelimit-remaining-tokens", "retry-after"):
            value = headers.get(key)
            if isinstance(value, (str, int)) and str(value).isascii() and str(value).isdigit():
                parsed = int(value)
                if 0 <= parsed <= 10**9:
                    result["rate_headers"][key] = parsed
    result["rate_header_meaning"] = "requests=RPD; tokens=TPM, NOT daily remaining tokens"
    return result


def record_attempt(gate, inputs, reservation: int, reply=None, *, transport_error=False) -> None:
    path = gate.quota.path.parent / "groq-history-telemetry" / (gate.quota.day + ".json")
    data = read_json(path, {"version": 1, "utc_day": gate.quota.day, "attempts": []})
    if data.get("utc_day") != gate.quota.day or not isinstance(data.get("attempts"), list):
        raise ValueError("Malformed historical telemetry; quota reservation remains durable")
    row = {"request_index": gate.quota.used, "run_id": os.getenv("GITHUB_RUN_ID", ""),
           "at": datetime.now(timezone.utc).isoformat(), "input_articles": len(inputs),
           "reserved_tokens": reservation, "validated_articles": 0,
           "validated_response": False, "transport_error": transport_error}
    if reply is not None:
        row.update(safe_response_metadata(reply))
    gate._diagnostic = row
    data["attempts"].append(row)
    data["note"] = "Observed since instrumentation; HTTP success and validated reviews are not publication. Reservations are not actual usage."
    atomic_json(path, data)
    gate._telemetry_path = path
    print("GROQ_HISTORY_ATTEMPT " + json.dumps(row, sort_keys=True))


def mark_validated(gate, count: int) -> None:
    path = gate._telemetry_path
    data = read_json(path, {})
    row = data["attempts"][-1]
    if row["request_index"] != gate.quota.used:
        raise ValueError("Telemetry/quota request mismatch")
    row.update(validated_response=True, validated_articles=count)
    atomic_json(path, data)
    print(f"GROQ_HISTORY_VALIDATED request={gate.quota.used} articles={count}")


def _cache_key(backend, collector, item) -> str:
    context = {"version": 1, "model": backend.MODEL, "instructions": backend.INSTRUCTIONS,
               "schema": backend.schema_for(collector),
               "input": {key: item[key] for key in SAFE_INPUT_FIELDS if key in item}}
    return hashlib.sha256(json.dumps(context, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode()).hexdigest()


def call_with_recovery(backend, gate, inputs, *, _sub_batch=False):
    """Split only malformed/oversize batches; never retry 429/5xx or refusals.

    Every successful sub-batch is cached durably before processing a sibling.
    If a sibling fails or the budget ends, ALL original candidates stay queued;
    a later retry can reuse validated answers instead of paying for them again.
    No partial reply is ever presented as a complete batch to archive_review.
    """
    if not inputs or len(inputs) > backend.BATCH_SIZE:
        raise gate.collector.AISelectionIncompleteError("Groq: batch too large")
    ids = [x.get("event_id") for x in inputs]
    if any(not isinstance(x, str) for x in ids) or len(set(ids)) != len(ids):
        raise gate.collector.AISelectionTransientError("Groq: duplicate or malformed input IDs; queue retained")
    path = gate.quota.path.parent.parent / CACHE_FILE
    data = read_json(path, {"version": 1, "entries": {}})
    if data.get("version") != 1 or not isinstance(data.get("entries"), dict):
        raise ValueError("Malformed Groq validated-review cache")
    keys = {x["event_id"]: _cache_key(backend, gate.collector, x) for x in inputs}
    found, missing = {}, []
    for item in inputs:
        row = copy.deepcopy(data["entries"].get(keys[item["event_id"]]))
        if isinstance(row, dict):
            row["event_id"] = item["event_id"]
            try:
                backend.validated_results({"results": [row]}, [item], gate.collector)
            except gate.collector.AISelectionIncompleteError:
                row = None
        if isinstance(row, dict):
            found[item["event_id"]] = row
        else:
            missing.append(item)
    if found:
        print(f"GROQ_HISTORY_REUSED validated_articles={len(found)} new_http_calls=0")
    if missing:
        gate._diagnostic = None
        try:
            answers = gate._call_once(missing)
        except (gate.collector.AISelectionIncompleteError, gate.collector.AISelectionTransientError) as error:
            diagnostic = gate._diagnostic or {}
            split_allowed = (isinstance(error, gate.collector.AISelectionIncompleteError)
                             or (diagnostic.get("http_status") == 400
                                 and diagnostic.get("error_code") == "json_validate_failed"))
            if split_allowed and len(missing) > 1:
                mid = len(missing) // 2
                # Recursive inputs shrink; every real attempt still uses the SAME
                # rate gate and durable quota. No switch to a weaker JSON mode.
                left = call_with_recovery(backend, gate, missing[:mid], _sub_batch=True)
                right = call_with_recovery(backend, gate, missing[mid:], _sub_batch=True)
                answers = left + right
                data = read_json(path, {"version": 1, "entries": {}})
            elif isinstance(error, gate.collector.AISelectionIncompleteError):
                if not diagnostic and len(inputs) == 1 and not _sub_batch:
                    raise  # Pre-HTTP oversized singleton: preserve the legacy API.
                # Prevent the generic reviewer's terminal skip of unanswered items.
                raise gate.collector.AISelectionTransientError(
                    "Groq singleton validation failed; queue and validated siblings retained") from None
            else:
                code = diagnostic.get("error_code", "unclassified")
                status = diagnostic.get("http_status", "transport")
                raise gate.collector.AISelectionTransientError(
                    f"Groq HTTP {status}; code={code}; queue retained; no blind retry") from None
        # Whole response validated by the unchanged validator, including failures
        # split into sub-batches. Unknown/partial/refused replies are never cached.
        answers = backend.validated_results({"results": answers}, missing, gate.collector)
        for row in answers:
            found[row["event_id"]] = row
            data["entries"][keys[row["event_id"]]] = copy.deepcopy(row)
        atomic_json(path, data)
    return backend.validated_results({"results": [found[x] for x in ids]}, inputs, gate.collector)


def preflight(root: Path, *, maintenance=False, day=None) -> dict:
    """Read-only decision before dependency install or archive replay."""
    day = day or datetime.now(timezone.utc).date().isoformat()
    ledger = read_json(root / "quota/groq-oss120b-public-backfill.json", {})
    if not isinstance(ledger, dict):
        raise ValueError("Malformed Groq quota")
    used = tokens = 0
    if ledger.get("utc_day") == day:
        used, tokens = ledger.get("requests", 0), ledger.get("reserved_tokens", 0)
        if nonnegative_integer(used) is None or nonnegative_integer(tokens) is None:
            raise ValueError("Invalid quota counters; refusing backfill")
    history_enabled = backfill_control.specialist_history_enabled(root)
    run = history_enabled and (maintenance or (used < REQUEST_CAP and tokens + MIN_RUN_RESERVATION <= RESERVED_TOKEN_CAP))
    return {"run_needed": run, "utc_day": day, "maintenance": maintenance,
            "history_enabled": history_enabled,
            "requests": used, "reserved_tokens": tokens,
            "request_cap": REQUEST_CAP, "token_cap": RESERVED_TOKEN_CAP}


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("preflight",))
    parser.add_argument("--root", type=Path, default=Path("."))
    args = parser.parse_args()
    report = preflight(args.root, maintenance=os.getenv("GROQ_MAINTENANCE_ONLY") == "true")
    print("GROQ_HISTORY_PREFLIGHT " + json.dumps(report, sort_keys=True))
    if os.getenv("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as out:
            out.write("run_needed=" + str(report["run_needed"]).lower() + "\n")
