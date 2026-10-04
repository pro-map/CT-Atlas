import importlib
import json
from types import SimpleNamespace

from fastapi.testclient import TestClient
from google.adk.events import Event
from google.genai import types


def test_investigation_keeps_actual_function_evidence_if_synthesis_fails(monkeypatch):
    monkeypatch.setenv("CT_ATLAS_AGENT_SHARED_SECRET", "test-secret")
    server = importlib.import_module("server")
    async def run(**kwargs):
        yield Event(author="app", content=types.Content(parts=[types.Part.from_function_response(
            name="read_telegram_channel", response={"channel": "examplechan", "status": "success", "messages": [
                {"id": 1, "url": "https://t.me/examplechan/1", "text": "Original evidence"}]} )]))
        raise RuntimeError("Model call limit reached")
    monkeypatch.setattr(server, "runner", SimpleNamespace(run_async=run))
    response = TestClient(server.api).post("/investigate", headers={"X-CT-Atlas-Agent-Key": "test-secret"}, json={"user_id": "tester", "query": {"urls": ["https://t.me/examplechan"]}})
    assert response.status_code == 200
    report = response.json()["report"]
    assert "synthesis incomplete" in report["title"]
    assert report["telegram_evidence"]["messages"][0]["text"] == "Original evidence"


def test_investigation_rejects_model_invented_evidence_annex(monkeypatch):
    monkeypatch.setenv("CT_ATLAS_AGENT_SHARED_SECRET", "test-secret")
    server = importlib.import_module("server")
    async def run(**kwargs):
        yield Event(author="app", content=types.Content(parts=[types.Part.from_text(text=json.dumps({
            "executive_assessment": "No collected Telegram posts.", "telegram_evidence": {"messages": [{"text": "invented"}]}}))]))
    monkeypatch.setattr(server, "runner", SimpleNamespace(run_async=run))
    response = TestClient(server.api).post("/investigate", headers={"X-CT-Atlas-Agent-Key": "test-secret"}, json={"user_id": "tester", "query": {}})
    assert response.status_code == 200
    assert "telegram_evidence" not in response.json()["report"]
