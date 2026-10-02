"""tools/enrich_archive.py: the six-month enrichment's plan, searches, filters
and runs, with the searches and Gemini stubbed. No network."""
import json
import sys
import tempfile
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, "tools")
import archive_review  # noqa: E402
import enrich_archive  # noqa: E402

collector = archive_review.prepare_collector(archive_review.load_collector(), threshold=60)
TODAY = date(2026, 10, 2)          # a Friday
NOW = datetime(2026, 10, 2, 0, 43, tzinfo=timezone.utc)
NEXT_NIGHT = datetime(2026, 10, 3, 0, 43, tzinfo=timezone.utc)


class PlanTests(unittest.TestCase):
    def setUp(self):
        self.tasks = enrich_archive.plan_tasks(TODAY, collector)

    def test_weeks_run_from_the_first_monday_to_the_last_settled_week_newest_first(self):
        weeks = enrich_archive.week_starts(TODAY)
        # 21-28 Sept ended 4 days ago; 28 Sept - 5 Oct has not ended: the daily collection's.
        self.assertEqual(weeks[0], date(2026, 9, 21))
        self.assertEqual(weeks[-1], enrich_archive.FIRST_WEEK)
        self.assertTrue(all(w.weekday() == 0 for w in weeks))
        self.assertEqual(enrich_archive.week_starts(date(2026, 9, 30))[0], date(2026, 9, 14))

    def test_new_languages_come_first_then_gdelt_then_daily_profiles_then_english(self):
        groups = [task["group"] for task in self.tasks]
        order = list(dict.fromkeys(groups))
        self.assertEqual(order, ["new_language", "gdelt", "daily_profile", "english"])
        self.assertEqual(groups, sorted(groups, key=order.index), "groups never interleave")
        self.assertEqual((self.tasks[0]["code"], self.tasks[0]["week"]), ("hi", "2026-09-21"))

    def test_gdelt_tasks_alternate_languages_week_by_week(self):
        gdelt = [task["code"] for task in self.tasks if task["group"] == "gdelt"][:7]
        self.assertEqual(gdelt, ["fa", "ur", "ps", "ha", "so", "sw", "fa"])

    def test_task_keys_are_unique_and_stable(self):
        keys = [task["key"] for task in self.tasks]
        self.assertEqual(len(keys), len(set(keys)))
        later = enrich_archive.plan_tasks(date(2026, 10, 9), collector)
        self.assertTrue(set(keys) <= {task["key"] for task in later}, "a later plan keeps every earlier key")

    def test_the_collections_own_queries_are_replayed_only_before_its_reviews(self):
        replayed = [task for task in self.tasks if task["group"] in ("daily_profile", "english")]
        self.assertTrue(replayed)
        self.assertTrue(all(date.fromisoformat(t["week"]) + enrich_archive.WEEK <= enrich_archive.REPLAY_UNTIL
                            for t in replayed))
        self.assertIn("2026-09-21", {t["week"] for t in self.tasks if t["group"] == "new_language"})

    def test_a_cut_short_window_splits_in_two_down_to_a_day(self):
        task = self.tasks[0]
        halves = enrich_archive.split(task)
        self.assertEqual([(h["start"], h["end"]) for h in halves],
                         [("2026-09-21", "2026-09-25"), ("2026-09-25", "2026-09-28")])
        self.assertEqual(len({task["key"], *(h["key"] for h in halves)}), 3)
        day = {**task, "start": "2026-09-21", "end": "2026-09-22"}
        self.assertEqual(enrich_archive.split(day), [])

    def test_the_daily_collection_profiles_are_not_changed(self):
        codes = {profile["code"] for profile in collector.MULTILINGUAL_PROFILES}
        self.assertFalse({"hi", "bn", "id", "so", "ha"} & codes)


