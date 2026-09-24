from __future__ import annotations

import hmac
import json
import os
import re
import uuid
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from google.adk.agents.run_config import RunConfig
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types
from pydantic import BaseModel, Field

from app.agent import root_agent
from app.tools import social_capabilities


APP_NAME = "app"
AGENT_SERVICE_VERSION = "ct-atlas-socmint-adk-v1"
MAX_LLM_CALLS = 12

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

    supplied = str(value or "")
    if not hmac.compare_digest(expected, supplied):
        raise HTTPException(status_code=401, detail="Unauthorized agent request.")


def _clean_user_id(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.@-]+", "_", str(value or "").strip())[:64]
    return cleaned or "ct_atlas_user"


def _extract_json(text: str) -> dict[str, Any]:
    value = str(text or "").strip()
    value = re.sub(r"^\`\`\`(?:json)?\s*", "", value, flags=re.I)
    value = re.sub(r"\s*\`\`\`$", "", value)

    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        start = value.find("{")
        end = value.rfind("}")
        if start < 0 or end <= start:
            raise HTTPException(status_code=502, detail="Agent did not return JSON.")
        try:
            parsed = json.loads(value[start : end + 1])
        except json.JSONDecodeError as exc:
            raise HTTPException(
                status_code=502,
                detail="Agent returned malformed report JSON.",
            ) from exc

    if not isinstance(parsed, dict):
        raise HTTPException(status_code=502, detail="Agent report must be a JSON object.")
    if not str(parsed.get("executive_assessment") or "").strip():
        raise HTTPException(status_code=502, detail="Agent report is missing executive assessment.")
    return parsed


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
        "social_sources": social_capabilities(),
    }


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
    try:
        async for event in runner.run_async(
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
        ):
            event_count += 1
            if event.is_final_response() and event.content:
                pieces = [
                    part.text
                    for part in (event.content.parts or [])
                    if getattr(part, "text", None)
                ]
                if pieces:
                    final_text = "\n".join(pieces)
    except Exception as exc:
        message = re.sub(r"\s+", " ", str(exc)).strip()[:1000]
        status = 429 if "429" in message or "quota" in message.lower() else 502
        raise HTTPException(status_code=status, detail=message or "ADK investigation failed.") from exc

    report = _extract_json(final_text)
    return {
        "ok": True,
        "report": report,
        "meta": {
            "agent_version": AGENT_SERVICE_VERSION,
            "session_id": session_id,
            "event_count": event_count,
            "max_llm_calls": max_llm_calls,
        },
    }
