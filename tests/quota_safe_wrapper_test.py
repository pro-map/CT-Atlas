"""tools/run_collector_quota_safe.py replaces collector functions with its own
wrappers; each must keep the signature collector.main() calls it with. The
wrapper is imported in a child process so its monkeypatches never leak into
the other tests."""
import subprocess
import sys
import textwrap
import unittest

SCRIPT = textwrap.dedent('''
    import importlib.util, json, sys
    from datetime import datetime, timedelta, timezone
    sys.path.insert(0, "tools")
    spec = importlib.util.spec_from_file_location("quota_safe", "tools/run_collector_quota_safe.py")
    wrapper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(wrapper)
    collector = wrapper.collector
    now = datetime.now(timezone.utc)
    def event(url, days, score):
        return {"url": url, "title": "JNIM fighters attack army post in Mali", "summary": "",
                "published": (now - timedelta(days=days)).isoformat(),
                "ai_selection_complete": True, "ai_relevance_score": score}
    aged_out = []
    kept = collector.prune_old([event("https://a/recent", 2, 85), event("https://a/old", collector.RETENTION_DAYS + 3, 85),
                                event("https://a/below", 2, 40)], aged_out)
    print(json.dumps({"kept": [e["url"] for e in kept], "aged_out": [e["url"] for e in aged_out],
                      "wrapped": collector.prune_old is wrapper.prune}))
''')

# Gemini requests from the collection are spaced at least 6 seconds apart
# (10 a minute); other requests are not slowed down.
PACING = textwrap.dedent('''
    import importlib.util, json, sys
    from types import SimpleNamespace
    sys.path.insert(0, "tools")
    spec = importlib.util.spec_from_file_location("quota_safe", "tools/run_collector_quota_safe.py")
    wrapper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(wrapper)
    clock, sleeps = [100.0], []
    def sleep(seconds):
        sleeps.append(round(seconds, 3))
        clock[0] += seconds
    wrapper.time = SimpleNamespace(monotonic=lambda: clock[0], sleep=sleep)
    wrapper.POST = lambda url, *args, **kwargs: SimpleNamespace(status_code=200)
    post = wrapper.collector.requests.post
    gemini = "https://generativelanguage.googleapis.com/v1beta/interactions"
    post(gemini, json={})
    clock[0] += 2
    post(gemini, json={})
    post("https://news.example/rss")
    clock[0] += 10
    post(gemini, json={})
    print(json.dumps({"sleeps": sleeps}))
''')


# Once 3.5 Flash Lite's selection budget is spent, or it answers 429, the
# remaining selection requests go to the overflow model within its own budget.
# Run from an empty directory: no real selection cache, so no usage carried in.
OVERFLOW = textwrap.dedent('''
    import importlib.util, json, os, sys
    from types import SimpleNamespace
    os.environ.update({"AI_SELECTION_MAX_CALLS_PER_RUN": "1", "AI_SELECTION_DAILY_CALL_BUDGET": "60",
                       "AI_SELECTION_OVERFLOW_MODEL": "gemini-3.1-flash-lite",
                       "AI_SELECTION_OVERFLOW_MAX_CALLS_PER_RUN": "2",
                       "AI_SELECTION_OVERFLOW_DAILY_CALL_BUDGET": "50"})
    if len(sys.argv) > 2 and sys.argv[2] == "off":
        os.environ["AI_SELECTION_OVERFLOW_MODEL"] = ""
    root = sys.argv[1]
    sys.path.insert(0, os.path.join(root, "tools"))
    spec = importlib.util.spec_from_file_location("quota_safe", os.path.join(root, "tools", "run_collector_quota_safe.py"))
    wrapper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(wrapper)
    wrapper.time = SimpleNamespace(monotonic=lambda: 0.0, sleep=lambda s: None)
    sent, statuses = [], list(json.loads(sys.argv[3]) if len(sys.argv) > 3 else [])
    def fake_post(url, *args, **kwargs):
        sent.append(kwargs["json"]["model"])
        return SimpleNamespace(status_code=statuses.pop(0) if statuses else 200, json=lambda: {}, text="")
    wrapper.POST = fake_post
    body = {"model": "gemini-3.5-flash-lite", "system_instruction": "You are the final editorial relevance filter",
            "input": "Review every candidate. " + json.dumps({"events": [{"event_id": "evt-9"}]})}
    gemini = "https://generativelanguage.googleapis.com/v1beta/interactions"
    errors = []
    for _ in range(4):
        try:
            wrapper.collector.requests.post(gemini, json=body)
        except wrapper.collector.AISelectionQuotaError as error:
            errors.append(str(error)[:60])
    cache = {"items": {"fp-new": {"reviewed_at": "2999-01-01T00:00:00+00:00", "result": {"event_id": "evt-9"}},
                       "fp-old": {"reviewed_at": "2000-01-01T00:00:00+00:00", "result": {"event_id": "evt-9"}}}}
    usage = wrapper.inject(cache)["selection_quota_usage"]
    print(json.dumps({"sent": sent, "errors": errors, "body_model": body["model"], "hit429": wrapper.hit429,
                      "overflow429": wrapper.overflow429, "budget_hit": wrapper.budget_hit,
                      "overflow_calls": usage["overflow_calls"], "calls": usage["calls"],
                      "marked": sorted(k for k, v in cache["items"].items() if v.get("model"))}))
''')


