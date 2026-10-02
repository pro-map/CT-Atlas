"""Tests for tools/archive_dedup.py: one copy per story in the D1 archive.

tests/same_story_cases.json is generated from the Worker's shared.js
(normalizeTitle, isSameStory); the Python rule must agree with it exactly, so
the archive and the Worker never disagree on what a duplicate is."""
import importlib.util
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("archive_dedup", "tools/archive_dedup.py")
dedup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dedup)

CASES = json.loads(Path("tests/same_story_cases.json").read_text(encoding="utf-8"))


def same_story(a, a_date, b, b_date):
    index = dedup.StoryIndex()
    index.add(a, "", dedup.row_time({"published": a_date}), "a")
    return index.find(b, "", dedup.row_time({"published": b_date})) == "a"


def row(url, kind, title, published=None, score=None, collected_at="2026-09-20T00:00:00+00:00"):
    return {"url": url, "kind": kind, "title": title, "published": published,
            "ai_relevance_score": score, "collected_at": collected_at}


class SameRuleAsTheWorkerTests(unittest.TestCase):
    def test_titles_normalise_exactly_like_shared_js(self):
        for case in CASES["titles"]:
            with self.subTest(title=case["title"]):
                self.assertEqual(dedup.normalize_title(case["title"]), case["normalized"])

    def test_same_story_verdicts_match_shared_js(self):
        for case in CASES["pairs"]:
            with self.subTest(a=case["a"], b=case["b"]):
                self.assertEqual(same_story(case["a"], case["a_date"], case["b"], case["b_date"]), case["same"])
                self.assertEqual(same_story(case["b"], case["b_date"], case["a"], case["a_date"]), case["same"])

    def test_headlines_naming_different_places_are_different_stories(self):
        self.assertTrue(dedup.names_differ(
            "Police arrest suspect after stabbing in Hamburg station",
            "Police arrest suspect after stabbing in Munich station",
        ))
        self.assertFalse(dedup.names_differ(
            "Turkish Navy Helps Free Hijacked Vessel With Somali Pirates",
            "Turkish navy frees hijacked vessel from pirates off Somalia",
        ))


