from app.evidence_ledger import EvidenceLedger
from app.tools import extract_public_indicators, normalize_evidence


def kinds(ledger):
    return {entry["url"]: entry["kind"] for entry in ledger.as_list()}


def test_only_a_successful_fetch_counts_as_a_directly_observed_page():
    ledger = EvidenceLedger()
    ledger.capture("fetch_public_url", {
        "status": "success", "url": "https://example.org/final", "requested_url": "http://example.org/start",
        "title": "Page", "text": "Body", "links": [{"url": "https://other.example/link", "label": "Other"}],
    })
    ledger.capture("fetch_public_url", {"status": "error", "url": "https://failed.example/", "error": "HTTP 500"})
    ledger.capture("fetch_public_url", {"status": "policy_blocked", "url": "https://www.linkedin.com/in/x"})
    assert kinds(ledger) == {
        "https://example.org/final": "direct_public_page",
        "http://example.org/start": "direct_public_page",
        "https://other.example/link": "discovered_link",
    }


def test_search_results_are_not_direct_until_they_are_fetched():
    ledger = EvidenceLedger()
    ledger.capture("search_public_web", {"status": "success", "results": [
        {"url": "https://example.org/a", "title": "A", "snippet": "Snippet"},
        {"url": "https://www.linkedin.com/in/someone", "title": "Someone", "snippet": "Snippet"},
    ]})
    assert kinds(ledger)["https://example.org/a"] == "search_result"
    ledger.capture("fetch_public_url", {"status": "success", "url": "https://example.org/a", "title": "A", "text": "Body"})
    assert kinds(ledger)["https://example.org/a"] == "direct_public_page"
    assert kinds(ledger)["https://www.linkedin.com/in/someone"] == "search_result"


def test_every_collector_shape_reaches_the_ledger():
    ledger = EvidenceLedger()
    ledger.capture("search_tumblr", {"results": [{"post_url": "https://x.tumblr.com/post/1", "blog_name": "x"}]})
    ledger.capture("search_odysee", {"results": [{"url": "https://odysee.com/@a:1/b:2", "channel_url": "https://odysee.com/@a:1", "channel": "a"}]})
    ledger.capture("wayback_snapshots", {"captures": [{"archive_url": "https://web.archive.org/web/2020/https://example.org/", "captured_at": "2020"}]})
    ledger.capture("transcribe_public_media", {"status": "success", "source_url": "https://example.org/a.mp3", "text": "Words"})
    assert kinds(ledger) == {
        "https://x.tumblr.com/post/1": "search_result",
        "https://odysee.com/@a:1/b:2": "search_result",
        "https://odysee.com/@a:1": "search_result",
        "https://web.archive.org/web/2020/https://example.org/": "search_result",
        "https://example.org/a.mp3": "transcribed_media",
    }


def test_telegram_tools_record_posts_previews_and_post_links():
    ledger = EvidenceLedger()
    ledger.capture("explore_telegram_network", {"channels": [{
        "status": "success", "channel": "examplechan", "url": "https://t.me/examplechan", "preview_url": "https://t.me/s/examplechan",
        "info": {"title": "Example"},
        "messages": [{"id": 1, "url": "https://t.me/examplechan/1", "links": ["https://outside.example/x"], "text": "Post"}],
    }]})
    assert kinds(ledger) == {
        "https://t.me/examplechan/1": "telegram_collected_post",
        "https://t.me/examplechan": "telegram_public_preview",
        "https://t.me/s/examplechan": "telegram_public_preview",
        "https://outside.example/x": "discovered_link",
    }
    assert ledger.telegram.messages


def test_tools_that_echo_model_text_can_never_prove_a_url():
    ledger = EvidenceLedger()
    invented = "https://invented.example/never-fetched"
    ledger.capture("extract_public_indicators", extract_public_indicators("see " + invented))
    ledger.capture("normalize_evidence", normalize_evidence(invented, "observed"))
    ledger.capture("preprocess_public_text_free", {"status": "success", "response": invented, "url": invented})
    # Even if one of them ever grew a collector-shaped answer, only named tools count.
    ledger.capture("normalize_evidence", {"status": "success", "url": invented, "results": [{"url": invented}]})
    assert ledger.entries == {}
    assert ledger.has_evidence() is False


def test_links_alone_are_not_evidence_and_never_fill_a_partial_report():
    ledger = EvidenceLedger()
    ledger._add("https://other.example/link", "discovered_link", "fetch_public_url")
    assert ledger.has_evidence() is False
    ledger._add("https://example.org/a", "direct_public_page", "fetch_public_url", "A", "Body")
    assert ledger.has_evidence() is True
    assert ledger.report_sources() == [{"url": "https://example.org/a", "title": "A", "kind": "direct_public_page"}]
    assert ledger.coverage() == "1 page(s) retrieved directly."


def test_each_kind_is_bounded_and_a_flood_of_links_cannot_evict_sources():
    ledger = EvidenceLedger()
    for number in range(400):
        ledger._add(f"https://links.example/{number}", "discovered_link", "fetch_public_url")
    ledger._add("https://example.org/a", "direct_public_page", "fetch_public_url")
    assert sum(entry["kind"] == "discovered_link" for entry in ledger.as_list()) == 300
    assert ledger.as_list()[0]["url"] == "https://example.org/a"


def test_wallets_in_posts_beyond_the_retained_limit_are_still_listed():
    ledger = EvidenceLedger()
    messages = [{"id": i, "url": f"https://t.me/examplechan/{i}", "text": "x"} for i in range(1, 122)]
    messages[-1]["wallets"] = {"bitcoin": ["1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"]}
    ledger.capture("read_telegram_channel", {"channel": "examplechan", "status": "success", "messages": messages})
    annex = ledger.telegram.build()
    assert annex["messages_retained"] == 120
    assert annex["wallets"] == ["1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"]