QUOTA_RESTORE=textwrap.dedent('''
    import importlib.util, json, os, sys
    from datetime import datetime
    from pathlib import Path
    from zoneinfo import ZoneInfo
    root=sys.argv[1]
    Path("ai_article_selection_cache.json").write_text(json.dumps({
        "version":"obsolete-editorial-version","items":{},
        "selection_quota_usage":{"pacific_day":datetime.now(ZoneInfo("America/Los_Angeles")).date().isoformat(),
                                 "calls":17,"overflow_calls":9}}))
    sys.path.insert(0,os.path.join(root,"tools"))
    spec=importlib.util.spec_from_file_location("quota_safe",os.path.join(root,"tools","run_collector_quota_safe.py"))
    wrapper=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(wrapper)
    print(json.dumps({"primary":wrapper.today_calls(),"overflow":wrapper.today_overflow()}))
''')


# Real collector selection, fake deterministic batches and an in-memory cache:
# these cases exercise safe publication and persistent identities without an AI
# request or any durable repository data changes.
LANE_SELECTION = textwrap.dedent('''
    import importlib.util, json, os, sys
    from datetime import datetime, timedelta, timezone
    from types import SimpleNamespace
    root, mode = sys.argv[1:3]
    os.environ.update({"AI_SELECTION_BATCH_SIZE": "1", "AI_SELECTION_MAX_CALLS_PER_RUN": "10",
                       "AI_SELECTION_DAILY_CALL_BUDGET": "60", "AI_SELECTION_OVERFLOW_MODEL": "",
                       "AI_SELECTION_HISTORICAL_MAX_CALLS_PER_RUN": "3",
                       "AI_SELECTION_MAINTENANCE_MAX_CALLS_PER_RUN": "1"})
    if mode == "budget":
        os.environ["AI_SELECTION_MAX_CALLS_PER_RUN"] = "1"
    elif mode == "daily_budget":
        os.environ["AI_SELECTION_DAILY_CALL_BUDGET"] = "1"
    sys.path.insert(0, os.path.join(root, "tools"))
    spec = importlib.util.spec_from_file_location("quota_safe", os.path.join(root, "tools", "run_collector_quota_safe.py"))
    wrapper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(wrapper)
    collector = wrapper.collector
    collector.AI_SELECTION_ENABLED = True
    collector.BACKFILL_ACTIVE = False
    wrapper.official_result = lambda event: None
    wrapper.time = SimpleNamespace(monotonic=lambda: 0.0, sleep=lambda seconds: None)
    cache = {"version": collector.AI_SELECTION_VERSION, "items": {}}
    collector.load_selection_cache = lambda: cache
    wrapper.SAVE_CACHE = lambda current: cache.update(current)
    background = []
    collector.persist_background_articles = lambda events: background.extend(event["id"] for event in events)
    now = datetime.now(timezone.utc)
    def event(key, age=0):
        return {"id": key, "url": "https://example.test/" + key,
                "title": "ISIS attack kills one in Nigeria " + key, "summary": "",
                "categories": ["Attacks"], "published": (now - timedelta(days=age)).isoformat()}
    def decision(key, score=85):
        return {"event_id": key, "relevance_score": score, "is_current_ct_event": True,
                "categories": ["Attacks"], "original_language": "en",
                "english_title": "ISIS attacked a patrol in Nigeria " + key,
                "english_summary": "An attack occurred in Nigeria.",
                "canonical_event": "ISIS patrol attack " + key, "reason": "Confirmed incident.",
                "primary_event_type": "ATTACK", "incident_anchor": "ISIS patrol attack " + key,
                "update_type": "INITIAL"}
    sent, batches = [], []
    def fake_post(url, *args, **kwargs):
        sent.append(wrapper.ACTIVE_LANE)
        status = 429 if mode == "quota" and len(sent) == 2 else 200
        return SimpleNamespace(status_code=status, json=lambda: {}, text="")
    wrapper.POST = fake_post
    def process(batch):
        batches.append([candidate["event_id"] for candidate in batch])
        fail = len(batches) == 2 or mode == "cached"
        if fail and mode in ("transient", "cached"):
            raise collector.AISelectionTransientError("Temporary provider failure")
        if fail and mode == "incomplete":
            raise collector.AISelectionIncompleteError("Missing result in response")
        collector.requests.post("https://generativelanguage.googleapis.com/v1beta/interactions",
                                json={"model": "gemini-test", "system_instruction": "final editorial relevance filter"})
        return [decision(candidate["event_id"], 40 if candidate["event_id"].endswith("reject") else 85)
                for candidate in batch]
    wrapper.PROCESS_BATCH = process
    events = [event("r1"), event("r2"), event("r3")]
    result = []
    if mode == "mixed":
        events = [event("b1", 20), event("r1"), event("b2", 12), event("r2")]
        result = collector.ai_select_events(events)
    elif mode == "reservation":
        result.extend(collector.ai_select_events([event("m1", 45), event("m2", 44)], lane="maintenance"))
        result.extend(collector.ai_select_events([event("b1", 20), event("b2", 19), event("b3", 18)], lane="backlog"))
        result.extend(collector.ai_select_events([event("r1"), event("r2")], lane="recent"))
    elif mode == "cached":
        events = [event("r1"), event("r-reject"), event("r3")]
        for item in events[:2]:
            cache["items"][collector.selection_fingerprint(item)] = {
                "version": collector.AI_SELECTION_VERSION,
                "result": decision(item["id"], 40 if item["id"].endswith("reject") else 85)}
        result = collector.ai_select_events(events, lane="recent")
    elif mode == "maintenance_cache":
        events = [event("m1", 20), event("m2", 19)]
        for item in events:
            verdict=decision(item["id"])
            if item["id"]=="m1":
                verdict.pop("incident_anchor")
            cache["items"][collector.selection_fingerprint(item)]={
                "version":collector.AI_SELECTION_VERSION,"result":verdict}
        result=collector.ai_select_events(events,lane="maintenance")
    elif mode == "manual_backfill":
        collector.BACKFILL_ACTIVE=True
        events=[event("b"+str(index),20+index) for index in range(5)]
        result=collector.ai_select_events(events,lane="backlog")
    elif mode == "repeat":
        events = events[:1]
        result = collector.ai_select_events(events, lane="recent")
        collector.ai_select_events(events, lane="recent")
        collector.ai_select_events([], lane="backlog")
    else:
        result = collector.ai_select_events(events, lane="recent")
    print(json.dumps({"retained": [item["id"] for item in result], "sent": sent, "batches": batches,
                      "telemetry": collector.selection_runtime_status(), "background": background,
                      "complete": [collector.selection_review_complete(item) for item in events],
                      "mutated_pending": [item["id"] for item in events if not collector.selection_review_complete(item)
                                           and item.get("ai_selection_complete")],
                      "cached_telemetry": cache["selection_runtime_telemetry"]}))
''')