class PlanArchiveTests(unittest.TestCase):
    def test_off_topic_reviews_are_removed(self):
        stored = [row("gemini-review:1", "historical_review", "Yacht sale in Monaco", score=0),
                  row("gemini-review:2", "historical_review", "Analysis of JNIM strategy in Mali", score=35)]
        insert, delete = dedup.plan_archive(stored, [])
        self.assertEqual(insert, [])
        self.assertEqual([(url, reason) for url, reason, _ in delete], [("gemini-review:1", "noise")])

    def test_only_the_best_copy_of_a_story_is_kept(self):
        title = "Saudi and Yemeni forces kill an Islamic State leader in eastern Yemen"
        stored = [
            row("gemini-review:x", "historical_review", title, score=40, collected_at="2026-09-21T00:00:00+00:00"),
            row("https://removed/1", "removed_event", title, published="2026-09-20T10:00:00+00:00", score=70),
            row("https://related/1", "related_article", title, published="2026-09-20T09:00:00+00:00"),
        ]
        _, delete = dedup.plan_archive(stored, [])
        self.assertEqual(sorted(url for url, _, _ in delete), ["gemini-review:x", "https://removed/1"])
        self.assertTrue(all(kept == "https://related/1" for _, _, kept in delete))

    def test_among_equal_copies_the_most_recent_is_kept(self):
        stored = [
            row("https://a/early", "related_article", "Suicide bomber attacks police station in Quetta",
                published="2026-09-25T07:00:00+00:00"),
            row("https://a/late", "related_article", "Suicide bomber attacks police station in Quetta, officials say",
                published="2026-09-25T10:00:00+00:00"),
        ]
        _, delete = dedup.plan_archive(stored, [])
        self.assertEqual(delete, [("https://a/early", "duplicate_story", "https://a/late")])

    def test_a_better_new_copy_replaces_a_stored_review(self):
        title = "Analysis: why JNIM targets fuel convoys around Bamako"
        stored = [row("gemini-review:old", "historical_review", title, score=35)]
        new = [row("https://outlet/analysis", "historical_review", title, published="2026-09-20T06:00:00+00:00", score=35)]
        insert, delete = dedup.plan_archive(stored, new)
        self.assertEqual([r["url"] for r in insert], ["https://outlet/analysis"])
        self.assertEqual(delete, [("gemini-review:old", "duplicate_story", "https://outlet/analysis")])

    def test_new_rows_never_repeat_a_stored_link_or_each_other(self):
        stored = [row("https://same/link", "related_article", "Kidnappers seize twenty villagers in Zamfara",
                      published="2026-09-20T09:00:00+00:00")]
        new = [
            row("https://same/link", "related_article", "Kidnappers seize twenty villagers in Zamfara"),
            row("https://wire/a", "related_article", "Gunmen abduct 30 worshippers from church in Kaduna",
                published="2026-09-21T09:00:00+00:00"),
            row("https://wire/b", "related_article", "Gunmen abduct 30 worshippers from church in Kaduna state",
                published="2026-09-21T10:00:00+00:00"),
        ]
        insert, delete = dedup.plan_archive(stored, new)
        self.assertEqual(len(insert), 1)
        self.assertIn(insert[0]["url"], {"https://wire/a", "https://wire/b"})
        self.assertEqual(delete, [])

    def test_the_same_headline_a_week_apart_is_two_stories(self):
        title = "ISIS-K member sentenced to 20 years for Kabul airport bombing death of Marine"
        stored = [row("https://a/1", "related_article", title, published="2026-09-01T10:00:00+00:00"),
                  row("https://a/2", "related_article", title, published="2026-09-09T10:00:00+00:00")]
        self.assertEqual(dedup.plan_archive(stored, []), ([], []))

    def test_distinct_incidents_with_formula_headlines_are_all_kept(self):
        stored = [
            row("https://ru/1", "historical_review", "Tyumen resident sentenced to 8 years in prison for terrorist financing",
                published="2026-09-20T10:00:00+00:00", score=40),
            row("https://ru/2", "historical_review", "Chuvashia Resident Sentenced to Prison for Terrorist Financing",
                published="2026-09-21T10:00:00+00:00", score=40),
            row("https://pk/1", "related_article", "Six terrorists killed in Balochistan operations",
                published="2026-09-20T10:00:00+00:00"),
            row("https://pk/2", "related_article", "49 terrorists killed in joint operations in KP and Balochistan",
                published="2026-09-21T10:00:00+00:00"),
        ]
        self.assertEqual(dedup.plan_archive(stored, []), ([], []))

    def test_a_translation_and_its_untranslated_twin_are_one_story(self):
        stored = [
            row("https://tr/1", "related_article", "İstanbul'da DEAŞ operasyonu! Şüpheli polise ateş açtı",
                published="2026-09-20T09:00:00+00:00"),
            {**row("https://tr/2", "related_article", "ISIS operation in Istanbul! Suspect opens fire on police",
                   published="2026-09-20T10:00:00+00:00"),
             "original_title": "İstanbul'da DEAŞ operasyonu! Şüpheli polise ateş açtı"},
        ]
        _, delete = dedup.plan_archive(stored, [])
        self.assertEqual(len(delete), 1)
        self.assertEqual(delete[0][1], "duplicate_story")

    def test_a_review_dated_only_by_its_review_day_meets_its_twin_weeks_later(self):
        title = "Nigerian Air Force takes delivery of five new helicopters for anti-terror operations"
        stored = [
            row("https://ng/1", "rejected_candidate", title, published="2026-09-15T08:00:00+00:00", score=45),
            row("gemini-review:late", "historical_review", title, score=45, collected_at="2026-10-01T08:00:00+00:00"),
        ]
        _, delete = dedup.plan_archive(stored, [])
        self.assertEqual(delete, [("gemini-review:late", "duplicate_story", "https://ng/1")])

    def test_a_review_with_the_same_headline_word_for_word_is_its_article_months_later(self):
        title = "Damascus Bombing: 9 Dead, 20 Injured; Strong Condemnation from Turkey"
        stored = [
            row("https://sy/1", "rejected_candidate", title, published="2026-07-04T08:00:00+00:00", score=30),
            row("gemini-review:twin", "historical_review", title, score=30, collected_at="2026-09-30T08:00:00+00:00"),
        ]
        _, delete = dedup.plan_archive(stored, [])
        self.assertEqual(delete, [("gemini-review:twin", "duplicate_story", "https://sy/1")])

    def test_dated_articles_keep_the_five_day_window(self):
        title = "Nigerian Air Force takes delivery of five new helicopters for anti-terror operations"
        stored = [
            row("https://ng/1", "related_article", title, published="2026-09-15T08:00:00+00:00"),
            row("https://ng/2", "related_article", title, published="2026-10-01T08:00:00+00:00"),
        ]
        self.assertEqual(dedup.plan_archive(stored, []), ([], []))

    def test_a_row_repeating_a_map_event_is_removed_the_map_holds_the_incident(self):
        # When the event ages out, the collector archives it as an archived
        # incident: the story is never lost.
        event = {"id": "evt", "url": "https://map/lead", "title": "Suicide bomber attacks police station in Quetta",
                 "published": "2026-09-20T08:00:00+00:00",
                 "related_articles": [{"url": "https://map/other", "title": "Quetta police station hit by suicide blast"}]}
        stored = [
            row("https://a/copy", "archived_incident", "Suicide bomber attacks police station in Quetta, officials say",
                published="2026-09-20T10:00:00+00:00"),
            row("https://map/other", "related_article", "Quetta police station hit by suicide blast",
                published="2026-09-20T11:00:00+00:00"),
            row("https://b/other-story", "archived_incident", "Gunmen abduct 30 worshippers from church in Kaduna",
                published="2026-09-20T10:00:00+00:00"),
        ]
        _, delete = dedup.plan_archive(stored, [], map_stories=[event])
        self.assertEqual(sorted((url, reason, kept) for url, reason, kept in delete), [
            ("https://a/copy", "on_map", "https://map/lead"),
            ("https://map/other", "on_map", "https://map/lead"),
        ])

    def test_dropped_kinds_are_never_kept(self):
        stored = [row("https://wire/1", "related_article", "Gunmen abduct 30 worshippers from church in Kaduna",
                      published="2026-09-20T10:00:00+00:00")]
        new = [row("https://wire/2", "related_article", "Kidnappers seize twenty villagers in Zamfara")]
        insert, delete = dedup.plan_archive(stored, new, drop_kinds={"related_article"})
        self.assertEqual((insert, delete), ([], [("https://wire/1", "other_outlet_report", "")]))


if __name__ == "__main__":
    unittest.main()
