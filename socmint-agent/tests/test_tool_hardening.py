import subprocess
from types import SimpleNamespace

import pytest

from app import tools
from app.tools import search_username_profiles


def no_network(*args, **kwargs):
    pytest.fail("no network request expected")


SHERLOCK_OUTPUT = (
    "Update available! 0.16.0 --> 0.17.0\n"
    "https://github.com/sherlock-project/sherlock/releases/tag/v0.17.0\n"
    "[*] Checking username example on:\n\n"
    "[+] GitHub: https://github.com/example\n"
    "[+] Keybase: https://keybase.io/example\n"
    "[*] Search completed with 2 results\n"
)


def test_sherlock_lists_only_found_profiles(monkeypatch):
    monkeypatch.setattr(tools.subprocess, "run", lambda *a, **k: SimpleNamespace(stdout=SHERLOCK_OUTPUT, stderr="", returncode=0))
    urls = [item["url"] for item in search_username_profiles("example")["results"]]
    assert urls == ["https://github.com/example", "https://keybase.io/example"]


@pytest.mark.parametrize("stdout", [SHERLOCK_OUTPUT, SHERLOCK_OUTPUT.encode(), None])
def test_sherlock_keeps_the_hits_found_before_a_timeout(monkeypatch, stdout):
    def expire(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd="sherlock", timeout=45, output=stdout)

    monkeypatch.setattr(tools.subprocess, "run", expire)
    result = search_username_profiles("example")
    assert result["status"] == "partial"
    assert len(result["results"]) == (2 if stdout else 0)


def test_page_links_cost_no_dns_and_scanning_stops_at_the_cap(monkeypatch):
    monkeypatch.setattr(tools.socket, "getaddrinfo", no_network)
    anchors = "".join(f'<a href="https://host{number}.invalid/">x</a>' for number in range(5000))
    result = tools._page_payload("https://example.org/", ("<html><body>" + anchors + "</body></html>").encode(), "text/html")
    assert len(result["links"]) == tools.MAX_LINKS

    scanned = "".join('<a href="http://127.0.0.1/">x</a>' for _ in range(tools.MAX_ANCHORS_SCANNED))
    late = '<a href="https://late.example/">x</a>'
    result = tools._page_payload("https://example.org/", (scanned + late).encode(), "text/html")
    assert result["links"] == []


def test_page_links_still_exclude_private_targets_without_dns(monkeypatch):
    monkeypatch.setattr(tools.socket, "getaddrinfo", no_network)
    html = '<a href="http://169.254.169.254/x">a</a><a href="http://localhost/x">b</a><a href="https://good.example/x">c</a>'
    links = tools._page_payload("https://example.org/", html.encode(), "text/html")["links"]
    assert [link["url"] for link in links] == ["https://good.example/x"]


@pytest.mark.parametrize("collector", [
    tools.search_public_web, tools.search_bluesky, tools.search_mastodon, tools.search_youtube,
    tools.search_fourchan, tools.search_twitch, tools.search_flickr, tools.search_tumblr,
    tools.search_x, tools.search_reddit, tools.search_linkedin_public,
])
def test_a_non_numeric_limit_does_not_abort_the_run(monkeypatch, collector):
    def refuse(*args, **kwargs):
        raise OSError("no network in this test")

    monkeypatch.setattr(tools.requests, "get", refuse)
    assert isinstance(collector("query", limit="ten"), dict)


def test_a_non_numeric_sherlock_timeout_uses_the_default(monkeypatch):
    seen = {}

    def run(*args, **kwargs):
        seen.update(kwargs)
        return SimpleNamespace(stdout="", stderr="", returncode=0)

    monkeypatch.setattr(tools.subprocess, "run", run)
    search_username_profiles("example", timeout_seconds="soon")
    assert seen["timeout"] == 45