def run(script, *args, cwd=None):
    import json
    result = subprocess.run([sys.executable, "-c", script, *args], capture_output=True, text=True, timeout=120, cwd=cwd)
    if result.returncode:
        raise AssertionError(result.stderr[-2000:])
    return json.loads(result.stdout.strip().splitlines()[-1])


class QuotaSafeWrapperTests(unittest.TestCase):
    def test_wrapped_prune_old_keeps_the_aged_out_hand_over(self):
        data = run(SCRIPT)
        self.assertTrue(data["wrapped"])
        self.assertEqual(data["kept"], ["https://a/recent"])          # below-threshold event cleaned up
        self.assertEqual(data["aged_out"], ["https://a/old"])         # aged-out event handed over

    def test_gemini_calls_are_paced_to_ten_a_minute(self):
        self.assertEqual(run(PACING)["sleeps"], [4.0])

    def overflow(self, *args):
        import os
        import tempfile
        with tempfile.TemporaryDirectory() as empty:
            return run(OVERFLOW, os.getcwd(), *args, cwd=empty)

    def test_selection_moves_to_the_overflow_model_within_its_budget(self):
        data = self.overflow("on")
        self.assertEqual(data["sent"], ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.1-flash-lite"])
        self.assertEqual(len(data["errors"]), 1)
        self.assertIn("budget reached", data["errors"][0])
        self.assertEqual((data["calls"], data["overflow_calls"]), (1, 2))
        self.assertEqual(data["body_model"], "gemini-3.5-flash-lite", "the collector's own body is never changed")
        self.assertFalse(data["hit429"])
        self.assertTrue(data["budget_hit"], "if the overflow model fails, the run still publishes what was reviewed")
        self.assertEqual(data["marked"], ["fp-new"], "only this run's overflow reviews name the overflow model")

    def test_reviews_on_the_main_model_name_no_other_model(self):
        self.assertEqual(self.overflow("off")["marked"], [])

    def test_a_429_on_the_main_model_is_resent_on_the_overflow_model(self):
        data = self.overflow("on", "[429]")
        self.assertEqual(data["sent"][:2], ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"])
        self.assertTrue(data["hit429"], "3.5 Flash Lite is spent: the weekly analysis is skipped as before")
        self.assertEqual(data["overflow_calls"], 2)

    def test_a_429_on_the_overflow_model_stops_the_selection(self):
        data = self.overflow("on", "[200, 429]")
        self.assertEqual(data["sent"], ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"])
        self.assertTrue(data["overflow429"] and data["budget_hit"])
        self.assertFalse(data["hit429"], "3.5 Flash Lite itself is not out of quota")
        self.assertEqual(len(data["errors"]), 3)

    def test_without_an_overflow_model_the_budget_stops_the_selection(self):
        data = self.overflow("off")
        self.assertEqual(data["sent"], ["gemini-3.5-flash-lite"])
        self.assertEqual((len(data["errors"]), data["overflow_calls"]), (3, 0))

    def lanes(self, mode):
        import os
        import tempfile
        with tempfile.TemporaryDirectory() as empty:
            return run(LANE_SELECTION, os.getcwd(), mode, cwd=empty)

    def test_editorial_cache_version_change_does_not_reset_real_daily_usage(self):
        import os
        import tempfile
        with tempfile.TemporaryDirectory() as empty:
            data=run(QUOTA_RESTORE,os.getcwd(),cwd=empty)
        self.assertEqual(data,{"primary":17,"overflow":9})

    def test_recent_and_backlog_use_separate_newest_first_batches(self):
        data = self.lanes("mixed")
        self.assertEqual(data["batches"], [["r1"], ["r2"], ["b2"], ["b1"]])
        self.assertEqual(data["sent"], ["recent", "recent", "backlog", "backlog"])
        lanes = data["telemetry"]["lanes"]
        self.assertEqual((lanes["recent"]["candidates"], lanes["backlog"]["candidates"]), (2, 2))
        self.assertFalse(data["telemetry"]["partial"])

    def test_historical_caps_reserve_calls_even_if_maintenance_is_called_first(self):
        data = self.lanes("reservation")
        self.assertEqual(data["sent"], ["maintenance", "backlog", "backlog", "recent", "recent"])
        lanes = data["telemetry"]["lanes"]
        self.assertEqual(lanes["maintenance"]["pending"], 1)
        self.assertEqual(lanes["maintenance"]["reasons"], ["maintenance_budget"])
        self.assertEqual(lanes["backlog"]["pending"], 1)
        self.assertEqual(lanes["backlog"]["reasons"], ["historical_budget"])
        self.assertEqual(lanes["recent"]["status"], "complete")
        self.assertEqual(data["telemetry"]["budgets"]["historical_calls_used"], 3)

    def test_self_budget_returns_completed_reviews_and_preserves_pending(self):
        data = self.lanes("budget")
        self.assertEqual(data["retained"], ["r1"])
        self.assertEqual(data["complete"], [True, False, False])
        self.assertEqual(data["mutated_pending"], [])
        recent = data["telemetry"]["lanes"]["recent"]
        self.assertEqual((recent["reviewed"], recent["pending"], recent["new_reviews"]), (1, 2, 1))
        self.assertEqual(recent["reasons"], ["run_budget"])
        self.assertEqual(data["cached_telemetry"]["lanes"], data["telemetry"]["lanes"])

    def test_daily_envelope_is_independent_of_the_larger_run_envelope(self):
        data = self.lanes("daily_budget")
        self.assertEqual(data["retained"], ["r1"])
        self.assertEqual(data["sent"], ["recent"])
        self.assertEqual(data["telemetry"]["daily_call_budget"], 1)
        self.assertEqual(data["telemetry"]["lanes"]["recent"]["reasons"], ["daily_budget"])

    def test_a_provider_429_still_publishes_completed_decisions(self):
        data = self.lanes("quota")
        self.assertEqual(data["retained"], ["r1"])
        self.assertTrue(data["telemetry"]["partial"])
        self.assertTrue(data["telemetry"]["gemini_429"])
        self.assertEqual(data["telemetry"]["lanes"]["recent"]["reasons"], ["primary_quota_429"])
        self.assertEqual(data["mutated_pending"], [])

    def test_transient_and_incomplete_failures_are_partial_with_separate_reasons(self):
        for mode, reason in (("transient", "transient_error"), ("incomplete", "incomplete_response")):
            with self.subTest(mode=mode):
                data = self.lanes(mode)
                self.assertEqual(data["retained"], ["r1"])
                self.assertTrue(data["telemetry"]["partial"])
                self.assertEqual(data["telemetry"]["lanes"]["recent"]["reasons"], [reason])
                self.assertFalse(data["telemetry"]["budget_reached"])
                self.assertEqual(data["complete"], [True, False, False])

    def test_cached_retained_and_rejected_decisions_do_not_count_as_new_ai_reviews(self):
        data = self.lanes("cached")
        recent = data["telemetry"]["lanes"]["recent"]
        self.assertEqual((recent["candidates"], recent["reviewed"], recent["cached"], recent["new_reviews"]), (3, 2, 2, 0))
        self.assertEqual((recent["retained"], recent["rejected"], recent["pending"]), (1, 1, 1))
        self.assertEqual(data["background"], ["r-reject"])
        self.assertEqual(data["sent"], [])

    def test_maintenance_refreshes_only_unstructured_cached_verdicts(self):
        data=self.lanes("maintenance_cache")
        self.assertEqual(data["batches"], [["m1"]])
        self.assertEqual(data["sent"], ["maintenance"])
        lane=data["telemetry"]["lanes"]["maintenance"]
        self.assertEqual((lane["cached"],lane["new_reviews"],lane["pending"]), (1,1,0))

    def test_explicit_manual_backfill_keeps_its_global_envelope(self):
        data=self.lanes("manual_backfill")
        self.assertEqual(len(data["sent"]),5)
        self.assertEqual(data["telemetry"]["lanes"]["backlog"]["pending"],0)

    def test_translated_fingerprints_remain_reviewed_and_do_not_recount_or_spend_again(self):
        data = self.lanes("repeat")
        self.assertEqual(data["complete"], [True])
        self.assertEqual(data["sent"], ["recent"])
        recent = data["telemetry"]["lanes"]["recent"]
        self.assertEqual((recent["candidates"], recent["reviewed"], recent["new_reviews"]), (1, 1, 1))
        self.assertEqual(data["telemetry"]["lanes"]["backlog"]["candidates"], 0)
        self.assertEqual(data["telemetry"]["lanes"]["backlog"]["status"], "complete")



if __name__ == "__main__":
    unittest.main()
