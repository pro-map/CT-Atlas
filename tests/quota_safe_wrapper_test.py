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


def run(script):
    import json
    result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=120)
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


if __name__ == "__main__":
    unittest.main()
