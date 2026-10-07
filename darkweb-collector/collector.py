"""Curated CT Atlas outlet watch. All source traffic uses a local Tor SOCKS proxy.
Resumable internal-page traversal; no browser execution or external-host crawling.
"""
import argparse
import codecs
import functools
import hashlib
import json
import logging
import os
import sqlite3
import tempfile
import time
import unicodedata
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit, parse_qsl, unquote, quote
import re
import base64
import io

import requests

LOG = logging.getLogger("outlet-watch")
MAX_HTML_BYTES = 2 * 1024 * 1024
MAX_ITEMS = 500
SOURCE_CONNECT_TIMEOUT = 90
TYPES = {".pdf": "pdf", ".mp4": "video", ".webm": "video", ".mkv": "video", ".mov": "video",
         ".mp3": "audio", ".ogg": "audio", ".wav": "audio", ".m4a": "audio",
         ".jpg": "image", ".jpeg": "image", ".png": "image", ".webp": "image"}
# Characters new URL() never percent-encodes in a path or query. Encoding all
# others gives an upper bound on the href length the Worker measures.
URL_SAFE = "/%:@!$&()*+,;=?"


def display_title(value):
    raw = str(value or "")
    try:
        value = unquote(raw, errors="strict")
    except UnicodeDecodeError:
        # Legacy sites percent-encode Windows-1252 names, e.g. d%E9claration.pdf.
        value = unquote(raw, encoding="cp1252", errors="replace")
    if value.startswith(("/", "http://", "https://")):
        value = urlsplit(value).path.rsplit("/", 1)[-1]
    return " ".join(value.replace("_", " ").split())[:300]


def legacy_display_title(value):
    """The previous display_title, kept for the Arabic outlet's template and its other pages."""
    value = unquote(str(value or ""))
    if value.startswith(("/", "http://", "https://")):
        value = urlsplit(value).path.rsplit("/", 1)[-1]
    return " ".join(value.replace("_", " ").split())[:300]


def fold_text(value):
    """Compare words without case or diacritics; Turkish dotted and dotless i both become i."""
    value = unicodedata.normalize("NFKD", str(value or "").replace("ı", "i").replace("İ", "i"))
    return "".join(ch for ch in value if not unicodedata.combining(ch)).casefold()


ARABIC_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")
# Folded month names (see fold_text), comma-separated per month. Polish and Czech
# are deliberately absent: their "listopad" is November, the Croatian one October.
MONTH_NAMES = {
    "en": ("january,jan", "february,feb", "march,mar", "april,apr", "may", "june,jun", "july,jul",
           "august,aug", "september,sept,sep", "october,oct", "november,nov", "december,dec"),
    "fr": ("janvier,janv", "fevrier,fevr,fev", "mars", "avril,avr", "mai", "juin", "juillet,juil",
           "aout", "septembre,sept", "octobre,oct", "novembre,nov", "decembre,dec"),
    "de": ("januar,janner,jan", "februar,feber,feb", "marz,maerz", "april,apr", "mai", "juni", "juli",
           "august,aug", "september,sept,sep", "oktober,okt", "november,nov", "dezember,dez"),
    "tr": ("ocak,oca", "subat,sub", "mart,mar", "nisan,nis", "mayis,may", "haziran,haz", "temmuz,tem",
           "agustos,agu", "eylul,eyl", "ekim,eki", "kasim,kas", "aralik,ara"),
    "bs": ("januar,januara", "februar,februara", "mart,marta", "april,aprila", "maj,maja", "juni,juna,jun",
           "juli,jula,jul", "august,augusta,avgust,avgusta,avg", "septembar,septembra", "oktobar,oktobra",
           "novembar,novembra", "decembar,decembra"),
    "hr": ("sijecanj,sijecnja", "veljaca,veljace", "ozujak,ozujka", "travanj,travnja", "svibanj,svibnja",
           "lipanj,lipnja", "srpanj,srpnja", "kolovoz,kolovoza", "rujan,rujna", "listopad,listopada",
           "studeni,studenoga,studenog", "prosinac,prosinca"),
    "sq": ("janar,janari,janarit", "shkurt,shkurti,shkurtit", "mars,marsi,marsit", "prill,prilli,prillit",
           "maj,maji,majit", "qershor,qershori,qershorit", "korrik,korriku,korrikut", "gusht,gushti,gushtit",
           "shtator,shtatori,shtatorit", "tetor,tetori,tetorit", "nentor,nentori,nentorit",
           "dhjetor,dhjetori,dhjetorit"),
    # Kurmanji; ezafe/oblique forms (Cotmeha, Cotmehê) are added below.
    "ku": ("kanuna pasin,cile", "sibat", "adar", "nisan", "gulan", "heziran", "tirmeh", "tebax", "ilon",
           "cotmeh", "mijdar", "kanuna pesin,berfanbar"),
    "id": ("januari", "februari", "maret,mac", "april", "mei", "juni", "juli,julai", "agustus,agt,agus,ogos",
           "september", "oktober,okt", "november", "desember,disember,des,dis"),
    "es": ("enero,ene", "febrero", "marzo", "abril,abr", "mayo", "junio", "julio", "agosto,ago",
           "septiembre,setiembre,set", "octubre", "noviembre", "diciembre,dic"),
    "it": ("gennaio,gen", "febbraio", "marzo", "aprile", "maggio,mag", "giugno,giu", "luglio,lug", "agosto,ago",
           "settembre,set", "ottobre,ott", "novembre", "dicembre,dic"),
    "pt": ("janeiro", "fevereiro,fev", "marco", "abril,abr", "maio", "junho", "julho", "agosto,ago",
           "setembro,set", "outubro,out", "novembro", "dezembro,dez"),
    "ar": ("يناير", "فبراير", "مارس", "ابريل", "مايو", "يونيو", "يوليو", "اغسطس", "سبتمبر", "اكتوبر", "نوفمبر", "ديسمبر"),
}
# Abbreviations that are ordinary words elsewhere are used only when the page
# language is unknown or is one that uses them as month names.
AMBIGUOUS_MONTHS = {"des": {"id", "ms"}, "dis": {"id", "ms"}, "mac": {"id", "ms"}, "out": {"pt"},
                    "set": {"es", "it", "pt", "ca", "gl"}, "ago": {"es", "it", "pt", "ca", "gl"},
                    "gen": {"it"}, "mag": {"it"}, "ara": {"tr"}, "tem": {"tr"}}
LISTOPAD_NOVEMBER = {"pl", "cs", "sk", "sl", "uk", "be", "ru", "hsb", "dsb", "szl", "csb", "rue"}


@functools.lru_cache(maxsize=64)
def date_patterns(lang=""):
    forms = {}
    for code, months in MONTH_NAMES.items():
        for number, names in enumerate(months, 1):
            for name in names.split(","):
                for form in (name, name + "a", name + "e") if code == "ku" else (name,):
                    if lang and lang not in AMBIGUOUS_MONTHS.get(form, {lang}):
                        continue
                    if lang in LISTOPAD_NOVEMBER and form.startswith("listopad"):
                        continue
                    forms.setdefault(form, number)
    month = "(?P<m>" + "|".join(r"\s+".join(map(re.escape, form.split())) for form in sorted(forms, key=len, reverse=True)) + ")"
    day = r"(?P<d>0?[1-9]|[12][0-9]|3[01])"
    year = r"(?P<y>20[0-9]{2})(?![0-9])"
    patterns = (
        re.compile(r"(?<![0-9])(?P<y>20[0-9]{2})[-/](?P<m>0?[1-9]|1[0-2])[-/](?P<d>0?[1-9]|[12][0-9]|3[01])(?![0-9])"),
        re.compile(r"(?<![0-9.])(?P<y>20[0-9]{2})\.(?P<m>0?[1-9]|1[0-2])\.(?P<d>0?[1-9]|[12][0-9]|3[01])(?![0-9])"),
        # 12. Oktober 2026, 1er octobre 2026, 12'ê Cotmehê 2026, 12 de octubre de 2026, Mon, 12 Oct 2026 10:00 +0000
        re.compile(r"(?<![0-9])" + day + r"(?:\.|\s?(?:er|st|nd|rd|th)|['’]?e|['’])?\s*(?:[-/]\s*)?(?:(?:de|del|di)\s+)?"
                   + month + r"(?![^\W\d_])\.?\s*[,،\-/]?\s*(?:(?:de|del)\s+)?" + year),
        # October 12, 2026 and Ekim 12, 2026
        re.compile(r"(?<![^\W\d_])" + month + r"(?![^\W\d_])\.?\s*(?:[-/]\s*)?" + day + r"(?:st|nd|rd|th)?(?![0-9])\s*,?\s*" + year),
        # 12.10.2026, 12.10.2026. and 12. 10. 2026.: always day-month-year
        re.compile(r"(?<![0-9])(?<![0-9]\.)" + day + r"\.\s?(?P<m>0?[1-9]|1[0-2])\.\s?" + year),
        # 12/10/2026 or 12-10-2026: day-month-year unless unambiguous otherwise
        re.compile(r"(?<![0-9])(?P<a>[0-9]{1,2})(?P<s>[/-])(?P<b>[0-9]{1,2})(?P=s)" + year),
    )
    return patterns, forms


def publication_date(value, lang=""):
    """Earliest complete, valid calendar date in a label, or "".

    Neither crawl time nor HTTP Last-Modified establishes the publication date,
    and relative labels ("2 gün önce", "2 days ago") stay undated.
    """
    text = fold_text(str(value or "").translate(ARABIC_DIGITS))
    lang = language_tag(lang)
    patterns, forms = date_patterns(lang)
    found = []
    for priority, pattern in enumerate(patterns):
        for match in pattern.finditer(text):
            parts = match.groupdict()
            if parts.get("a"):
                first, second = int(parts["a"]), int(parts["b"])
                if first > 12 >= second:
                    day, month = first, second
                elif second > 12 >= first:
                    month, day = first, second
                elif first <= 12 and second <= 12 and lang != "en":
                    day, month = first, second
                else:
                    continue
            else:
                name = " ".join(parts["m"].split())
                month = int(name) if name.isdigit() else forms[name]
                day = int(parts["d"])
            try:
                found.append((match.start(), priority, datetime(int(parts["y"]), month, day).date().isoformat()))
                break
            except ValueError:
                continue
    return min(found)[2] if found else ""


