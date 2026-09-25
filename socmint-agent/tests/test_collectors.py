"""Tests for the Telegram channel reader, Wayback captures, Odysee search and
checksum wallet validation. No network: HTTP is replaced with fakes; the HTML
fixture mirrors the markup of the real https://t.me/s/<channel> preview."""
import pytest

from app import tools
from app.tools import extract_public_indicators, social_capabilities

# ---------------------------------------------------------------------------
# Wallet validation
# ---------------------------------------------------------------------------
VALID_WALLETS = {
    "bitcoin": [
        "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",  # genesis P2PKH
        "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy",  # P2SH
        "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",  # BIP173 bech32
        "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",  # BIP350 bech32m
        "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4",  # all-uppercase is valid
    ],
    "tron": ["TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "TA3941uFAvmVibSkQ6fMJXxmaSNovX86mz"],
    "evm": ["0x52908400098527886E0F7030069857D2E4169EE7"],
}
INVALID_WALLETS = {
    "bitcoin": [
        "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb",  # one character changed
        "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5",
        "Bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",  # mixed case is invalid
    ],
    "tron": ["TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u"],
    "evm": ["0x123", "0x" + "g" * 40],
}


@pytest.mark.parametrize("kind,address", [(k, a) for k, v in VALID_WALLETS.items() for a in v])
def test_real_wallet_strings_pass_validation(kind, address):
    assert tools.is_valid_wallet(kind, address)


@pytest.mark.parametrize("kind,address", [(k, a) for k, v in INVALID_WALLETS.items() for a in v])
def test_corrupted_wallet_strings_fail_validation(kind, address):
    assert not tools.is_valid_wallet(kind, address)


def test_indicator_extraction_drops_lookalikes_that_fail_the_checksum():
    text = (
        "Donate 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa or 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb, "
        "TRON TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t / TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u"
    )
    wallets = extract_public_indicators(text)["wallets"]
    assert wallets["bitcoin"] == ["1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"]
    assert wallets["tron"] == ["TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"]


# ---------------------------------------------------------------------------
# Telegram public channel reader
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("value,expected", [
    ("@example_channel", "example_channel"),
    ("example_channel", "example_channel"),
    ("https://t.me/example_channel", "example_channel"),
    ("t.me/s/example_channel", "example_channel"),
    ("https://t.me/example_channel/123?single", "example_channel"),
    ("https://telegram.me/Example_Channel/", "Example_Channel"),
])
def test_telegram_channel_normalisation(value, expected):
    assert tools._normalize_telegram_channel(value) == expected


@pytest.mark.parametrize("value", [
    "", "ab", "t.me/+AbCdEf123456", "https://t.me/joinchat/AAAA", "t.me/c/123456/7",
    "t.me/addstickers/pack", "1startswithdigit", "has space", "t.me/",
])
def test_telegram_private_invite_and_invalid_inputs_are_refused(value):
    with pytest.raises(ValueError):
        tools._normalize_telegram_channel(value)


PREVIEW_HTML = """
<html><body>
<div class="tgme_channel_info">
  <div class="tgme_channel_info_header"><div class="tgme_channel_info_header_title"><span dir="auto">Example Channel</span></div>
  <div class="tgme_channel_info_header_username"><a href="https://t.me/examplechan">@examplechan</a></div></div>
  <div class="tgme_channel_info_counters">
    <div class="tgme_channel_info_counter"><span class="counter_value">12.3K</span> <span class="counter_type">subscribers</span></div>
    <div class="tgme_channel_info_counter"><span class="counter_value">45</span> <span class="counter_type">photos</span></div>
  </div>
  <div class="tgme_channel_info_description">Line one<br/>Line two</div>
</div>
<section class="tgme_channel_history js-message_history">
<a class="tme_messages_more js-messages_more" href="/s/examplechan?before=101" data-before="101"></a>
<div class="tgme_widget_message_wrap js-widget_message_wrap">
 <div class="tgme_widget_message js-widget_message" data-post="examplechan/101">
  <div class="tgme_widget_message_bubble">
   <div class="tgme_widget_message_author"><a class="tgme_widget_message_owner_name" href="https://t.me/examplechan"><span dir="auto">Example Channel</span></a></div>
   <div class="tgme_widget_message_forwarded_from js-message_forwarded_from">Forwarded from
     <a class="tgme_widget_message_forwarded_from_name js-message_forwarded_from_name" href="https://t.me/othersource/12"><span dir="auto">Other Source</span></a></div>
   <a class="tgme_widget_message_reply js-message_reply" href="https://t.me/examplechan/99">
     <div class="tgme_widget_message_text js-message_reply_text" dir="auto">quoted reply text that is NOT the post text</div></a>
   <div class="tgme_widget_message_photo_wrap" style="background-image:url('x')"></div>
   <div class="tgme_widget_message_text js-message_text" dir="auto">Support us:<br/>BTC 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa<br/>fake 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb
     see <a href="https://t.me/othersource">@othersource</a> and <a href="https://t.me/examplechan">@examplechan</a>,
     join <a href="https://t.me/+PrivateInviteHash">invite</a>, more at <a href="https://www.example.org/page">example.org</a> #topic #Topic</div>
   <a class="tgme_widget_message_link_preview" href="https://www.example.org/page"><div class="link_preview_site_name">Example</div><div class="link_preview_title">A page</div></a>
   <div class="tgme_widget_message_footer"><div class="tgme_widget_message_info">
     <span class="tgme_widget_message_views">1.44M</span><span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/examplechan/101"><time class="time" datetime="2026-09-20T10:00:00+00:00">10:00</time></a></span></div></div>
  </div></div></div>
<div class="tgme_widget_message_wrap js-widget_message_wrap">
 <div class="tgme_widget_message js-widget_message" data-post="examplechan/102">
  <div class="tgme_widget_message_bubble">
   <div class="tgme_widget_message_text js-message_text" dir="auto">Second post</div>
   <div class="tgme_widget_message_footer"><div class="tgme_widget_message_info">
     <span class="tgme_widget_message_views">532</span><span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/examplechan/102"><time class="time" datetime="2026-09-21T10:00:00+00:00">10:00</time></a></span></div></div>
  </div></div></div>
</section></body></html>
"""


def test_preview_parser_extracts_channel_info_and_pagination():
    page = tools.parse_telegram_preview(PREVIEW_HTML, "examplechan")
    assert page["info"]["title"] == "Example Channel"
    assert page["info"]["username"] == "@examplechan"
    assert page["info"]["counters"] == {"subscribers": "12.3K", "photos": "45"}
    assert page["info"]["description"] == "Line one\nLine two"
    assert page["next_before"] == 101
    assert [m["id"] for m in page["messages"]] == [101, 102]


def test_preview_parser_reads_post_text_not_the_quoted_reply_and_keeps_line_breaks():
    message = tools.parse_telegram_preview(PREVIEW_HTML, "examplechan")["messages"][0]
    assert message["text"].startswith("Support us:\nBTC 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")
    assert "quoted reply" not in message["text"]
    assert message["reply_to_url"] == "https://t.me/examplechan/99"


def test_preview_parser_extracts_forward_links_media_and_dates():
    message = tools.parse_telegram_preview(PREVIEW_HTML, "examplechan")["messages"][0]
    assert message["url"] == "https://t.me/examplechan/101"
    assert message["date"] == "2026-09-20T10:00:00+00:00"
    assert message["views"] == 1_440_000 and message["views_displayed"] == "1.44M"
    assert message["forwarded_from"]["channel"] == "othersource"
    assert message["forwarded_from"]["name"] == "Other Source"
    assert message["media"] == ["photo"]
    assert message["mentioned_channels"] == ["othersource"], "the channel's own links must be excluded"
    assert message["invite_links"] == ["https://t.me/+PrivateInviteHash"]
    assert "https://www.example.org/page" in message["links"]
    assert message["link_preview"]["title"] == "A page"
    assert message["hashtags"] == ["#topic", "#Topic"]


def test_preview_parser_reports_only_checksum_valid_wallets():
    message = tools.parse_telegram_preview(PREVIEW_HTML, "examplechan")["messages"][0]
    assert message["wallets"] == {"bitcoin": ["1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"]}


def test_telegram_network_summary_ranks_forwards_and_collects_wallets():
    messages = tools.parse_telegram_preview(PREVIEW_HTML, "examplechan")["messages"]
    network = tools._telegram_network(messages + [dict(messages[0], id=103)])
    assert network["forwarded_from"][0] == {"channel": "othersource", "name": "Other Source", "count": 2}
    assert network["external_domains"][0] == {"domain": "example.org", "count": 2}
    assert network["invite_links"] == ["https://t.me/+PrivateInviteHash"]
    assert network["wallets"]["bitcoin"] == ["1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"]


class _FakeResponse:
    def __init__(self, body, final_url):
        self._body = body.encode("utf-8")
        self._ct_atlas_final_url = final_url
        self.headers = {"Content-Type": "text/html"}

    def iter_content(self, chunk_size=16384):
        yield self._body

    def close(self):
        pass


def _second_page(first_id=90, count=2):
    rows = "".join(
        f'<div class="tgme_widget_message js-widget_message" data-post="examplechan/{first_id - i}">'
        f'<div class="tgme_widget_message_text js-message_text">older {first_id - i}</div></div>'
        for i in range(count)
    )
    return f"<html><body>{rows}</body></html>"


def test_read_telegram_channel_paginates_newest_first_and_returns_a_cursor(monkeypatch):
    monkeypatch.setattr(tools.time, "sleep", lambda seconds: None)
    requested = []

    def fake_fetch(url, timeout=12):
        requested.append(url)
        if "before=101" in url:
            return _FakeResponse(_second_page(), url)
        return _FakeResponse(PREVIEW_HTML, url)

    monkeypatch.setattr(tools, "_manual_fetch", fake_fetch)
    result = tools.read_telegram_channel("@examplechan", pages=2)
    assert requested == ["https://t.me/s/examplechan", "https://t.me/s/examplechan?before=101"]
    assert result["status"] == "success"
    assert [m["id"] for m in result["messages"]] == [102, 101, 90, 89]
    assert result["newest_id"] == 102 and result["oldest_id"] == 89
    assert result["info"]["title"] == "Example Channel"
    assert "network" in result and "limits" in result and "caveat" in result


def test_read_telegram_channel_caps_pages_and_tolerates_garbage_arguments(monkeypatch):
    monkeypatch.setattr(tools.time, "sleep", lambda seconds: None)
    calls = []

    def fake_fetch(url, timeout=12):
        calls.append(url)
        # Every page offers another one, with fresh ids so nothing is deduplicated away.
        page = PREVIEW_HTML.replace("examplechan/101", f"examplechan/{200 - len(calls)}")
        return _FakeResponse(page.replace("data-before=\"101\"", f"data-before=\"{100 - len(calls)}\""), url)

    monkeypatch.setattr(tools, "_manual_fetch", fake_fetch)
    tools.read_telegram_channel("examplechan", pages="999", before="not-a-number")
    assert len(calls) == tools._TELEGRAM_MAX_PAGES
    assert calls[0] == "https://t.me/s/examplechan"


def test_read_telegram_channel_reports_unavailable_when_there_is_no_web_preview(monkeypatch):
    # t.me redirects channels without a web preview to the ordinary page.
    monkeypatch.setattr(
        tools, "_manual_fetch", lambda url, timeout=12: _FakeResponse("<html></html>", "https://t.me/privatechan")
    )
    result = tools.read_telegram_channel("privatechan")
    assert result["status"] == "unavailable"
    assert "preview" in result["reason"]


def test_read_telegram_channel_surfaces_network_errors_without_raising(monkeypatch):
    def boom(url, timeout=12):
        raise tools.requests.ConnectionError("network down")

    monkeypatch.setattr(tools, "_manual_fetch", boom)
    result = tools.read_telegram_channel("examplechan")
    assert result["status"] == "error" and "network down" in result["error"]


def test_read_telegram_channel_refuses_invites_without_any_request(monkeypatch):
    monkeypatch.setattr(tools, "_manual_fetch", lambda *a, **k: pytest.fail("must not fetch invite links"))
    assert tools.read_telegram_channel("https://t.me/+AbCdEfGh123")["status"] == "error"


# ---------------------------------------------------------------------------
# Wayback Machine captures
# ---------------------------------------------------------------------------
class _JsonResponse:
    def __init__(self, payload, status=200):
        self._payload, self.status_code = payload, status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise tools.requests.HTTPError(f"HTTP {self.status_code}")

    def json(self):
        return self._payload


def test_wayback_lists_earliest_and_latest_and_builds_readable_archive_urls(monkeypatch):
    monkeypatch.setattr(tools.time, "sleep", lambda seconds: None)
    sent = []
    header = ["timestamp", "original", "statuscode", "mimetype"]

    def fake_get(url, params=None, **kwargs):
        sent.append(params["limit"])
        stamp = "20141129144958" if params["limit"] > 0 else "20260923224906"
        return _JsonResponse([header, [stamp, "https://example.org/gone", "200", "text/html"]])

    monkeypatch.setattr(tools.requests, "get", fake_get)
    result = tools.wayback_snapshots("https://example.org/gone", which="both", limit=1)
    assert sent == [1, -1], "the newest side must use a negative CDX limit"
    assert result["status"] == "success"
    assert result["first_capture"] == "2014-11-29T14:49:58Z"
    assert result["last_capture"] == "2026-09-23T22:49:06Z"
    assert result["captures"][0]["archive_url"] == "https://web.archive.org/web/20141129144958/https://example.org/gone"
    assert "does not prove" in result["note"]


def test_wayback_reports_no_captures_and_rate_limits_without_raising(monkeypatch):
    monkeypatch.setattr(tools.requests, "get", lambda url, params=None, **k: _JsonResponse([]))
    assert tools.wayback_snapshots("https://example.org/none", which="latest")["status"] == "no_captures"

    monkeypatch.setattr(tools.requests, "get", lambda url, params=None, **k: _JsonResponse({}, status=429))
    result = tools.wayback_snapshots("https://example.org/x", which="latest")
    assert result["status"] == "error" and "429" in result["error"]


@pytest.mark.parametrize("url", [
    "http://localhost/x", "http://10.0.0.5/x", "ftp://example.org/x", "https://user:pw@example.org/",
])
def test_wayback_rejects_local_private_and_credentialed_urls(url, monkeypatch):
    monkeypatch.setattr(tools.requests, "get", lambda *a, **k: pytest.fail("must not call the archive"))
    assert tools.wayback_snapshots(url)["status"] == "error"


def test_wayback_allows_dead_domains_because_no_dns_lookup_is_needed(monkeypatch):
    monkeypatch.setattr(tools.requests, "get", lambda url, params=None, **k: _JsonResponse([]))
    monkeypatch.setattr(tools.socket, "getaddrinfo", lambda *a, **k: pytest.fail("no DNS lookup expected"))
    result = tools.wayback_snapshots("https://domain-that-no-longer-exists.example/", which="latest")
    assert result["status"] == "no_captures"


# ---------------------------------------------------------------------------
# Odysee
# ---------------------------------------------------------------------------
def test_odysee_keeps_search_relevance_order_and_builds_public_urls(monkeypatch):
    def fake_get(url, params=None, **kwargs):
        return _JsonResponse([{"claimId": "b", "name": "second"}, {"claimId": "a", "name": "first"}])

    def fake_post(url, json=None, **kwargs):
        assert json["params"]["claim_ids"] == ["b", "a"]
        return _JsonResponse({"result": {"items": [
            {"claim_id": "a", "name": "first", "timestamp": 1790169968, "canonical_url": "lbry://@chan#9/first#a",
             "value": {"title": "First", "description": "d", "tags": ["t"], "stream_type": "video",
                       "source": {"media_type": "video/mp4"}},
             "signing_channel": {"name": "@chan", "canonical_url": "lbry://@chan#9"}},
            {"claim_id": "b", "name": "second", "timestamp": 1790169000, "canonical_url": "lbry://@other#1/second#b",
             "value": {"title": "Second"}, "signing_channel": {"name": "@other", "canonical_url": "lbry://@other#1"}},
        ]}})

    monkeypatch.setattr(tools.requests, "get", fake_get)
    monkeypatch.setattr(tools.requests, "post", fake_post)
    result = tools.search_odysee("query", limit=5)
    assert result["status"] == "success"
    assert [r["title"] for r in result["results"]] == ["Second", "First"]
    first = result["results"][1]
    assert first["url"] == "https://odysee.com/@chan:9/first:a"
    assert first["channel"] == "@chan" and first["channel_url"] == "https://odysee.com/@chan:9"
    assert first["published_at"].startswith("2026-")


def test_odysee_handles_empty_results_bad_mode_and_provider_errors(monkeypatch):
    monkeypatch.setattr(tools.requests, "get", lambda url, params=None, **k: _JsonResponse([]))
    assert tools.search_odysee("nothing")["results"] == []
    assert tools.search_odysee("x", result_type="weird")["status"] == "error"
    assert tools.search_odysee("   ")["status"] == "error"

    monkeypatch.setattr(tools.requests, "get", lambda url, params=None, **k: _JsonResponse([], status=503))
    assert tools.search_odysee("x")["status"] == "error"


def test_new_free_collectors_are_advertised_and_registered_with_the_agent():
    caps = social_capabilities()
    for flag in ("telegram_channel_reader", "wayback_captures", "odysee_public"):
        assert caps[flag] is True
    import app.agent as agent_module

    registered = {getattr(tool, "__name__", "") for tool in agent_module.root_agent.tools}
    assert {"read_telegram_channel", "wayback_snapshots", "search_odysee"} <= registered
    for name in ("read_telegram_channel", "wayback_snapshots", "search_odysee"):
        assert name in agent_module.INSTRUCTION
