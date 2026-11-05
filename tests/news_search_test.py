"""tools/news_search.py: the live RadNuc background job's Google News and GDELT
searches and article keys, with the network stubbed."""
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import archive_review  # noqa: E402
import news_search  # noqa: E402

collector = archive_review.prepare_collector(archive_review.load_collector(), threshold=60)


class UrlTests(unittest.TestCase):
    def test_google_searches_the_window_on_the_profiles_edition(self):
        task = {"query": "x", "start": "2026-06-01", "end": "2026-06-08", "hl": "bn", "gl": "BD", "ceid": "BD:bn"}
        query = parse_qs(urlparse(news_search.google_url(collector, task)).query)
        self.assertTrue(query["q"][0].endswith("after:2026-06-01 before:2026-06-09"))
        self.assertEqual((query["hl"][0], query["gl"][0], query["ceid"][0]), ("bn", "BD", "BD:bn"))
        self.assertNotIn("when:", query["q"][0])

    def test_gdelt_searches_the_window(self):
        task = {"query": "x sourcelang:pashto", "start": "2026-06-01", "end": "2026-06-08"}
        query = parse_qs(urlparse(news_search.gdelt_url(collector, task)).query)
        self.assertEqual((query["startdatetime"][0], query["enddatetime"][0]), ("20260601000000", "20260608000000"))
        self.assertEqual(query["maxrecords"][0], "250")


class SearchTests(unittest.TestCase):
    gdelt_task = {"source": "gdelt", "week": "2026-06-01", "query": "x sourcelang:urdu", "category": "Attacks",
                  "code": "ur", "name": "Urdu"}
    google_task = {"source": "google", "week": "2026-06-01", "query": "x", "category": "Attacks", "code": "hi",
                   "name": "Hindi", "hl": "hi", "gl": "IN", "ceid": "IN:hi"}

    def searcher(self, gets=(), google=()):
        gets, google = list(gets), list(google)
        fake = SimpleNamespace(**{name: getattr(collector, name) for name in (
            "GDELT_DOC_SEARCH_URL", "GOOGLE_NEWS_BASE", "gdelt_article_to_event", "entry_to_event", "feedparser")})
        fake.requests = SimpleNamespace(RequestException=collector.requests.RequestException,
                                        get=lambda *a, **k: gets.pop(0))
        fake.request_google_news = lambda url, label=None: google.pop(0)
        return news_search.Searcher(fake, sleep=lambda s: None, clock=lambda: 0.0)

    @staticmethod
    def text_reply(text):
        return SimpleNamespace(status_code=200, text=text, json=lambda: (_ for _ in ()).throw(ValueError("not json")))

    def test_gdelts_rate_limit_is_a_failure_to_retry_and_three_stop_it(self):
        busy = self.text_reply("Please limit requests to one every 5 seconds or contact ...")
        tries = news_search.GDELT_RATE_LIMIT_RETRIES + 1
        searcher = self.searcher([busy] * (3 * tries))
        for _ in range(3):
            with self.assertRaises(news_search.SourceUnavailable) as raised:
                searcher.search(self.gdelt_task)
            self.assertTrue(raised.exception.rate_limited)
        self.assertFalse(searcher.available("gdelt"))
        self.assertTrue(searcher.available("google"))

    def test_a_rate_limited_gdelt_search_is_asked_again_after_a_wait(self):
        too_many = SimpleNamespace(status_code=429, text="Please limit requests to one every 5 seconds")
        ok = SimpleNamespace(status_code=200, json=lambda: {"articles": []})
        searcher = self.searcher([too_many, too_many, ok])
        waits, now = [], [0.0]

        def sleep(seconds):
            waits.append(seconds)
            now[0] += seconds
        searcher.sleep, searcher.clock = sleep, lambda: now[0]
        self.assertEqual(searcher.search(self.gdelt_task), ([], False))
        backoff = news_search.GDELT_RATE_LIMIT_BACKOFF_SECONDS
        self.assertEqual(waits, [backoff, 2 * backoff])
        self.assertTrue(searcher.available("gdelt"))

    def test_another_gdelt_error_is_not_a_rate_limit(self):
        searcher = self.searcher([SimpleNamespace(status_code=503, text="")])
        with self.assertRaises(news_search.SourceUnavailable) as raised:
            searcher.search(self.gdelt_task)
        self.assertFalse(raised.exception.rate_limited)

    def test_any_other_text_from_gdelt_is_a_rejected_query(self):
        searcher = self.searcher([self.text_reply("Your search contained a phrase that is too short.")])
        with self.assertRaises(news_search.QueryRejected):
            searcher.search(self.gdelt_task)
        self.assertTrue(searcher.available("gdelt"), "a bad query does not switch GDELT off")

    def test_gdelt_articles_carry_the_searched_language(self):
        ok = SimpleNamespace(status_code=200, json=lambda: {"articles": [
            {"url": "https://ur.test/1", "title": "کراچی میں دہشت گرد حملہ", "seendate": "20260603T101500Z",
             "domain": "ur.test", "language": "Urdu"}]})
        events, full = self.searcher([ok]).search(self.gdelt_task)
        self.assertEqual((events[0]["original_language"], events[0]["published"], full),
                         ("ur", "2026-06-03T10:15:00+00:00", False))

    def test_a_full_answer_is_reported(self):
        many = SimpleNamespace(status_code=200, json=lambda: {"articles": [
            {"url": f"https://ur.test/{n}", "title": f"Headline number {n} from Karachi", "seendate": "20260603T101500Z",
             "domain": "ur.test", "language": "Urdu"} for n in range(250)]})
        self.assertTrue(self.searcher([many]).search(self.gdelt_task)[1])

    def test_a_google_search_that_got_no_feed_is_a_failure(self):
        searcher = self.searcher(google=[None, SimpleNamespace(content=b"<html>consent</html>")])
        for _ in range(2):
            with self.assertRaises(news_search.SourceUnavailable):
                searcher.search(self.google_task)

    def test_an_empty_feed_is_a_real_empty_week(self):
        empty = b'<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>'
        self.assertEqual(self.searcher(google=[SimpleNamespace(content=empty)]).search(self.google_task), ([], False))