def legacy_publication_date(value):
    """The previous date rule, kept verbatim for the Arabic outlet's post-card/read-area
    template and its other pages: the first ISO date, then an Arabic day-month-year date.

    Its records are dated exactly as before, so no published_at (part of the Worker's
    content hash) changes and no stored translation is requeued.
    """
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


def machine_date(value, lang=""):
    """Date in a machine attribute (content/datetime/title), including compact 20261012."""
    value = str(value or "").strip()
    compact = re.fullmatch(r"(20[0-9]{2})(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])(?:T?[0-9]{4,6}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?)?", value)
    if compact:
        try:
            return datetime(*map(int, compact.groups())).date().isoformat()
        except ValueError:
            return ""
    return publication_date(value[:300], lang)


def url_publication_date(url):
    """A permalink date only: /YYYY/MM/DD/ path segments or a YYYY-MM-DD token in the path.

    Upload folders (/uploads/2026/10/1.pdf) record when a file was stored, not
    published, and are never dated from the URL.
    """
    path = unquote(urlsplit(str(url or "")).path)
    if re.search(r"/(?:uploads|wp-content)/", path.lower()):
        return ""
    match = re.search(r"/(20[0-9]{2})/(0[1-9]|1[0-2])/(0[1-9]|[12][0-9]|3[01])/", path) or re.search(
        r"(?<![0-9])(20[0-9]{2})([-_])(0?[1-9]|1[0-2])\2(0?[1-9]|[12][0-9]|3[01])(?![0-9])", path)
    if not match:
        return ""
    year, month, day = (match[1], match[2], match[3]) if match.re.groups == 3 else (match[1], match[3], match[4])
    try:
        return datetime(int(year), int(month), int(day)).date().isoformat()
    except ValueError:
        return ""


def language_tag(value):
    """Lowercase BCP-47 primary subtag (2-3 letters) of a lang, og:locale or Content-Language value."""
    for token in re.split(r"[\s,;]+", str(value or "")):
        primary = re.split(r"[-_]", token, maxsplit=1)[0].lower()
        if re.fullmatch(r"[a-z]{2,3}", primary) and primary not in {"und", "mul", "zxx", "mis"}:
            return primary
    return ""


NOT_CHARSETS = {"utf-7", "idna", "punycode", "raw-unicode-escape", "unicode-escape", "undefined", "mbcs", "oem"}
# Undeclared, non-UTF-8 pages: the legacy Windows code page of the declared <html lang>.
LEGACY_CHARSETS = {"tr": "cp1254", "az": "cp1254", "ku": "cp1254", "bs": "cp1250", "hr": "cp1250", "sr": "cp1250",
                   "sl": "cp1250", "cs": "cp1250", "sk": "cp1250", "pl": "cp1250", "hu": "cp1250", "ro": "cp1250"}


def charset_codec(label):
    try:
        info = codecs.lookup(str(label or "").strip().strip("\"'"))
    except LookupError:
        return ""
    if not getattr(info, "_is_text_encoding", True) or info.name in NOT_CHARSETS:
        return ""
    # As browsers do: Latin-1/ASCII labels mean Windows-1252, ISO-8859-9 means Windows-1254.
    return {"iso8859-1": "cp1252", "ascii": "cp1252", "iso8859-9": "cp1254"}.get(info.name, info.name)


def decode_html(data, content_type=""):
    """BOM, then the Content-Type charset, then <meta charset> in the first 4 KB, then strict UTF-8, then Windows-1252."""
    if data.startswith(codecs.BOM_UTF8):
        return data[3:].decode("utf-8", errors="replace")
    if data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        return data.decode("utf-16", errors="replace")
    head = data[:4096].decode("ascii", errors="replace")
    declared = re.search(r"charset\s*=\s*[\"']?([^\"';,\s]+)", content_type or "", re.I)
    candidates = [charset_codec(declared[1])] if declared else []
    meta = re.search(r"<meta\b[^>]*?charset\s*=\s*[\"']?\s*([^\"'>;\s/]+)", head, re.I)
    if meta:
        codec = charset_codec(meta[1])
        # HTML: a UTF-16 declaration inside the byte stream itself means UTF-8.
        candidates.append("utf-8" if codec.startswith("utf-16") else codec)
    for codec in candidates:
        if codec:
            try:
                return data.decode(codec, errors="replace")
            except (LookupError, UnicodeError):
                continue
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        pass
    text = data.decode("utf-8", errors="replace")
    damaged = text.count("�") - data.count("�".encode("utf-8"))
    valid = len(text) - len(text.encode("ascii", errors="ignore")) - text.count("�")
    if valid >= 8 and damaged * 4 <= valid:
        # Mostly valid UTF-8 with a few damaged sequences, as previously decoded.
        return text
    lang = re.search(r"<html\b[^>]*?\blang\s*=\s*[\"']?([A-Za-z]{2,3})(?![A-Za-z])", head, re.I)
    return data.decode(LEGACY_CHARSETS.get(lang[1].lower(), "cp1252") if lang else "cp1252", errors="replace")


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
            for table in ("outlets", "items", "crawl_runs", "frontier", "pages", "outbox", "undated", "preview_retries"):
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
        url = urlunsplit((parsed.scheme, parsed.netloc.lower(), parsed.path or "/", parsed.query, ""))
        # The Worker refuses hrefs over 2000 characters after percent-encoding.
        return url if len(quote(url, safe=URL_SAFE)) <= 2000 else ""
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
    TEXT = {"p", "article", "main", "blockquote", "div", "td", "section"}
    # HTML5 implied end tags: a new element closes an open one of the same kind
    # unless one of these scope boundaries lies between them.
    IMPLIED = {"p": {"button", "table", "td", "th", "caption", "object", "template"}, "li": {"ul", "ol", "menu", "table", "td", "th"},
               "td": {"table", "tr"}, "tr": {"table"}, "option": {"select", "datalist", "optgroup"}}
    MAX_DEPTH = 256

    def __init__(self):
        super().__init__(convert_charrefs=True)
        # Each text node is stored once; an open frame covers parts[start:].
        self.stack, self.parts, self.best, self.paragraphs = [], [], "", {}
        # Elements nested beyond MAX_DEPTH are flattened into the innermost frame.
        self.deep, self.deep_omit = {}, {}

    def handle_starttag(self, tag, attrs):
        if tag in self.VOID:
            return
        values = dict(attrs)
        marker = " ".join(values.get(k, "") for k in ("id", "class", "itemprop"))
        tokens = set(re.split(r"[^\w]+", marker.lower()))
        excluded = bool(tokens & {"menu", "navigation", "breadcrumb", "breadcrumbs", "pagination", "sidebar"})
        omitted = tag in self.OMIT or excluded or values.get("role") == "navigation" or "hidden" in values or values.get("aria-hidden") == "true"
        comment = bool(tokens & {"comment", "comments", "reply", "replies", "commentbody", "usercomment"})
        if tag in self.IMPLIED:
            for i in range(len(self.stack)-1, -1, -1):
                if self.stack[i]["tag"] == tag:
                    self.close_frames(i)
                    break
                if self.stack[i]["tag"] in self.IMPLIED[tag]:
                    break
        if len(self.stack) >= self.MAX_DEPTH:
            self.deep[tag] = self.deep.get(tag, 0) + 1
            if omitted:
                self.deep_omit[tag] = self.deep_omit.get(tag, 0) + 1
            return
        parent = self.stack[-1] if self.stack else {"omit": False, "comment": False, "link": False}
        self.stack.append({"tag": tag, "omit": omitted or parent["omit"], "comment": comment or parent["comment"],
                           "link": tag == "a" or parent["link"], "start": len(self.parts)})

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID:
            self.handle_endtag(tag)

    def handle_data(self, data):
        if not self.stack or self.stack[-1]["omit"] or any(self.deep_omit.values()):
            return
        self.parts.append((data, self.stack[-1]["link"] or bool(self.deep.get("a"))))

    def handle_endtag(self, tag):
        if self.deep.get(tag):
            self.deep[tag] -= 1
            if self.deep_omit.get(tag):
                self.deep_omit[tag] -= 1
            return
        index = next((i for i in range(len(self.stack)-1, -1, -1) if self.stack[i]["tag"] == tag), None)
        if index is not None:
            self.close_frames(index)

    def close_frames(self, index):
        for frame in self.stack[index:]:
            if frame["tag"] in self.TEXT and not frame["omit"]:
                segment = self.parts[frame["start"]:]
                raw = " ".join(data for data, _ in segment)
                text = " ".join(raw.split())
                if text and sum(len(data) for data, linked in segment if linked) / max(len(raw), 1) < 0.25:
                    self.keep(text, frame["comment"], frame["tag"])
        del self.stack[index:]
        self.deep, self.deep_omit = {}, {}
        if not self.stack:
            self.parts = []

    def keep(self, text, comment, tag):
        # Retain only what selected_text can return: the first longest candidate and long paragraphs.
        if ((comment and len(text) >= 80) or (len(text) >= 1200 and tag in {"p", "article", "blockquote", "div", "td"})) and len(text) > len(self.best):
            self.best = text
        if tag == "p" and len(text) >= 120:
            self.paragraphs.setdefault(text, None)

    def selected_text(self):
        # A short explicit comment is eligible; a normal text needs real body length.
        # Prefer paragraphs to avoid concatenating an entire homepage into an article.
        candidates = [self.best] if self.best else []
        if sum(map(len, self.paragraphs)) >= 1200:
            candidates.append("\n\n".join(self.paragraphs))
        if not candidates:
            return ""
        return max(candidates, key=len)[:100000]


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
        # Valueless attributes (<time pubdate>, <div class>) are empty strings, never None.
        node = {"tag": tag, "attrs": {key: value or "" for key, value in attrs}, "children": []}
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


