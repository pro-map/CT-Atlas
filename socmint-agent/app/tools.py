from __future__ import annotations

import ipaddress
import json
import os
import re
import socket
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
