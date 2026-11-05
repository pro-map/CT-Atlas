"""Text deduplication and the collection's own duplicate work: identical
headlines respect the 7-day window, headlines in another script are not
compared through their Latin residue, a template headline that only swaps the
city does not merge, an article already held by a record or by the daily queue
is not reviewed again, alias chains survive the consolidation state, and one
collection wave asks Google News once per URL. No network access."""
import importlib.util
import io
import os
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import daily_pipeline

spec = importlib.util.spec_from_file_location("collector", "collector.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


def record(title, day, url, country="Turkey", source="Outlet", summary="", **extra):
    return {
        "id": url.rsplit("/", 1)[-1], "title": title, "original_title": title,
        "summary": summary, "url": url, "source": source,
        "published": f"{day}T10:00:00+00:00", "category": "Attacks",
        "categories": ["Attacks"], "country": country, **extra,
    }


def quietly(function, *args):
    with redirect_stdout(io.StringIO()):
        return function(*args)


def match(title1, title2, day1="2026-10-31", day2="2026-10-31"):
    return collector.event_match(record(title1, day1, "https://a.test/1"),
                                 record(title2, day2, "https://b.test/2"))


class TimeWindowTests(unittest.TestCase):
    RECAAP = "ReCAAP ISC reports two armed robbery incidents at sea"

    def test_an_identical_bulletin_headline_36_days_later_is_a_new_incident(self):
        existing = record(self.RECAAP, "2026-06-09", "https://safety4sea.test/june", "Singapore")
        fresh = record(self.RECAAP, "2026-07-15", "https://safety4sea.test/july", "Singapore")
        self.assertEqual(collector.profile_pair_score(fresh, existing)[2], "outside_time_window")
        self.assertFalse(collector.event_match(fresh, existing)[0])

        events = quietly(collector.deduplicate_incremental, [existing], [fresh])

        self.assertEqual(len(events), 2)
        self.assertEqual([e["published"][:10] for e in events], ["2026-06-09", "2026-07-15"])

    def test_an_identical_headline_two_days_apart_still_merges(self):
        title = "Gunmen kill five villagers in Zamfara state raid"
        self.assertEqual(match(title, title, "2026-10-29", "2026-10-31")[:1], (True,))
        self.assertEqual(match(title, title, "2026-10-29", "2026-10-31")[2], "same_normalized_title")

    def test_the_same_link_still_merges_whatever_the_dates(self):
        old = record(self.RECAAP, "2026-06-09", "https://safety4sea.test/a")
        again = record(self.RECAAP, "2026-07-15", "https://safety4sea.test/a/")
        self.assertEqual(collector.profile_pair_score(again, old)[2], "same_url")


class NonLatinHeadlineTests(unittest.TestCase):
    def test_two_unrelated_hebrew_headlines_with_a_hyphen_stay_apart(self):
        # Both reduce to "-" under the Latin-only normalization (record 22c7d6f26bbb).
        strike = record("דיווח: מחבל חוסל בתקיפה ממוקדת של רכב בשכונת תל אל-הווא ברצועת עזה",
                        "2026-11-02", "https://he.test/1", "Palestinian Territory")
        arrest = record("מחבל בחנות הבגדים: הלוחמים הגיעו בהסוואה - המבוקש נכנע ונעצר",
                        "2026-11-02", "https://he.test/2", "Palestinian Territory")
        self.assertEqual(collector.profile_pair_score(strike, arrest), (False, 0.0, "non_comparable_title"))
        self.assertEqual(len(quietly(collector.deduplicate_events, [strike, arrest])), 2)

    def test_headlines_sharing_only_a_number_or_a_latin_word_stay_apart(self):
        pairs = [
            ("مقتل 3 جنود في هجوم بسيناء", "مقتل 3 مدنيين في قصف على غزة"),
            ("تجريف الأراضي واقتلاع 300 شجرة زيتون في القنيطرة",
             "بعد التوقف والتوترات.. انتعاش الأجواء العراقية بعبور 300 طائرة يومياً"),
            ("В Волгограде мужчину задержали за комментарии в Telegram",
             "Волгоградского подростка будут судить за призывы к терроризму в Telegram"),
        ]
        for title1, title2 in pairs:
            with self.subTest(title1=title1):
                a, b = record(title1, "2026-10-31", "https://x.test/1"), record(title2, "2026-10-31", "https://x.test/2")
                self.assertEqual(collector.profile_pair_score(a, b)[2], "non_comparable_title")
                self.assertFalse(collector.event_match(a, b)[0])

    def test_a_non_latin_article_still_merges_through_its_link(self):
        title = "مقتل خمسة جنود في هجوم على نقطة تفتيش شمال العراق"
        a = record(title, "2026-10-31", "https://ar.test/1?oc=5", "Iraq")
        b = record(title, "2026-10-31", "https://ar.test/1", "Iraq")
        self.assertEqual(collector.event_match(a, b), (True, 1.0, "same_url"))


class TemplateHeadlineTests(unittest.TestCase):
    def test_city_substitutions_in_a_template_headline_do_not_merge(self):
        # Haber 7 headlines merged into records d6732066a9e9 and db670aa3e63b.
        pairs = [
            ("Van'daki terör saldırısı", "Silvan'daki terör saldırısı"),
            ("Ankara'daki terör saldırısı", "Hakkari'deki terör saldırısı"),
            ("Bitlis'teki terör saldırısı", "İdlib'deki terör saldırısı"),
            ("Bitlis'te terör operasyonu", "Siirt'te terör operasyonu"),
            ("Counter-terrorism operation in Sirnak", "Counter-terrorism operation in Bitlis"),
        ]
        for title1, title2 in pairs:
            with self.subTest(title1=title1):
                self.assertFalse(match(title1, title2)[0])

    def test_one_haber7_batch_keeps_one_cluster_per_city(self):
        titles = ["Van'daki terör saldırısı", "Silvan'daki terör saldırısı", "Ankara'daki terör saldırısı",
                  "Hakkari'deki terör saldırısı", "Van'da terör saldırısı", "Hakkari'daki terör saldırısı"]
        records = [record(t, "2026-10-31", f"https://haber7.test/{n}", source="Haber 7") for n, t in enumerate(titles)]
        clusters = quietly(collector.deduplicate_events, records)
        self.assertEqual(len(clusters), 4, "Van, Silvan, Ankara and Hakkari")

    def test_wire_rewrites_and_translations_still_merge(self):
        pairs = [
            ("Liberadas cerca de 50 personas secuestradas en el noreste de RDC por un grupo vinculado a Estado Islámico",
             "Liberadas cerca de 50 pessoas sequestradas no nordeste da RDC por um grupo ligado ao Estado Islâmico"),
            ("Arrestado en Siria un destacado cabecilla de Estado Islámico por el ataque a una mezquita alauí en Homs",
             "Arrestado na Síria um destacado chefe do Estado Islâmico pelo ataque a uma mesquita alauíta em Homs"),
            ("Zim confirm loss of container ship attacked in Black Sea",
             "Zim Confirms Loss of Containership Attacked in Black Sea off Bulgaria"),
            ("22-year-old neo-Nazi arrested in Milan for planning attacks against synagogues and mosques",
             "22-year-old arrested in Milan for planning attacks on a synagogue and mosque"),
            ("Houthis launch cross-border raids on Saudi military positions",
             "Houthis launched cross border raids on Saudi military posts, sources say"),
            ("Attentat raciste de Trappes : Kévin Tessier s’entraînait au fusil à pompe, selon Mediapart",
             "Attentat raciste à Trappes : Kévin Tessier s’entraînait au fusil à pompe selon Médiapart"),
            ("Van'daki terör saldırısı", "Van'da terör saldırısı"),
        ]
        for title1, title2 in pairs:
            with self.subTest(title1=title1):
                self.assertEqual(match(title1, title2)[:1], (True,))
                self.assertEqual(match(title1, title2)[2], "very_high_title_similarity")

    def test_soft_hyphens_inside_words_do_not_split_them(self):
        soft, zero_width = "\N{SOFT HYPHEN}", "\N{ZERO WIDTH SPACE}"
        hyphenated = (f"Mut{soft}maß{soft}li{soft}che Sa{soft}bo{soft}teu{soft}re nach "
                      f"Starlink-{zero_width}Anschlag fest{soft}ge{soft}nom{soft}men")
        self.assertTrue(match("Mutmaßliche Saboteure nach Starlink-Anschlag festgenommen", hyphenated)[0])

    def test_headline_stems_drop_apostrophe_suffixes_and_elided_articles(self):
        self.assertEqual(collector.headline_stems({"van'daki", "van'da", "silvan'daki"}), {"van", "silvan"})
        self.assertEqual(collector.headline_stems({"l'attaque", "dell'attentato", "pakistan's", "'quoted'"}),
                         {"attaque", "attentato", "pakistan", "quoted"})


class AlreadyHeldArticleTests(unittest.TestCase):
    GNEWS = "https://news.google.com/rss/articles/"

    def setUp(self):
        collector.COLLECTION_STATS.clear()
        self.existing = record("Attack on the embassy in Belgrade", "2026-10-28", "https://outlet.test/belgrade",
                               "Serbia", ai_selection_complete=True,
                               related_articles=[{"title": "Embassy attacked in Belgrade", "summary": "s",
                                                  "url": self.GNEWS + "CBMiAAA?oc=5", "source": "Wire",
                                                  "published": "2026-10-28T12:00:00+00:00"}])

    def test_a_refetched_article_with_an_edited_headline_is_not_reviewed_again(self):
        fresh = [
            record("UPDATE: Embassy attacked in Belgrade, one wounded", "2026-10-28", self.GNEWS + "CBMiAAA?oc=5", "Serbia"),
            record("Attack on the embassy in Belgrade - Outlet", "2026-10-28", "https://outlet.test/belgrade/", "Serbia"),
            record("Another attack elsewhere", "2026-10-28", "https://outlet.test/other", "Serbia"),
        ]
        pending = quietly(collector.exclude_reviewed_articles, fresh, [self.existing])
        self.assertEqual([e["url"] for e in pending], ["https://outlet.test/other"])
        self.assertEqual(collector.COLLECTION_STATS["already_reviewed_articles"], 2)

    def test_only_reviewed_records_hold_their_links(self):
        # Same rule as the fingerprints: a record Gemini never reviewed does not block.
        self.existing["ai_selection_complete"] = False
        fresh = [record("UPDATE: Embassy attacked", "2026-10-28", self.GNEWS + "CBMiAAA?oc=5", "Serbia")]
        self.assertEqual(len(quietly(collector.exclude_reviewed_articles, fresh, [self.existing])), 1)

    def test_the_daily_queue_drops_a_fresh_copy_of_a_queued_link(self):
        now = datetime(2026, 10, 29, 9, 0, tzinfo=timezone.utc)
        queued = record("Gunmen attack police post in Kidal", "2026-10-28", "https://outlet.test/kidal", "Mali",
                        related_articles=[{"title": "Kidal police post attacked", "summary": "",
                                           "url": self.GNEWS + "CBMiKID?oc=5", "source": "Wire",
                                           "published": "2026-10-28T11:00:00+00:00"}])
        fresh = [
            # Same links, headline edited since it was queued.
            record("Gunmen attack police post in Kidal, two killed", "2026-10-28", "https://outlet.test/kidal", "Mali"),
            record("Kidal: police post attacked overnight", "2026-10-28", self.GNEWS + "CBMiKID?oc=7", "Mali"),
            record("Bomb defused in Gao market", "2026-10-28", "https://outlet.test/gao", "Mali"),
        ]
        saved = collector.deduplicate_events
        collector.deduplicate_events = lambda rows: rows
        try:
            recent, backlog, _ = daily_pipeline.prepare(fresh, [queued], [], collector, now)
        finally:
            collector.deduplicate_events = saved
        self.assertEqual([e["url"] for e in recent], ["https://outlet.test/kidal", "https://outlet.test/gao"])
        self.assertIs(recent[0], queued, "the queued cluster itself is kept unchanged")
        self.assertEqual(backlog, [])


class AliasChainTests(unittest.TestCase):
    def test_an_alias_to_a_merged_incident_is_re_pointed_not_dropped(self):
        state = {"version": 1, "reviewed": {},
                 "aliases": {"inc-a": "inc-b", "inc-b": "inc-c", "inc-x": "inc-gone",
                             "inc-loop1": "inc-loop2", "inc-loop2": "inc-loop1"}}
        events = [{"id": "e1", "incident_id": "inc-c"}, {"id": "e2", "incident_id": "inc-loop1"}]
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "state.json"
            collector.save_incident_state(state, events, path)
            saved = collector.load_incident_state(path)
        self.assertEqual(saved["aliases"], {"inc-a": "inc-c", "inc-b": "inc-c", "inc-loop2": "inc-loop1"})
        self.assertEqual(collector.resolve_incident_alias("inc-a", saved["aliases"]), "inc-c")


class Response:
    def __init__(self, status):
        self.status_code, self.headers = status, {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise collector.requests.HTTPError(str(self.status_code))


class GoogleNewsWaveMemoTests(unittest.TestCase):
    def setUp(self):
        self.saved = (collector.session, collector.time, collector._collect_all_once,
                      collector.COLLECTION_STARTED, collector.SERVER_ERROR_STREAK)
        self.requested = []
        self.replies = {}
        collector.time = SimpleNamespace(sleep=lambda seconds: None, monotonic=time.monotonic)
        collector.COLLECTION_STARTED = time.monotonic()

        def get(url, timeout):
            self.requested.append(url)
            statuses = self.replies.get(url)
            return Response(statuses.pop(0) if statuses else 200)
        collector.session = SimpleNamespace(get=get)

    def tearDown(self):
        (collector.session, collector.time, collector._collect_all_once,
         collector.COLLECTION_STARTED, collector.SERVER_ERROR_STREAK) = self.saved
        collector.QUERY_STATS.clear()

    def test_a_repeated_url_is_requested_once_per_wave(self):
        url, other, failing = ("https://news.google.com/rss/search?q=" + q for q in ("isis", "pkk", "down"))
        self.replies[failing] = [503, 503, 200]
        answers = []

        def wave(days):
            for each in (url, other, url, failing, failing, url):
                answers.append(collector._request_google_news_network(each))
            return dict(collector.QUERY_STATS)
        collector._collect_all_once = wave

        stats = quietly(collector.collect_all, 3)

        # The failed query was not remembered: its second call asked Google again.
        self.assertEqual(self.requested, [url, other, failing, failing, failing])
        self.assertIs(answers[2], answers[0])
        self.assertIs(answers[5], answers[0])
        self.assertIsNone(answers[3])
        self.assertEqual(answers[4].status_code, 200)
        self.assertEqual(stats["deduplicated_urls"], 2)
        self.assertEqual(stats["successful"], 5, "memo answers still count as successful queries")
        self.assertEqual(stats["failed"], 1)
        self.assertIsNone(collector.GOOGLE_NEWS_WAVE_RESPONSES, "released after the wave")

    def test_a_retry_wave_asks_google_again(self):
        url = "https://news.google.com/rss/search?q=isis"
        waves = []

        def wave(days):
            waves.append(dict(collector.GOOGLE_NEWS_WAVE_RESPONSES))
            collector._request_google_news_network(url)
            collector._request_google_news_network(url)
            if len(waves) == 1:
                raise RuntimeError("Too many Google News queries failed (70/100).")
            return dict(collector.QUERY_STATS)
        collector._collect_all_once = wave

        stats = quietly(collector.collect_all, 3)

        self.assertEqual(waves, [{}, {}], "every wave starts with an empty memo")
        self.assertEqual(self.requested, [url, url])
        self.assertEqual(stats["deduplicated_urls"], 1)

    def test_outside_a_collection_nothing_is_remembered(self):
        url = "https://news.google.com/rss/search?q=isis"
        collector._request_google_news_network(url)
        collector._request_google_news_network(url)
        self.assertEqual(self.requested, [url, url])
        self.assertEqual(collector.QUERY_STATS["deduplicated_urls"], 0)


if __name__ == "__main__":
    unittest.main()
