from __future__ import annotations

import asyncio
import hmac
import json
import os
import re
import time
import uuid
from contextlib import aclosing
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from json_repair import repair_json
from google.adk.agents.run_config import RunConfig
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types
from pydantic import BaseModel, Field

from app.agent import root_agent
from app.evidence_ledger import EvidenceLedger
from app.run_budget import RunBudget, track_budget
from app.tools import social_capabilities


APP_NAME = "app"
AGENT_SERVICE_VERSION = "ct-atlas-socmint-adk-v2"
MAX_LLM_CALLS = 12
# The Worker gives up after 115 s, so a run must answer before that or its evidence
# and every Gemini call spent on it are lost.
DEFAULT_DEADLINE_SECONDS = 100
MAX_DEADLINE_SECONDS = 110
# Tools stop this long before the deadline, leaving time for the final report.
SYNTHESIS_RESERVE_SECONDS = 25

api = FastAPI(
    title="CT Atlas SOCMINT ADK Agent",
    version=AGENT_SERVICE_VERSION,
)

session_service = InMemorySessionService()
runner = Runner(
    agent=root_agent,
    app_name=APP_NAME,
    session_service=session_service,
)


class InvestigationRequest(BaseModel):
    user_id: str = Field(min_length=1, max_length=64)
    query: dict[str, Any]
    deadline_seconds: int = Field(default=DEFAULT_DEADLINE_SECONDS, ge=1, le=MAX_DEADLINE_SECONDS)


def _check_agent_key(value: str | None) -> None:
    expected = os.getenv("CT_ATLAS_AGENT_SHARED_SECRET", "").strip()
    insecure_local = os.getenv("SOCMINT_AGENT_ALLOW_INSECURE_LOCAL", "").strip() == "1"

    if not expected:
        if insecure_local:
            return
        raise HTTPException(
            status_code=503,
            detail="Agent shared secret is not configured.",
        )

    # Bytes: compare_digest raises TypeError on non-ASCII str.
    supplied = str(value or "")
    if not hmac.compare_digest(expected.encode(), supplied.encode()):
        raise HTTPException(status_code=401, detail="Unauthorized agent request.")


def _clean_user_id(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.@-]+", "_", str(value or "").strip())[:64]
    return cleaned or "ct_atlas_user"


def _extract_json(text: str) -> dict[str, Any]:
    value = str(text or "").strip()
    value = re.sub(r"^```(?:json)?\s*", "", value, flags=re.I)
    value = re.sub(r"\s*```$", "", value)

    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        # Model output can contain small syntax defects even when instructed
        # to return JSON. Repair syntax only, then keep the semantic checks
        # below so broken or incomplete reports are still rejected.
        try:
            parsed = repair_json(value, return_objects=True)
        except Exception as exc:
            raise HTTPException(
                status_code=502,
                detail="Agent returned malformed report JSON.",
            ) from exc

    if not isinstance(parsed, dict):
        raise HTTPException(status_code=502, detail="Agent report must be a JSON object.")
    if not str(parsed.get("executive_assessment") or "").strip():
        raise HTTPException(status_code=502, detail="Agent report is missing executive assessment.")
    return parsed


_STOP_REASONS = {
    "deadline": "the time limit was reached",
    "llm_call_limit": "the model call limit was reached",
    "model_error": "the model call failed",
    "invalid_report": "the model's report was unusable",
}


def _partial_report(ledger: EvidenceLedger, stop_reason: str) -> dict[str, Any]:
    return {
        "title": "Collected evidence — synthesis incomplete",
        "executive_assessment": f"Public sources were collected, but automated synthesis did not complete: {_STOP_REASONS[stop_reason]}. Review the retained sources and their direct citations below.",
        "source_coverage": ledger.coverage(),
        "analytical_gaps": "No completed analytical assessment. Observed connections are references in collected material, not verified affiliation or ownership.",
        "sources": ledger.report_sources(),
    }


@api.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "ct-atlas-socmint-adk-agent",
        "version": AGENT_SERVICE_VERSION,
        "app_name": APP_NAME,
        "model": os.getenv("SOCMINT_AGENT_MODEL", "gemini-3.5-flash-lite"),
        "google_search_grounding": False,
        "search_provider": os.getenv("SOCMINT_SEARCH_PROVIDER", "disabled"),
        "max_llm_calls": MAX_LLM_CALLS,
        "social_sources": await asyncio.to_thread(social_capabilities),
    }


