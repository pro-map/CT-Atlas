from types import SimpleNamespace

import pytest

from app import tools
from app.tools import search_bluesky, search_reddit, search_x, social_capabilities


def no_network(*args, **kwargs):
    pytest.fail("no network request expected")


def test_bluesky_post_search_uses_the_host_that_still_answers(monkeypatch):
    requested = []

    def answer(url, **kwargs):
        requested.append(url)
        return SimpleNamespace(raise_for_status=lambda: None, json=lambda: {"posts": [], "actors": []})

    monkeypatch.setattr(tools.requests, "get", answer)
    assert search_bluesky("test", mode="posts")["status"] == "success"
    assert search_bluesky("test", mode="accounts")["status"] == "success"
    assert requested == [
        "https://api.bsky.app/xrpc/app.bsky.feed.searchPosts",
        "https://public.api.bsky.app/xrpc/app.bsky.actor.searchActors",
    ]


def probe_answers(monkeypatch, refused=()):
    calls = []

    def answer(url, **kwargs):
        calls.append(url)
        marker = next(probe[2] for probe in tools._COLLECTOR_PROBES.values() if probe[0] == url)
        return SimpleNamespace(ok=url not in refused, text=marker if url not in refused else "403 Forbidden")

    monkeypatch.setattr(tools.requests, "get", answer)
    monkeypatch.setitem(tools._collector_cache, "flags", None)
    return calls


def test_a_collector_that_refuses_its_probe_reports_false(monkeypatch):
    probe_answers(monkeypatch, refused={"https://api.bsky.app/xrpc/app.bsky.feed.searchPosts", "https://t.me/s/telegram"})
    caps = social_capabilities()
    assert caps["bluesky_post_search"] is False
    assert caps["bluesky_public"] is True
    assert caps["telegram_channel_reader"] is False
    assert caps["fourchan_public"] is True


def test_a_200_without_the_expected_content_is_not_healthy(monkeypatch):
    monkeypatch.setattr(tools.requests, "get", lambda url, **k: SimpleNamespace(ok=True, text="<html>consent wall</html>"))
    assert tools._probe_collector("https://t.me/s/telegram", {}, "tgme_widget_message") is False


def test_collector_probes_are_cached(monkeypatch):
    calls = probe_answers(monkeypatch)
    social_capabilities()
    social_capabilities()
    assert len(calls) == len(tools._COLLECTOR_PROBES)


def test_sherlock_flag_reports_whether_the_tool_is_installed(monkeypatch):
    monkeypatch.setattr(tools, "_collector_status", lambda: dict.fromkeys(tools._COLLECTOR_PROBES, True))
    monkeypatch.setattr(tools.importlib.util, "find_spec", lambda name: None)
    assert social_capabilities()["sherlock_username_discovery"] is False
    monkeypatch.setattr(tools.importlib.util, "find_spec", lambda name: object())
    assert social_capabilities()["sherlock_username_discovery"] is True


def test_a_token_alone_does_not_enable_x_or_reddit(monkeypatch):
    monkeypatch.setenv("X_BEARER_TOKEN", "a-token")
    monkeypatch.setenv("REDDIT_CLIENT_ID", "an-id")
    monkeypatch.setenv("REDDIT_CLIENT_SECRET", "a-value")
    monkeypatch.delenv("X_WRITTEN_APPROVAL", raising=False)
    monkeypatch.delenv("REDDIT_WRITTEN_APPROVAL", raising=False)
    monkeypatch.setattr(tools, "_collector_status", lambda: dict.fromkeys(tools._COLLECTOR_PROBES, True))
    monkeypatch.setattr(tools.requests, "get", no_network)
    monkeypatch.setattr(tools.requests, "post", no_network)
    assert search_x("test")["status"] == "unavailable"
    assert search_reddit("test")["status"] == "unavailable"
    caps = social_capabilities()
    assert caps["x_api"] is False
    assert caps["reddit_oauth"] is False