def page_language(tree, header=""):
    """source_language: <html lang>, then og:locale, then the Content-Language header."""
    html = next((n for n in descendants(tree.root) if n["tag"] == "html"), None)
    language = language_tag(html["attrs"].get("lang") or html["attrs"].get("xml:lang")) if html else ""
    if not language:
        locale = next((n["attrs"].get("content") for n in descendants(tree.root) if n["tag"] == "meta"
                       and (n["attrs"].get("property") or "").lower() == "og:locale"), "")
        language = language_tag(locale)
    return language or language_tag(header)


def publication_record(url, title, text, date_raw, complete=False, attachments=None, preview="", category=None, kind=None, language="", legacy=False):
    """A publication_version 1 record: structured cards and details, and generic article pages.

    legacy: the Arabic outlet's template, dated with the previous rule (legacy_publication_date).
    """
    if category is None:
        category = urlsplit(url).path.split("/")[2] if re.match(r"/posts/[^/]+/[^/]+/?$", urlsplit(url).path) else "publication"
    full = text or title
    clipped = full.encode("utf-8")[:48000].decode("utf-8", errors="ignore")
    if kind is None:
        kind = {"naba": "pdf", "videos": "video", "audios": "audio"}.get(category, "page")
    row = {"url": url, "title": title[:2000], "type": kind, "category": category,
           "original_text": clipped, "excerpt": full[:600], "source_date": date_raw[:150],
           "published_at": legacy_publication_date(date_raw) if legacy else publication_date(date_raw, language),
           "date_basis": "html", "source_page": url,
           "publication_version": 1, "text_status": "truncated" if clipped != full or len(title) > 2000 else "complete" if complete else "listing",
           "attachments": attachments or [], "preview_url": preview, "crawl": not complete}
    if language:
        row["source_language"] = language
    return row


def content_attachments(content, local, name=display_title):
    """PDF, video, audio and image files referenced inside a publication's content container.

    name: how a file without link text is titled (legacy_display_title for the Arabic template).
    """
    attachments = {}
    for n in descendants(content):
        attrs = n["attrs"]
        for key in ("href", "src", "data", "data-url", "data-pdf", "data-src"):
            target = local(attrs.get(key))
            if not target:
                continue
            kind = material_type(target, attrs.get("type", ""))
            if kind in {"pdf", "video", "audio", "image"}:
                attachments[target] = {"url": target, "type": kind, "title": original_text(n)[:300] or name(target)}
        # PDF.js viewers commonly carry the original URL in a file= query parameter.
        for key in ("src", "href"):
            for param, value in parse_qsl(urlsplit(attrs.get(key, "")).query):
                target = local(value) if param == "file" else ""
                if target and material_type(target) == "pdf":
                    attachments[target] = {"url": target, "type": "pdf", "title": name(target)}
    return attachments


def structured_publications(html, base, language=None, tree=None, since=""):
    """One record per card/permalink; attachment links never become separate publications.

    Host addresses and source material are runtime input, not embedded in the code.
    Return None for other templates so their existing collection rules remain intact.
    The Arabic outlet's post-card/read-area records keep their previous dates and
    titles (legacy_publication_date, legacy_display_title); a read-area page without
    post-content returns None and keeps the previous generic reading (read_listing).
    """
    if tree is None:
        tree = PublicationTree()
        tree.feed(html)
    if language is None:
        language = page_language(tree)
    nodes = list(descendants(tree.root))
    host = urlsplit(base).hostname
    def local(value):
        url = onion_url(urljoin(base, value or ""))
        return url if value and url and urlsplit(url).hostname == host else ""
    def first(parent, cls):
        return next((n for n in descendants(parent) if has_class(n, cls)), None)
    def record(url, title, text, date_raw, complete=False, attachments=None, preview=""):
        return publication_record(url, title, text, date_raw, complete, attachments, preview, language=language, legacy=True)
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
            date_node = next((n for n in descendants(footer or tree.root) if n["tag"] in {"span", "time"} and legacy_publication_date(original_text(n))), None) if footer else None
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
    if area is not None and content is None:
        return None
    if area is None:
        return news_portal_publications(nodes, base, language, since)
    title = original_text(first(area, "title"))
    if not title:
        return {"items": [], "page": None, "text": "", "truncated": True, "structured": True}
    date_raw = original_text(first(area, "author-profile"))
    meta = {n["attrs"].get("property"): n["attrs"].get("content", "") for n in nodes if n["tag"] == "meta"}
    published = legacy_publication_date(meta.get("article:published_time")) or legacy_publication_date(date_raw)
    # The requested permalink is the record identity. Do not trust a conflicting og:url.
    attachments = content_attachments(content, local, legacy_display_title)
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


# The news-portal template of the second outlet: a multilingual site whose own
# language menu serves English, Arabic, Russian and French versions. Its home page
# lists news in two sections, each paginated by its own query key, and each article
# page (article.blog-post) shows its date next to a calendar icon. Only news is
# collected there: the template returns no other link (videos, audio, comments,
# profiles). Permalinks are single-segment /posts/<slug> paths; most, such as
# /posts/region-06-10-2026-2, also carry the category and the day-month-year date.
NEWS_PORTAL_SECTIONS = (("news-content", "news-pagination", "news_page"),
                        ("priority-news-content", "priority-news-pagination", "priority_news_page"))
NEWS_PORTAL_SLUG = re.compile(r"^/posts/([a-z0-9]+(?:-[a-z0-9]+)*?)-([0-3]?[0-9])-([01]?[0-9])-(20[0-9]{2})(?:-[0-9]+)?/?$")
# Any single-segment permalink, percent-encoded slugs included (recognised template only).
NEWS_PORTAL_POST = re.compile(r"^/posts/[^/]+/?$")
NEWS_PORTAL_CATEGORIES = {"an-naba": ("naba", "pdf")}
# The outlet's own language menu link (a plain GET, as a reader choosing English does).
NEWS_PORTAL_ENGLISH = "/language/change?locale=en&auto_translate=true&force_translate=false"
# Some deployments expose the English tab but keep article text in the source language
# unless translation is explicitly forced. Try this only when the normal English switch
# succeeds but the reread still does not produce English publication records.
NEWS_PORTAL_ENGLISH_FORCE = "/language/change?locale=en&auto_translate=true&force_translate=true"
NEWS_PORTAL_SKIP = {"related-posts", "comments-section", "thumbnail-wrapper", "breadcrumb"}
# The pdf.js viewer names its file only in an inline script: const pdfUrl = "...";
NEWS_PORTAL_PDF_URL = re.compile(r"""\b(?:const|let|var)\s+pdfUrl\s*=\s*(?:"((?:[^"\\\r\n]|\\.)*)"|'((?:[^'\\\r\n]|\\.)*)')""")


def news_portal_slug(url):
    """Category and day-month-year date of a news permalink, or ("", "")."""
    match = NEWS_PORTAL_SLUG.match(urlsplit(url).path)
    if not match:
        return "", ""
    try:
        return match[1], datetime(int(match[4]), int(match[3]), int(match[2])).date().isoformat()
    except ValueError:
        return match[1], ""


def preline_text(node):
    """Text of a white-space: pre-line article body: its line breaks are paragraph breaks."""
    parts, stack = [], [node]
    while stack:
        current = stack.pop()
        if current is None or isinstance(current, str):
            parts.append("\n" if current is None else current)
        elif current["tag"] not in {"script", "style", "svg", "noscript", "template", "button", "canvas"}:
            block = current["tag"] in {"p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote"}
            if block:
                parts.append("\n")
            stack.extend([None] if block else [])
            stack.extend(reversed(current["children"]))
    lines = (" ".join(line.split()) for line in "".join(parts).splitlines())
    return "\n\n".join(line for line in lines if line)


def js_string(value):
    """Value of a JavaScript string literal body (\\/, \\uXXXX and \\xXX escapes)."""
    return re.sub(r"\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(.))",
                  lambda m: chr(int(m[1] or m[2], 16)) if m[1] or m[2] else m[3], value)


def file_title(url):
    """A file's name; media.php?file=posts/files/x.pdf names it in the query."""
    name = dict(parse_qsl(urlsplit(url).query)).get("file", "")
    return display_title("/" + name.lstrip("/")) if name else display_title(url)


