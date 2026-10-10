"""The Windows/local runner never sends secrets to GitHub or writes them to disk."""
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "experiments"))
import run_local_pilot as runner


class LocalRunnerTests(unittest.TestCase):
    def test_refuse_user_opt_in_without_api_call(self):
        with mock.patch("builtins.input", side_effect=["3", "non"]):
            with mock.patch.object(runner.pilot, "main",
                                   side_effect=AssertionError("Unexpected API")):
                self.assertEqual(runner.main(), 0)

    def test_groq_free_plan_must_be_confirmed(self):
        with mock.patch("builtins.input", side_effect=["1", "oui", "non"]):
            with mock.patch.object(runner.pilot, "main",
                                   side_effect=AssertionError("Unexpected API")):
                self.assertEqual(runner.main(), 0)

    def test_one_groq_synthetic_call_and_clear_credentials_afterward(self):
        seen = {}
        def fake(argv, env):
            seen["args"] = argv
            seen["env"] = env
            seen["key_while_running"] = env["GROQ_API_KEY"]
            return 0
        with mock.patch("builtins.input", side_effect=["1", "oui", "oui"]):
            with mock.patch.object(runner.getpass, "getpass", return_value="FAKE_ONLY"):
                with mock.patch.object(runner.pilot, "main", side_effect=fake):
                    self.assertEqual(runner.main(), 0)
        self.assertEqual(seen["args"],
                         ["--mode", "live", "--provider", "groq", "--max-per-provider", "1"])
        self.assertEqual(seen["key_while_running"], "FAKE_ONLY")
        self.assertEqual(seen["env"], {}, "Credentials cleared on completion")

    def test_cloudflare_account_and_key_not_logged_or_saved(self):
        seen = {}
        def fake(argv, env):
            seen["account_while_running"] = env["CLOUDFLARE_AI_ACCOUNT_ID"]
            seen["key_while_running"] = env["CLOUDFLARE_AI_API_TOKEN"]
            seen["reference"] = env
        with mock.patch("builtins.input", side_effect=[
                "2", "oui", "oui", "c" * 32]):
            with mock.patch.object(runner.getpass, "getpass", return_value="MOCK_TOKEN"):
                with mock.patch.object(runner.pilot, "main", side_effect=fake):
                    self.assertEqual(runner.main(), 0)
        self.assertEqual(seen["account_while_running"], "c" * 32)
        self.assertEqual(seen["key_while_running"], "MOCK_TOKEN")
        self.assertEqual(seen["reference"], {})

    def test_provider_refusal_does_not_echo_key(self):
        fake_error = runner.pilot.PilotSafetyError("Provider HTTP 403; no retry")
        with mock.patch("builtins.input", side_effect=["1", "oui", "oui"]):
            with mock.patch.object(runner.getpass, "getpass", return_value="NEVER_PRINT_TOKEN"):
                with mock.patch.object(runner.pilot, "main", side_effect=fake_error):
                    with mock.patch("builtins.print") as show:
                        self.assertEqual(runner.main(), 1)
        printed = " ".join(" ".join(map(str, row.args)) for row in show.call_args_list)
        self.assertNotIn("NEVER_PRINT_TOKEN", printed)


if __name__ == "__main__":
    unittest.main()
