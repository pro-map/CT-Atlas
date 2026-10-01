"""Event ids from collector.create_event_id and the uniqueness guard in
deduplicate_incremental. The old id hashed a Latin-only slug of the title plus
the date, so every Arabic/Russian/Hebrew/Chinese headline of a day shared one
id. No network access."""
import hashlib
import importlib.util
import io
import unittest
from contextlib import redirect_stdout

import feedparser

spec = importlib.util.spec_from_file_location("collector", "collector.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)

DAY = "2026-09-29"
# The id every non-Latin headline of DAY used to get: sha256("" + "|" + DAY).
OLD_SHARED_ID = hashlib.sha256(("|" + DAY).encode("utf-8")).hexdigest()[:16]


def legacy_id(title, published):
    key = collector.normalize_title(title) + "|" + str(published)[:10]
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def rss_entry(title, link, published="Tue, 29 Sep 2026 10:00:00 GMT", source="Outlet"):
    return feedparser.FeedParserDict(
        title=f"{title} - {source}",
        link=link,
        summary="",
        published=published,
        source=feedparser.FeedParserDict(title=source),
    )


def stored_event(event_id, title, url, published=f"{DAY}T10:00:00+00:00", country="Iraq"):
    return {
        "id": event_id,
        "title": title,
        "original_title": title,
        "summary": "",
        "url": url,
        "source": "Outlet",
        "published": published,
        "category": "Attacks",
        "categories": ["Attacks"],
        "country": country,
    }


def quietly(function, *args):
    with redirect_stdout(io.StringIO()):
        return function(*args)


class NonLatinTitleIdTests(unittest.TestCase):
    def test_different_non_latin_events_on_the_same_day_get_different_ids(self):
        events = [
            ("مقتل خمسة جنود في هجوم على نقطة تفتيش شمال العراق", "https://news.example/ar/1"),
            ("اعتقال خلية إرهابية تخطط لتفجير في عمان", "https://news.example/ar/2"),
            ("Задержан сторонник ИГ, готовивший теракт в Москве", "https://news.example/ru/1"),
            ("Суд вынес приговор за финансирование терроризма", "https://news.example/ru/2"),
            ("סוכל פיגוע ירי בצומת גוש עציון", "https://news.example/he/1"),
            ("警方破获一起恐怖袭击阴谋", "https://news.example/zh/1"),
        ]
        ids = [collector.create_event_id(title, f"{DAY}T08:00:00+00:00", url) for title, url in events]

        self.assertEqual(len(set(ids)), len(events))
        self.assertNotIn(OLD_SHARED_ID, ids)

    def test_titles_reduced_to_a_meaningless_latin_slug_get_different_ids(self):
        # Both reduce to the slug "7", and both to "newsru co il", under the old id.
        pairs = [
            (("צה\"ל חיסל מחבל שהשתתף בטבח ה-7 באוקטובר", "https://news.example/he/2"),
             ("הוארך מעצרו של מחבל שהשתתף בטבח ב-7 באוקטובר", "https://news.example/he/3")),
            (("Задержан подозреваемый в подготовке теракта - NEWSru.co.il", "https://news.example/ru/3"),
             ("Предъявлено обвинение террористу - NEWSru.co.il", "https://news.example/ru/4")),
        ]
        for (title_a, url_a), (title_b, url_b) in pairs:
            with self.subTest(title_a=title_a):
                self.assertEqual(legacy_id(title_a, DAY), legacy_id(title_b, DAY))
                self.assertNotEqual(
                    collector.create_event_id(title_a, DAY, url_a),
                    collector.create_event_id(title_b, DAY, url_b),
                )

    def test_the_same_non_latin_article_keeps_its_id_when_collected_again(self):
        title = "مقتل خمسة جنود في هجوم على نقطة تفتيش شمال العراق"
        first = collector.create_event_id(title, f"{DAY}T08:00:00+00:00", "https://news.example/ar/1?oc=5")
        # Later fetch: other time of day, tracking parameter gone, spacing and
        # an HTML entity differ in the feed's title.
        again = collector.create_event_id(
            "  مقتل خمسة جنود في هجوم على نقطة تفتيش  شمال العراق&nbsp;",
            f"{DAY}T21:30:00+00:00",
            "https://NEWS.example/ar/1/",
        )
        self.assertEqual(first, again)

    def test_one_non_latin_headline_from_two_outlets_gets_two_ids(self):
        title = "اعتقال خلية إرهابية تخطط لتفجير في عمان"
        self.assertNotEqual(
            collector.create_event_id(title, DAY, "https://one.example/a"),
            collector.create_event_id(title, DAY, "https://two.example/b"),
        )

    def test_the_date_still_separates_non_latin_events(self):
        title = "اعتقال خلية إرهابية تخطط لتفجير في عمان"
        url = "https://news.example/ar/2"
        self.assertNotEqual(
            collector.create_event_id(title, "2026-09-29T10:00:00+00:00", url),
            collector.create_event_id(title, "2026-09-30T10:00:00+00:00", url),
        )


class LatinTitleIdTests(unittest.TestCase):
    def test_latin_titles_keep_the_ids_already_stored_in_events_json(self):
        # Pinned from the formula before the fix (sample titles, not records of
        # events.json): a Latin headline must get exactly the id the old
        # formula gave it, so a re-collected article matches its stored event.
        pinned = {
            "Police arrest three suspects over planned attack on Berlin synagogue": "8cbfc4dadd2d09ef",
            "Okul saldırısı: 42 öğrenci kaçırıldı": "eb2965f89a288464",
            "Attentat déjoué à Marseille : deux hommes mis en examen": "ff3ffd86d8253875",
        }
        for title, expected in pinned.items():
            with self.subTest(title=title):
                for url in (None, "https://one.example/a", "https://two.example/b"):
                    self.assertEqual(collector.create_event_id(title, f"{DAY}T10:00:00+00:00", url), expected)
                self.assertEqual(legacy_id(title, DAY), expected)


class CollectorPipelineIdTests(unittest.TestCase):
    def test_google_news_entries_of_one_day_get_distinct_and_repeatable_ids(self):
        entries = [
            rss_entry("مقتل خمسة جنود في هجوم على نقطة تفتيش شمال العراق", "https://news.google.com/rss/articles/AAA?oc=5"),
            rss_entry("Задержан сторонник ИГ, готовивший теракт в Москве", "https://news.google.com/rss/articles/BBB?oc=5"),
            rss_entry("סוכל פיגוע ירי בצומת גוש עציון", "https://news.google.com/rss/articles/CCC?oc=5"),
        ]
        first = [collector.entry_to_event(entry, ["Attacks"])["id"] for entry in entries]
        again = [collector.entry_to_event(entry, ["Attacks"])["id"] for entry in entries]

        self.assertEqual(len(set(first)), 3)
        self.assertEqual(first, again)

    def test_gdelt_articles_of_one_day_get_distinct_ids(self):
        articles = [
            {"url": "https://ar.example/1", "title": "مقتل خمسة جنود في هجوم على نقطة تفتيش شمال العراق",
             "seendate": "20260929T081500Z", "language": "Arabic", "domain": "ar.example"},
            {"url": "https://ar.example/2", "title": "اعتقال خلية إرهابية تخطط لتفجير في عمان",
             "seendate": "20260929T091500Z", "language": "Arabic", "domain": "ar.example"},
        ]
        ids = {collector.gdelt_article_to_event(article, ["Attacks"])["id"] for article in articles}
        self.assertEqual(len(ids), 2)


class IncrementalDeduplicationIdTests(unittest.TestCase):
    def test_a_recollected_article_merges_and_keeps_the_stored_legacy_id(self):
        title = "مقتل خمسة جنود في هجوم على نقطة تفتيش شمال العراق"
        url = "https://news.example/ar/1"
        existing = stored_event(OLD_SHARED_ID, title, url)
        fresh = stored_event(collector.create_event_id(title, DAY, url), title, url, f"{DAY}T18:00:00+00:00")
        self.assertNotEqual(fresh["id"], OLD_SHARED_ID)

        events = quietly(collector.deduplicate_incremental, [existing], [fresh])

        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["id"], OLD_SHARED_ID)

    def test_a_new_cluster_never_takes_an_id_already_in_the_database(self):
        def run():
            existing = stored_event("8cbfc4dadd2d09ef", "Police arrest three suspects over planned attack on Berlin synagogue",
                                    "https://one.example/berlin", country="Germany")
            # Same id, different article that event_match keeps separate.
            fresh = stored_event("8cbfc4dadd2d09ef", "Pirates hijack fishing dhow off the coast of Puntland",
                                 "https://two.example/puntland", country="Somalia")
            fresh["category"] = "Maritime Piracy"
            fresh["categories"] = ["Maritime Piracy"]
            return quietly(collector.deduplicate_incremental, [existing], [fresh])

        events = run()

        self.assertEqual(len(events), 2)
        self.assertEqual(events[0]["id"], "8cbfc4dadd2d09ef")
        self.assertNotEqual(events[1]["id"], "8cbfc4dadd2d09ef")
        self.assertEqual(events[1]["id"], run()[1]["id"])

    def test_unused_event_id_keeps_a_free_id_and_avoids_taken_ones(self):
        event = {"id": "abc", "url": "https://x.example/1", "published": f"{DAY}T10:00:00+00:00"}
        self.assertEqual(collector.unused_event_id(event, {"other"}), "abc")

        replacement = collector.unused_event_id(event, {"abc"})
        self.assertNotEqual(replacement, "abc")
        self.assertNotIn(collector.unused_event_id(event, {"abc", replacement}), {"abc", replacement})
        self.assertNotEqual(collector.unused_event_id({**event, "id": ""}, set()), "")


if __name__ == "__main__":
    unittest.main()
