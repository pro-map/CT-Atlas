"""Curated CT Atlas outlet watch. All source traffic uses a local Tor SOCKS proxy.
No browser execution, arbitrary crawling, external redirect following or file serving.
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
from urllib.parse import urljoin, urlsplit, urlunsplit
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


class ListingParser(HTMLParser):
    def __init__(self, base):
        super().__init__(convert_charrefs=True)
        self.base = base
        self.host = urlsplit(base).hostname
        self.rows = {}
        self.current = None
        self.parts = []
        self.truncated = False

    def handle_starttag(self, tag, attrs):
        if tag != "a":
            return
        values = dict(attrs)
        target = onion_url(urljoin(self.base, values.get("href", "")))
        self.current = target if target and urlsplit(target).hostname == self.host and target != self.base else None
        self.parts = []

    def handle_data(self, data):
        if self.current and sum(len(p) for p in self.parts) < 1000:
            self.parts.append(data[:1000])

    def handle_endtag(self, tag):
        if tag != "a" or not self.current:
            return
        if len(self.rows) >= MAX_ITEMS and self.current not in self.rows:
            self.truncated = True
        else:
            title = " ".join(" ".join(self.parts).split())[:300] or urlsplit(self.current).path
            extension = Path(urlsplit(self.current).path).suffix.lower()
            self.rows[self.current] = {"url": self.current, "title": title, "type": TYPES.get(extension, "page")}
        self.current = None
        self.parts = []


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
        content_type = response.headers.get("Content-Type", "").lower()
        if content_type and "html" not in content_type:
            raise ValueError("Listing is not HTML")
        chunks, total = [], 0
        for chunk in response.iter_content(65536):
            total += len(chunk)
            if total > MAX_HTML_BYTES:
                raise ValueError("Listing exceeds HTML size limit")
            chunks.append(chunk)
        parser = ListingParser(response.url)
        parser.feed(b"".join(chunks).decode(response.encoding or "utf-8", errors="replace"))
        parser.close()
        return list(parser.rows.values()), parser.truncated
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
    return db


def scan_outlet(api, endpoint, tor, db, outlet, evidence, acquire_files, max_bytes):
    try:
        rows, truncated = read_listing(tor, outlet)
    except Exception:
        # Log a code/label, never exception strings with outlet URLs or secrets.
        LOG.warning("Listing collection failed for outlet %s", outlet["id"])
        api_call(api, endpoint, "/darkweb/ingest", {"outlet_id": outlet["id"], "items": [], "scan_ok": False, "scan_complete": True})
        return False
    local_initialized = bool(db.execute("SELECT initialized FROM outlets WHERE id=?", (outlet["id"],)).fetchone())
    metadata = []
    for source_row in rows:
        row = dict(source_row)
        prior = db.execute("SELECT metadata,baseline FROM items WHERE outlet_id=? AND url=?", (outlet["id"], row["url"])).fetchone()
        baseline = bool(prior[1]) if prior else not local_initialized
        previous = json.loads(prior[0]) if prior else {}
        row.update({k: previous[k] for k in ("sha256", "acquired", "bytes") if k in previous})
        if acquire_files and not baseline and row["type"] != "page" and not row.get("acquired"):
            try:
                row.update(acquire(tor, row, evidence, max_bytes))
            except Exception:
                LOG.warning("Acquisition failed or exceeded cap for outlet %s; will retry on a later scan", outlet["id"])
        metadata.append((row, baseline))
    # Empty successful listings must also update collector status.
    batches = [metadata[i:i + 100] for i in range(0, len(metadata), 100)] or [[]]
    for index, batch in enumerate(batches):
        result = api_call(api, endpoint, "/darkweb/ingest", {"outlet_id": outlet["id"], "items": [r for r, _ in batch],
            "scan_ok": True, "scan_complete": index == len(batches) - 1, "truncated": truncated})
        if result.get("ok") is not True:
            raise ValueError("Ingestion did not acknowledge the scan")
        # Only acknowledge locally after the server acknowledges ingestion.
        with db:
            for row, baseline in batch:
                db.execute("INSERT OR REPLACE INTO items VALUES (?,?,?,?)", (outlet["id"], row["url"], json.dumps(row), int(baseline)))
    if not truncated:
        with db:
            db.execute("INSERT OR REPLACE INTO outlets VALUES (?,1)", (outlet["id"],))
    LOG.info("Scan complete: outlet %s, %s links, truncated=%s", outlet["id"], len(rows), truncated)
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", default=os.environ.get("CT_ATLAS_API", "https://ct-report-generator.fairpeace.workers.dev"))
    parser.add_argument("--proxy", default=os.environ.get("TOR_SOCKS_PROXY", "socks5h://127.0.0.1:9050"))
    parser.add_argument("--state", type=Path, default=Path("private-outlet-watch/state.sqlite"))
    parser.add_argument("--evidence", type=Path, default=Path("private-outlet-watch/evidence"))
    parser.add_argument("--interval", type=int, default=900)
    parser.add_argument("--max-file-mb", type=int, default=50)
    parser.add_argument("--acquire", action="store_true", help="Acquire new material links locally; no historical baseline downloads")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if args.interval < 60 or not 1 <= args.max_file_mb <= 500:
        parser.error("Interval must be >=60 seconds and file cap between 1 and 500 MB")
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
                for outlet in config.get("outlets", []):
                    if not onion_url(outlet.get("url", "")):
                        continue
                    try:
                        if not scan_outlet(api, endpoint, tor, db, outlet, args.evidence, args.acquire, args.max_file_mb * 1048576):
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
