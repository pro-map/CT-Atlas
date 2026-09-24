import importlib


def _reload_agent_with_env(monkeypatch, **env):
    """app.agent builds root_agent at import time from os.getenv(...), so
    exercising a different environment requires a real module reload, not
    just setting env vars before a cached import."""
    for key in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    import app.agent as agent_module

    return importlib.reload(agent_module)


def test_gemini_model_is_configured_with_the_deployed_env_var_name(monkeypatch):
    # Regression test: Cloud Run is configured with GEMINI_API_KEY (see
    # .github/workflows/deploy-socmint-agent.yml), but google-genai's own
    # auto-detection only reads GOOGLE_API_KEY. Without explicitly passing
    # the key through client_kwargs, every real /investigate call fails auth
    # and server.py's generic exception handler reports it as a plain 502 --
    # this broke the 2026-09-24 deploy (run #45) silently past "Verify agent
    # health", which never calls the model.
    agent_module = _reload_agent_with_env(monkeypatch, GEMINI_API_KEY="deployed-key-value")
    client_kwargs = agent_module.root_agent.model.client_kwargs
    assert client_kwargs.get("api_key") == "deployed-key-value"


def test_gemini_model_also_accepts_google_api_key_directly(monkeypatch):
    agent_module = _reload_agent_with_env(monkeypatch, GOOGLE_API_KEY="google-style-key")
    client_kwargs = agent_module.root_agent.model.client_kwargs
    assert client_kwargs.get("api_key") == "google-style-key"


def test_missing_key_does_not_crash_module_import(monkeypatch):
    # No key at all should still let the module import (Cloud Run's own
    # deploy-secret verification step is what should catch a missing key,
    # not an import-time crash here).
    agent_module = _reload_agent_with_env(monkeypatch)
    assert agent_module.root_agent is not None