def news_portal_publications(nodes, base, language, since=""):
    """Listing cards and article records of the news-portal template, or None for other pages.

    The template is recognised by its language menu (.language-option[data-lang])
    together with the auto-translate switch, the article (article.blog-post) or a news
    section. A recognised page never falls back to the generic reader: an article
    without a body gives a title-only record, and any other page of the site (empty
    sections, a soft "not found", a profile or video page) gives no record and no link.
    """
    host = urlsplit(base).hostname
    root = urlunsplit((urlsplit(base).scheme, urlsplit(base).netloc, "/", "", ""))
    def local(value):
        url = onion_url(urljoin(base, value or ""))
        return url if value and url and urlsplit(url).hostname == host else ""
    menu = {n["attrs"]["data-lang"] for n in nodes if has_class(n, "language-option") and n["attrs"].get("data-lang")}
    article = next((n for n in nodes if n["tag"] == "article" and has_class(n, "blog-post")), None)
    sections = [(next((n for n in nodes if n["attrs"].get("id") == section_id), None), pager_id, key)
                for section_id, pager_id, key in NEWS_PORTAL_SECTIONS]
    switch = any(n["attrs"].get("id") == "autoTranslateCheckbox" for n in nodes)
    template = bool(menu) and (switch or article is not None or any(section is not None for section, _, _ in sections))
    english = language != "en" and "en" in menu
    nothing = {"items": [], "page": None, "text": "", "truncated": False, "structured": True, "english_available": english}
    def post_link(value):
        url = local(value)
        if not url:
            return ""
        if template:
            return url if NEWS_PORTAL_POST.match(urlsplit(url).path) and not urlsplit(url).query else ""
        return url if NEWS_PORTAL_SLUG.match(urlsplit(url).path) else ""
    def news_row(url, title, text, label, complete, attachments=None, preview=""):
        # The slug's category and date are used only when the permalink has the dated form.
        category, slug_date = news_portal_slug(url)
        category, kind = NEWS_PORTAL_CATEGORIES.get(category, ("news", "page"))
        row = publication_record(url, title, text, label, complete, attachments, preview, category=category, kind=kind, language=language)
        if not row["published_at"] and slug_date:
            row["published_at"], row["date_basis"] = slug_date, "url"
        if row.get("source_language") == "en":
            # The outlet's own (possibly automatic) translation of its Arabic originals.
            row["source_translation"] = "outlet"
        return row

    if article is not None:
        content = next((n for n in descendants(article) if has_class(n, "post-content")), None)
        heading = next((n for n in descendants(article) if n["tag"] == "h1"), None)
        header = next((n for n in descendants(article) if n["tag"] == "header"), None)
        calendar = header is not None and any(n["tag"] == "i" and has_class(n, "fa-calendar") for n in descendants(header))
        if not template and (content is None or heading is None or not calendar):
            return None
        title = original_text(heading) if heading is not None else ""
        if not title:
            return nothing
        # The date is the header text next to the calendar icon ("06 October 2026").
        label = next((original_text(n) for n in descendants(header or article) if n["tag"] in {"span", "small", "time"}
                      and any(c["tag"] == "i" and has_class(c, "fa-calendar") for c in descendants(n))), "")
        # Files of the article: its body, players, PDF viewer and archive download;
        # never related posts, comments, the breadcrumb or the cover image.
        files, cover, stack = {}, "", list(article["children"])
        while stack:
            n = stack.pop()
            if not isinstance(n, dict) or n["tag"] in {"script", "style", "nav"}:
                continue
            classes = set(n["attrs"].get("class", "").split()) | {n["attrs"].get("id", "")}
            if classes & {"thumbnail-wrapper"} and not cover:
                cover = next((local(c["attrs"].get("src")) for c in descendants(n) if c["tag"] == "img" and local(c["attrs"].get("src"))), "")
            if classes & NEWS_PORTAL_SKIP or n is header:
                continue
            for key in ("href", "src", "data", "data-url", "data-src", "data-file"):
                target = local(n["attrs"].get(key))
                if not target:
                    continue
                kind = material_type(target, n["attrs"].get("type", ""))
                if kind == "page":
                    # media.php?file=posts/files/x.pdf names its file in the query.
                    name = dict(parse_qsl(urlsplit(target).query)).get("file", "")
                    kind = material_type("/" + name.lstrip("/")) if name else "page"
                if kind in {"pdf", "video", "audio", "image"}:
                    files[target] = {"url": target, "type": kind, "title": original_text(n)[:300] or file_title(target)}
            stack.extend(n["children"])
        if not any(file["type"] == "pdf" for file in files.values()):
            # The pdf.js viewer (#pdf-viewer with #pdf-prev, #pdf-next and #pdf-zoom controls)
            # carries no URL: its file is the inline script's pdfUrl constant. Script text is
            # kept as the script node's children (descendants() does not enter scripts).
            scripts = ("".join(c for c in n["children"] if isinstance(c, str)) for n in nodes if n["tag"] == "script")
            values = (js_string(m[1] if m[1] is not None else m[2]) for text in scripts for m in NEWS_PORTAL_PDF_URL.finditer(text))
            target = next((url for url in (local(value.strip()) for value in values) if url), "")
            if target:
                # The page's own scheme: the site answers on it (one script line uses https).
                target = urlunsplit((urlsplit(base).scheme,) + tuple(urlsplit(target))[1:])
                files = {target: {"url": target, "type": "pdf", "title": file_title(target)}, **files}
        body = preline_text(content) if content is not None else ""
        full = title + ("\n\n" + body if body and body != title else "")
        row = news_row(base, title, full, label, True, list(files.values())[:12], cover)
        if len(files) > 12:
            row["attachments_truncated"] = True
        return {"items": [], "page": row, "text": full, "truncated": False, "structured": True, "english_available": english}

    rows, found = {}, False
    for section, pager_id, key in sections:
        if section is None:
            continue
        dates = []
        for card in descendants(section):
            if not (card["tag"] == "li" or has_class(card, "list-group-item") or has_class(card, "card")):
                continue
            links = [post_link(n["attrs"].get("href")) for n in descendants(card) if n["tag"] == "a"]
            url = next((link for link in links if link), "")
            if not url or url in rows:
                continue
            heading = next((n for n in descendants(card) if n["tag"] in HEADINGS), None)
            title = original_text(heading) if heading else max(
                (original_text(n) for n in descendants(card) if n["tag"] == "a" and post_link(n["attrs"].get("href")) == url), key=len, default="")
            label = next((original_text(n) for n in descendants(card) if n["tag"] in {"small", "span", "time"}
                          and not has_class(n, "badge") and publication_date(original_text(n), language)), "")
            if not title:
                continue
            row = news_row(url, title, title, label, False)
            dates.append(row["published_at"])
            found = True
            # Cards older than the collection period are neither stored nor opened.
            if not (since and row["published_at"] and row["published_at"] < since):
                rows[url] = row
        # Follow this section's next page only, until a page is empty or entirely older
        # than the period: never its last page or other numbered pages.
        if not dates or (since and all(date and date < since for date in dates)):
            continue
        current = dict(parse_qsl(urlsplit(base).query)).get(key, "")
        following = (max(int(current), 1) if current.isdigit() else 1) + 1
        pager = next((n for n in nodes if n["attrs"].get("id") == pager_id), None)
        for link in (n for n in descendants(pager) if n["tag"] == "a") if pager is not None else ():
            target = local(link["attrs"].get("href"))
            number = dict(parse_qsl(urlsplit(target).query)).get(key, "") if target else ""
            if number.isdigit() and int(number) == following:
                page_url = root + "?" + key + "=" + str(following)
                rows.setdefault(page_url, {"url": page_url, "type": "page", "title": "Listing page", "crawl": True})
                break
    if not found:
        return nothing if template else None
    return {"items": list(rows.values()), "page": None, "text": "", "truncated": False, "structured": True, "english_available": english}


ARTICLE_TYPES = {"blogposting", "report", "socialmediaposting", "liveblogposting"}
CONTENT_CLASSES = {"entry-content", "post-content", "post-body", "article-content", "article-body"}
# Site chrome around an article: never a source of its date or text.
CHROME_WORDS = {"sidebar", "widget", "widgets", "comment", "comments", "commentlist", "menu", "navigation",
                "breadcrumb", "breadcrumbs", "pagination", "related", "relatedposts", "masthead", "colophon"}
PRUNE_WORDS = CHROME_WORDS | {"share", "sharing", "sharedaddy", "social"}
DATE_LABEL_CLASSES = {"date", "posted-on", "entry-date", "published", "post-date", "meta-date", "byline"}
MODIFIED_WORDS = {"updated", "modified"}
META_DATE_NAMES = ("article:published_time", "datepublished", "date", "pubdate", "publishdate", "publish-date", "publish_date",
                   "dc.date", "dc.date.issued", "dcterms.created", "dcterms.date", "parsely-pub-date", "sailthru.date")
HEADINGS = {"h1", "h2", "h3", "h4", "h5", "h6"}
LISTING_BODY = {"archive", "category", "tag", "search", "blog", "feed-view", "error404"}
SINGLE_BODY = {"single", "single-post", "item-view"}
# Logout and delete paths in the source languages, compared after fold_text. Not
# "dil": Albanian logout, but Turkish "language".
ACTION_WORDS = {"logout", "signout", "delete", "remove", "unsubscribe", "ban", "cikis", "oturumu-kapat", "sil",
                "odjava", "obrisi", "izbrisi", "abmelden", "loeschen", "loschen", "deconnexion", "supprimer", "fshij",
                "keluar", "hapus", "padam", "derketin", "jebirin"}
SCRIPT_SUFFIXES = {".php", ".asp", ".aspx", ".jsp", ".cgi", ".pl", ".do", ".html", ".htm"}
CMS_SEGMENTS = {"wp-login.php", "wp-admin", "xmlrpc.php", "wp-json", "feed", "feeds", "trackback"}
SKIP_QUERY_KEYS = {"replytocom", "share", "like_comment", "amp", "print", "showcomment"}


def skipped_link(parsed):
    """Account, moderation and CMS plumbing links (feeds, logins, reply forms, share and print views)."""
    segments = [fold_text(unquote(part)) for part in parsed.path.split("/") if part]
    for segment in segments:
        stem, suffix = os.path.splitext(segment)
        if segment in ACTION_WORDS or segment in CMS_SEGMENTS or (suffix in SCRIPT_SUFFIXES and stem in ACTION_WORDS):
            return True
    if segments and segments[-1] == "amp":
        return True
    return any(fold_text(key) in SKIP_QUERY_KEYS or (fold_text(key) in {"action", "do", "act"} and fold_text(value) in ACTION_WORDS)
               for key, value in parse_qsl(parsed.query, keep_blank_values=True))


