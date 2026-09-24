from app.tools import extract_public_indicators


def test_indicator_extraction_is_syntactic():
    result = extract_public_indicators(
        "Contact @example_user and see https://t.me/example. "
        "Wallet 0x1111111111111111111111111111111111111111"
    )
    assert "@example_user" in result["handles"]
    assert "https://t.me/example" in result["telegram_urls"]
    assert "0x1111111111111111111111111111111111111111" in result["wallets"]["evm"]
    assert "not attribution" in result["caveat"].lower()
