from __future__ import annotations

import ipaddress
import json
import os
import re
import socket
import subprocess
import sys
import time
from html import unescape
from typing import Any
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit

import requests
from bs4 import BeautifulSoup


USER_AGENT = "CT-Atlas-SOCMINT-Agent/0.1 (+public-osint)"
MAX_FETCH_BYTES = 1_000_000
MAX_LINKS = 50
DEFAULT_TIMEOUT = 12
ALLOWED_SCHEMES = {"http", "https"}

BTC_RE = re.compile(r"\b(?:bc1[a-zA-HJ-NP-Z0-9]{20,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b")
EVM_RE = re.compile(r"\b0x[a-fA-F0-9]{40}\b")
TRON_RE = re.compile(r"\bT[1-9A-HJ-NP-Za-km-z]{33}\b")
HANDLE_RE = re.compile(r"(?<![\w@])@[A-Za-z0-9_\.]{3,64}\b")
TELEGRAM_RE = re.compile(r"https?://(?:t\.me|telegram\.me)/[A-Za-z0-9_+\-/]+", re.I)
URL_RE = re.compile(r"https?://[^\s<>'\"\]\)]+", re.I)


def _clean(value: Any, max_len: int = 4000) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:max_len]


def _is_public_ip(value: str) -> bool:
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        return False
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def _validate_public_url(value: str) -> str:
    raw = str(value or "").strip()
    try:
        parsed = urlsplit(raw)
    except ValueError as exc:
        raise ValueError("Invalid URL.") from exc

    if parsed.scheme.lower() not in ALLOWED_SCHEMES:
        raise ValueError("Only http/https public URLs are allowed.")
    if parsed.username or parsed.password:
        raise ValueError("Credential-bearing URLs are not allowed.")
    host = (parsed.hostname or "").strip().lower()
    if not host or host in {"localhost", "localhost.localdomain"}:
        raise ValueError("Local URLs are not allowed.")
    if host.endswith((".local", ".internal", ".localhost")):
        raise ValueError("Local/private hostnames are not allowed.")

    try:
        infos = socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80))
    except socket.gaierror as exc:
        raise ValueError("Unable to resolve URL hostname.") from exc

    addresses = {item[4][0] for item in infos if item and item[4]}
    if not addresses or any(not _is_public_ip(address) for address in addresses):
        raise ValueError("Private or non-public network targets are not allowed.")

    return urlunsplit(parsed)


def _manual_fetch(url: str, timeout: int = DEFAULT_TIMEOUT) -> requests.Response:
    current = _validate_public_url(url)
    for _ in range(4):
        response = requests.get(
            current,
            headers={"User-Agent": USER_AGENT, "Accept": "text/html,text/plain,application/json;q=0.9,*/*;q=0.2"},
            timeout=max(3, min(int(timeout), 20)),
            stream=True,
            allow_redirects=False,
        )
        if response.status_code in {301, 302, 303, 307, 308}:
            location = response.headers.get("Location", "")
            response.close()
            if not location:
                raise ValueError("Redirect did not provide a destination.")
            current = _validate_public_url(urljoin(current, location))
            continue
        response.raise_for_status()
        response._ct_atlas_final_url = current
        return response
    raise ValueError("Too many redirects.")


def _read_limited(response: requests.Response) -> bytes:
    chunks: list[bytes] = []
    total = 0
    for chunk in response.iter_content(chunk_size=16384):
        if not chunk:
            continue
        total += len(chunk)
        if total > MAX_FETCH_BYTES:
            remaining = MAX_FETCH_BYTES - (total - len(chunk))
            if remaining > 0:
                chunks.append(chunk[:remaining])
            break
        chunks.append(chunk)
    return b"".join(chunks)


def _page_payload(url: str, body: bytes, content_type: str) -> dict[str, Any]:
    text = body.decode("utf-8", errors="replace")
    final_url = url

    if "html" not in content_type.lower():
        return {
            "status": "success",
            "url": final_url,
            "title": "",
            "text": _clean(text, 14000),
            "links": [],
            "content_type": content_type,
        }

    soup = BeautifulSoup(text, "html.parser")
    for node in soup(["script", "style", "noscript", "template", "svg"]):
        node.decompose()

    title = _clean(soup.title.get_text(" ", strip=True) if soup.title else "", 300)
    page_text = _clean(unescape(soup.get_text(" ", strip=True)), 14000)

    links: list[dict[str, str]] = []
    seen: set[str] = set()
    for anchor in soup.find_all("a", href=True):
        href = str(anchor.get("href") or "").strip()
        if not href:
            continue
        absolute = urljoin(final_url, href)
        try:
            safe = _validate_public_url(absolute)
        except Exception:
            continue
        if safe in seen:
            continue
        seen.add(safe)
        links.append({
            "url": safe,
            "label": _clean(anchor.get_text(" ", strip=True), 180),
        })
        if len(links) >= MAX_LINKS:
            break

    return {
        "status": "success",
        "url": final_url,
        "title": title,
        "text": page_text,
        "links": links,
        "content_type": content_type,
    }


def fetch_public_url(url: str) -> dict[str, Any]:
    """Retrieve one analyst-supplied or newly discovered PUBLIC web URL.

    Use this tool to inspect public pages during a SOCMINT investigation.
    It blocks localhost/private-network targets, follows at most three
    validated redirects, limits response size, and returns readable page text
    plus public links that may be explored in later tool calls.
    """
    try:
        response = _manual_fetch(url)
        final_url = getattr(response, "_ct_atlas_final_url", url)
        content_type = response.headers.get("Content-Type", "")
        body = _read_limited(response)
        response.close()
        return _page_payload(final_url, body, content_type)
    except Exception as exc:
        return {
            "status": "error",
            "url": _clean(url, 1500),
            "error": _clean(exc, 500),
        }