def marker_words(attrs):
    """id/class words, ignoring layout modifiers such as has-sidebar or right-sidebar."""
    words = set()
    for token in ((attrs.get("id") or "") + " " + (attrs.get("class") or "")).lower().split():
        if re.match(r"(?:has|no|with|without|is|layout|template|theme)[-_]", token) or re.search(
                r"(?:^|[-_])(?:left|right|both|full|no|with)[-_]sidebars?$|^sidebars?[-_](?:left|right|both|none)$|^(?:content-sidebar|sidebar-content)$", token):
            continue
        words.update(re.split(r"[^\w]+", token))
    words.discard("")
    return words


def article_type(value):
    for item in value if isinstance(value, list) else [value]:
        name = str(item or "").rstrip("/").rsplit("/", 1)[-1].rsplit(":", 1)[-1].lower()
        if name.endswith("article") or name in ARTICLE_TYPES:
            return True
    return False


def ld_entries(text):
    """Flattened JSON-LD objects (top level and @graph), bounded."""
    if len(text) > 200000:
        return []
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return []
    queue, entries = list(data[:100] if isinstance(data, list) else [data]), []
    for entry in queue:
        if len(entries) >= 200:
            break
        if isinstance(entry, dict):
            entries.append(entry)
            if isinstance(entry.get("@graph"), list) and len(queue) < 400:
                queue.extend(entry["@graph"][:100])
    return entries


def modified_marker(attrs):
    marker = ((attrs.get("id") or "") + " " + (attrs.get("class") or "") + " " + (attrs.get("itemprop") or "")).lower()
    return ("updat" in marker or "modif" in marker) and bool(
        marker_words(attrs) & MODIFIED_WORDS or "datemodified" in (attrs.get("itemprop") or "").lower().split())


def node_text(node, limit=2000):
    """Visible text of an element, leaving out updated/modified dates inside it.

    Bounded, so malformed pages (unclosed headings nesting the whole page) stay linear.
    """
    parts, stack, size, visited = [], [node], 0, 0
    while stack and size < limit and visited < 5 * limit:
        current = stack.pop()
        visited += 1
        if isinstance(current, str):
            parts.append(current)
            size += len(current)
        elif current["tag"] not in {"script", "style", "svg", "noscript", "template"} and (current is node or not modified_marker(current["attrs"])):
            stack.extend(reversed(current["children"]))
    return " ".join(" ".join(parts).split())[:limit]


def prune_chrome(node, whole=False):
    """Copy of a content subtree without comments, sharing, related posts, forms or navigation."""
    def dropped(child):
        attrs = child["attrs"]
        if child["tag"] in {"nav", "aside", "form", "button", "select"} or "hidden" in attrs or attrs.get("aria-hidden") == "true":
            return True
        # A whole <article> used as the container: its header carries the title and byline.
        return (whole and child["tag"] in {"header", "footer"}) or bool(marker_words(attrs) & PRUNE_WORDS)
    copy = {"tag": node["tag"], "attrs": node["attrs"], "children": []}
    stack = [(node, copy)]
    while stack:
        source, target = stack.pop()
        for child in source["children"]:
            if isinstance(child, str):
                target["children"].append(child)
            elif not dropped(child):
                clone = {"tag": child["tag"], "attrs": child["attrs"], "children": []}
                target["children"].append(clone)
                stack.append((child, clone))
    return copy


def strip_site_suffix(title, site=""):
    title = " ".join(str(title or "").split())
    separators = (" | ", " – ", " — ", " - ", " :: ", " · ")
    if site:
        for separator in separators:
            if title.casefold().endswith((separator + site).casefold()) and len(title) > len(separator + site):
                return title[:-len(separator + site)].strip()
        return title
    for separator in separators:
        head, found, tail = title.rpartition(separator)
        if found and head.strip() and len(tail) <= 80:
            return head.strip()
    return title


def page_outline(tree, page_url, language=""):
    """Read a non-structured page: site chrome, article units, the content container and ranked dates.

    Element flags are inherited down the tree. An element that contains an article
    unit or content container is never treated as chrome, so a layout class such as
    "sidebar" on a page wrapper cannot hide the article itself.
    """
    host = urlsplit(page_url).hostname
    own_path = unquote(urlsplit(page_url).path).rstrip("/")
    flat, stack = [], [(tree.root, -1)]
    while stack:
        node, parent = stack.pop()
        attrs, tag = node["attrs"], node["tag"]
        classes = set((attrs.get("class") or "").lower().split())
        words = marker_words(attrs)
        itemprop = set((attrs.get("itemprop") or "").lower().split())
        role = (attrs.get("role") or "").lower()
        chrome = tag not in {"root", "html", "body", "main"} and (
            tag in {"aside", "nav"} or role in {"complementary", "navigation", "search"} or bool(words & CHROME_WORDS))
        unit = not chrome and (tag == "article" or "hentry" in classes or "blogpost" in itemprop
                               or article_type((attrs.get("itemtype") or "").split()))
        content = not chrome and ("articlebody" in itemprop or bool(classes & CONTENT_CLASSES))
        flat.append({"node": node, "parent": parent, "tag": tag, "attrs": attrs, "classes": classes, "words": words,
                     "itemprop": itemprop, "role": role, "chrome": chrome, "unit_marker": unit,
                     "content_marker": content, "core": unit or content})
        if tag not in {"script", "style", "svg", "noscript", "template"}:
            stack.extend((child, len(flat) - 1) for child in reversed(node["children"]) if isinstance(child, dict))
    for entry in reversed(flat):
        if entry["core"] and entry["parent"] >= 0:
            flat[entry["parent"]]["core"] = True
    top = {"unit": None, "main": False, "excluded": False, "modified": False, "heading": False, "content": False, "label": False}
    units, contents, labels, marked, times, headings, rel_links, ld = [], [], [], [], [], [], [], []
    meta_dates, og, title_text, has_main = {}, {}, "", False
    for index, e in enumerate(flat):
        p = flat[e["parent"]] if e["parent"] >= 0 else top
        node, attrs, tag = e["node"], e["attrs"], e["tag"]
        if e["unit_marker"] and p["unit"] is None:
            units.append({"entry": index, "card": False})
            e["unit"] = len(units) - 1
        else:
            e["unit"] = p["unit"]
        e["main"] = p["main"] or tag == "main" or e["role"] == "main"
        has_main |= e["main"]
        frame = (tag in {"header", "footer"} or e["role"] in {"banner", "contentinfo"}) and e["unit"] is None
        e["excluded"] = p["excluded"] or (not e["core"] and (e["chrome"] or frame))
        e["modified"] = p["modified"] or (not e["core"] and bool(e["words"] & MODIFIED_WORDS or "datemodified" in e["itemprop"]))
        e["content"] = p["content"] or e["content_marker"]
        e["label"] = p["label"]
        if e["content_marker"] and not p["content"]:
            contents.append(index)
        e["heading"] = p["heading"] or tag in HEADINGS or bool(e["classes"] & {"entry-title", "post-title"})
        e["title_of"] = p.get("title_of")
        if e["heading"] and not p["heading"] and e["unit"] is not None and not e["content"] and "title" not in units[e["unit"]]:
            # The first heading of a unit, outside its body, is its title.
            units[e["unit"]]["title"] = index
            e["title_of"] = e["unit"]
        if tag == "title" and not title_text:
            title_text = node_text(node)
        if tag == "script":
            if (attrs.get("type") or "").strip().lower() == "application/ld+json":
                ld.extend(ld_entries("".join(c for c in node["children"] if isinstance(c, str))))
            continue
        if e["excluded"]:
            continue
        if tag == "meta":
            name = (attrs.get("property") or attrs.get("name") or "").strip().lower()
            if name.startswith("og:"):
                og.setdefault(name, attrs.get("content") or "")
            if name in META_DATE_NAMES and not meta_dates.get(name):
                meta_dates[name] = machine_date(attrs.get("content"), language)
            if "datepublished" in e["itemprop"] and not e["modified"]:
                marked.append((attrs.get("content"), e))
            continue
        # Texts are read lazily (only for the chosen candidates) to keep large pages fast.
        if not e["modified"]:
            value = ""
            if "datepublished" in e["itemprop"]:
                value = attrs.get("content") or attrs.get("datetime") or attrs.get("title") or node_text(node, 300)
            elif (tag in {"abbr", "span", "time"} and "published" in e["classes"]) or (tag == "time" and "pubdate" in attrs):
                value = attrs.get("datetime") or attrs.get("title")
            if value:
                marked.append((value, e))
            if tag == "time" and attrs.get("datetime"):
                times.append((attrs["datetime"], e))
            # Containers of articles (Blogger's date-outer) are not date labels.
            if not e["label"] and not e["core"] and (e["classes"] & DATE_LABEL_CLASSES or "date" in e["words"] or (tag == "time" and not attrs.get("datetime"))):
                e["label"] = True
                labels.append(e)
        if tag in HEADINGS or e["classes"] & {"entry-title", "post-title"}:
            headings.append(e)
        if tag == "a":
            rel = set((attrs.get("rel") or "").lower().split())
            if attrs.get("href") and e["unit"] is not None and not e["content"] and (e["title_of"] == e["unit"] or "bookmark" in rel):
                target = onion_url(urljoin(page_url, attrs["href"]))
                if target and urlsplit(target).hostname == host and unquote(urlsplit(target).path).rstrip("/") != own_path:
                    # The unit's title or permalink leads to another page: a card in a listing.
                    units[e["unit"]]["card"] = True
            if rel & {"category", "tag"}:
                rel_links.append(("category" not in rel, e))
    body = next((e for e in flat if e["tag"] == "body"), None)
    listing_body = bool(body and body["classes"] & LISTING_BODY and not body["classes"] & SINGLE_BODY)
    ld_article = [entry for entry in ld if article_type(entry.get("@type"))]
    meta_marker = (og.get("og:type") or "").strip().lower() == "article" or bool(ld_article)
    cards = sum(u["card"] for u in units)
    content, whole = None, False
    if len(contents) == 1:
        entry = flat[contents[0]]
        if not (entry["unit"] is not None and units[entry["unit"]]["card"]) and (
                "articlebody" in entry["itemprop"] or entry["unit"] is not None or entry["main"] or meta_marker):
            content = entry
    elif not contents and meta_marker and len(units) == 1 and not units[0]["card"]:
        content, whole = flat[units[0]["entry"]], True
    ld_body = next((" ".join(str(x.get("articleBody")).split()) for x in ld_article if isinstance(x.get("articleBody"), str) and x["articleBody"].strip()), "")
    if listing_body:
        content = None
    article = content is not None or bool(meta_marker and not listing_body and not contents and cards < 2 and ld_body)
    listing = content is None and (len(contents) > 1 or cards >= 2 or listing_body)
    if content is not None:
        scope = ("unit", content["unit"]) if content["unit"] is not None else ("main",) if content["main"] else None
    elif len(units) == 1:
        scope = ("unit", 0)
    else:
        scope = ("main",) if has_main else None

    def inside(e):
        return bool(e) and bool(scope) and ((scope[0] == "unit" and e["unit"] == scope[1]) or (scope[0] == "main" and e["main"]))

    def choose(candidates):
        # The first candidate of the article's own unit; otherwise one unambiguous date.
        dated = [(date, e) for date, e in ((machine_date(value, language), e) for value, e in candidates) if date]
        if scope and scope[0] == "unit":
            own = [c for c in dated if c[1]["unit"] == scope[1]]
            if own:
                return own[0]
            dated = [c for c in dated if c[1]["unit"] is None]
        elif scope:
            own = [c for c in dated if c[1]["main"]]
            if own:
                return own[0] if len({c[0] for c in own}) == 1 else None
        return dated[0] if dated and len({c[0] for c in dated}) == 1 else None

    def unique_ld(entries):
        dates = {machine_date(x.get("datePublished"), language) for x in entries if isinstance(x.get("datePublished"), str)} - {""}
        return (dates.pop(), None) if len(dates) == 1 else None

    visible = [(publication_date(text, language), text) for text in (node_text(e["node"], 300) for e in labels if inside(e))]
    visible = [v for v in visible if v[0]]
    meta = next((meta_dates[name] for name in META_DATE_NAMES if meta_dates.get(name)), "")
    pick = (meta, None) if meta else next((p for p in (choose(marked), unique_ld(ld_article), choose(times), unique_ld(ld)) if p), None)
    date = pick[0] if pick else visible[0][0] if len({v[0] for v in visible}) == 1 else ""
    # The raw visible label showing that date, when the page shows one.
    shown = node_text(pick[1]["node"], 300) if pick and pick[1] else ""
    label = next((text for text in [shown] + [v[1] for v in visible] if date and publication_date(text, language) == date), "")
    site = " ".join((og.get("og:site_name") or "").split())
    own_headings = (node_text(e["node"]) for e in headings if (inside(e) if scope and scope[0] == "unit" else True)
                    and e["classes"] & {"entry-title", "post-title"})
    # og:title loses a suffix only when og:site_name confirms it; <title> always does.
    title = next((t for t in (strip_site_suffix(og.get("og:title"), site) if site else " ".join((og.get("og:title") or "").split()),
                              next((" ".join(str(x.get("headline")).split()) for x in ld_article if isinstance(x.get("headline"), str)), ""),
                              next((t for t in own_headings if t), ""),
                              next((t for t in (node_text(e["node"]) for e in headings if e["tag"] == "h1") if t), ""),
                              strip_site_suffix(title_text, site)) if t), "")
    ranked = sorted(rel_links, key=lambda link: (link[0], not inside(link[1])))
    category = next((t for t in (node_text(e["node"], 300) for _, e in ranked) if t), "")
    return {"language": language, "og": og, "content": content, "whole": whole, "article": article, "listing": listing,
            "ld_body": ld_body if article and content is None else "", "date": date, "label": label, "strong": bool(meta),
            "title": title, "category": category.replace("İ", "i").lower()[:100]}


