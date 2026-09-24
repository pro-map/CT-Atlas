from app.tools import (
    extract_public_indicators,
    preprocess_public_text_free,
    search_reddit,
    search_youtube,
    social_capabilities,
    transcribe_public_media,
)


def test_indicator_extraction_is_syntactic():
    result = extract_public_indicators(
        "Contact @example_user and see https://t.me/example. "
        "Wallet 0x1111111111111111111111111111111111111111"
    )
    assert "@example_user" in result["handles"]
    assert "https://t.me/example" in result["telegram_urls"]
    assert "0x1111111111111111111111111111111111111111" in result["wallets"]["evm"]
    assert "not attribution" in result["caveat"].lower()


def test_free_public_capabilities_and_optional_keys(monkeypatch):
    monkeypatch.delenv("YOUTUBE_API_KEY", raising=False)
    monkeypatch.delenv("REDDIT_CLIENT_ID", raising=False)
    monkeypatch.delenv("REDDIT_CLIENT_SECRET", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)

    caps = social_capabilities()
    assert caps["bluesky_public"] is True
    assert caps["mastodon_public"] is True
    assert caps["youtube_api"] is False
    assert caps["reddit_oauth"] is False
    assert caps["groq_whisper"] is False

    assert search_youtube("test")["status"] == "unavailable"
    assert search_reddit("test")["status"] == "unavailable"
    assert transcribe_public_media("https://example.org/audio.mp3")["status"] == "unavailable"


def test_free_preprocessing_is_optional(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("CLOUDFLARE_AI_ACCOUNT_ID", raising=False)
    monkeypatch.delenv("CLOUDFLARE_AI_API_TOKEN", raising=False)
    result = preprocess_public_text_free("public source text")
    assert result["status"] == "unavailable"
