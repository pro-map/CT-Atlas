"""What the collectors actually returned, independently of what the model reports.

The Worker keeps a report's sources and citations only if they are in this ledger,
and takes each source's kind from here. The ledger therefore reads structured
collector fields only: extract_public_indicators, normalize_evidence and
preprocess_public_text_free echo text the model supplied, so nothing they return
can prove that a URL exists.
"""
from collections import Counter
from typing import Any

from .telegram_evidence import TelegramEvidence

MAX_PER_KIND = 300
SNIPPET_MAX = 300

# A stronger observation of a URL replaces a weaker one.
_RANK = {
    "discovered_link": 0,
    "search_result": 1,
    "transcribed_media": 2,
    "telegram_public_preview": 2,
    "telegram_collected_post": 3,
    "direct_public_page": 3,
}
_SEARCH_TOOLS = {
    "search_public_web", "search_linkedin_public", "search_telegram_public", "search_bluesky",
    "search_mastodon", "search_flickr", "search_fourchan", "search_youtube", "search_x",
    "search_reddit", "search_tumblr", "search_twitch", "search_odysee", "search_username_profiles",
}
_TELEGRAM_TOOLS = {"read_telegram_channel", "explore_telegram_network"}
_TITLE_FIELDS = ("title", "subject", "display_name", "handle", "acct", "blog_name", "login", "name")
_SNIPPET_FIELDS = ("snippet", "text", "description", "note", "summary", "selftext")


def _first(item: dict[str, Any], fields: tuple[str, ...]) -> str:
    return next((str(item[field]) for field in fields if item.get(field)), "")


class EvidenceLedger:
    def __init__(self):
        self.telegram = TelegramEvidence()
        self.entries: dict[str, dict[str, str]] = {}
        self.counts: Counter = Counter()

    def _add(self, url: Any, kind: str, tool: str, title: str = "", snippet: str = "") -> None:
        url = str(url or "").strip()[:1500]
        if not url.lower().startswith(("http://", "https://")):
            return
        current = self.entries.get(url)
        if current:
            if _RANK[kind] > _RANK[current["kind"]]:
                current.update(kind=kind, tool=tool)
            current["title"] = current["title"] or title[:200]
            current["snippet"] = current["snippet"] or snippet[:SNIPPET_MAX]
            return
        if self.counts[kind] >= MAX_PER_KIND:
            return
        self.counts[kind] += 1
        self.entries[url] = {"url": url, "kind": kind, "tool": tool, "title": title[:200], "snippet": snippet[:SNIPPET_MAX]}

    def _capture_page(self, data: dict[str, Any]) -> None:
        if data.get("status") != "success":
            return
        title, text = str(data.get("title") or ""), str(data.get("text") or "")
        self._add(data.get("url"), "direct_public_page", "fetch_public_url", title, text)
        self._add(data.get("requested_url"), "direct_public_page", "fetch_public_url", title, text)
        for link in data.get("links") or []:
            if isinstance(link, dict):
                self._add(link.get("url"), "discovered_link", "fetch_public_url", str(link.get("label") or ""))

    def _capture_telegram(self, name: str, data: dict[str, Any]) -> None:
        for channel in data.get("channels", [data]):
            if not isinstance(channel, dict):
                continue
            if channel.get("status") == "success":
                title = str((channel.get("info") or {}).get("title") or "")
                self._add(channel.get("url"), "telegram_public_preview", name, title)
                self._add(channel.get("preview_url"), "telegram_public_preview", name, title)
            for message in channel.get("messages") or []:
                if not isinstance(message, dict):
                    continue
                self._add(message.get("url"), "telegram_collected_post", name)
                for link in message.get("links") or []:
                    self._add(link, "discovered_link", name)
                self._add(message.get("reply_to_url"), "discovered_link", name)
                self._add((message.get("forwarded_from") or {}).get("url"), "discovered_link", name)

    def capture(self, name: str, response: Any) -> None:
        self.telegram.capture(name, response)
        data = response.get("result", response) if isinstance(response, dict) else None
        if not isinstance(data, dict):
            return
        if name == "fetch_public_url":
            self._capture_page(data)
        elif name in _TELEGRAM_TOOLS:
            self._capture_telegram(name, data)
        elif name == "wayback_snapshots":
            for capture in data.get("captures") or []:
                self._add(capture.get("archive_url"), "search_result", name, "Wayback capture " + str(capture.get("captured_at") or ""))
        elif name == "transcribe_public_media" and data.get("status") == "success":
            self._add(data.get("source_url"), "transcribed_media", name, "", str(data.get("text") or ""))
        elif name in _SEARCH_TOOLS:
            for item in data.get("results") or []:
                if isinstance(item, dict):
                    title, snippet = _first(item, _TITLE_FIELDS), _first(item, _SNIPPET_FIELDS)
                    self._add(item.get("url") or item.get("post_url"), "search_result", name, title, snippet)
                    self._add(item.get("channel_url"), "search_result", name, str(item.get("channel") or ""))

    def has_evidence(self) -> bool:
        return any(entry["kind"] != "discovered_link" for entry in self.entries.values())

    def as_list(self) -> list[dict[str, str]]:
        return sorted(self.entries.values(), key=lambda entry: -_RANK[entry["kind"]])

    def report_sources(self) -> list[dict[str, str]]:
        """Sources for a report the model did not finish. Links seen on a page stay
        out: they were never read, and one page can carry fifty of them."""
        return [
            {"url": entry["url"], "title": entry["title"], "kind": entry["kind"]}
            for entry in self.as_list()
            if entry["kind"] not in {"discovered_link", "telegram_collected_post"}
        ][:100]

    def coverage(self) -> str:
        parts = (
            ("direct_public_page", "page(s) retrieved directly"),
            ("telegram_public_preview", "Telegram preview URL(s) read"),
            ("transcribed_media", "media file(s) transcribed"),
            ("search_result", "search result(s), not retrieved"),
        )
        summary = [f"{self.counts[kind]} {label}" for kind, label in parts if self.counts[kind]]
        if self.telegram.messages:
            summary.append(f"{len(self.telegram.messages)} Telegram posts retained from public previews")
        return "; ".join(summary) + "."
