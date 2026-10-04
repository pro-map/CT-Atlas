"""Curated CT Atlas outlet watch. All source traffic uses a local Tor SOCKS proxy.
Resumable internal-page traversal; no browser execution or external-host crawling.
"""
import argparse
import hashlib
import json
import logging
import os
import sqlite3
import tempfile
import time
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit, parse_qsl, unquote
import re
import base64
import io
import shutil
import subprocess

import requests

LOG = logging.getLogger("outlet-watch")
MAX_HTML_BYTES = 2 * 1024 * 1024
MAX_ITEMS = 500
SOURCE_CONNECT_TIMEOUT = 90
TYPES = {".pdf": "pdf", ".mp4": "video", ".webm": "video", ".mkv": "video", ".mov": "video",
         ".mp3": "audio", ".ogg": "audio", ".wav": "audio", ".m4a": "audio",
         ".jpg": "image", ".jpeg": "image", ".png": "image", ".webp": "image"}


def display_title(value):
    value = unquote(str(value or ""))
    if value.startswith(("/", "http://", "https://")):
        value = urlsplit(value).path.rsplit("/", 1)[-1]
    return " ".join(value.replace("_", " ").split())[:300]


def publication_date(value):
    # Require a complete calendar date. Neither crawl time nor HTTP Last-Modified
    # establishes the publication date. Normalize Arabic-Indic digits first.
    value = str(value or "").translate(str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789"))
    match = re.search(r"(?<![0-9])(20[0-9]{2})[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12][0-9]|3[01])(?![0-9])", value)
    if not match:
        months = {"يناير": 1, "فبراير": 2, "مارس": 3, "أبريل": 4, "ابريل": 4, "مايو": 5,
                  "يونيو": 6, "يوليو": 7, "أغسطس": 8, "اغسطس": 8, "سبتمبر": 9,
                  "أكتوبر": 10, "اكتوبر": 10, "نوفمبر": 11, "ديسمبر": 12}
        arabic = re.search(r"(?<!\d)(\d{1,2})\s+(" + "|".join(months) + r")\s+(20\d{2})(?!\d)", value)
        if not arabic:
            return ""
        try:
            return datetime(int(arabic[3]), months[arabic[2]], int(arabic[1])).date().isoformat()
        except ValueError:
            return ""
    try:
        return datetime(*map(int, match.groups())).date().isoformat()
    except ValueError:
        return ""


def within_period(row, policy):
    if not policy:
        return True
    date = publication_date(row.get("published_at"))
    return bool(date and policy["from"] <= date <= min(policy["through"], datetime.now(timezone.utc).date().isoformat()))


def apply_epoch(db, policy):
    prior = db.execute("SELECT value FROM settings WHERE key='epoch'").fetchone()
    epoch = str(policy["epoch"])
    if not prior or prior[0] != epoch:
        with db:
            for table in ("outlets", "items", "crawl_runs", "frontier", "pages", "outbox", "undated"):
                db.execute("DELETE FROM " + table)
            db.execute("DELETE FROM settings WHERE key LIKE 'publication-inventory-v1:%'")
            db.execute("INSERT OR REPLACE INTO settings VALUES ('epoch',?)", (epoch,))
        LOG.info("Collection reset acknowledged; local evidence files preserved")


def onion_url(value):
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in ("http", "https") or parsed.username or parsed.password or parsed.port:
            return ""
        if not re.fullmatch(r"[a-z2-7]{56}\.onion", parsed.hostname or "") or len(value) > 2000:
            return ""
        return urlunsplit((parsed.scheme, parsed.netloc.lower(), parsed.path or "/", parsed.query, ""))
    except (ValueError, TypeError):
        return ""


def safe_proxy(value):
    parsed = urlsplit(value)
    if parsed.scheme != "socks5h" or parsed.hostname not in ("127.0.0.1", "localhost", "::1") or not parsed.port:
        raise ValueError("Use a local socks5h Tor proxy, e.g. socks5h://127.0.0.1:9050")
    if parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        raise ValueError("Unsupported Tor proxy URL")
    return value


SKIP_EXTENSIONS = {".css", ".js", ".ico", ".woff", ".woff2", ".ttf", ".zip", ".exe", ".dmg"}
MIME_TYPES = {"application/pdf": "pdf", "video/": "video", "audio/": "audio", "image/": "image"}


class PublicationParser(HTMLParser):
    """Select substantive body blocks, never navigation labels or HTML comments.

    This is a structural heuristic, not an authenticity or official-source verdict.
    Keep traversal in ListingParser independent of these selection decisions.
    """
    VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
    OMIT = {"head", "nav", "header", "footer", "aside", "form", "script", "style", "template", "noscript", "button", "select", "h1", "h2", "h3", "h4", "h5", "h6"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack, self.blocks = [], []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        marker = " ".join(values.get(k, "") for k in ("id", "class", "itemprop"))
        tokens = set(re.split(r"[^\w]+", marker.lower()))
        excluded = bool(tokens & {"menu", "navigation", "breadcrumb", "breadcrumbs", "pagination", "sidebar"})
        omitted = tag in self.OMIT or excluded or values.get("role") == "navigation" or "hidden" in values or values.get("aria-hidden") == "true"
        comment = bool(tokens & {"comment", "comments", "reply", "replies", "commentbody", "usercomment"})
        frame = {"tag": tag, "omit": omitted or any(x["omit"] for x in self.stack),
                 "comment": comment or any(x["comment"] for x in self.stack), "parts": [], "linked": 0}
        if tag not in self.VOID:
            self.stack.append(frame)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID:
            self.handle_endtag(tag)

    def handle_data(self, data):
        if not self.stack or self.stack[-1]["omit"]:
            return
        linked = any(x["tag"] == "a" for x in self.stack)
        for frame in self.stack:
            if frame["tag"] in {"p", "article", "main", "blockquote", "div", "td", "section"}:
                frame["parts"].append(data)
                frame["linked"] += len(data) if linked else 0

    def handle_endtag(self, tag):
        index = next((i for i in range(len(self.stack)-1, -1, -1) if self.stack[i]["tag"] == tag), None)
        if index is None:
            return
        for frame in self.stack[index:]:
            raw = " ".join(frame["parts"])
            text = " ".join(raw.split())
            if not frame["omit"] and text and frame["linked"] / max(len(raw), 1) < 0.25:
                self.blocks.append((text, frame["comment"], frame["tag"]))
        del self.stack[index:]

    def selected_text(self):
        # A short explicit comment is eligible; a normal text needs real body length.
        # Prefer paragraphs to avoid concatenating an entire homepage into an article.
        candidates = [(text, comment) for text, comment, tag in self.blocks
                      if (comment and len(text) >= 80) or (len(text) >= 1200 and tag in {"p", "article", "blockquote", "div", "td"})]
        paragraphs = list(dict.fromkeys(text for text, _, tag in self.blocks if tag == "p" and len(text) >= 120))
        if sum(map(len, paragraphs)) >= 1200:
            candidates.append(("\n\n".join(paragraphs), False))
        if not candidates:
            return ""
        return max(candidates, key=lambda row: len(row[0]))[0][:100000]


def selected_material(row):
    return row.get("publication_version") == 1 or row.get("type") in {"pdf", "video", "audio"} or (row.get("type") == "image" and bool(row.get("published_at"))) or (
        row.get("type") == "page" and row.get("selection_version") == 1)


def material_type(url, mime=""):
    mime = mime.split(";", 1)[0].lower().strip()
    for prefix, kind in MIME_TYPES.items():
        if mime == prefix or (prefix.endswith("/") and mime.startswith(prefix)):
            return kind
    return TYPES.get(Path(urlsplit(url).path).suffix.lower(), "page")


class PublicationTree(HTMLParser):
    """Small inert DOM for the observed post-card/read-area template. No JS execution."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = {"tag": "root", "attrs": {}, "children": []}
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = {"tag": tag, "attrs": dict(attrs), "children": []}
        self.stack[-1]["children"].append(node)
        if tag not in PublicationParser.VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in PublicationParser.VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for i in range(len(self.stack)-1, 0, -1):
            if self.stack[i]["tag"] == tag:
                del self.stack[i:]
                break

    def handle_data(self, value):
        self.stack[-1]["children"].append(value)


def descendants(node):
    stack = [node]
    while stack:
        current = stack.pop()
        if not isinstance(current, dict):
            continue
        yield current
        if current["tag"] not in {"script", "style", "svg", "noscript", "template"}:
            stack.extend(reversed(current["children"]))


def has_class(node, name):
    return name in node["attrs"].get("class", "").split()


def original_text(node):
    """Retain Unicode and paragraph boundaries; never include navigation or active HTML."""
    if node is None:
        return ""
    parts, stack = [], [node]
    while stack:
        current = stack.pop()
        if current is None:
            parts.append("\n")
        elif isinstance(current, str):
            # Physical line wrapping in saved HTML is layout whitespace, not a
            # paragraph break. Only block elements introduce paragraph boundaries.
            parts.append(re.sub(r"\s+", " ", current))
        elif current["tag"] not in {"script", "style", "svg", "noscript", "template", "button", "canvas"} and not (
                set(current["attrs"].get("class", "").split()) & {"pdf-viewer", "paginator", "page-number-indicator", "next-prev-btn", "loading-wrapper"}
                or current["attrs"].get("role") == "toolbar"):
            block = current["tag"] in {"p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote"}
            if block:
                parts.append("\n")
            stack.extend([None] if block else [])
            stack.extend(reversed(current["children"]))
    return "\n\n".join(line for line in (" ".join(p.split()) for p in "".join(parts).splitlines()) if line)


def structured_publications(html, base):
    """One record per card/permalink; attachment links never become separate publications.

    Host addresses and source material are runtime input, not embedded in the code.
    Return None for other templates so their existing collection rules remain intact.
    """
    tree = PublicationTree()
    tree.feed(html)
    nodes = list(descendants(tree.root))
    host = urlsplit(base).hostname
    def local(value):
        url = onion_url(urljoin(base, value or ""))
        return url if value and url and urlsplit(url).hostname == host else ""
    def first(parent, cls):
        return next((n for n in descendants(parent) if has_class(n, cls)), None)
    def record(url, title, text, date_raw, complete=False, attachments=None, preview=""):
        category = urlsplit(url).path.split("/")[2] if re.match(r"/posts/[^/]+/[^/]+/?$", urlsplit(url).path) else "publication"
        full = text or title
        clipped = full.encode("utf-8")[:48000].decode("utf-8", errors="ignore")
        kind = {"naba": "pdf", "videos": "video", "audios": "audio"}.get(category, "page")
        return {"url": url, "title": title[:2000], "type": kind, "category": category,
                "original_text": clipped, "excerpt": full[:600], "source_date": date_raw[:150],
                "published_at": publication_date(date_raw), "date_basis": "html", "source_page": url,
                "publication_version": 1, "text_status": "truncated" if clipped != full or len(title) > 2000 else "complete" if complete else "listing",
                "attachments": attachments or [], "preview_url": preview, "crawl": not complete}
    holder = next((n for n in nodes if n["attrs"].get("id") == "post-card-holder"), None)
    if holder is not None:
        rows = {}
        for card in (n for n in descendants(holder) if has_class(n, "post-card")):
            link = next((local(n["attrs"].get("href")) for n in descendants(card)
                         if n["tag"] == "a" and has_class(n, "post-card-link") and local(n["attrs"].get("href"))), "")
            if not link or not re.match(r"^/posts/[^/]+/[^/]+/?$", urlsplit(link).path):
                continue
            title = original_text(first(card, "post-summary"))
            footer = first(card, "card-footer")
            date_node = next((n for n in descendants(footer or tree.root) if n["tag"] in {"span", "time"} and publication_date(original_text(n))), None) if footer else None
            if title:
                rows[link] = record(link, title, title, original_text(date_node))
        # Follow the main list's own pagination, not sidebars, donation links or related posts.
        for pagination in (n for n in nodes if has_class(n, "pagination")):
            for link in descendants(pagination):
                target = local(link["attrs"].get("href")) if link["tag"] == "a" else ""
                if target and target != base:
                    rows.setdefault(target, {"url": target, "type": "page", "title": "Listing page", "crawl": True})
        return {"items": list(rows.values()), "page": None, "text": "", "truncated": False, "structured": True}
    area = next((n for n in nodes if has_class(n, "read-area")), None)
    content = next((n for n in descendants(area) if n["attrs"].get("id") == "post-content"), None) if area else None
    if area is None or content is None:
        return None
    title = original_text(first(area, "title"))
    if not title:
        return {"items": [], "page": None, "text": "", "truncated": True, "structured": True}
    date_raw = original_text(first(area, "author-profile"))
    meta = {n["attrs"].get("property"): n["attrs"].get("content", "") for n in nodes if n["tag"] == "meta"}
    published = publication_date(meta.get("article:published_time")) or publication_date(date_raw)
    # The requested permalink is the record identity. Do not trust a conflicting og:url.
    attachments = {}
    for n in descendants(content):
        attrs = n["attrs"]
        for key in ("href", "src", "data", "data-url", "data-pdf", "data-src"):
            target = local(attrs.get(key))
            if not target:
                continue
            kind = material_type(target, attrs.get("type", ""))
            if kind in {"pdf", "video", "audio", "image"}:
                attachments[target] = {"url": target, "type": kind, "title": original_text(n)[:300] or display_title(target)}
        # PDF.js viewers commonly carry the original URL in a file= query parameter.
        for key in ("src", "href"):
            for param, value in parse_qsl(urlsplit(attrs.get(key, "")).query):
                target = local(value) if param == "file" else ""
                if target and material_type(target) == "pdf":
                    attachments[target] = {"url": target, "type": "pdf", "title": display_title(target)}
    preview = local(meta.get("og:image"))
    if preview and material_type(preview) != "image":
        preview = ""
    if not preview:
        hero = first(area, "hero-area")
        match = re.search(r"url\(['\"]?([^)'\"]+)", hero["attrs"].get("style", "")) if hero else None
        preview = local(match[1]) if match else ""
    body = original_text(content)
    full = title + ("\n\n" + body if body and body != title else "")
    row = record(base, title, full, date_raw, True, list(attachments.values())[:12], preview)
    row["published_at"] = published
    if len(attachments) > 12:
        row["attachments_truncated"] = True
    return {"items": [], "page": row, "text": full, "truncated": False, "structured": True}


class ListingParser(HTMLParser):
    def __init__(self, base):
        super().__init__(convert_charrefs=True)
        self.base, self.host = base, urlsplit(base).hostname
        self.rows, self.parts, self.text_parts, self.title_parts = {}, [], [], []
        self.current, self.truncated, self.in_title, self.ignored = None, False, False, 0
        self.text_size = 0
        self.published_at, self.poster, self.preview_url = "", "", ""
        self.page_dates = set()
        self.structured_parts, self.in_structured = [], False

    def add_link(self, href, title="", kind=None):
        target = onion_url(urljoin(self.base, href or ""))
        if not target or urlsplit(target).hostname != self.host or target == self.base:
            return None
        parsed = urlsplit(target)
        # Follow document links, never account/moderation actions or forms.
        actions = {"logout", "signout", "delete", "remove", "unsubscribe", "ban"}
        if any(part.lower() in actions for part in parsed.path.split("/")) or any(
                key.lower() in {"action", "do", "act"} and value.lower() in actions
                for key, value in parse_qsl(parsed.query)):
            return None
        if Path(parsed.path).suffix.lower() in SKIP_EXTENSIONS:
            return None
        if len(self.rows) >= MAX_ITEMS and target not in self.rows:
            self.truncated = True
            return None
        self.rows[target] = {"url": target, "title": display_title(title) or display_title(target),
                             "type": kind or material_type(target), "source_page": self.base}
        return target

    def handle_starttag(self, tag, attrs):
        if tag == "script" and dict(attrs).get("type", "").lower() == "application/ld+json":
            self.in_structured, self.structured_parts = True, []
        if tag in ("script", "style"):
            self.ignored += 1
        if self.ignored:
            return
        values = dict(attrs)
        if tag == "meta" and values.get("property", values.get("name", "")).lower() in {"article:published_time", "datepublished", "date"}:
            self.published_at = publication_date(values.get("content")) or self.published_at
        if tag == "time":
            date = publication_date(values.get("datetime"))
            if date:
                self.page_dates.add(date)
        if tag == "meta" and values.get("property", "").lower() == "og:image":
            self.preview_url = onion_url(urljoin(self.base, values.get("content", "")))
        if tag == "video" and values.get("poster"):
            self.poster = onion_url(urljoin(self.base, values["poster"]))
        if tag == "title":
            self.in_title = True
        if tag == "a":
            self.current = self.add_link(values.get("href"))
            self.parts = []
        if tag in ("video", "audio", "source", "iframe", "embed", "object"):
            kind = material_type(values.get("src", values.get("data", "")), values.get("type", ""))
            if tag in ("video", "audio"):
                kind = tag
            self.add_link(values.get("src", values.get("data", "")), values.get("title", ""), kind)
        if tag == "link" and "next" in values.get("rel", "").lower().split():
            self.add_link(values.get("href"), "Next page")

    def handle_data(self, data):
        if self.in_structured and sum(map(len, self.structured_parts)) < 100000:
            self.structured_parts.append(data[:100000])
        if self.ignored:
            return
        if self.current and sum(len(p) for p in self.parts) < 1000:
            self.parts.append(data[:1000])
        if self.in_title:
            self.title_parts.append(data[:300])
        if self.text_size < 100000:
            part = data[:100000 - self.text_size]
            self.text_parts.append(part)
            self.text_size += len(part)

    def handle_endtag(self, tag):
        if tag == "script" and self.in_structured:
            self.in_structured = False
            try:
                records = json.loads("".join(self.structured_parts))
                queue = records if isinstance(records, list) else [records]
                for entry in queue[:100]:
                    if not isinstance(entry, dict):
                        continue
                    if isinstance(entry.get("@graph"), list):
                        queue.extend(entry["@graph"][:100])
                    date = publication_date(entry.get("datePublished"))
                    if date:
                        self.page_dates.add(date)
                # Graph entries are common in publication metadata.
                for entry in queue[:200]:
                    if isinstance(entry, dict):
                        date = publication_date(entry.get("datePublished"))
                        if date:
                            self.page_dates.add(date)
            except (ValueError, TypeError):
                pass
        if tag in ("script", "style") and self.ignored:
            self.ignored -= 1
        if tag == "title":
            self.in_title = False
        if tag == "a" and self.current:
            self.rows[self.current]["title"] = display_title(" ".join(self.parts)) or display_title(self.current)
            self.current, self.parts = None, []


def source_get(session, url, host):
    """Validate every redirect *before* making another source request."""
    for _ in range(4):
        if not onion_url(url) or urlsplit(url).hostname != host:
            raise ValueError("Source redirect leaves the registered onion host")
        response = session.get(url, stream=True, allow_redirects=False,
                               timeout=(getattr(session, "source_connect_timeout", SOURCE_CONNECT_TIMEOUT), 90))
        if response.status_code in (301, 302, 303, 307, 308):
            location = response.headers.get("Location")
            response.close()
            if not location:
                raise ValueError("Redirect missing Location")
            url = urljoin(url, location)
            continue
        try:
            response.raise_for_status()
        except Exception:
            response.close()
            raise
        return response
    raise ValueError("Too many redirects")


def source_failure_reason(error):
    """Explain failures without logging source URLs, response text or credentials."""
    if isinstance(error, requests.exceptions.HTTPError):
        status = getattr(error.response, "status_code", None)
        return "HTTP " + str(status) if isinstance(status, int) else "HTTP error"
    if isinstance(error, requests.exceptions.Timeout):
        return type(error).__name__ + " (request timed out)"
    if isinstance(error, requests.exceptions.ConnectionError):
        # Requests may wrap a SOCKS handshake timeout as ConnectionError.
        message = str(error).lower()
        if "timed out" in message or "timeout" in message:
            return "Tor/SOCKS connection timed out"
        if "refused" in message:
            return "Tor/SOCKS connection refused"
        return "Tor/SOCKS connection failed"
    known = {"Listing exceeds HTML size limit", "Source redirect leaves the registered onion host",
             "Redirect missing Location", "Too many redirects", "Local PDF size mismatch or exceeds Atlas limit",
             "Local file is not a PDF", "Local PDF hash mismatch", "PDF upload was not acknowledged"}
    if isinstance(error, ValueError) and str(error) in known:
        return str(error)
    return type(error).__name__


def read_listing(session, outlet):
    response = source_get(session, outlet["url"], urlsplit(outlet["url"]).hostname)
    try:
        mime = response.headers.get("Content-Type", "").lower()
        kind = material_type(response.url, mime)
        if kind != "page":
            return {"items": [], "page": {"url": outlet["url"], "title": display_title(response.url),
                    "type": kind, "published_at": publication_date(unquote(response.url)), "date_basis": "url"}, "text": "", "truncated": False}
        if mime and "html" not in mime:
            return {"items": [], "page": None, "text": "", "truncated": False}
        chunks, total = [], 0
        for chunk in response.iter_content(65536):
            total += len(chunk)
            if total > MAX_HTML_BYTES:
                raise ValueError("Listing exceeds HTML size limit")
            chunks.append(chunk)
        parser = ListingParser(response.url)
        encoding = response.encoding or "utf-8"
        if encoding.lower() == "iso-8859-1":
            encoding = "utf-8"
        html = b"".join(chunks).decode(encoding, errors="replace")
        structured = structured_publications(html, outlet["url"])
        if structured is not None:
            return structured
        parser.feed(html)
        parser.close()
        selector = PublicationParser()
        selector.feed(html)
        selector.handle_endtag("html")
        selected = selector.selected_text()
        text = " ".join(" ".join(parser.text_parts).split())
        title = " ".join(" ".join(parser.title_parts).split())[:300] or display_title(response.url)
        # A unique HTML time on a publication page can date its attachments.
        # Category pages with multiple dates cannot assign one date to every file.
        dated = parser.published_at or (next(iter(parser.page_dates)) if len(parser.page_dates) == 1 else "")
        for row in parser.rows.values():
            row["title"] = display_title(row["title"])
            row["published_at"] = publication_date(unquote(row["url"]))
            row["date_basis"] = "url" if row["published_at"] else ""
            if row["type"] != "page" and dated and (selected or parser.published_at):
                row["published_at"] = row["published_at"] or dated
                row["date_basis"] = row["date_basis"] or "source_page"
            preview = parser.poster if row["type"] == "video" else parser.preview_url
            if preview and urlsplit(preview).hostname == urlsplit(outlet["url"]).hostname:
                row["preview_url"] = preview
        return {"items": list(parser.rows.values()), "page": {"url": outlet["url"], "title": title,
                "type": "page", "published_at": dated, "date_basis": "html", "preview_url": parser.preview_url, "excerpt": selected[:600], "selection_version": 1 if selected else 0}, "text": text, "truncated": parser.truncated}
    finally:
        response.close()


def preview_source(row):
    """Identify actual preview bytes so listing-only failures do not block detail previews."""
    if row.get("publication_version") == 1:
        attachment = next((a for a in row.get("attachments", []) if a.get("type") == "pdf"), None)
        if attachment:
            return ("pdf", attachment["url"])
    if row.get("preview_url"):
        return ("image", row["preview_url"])
    if not row.get("publication_version") and row.get("type") in {"pdf", "image", "video"}:
        return (row["type"], row["url"])
    return None


def make_preview(tor, row):
    result = _make_preview(tor, row)
    if not result.get("preview") and row.get("publication_version") == 1 and row.get("preview_url") and any(a.get("type") == "pdf" for a in row.get("attachments", [])):
        # Large/unreadable PDFs may still supply a usable cover image in the page.
        cover = _make_preview(tor, {**row, "attachments": []})
        if cover.get("preview"):
            result = cover
    return {**result, "preview_version": 2}


def _make_preview(tor, row):
    """At most 8 MiB of source bytes; never keep or upload original media."""
    if row.get("publication_version") == 1:
        attachment = next((a for a in row.get("attachments", []) if a["type"] == "pdf"), None)
        if attachment:
            row = {**attachment, "preview_url": ""}
        elif not row.get("preview_url"):
            return {"preview_status": "No visual preview supplied"}
    kind = row.get("type")
    preview_url = row.get("preview_url", "")
    target = preview_url or (row["url"] if kind in {"pdf", "image", "video"} else "")
    if not target:
        return {"preview_status": "No visual preview supplied"}
    host = urlsplit(row["url"]).hostname
    if not onion_url(target) or urlsplit(target).hostname != host:
        return {"preview_status": "Preview outside registered outlet"}
    try:
        from PIL import Image
        if not preview_url and kind == "pdf":
            import fitz
        if not preview_url and kind == "video" and not shutil.which("ffmpeg"):
            return {"preview_status": "No poster; local FFmpeg required"}
        response = source_get(tor, target, host)
        try:
            length = response.headers.get("Content-Length", "")
            if length.isdigit() and int(length) > 8 * 1048576:
                return {"preview_status": "Preview source exceeds 8 MB cap"}
            chunks, size = [], 0
            for chunk in response.iter_content(65536):
                size += len(chunk)
                if size > 8 * 1048576:
                    return {"preview_status": "Preview source exceeds 8 MB cap"}
                chunks.append(chunk)
            data = b"".join(chunks)
        finally:
            response.close()
        if not preview_url and kind == "pdf":
            with fitz.open(stream=data, filetype="pdf") as document:
                page = document[0]
                scale = min(1, 320 / max(page.rect.width, page.rect.height, 1))
                pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
                data = pix.tobytes("png")
        elif not preview_url and kind == "video":
            # pipe-only protocols prevent playlists from fetching network/local files.
            result = subprocess.run(["ffmpeg", "-v", "error", "-protocol_whitelist", "pipe", "-i", "pipe:0", "-frames:v", "1", "-vf", "scale=320:320:force_original_aspect_ratio=decrease", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"], input=data, capture_output=True, timeout=20, check=True)
            data = result.stdout
        with Image.open(io.BytesIO(data)) as original:
            if original.width * original.height > 16000000:
                return {"preview_status": "Preview dimensions exceed cap"}
            original.thumbnail((240, 240))
            picture = original.convert("RGB")
            for quality in (65, 45, 25):
                output = io.BytesIO()
                picture.save(output, format="JPEG", quality=quality)
                encoded = "data:image/jpeg;base64," + base64.b64encode(output.getvalue()).decode("ascii")
                if len(encoded) <= 16000:
                    return {"preview": encoded, "preview_status": "Source thumbnail" if preview_url else "First page" if kind == "pdf" else "Video frame" if kind == "video" else "Image preview"}
        return {"preview_status": "Preview could not fit size cap"}
    except ImportError:
        return {"preview_status": "Install Pillow and PyMuPDF on collector"}
    except Exception:
        return {"preview_status": "Preview unavailable within collection limits"}


def acquire(session, item, evidence, max_bytes):
    evidence.mkdir(parents=True, exist_ok=True)
    response = source_get(session, item["url"], urlsplit(item["url"]).hostname)
    temporary = None
    try:
        # Error/login pages are not downloaded as purported PDF/video evidence.
        if "html" in response.headers.get("Content-Type", "").lower():
            raise ValueError("Material link returned HTML")
        length = response.headers.get("Content-Length", "")
        if length.isdigit() and int(length) > max_bytes:
            raise ValueError("Material exceeds acquisition cap")
        digest, size = hashlib.sha256(), 0
        with tempfile.NamedTemporaryFile(dir=evidence, prefix=".partial-", delete=False) as output:
            temporary = Path(output.name)
            for chunk in response.iter_content(65536):
                size += len(chunk)
                if size > max_bytes:
                    raise ValueError("Material exceeds acquisition cap")
                digest.update(chunk)
                output.write(chunk)
        fingerprint = digest.hexdigest()
        if item.get("type") == "pdf":
            with temporary.open("rb") as downloaded:
                if downloaded.read(5) != b"%PDF-":
                    raise ValueError("Material is not a PDF")
        extension = ".pdf" if item.get("type") == "pdf" else ".bin"
        destination = evidence / (fingerprint + extension)
        if destination.exists():
            temporary.unlink()
        else:
            temporary.replace(destination)
        temporary = None
        return {"acquired": True, "sha256": fingerprint, "bytes": size}
    finally:
        response.close()
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def api_session(endpoint, token):
    parsed = urlsplit(endpoint)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise ValueError("CT Atlas API must be an HTTPS origin")
    if len(token) < 32:
        raise ValueError("DARKWEB_INGEST_TOKEN must contain at least 32 characters")
    session = requests.Session()
    session.trust_env = False
    session.headers.update({"Authorization": "Bearer " + token, "User-Agent": "CTAtlas-OutletWatch/1"})
    return session, endpoint.rstrip("/")


def api_call(session, endpoint, path, payload=None):
    response = session.request("GET" if payload is None else "POST", endpoint + path,
                               data=None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                               headers={"Content-Type": "application/json"}, timeout=(15, 60), allow_redirects=False)
    try:
        if 300 <= response.status_code < 400:
            raise ValueError("API redirects are not followed with collector credentials")
        response.raise_for_status()
        return response.json()
    finally:
        response.close()


def open_database(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE IF NOT EXISTS outlets (id TEXT PRIMARY KEY, initialized INTEGER NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS items (outlet_id TEXT, url TEXT, metadata TEXT, baseline INTEGER, PRIMARY KEY(outlet_id,url))")
    db.execute("CREATE TABLE IF NOT EXISTS crawl_runs (outlet_id TEXT PRIMARY KEY, finished INTEGER DEFAULT 0)")
    db.execute("CREATE TABLE IF NOT EXISTS frontier (outlet_id TEXT, url TEXT, status TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0, PRIMARY KEY(outlet_id,url))")
    db.execute("CREATE TABLE IF NOT EXISTS pages (outlet_id TEXT, url TEXT, title TEXT, text TEXT, checked_at TEXT, PRIMARY KEY(outlet_id,url))")
    db.execute("CREATE TABLE IF NOT EXISTS outbox (outlet_id TEXT, url TEXT, metadata TEXT, baseline INTEGER, PRIMARY KEY(outlet_id,url))")
    db.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)")
    db.execute("CREATE TABLE IF NOT EXISTS pdf_uploads (outlet_id TEXT, item_url TEXT, sha256 TEXT, epoch INTEGER, status TEXT, attempts INTEGER, next_try REAL, PRIMARY KEY(outlet_id,item_url,sha256,epoch))")
    db.execute("CREATE TABLE IF NOT EXISTS undated (outlet_id TEXT, url TEXT, metadata TEXT, PRIMARY KEY(outlet_id,url))")
    if "depth" not in [row[1] for row in db.execute("PRAGMA table_info(frontier)")]:
        db.execute("ALTER TABLE frontier ADD COLUMN depth INTEGER DEFAULT 0")
    return db


def sync_pdf_files(api, endpoint, db, outlet, evidence, storage, max_uploads=2):
    """Upload acquired PDFs from disk; never reset state or fetch an onion URL."""
    if not storage or not storage.get("configured"):
        return False
    policy = outlet["policy"]
    if policy.get("paused"):
        return False
    epoch, oid, now = policy["epoch"], outlet["id"], time.time()
    candidates = []
    for url, raw in db.execute("SELECT url,metadata FROM items WHERE outlet_id=? ORDER BY rowid", (oid,)):
        row = json.loads(raw)
        if row.get("publication_version") != 1 or not within_period(row, policy):
            continue
        for file in row.get("attachments", []):
            fingerprint = file.get("sha256", "")
            if file.get("type") != "pdf" or not file.get("acquired") or not re.fullmatch(r"[a-f0-9]{64}", fingerprint):
                continue
            key = (oid, url, fingerprint, epoch)
            prior = db.execute("SELECT status,attempts,next_try FROM pdf_uploads WHERE outlet_id=? AND item_url=? AND sha256=? AND epoch=?", key).fetchone()
            if prior and prior[2] > now:
                continue
            candidates.append((url, file, key, prior))
    for url, file, key, prior in candidates[:max_uploads]:
        fingerprint = file["sha256"]
        params = {"id": hashlib.sha256((oid + "\n" + url).encode()).hexdigest(), "sha256": fingerprint,
                  "epoch": epoch, "outlet_id": oid}
        attempts = (prior[1] if prior else 0) + 1
        status, next_try = "retry", now + min(900, 60 * 2 ** min(attempts, 4))
        response = None
        try:
            response = api.request("GET", endpoint + "/darkweb/file-status", params=params,
                                   timeout=(15, 60), allow_redirects=False)
            response.raise_for_status()
            remote = response.json()
            response.close(); response = None
            if remote.get("stored") is not True:
                path = evidence / (fingerprint + ".pdf")
                size = path.stat().st_size
                if size != file.get("bytes") or not 5 <= size <= storage.get("max_file_bytes", 50 * 1048576):
                    raise ValueError("Local PDF size mismatch or exceeds Atlas limit")
                with path.open("rb") as source:
                    if source.read(5) != b"%PDF-":
                        raise ValueError("Local file is not a PDF")
                    source.seek(0)
                    digest = hashlib.sha256()
                    for chunk in iter(lambda: source.read(65536), b""):
                        digest.update(chunk)
                    if digest.hexdigest() != fingerprint:
                        raise ValueError("Local PDF hash mismatch")
                    source.seek(0)
                    response = api.request("POST", endpoint + "/darkweb/file-upload", params=params, data=source,
                                           headers={"Content-Type": "application/pdf", "Content-Length": str(size)},
                                           timeout=(15, 180), allow_redirects=False)
                    response.raise_for_status()
                    if response.json().get("stored") is not True:
                        raise ValueError("PDF upload was not acknowledged")
            status, attempts, next_try = "stored", 0, now + 86400
            LOG.info("Outlet %s: PDF available in Atlas (%s bytes)", oid, file.get("bytes"))
        except Exception as error:
            code = getattr(response, "status_code", None)
            if code == 507:
                status, next_try = "storage_limit", now + 900
            LOG.warning("Outlet %s: PDF sync pending (%s); local file preserved", oid,
                        "storage limit reached" if code == 507 else source_failure_reason(error))
        finally:
            if response is not None:
                response.close()
            with db:
                db.execute("INSERT OR REPLACE INTO pdf_uploads VALUES (?,?,?,?,?,?,?)", (*key, status, attempts, next_try))
    # Drain remaining local files promptly, without repeatedly retrying failed files.
    return len(candidates) > max_uploads


def crawl_outlet(tor, db, outlet, pages_per_scan=100, max_pages=10000, request_delay=1.0):
    oid = outlet["id"]
    policy = outlet.get("policy")
    watching = outlet.get("collection_phase") == "watch"
    run = db.execute("SELECT finished FROM crawl_runs WHERE outlet_id=?", (oid,)).fetchone()
    if not run or run[0]:
        with db:
            db.execute("DELETE FROM frontier WHERE outlet_id=?", (oid,))
            db.execute("INSERT OR REPLACE INTO crawl_runs VALUES (?,0)", (oid,))
            db.execute("INSERT INTO frontier(outlet_id,url) VALUES (?,?)", (oid, outlet["url"]))
    # A failed upload is replayed before advancing the crawler.
    if db.execute("SELECT 1 FROM outbox WHERE outlet_id=? LIMIT 1", (oid,)).fetchone():
        return crawl_progress(db, oid, max_pages)
    local_initialized = bool(db.execute("SELECT initialized FROM outlets WHERE id=?", (oid,)).fetchone())
    visited = 0
    while visited < pages_per_scan:
        if db.execute("SELECT COUNT(*) FROM frontier WHERE outlet_id=?", (oid,)).fetchone()[0] >= 50000:
            break
        done = db.execute("SELECT COUNT(*) FROM frontier WHERE outlet_id=? AND status='done'", (oid,)).fetchone()[0]
        if done >= max_pages:
            break
        target = db.execute("SELECT url,depth FROM frontier WHERE outlet_id=? AND status IN ('pending','failed') AND attempts<3 ORDER BY attempts,rowid LIMIT 1", (oid,)).fetchone()
        if not target:
            break
        url = target[0]
        if visited == 0 or visited % 10 == 0:
            LOG.info("Outlet %s: crawling internal pages (%s fetched in this cycle)", oid, done)
        if visited and request_delay:
            time.sleep(request_delay)
        visited += 1
        try:
            result = read_listing(tor, {**outlet, "url": url})
        except Exception as error:
            with db:
                db.execute("UPDATE frontier SET status='failed',attempts=attempts+1 WHERE outlet_id=? AND url=?", (oid, url))
            LOG.warning("Internal page failed for outlet %s: %s; connect timeout=%ss, read timeout=90s; queue retained",
                        oid, source_failure_reason(error), getattr(tor, "source_connect_timeout", SOURCE_CONNECT_TIMEOUT))
            continue
        records = result["items"] + ([result["page"]] if result["page"] else [])
        with db:
            # Page truncation is explicit and never treated as a full inventory.
            db.execute("UPDATE frontier SET status=?,attempts=attempts+1 WHERE outlet_id=? AND url=?",
                       ("limited" if result["truncated"] else "done", oid, url))
            if result["page"] and result["page"]["type"] == "page":
                db.execute("INSERT OR REPLACE INTO pages VALUES (?,?,?,?,?)", (oid, url, result["page"]["title"],
                           result["text"], datetime.now(timezone.utc).isoformat()))
            for row in records:
                target_url = onion_url(row["url"])
                if not target_url or urlsplit(target_url).hostname != urlsplit(outlet["url"]).hostname:
                    continue
                if (row.get("crawl") or row["type"] == "page") and target_url != url and (not watching or target[1] < 2):
                    db.execute("INSERT OR IGNORE INTO frontier(outlet_id,url,depth) VALUES (?,?,?)", (oid, target_url, target[1]+1))
                if not selected_material(row):
                    continue
                if not within_period(row, policy):
                    if not row.get("published_at"):
                        db.execute("INSERT OR REPLACE INTO undated VALUES (?,?,?)", (oid, target_url, json.dumps(row)))
                        db.execute("DELETE FROM undated WHERE rowid NOT IN (SELECT rowid FROM undated ORDER BY rowid DESC LIMIT 500)")
                    continue
                prior = db.execute("SELECT metadata,baseline FROM items WHERE outlet_id=? AND url=?", (oid, target_url)).fetchone()
                queued = db.execute("SELECT metadata,baseline FROM outbox WHERE outlet_id=? AND url=?", (oid, target_url)).fetchone()
                previous = json.loads((queued or prior)[0]) if queued or prior else {}
                if previous.get("publication_version") == 1 and previous.get("text_status") in {"complete", "truncated"} and row.get("text_status") == "listing":
                    # Listing excerpts must never downgrade a fetched publication.
                    continue
                # Preserve a fetched page's title/excerpt when a later navigation link points to it.
                merged = {**previous, **row}
                if row.get("publication_version") == 1:
                    old_files = {a["url"]: a for a in previous.get("attachments", [])}
                    merged["attachments"] = [{**old_files.get(a["url"], {}), **a} for a in row.get("attachments", [])]
                if preview_source(previous) != preview_source(merged):
                    merged.pop("preview", None)
                    merged.pop("preview_status", None)
                if previous.get("type", "page") != "page" and row["type"] == "page" and not row.get("excerpt"):
                    merged["type"] = previous["type"]
                if previous.get("excerpt") and not row.get("excerpt"):
                    merged["title"], merged["excerpt"] = previous["title"], previous["excerpt"]
                baseline = bool((queued or prior)[1]) if queued or prior else not local_initialized
                db.execute("INSERT OR REPLACE INTO outbox VALUES (?,?,?,?)", (oid, target_url, json.dumps(merged), int(baseline)))
        # Bound the local queue as well as network requests; do not drop any queued URL.
        if db.execute("SELECT COUNT(*) FROM frontier WHERE outlet_id=?", (oid,)).fetchone()[0] >= 50000:
            break
    return crawl_progress(db, oid, max_pages)


def crawl_progress(db, oid, max_pages):
    counts = dict(db.execute("SELECT status,COUNT(*) FROM frontier WHERE outlet_id=? GROUP BY status", (oid,)))
    done = counts.get("done", 0)
    failed = counts.get("failed", 0)
    pending = counts.get("pending", 0)
    limited = counts.get("limited", 0) > 0 or (done >= max_pages and pending > 0) or sum(counts.values()) >= 50000
    return {"pages_scanned": done + counts.get("limited", 0), "pending_pages": pending, "failed_pages": failed,
            "truncated": limited, "complete": pending == 0 and failed == 0 and not limited}


def scan_outlet(api, endpoint, tor, db, outlet, evidence, acquire_files, max_bytes,
                pages_per_scan=100, max_pages=10000, request_delay=1.0):
    policy = outlet.get("policy")
    # Revisit previously scanned pages once after the parser upgrade without
    # deleting evidence, metadata or online results. Persist progress across CMD restarts.
    inventory_key = "publication-inventory-v1:" + outlet["id"]
    inventory = db.execute("SELECT value FROM settings WHERE key=?", (inventory_key,)).fetchone()
    if not inventory:
        with db:
            db.execute("DELETE FROM frontier WHERE outlet_id=?", (outlet["id"],))
            db.execute("DELETE FROM crawl_runs WHERE outlet_id=?", (outlet["id"],))
            db.execute("INSERT OR REPLACE INTO settings VALUES (?, 'running')", (inventory_key,))
    if not inventory or inventory[0] != "complete":
        outlet = {**outlet, "collection_phase": "backfill"}
    if policy:
        pages_per_scan = min(pages_per_scan, policy["pages_per_scan"])
        max_pages = min(max_pages, 200 if outlet.get("collection_phase") == "watch" else 10000)
    progress = crawl_outlet(tor, db, outlet, pages_per_scan, max_pages, request_delay)
    oid = outlet["id"]
    if policy:
        # Fill missing previews gradually even for older backfill pages that the
        # shallow watch cycle no longer visits. Keep the same per-pass budget.
        with db:
            added = 0
            for old_url, metadata, baseline in db.execute("SELECT url,metadata,baseline FROM items WHERE outlet_id=? ORDER BY rowid", (oid,)).fetchall():
                item = json.loads(metadata)
                pdf_pending = any(a.get("type") == "pdf" and not a.get("acquired") and a.get("attempts", 0) < 3 for a in item.get("attachments", []))
                preview_pending = policy.get("previews") and not item.get("preview") and (not item.get("preview_status") or item.get("preview_version") != 2)
                if within_period(item, policy) and (pdf_pending or preview_pending):
                    db.execute("INSERT OR IGNORE INTO outbox VALUES (?,?,?,?)", (oid, old_url, metadata, baseline))
                    added += 1
                    if added >= 2:
                        break
    pending = db.execute("SELECT url,metadata,baseline FROM outbox WHERE outlet_id=? ORDER BY rowid", (oid,)).fetchall()
    batch, batch_size = [], 0
    previews_left = 2
    pdfs_left = 2

    def upload(rows, final):
        result = api_call(api, endpoint, "/darkweb/ingest", {"selection_version": 2, "collection_epoch": policy["epoch"] if policy else 0, "undated_count": db.execute("SELECT COUNT(*) FROM undated WHERE outlet_id=?", (oid,)).fetchone()[0], "outlet_id": oid, "items": [r for r, _ in rows],
            "inventory_phase": outlet.get("collection_phase", "backfill"),
            "scan_ok": progress["pages_scanned"] > 0, "scan_complete": final and progress["complete"],
            "truncated": progress["truncated"], "pages_scanned": progress["pages_scanned"],
            "pending_pages": progress["pending_pages"], "failed_pages": progress["failed_pages"]})
        if result.get("ok") is not True:
            raise ValueError("Ingestion did not acknowledge the scan")
        with db:
            for row, baseline in rows:
                db.execute("INSERT OR REPLACE INTO items VALUES (?,?,?,?)", (oid, row["url"], json.dumps(row), int(baseline)))
                db.execute("DELETE FROM outbox WHERE outlet_id=? AND url=?", (oid, row["url"]))

    for _, payload, baseline in pending:
        row = json.loads(payload)
        # An older collector may have left navigation entries awaiting upload.
        if not selected_material(row) or not within_period(row, policy):
            with db:
                db.execute("DELETE FROM outbox WHERE outlet_id=? AND url=?", (oid, row["url"]))
            continue
        if row.get("publication_version") == 1:
            for attachment in row.get("attachments", []):
                if attachment["type"] != "pdf" or attachment.get("acquired") or attachment.get("attempts", 0) >= 3 or not pdfs_left:
                    continue
                pdfs_left -= 1
                attachment["attempts"] = attachment.get("attempts", 0) + 1
                try:
                    attachment.update(acquire(tor, attachment, evidence, max_bytes))
                    attachment["status"] = "downloaded_on_collector"
                except Exception:
                    attachment["status"] = "download_failed_or_exceeds_cap"
                    LOG.warning("PDF acquisition failed or exceeded cap for outlet %s", oid)
            with db:
                db.execute("UPDATE outbox SET metadata=? WHERE outlet_id=? AND url=?", (json.dumps(row), oid, row["url"]))
        if policy and policy.get("previews"):
            prior = db.execute("SELECT metadata FROM items WHERE outlet_id=? AND url=?", (oid, row["url"])).fetchone()
            previous = json.loads(prior[0]) if prior else {}
            if preview_source(previous) == preview_source(row) and (previous.get("preview") or previous.get("preview_status")):
                row.update({key: previous[key] for key in ("preview", "preview_status", "preview_version") if key in previous})
            if not row.get("preview") and row.get("preview_version") != 2:
                row.pop("preview_status", None)
            if not row.get("preview") and not row.get("preview_status") and previews_left:
                previews_left -= 1
                row.update(make_preview(tor, row))
                with db:
                    db.execute("UPDATE outbox SET metadata=? WHERE outlet_id=? AND url=?", (json.dumps(row), oid, row["url"]))
        if acquire_files and not baseline and not row.get("publication_version") and row["type"] != "page" and not row.get("acquired"):
            try:
                row.update(acquire(tor, row, evidence, max_bytes))
                # Retain the acquired metadata even if the subsequent upload fails.
                with db:
                    db.execute("UPDATE outbox SET metadata=? WHERE outlet_id=? AND url=?", (json.dumps(row), oid, row["url"]))
            except Exception:
                LOG.warning("Acquisition failed or exceeded cap for outlet %s", oid)
        encoded_size = len(json.dumps(row, ensure_ascii=False).encode("utf-8"))
        if batch and (len(batch) >= 100 or batch_size + encoded_size > 90000):
            upload(batch, False)
            batch, batch_size = [], 0
        batch.append((row, baseline))
        batch_size += encoded_size
    upload(batch, True)
    if progress["complete"]:
        with db:
            db.execute("INSERT OR REPLACE INTO outlets VALUES (?,1)", (oid,))
            db.execute("UPDATE crawl_runs SET finished=1 WHERE outlet_id=?", (oid,))
            db.execute("INSERT OR REPLACE INTO settings VALUES (?, 'complete')", (inventory_key,))
    elif policy and outlet.get("collection_phase") == "watch" and progress["pages_scanned"] >= max_pages:
        with db:
            db.execute("UPDATE crawl_runs SET finished=1 WHERE outlet_id=?", (oid,))
    elif progress["failed_pages"]:
        # Retry failed pages on the next pass, without restarting successful pages.
        with db:
            db.execute("UPDATE frontier SET attempts=0 WHERE outlet_id=? AND status='failed'", (oid,))
    LOG.info("Outlet %s: pages=%s pending=%s failed=%s limited=%s complete=%s", oid,
             progress["pages_scanned"], progress["pending_pages"], progress["failed_pages"], progress["truncated"], progress["complete"])
    return not progress["failed_pages"] and not progress["truncated"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", default=os.environ.get("CT_ATLAS_API", "https://ct-report-generator.fairpeace.workers.dev"))
    parser.add_argument("--proxy", default=os.environ.get("TOR_SOCKS_PROXY", "socks5h://127.0.0.1:9050"))
    parser.add_argument("--connect-timeout", type=int, default=SOURCE_CONNECT_TIMEOUT,
                        help="Tor source connection timeout in seconds (10..300, default: 90)")
    parser.add_argument("--state", type=Path, default=Path("private-outlet-watch/state.sqlite"))
    parser.add_argument("--evidence", type=Path, default=Path("private-outlet-watch/evidence"))
    parser.add_argument("--interval", type=int, default=900)
    parser.add_argument("--max-file-mb", type=int, default=50)
    parser.add_argument("--acquire", action="store_true", help="Acquire new material links locally; no historical baseline downloads")
    parser.add_argument("--once", action="store_true", help="Run one resumable pass, not necessarily a complete outlet crawl")
    parser.add_argument("--upload-only", action="store_true", help="Synchronize existing local PDFs with Atlas without crawling Tor")
    parser.add_argument("--only-outlet", default="", help="Collect only this registered outlet ID or starting onion URL")
    parser.add_argument("--pages-per-scan", type=int, default=50)
    parser.add_argument("--max-pages", type=int, default=10000)
    parser.add_argument("--request-delay", type=float, default=1.0)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if not 10 <= args.connect_timeout <= 300:
        parser.error("Tor connection timeout must be between 10 and 300 seconds")
    if args.interval < 60 or not 1 <= args.max_file_mb <= 500:
        parser.error("Interval must be >=60 seconds and file cap between 1 and 500 MB")
    if not 1 <= args.pages_per_scan <= 1000 or not 1 <= args.max_pages <= 40000 or not 0 <= args.request_delay <= 60:
        parser.error("Pages per scan: 1..1000; max pages: 1..40000; delay: 0..60 seconds")
    try:
        proxy = safe_proxy(args.proxy)
        api, endpoint = api_session(args.api, os.environ.get("DARKWEB_INGEST_TOKEN", ""))
    except ValueError as exc:
        parser.error(str(exc))
    tor = requests.Session()
    tor.trust_env = False
    tor.source_connect_timeout = args.connect_timeout
    tor.proxies = {"http": proxy, "https": proxy}
    tor.headers.update({"User-Agent": "CTAtlas-OutletWatch/1", "Accept": "text/html,application/xhtml+xml"})
    db = open_database(args.state)
    try:
        while True:
            started = time.monotonic()
            failed = False
            backfill_pending = False
            try:
                config = api_call(api, endpoint, "/darkweb/collector-config")
                policy = config.get("policy")
                if not policy:
                    raise ValueError("Deploy the controlled collection Worker before updating this collector")
                apply_epoch(db, policy)
                if policy.get("paused"):
                    LOG.info("Collection paused by administrator")
                if not config.get("outlets"):
                    LOG.warning("No enabled outlets. Register starting URLs in CT Atlas OUTLETS first.")
                    failed = True
                if args.only_outlet and not any(args.only_outlet == o["id"] or onion_url(args.only_outlet) == onion_url(o["url"]) for o in config.get("outlets", [])):
                    LOG.error("The selected outlet is not registered and enabled in Atlas")
                    failed = True
                for outlet in ([] if policy.get("paused") else config.get("outlets", [])):
                    outlet = {**outlet, "policy": policy}
                    if args.only_outlet and args.only_outlet != outlet["id"] and onion_url(args.only_outlet) != onion_url(outlet["url"]):
                        continue
                    if not onion_url(outlet.get("url", "")):
                        continue
                    try:
                        if not args.upload_only and not scan_outlet(api, endpoint, tor, db, outlet, args.evidence, args.acquire, args.max_file_mb * 1048576, args.pages_per_scan, args.max_pages, args.request_delay):
                            failed = True
                        backfill_pending |= sync_pdf_files(api, endpoint, db, outlet, args.evidence, config.get("files_storage"))
                        phase = db.execute("SELECT value FROM settings WHERE key=?", ("publication-inventory-v1:"+outlet["id"],)).fetchone()
                        backfill_pending |= not args.upload_only and bool(phase and phase[0] != "complete")
                    except Exception:
                        failed = True
                        LOG.error("Scan not acknowledged for outlet %s; inventory retained for retry", outlet["id"])
            except Exception:
                failed = True
                LOG.error("Collector API unavailable or credentials rejected; retrying at next interval")
            if args.once:
                return 1 if failed else 0
            # Continue an initial inventory promptly; the configured interval is
            # the ongoing watch cadence after the archive traversal completes.
            interval = min(args.interval, 15) if backfill_pending and not failed else args.interval
            time.sleep(max(1, interval - (time.monotonic() - started)))
    except KeyboardInterrupt:
        return 0
    finally:
        db.close()
        tor.close()
        api.close()


if __name__ == "__main__":
    raise SystemExit(main())