class UrlTests(unittest.TestCase):
    def test_google_searches_one_week_on_the_profiles_edition(self):
        task = next(t for t in enrich_archive.plan_tasks(TODAY, collector)
                    if t["code"] == "bn" and t["week"] == "2026-06-01")
        query = parse_qs(urlparse(enrich_archive.google_url(collector, task)).query)
        self.assertTrue(query["q"][0].endswith("after:2026-06-01 before:2026-06-09"))
        self.assertEqual((query["hl"][0], query["gl"][0], query["ceid"][0]), ("bn", "BD", "BD:bn"))
        self.assertNotIn("when:", query["q"][0])

    def test_gdelt_searches_one_source_language_over_the_week(self):
        task = next(t for t in enrich_archive.plan_tasks(TODAY, collector)
                    if t["source"] == "gdelt" and t["code"] == "ps" and t["week"] == "2026-06-01")
        query = parse_qs(urlparse(enrich_archive.gdelt_url(collector, task)).query)
        self.assertTrue(query["query"][0].endswith("sourcelang:pashto"))
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
        return enrich_archive.Searcher(fake, sleep=lambda s: None, clock=lambda: 0.0)

    @staticmethod
    def text_reply(text):
        return SimpleNamespace(status_code=200, text=text, json=lambda: (_ for _ in ()).throw(ValueError("not json")))

    def test_gdelts_rate_limit_is_a_failure_to_retry_and_three_stop_it(self):
        busy = self.text_reply("Please limit requests to one every 5 seconds or contact ...")
        searcher = self.searcher([busy] * 3)
        for _ in range(3):
            with self.assertRaises(enrich_archive.SourceUnavailable):
                searcher.search(self.gdelt_task)
        self.assertFalse(searcher.available("gdelt"))
        self.assertTrue(searcher.available("google"))

    def test_any_other_text_from_gdelt_is_a_rejected_query(self):
        searcher = self.searcher([self.text_reply("Your search contained a phrase that is too short.")])
        with self.assertRaises(enrich_archive.QueryRejected):
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
            with self.assertRaises(enrich_archive.SourceUnavailable):
                searcher.search(self.google_task)

    def test_an_empty_feed_is_a_real_empty_week(self):
        empty = b'<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>'
        self.assertEqual(self.searcher(google=[SimpleNamespace(content=empty)]).search(self.google_task), ([], False))


class FilterTests(unittest.TestCase):
    def test_article_keys_are_the_headline_in_any_script(self):
        key = enrich_archive.article_key
        self.assertEqual(key("Militants attack police post!", "Dawn"), key("militants attack police post", "DAWN"))
        self.assertEqual(key("किश्तवाड़ में आतंकी हमला", "Jagran"), key("किश्तवाड़ में आतंकी हमला।", "jagran"))
        # GDELT names the outlet by its domain, Google News by its name: one article.
        self.assertEqual(key("Militants attack police post", "france24.com"), key("Militants attack police post", "France 24"))
        self.assertNotEqual(key("Attack", "Dawn"), key("Attack", "Geo"), "a short headline needs its outlet")
        self.assertEqual(key("!!!", "Dawn"), "")

    def test_only_an_articles_own_link_identifies_it(self):
        self.assertTrue(enrich_archive.link_key("https://www.dawn.com/news/1"))
        self.assertEqual(enrich_archive.link_key("https://news.google.com/rss/articles/CBMi"), "")

    def test_the_window_reads_iso_dates_and_allows_a_day_either_side(self):
        task = {"week": "2026-06-01"}
        inside = enrich_archive.in_window
        self.assertTrue(inside({"published": "2026-06-08T23:00:00+00:00"}, task, collector))
        self.assertTrue(inside({"published": "2026-05-31T10:00:00+00:00"}, task, collector))
        self.assertFalse(inside({"published": "2026-06-10T00:00:00+00:00"}, task, collector))
        self.assertFalse(inside({"published": None}, task, collector))

    def test_the_collectors_cheap_rejections_apply(self):
        self.assertTrue(enrich_archive.screen({"title": "France condemns attack in Kabul", "summary": ""}, collector))
        self.assertFalse(enrich_archive.screen({"title": "Militants kill nine in Borno attack", "summary": ""}, collector))


class FakeSearcher:
    def __init__(self, per_task, fail=(), reject=(), full=lambda task: False):
        self.per_task, self.fail, self.reject, self.full = per_task, set(fail), set(reject), full
        self.fetches, self.searched = 0, []

    def available(self, source):
        return True

    def search(self, task):
        self.fetches += 1
        self.searched.append(task["key"])
        if task["key"] in self.fail:
            raise enrich_archive.SourceUnavailable("refused")
        if task["key"] in self.reject:
            raise enrich_archive.QueryRejected("bad query")
        return [dict(event) for event in self.per_task(task)], self.full(task)


