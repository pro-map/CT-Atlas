"""/investigate through the real ADK Runner with a stub model: no network, no Gemini."""
import asyncio
import importlib
import json
import time
from types import SimpleNamespace
from typing import AsyncGenerator

import httpx
import pytest
from fastapi.testclient import TestClient
from google.adk.agents.invocation_context import LlmCallsLimitExceededError
from google.adk.events import Event
from google.adk.models import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.tools.function_tool import FunctionTool
from google.genai import types

from app import tools
from app.run_budget import FINAL_REPORT_INSTRUCTION

HEADERS = {"X-CT-Atlas-Agent-Key": "test-secret"}
QUERY = {"user_id": "tester", "query": {"mode": "discover", "target": "example"}}


class DiligentStub(BaseLlm):
    """Never stops asking for tools unless the request forbids them."""
    tool_name: str = "search_public_web"
    tool_args: dict = {"query": "example"}
    seen: list = []

    async def generate_content_async(self, llm_request, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        tool_config = llm_request.config.tool_config
        mode = tool_config.function_calling_config.mode if tool_config else None
        self.seen.append(mode)
        if mode == types.FunctionCallingConfigMode.NONE:
            assert FINAL_REPORT_INSTRUCTION in str(llm_request.config.system_instruction)
            text = json.dumps({"title": "Done", "executive_assessment": "Assessment from collected evidence."})
            yield LlmResponse(content=types.Content(role="model", parts=[types.Part.from_text(text=text)]))
            return
        part = types.Part.from_function_call(name=self.tool_name, args=self.tool_args)
        yield LlmResponse(content=types.Content(role="model", parts=[part]))


@pytest.fixture
def server(monkeypatch):
    monkeypatch.setenv("CT_ATLAS_AGENT_SHARED_SECRET", "test-secret")
    monkeypatch.setenv("SOCMINT_SEARCH_PROVIDER", "brave")
    monkeypatch.setenv("BRAVE_SEARCH_API_KEY", "not-a-real-key")
    module = importlib.import_module("server")
    monkeypatch.setattr(tools, "_search_brave", lambda query, limit: [
        {"title": "Result", "url": "https://example.org/found", "snippet": "Snippet", "provider": "brave"}
    ])
    return module


def use_stub(monkeypatch, server, **fields):
    stub = DiligentStub(model="stub", seen=[], **fields)
    monkeypatch.setattr(server.root_agent, "model", stub)
    return stub


def fake_runner(monkeypatch, server, tool_name, tool_response, error):
    async def run(**kwargs):
        yield Event(author="app", content=types.Content(parts=[
            types.Part.from_function_response(name=tool_name, response=tool_response)]))
        raise error
    monkeypatch.setattr(server, "runner", SimpleNamespace(run_async=run))


def test_the_last_llm_call_is_reserved_for_the_final_report(monkeypatch, server):
    stub = use_stub(monkeypatch, server)
    response = TestClient(server.api).post("/investigate", headers=HEADERS, json=QUERY)
    assert response.status_code == 200
    body = response.json()
    assert body["report"]["title"] == "Done"
    assert body["meta"]["partial"] is False
    assert body["meta"]["forced_final"] is True
    assert body["meta"]["llm_calls"] == server.MAX_LLM_CALLS
    assert len(stub.seen) == server.MAX_LLM_CALLS
    assert stub.seen[:-1].count(types.FunctionCallingConfigMode.NONE) == 0
    assert {"url": "https://example.org/found", "kind": "search_result"}.items() <= body["meta"]["evidence_ledger"][0].items()


def test_llm_limit_keeps_non_telegram_evidence_as_a_partial_report(monkeypatch, server):
    fake_runner(monkeypatch, server, "search_public_web",
                {"status": "success", "results": [{"url": "https://example.org/a", "title": "A", "snippet": "S"}]},
                LlmCallsLimitExceededError("Max number of llm calls limit of `12` exceeded"))
    response = TestClient(server.api).post("/investigate", headers=HEADERS, json=QUERY)
    assert response.status_code == 200
    body = response.json()
    assert "synthesis incomplete" in body["report"]["title"]
    assert body["report"]["sources"] == [{"url": "https://example.org/a", "title": "A", "kind": "search_result"}]
    assert body["meta"]["partial"] is True
    assert body["meta"]["stop_reason"] == "llm_call_limit"


def test_a_failure_with_nothing_collected_still_reaches_the_worker(monkeypatch, server):
    fake_runner(monkeypatch, server, "social_capabilities", {"status": "success"}, RuntimeError("429 quota exceeded"))
    response = TestClient(server.api).post("/investigate", headers=HEADERS, json=QUERY)
    assert response.status_code == 429


def test_an_unusable_final_answer_falls_back_to_the_ledger(monkeypatch, server):
    async def run(**kwargs):
        yield Event(author="app", content=types.Content(parts=[types.Part.from_function_response(
            name="fetch_public_url", response={"status": "success", "url": "https://example.org/", "title": "T", "text": "B"})]))
        yield Event(author="app", content=types.Content(parts=[types.Part.from_text(text="Not a report.")]))
    monkeypatch.setattr(server, "runner", SimpleNamespace(run_async=run))
    body = TestClient(server.api).post("/investigate", headers=HEADERS, json=QUERY).json()
    assert body["meta"]["partial"] is True
    assert body["meta"]["stop_reason"] == "invalid_report"
    assert body["report"]["sources"][0]["kind"] == "direct_public_page"


def test_the_deadline_stops_a_stuck_tool_and_returns_what_was_collected(monkeypatch, server):
    # Second tool turn hangs far past the deadline: the first turn's evidence must survive.
    original = tools._search_brave
    calls = []

    def slow_search(query, limit):
        calls.append(query)
        if len(calls) > 1:
            time.sleep(5)
        return original(query, limit)

    monkeypatch.setattr(tools, "_search_brave", slow_search)
    use_stub(monkeypatch, server)

    # Timed inside the loop: closing a loop waits for the abandoned tool thread,
    # which a long-running server never does.
    async def timed_request():
        transport = httpx.ASGITransport(app=server.api)
        async with httpx.AsyncClient(transport=transport, base_url="http://agent") as client:
            started = time.monotonic()
            answer = await client.post("/investigate", headers=HEADERS, json={**QUERY, "deadline_seconds": 1}, timeout=20)
            return answer, time.monotonic() - started

    response, elapsed = asyncio.run(timed_request())
    assert elapsed < 2
    assert response.status_code == 200
    body = response.json()
    assert body["meta"]["partial"] is True
    assert body["meta"]["stop_reason"] == "deadline"
    assert body["report"]["sources"][0]["url"] == "https://example.org/found"


def test_a_deadline_with_nothing_collected_lets_the_worker_fall_back(monkeypatch, server):
    monkeypatch.setattr(tools, "_search_brave", lambda query, limit: time.sleep(5) or [])
    use_stub(monkeypatch, server)
    response = TestClient(server.api).post("/investigate", headers=HEADERS, json={**QUERY, "deadline_seconds": 1})
    assert response.status_code == 504


def test_the_synthesis_deadline_takes_the_tools_away_before_the_hard_deadline(monkeypatch, server):
    monkeypatch.setattr(server, "SYNTHESIS_RESERVE_SECONDS", 1000)
    monkeypatch.setattr(tools, "_search_brave", lambda query, limit: time.sleep(1.2) or [
        {"title": "Result", "url": "https://example.org/found", "snippet": "S", "provider": "brave"}])
    use_stub(monkeypatch, server)
    body = TestClient(server.api).post("/investigate", headers=HEADERS, json=QUERY).json()
    assert body["report"]["title"] == "Done"
    assert body["meta"]["forced_final"] is True
    assert body["meta"]["llm_calls"] == 2


def test_a_slow_tool_no_longer_blocks_the_event_loop(monkeypatch, server):
    monkeypatch.setattr(tools, "_search_brave", lambda query, limit: time.sleep(1) or [
        {"title": "Result", "url": "https://example.org/found", "snippet": "S", "provider": "brave"}])
    monkeypatch.setattr(server, "MAX_LLM_CALLS", 2)
    use_stub(monkeypatch, server)
    gaps = []

    async def scenario():
        async def beat(stop):
            last = time.monotonic()
            while not stop.is_set():
                await asyncio.sleep(0.05)
                gaps.append(time.monotonic() - last)
                last = time.monotonic()
        stop = asyncio.Event()
        task = asyncio.create_task(beat(stop))
        transport = httpx.ASGITransport(app=server.api)
        async with httpx.AsyncClient(transport=transport, base_url="http://agent") as client:
            response = await client.post("/investigate", headers=HEADERS, json=QUERY, timeout=20)
        stop.set()
        await task
        return response

    assert asyncio.run(scenario()).status_code == 200
    assert max(gaps) < 0.5


def test_sessions_are_deleted_after_success_and_after_failure(monkeypatch, server):
    use_stub(monkeypatch, server)
    client = TestClient(server.api)
    assert client.post("/investigate", headers=HEADERS, json=QUERY).status_code == 200
    fake_runner(monkeypatch, server, "social_capabilities", {"status": "success"}, RuntimeError("boom"))
    assert client.post("/investigate", headers=HEADERS, json=QUERY).status_code == 502
    stored = server.session_service.sessions.get(server.APP_NAME, {})
    assert not any(stored.values())


def test_a_non_ascii_agent_key_is_rejected_rather_than_crashing(server):
    response = TestClient(server.api).post("/investigate", headers={"X-CT-Atlas-Agent-Key": "café".encode("latin-1")}, json=QUERY)
    assert response.status_code == 401


def test_health_shows_a_collector_that_failed_its_probe(monkeypatch, server):
    flags = dict.fromkeys(tools._COLLECTOR_PROBES, True) | {"bluesky_post_search": False}
    monkeypatch.setattr(tools, "_collector_status", lambda: flags)
    sources = TestClient(server.api).get("/health").json()["social_sources"]
    assert sources["bluesky_post_search"] is False
    assert sources["bluesky_public"] is True


def test_auth_check_tells_a_stale_key_from_a_good_one(server):
    client = TestClient(server.api)
    assert client.get("/auth-check", headers=HEADERS).json() == {"ok": True}
    assert client.get("/auth-check", headers={"X-CT-Atlas-Agent-Key": "stale"}).status_code == 401
    assert client.get("/auth-check").status_code == 401


def test_off_thread_wrappers_keep_what_the_model_sees():
    agent_module = importlib.import_module("app.agent")
    for bare in (tools.search_bluesky, tools.fetch_public_url, tools.explore_telegram_network):
        wrapped = next(tool for tool in agent_module.root_agent.tools if tool.__name__ == bare.__name__)
        assert asyncio.iscoroutinefunction(wrapped)
        assert FunctionTool(wrapped)._get_declaration() == FunctionTool(bare)._get_declaration()


def test_x_and_reddit_need_written_approval_even_with_keys(monkeypatch):
    monkeypatch.setenv("X_BEARER_TOKEN", "a-token")
    monkeypatch.setenv("REDDIT_CLIENT_ID", "an-id")
    monkeypatch.setenv("REDDIT_CLIENT_SECRET", "a-value")
    monkeypatch.delenv("X_WRITTEN_APPROVAL", raising=False)
    monkeypatch.delenv("REDDIT_WRITTEN_APPROVAL", raising=False)
    agent_module = importlib.reload(importlib.import_module("app.agent"))
    names = {tool.__name__ for tool in agent_module.root_agent.tools}
    assert "search_x" not in names and "search_reddit" not in names
    assert "search_x" not in agent_module.INSTRUCTION and "search_reddit" not in agent_module.INSTRUCTION

    monkeypatch.setenv("X_WRITTEN_APPROVAL", "1")
    monkeypatch.setenv("REDDIT_WRITTEN_APPROVAL", "1")
    agent_module = importlib.reload(agent_module)
    names = {tool.__name__ for tool in agent_module.root_agent.tools}
    assert {"search_x", "search_reddit"} <= names

    monkeypatch.delenv("X_WRITTEN_APPROVAL")
    monkeypatch.delenv("REDDIT_WRITTEN_APPROVAL")
    importlib.reload(agent_module)


def test_the_prompt_lists_every_registered_tool():
    agent_module = importlib.import_module("app.agent")
    for tool in agent_module.root_agent.tools:
        assert tool.__name__ + "(" in agent_module.INSTRUCTION, tool.__name__
