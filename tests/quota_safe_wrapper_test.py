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


if __name__ == "__main__":
    unittest.main()