# /health is public and says nothing about the Worker's key. This is how the status
# page tells a stale key from a healthy agent.
@api.get("/auth-check")
async def auth_check(x_ct_atlas_agent_key: str | None = Header(default=None)) -> dict[str, Any]:
    _check_agent_key(x_ct_atlas_agent_key)
    return {"ok": True}


@api.post("/investigate")
async def investigate(
    request: InvestigationRequest,
    x_ct_atlas_agent_key: str | None = Header(default=None),
) -> dict[str, Any]:
    _check_agent_key(x_ct_atlas_agent_key)

    user_id = _clean_user_id(request.user_id)
    session_id = "socmint_" + uuid.uuid4().hex

    await session_service.create_session(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=session_id,
        state={
            "ct_atlas_query": request.query,
            "investigation_id": session_id,
        },
    )

    smoke_test = bool(request.query.get("smoke_test"))
    if smoke_test:
        prompt = (
            "CT Atlas deployment smoke test. Use ONLY fetch_public_url on the single "
            "supplied URL, do not call any discovery/search/username/social-platform "
            "tools, and immediately return the smallest valid JSON report matching "
            "the required schema. Do not perform iterative exploration.\n\n"
            + json.dumps(request.query, ensure_ascii=False)
        )
        max_llm_calls = 3
    else:
        prompt = (
            "Run a CT Atlas public-source SOCMINT investigation using this analyst "
            "input. Work iteratively with your tools before producing the final "
            "JSON report. Gemini Google Search grounding is unavailable; do not "
            "attempt to use it.\n\n"
            + json.dumps(request.query, ensure_ascii=False)
        )
        max_llm_calls = MAX_LLM_CALLS

    final_text = ""
    event_count = 0
    stop_reason = "completed"
    ledger = EvidenceLedger()
    deadline = request.deadline_seconds
    budget = RunBudget(
        max_llm_calls=max_llm_calls,
        synthesis_deadline=time.monotonic() + max(1, deadline - SYNTHESIS_RESERVE_SECONDS),
    )

    async def collect() -> None:
        nonlocal final_text, event_count
        async with aclosing(runner.run_async(
            user_id=user_id,
            session_id=session_id,
            new_message=types.Content(
                role="user",
                parts=[types.Part.from_text(text=prompt)],
            ),
            run_config=RunConfig(
                max_llm_calls=max_llm_calls,
                custom_metadata={
                    "ct_atlas_module": "socmint",
                    "investigation_id": session_id,
                },
            ),
        )) as events:
            async for event in events:
                event_count += 1
                for part in (getattr(event.content, "parts", None) or []):
                    response = getattr(part, "function_response", None)
                    if response:
                        ledger.capture(response.name, response.response)
                if event.is_final_response() and event.content:
                    pieces = [
                        part.text
                        for part in (event.content.parts or [])
                        if getattr(part, "text", None)
                    ]
                    if pieces:
                        final_text = "\n".join(pieces)

    try:
        with track_budget(session_id, budget):
            await asyncio.wait_for(collect(), timeout=deadline)
    except asyncio.TimeoutError as exc:
        stop_reason = "deadline"
        if not ledger.has_evidence():
            raise HTTPException(status_code=504, detail="The investigation deadline passed before any public source was collected.") from exc
    except Exception as exc:
        stop_reason = "llm_call_limit" if type(exc).__name__ == "LlmCallsLimitExceededError" else "model_error"
        message = re.sub(r"\s+", " ", str(exc)).strip()[:1000]
        status = 429 if "429" in message or "quota" in message.lower() else 502
        if not ledger.has_evidence():
            raise HTTPException(status_code=status, detail=message or "ADK investigation failed.") from exc
    finally:
        await session_service.delete_session(app_name=APP_NAME, user_id=user_id, session_id=session_id)

    partial = False
    try:
        report = _extract_json(final_text)
        stop_reason = "completed"
    except HTTPException:
        if not ledger.has_evidence():
            raise
        partial = True
        if stop_reason == "completed":
            stop_reason = "invalid_report"
        report = _partial_report(ledger, stop_reason)
    # Never accept an evidence annex invented by the language model.
    report.pop("telegram_evidence", None)
    if ledger.telegram.channels:
        report["telegram_evidence"] = ledger.telegram.build()
    return {
        "ok": True,
        "report": report,
        "meta": {
            "agent_version": AGENT_SERVICE_VERSION,
            "session_id": session_id,
            "event_count": event_count,
            "max_llm_calls": max_llm_calls,
            "llm_calls": budget.llm_calls,
            "forced_final": budget.forced_final,
            "partial": partial,
            "stop_reason": stop_reason,
            "evidence_ledger": ledger.as_list(),
        },
    }