def path_category(url, language=""):
    segments = [unquote(s) for s in urlsplit(url).path.split("/") if s]
    if language and len(segments) >= 3 and segments[0].lower() == language:
        segments = segments[1:]
    return segments[0].lower()[:100] if len(segments) >= 2 and not segments[0].isdigit() else "publication"


def article_record(outline, url, base):
    """One publication_version 1 record for a generic article page (WordPress, Blogger, other CMSs).

    Comments, sharing blocks and related posts outside or inside the content
    container are left out; title-only communiqués are kept.
    """
    host = urlsplit(url).hostname
    def local(value):
        target = onion_url(urljoin(base, value or ""))
        return target if value and target and urlsplit(target).hostname == host else ""
    title = outline["title"]
    if not title or not outline["article"]:
        return None, {}
    attachments, body = {}, outline["ld_body"]
    if outline["content"] is not None:
        kept = prune_chrome(outline["content"]["node"], outline["whole"])
        body = original_text(kept)
        attachments = content_attachments(kept, local)
    full = body if body == title or body.startswith(title + "\n") else title + ("\n\n" + body if body else "")
    preview = local(outline["og"].get("og:image"))
    if preview and material_type(preview) != "image":
        preview = ""
    row = publication_record(url, title, full, outline["label"], True, list(attachments.values())[:12], preview,
                             outline["category"] or path_category(url, outline["language"]), "page", outline["language"])
    row["published_at"], row["date_basis"] = outline["date"], "html"
    if not row["published_at"]:
        row["published_at"] = url_publication_date(url)
        row["date_basis"] = "url" if row["published_at"] else "html"
    if len(attachments) > 12:
        row["attachments_truncated"] = True
    return row, attachments


class ListingParser(HTMLParser):
    def __init__(self, base):
        super().__init__(convert_charrefs=True)
        self.base, self.host = base, urlsplit(base).hostname
        self.rows, self.parts, self.text_parts, self.title_parts = {}, [], [], []
        self.current, self.truncated, self.in_title, self.ignored = None, False, False, 0
        self.text_size = 0
        self.poster, self.preview_url = "", ""

    def add_link(self, href, title="", kind=None):
        target = onion_url(urljoin(self.base, href or ""))
        if not target or urlsplit(target).hostname != self.host or target == self.base:
            return None
        parsed = urlsplit(target)
        # Follow document links, never account/moderation actions, forms or CMS plumbing.
        if skipped_link(parsed):
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
        if tag in ("script", "style"):
            self.ignored += 1
        if self.ignored:
            return
        values = {key: value or "" for key, value in attrs}
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
            self.rows[self.current]["title"] = display_title(" ".join(self.parts)) or display_title(self.current)
            self.current, self.parts = None, []


