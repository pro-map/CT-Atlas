from app.telegram_evidence import TelegramEvidence
from app import tools


def post(i, **extra):
    return {"id": i, "url": f"https://t.me/seedchannel/{i}", "text": "Observed text", **extra}


def test_actual_tool_evidence_deduplicates_posts_and_counts_unique_citations():
    evidence = TelegramEvidence()
    result = {"channel": "SeedChannel", "status": "success", "messages": [
        post(1, mentioned_channels=["AnotherChannel", "anotherchannel"], links=["https://example.org/a", "https://example.org/b"]),
        post(2, mentioned_channels=["anotherchannel"], forwarded_from={"channel": "anotherchannel"}),
    ]}
    evidence.capture("read_telegram_channel", result)
    evidence.capture("explore_telegram_network", {"result": {"channels": [result]}})
    evidence.capture("fetch_public_url", {"channel": "ignored", "messages": [post(5)]})
    report = evidence.build()
    assert report["messages_retained"] == 2
    mention = next(item for item in report["relationships"] if item["type"] == "mention")
    assert mention["target"] == "@anotherchannel" and mention["count"] == 2
    domain = next(item for item in report["relationships"] if item["type"] == "domain")
    assert domain["count"] == 1
    assert len(report["channels"]) == 1


def test_evidence_exposes_caps_and_retains_partial_collection():
    evidence = TelegramEvidence()
    evidence.capture("read_telegram_channel", {"channel": "seedchannel", "status": "error", "error": "Timeout", "messages": [post(i) for i in range(130)]})
    report = evidence.build()
    assert report["messages_observed"] == 130
    assert report["messages_retained"] == 120 and report["truncated"]
    assert report["channels"][0]["stop_reason"] == "Timeout"


def test_parser_preserves_telegram_links_plain_mentions_and_truncation():
    html = '<div class="tgme_widget_message" data-post="seedchannel/1"><div class="tgme_widget_message_text">@AnotherChannel @anotherchannel <a href="https://t.me/anotherchannel/42">post</a>' + "a" * 5000 + '</div></div>'
    message = tools.parse_telegram_preview(html, "seedchannel")["messages"][0]
    assert message["mentioned_channels"] == ["anotherchannel"]
    assert "https://t.me/anotherchannel/42" in message["links"]
    assert len(message["text"]) == 4000 and message["text_truncated"]


def test_expansion_requires_repeated_references_and_stays_one_hop(monkeypatch):
    calls = []
    def read(channel, pages, before, deadline):
        calls.append((channel, pages))
        return {"channel": channel, "status": "success", "network": {
            "mentioned_channels": [{"channel": "weak", "count": 1}, {"channel": "linked", "count": 2}],
            "forwarded_from": [{"channel": "weak", "count": 1}]}}
    monkeypatch.setattr(tools, "_read_telegram_channel", read)
    result = tools.explore_telegram_network("seedchannel")
    assert calls == [("seedchannel", 3), ("linked", 1)]
    assert result["hops"] == 1


def test_adk_function_response_shape_is_captured():
    from google.genai import types
    from google.adk.events import Event
    event = Event(author="agent", content=types.Content(parts=[types.Part.from_function_response(
        name="read_telegram_channel", response={"channel": "seedchannel", "messages": [post(1)]})]))
    evidence = TelegramEvidence()
    for part in event.content.parts:
        evidence.capture(part.function_response.name, part.function_response.response)
    assert evidence.build()["messages_retained"] == 1