def extract_public_indicators(text: str) -> dict[str, Any]:
    """Extract observable public indicators from already retrieved text.

    Use after fetching pages to identify candidate handles, Telegram links,
    public URLs and cryptocurrency wallet strings. Extraction is syntactic:
    it does NOT establish identity, ownership, criminality or terrorist links.
    """
    value = str(text or "")
    urls = list(dict.fromkeys(URL_RE.findall(value)))[:60]
    handles = list(dict.fromkeys(HANDLE_RE.findall(value)))[:60]
    telegram = list(dict.fromkeys(TELEGRAM_RE.findall(value)))[:40]
    btc = list(dict.fromkeys(BTC_RE.findall(value)))[:30]
    evm = list(dict.fromkeys(EVM_RE.findall(value)))[:30]
    tron = list(dict.fromkeys(TRON_RE.findall(value)))[:30]
    return {
        "status": "success",
        "handles": handles,
        "telegram_urls": telegram,
        "urls": urls,
        "wallets": {
            "bitcoin": btc,
            "evm": evm,
            "tron": tron,
        },
        "caveat": "Indicators are strings observed in source text; they are not attribution findings.",
    }


def _search_searxng(query: str, limit: int) -> list[dict[str, str]]:
    base = os.getenv("SOCMINT_SEARCH_BASE_URL", "").strip().rstrip("/")
    if not base:
        return []
    endpoint = base if base.endswith("/search") else base + "/search"
    response = requests.get(
        endpoint,
        params={"q": query, "format": "json", "safesearch": "0"},
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        timeout=DEFAULT_TIMEOUT,
    )
    response.raise_for_status()
    payload = response.json()
    out = []
    for item in payload.get("results", [])[:limit]:
        url = str(item.get("url") or "")
        try:
            url = _validate_public_url(url)
        except Exception:
            continue
        out.append({
            "title": _clean(item.get("title"), 250),
            "url": url,
            "snippet": _clean(item.get("content"), 700),
            "provider": "searxng",
        })
    return out


def _search_brave(query: str, limit: int) -> list[dict[str, str]]:
    key = os.getenv("BRAVE_SEARCH_API_KEY", "").strip()
    if not key:
        return []
    response = requests.get(
        "https://api.search.brave.com/res/v1/web/search",
        params={"q": query, "count": limit},
        headers={"Accept": "application/json", "X-Subscription-Token": key, "User-Agent": USER_AGENT},
        timeout=DEFAULT_TIMEOUT,
    )
    response.raise_for_status()
    payload = response.json()
    out = []
    for item in payload.get("web", {}).get("results", [])[:limit]:
        url = str(item.get("url") or "")
        try:
            url = _validate_public_url(url)
        except Exception:
            continue
        out.append({
            "title": _clean(item.get("title"), 250),
            "url": url,
            "snippet": _clean(item.get("description"), 700),
            "provider": "brave",
        })
    return out


def search_public_web(query: str, limit: int = 8) -> dict[str, Any]:
    """Search the public web ONLY through an explicitly configured provider.

    Gemini Google Search grounding is deliberately not used because it is not
    available for the current CT Atlas Gemini API project. By default this
    tool returns 'unavailable'. Configure SOCMINT_SEARCH_PROVIDER=searxng or
    brave plus the corresponding endpoint/key to enable independent discovery.
    The agent must continue from known URLs when search is unavailable.
    """
    clean_query = _clean(query, 500)
    requested = max(1, min(int(limit or 8), 10))
    provider = os.getenv("SOCMINT_SEARCH_PROVIDER", "disabled").strip().lower()

    if not clean_query:
        return {"status": "error", "error": "Empty search query.", "results": []}

    try:
        if provider == "searxng":
            results = _search_searxng(clean_query, requested)
        elif provider == "brave":
            results = _search_brave(clean_query, requested)
        else:
            return {
                "status": "unavailable",
                "provider": provider or "disabled",
                "results": [],
                "reason": (
                    "No independent search provider is configured. Continue the "
                    "investigation from analyst-supplied URLs and links found on those pages."
                ),
            }
        return {
            "status": "success",
            "provider": provider,
            "query": clean_query,
            "results": results,
        }
    except Exception as exc:
        return {
            "status": "error",
            "provider": provider,
            "query": clean_query,
            "results": [],
            "error": _clean(exc, 600),
        }



_reddit_token_cache: dict[str, Any] = {"token": "", "expires_at": 0.0}
_twitch_token_cache: dict[str, Any] = {"token": "", "expires_at": 0.0}


def social_capabilities() -> dict[str, Any]:
    """Report which free/public SOCMINT collectors are currently usable.

    This returns configuration state only and never exposes API keys or secrets.
    Bluesky and basic Mastodon discovery are public and need no key.
    """
    provider = os.getenv("SOCMINT_SEARCH_PROVIDER", "disabled").strip().lower()
    reddit_ready = bool(
        os.getenv("REDDIT_CLIENT_ID", "").strip()
        and os.getenv("REDDIT_CLIENT_SECRET", "").strip()
    )
    return {
        "status": "success",
        "bluesky_public": True,
        "fourchan_public": True,
        "mastodon_public": True,
        "telegram_public_pages": True,
        "telegram_global_discovery": provider in {"brave", "searxng"},
        "linkedin_public_discovery": provider in {"brave", "searxng"},
        "youtube_api": bool(os.getenv("YOUTUBE_API_KEY", "").strip()),
        "twitch_api": bool(
            os.getenv("TWITCH_CLIENT_ID", "").strip()
            and os.getenv("TWITCH_CLIENT_SECRET", "").strip()
        ),
        "flickr_api": bool(os.getenv("FLICKR_API_KEY", "").strip()),
        "tumblr_api": bool(os.getenv("TUMBLR_API_KEY", "").strip()),
        "x_api": bool(os.getenv("X_BEARER_TOKEN", "").strip()),
        "reddit_oauth": reddit_ready,
        "groq_whisper": bool(os.getenv("GROQ_API_KEY", "").strip()),
        "cloudflare_workers_ai": bool(
            os.getenv("CLOUDFLARE_AI_ACCOUNT_ID", "").strip()
            and os.getenv("CLOUDFLARE_AI_API_TOKEN", "").strip()
        ),
        "openrouter_free": bool(os.getenv("OPENROUTER_API_KEY", "").strip()),
        "sherlock_username_discovery": True,
        "independent_web_search": provider in {"brave", "searxng"},
        "search_provider": provider or "disabled",
        "notes": (
            "Public collectors return candidate evidence only. Cross-platform "
            "identity must be corroborated before attribution."
        ),
    }


