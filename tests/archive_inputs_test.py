"""What the collector feeds the background archive: no off-topic noise, no
second copy of an article under a new Google News token, no headline repeated
among its own related articles."""
import importlib.util
import unittest

spec = importlib.util.spec_from_file_location("collector", "collector.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)

GNEWS = "https://news.google.com/rss/articles/"


def article(title, url, source="Al Arabiya", published="2026-09-27T10:00:00+00:00"):
    return {"title": title, "url": url, "source": source, "published": published}


def record(title, url, source, published="2026-09-27T10:00:00+00:00", related=None):
    return {
        "id": title[:20], "title": title, "summary": title, "published": published,
        "source": source, "sources": [source], "url": url,
        "category": "Attacks", "categories": ["Attacks"],
        "related_articles": related or [], "article_count": 1 + len(related or []),
    }


class GoogleNewsIdentityTests(unittest.TestCase):
    def test_one_article_under_two_google_news_tokens_is_one_article(self):
        a = article("اشتباكات كركوك: ارتفاع الحصيلة", GNEWS + "CBMiAAA")
        b = article("اشتباكات كركوك: ارتفاع الحصيلة", GNEWS + "CBMiBBB")
        self.assertEqual(collector.article_identity(a), collector.article_identity(b))

    def test_other_outlets_and_other_days_stay_distinct(self):
        base = article("Kirkuk clashes toll rises", GNEWS + "CBMiAAA")
        self.assertNotEqual(collector.article_identity(base),
                            collector.article_identity({**base, "source": "Rudaw", "url": GNEWS + "CBMiCCC"}))
        self.assertNotEqual(collector.article_identity(base),
                            collector.article_identity({**base, "published": "2026-09-28T10:00:00+00:00"}))

    def test_publisher_links_keep_their_url_identity(self):
        self.assertEqual(collector.article_identity(article("x", "https://rudaw.net/a/1/")), "url:https://rudaw.net/a/1")


class MergeEventTests(unittest.TestCase):
    def test_a_promoted_headline_does_not_stay_among_the_related_articles(self):
        existing = record("Attack near Kirkuk kills four", GNEWS + "CBMiLOW", "Unknown blog")
        incoming = record("Four killed in attack near Kirkuk", "https://www.reuters.com/world/kirkuk", "Reuters")
        self.assertGreater(collector.source_rank("Reuters"), collector.source_rank("Unknown blog"))
        collector.merge_event(existing, incoming, 0.9, "test")
        self.assertEqual(existing["url"], "https://www.reuters.com/world/kirkuk")
        related_urls = [item.get("url") for item in existing["related_articles"]]
        self.assertNotIn("https://www.reuters.com/world/kirkuk", related_urls)
        self.assertIn(GNEWS + "CBMiLOW", related_urls)

    def test_merging_a_record_with_the_headlines_own_link_adds_nothing(self):
        # deduplicate_incremental anchors on the URL ("same_url" merges): the
        # headline must not reappear among its own related articles.
        existing = record("Gunmen kill 5 in Zamfara", GNEWS + "CBMiAAA", "Punch")
        existing["published"] = "2026-09-26T08:00:00+00:00"  # the cluster's first report, an earlier day
        incoming = record("Gunmen kill 5 in Zamfara", GNEWS + "CBMiAAA", "Punch")
        collector.merge_event(existing, incoming, 1.0, "same_url")
        self.assertEqual(existing["related_articles"], [])
        self.assertEqual(existing["article_count"], 1)

    def test_the_headline_under_a_new_token_on_its_own_day_adds_nothing(self):
        # The cluster's published date becomes its first report's day, so the
        # headline's own article may come back dated another day.
        existing = record("Gunmen kill 5 in Zamfara", GNEWS + "CBMiAAA", "Punch", published="2026-09-27T10:00:00+00:00")
        earlier = record("Bandits attack Zamfara village", "https://blog.test/zamfara", "Unknown blog",
                         published="2026-09-26T10:00:00+00:00")
        collector.merge_event(existing, earlier, 0.9, "test")
        count = existing["article_count"]
        again = record("Gunmen kill 5 in Zamfara", GNEWS + "CBMiCCC", "Punch", published="2026-09-27T10:00:00+00:00")
        collector.merge_event(existing, again, 0.9, "test")
        self.assertEqual(existing["article_count"], count)
        self.assertNotIn(GNEWS + "CBMiCCC", [item.get("url") for item in existing["related_articles"]])

    def test_the_same_article_under_a_new_token_is_not_added_again(self):
        existing = record("Kirkuk clashes toll rises", "https://rudaw.net/kirkuk", "Rudaw",
                          related=[article("Kirkuk clashes: toll rises to 9", GNEWS + "CBMiAAA", source="Alsumaria")])
        incoming = record("Kirkuk clashes: toll rises to 9", GNEWS + "CBMiBBB", "Alsumaria")
        collector.merge_event(existing, incoming, 0.9, "test")
        titles = [item.get("title") for item in existing["related_articles"]]
        self.assertEqual(titles.count("Kirkuk clashes: toll rises to 9"), 1)


class SelectionCacheArticleTests(unittest.TestCase):
    """Only reviews the archive will hold (0 < score < threshold) keep their
    article's link and date in the committed cache."""

    def test_only_archive_bound_reviews_store_their_article(self):
        import json
        import os
        import tempfile

        scores = {"Map-worthy attack in Kabul": 85, "Analysis of Sahel jihadist rivalry": 30, "Yacht sale in Monaco": 0}
        events = [
            {**record(title, f"https://outlet.test/{index}", "Outlet"), "id": f"evt-{index}"}
            for index, title in enumerate(scores)
        ]

        def fake_batch(batch):
            return [{"event_id": item["event_id"], "relevance_score": scores[item["title"]],
                     "english_title": item["title"], "keep": scores[item["title"]] >= 60}
                    for item in batch]

        saved = {name: getattr(collector, name) for name in (
            "AI_SELECTION_ENABLED", "AI_SELECTION_CACHE_FILE", "AI_SELECTION_THRESHOLD",
            "process_ai_selection_batch", "persist_background_articles")}
        with tempfile.TemporaryDirectory() as tmp:
            cache_path = os.path.join(tmp, "cache.json")
            collector.AI_SELECTION_ENABLED = True
            collector.AI_SELECTION_CACHE_FILE = cache_path
            collector.AI_SELECTION_THRESHOLD = 60
            collector.process_ai_selection_batch = fake_batch
            collector.persist_background_articles = lambda rejected: None
            try:
                try:
                    collector.ai_select_events(events)
                except Exception:  # noqa: BLE001 -- only the saved cache matters here
                    pass
                with open(cache_path, encoding="utf-8") as handle:
                    items = json.load(handle)["items"].values()
            finally:
                for name, value in saved.items():
                    setattr(collector, name, value)

        by_title = {item["result"]["english_title"]: item for item in items}
        self.assertEqual(by_title["Analysis of Sahel jihadist rivalry"]["article"]["url"], "https://outlet.test/1")
        self.assertNotIn("article", by_title["Map-worthy attack in Kabul"])
        self.assertNotIn("article", by_title["Yacht sale in Monaco"])


class OffTopicTests(unittest.TestCase):
    def test_score_zero_rejections_are_not_sent_to_the_archive(self):
        sent = []
        original = collector.persist_background_articles_to_d1
        collector.persist_background_articles_to_d1 = lambda events: sent.extend(events)
        try:
            collector.persist_background_articles([
                {"url": "https://x/noise", "title": "Yacht sale", "ai_relevance_score": 0},
                {"url": "https://x/context", "title": "Analysis of JNIM", "ai_relevance_score": 35},
                {"url": "https://x/unscored", "title": "No score recorded"},
            ])
        finally:
            collector.persist_background_articles_to_d1 = original
        self.assertEqual([event["url"] for event in sent], ["https://x/context", "https://x/unscored"])


if __name__ == "__main__":
    unittest.main()
