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


class QuotaSafeWrapperTests(unittest.TestCase):
    def test_wrapped_prune_old_keeps_the_aged_out_hand_over(self):
        result = subprocess.run([sys.executable, "-c", SCRIPT], capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        import json
        data = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertTrue(data["wrapped"])
        self.assertEqual(data["kept"], ["https://a/recent"])          # below-threshold event cleaned up
        self.assertEqual(data["aged_out"], ["https://a/old"])         # aged-out event handed over


if __name__ == "__main__":
    unittest.main()