def search_bluesky(query: str, limit: int = 10, mode: str = "posts") -> dict[str, Any]:
    """Search PUBLIC Bluesky posts or accounts without authentication.

    mode='posts' uses app.bsky.feed.searchPosts.
    mode='accounts' uses app.bsky.actor.searchActors.
    """
    clean_query = _clean(query, 400)
    requested = max(1, min(int(limit or 10), 25))
    selected = _clean(mode, 20).lower() or "posts"
    if not clean_query:
        return {"status": "error", "error": "Empty Bluesky query.", "results": []}

    if selected not in {"posts", "accounts"}:
        return {"status": "error", "error": "mode must be posts or accounts.", "results": []}

    endpoint = (
        "https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts"
        if selected == "posts"
        else "https://public.api.bsky.app/xrpc/app.bsky.actor.searchActors"
    )
    try:
        response = requests.get(
            endpoint,
            params={"q": clean_query, "limit": requested},
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            timeout=DEFAULT_TIMEOUT,
        )
        response.raise_for_status()
        payload = response.json()
        results: list[dict[str, Any]] = []

        if selected == "accounts":
            for actor in payload.get("actors", [])[:requested]:
                handle = _clean(actor.get("handle"), 200)
                results.append({
                    "type": "account",
                    "handle": handle,
                    "display_name": _clean(actor.get("displayName"), 250),
                    "did": _clean(actor.get("did"), 250),
                    "description": _clean(actor.get("description"), 1000),
                    "url": f"https://bsky.app/profile/{handle}" if handle else "",
                    "source": "bluesky_public_api",
                })
        else:
            for post in payload.get("posts", [])[:requested]:
                author = post.get("author") or {}
                record = post.get("record") or {}
                handle = _clean(author.get("handle"), 200)
                uri = _clean(post.get("uri"), 500)
                rkey = uri.rsplit("/", 1)[-1] if "/" in uri else ""
                results.append({
                    "type": "post",
                    "text": _clean(record.get("text"), 2500),
                    "author_handle": handle,
                    "author_display_name": _clean(author.get("displayName"), 250),
                    "author_did": _clean(author.get("did"), 250),
                    "created_at": _clean(record.get("createdAt"), 80),
                    "indexed_at": _clean(post.get("indexedAt"), 80),
                    "reply_count": int(post.get("replyCount") or 0),
                    "repost_count": int(post.get("repostCount") or 0),
                    "like_count": int(post.get("likeCount") or 0),
                    "uri": uri,
                    "url": (
                        f"https://bsky.app/profile/{handle}/post/{rkey}"
                        if handle and rkey else ""
                    ),
                    "source": "bluesky_public_api",
                })
        return {
            "status": "success",
            "platform": "bluesky",
            "mode": selected,
            "query": clean_query,
            "results": results,
        }
    except Exception as exc:
        return {
            "status": "error",
            "platform": "bluesky",
            "query": clean_query,
            "results": [],
            "error": _clean(exc, 600),
        }


def search_mastodon(
    query: str,
    instance: str = "mastodon.social",
    limit: int = 10,
    result_type: str = "accounts",
) -> dict[str, Any]:
    """Search PUBLIC Mastodon accounts/hashtags on a chosen public instance.

    Unauthenticated full-text status search is often unavailable, so this tool
    is intended primarily for account and hashtag discovery.
    """
    clean_query = _clean(query, 400)
    host = _clean(instance, 300).lower().replace("https://", "").replace("http://", "").strip("/")
    requested = max(1, min(int(limit or 10), 20))
    selected = _clean(result_type, 20).lower() or "accounts"
    if selected not in {"accounts", "hashtags", "statuses"}:
        return {"status": "error", "error": "result_type must be accounts, hashtags or statuses.", "results": []}
    if not clean_query:
        return {"status": "error", "error": "Empty Mastodon query.", "results": []}

    try:
        base = _validate_public_url(f"https://{host}")
        response = requests.get(
            base.rstrip("/") + "/api/v2/search",
            params={
                "q": clean_query,
                "type": selected,
                "limit": requested,
                "resolve": "false",
            },
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            timeout=DEFAULT_TIMEOUT,
        )
        response.raise_for_status()
        payload = response.json()
        key = selected
        rows = payload.get(key, [])[:requested]
        results: list[dict[str, Any]] = []
        if selected == "accounts":
            for actor in rows:
                results.append({
                    "type": "account",
                    "acct": _clean(actor.get("acct"), 300),
                    "username": _clean(actor.get("username"), 200),
                    "display_name": _clean(actor.get("display_name"), 250),
                    "note": _clean(BeautifulSoup(str(actor.get("note") or ""), "html.parser").get_text(" ", strip=True), 1000),
                    "url": _clean(actor.get("url"), 1000),
                    "followers_count": int(actor.get("followers_count") or 0),
                    "following_count": int(actor.get("following_count") or 0),
                })
        elif selected == "hashtags":
            for tag in rows:
                results.append({
                    "type": "hashtag",
                    "name": _clean(tag.get("name"), 200),
                    "url": _clean(tag.get("url"), 1000),
                })
        else:
            for status in rows:
                account = status.get("account") or {}
                results.append({
                    "type": "status",
                    "id": _clean(status.get("id"), 120),
                    "url": _clean(status.get("url"), 1000),
                    "created_at": _clean(status.get("created_at"), 80),
                    "account": _clean(account.get("acct"), 300),
                    "text": _clean(
                        BeautifulSoup(str(status.get("content") or ""), "html.parser").get_text(" ", strip=True),
                        2500,
                    ),
                })
        return {
            "status": "success",
            "platform": "mastodon",
            "instance": host,
            "query": clean_query,
            "result_type": selected,
            "results": results,
            "caveat": (
                "Unauthenticated Mastodon search coverage depends on the selected "
                "instance; public full-text status search may be unavailable."
            ),
        }
    except Exception as exc:
        return {
            "status": "error",
            "platform": "mastodon",
            "instance": host,
            "query": clean_query,
            "results": [],
            "error": _clean(exc, 600),
        }


