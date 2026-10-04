"""Evidence retained from actual collector responses, independently of synthesis."""
from copy import deepcopy
from datetime import datetime, timezone
from urllib.parse import urlsplit

MAX_MESSAGES = 120


class TelegramEvidence:
    def __init__(self):
        self.channels = {}
        self.messages = {}
        self.observed = set()
        self.retrieved_at = datetime.now(timezone.utc).isoformat()

    def capture(self, name, response):
        if name not in {"read_telegram_channel", "explore_telegram_network"} or not isinstance(response, dict):
            return
        data = response.get("result", response)
        if not isinstance(data, dict):
            return
        for result in data.get("channels", [data]):
            if not isinstance(result, dict) or not result.get("channel"):
                continue
            channel = str(result["channel"]).lower()
            previous = self.channels.get(channel, {})
            self.channels[channel] = {
                "channel": channel, "title": result.get("info", {}).get("title", ""),
                "description": result.get("info", {}).get("description", ""),
                "status": result.get("status", "unknown"),
                "pages_read": previous.get("pages_read", 0) + result.get("pages_read", 0),
                "next_before": result.get("next_before"),
                "stop_reason": result.get("stop_reason") or result.get("error") or result.get("reason", ""),
            }
            for message in result.get("messages", []):
                url = message.get("url", "")
                if not url:
                    continue
                self.observed.add(url)
                if url in self.messages or len(self.messages) >= MAX_MESSAGES:
                    continue
                self.messages[url] = {**deepcopy(message), "channel": channel}

    def build(self):
        relationships = {}
        for message in self.messages.values():
            targets = set()
            forward = message.get("forwarded_from") or {}
            if forward.get("channel"):
                targets.add(("forward", "@" + forward["channel"].lower()))
            for target in message.get("mentioned_channels", []):
                targets.add(("mention", "@" + target.lower()))
            reply = message.get("reply_to_url", "")
            if reply.startswith("https://t.me/"):
                targets.add(("reply", reply))
            for url in message.get("links", []):
                if urlsplit(url).scheme in {"http", "https"}:
                    targets.add(("link", url))
                    host = (urlsplit(url).hostname or "").lower().removeprefix("www.")
                    if host and host not in {"t.me", "telegram.me", "telegram.dog"}:
                        targets.add(("domain", host))
            for kind, target in sorted(targets):
                key = (message["channel"], kind, target)
                item = relationships.setdefault(key, {"channel": message["channel"], "type": kind,
                                                      "target": target, "source_urls": []})
                item["source_urls"].append(message["url"])
        edges = sorted(relationships.values(), key=lambda item: (-len(item["source_urls"]), item["channel"], item["type"], item["target"]))
        return {
            "retrieved_at": self.retrieved_at,
            "channels": list(self.channels.values())[:5],
            "messages": list(self.messages.values()),
            "messages_observed": len(self.observed),
            "messages_retained": len(self.messages),
            "truncated": len(self.observed) > len(self.messages),
            "relationships": [{**item, "count": len(item["source_urls"])} for item in edges[:300]],
            "relationships_truncated": len(edges) > 300,
            "scope": "Public preview only. Counts describe retained posts, not the entire channel. Mentions and forwards do not establish identity, affiliation or common control. Media content was not transcribed.",
        }