class ArticleKeyTests(unittest.TestCase):
    def test_article_keys_are_the_headline_in_any_script(self):
        key = news_search.article_key
        self.assertEqual(key("Militants attack police post!", "Dawn"), key("militants attack police post", "DAWN"))
        self.assertEqual(key("किश्तवाड़ में आतंकी हमला", "Jagran"), key("किश्तवाड़ में आतंकी हमला।", "jagran"))
        # GDELT names the outlet by its domain, Google News by its name: one article.
        self.assertEqual(key("Militants attack police post", "france24.com"), key("Militants attack police post", "France 24"))
        self.assertNotEqual(key("Attack", "Dawn"), key("Attack", "Geo"), "a short headline needs its outlet")
        self.assertEqual(key("!!!", "Dawn"), "")

    def test_gdelt_json_with_raw_control_characters_is_read(self):
        # A raw tab inside a title: strict JSON parsing (requests' json()) refuses it.
        text = ('{"articles": [{"url": "https://ur.test/1", "title": "Karachi\tattack", '
                '"seendate": "20260603T101500Z", "domain": "ur.test", "language": "Urdu"}]}')
        reply = SimpleNamespace(status_code=200, text=text,
                                json=lambda: (_ for _ in ()).throw(ValueError("Invalid control character")))
        searcher = SearchTests.searcher(SearchTests(), [reply])
        events, _ = searcher.search(SearchTests.gdelt_task)
        self.assertEqual(len(events), 1)

    def test_indic_headlines_differing_by_a_vowel_sign_have_different_keys(self):
        a = news_search.article_key("आतंकी हमले में दो जवान शहीद", "Jagran")
        b = news_search.article_key("आतंकी हमला में दो जवान शहीद", "Jagran")
        self.assertNotEqual(a, b)
        legacy = news_search.article_key("आतंकी हमले में दो जवान शहीद", "Jagran", legacy=True)
        self.assertIn(legacy, news_search.article_keys("आतंकी हमले में दो जवान शहीद", "Jagran"),
                      "keys stored before still match")


if __name__ == "__main__":
    unittest.main()
