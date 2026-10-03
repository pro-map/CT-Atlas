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
from urllib.parse import urljoin, urlsplit, urlunsplit, parse_qsl
import re

import requests

LOG = logging.getLogger("outlet-watch")
MAX_HTML_BYTES = 2 * 1024 * 1024
MAX_ITEMS = 500
TYPES = {".pdf": "pdf", ".mp4": "video", ".webm": "video", ".mkv": "video", ".mov": "video",
         ".mp3": "audio", ".ogg": "audio", ".wav": "audio", ".m4a": "audio",
         ".jpg": "image", ".jpeg": "image", ".png": "image", ".webp": "image"}


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
    return row.get("type") in {"pdf", "video", "audio"} or (
        row.get("type") == "page" and row.get("selection_version") == 1)


def material_type(url, mime=""):
    mime = mime.split(";", 1)[0].lower().strip()
    for prefix, kind in MIME_TYPES.items():
        if mime == prefix or (prefix.endswith("/") and mime.startswith(prefix)):
            return kind
    return TYPES.get(Path(urlsplit(url).path).suffix.lower(), "page")


class ListingParser(HTMLParser):
    def __init__(self, base):
        super().__init__(convert_charrefs=True)
        self.base, self.host = base, urlsplit(base).hostname
        self.rows, self.parts, self.text_parts, self.title_parts = {}, [], [], []
        self.current, self.truncated, self.in_title, self.ignored = None, False, False, 0
        self.text_size = 0

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
        self.rows[target] = {"url": target, "title": " ".join(title.split())[:300] or urlsplit(target).path,
                             "type": kind or material_type(target), "source_page": self.base}
        return target

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.ignored += 1
        if self.ignored:
            return
        values = dict(attrs)
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
        if tag in ("script", "style") and self.ignored:
            self.ignored -= 1
        if tag == "title":
            self.in_title = False
        if tag == "a" and self.current:
            self.rows[self.current]["title"] = " ".join(" ".join(self.parts).split())[:300] or urlsplit(self.current).path
            self.current, self.parts = None, []


def source_get(session, url, host):
    """Validate every redirect *before* making another source request."""
    for _ in range(4):
        if not onion_url(url) or urlsplit(url).hostname != host:
            raise ValueError("Source redirect leaves the registered onion host")
        response = session.get(url, stream=True, allow_redirects=False, timeout=(30, 90))
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


def read_listing(session, outlet):
    response = source_get(session, outlet["url"], urlsplit(outlet["url"]).hostname)
    try:
        mime = response.headers.get("Content-Type", "").lower()
        kind = material_type(response.url, mime)
        if kind != "page":
            return {"items": [], "page": {"url": outlet["url"], "title": urlsplit(response.url).path,
                    "type": kind}, "text": "", "truncated": False}
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
        parser.feed(html)
        parser.close()
        selector = PublicationParser()
        selector.feed(html)
        selector.handle_endtag("html")
        selected = selector.selected_text()
        text = " ".join(" ".join(parser.text_parts).split())
        title = " ".join(" ".join(parser.title_parts).split())[:300] or urlsplit(response.url).path
        return {"items": list(parser.rows.values()), "page": {"url": outlet["url"], "title": title,
                "type": "page", "excerpt": selected[:600], "selection_version": 1 if selected else 0}, "text": text, "truncated": parser.truncated}
    finally:
        response.close()


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
        destination = evidence / (fingerprint + ".bin")
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
                               json=payload, timeout=(15, 60), allow_redirects=False)
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
    return db