class FakeGate:
    def __init__(self, budget):
        self.max_posts, self.posts = budget, 0

    @property
    def remaining(self):
        return max(0, self.max_posts - self.posts)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def candidates(task, count):
    week = date.fromisoformat(task["week"])
    return [{"url": f"https://{task['code']}.test/{task['key']}/{n}", "title": f"{task['code']} story {task['key']} {n}",
             "original_title": f"{task['code']} story {task['key']} {n}", "summary": "",
             "published": datetime(week.year, week.month, week.day, 9, tzinfo=timezone.utc).isoformat(),
             "source": "Outlet", "original_language": task["code"], "categories": ["Attacks"], "category": "Attacks",
             "source_article_fingerprints": [f"fp-{task['key']}-{n}"]}
            for n in range(count)]


class RunTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        (self.root / "archive").mkdir()
        (self.root / "events.json").write_text(json.dumps({"events": []}), encoding="utf-8")
        self.tasks = enrich_archive.plan_tasks(TODAY, collector)
        self.calls = []

    def run_once(self, per_task, budget, max_fetches=50, score=lambda title: 70, fail=(), reject=(), now=NOW,
                 quota_after=None, deadline=1000, clock=lambda: 0.0, full=lambda task: False):
        holder = {}

        def gate_factory(posts):
            holder["gate"] = FakeGate(posts)
            return holder["gate"]

        def call_batch(payload):
            gate = holder["gate"]
            if gate.posts >= gate.max_posts:
                raise archive_review.BudgetReached("budget")
            if quota_after is not None and len(self.calls) >= quota_after:
                raise collector.AISelectionQuotaError("429")
            gate.posts += 1
            self.calls.append(len(payload))
            return [{"event_id": e["event_id"], "relevance_score": score(e["title"]), "reason": "r",
                     "categories": ["Attacks"], "english_title": "EN " + e["title"]} for e in payload]
        searcher = FakeSearcher(per_task, fail, reject, full)
        summary, stop = enrich_archive.run(self.root, collector, budget, max_fetches, today=now.date(), now=now,
                                           searcher=searcher, call_batch=call_batch, gate_factory=gate_factory,
                                           log=lambda *a: None, deadline_minutes=deadline, clock=clock)
        return summary, stop, searcher, holder["gate"] if "gate" in holder else None

    def state(self):
        return json.loads((self.root / enrich_archive.STATE_FILE).read_text(encoding="utf-8"))

    def output(self):
        files = sorted((self.root / "archive").glob("enriched-articles-*.json"))
        return [row for path in files for row in json.loads(path.read_text(encoding="utf-8"))["articles"]]

    def test_searching_stops_once_the_reviews_have_their_budget_of_work(self):
        summary, stop, searcher, _ = self.run_once(lambda task: candidates(task, 10), budget=2)
        self.assertEqual(self.calls, [25, 25])
        self.assertEqual(searcher.fetches, 5, "50 candidates found, no more searching")
        self.assertIn("budget", stop)
        rows = self.output()
        self.assertEqual(len(rows), 50)
        self.assertTrue(rows[0]["title"].startswith("EN "))
        # Filed as the map's selection files a candidate.
        self.assertEqual((rows[0]["ai_selected"], rows[0]["map_threshold"]), (True, 60))
        self.assertTrue(rows[0]["incident_id"].startswith("inc-"))
        self.assertEqual((rows[0]["enrichment"]["language"], rows[0]["original_title"][:8]), ("hi", "hi story"))

    def test_a_task_is_finished_once_all_its_candidates_are_reviewed(self):
        self.run_once(lambda task: candidates(task, 10), budget=2)
        self.assertEqual(set(self.state()["done"]), {task["key"] for task in self.tasks[:5]})

    def test_off_topic_reviews_are_remembered_and_never_sent_again(self):
        self.run_once(lambda task: candidates(task, 25), budget=1, score=lambda title: 0)
        self.assertEqual(self.output(), [])
        seen = (self.root / "archive" / "enrichment-seen-20261002.txt").read_text(encoding="utf-8").split()
        self.assertEqual(len(seen), 25)
        self.calls.clear()
        # The first task is finished; even if it were searched again its 25 are known.
        self.run_once(lambda task: candidates(task, 25), budget=1, score=lambda title: 0, now=NEXT_NIGHT)
        self.assertEqual(self.calls, [25])
        self.assertEqual(len(self.state()["done"]), 2)

    def test_kept_articles_are_known_to_the_next_run(self):
        self.run_once(lambda task: candidates(task, 25), budget=1)
        self.assertIn(enrich_archive.article_key(self.output()[0]["original_title"], "Outlet"),
                      enrich_archive.known_article_keys(self.root))

    def test_the_daily_allocation_holds_across_runs_of_one_pacific_day(self):
        original = enrich_archive.DAILY_POSTS
        enrich_archive.DAILY_POSTS = 2
        try:
            ledger_path = archive_review.ledger_path("enrichment", self.root)
            archive_review.DailyLedger(ledger_path, 2, now=NOW).save(2)
            summary, stop, searcher, gate = self.run_once(lambda task: candidates(task, 25), budget=5)
            self.assertEqual((self.calls, searcher.fetches), ([], 0))
            self.assertIn("allocation", stop)
        finally:
            enrich_archive.DAILY_POSTS = original

    def test_a_quota_stop_keeps_saved_batches_and_leaves_their_tasks_open(self):
        summary, stop, _, _ = self.run_once(lambda task: candidates(task, 30), budget=10, quota_after=1)
        self.assertIn("AISelectionQuotaError", stop)
        self.assertEqual(len(self.output()), 25)
        self.assertEqual(self.state()["done"], {}, "the first task still has 5 unreviewed candidates")

    def test_a_refused_search_stays_open_and_a_rejected_query_is_finished(self):
        refused, rejected = self.tasks[0]["key"], self.tasks[1]["key"]
        summary, _, _, _ = self.run_once(lambda task: [], budget=1, max_fetches=3, fail={refused}, reject={rejected})
        done = self.state()["done"]
        self.assertNotIn(refused, done)
        self.assertIn(rejected, done)
        self.assertIn(self.tasks[2]["key"], done, "an empty week is finished")
        self.assertEqual((summary["source_failures"], summary["query_errors"]), (1, 1))

    def test_articles_already_held_or_reviewed_are_not_sent_to_gemini(self):
        task = self.tasks[0]
        existing = candidates(task, 25)
        (self.root / "events.json").write_text(json.dumps({"events": [
            {"title": "EN x", "original_title": existing[0]["original_title"], "source": "Outlet",
             "related_articles": [{"title": existing[1]["title"], "source": "Outlet"}]}]}), encoding="utf-8")
        (self.root / "archive" / "removed-events-aged-out-202610.json").write_text(json.dumps(
            {"events": [{"title": existing[2]["title"], "source": "Outlet"}]}), encoding="utf-8")
        (self.root / "ai_article_selection_cache.json").write_text(json.dumps(
            {"items": {existing[3]["source_article_fingerprints"][0]: {"result": {}}}}), encoding="utf-8")
        summary, _, _, _ = self.run_once(lambda t: candidates(t, 25) if t["key"] == task["key"] else [], budget=1,
                                         max_fetches=1)
        self.assertEqual((summary["skipped"], summary["skipped_cached"], summary["candidates"]), (3, 1, 21))

    def test_a_cut_short_week_is_searched_again_in_halves(self):
        first = self.tasks[0]["key"]
        summary, _, searcher, _ = self.run_once(
            lambda task: candidates(task, 3), budget=1, max_fetches=3,
            full=lambda task: task["key"] == first)
        self.assertEqual(summary["split"], 1)
        searched = searcher.searched
        self.assertEqual(searched[0], first)
        halves = enrich_archive.split(self.tasks[0])
        self.assertEqual(searched[1:3], [h["key"] for h in halves], "the halves come next")
        state = self.state()
        self.assertIn(first, state["done"], "the week is covered by its halves")
        self.assertEqual(state["children"], {}, "both halves were searched and reviewed")

    def test_a_task_failing_run_after_run_is_given_up(self):
        refused = self.tasks[0]["key"]
        for night in range(enrich_archive.MAX_TASK_FAILURES):
            summary, _, _, _ = self.run_once(lambda task: [], budget=1, max_fetches=1, fail={refused},
                                             now=datetime(2026, 10, 3 + night, 0, 43, tzinfo=timezone.utc))
        self.assertEqual(summary["given_up"], 1)
        self.assertIn(refused, self.state()["done"])

    def test_the_deadline_stops_the_run_cleanly(self):
        ticks = iter([0.0] + [200 * 60.0] * 100)
        summary, stop, searcher, _ = self.run_once(lambda task: candidates(task, 10), budget=5, deadline=110,
                                                   clock=lambda: next(ticks))
        self.assertIn("deadline", stop)
        self.assertEqual((searcher.fetches, self.calls), (0, []))


if __name__ == "__main__":
    unittest.main()