def search_youtube(query: str, limit: int = 10) -> dict[str, Any]:
    """Search PUBLIC YouTube videos/channels through the free Data API quota."""
    key = os.getenv("YOUTUBE_API_KEY", "").strip()
    clean_query = _clean(query, 400)
    requested = max(1, min(int(limit or 10), 25))
    if not key:
        return {
            "status": "unavailable",
            "platform": "youtube",
            "results": [],
            "reason": "YOUTUBE_API_KEY is not configured.",
        }
    if not clean_query:
        return {"status": "error", "platform": "youtube", "results": [], "error": "Empty YouTube query."}
    try:
        response = requests.get(
            "https://www.googleapis.com/youtube/v3/search",
            params={
                "part": "snippet",
                "q": clean_query,
                "maxResults": requested,
                "type": "video,channel",
                "key": key,
            },
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            timeout=DEFAULT_TIMEOUT,
        )
        response.raise_for_status()
        payload = response.json()
        results: list[dict[str, Any]] = []
        for item in payload.get("items", [])[:requested]:
            ident = item.get("id") or {}
            snippet = item.get("snippet") or {}
            video_id = _clean(ident.get("videoId"), 120)
            channel_id = _clean(ident.get("channelId"), 120)
            kind = "video" if video_id else "channel"
            url = (
                f"https://www.youtube.com/watch?v={video_id}"
                if video_id
                else (f"https://www.youtube.com/channel/{channel_id}" if channel_id else "")
            )
            results.append({
                "type": kind,
                "title": _clean(snippet.get("title"), 400),
                "description": _clean(snippet.get("description"), 1200),
                "published_at": _clean(snippet.get("publishedAt"), 80),
                "channel_title": _clean(snippet.get("channelTitle"), 300),
                "channel_id": _clean(snippet.get("channelId") or channel_id, 120),
                "video_id": video_id,
                "url": url,
            })
        return {
            "status": "success",
            "platform": "youtube",
            "query": clean_query,
            "results": results,
        }
    except Exception as exc:
        return {
            "status": "error",
            "platform": "youtube",
            "query": clean_query,
            "results": [],
            "error": _clean(exc, 600),
        }