class LegacyListingParser(HTMLParser):
    """The previous generic link reader, kept verbatim (legacy dates and titles) for pages
    that carry the Arabic outlet's template markers outside its card lists and permalinks."""
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
        self.rows[target] = {"url": target, "title": legacy_display_title(title) or legacy_display_title(target),
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
            self.published_at = legacy_publication_date(values.get("content")) or self.published_at
        if tag == "time":
            date = legacy_publication_date(values.get("datetime"))
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
                    date = legacy_publication_date(entry.get("datePublished"))
                    if date:
                        self.page_dates.add(date)
                # Graph entries are common in publication metadata.
                for entry in queue[:200]:
                    if isinstance(entry, dict):
                        date = legacy_publication_date(entry.get("datePublished"))
                        if date:
                            self.page_dates.add(date)
            except (ValueError, TypeError):
                pass
        if tag in ("script", "style") and self.ignored:
            self.ignored -= 1
        if tag == "title":
            self.in_title = False
        if tag == "a" and self.current:
            self.rows[self.current]["title"] = legacy_display_title(" ".join(self.parts)) or legacy_display_title(self.current)
            self.current, self.parts = None, []


def arabic_template_page(tree):
    """The Arabic outlet's template markers: an element with class read-area, or id post-card-holder."""
    return any(has_class(n, "read-area") or n["attrs"].get("id") == "post-card-holder" for n in descendants(tree.root))


def legacy_listing(page_url, url, html, language=""):
    """The previous generic reading, for a page of the Arabic outlet's template that is not
    one of its card lists or permalinks with post-content (for example a video page).

    Records, file rows, their dates and the followed links are exactly as before; only
    source_language is added. No generic article record and no new link rules apply.
    """
    parser = LegacyListingParser(page_url)
    parser.feed(html)
    parser.close()
    selector = PublicationParser()
    selector.feed(html)
    selector.handle_endtag("html")
    selected = selector.selected_text()
    text = " ".join(" ".join(parser.text_parts).split())
    title = " ".join(" ".join(parser.title_parts).split())[:300] or legacy_display_title(page_url)
    # A unique HTML time on a publication page can date its attachments.
    # Category pages with multiple dates cannot assign one date to every file.
    dated = parser.published_at or (next(iter(parser.page_dates)) if len(parser.page_dates) == 1 else "")
    for row in parser.rows.values():
        row["title"] = legacy_display_title(row["title"])
        row["published_at"] = legacy_publication_date(unquote(row["url"]))
        row["date_basis"] = "url" if row["published_at"] else ""
        if row["type"] != "page" and dated and (selected or parser.published_at):
            row["published_at"] = row["published_at"] or dated
            row["date_basis"] = row["date_basis"] or "source_page"
        preview = parser.poster if row["type"] == "video" else parser.preview_url
        if preview and urlsplit(preview).hostname == urlsplit(url).hostname:
            row["preview_url"] = preview
        if language:
            row["source_language"] = language
    page = {"url": url, "title": title, "type": "page", "published_at": dated, "date_basis": "html",
            "preview_url": parser.preview_url, "excerpt": selected[:600], "selection_version": 1 if selected else 0}
    if language:
        page["source_language"] = language
    return {"items": list(parser.rows.values()), "page": page, "text": text, "truncated": parser.truncated}


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


def transient_error(error):
    """Network or server-side failures that a later pass may not repeat."""
    if isinstance(error, requests.exceptions.HTTPError):
        status = getattr(error.response, "status_code", None)
        return isinstance(status, int) and status >= 500
    return isinstance(error, (requests.exceptions.Timeout, requests.exceptions.ConnectionError, requests.exceptions.ChunkedEncodingError))


def english_switch_due(session, url, every=600):
    """At most one English request per outlet host every ten minutes (a lost session can be renewed)."""
    host = urlsplit(url).hostname
    try:
        switched = session.__dict__.setdefault("ct_english_requested", {})
    except AttributeError:
        return False
    if time.monotonic() - switched.get(host, -every) < every:
        return False
    switched[host] = time.monotonic()
    return True


def read_listing(session, outlet):
    response = source_get(session, outlet["url"], urlsplit(outlet["url"]).hostname)
    try:
        content_type = response.headers.get("Content-Type", "")
        mime = content_type.lower()
        header_language = language_tag(response.headers.get("Content-Language", ""))
        kind = material_type(response.url, mime)
        if kind != "page":
            page = {"url": outlet["url"], "title": display_title(response.url),
                    "type": kind, "published_at": url_publication_date(response.url), "date_basis": "url"}
            if header_language:
                page["source_language"] = header_language
            return {"items": [], "page": page, "text": "", "truncated": False}
        if mime and "html" not in mime:
            return {"items": [], "page": None, "text": "", "truncated": False}
        chunks, total = [], 0
        for chunk in response.iter_content(65536):
            total += len(chunk)
            if total > MAX_HTML_BYTES:
                raise ValueError("Listing exceeds HTML size limit")
            chunks.append(chunk)
        # The charset comes from the bytes and headers, never from requests' ISO-8859-1 default.
        html = decode_html(b"".join(chunks), content_type)
        tree = PublicationTree()
        tree.feed(html)
        language = page_language(tree, header_language)
        # The observed structured templates keep priority over every generic reading.
        since = str((outlet.get("policy") or {}).get("from") or "")
        structured = structured_publications(html, outlet["url"], language, tree, since)
        if structured is not None:
            if structured.pop("english_available", False) and english_switch_due(session, outlet["url"]):
                # A multilingual outlet served another language. Ask its own English menu,
                # verify the reread, and (only if needed) retry with force_translate=true.
                # This avoids silently keeping Arabic when the English tab exists but the
                # site's session requires an explicit translation flag for article bodies.
                response.close()
                host = urlsplit(outlet["url"]).hostname
                root = urlunsplit((urlsplit(outlet["url"]).scheme, urlsplit(outlet["url"]).netloc, "", "", ""))
                last_error = None
                fallback = structured
                for switch_path in (NEWS_PORTAL_ENGLISH, NEWS_PORTAL_ENGLISH_FORCE):
                    try:
                        source_get(session, root + switch_path, host).close()
                        reread = read_listing(session, outlet)
                        fallback = reread
                        records = list(reread.get("items") or [])
                        if reread.get("page"):
                            records.append(reread["page"])
                        if any(row.get("source_language") == "en" for row in records):
                            return reread
                    except Exception as error:
                        last_error = error
                # Keep the already collected source-language page rather than losing data.
                LOG.warning("Outlet %s: English tab did not yield English publication text%s; page kept in its served language",
                            outlet.get("id", ""),
                            " (" + source_failure_reason(last_error) + ")" if last_error else "")
                return fallback
            return structured
        tree.close()
        if arabic_template_page(tree):
            # The Arabic outlet's other pages (a video page without post-content, for
            # example) keep the previous generic reading, so its records stay unchanged.
            return legacy_listing(response.url, outlet["url"], html, language)
        parser = ListingParser(response.url)
        parser.feed(html)
        parser.close()
        outline = page_outline(tree, response.url, language)
        article, files = article_record(outline, outlet["url"], response.url)
        media_date = ""
        if article:
            # Files inside the article belong to its record, not to separate items.
            for attachment in article["attachments"]:
                parser.rows.pop(attachment["url"], None)
            page, text = article, article["original_text"]
            media_date = article["published_at"]
        else:
            selector = PublicationParser()
            selector.feed(html)
            selector.handle_endtag("html")
            # Category and archive pages list articles; they are never publications themselves.
            selected = "" if outline["listing"] else selector.selected_text()
            text = " ".join(" ".join(parser.text_parts).split())
            title = " ".join(" ".join(parser.title_parts).split())[:300] or display_title(response.url)
            dated, basis = outline["date"], "html"
            if not dated and selected:
                dated = url_publication_date(outlet["url"])
                basis = "url" if dated else "html"
            page = {"url": outlet["url"], "title": title, "type": "page", "published_at": dated, "date_basis": basis,
                    "preview_url": parser.preview_url, "excerpt": selected[:600], "selection_version": 1 if selected else 0}
            # A dated publication page can date its files. Category pages with
            # several dates cannot assign one date to every file.
            if selected or outline["strong"]:
                media_date = dated
        for row in parser.rows.values():
            row["title"] = display_title(row["title"])
            row["published_at"] = url_publication_date(row["url"])
            row["date_basis"] = "url" if row["published_at"] else ""
            # Files of a dated page take the page's date; outside an article's content
            # (sidebars, headers) only a permalink-style URL can date them.
            if row["type"] != "page" and media_date and (not article or row["url"] in files):
                row["published_at"], row["date_basis"] = media_date, "source_page"
            preview = parser.poster if row["type"] == "video" else parser.preview_url
            if preview and urlsplit(preview).hostname == urlsplit(outlet["url"]).hostname:
                row["preview_url"] = preview
            if language:
                row["source_language"] = language
        if language:
            page["source_language"] = language
        return {"items": list(parser.rows.values()), "page": page, "text": text, "truncated": parser.truncated}
    finally:
        response.close()


def preview_source(row):
    """Identify actual preview bytes so listing-only failures do not block detail previews.

    Only publication records (the structured template and generic article pages)
    are previewed: the first page of their PDF or their same-host cover image.
    Other generic and forum pages never are, so user-posted images are never fetched.
    """
    if row.get("publication_version") != 1:
        return None
    attachment = next((a for a in row.get("attachments", []) if a.get("type") == "pdf"), None)
    if attachment:
        return ("pdf", attachment["url"])
    if row.get("preview_url"):
        return ("image", row["preview_url"])
    return None


def make_preview(tor, row):
    result = _make_preview(tor, row)
    if not result.get("preview") and row.get("publication_version") == 1 and row.get("preview_url") and any(a.get("type") == "pdf" for a in row.get("attachments", [])):
        # Large/unreadable PDFs may still supply a usable cover image in the page.
        cover = _make_preview(tor, {**row, "attachments": []})
        if cover.get("preview") or cover.get("transient"):
            result = cover
    # A transient failure carries no status, so a later pass retries it.
    return result if result.get("transient") else {**result, "preview_version": 2}


def _make_preview(tor, row):
    """At most 8 MiB of source bytes; never keep or upload original media."""
    if row.get("publication_version") != 1:
        return {"preview_status": "No visual preview supplied"}
    attachment = next((a for a in row.get("attachments", []) if a["type"] == "pdf"), None)
    if attachment:
        row = {**attachment, "preview_url": ""}
    elif not row.get("preview_url"):
        return {"preview_status": "No visual preview supplied"}
    kind = row.get("type")
    preview_url = row.get("preview_url", "")
    target = preview_url or (row["url"] if kind == "pdf" else "")
    if not target:
        return {"preview_status": "No visual preview supplied"}
    host = urlsplit(row["url"]).hostname
    if not onion_url(target) or urlsplit(target).hostname != host:
        return {"preview_status": "Preview outside registered outlet"}
    try:
        from PIL import Image
        if not preview_url and kind == "pdf":
            import fitz
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
                    return {"preview": encoded, "preview_status": "Source thumbnail" if preview_url else "First page"}
        return {"preview_status": "Preview could not fit size cap"}
    except ImportError:
        return {"preview_status": "Install Pillow and PyMuPDF on collector"}
    except Exception as error:
        if transient_error(error):
            return {"transient": True}
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
    # Queued rows Atlas cannot accept are kept here instead of blocking the outbox.
    db.execute("CREATE TABLE IF NOT EXISTS rejected (outlet_id TEXT, url TEXT, metadata TEXT, baseline INTEGER, PRIMARY KEY(outlet_id,url))")
    db.execute("CREATE TABLE IF NOT EXISTS preview_retries (outlet_id TEXT, url TEXT, source TEXT, attempts INTEGER, PRIMARY KEY(outlet_id,url))")
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
    requeued = False
    if not run or run[0]:
        with db:
            db.execute("DELETE FROM frontier WHERE outlet_id=?", (oid,))
            db.execute("INSERT OR REPLACE INTO crawl_runs VALUES (?,0)", (oid,))
            db.execute("INSERT INTO frontier(outlet_id,url) VALUES (?,?)", (oid, outlet["url"]))
    elif watching:
        # Daily watch mode never walks the historical frontier. Keep only the current
        # starting page; links discovered from it may be followed within the normal
        # shallow watch depth during this pass.
        with db:
            db.execute("DELETE FROM frontier WHERE outlet_id=? AND url<>? AND status NOT IN (\'failed\')", (oid, outlet["url"]))
            db.execute("INSERT OR IGNORE INTO frontier(outlet_id,url) VALUES (?,?)", (oid, outlet["url"]))
            db.execute("UPDATE frontier SET status='pending',attempts=0,depth=0 WHERE outlet_id=? AND url=?", (oid, outlet["url"]))
        requeued = True
    # A failed upload is replayed before advancing the crawler.
    if db.execute("SELECT 1 FROM outbox WHERE outlet_id=? LIMIT 1", (oid,)).fetchone():
        return crawl_progress(db, oid, max_pages)
    local_initialized = bool(db.execute("SELECT initialized FROM outlets WHERE id=?", (oid,)).fetchone())
    visited, tried, deferred, answered = 0, set(), [], False
    while visited < pages_per_scan:
        if db.execute("SELECT COUNT(*) FROM frontier WHERE outlet_id=?", (oid,)).fetchone()[0] >= 50000:
            break
        done = db.execute("SELECT COUNT(*) FROM frontier WHERE outlet_id=? AND status='done'", (oid,)).fetchone()[0]
        if done >= max_pages:
            break
        # A failed page is retried on a later pass, not repeatedly within one pass.
        candidates = db.execute("SELECT url,depth FROM frontier WHERE outlet_id=? AND status IN ('pending','failed') AND attempts<3 ORDER BY url=? DESC,attempts,rowid LIMIT ?",
                                (oid, outlet["url"], len(tried) + 1)).fetchall()
        target = next((row for row in candidates if row[0] not in tried), None)
        if not target:
            break
        url = target[0]
        tried.add(url)
        if visited == 0 or visited % 10 == 0:
            LOG.info("Outlet %s: crawling internal pages (%s fetched in this cycle)", oid, done)
        if visited and request_delay:
            time.sleep(request_delay)
        visited += 1
        try:
            result = read_listing(tor, {**outlet, "url": url})
        except Exception as error:
            # Network and server errors count once the outlet has answered in this pass,
            # so a Tor or onion-service outage does not use up page attempts.
            transient = transient_error(error)
            with db:
                db.execute("UPDATE frontier SET status='failed',attempts=attempts+? WHERE outlet_id=? AND url=?", (0 if transient else 1, oid, url))
            if transient:
                deferred.append(url)
            answered |= isinstance(error, requests.exceptions.HTTPError) and not transient
            LOG.warning("Internal page failed for outlet %s: %s; connect timeout=%ss, read timeout=90s; queue retained",
                        oid, source_failure_reason(error), getattr(tor, "source_connect_timeout", SOURCE_CONNECT_TIMEOUT))
            continue
        answered = True
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
                    # In daily watch mode, previously collected publication URLs do not
                    # need to be reopened. Only genuinely new links enter the shallow
                    # frontier; failed links keep their attempts across passes.
                    known = watching and db.execute("SELECT 1 FROM items WHERE outlet_id=? AND url=? LIMIT 1", (oid, target_url)).fetchone()
                    if not known:
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
                if "source_translation" not in row:
                    # Set by each reading: a page read in another language is not the outlet's translation.
                    merged.pop("source_translation", None)
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
                if requeued and url == outlet["url"] and prior and not queued and merged == json.loads(prior[0]):
                    # A start page re-checked within a watch run sends only new or changed rows.
                    continue
                db.execute("INSERT OR REPLACE INTO outbox VALUES (?,?,?,?)", (oid, target_url, json.dumps(merged), int(baseline)))
        # Bound the local queue as well as network requests; do not drop any queued URL.
        if db.execute("SELECT COUNT(*) FROM frontier WHERE outlet_id=?", (oid,)).fetchone()[0] >= 50000:
            break
    if deferred and not answered and outlet["url"] not in tried and not db.execute(
            "SELECT 1 FROM frontier WHERE outlet_id=? AND status='pending' LIMIT 1", (oid,)).fetchone():
        # Only failing pages remain: confirm the outlet answers before counting their failures.
        try:
            if request_delay:
                time.sleep(request_delay)
            source_get(tor, outlet["url"], urlsplit(outlet["url"]).hostname).close()
            answered = True
        except Exception as error:
            answered = isinstance(error, requests.exceptions.HTTPError) and not transient_error(error)
    if deferred and answered:
        with db:
            db.executemany("UPDATE frontier SET attempts=attempts+1 WHERE outlet_id=? AND url=? AND status='failed'", [(oid, u) for u in deferred])
    return close_exhausted_run(db, oid, max_pages)


def close_exhausted_run(db, oid, max_pages):
    """Finish a run once nothing selectable is left, so the next run restarts at the start page."""
    progress = crawl_progress(db, oid, max_pages)
    if progress["complete"]:
        return progress
    total = db.execute("SELECT COUNT(*) FROM frontier WHERE outlet_id=?", (oid,)).fetchone()[0]
    done = db.execute("SELECT COUNT(*) FROM frontier WHERE outlet_id=? AND status='done'", (oid,)).fetchone()[0]
    if total < 50000 and done < max_pages and db.execute(
            "SELECT 1 FROM frontier WHERE outlet_id=? AND status IN ('pending','failed') AND attempts<3 LIMIT 1", (oid,)).fetchone():
        return progress
    with db:
        if progress["pages_scanned"]:
            # Leftovers are reported as abandoned; a limited page was fetched, so it stays counted as scanned.
            db.execute("UPDATE frontier SET status='partial' WHERE outlet_id=? AND status='limited'", (oid,))
            db.execute("UPDATE frontier SET status='abandoned' WHERE outlet_id=? AND status IN ('pending','failed')", (oid,))
        else:
            # The start page itself has not been fetched in this run; retry it next pass.
            db.execute("UPDATE frontier SET attempts=0 WHERE outlet_id=? AND status='failed'", (oid,))
    progress = crawl_progress(db, oid, max_pages)
    if progress["abandoned_pages"]:
        LOG.warning("Outlet %s: run finished with %s pages abandoned (repeated failures, page limits or the page cap)",
                    oid, progress["abandoned_pages"])
    return progress


def crawl_progress(db, oid, max_pages):
    counts = dict(db.execute("SELECT status,COUNT(*) FROM frontier WHERE outlet_id=? GROUP BY status", (oid,)))
    done = counts.get("done", 0)
    failed = counts.get("failed", 0)
    pending = counts.get("pending", 0)
    partial = counts.get("partial", 0)
    abandoned = counts.get("abandoned", 0) + partial
    limited = counts.get("limited", 0) > 0 or (done >= max_pages and pending > 0) or sum(counts.values()) - abandoned >= 50000
    return {"pages_scanned": done + counts.get("limited", 0) + partial, "pending_pages": pending, "failed_pages": failed,
            "abandoned_pages": abandoned, "truncated": limited, "complete": pending == 0 and failed == 0 and not limited}


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
            db.execute("INSERT OR REPLACE INTO settings VALUES (?, ?)", (inventory_key, "complete" if outlet.get("collection_phase") == "watch" else "running"))
        inventory = ("complete",) if outlet.get("collection_phase") == "watch" else ("running",)
    if inventory[0] != "complete" and outlet.get("collection_phase") != "watch":
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
                preview_pending = policy.get("previews") and item.get("publication_version") == 1 and not item.get("preview") and (not item.get("preview_status") or item.get("preview_version") != 2)
                if within_period(item, policy) and onion_url(old_url) and (pdf_pending or preview_pending):
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
            "pending_pages": progress["pending_pages"], "failed_pages": progress["failed_pages"],
            "abandoned_pages": progress["abandoned_pages"]})
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
        if not onion_url(row["url"]) or any(not onion_url(a.get("url", "")) for a in row.get("attachments", [])):
            # Atlas refuses such a URL and the whole batch with it; keep the row locally instead.
            with db:
                db.execute("INSERT OR REPLACE INTO rejected VALUES (?,?,?,?)", (oid, row["url"], payload, baseline))
                db.execute("DELETE FROM outbox WHERE outlet_id=? AND url=?", (oid, row["url"]))
            LOG.warning("Outlet %s: a queued item exceeds the Atlas URL limit; kept in the local rejected table", oid)
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
            if row.get("publication_version") == 1 and not row.get("preview") and not row.get("preview_status") and previews_left:
                previews_left -= 1
                source = json.dumps(preview_source(row))
                retry = db.execute("SELECT attempts FROM preview_retries WHERE outlet_id=? AND url=? AND source=?", (oid, row["url"], source)).fetchone()
                result = make_preview(tor, row)
                attempts = (retry[0] if retry else 0) + 1
                if result.get("transient") and attempts >= 3:
                    result = {"preview_status": "Preview source unreachable after 3 attempts", "preview_version": 2}
                # Atlas already holds this exact row when only the local retry counter changes.
                unchanged = bool(result.get("transient") and prior and row == previous)
                with db:
                    if result.get("transient"):
                        # Timeouts, connection errors and HTTP 5xx leave no status; a later pass retries.
                        db.execute("INSERT OR REPLACE INTO preview_retries VALUES (?,?,?,?)", (oid, row["url"], source, attempts))
                    else:
                        db.execute("DELETE FROM preview_retries WHERE outlet_id=? AND url=?", (oid, row["url"]))
                        row.update(result)
                    if unchanged:
                        db.execute("DELETE FROM outbox WHERE outlet_id=? AND url=?", (oid, row["url"]))
                    else:
                        db.execute("UPDATE outbox SET metadata=? WHERE outlet_id=? AND url=?", (json.dumps(row), oid, row["url"]))
                if unchanged:
                    continue
        # Generic image links are never fetched, even with --acquire.
        if acquire_files and not baseline and not row.get("publication_version") and row["type"] not in {"page", "image"} and not row.get("acquired"):
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
    # Failed pages stay queued for a later pass; close_exhausted_run ends a run that cannot progress.
    LOG.info("Outlet %s: pages=%s pending=%s failed=%s abandoned=%s limited=%s complete=%s", oid,
             progress["pages_scanned"], progress["pending_pages"], progress["failed_pages"], progress["abandoned_pages"], progress["truncated"], progress["complete"])
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
