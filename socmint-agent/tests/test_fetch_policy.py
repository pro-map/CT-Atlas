import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import tools
from app.tools import NO_DIRECT_FETCH_HOSTS, fetch_public_url, is_no_direct_fetch, transcribe_public_media


def no_network(*args, **kwargs):
    pytest.fail("no network request expected")


@pytest.mark.parametrize("url", [
    "https://www.linkedin.com/in/someone",
    "https://facebook.com/page",
    "https://m.facebook.com/page",
    "https://www.instagram.com/someone/",
    "https://www.threads.net/@someone",
    "https://www.threads.com/@someone",
    "https://x.com/someone",
    "https://twitter.com/someone",
    "https://www.tiktok.com/@someone",
    "https://old.reddit.com/r/test",
    "https://lnkd.in/abc",
    "https://t.co/abc",
])
def test_policy_blocked_hosts_are_never_requested(monkeypatch, url):
    monkeypatch.setattr(tools.requests, "get", no_network)
    monkeypatch.setattr(tools.socket, "getaddrinfo", no_network)
    result = fetch_public_url(url)
    assert result["status"] == "policy_blocked"
    assert "text" not in result


@pytest.mark.parametrize("url", ["https://notx.com/a", "https://x.com.evil.org/a", "https://mylinkedin.com/", "https://t.me/s/example"])
def test_lookalike_hosts_are_not_policy_blocked(url):
    assert is_no_direct_fetch(url) is False


def test_a_redirect_into_a_blocked_host_is_stopped_at_that_hop(monkeypatch):
    requested = []

    def redirecting(url, **kwargs):
        requested.append(url)
        return SimpleNamespace(status_code=302, headers={"Location": "https://www.linkedin.com/in/someone"}, close=lambda: None)

    monkeypatch.setattr(tools.requests, "get", redirecting)
    monkeypatch.setattr(tools.socket, "getaddrinfo", lambda *a, **k: [(0, 0, 0, "", ("93.184.216.34", 0))])
    result = fetch_public_url("https://short.example/abc")
    assert result["status"] == "policy_blocked"
    assert requested == ["https://short.example/abc"]


def test_groq_is_not_sent_a_blocked_url(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "not-a-real-key")
    monkeypatch.setattr(tools.requests, "post", no_network)
    assert transcribe_public_media("https://www.tiktok.com/@someone/video/1")["status"] == "policy_blocked"


def test_the_worker_and_the_agent_block_the_same_hosts():
    source = (Path(__file__).parents[2] / "cloudflare-worker" / "social-intel.js").read_text(encoding="utf-8")
    block = re.search(r"const NO_DIRECT_FETCH_HOSTS = \[(.*?)\];", source, re.S).group(1)
    assert sorted(re.findall(r'"([^"]+)"', block)) == sorted(NO_DIRECT_FETCH_HOSTS)