def _twitch_access_token() -> str:
    now = time.time()
    cached = str(_twitch_token_cache.get("token") or "")
    if cached and float(_twitch_token_cache.get("expires_at") or 0) > now + 60:
        return cached

    client_id = os.getenv("TWITCH_CLIENT_ID", "").strip()
    client_secret = os.getenv("TWITCH_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        return ""

    response = requests.post(
        "https://id.twitch.tv/oauth2/token",
        params={
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "client_credentials",
        },
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        timeout=DEFAULT_TIMEOUT,
    )
    response.raise_for_status()
    payload = response.json()
    token = str(payload.get("access_token") or "").strip()
    if not token:
        raise ValueError("Twitch OAuth did not return an access token.")
    _twitch_token_cache["token"] = token
    _twitch_token_cache["expires_at"] = now + max(300, int(payload.get("expires_in") or 3600))
    return token


def search_fourchan(
    query: str,
    boards: str = "pol,int,news",
    limit: int = 10,
) -> dict[str, Any]:
    """Search PUBLIC 4chan catalog posts without authentication.

    The official 4chan API is read-only. Requests are deliberately serialized
    to respect the API rule of no more than one request per second.
    """
    clean_query = _clean(query, 200).lower()
    requested = max(1, min(int(limit or 10), 25))
    board_list = [
        re.sub(r"[^a-z0-9]", "", part.lower())
        for part in str(boards or "pol,int,news").split(",")
    ]
    board_list = [b for b in board_list if b][:3]
    if not clean_query:
        return {"status": "error", "platform": "4chan", "results": [], "error": "Empty 4chan query."}
    if not board_list:
        board_list = ["pol"]

    results: list[dict[str, Any]] = []
    errors: list[str] = []
    try:
        for idx, board in enumerate(board_list):
            if idx:
                time.sleep(1.05)
            response = requests.get(
                f"https://a.4cdn.org/{board}/catalog.json",
                headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
                timeout=DEFAULT_TIMEOUT,
            )
            response.raise_for_status()
            pages = response.json()
            for page in pages:
                for thread in page.get("threads") or []:
                    candidates = [thread] + list(thread.get("last_replies") or [])
                    matched = False
                    matched_text = ""
                    for post in candidates:
                        subject = _clean(post.get("sub"), 500)
                        comment_html = str(post.get("com") or "")
                        comment = _clean(
                            BeautifulSoup(comment_html, "html.parser").get_text(" ", strip=True),
                            3000,
                        )
                        combined = (subject + " " + comment).lower()
                        if clean_query in combined:
                            matched = True
                            matched_text = _clean((subject + " " + comment), 3000)
                            break
                    if not matched:
                        continue
                    thread_no = str(thread.get("no") or "")
                    results.append({
                        "type": "thread",
                        "board": board,
                        "thread_id": thread_no,
                        "subject": _clean(thread.get("sub"), 500),
                        "text": matched_text,
                        "time": thread.get("time"),
                        "replies": int(thread.get("replies") or 0),
                        "images": int(thread.get("images") or 0),
                        "unique_ips": thread.get("unique_ips"),
                        "url": (
                            f"https://boards.4chan.org/{board}/thread/{thread_no}"
                            if thread_no else ""
                        ),
                        "source": "4chan_official_read_only_api",
                    })
                    if len(results) >= requested:
                        return {
                            "status": "success",
                            "platform": "4chan",
                            "query": clean_query,
                            "boards": board_list,
                            "results": results,
                            "source_disclosure": "Source data: 4chan public read-only JSON API.",
                        }
        return {
            "status": "success" if not errors else "partial",
            "platform": "4chan",
            "query": clean_query,
            "boards": board_list,
            "results": results[:requested],
            "errors": errors,
            "source_disclosure": "Source data: 4chan public read-only JSON API.",
        }
    except Exception as exc:
        return {
            "status": "error",
            "platform": "4chan",
            "query": clean_query,
            "boards": board_list,
            "results": results[:requested],
            "error": _clean(exc, 600),
        }


def search_twitch(query: str, limit: int = 10, live_only: bool = False) -> dict[str, Any]:
    """Search PUBLIC Twitch channels with server-side app credentials."""
    client_id = os.getenv("TWITCH_CLIENT_ID", "").strip()
    client_secret = os.getenv("TWITCH_CLIENT_SECRET", "").strip()
    clean_query = _clean(query, 250)
    requested = max(1, min(int(limit or 10), 20))
    if not client_id or not client_secret:
        return {
            "status": "unavailable",
            "platform": "twitch",
            "results": [],
            "reason": "TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET are not configured.",
        }
    if not clean_query:
        return {"status": "error", "platform": "twitch", "results": [], "error": "Empty Twitch query."}

    try:
        token = _twitch_access_token()
        response = requests.get(
            "https://api.twitch.tv/helix/search/channels",
            params={
                "query": clean_query,
                "first": requested,
                "live_only": "true" if live_only else "false",
            },
            headers={
                "Authorization": f"Bearer {token}",
                "Client-Id": client_id,
                "User-Agent": USER_AGENT,
                "Accept": "application/json",
            },
            timeout=DEFAULT_TIMEOUT,
        )
        response.raise_for_status()
        payload = response.json()
        results: list[dict[str, Any]] = []
        for item in (payload.get("data") or [])[:requested]:
            login = _clean(item.get("broadcaster_login"), 180)
            results.append({
                "type": "channel",
                "broadcaster_id": _clean(item.get("id"), 120),
                "login": login,
                "display_name": _clean(item.get("display_name"), 250),
                "language": _clean(item.get("broadcaster_language"), 40),
                "game_id": _clean(item.get("game_id"), 120),
                "game_name": _clean(item.get("game_name"), 250),
                "title": _clean(item.get("title"), 600),
                "is_live": bool(item.get("is_live")),
                "started_at": _clean(item.get("started_at"), 80),
                "thumbnail_url": _clean(item.get("thumbnail_url"), 1200),
                "url": f"https://www.twitch.tv/{login}" if login else "",
            })
        return {
            "status": "success",
            "platform": "twitch",
            "query": clean_query,
            "live_only": bool(live_only),
            "results": results,
        }
    except Exception as exc:
        return {
            "status": "error",
            "platform": "twitch",
            "query": clean_query,
            "results": [],
            "error": _clean(exc, 600),
        }


def search_flickr(query: str, limit: int = 10) -> dict[str, Any]:
    """Search PUBLIC Flickr photos with a non-commercial API key.

    Returns public photo metadata only. Geolocation is included only when the
    public photo record exposes it.
    """
    key = os.getenv("FLICKR_API_KEY", "").strip()
    clean_query = _clean(query, 300)
    requested = max(1, min(int(limit or 10), 50))
    if not key:
        return {
            "status": "unavailable",
            "platform": "flickr",
            "results": [],
            "reason": "FLICKR_API_KEY is not configured.",
        }
    if not clean_query:
        return {"status": "error", "platform": "flickr", "results": [], "error": "Empty Flickr query."}

    try:
        response = requests.get(
            "https://www.flickr.com/services/rest/",
            params={
                "method": "flickr.photos.search",
                "api_key": key,
                "text": clean_query,
                "sort": "date-posted-desc",
                "safe_search": 1,
                "content_type": 1,
                "media": "photos",
                "extras": (
                    "description,date_upload,date_taken,owner_name,geo,tags,"
                    "views,url_m,url_l,path_alias"
                ),
                "per_page": requested,
                "page": 1,
                "format": "json",
                "nojsoncallback": 1,
            },
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            timeout=DEFAULT_TIMEOUT,
        )
        response.raise_for_status()
        payload = response.json()
        if payload.get("stat") != "ok":
            raise ValueError(_clean(payload.get("message") or "Flickr API error.", 400))
        photos = (payload.get("photos") or {}).get("photo") or []
        results: list[dict[str, Any]] = []
        for photo in photos[:requested]:
            photo_id = _clean(photo.get("id"), 120)
            owner = _clean(photo.get("owner"), 180)
            path_alias = _clean(photo.get("pathalias"), 180)
            owner_segment = path_alias or owner
            page_url = (
                f"https://www.flickr.com/photos/{owner_segment}/{photo_id}/"
                if owner_segment and photo_id
                else ""
            )
            description = photo.get("description") or {}
            results.append({
                "type": "photo",
                "id": photo_id,
                "title": _clean(photo.get("title"), 500),
                "description": _clean(
                    description.get("_content") if isinstance(description, dict) else description,
                    2500,
                ),
                "owner_id": owner,
                "owner_name": _clean(photo.get("ownername"), 250),
                "date_upload": _clean(photo.get("dateupload"), 80),
                "date_taken": _clean(photo.get("datetaken"), 80),
                "tags": _clean(photo.get("tags"), 1600),
                "latitude": _clean(photo.get("latitude"), 80),
                "longitude": _clean(photo.get("longitude"), 80),
                "accuracy": _clean(photo.get("accuracy"), 40),
                "views": _clean(photo.get("views"), 40),
                "image_url": _clean(photo.get("url_l") or photo.get("url_m"), 1200),
                "url": page_url,
            })
        return {
            "status": "success",
            "platform": "flickr",
            "query": clean_query,
            "results": results,
        }
    except Exception as exc:
        return {
            "status": "error",
            "platform": "flickr",
            "query": clean_query,
            "results": [],
            "error": _clean(exc, 600),
        }


def search_tumblr(query: str, limit: int = 10) -> dict[str, Any]:
    """Search PUBLIC Tumblr posts by tag using the Tumblr API.

    Tumblr's tagged endpoint is public-read oriented and requires only the
    application's OAuth Consumer Key (used here as the API key).
    """
    key = os.getenv("TUMBLR_API_KEY", "").strip()
    clean_query = _clean(query, 200).lstrip("#")
    requested = max(1, min(int(limit or 10), 20))
    if not key:
        return {
            "status": "unavailable",
            "platform": "tumblr",
            "results": [],
            "reason": "TUMBLR_API_KEY is not configured.",
        }
    if not clean_query:
        return {"status": "error", "platform": "tumblr", "results": [], "error": "Empty Tumblr tag."}

    try:
        response = requests.get(
            "https://api.tumblr.com/v2/tagged",
            params={
                "tag": clean_query,
                "limit": requested,
                "api_key": key,
            },
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            timeout=DEFAULT_TIMEOUT,
        )
        response.raise_for_status()
        payload = response.json()
        posts = payload.get("response") or []
        results: list[dict[str, Any]] = []
        for post in posts[:requested]:
            parts: list[str] = []
            for block in post.get("content") or []:
                if isinstance(block, dict) and block.get("type") == "text":
                    text_value = _clean(block.get("text"), 1800)
                    if text_value:
                        parts.append(text_value)
            body = " ".join(parts)
            if not body:
                body = _clean(
                    post.get("summary")
                    or post.get("caption")
                    or post.get("body")
                    or post.get("description"),
                    2500,
                )
            results.append({
                "type": "post",
                "id": _clean(post.get("id_string") or post.get("id"), 120),
                "blog_name": _clean(post.get("blog_name"), 250),
                "post_url": _clean(post.get("post_url"), 1200),
                "timestamp": post.get("timestamp"),
                "date": _clean(post.get("date"), 80),
                "summary": _clean(post.get("summary"), 1000),
                "text": _clean(body, 3000),
                "tags": [
                    _clean(tag, 150)
                    for tag in (post.get("tags") or [])[:30]
                    if _clean(tag, 150)
                ],
            })
        return {
            "status": "success",
            "platform": "tumblr",
            "query": clean_query,
            "results": results,
        }
    except Exception as exc:
        return {
            "status": "error",
            "platform": "tumblr",
            "query": clean_query,
            "results": [],
            "error": _clean(exc, 600),
        }


def search_x(query: str, limit: int = 10) -> dict[str, Any]:
    """Search recent PUBLIC X posts with app-only Bearer Token authentication.

    The collector intentionally requests post fields only, avoiding user
    expansions so a basic search does not add separate user-read charges.
    """
    token = os.getenv("X_BEARER_TOKEN", "").strip()
    clean_query = _clean(query, 500)
    requested = max(1, min(int(limit or 10), 25))
    if not token:
        return {
            "status": "unavailable",
            "platform": "x",
            "results": [],
            "reason": "X_BEARER_TOKEN is not configured.",
        }
    if not clean_query:
        return {"status": "error", "platform": "x", "results": [], "error": "Empty X query."}

    try:
        # X recent-search currently requires max_results >= 10.
        api_count = max(10, requested)
        response = requests.get(
            "https://api.x.com/2/tweets/search/recent",
            params={
                "query": clean_query,
                "max_results": api_count,
                "tweet.fields": (
                    "id,text,author_id,created_at,lang,conversation_id,"
                    "possibly_sensitive,public_metrics,entities"
                ),
            },
            headers={
                "Authorization": f"Bearer {token}",
                "User-Agent": USER_AGENT,
                "Accept": "application/json",
            },
            timeout=DEFAULT_TIMEOUT,
        )
        response.raise_for_status()
        payload = response.json()
        results: list[dict[str, Any]] = []
        for post in (payload.get("data") or [])[:requested]:
            post_id = _clean(post.get("id"), 120)
            results.append({
                "type": "post",
                "id": post_id,
                "author_id": _clean(post.get("author_id"), 120),
                "created_at": _clean(post.get("created_at"), 80),
                "lang": _clean(post.get("lang"), 30),
                "text": _clean(post.get("text"), 4000),
                "conversation_id": _clean(post.get("conversation_id"), 120),
                "possibly_sensitive": bool(post.get("possibly_sensitive", False)),
                "public_metrics": post.get("public_metrics") or {},
                "entities": post.get("entities") or {},
                "url": f"https://x.com/i/web/status/{post_id}" if post_id else "",
            })
        return {
            "status": "success",
            "platform": "x",
            "query": clean_query,
            "results": results,
            "meta": payload.get("meta") or {},
            "cost_note": (
                "This collector requests post resources only and does not request "
                "user expansions."
            ),
        }
    except Exception as exc:
        return {
            "status": "error",
            "platform": "x",
            "query": clean_query,
            "results": [],
            "error": _clean(exc, 600),
        }


def _reddit_access_token() -> str:
    now = time.time()
    cached = str(_reddit_token_cache.get("token") or "")
    if cached and float(_reddit_token_cache.get("expires_at") or 0) > now + 60:
        return cached

    client_id = os.getenv("REDDIT_CLIENT_ID", "").strip()
    client_secret = os.getenv("REDDIT_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        return ""

    user_agent = os.getenv("REDDIT_USER_AGENT", USER_AGENT).strip() or USER_AGENT
    response = requests.post(
        "https://www.reddit.com/api/v1/access_token",
        auth=(client_id, client_secret),
        data={"grant_type": "client_credentials"},
        headers={"User-Agent": user_agent},
        timeout=DEFAULT_TIMEOUT,
    )
    response.raise_for_status()
    payload = response.json()
    token = str(payload.get("access_token") or "").strip()
    if not token:
        raise ValueError("Reddit OAuth did not return an access token.")
    _reddit_token_cache["token"] = token
    _reddit_token_cache["expires_at"] = now + max(300, int(payload.get("expires_in") or 3600))
    return token


def search_reddit(query: str, limit: int = 10, sort: str = "new") -> dict[str, Any]:
    """Search PUBLIC Reddit posts through OAuth free-access credentials."""
    clean_query = _clean(query, 400)
    requested = max(1, min(int(limit or 10), 25))
    selected_sort = _clean(sort, 20).lower() or "new"
    if selected_sort not in {"new", "relevance", "top", "hot", "comments"}:
        selected_sort = "new"
    if not os.getenv("REDDIT_CLIENT_ID", "").strip() or not os.getenv("REDDIT_CLIENT_SECRET", "").strip():
        return {
            "status": "unavailable",
            "platform": "reddit",
            "results": [],
            "reason": "REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET are not configured.",
        }
    if not clean_query:
        return {"status": "error", "platform": "reddit", "results": [], "error": "Empty Reddit query."}
    try:
        token = _reddit_access_token()
        user_agent = os.getenv("REDDIT_USER_AGENT", USER_AGENT).strip() or USER_AGENT
        response = requests.get(
            "https://oauth.reddit.com/search",
            params={
                "q": clean_query,
                "limit": requested,
                "sort": selected_sort,
                "type": "link",
                "raw_json": 1,
            },
            headers={
                "Authorization": f"bearer {token}",
                "User-Agent": user_agent,
                "Accept": "application/json",
            },
            timeout=DEFAULT_TIMEOUT,
        )
        response.raise_for_status()
        payload = response.json()
        results: list[dict[str, Any]] = []
        for child in (payload.get("data") or {}).get("children", [])[:requested]:
            data = child.get("data") or {}
            permalink = _clean(data.get("permalink"), 1200)
            results.append({
                "type": "post",
                "title": _clean(data.get("title"), 600),
                "selftext": _clean(data.get("selftext"), 2500),
                "author": _clean(data.get("author"), 200),
                "subreddit": _clean(data.get("subreddit"), 200),
                "created_utc": data.get("created_utc"),
                "score": int(data.get("score") or 0),
                "num_comments": int(data.get("num_comments") or 0),
                "url": ("https://www.reddit.com" + permalink) if permalink.startswith("/") else permalink,
                "external_url": _clean(data.get("url_overridden_by_dest") or data.get("url"), 1200),
            })
        return {
            "status": "success",
            "platform": "reddit",
            "query": clean_query,
            "sort": selected_sort,
            "results": results,
            "retention_note": (
                "Respect Reddit deletion/retention requirements if results are persisted."
            ),
        }
    except Exception as exc:
        return {
            "status": "error",
            "platform": "reddit",
            "query": clean_query,
            "results": [],
            "error": _clean(exc, 600),
        }


def search_linkedin_public(
    query: str,
    limit: int = 10,
    result_type: str = "all",
) -> dict[str, Any]:
    """Discover PUBLIC LinkedIn pages through the configured web-search provider.

    This does not use LinkedIn member APIs, authenticate to LinkedIn, or bypass
    access controls. It only returns public LinkedIn URLs already exposed by an
    independent search provider such as Brave or SearXNG.

    result_type may be: all, people, companies, posts.
    """
    clean_query = _clean(query, 350)
    requested = max(1, min(int(limit or 10), 10))
    selected = _clean(result_type, 30).lower() or "all"
    if selected not in {"all", "people", "companies", "posts"}:
        return {
            "status": "error",
            "platform": "linkedin",
            "results": [],
            "error": "result_type must be all, people, companies or posts.",
        }
    if not clean_query:
        return {
            "status": "error",
            "platform": "linkedin",
            "results": [],
            "error": "Empty LinkedIn query.",
        }

    site_filter = {
        "people": "site:linkedin.com/in/",
        "companies": "site:linkedin.com/company/",
        "posts": "site:linkedin.com/posts/",
        "all": "site:linkedin.com",
    }[selected]

    result = search_public_web(f"{site_filter} {clean_query}", requested)
    result["platform"] = "linkedin"
    result["result_type"] = selected
    result["access_note"] = (
        "Results come from public-web indexing only. LinkedIn login-gated or "
        "non-public content is not accessed."
    )
    return result


def search_telegram_public(query: str, limit: int = 10) -> dict[str, Any]:
    """Discover PUBLIC Telegram pages using the configured independent web search.

    Direct t.me URLs can always be inspected with fetch_public_url. Global
    Telegram post discovery is not attempted through unofficial scraping.
    """
    clean_query = _clean(query, 350)
    if not clean_query:
        return {"status": "error", "platform": "telegram", "results": [], "error": "Empty Telegram query."}
    result = search_public_web(f"site:t.me {clean_query}", limit)
    result["platform"] = "telegram"
    return result


def transcribe_public_media(url: str, language: str = "") -> dict[str, Any]:
    """Transcribe a PUBLIC audio/video URL with Groq Whisper when configured.

    The URL must resolve to a public network target. The media URL is sent to
    Groq for transcription, so use only material suitable for third-party
    processing.
    """
    key = os.getenv("GROQ_API_KEY", "").strip()
    if not key:
        return {
            "status": "unavailable",
            "provider": "groq",
            "reason": "GROQ_API_KEY is not configured.",
            "text": "",
        }
    try:
        safe_url = _validate_public_url(url)
        payload: dict[str, str] = {
            "model": os.getenv("GROQ_WHISPER_MODEL", "whisper-large-v3-turbo").strip()
            or "whisper-large-v3-turbo",
            "url": safe_url,
            "response_format": "json",
        }
        clean_language = _clean(language, 10).lower()
        if clean_language:
            payload["language"] = clean_language
        response = requests.post(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {key}", "User-Agent": USER_AGENT},
            data=payload,
            timeout=90,
        )
        response.raise_for_status()
        data = response.json()
        return {
            "status": "success",
            "provider": "groq",
            "model": payload["model"],
            "source_url": safe_url,
            "text": _clean(data.get("text"), 20000),
        }
    except Exception as exc:
        return {
            "status": "error",
            "provider": "groq",
            "source_url": _clean(url, 1200),
            "text": "",
            "error": _clean(exc, 600),
        }


def search_username_profiles(username: str, timeout_seconds: int = 45) -> dict[str, Any]:
    """Use Sherlock to identify candidate PUBLIC profiles sharing a username.

    This is discovery only. A matching username never proves that accounts are
    controlled by the same person or organization.
    """
    value = str(username or "").strip().lstrip("@")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{2,64}", value):
        return {
            "status": "error",
            "provider": "sherlock",
            "results": [],
            "error": "Username contains unsupported characters.",
        }
    timeout_value = max(10, min(int(timeout_seconds or 45), 60))
    try:
        proc = subprocess.run(
            [
                sys.executable,
                "-m",
                "sherlock_project",
                value,
                "--print-found",
                "--no-color",
                "--timeout",
                "4",
            ],
            capture_output=True,
            text=True,
            timeout=timeout_value,
            check=False,
        )
        output = (proc.stdout or "") + "\n" + (proc.stderr or "")
        urls = list(dict.fromkeys(URL_RE.findall(output)))[:100]
        return {
            "status": "success" if proc.returncode in {0, 1} else "partial",
            "provider": "sherlock",
            "username": value,
            "results": [{"url": url} for url in urls],
            "caveat": (
                "Same-username hits are candidate profiles only and require "
                "independent corroboration before identity attribution."
            ),
        }
    except subprocess.TimeoutExpired:
        return {
            "status": "partial",
            "provider": "sherlock",
            "username": value,
            "results": [],
            "error": "Sherlock timed out before completing the scan.",
        }
    except Exception as exc:
        return {
            "status": "error",
            "provider": "sherlock",
            "username": value,
            "results": [],
            "error": _clean(exc, 600),
        }



def preprocess_public_text_free(
    text: str,
    task: str = "Extract named entities, aliases, URLs, locations and concise themes.",
) -> dict[str, Any]:
    """Preprocess already-PUBLIC text with an optional zero-cost model provider.

    Provider order: Cloudflare Workers AI, then OpenRouter Free Router.
    Model output is analytical assistance only and MUST NOT be cited as source
    evidence or used to invent facts absent from the supplied public text.
    """
    source_text = _clean(text, 16000)
    instruction = _clean(task, 1200)
    if not source_text:
        return {"status": "error", "error": "Empty text.", "provider": "none", "response": ""}

    cf_account = os.getenv("CLOUDFLARE_AI_ACCOUNT_ID", "").strip()
    cf_token = os.getenv("CLOUDFLARE_AI_API_TOKEN", "").strip()
    if cf_account and cf_token:
        try:
            model = os.getenv(
                "CLOUDFLARE_AI_MODEL",
                "@cf/meta/llama-3.1-8b-instruct",
            ).strip() or "@cf/meta/llama-3.1-8b-instruct"
            endpoint = (
                f"https://api.cloudflare.com/client/v4/accounts/{cf_account}"
                f"/ai/run/{model}"
            )
            response = requests.post(
                endpoint,
                headers={
                    "Authorization": f"Bearer {cf_token}",
                    "Content-Type": "application/json",
                    "User-Agent": USER_AGENT,
                },
                json={
                    "messages": [
                        {
                            "role": "system",
                            "content": (
                                "Analyze only the supplied public-source text. "
                                "Do not add facts not present in it."
                            ),
                        },
                        {
                            "role": "user",
                            "content": instruction + "\n\nPUBLIC TEXT:\n" + source_text,
                        },
                    ]
                },
                timeout=45,
            )
            response.raise_for_status()
            payload = response.json()
            result = payload.get("result") or {}
            answer = result.get("response")
            if not answer and isinstance(result.get("choices"), list):
                choice = (result.get("choices") or [{}])[0]
                answer = ((choice.get("message") or {}).get("content"))
            return {
                "status": "success",
                "provider": "cloudflare_workers_ai",
                "model": model,
                "response": _clean(answer, 12000),
                "caveat": "Model output is preprocessing, not source evidence.",
            }
        except Exception as exc:
            cf_error = _clean(exc, 500)
    else:
        cf_error = ""

    or_key = os.getenv("OPENROUTER_API_KEY", "").strip()
    if or_key:
        try:
            response = requests.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {or_key}",
                    "Content-Type": "application/json",
                    "User-Agent": USER_AGENT,
                    "HTTP-Referer": "https://ct-atlas.com",
                    "X-Title": "CT Atlas SOCMINT",
                },
                json={
                    "model": os.getenv("OPENROUTER_FREE_MODEL", "openrouter/free").strip()
                    or "openrouter/free",
                    "messages": [
                        {
                            "role": "system",
                            "content": (
                                "Analyze only the supplied public-source text. "
                                "Do not add facts not present in it."
                            ),
                        },
                        {
                            "role": "user",
                            "content": instruction + "\n\nPUBLIC TEXT:\n" + source_text,
                        },
                    ],
                    "temperature": 0.1,
                },
                timeout=45,
            )
            response.raise_for_status()
            payload = response.json()
            choices = payload.get("choices") or []
            answer = ""
            if choices:
                answer = ((choices[0].get("message") or {}).get("content") or "")
            return {
                "status": "success",
                "provider": "openrouter_free",
                "model": _clean(payload.get("model"), 200) or "openrouter/free",
                "response": _clean(answer, 12000),
                "caveat": "Model output is preprocessing, not source evidence.",
            }
        except Exception as exc:
            return {
                "status": "error",
                "provider": "openrouter_free",
                "response": "",
                "error": _clean(exc, 600),
                "cloudflare_error": cf_error,
            }

    return {
        "status": "unavailable",
        "provider": "none",
        "response": "",
        "reason": (
            "No free preprocessing provider is configured. Set Cloudflare "
            "Workers AI credentials or OPENROUTER_API_KEY."
        ),
        "cloudflare_error": cf_error,
    }


def normalize_evidence(
    source_url: str,
    observation: str,
    category: str = "OTHER",
    confidence: str = "LOW",
) -> dict[str, Any]:
    """Create a normalized evidence record from an observed public source.

    Use this after retrieving a source when an observation may support the
    final report. Confidence is confidence in the analytical linkage, not in
    whether the text was observed. Never use this tool to convert an inference
    into a fact.
    """
    try:
        safe_url = _validate_public_url(source_url)
    except Exception:
        safe_url = ""
    conf = _clean(confidence, 16).upper()
    if conf not in {"HIGH", "MEDIUM", "LOW"}:
        conf = "LOW"
    return {
        "source_url": safe_url,
        "observation": _clean(observation, 1800),
        "category": _clean(category, 80).upper() or "OTHER",
        "confidence": conf,
    }