def crawl_outlet(tor, db, outlet, pages_per_scan=100, max_pages=10000, request_delay=1.0):
    oid = outlet["id"]
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
        target = db.execute("SELECT url FROM frontier WHERE outlet_id=? AND status IN ('pending','failed') AND attempts<3 ORDER BY attempts,rowid LIMIT 1", (oid,)).fetchone()
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
        except Exception:
            with db:
                db.execute("UPDATE frontier SET status='failed',attempts=attempts+1 WHERE outlet_id=? AND url=?", (oid, url))
            LOG.warning("Internal page failed for outlet %s; queue retained", oid)
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
                if row["type"] == "page" and target_url != url:
                    db.execute("INSERT OR IGNORE INTO frontier(outlet_id,url) VALUES (?,?)", (oid, target_url))
                if not selected_material(row):
                    continue
                prior = db.execute("SELECT metadata,baseline FROM items WHERE outlet_id=? AND url=?", (oid, target_url)).fetchone()
                queued = db.execute("SELECT metadata,baseline FROM outbox WHERE outlet_id=? AND url=?", (oid, target_url)).fetchone()
                previous = json.loads((queued or prior)[0]) if queued or prior else {}
                # Preserve a fetched page's title/excerpt when a later navigation link points to it.
                merged = {**previous, **row}
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
    progress = crawl_outlet(tor, db, outlet, pages_per_scan, max_pages, request_delay)
    oid = outlet["id"]
    pending = db.execute("SELECT url,metadata,baseline FROM outbox WHERE outlet_id=? ORDER BY rowid", (oid,)).fetchall()
    batch, batch_size = [], 0

    def upload(rows, final):
        result = api_call(api, endpoint, "/darkweb/ingest", {"selection_version": 1, "outlet_id": oid, "items": [r for r, _ in rows],
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
        if not selected_material(row):
            with db:
                db.execute("DELETE FROM outbox WHERE outlet_id=? AND url=?", (oid, row["url"]))
            continue
        if acquire_files and not baseline and row["type"] != "page" and not row.get("acquired"):
            try:
                row.update(acquire(tor, row, evidence, max_bytes))
                # Retain the acquired metadata even if the subsequent upload fails.
                with db:
                    db.execute("UPDATE outbox SET metadata=? WHERE outlet_id=? AND url=?", (json.dumps(row), oid, row["url"]))
            except Exception:
                LOG.warning("Acquisition failed or exceeded cap for outlet %s", oid)
        encoded_size = len(json.dumps(row).encode("utf-8"))
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
    parser.add_argument("--state", type=Path, default=Path("private-outlet-watch/state.sqlite"))
    parser.add_argument("--evidence", type=Path, default=Path("private-outlet-watch/evidence"))
    parser.add_argument("--interval", type=int, default=900)
    parser.add_argument("--max-file-mb", type=int, default=50)
    parser.add_argument("--acquire", action="store_true", help="Acquire new material links locally; no historical baseline downloads")
    parser.add_argument("--once", action="store_true", help="Run one resumable pass, not necessarily a complete outlet crawl")
    parser.add_argument("--pages-per-scan", type=int, default=100)
    parser.add_argument("--max-pages", type=int, default=10000)
    parser.add_argument("--request-delay", type=float, default=1.0)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
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
    tor.proxies = {"http": proxy, "https": proxy}
    tor.headers.update({"User-Agent": "CTAtlas-OutletWatch/1", "Accept": "text/html,application/xhtml+xml"})
    db = open_database(args.state)
    try:
        while True:
            started = time.monotonic()
            failed = False
            try:
                config = api_call(api, endpoint, "/darkweb/collector-config")
                if not config.get("outlets"):
                    LOG.warning("No enabled outlets. Register starting URLs in CT Atlas OUTLETS first.")
                    failed = True
                for outlet in config.get("outlets", []):
                    if not onion_url(outlet.get("url", "")):
                        continue
                    try:
                        if not scan_outlet(api, endpoint, tor, db, outlet, args.evidence, args.acquire, args.max_file_mb * 1048576, args.pages_per_scan, args.max_pages, args.request_delay):
                            failed = True
                    except Exception:
                        failed = True
                        LOG.error("Scan not acknowledged for outlet %s; inventory retained for retry", outlet["id"])
            except Exception:
                failed = True
                LOG.error("Collector API unavailable or credentials rejected; retrying at next interval")
            if args.once:
                return 1 if failed else 0
            time.sleep(max(0, args.interval - (time.monotonic() - started)))
    except KeyboardInterrupt:
        return 0
    finally:
        db.close()
        tor.close()
        api.close()


if __name__ == "__main__":
    raise SystemExit(main())
