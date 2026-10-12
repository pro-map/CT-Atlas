import importlib.util
import io
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("wrangler_retry", ROOT / "tools/wrangler_retry.py")
retry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retry)


class WranglerRetryTest(unittest.TestCase):
    def run_case(self, results):
        calls, delays, out, err = [], [], io.StringIO(), io.StringIO()
        results = iter(results)

        def runner(command, **kwargs):
            calls.append(command)
            result = next(results)
            if isinstance(result, Exception):
                raise result
            return subprocess.CompletedProcess(command, *result)

        code = retry.run_wrangler(["deploy", "--keep-vars"], runner=runner,
                                  sleeper=delays.append, stdout=out, stderr=err)
        return code, calls, delays, out.getvalue(), err.getvalue()

    def test_timeout_then_malformed_200_response_then_success(self):
        code, calls, delays, out, err = self.run_case([
            (1, "", "GET workers/services -> 504 Gateway Timeout"),
            (1, "", "Received a malformed response from the API; deployments -> 200 OK"),
            (0, "Current Version ID: verified-version", ""),
        ])
        self.assertEqual(code, 0)
        self.assertEqual(delays, [10, 20])
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[0], ["npx", "--yes", "wrangler@4.149.0", "deploy", "--keep-vars"])
        self.assertIn("verified-version", out)

    def test_permanent_auth_or_configuration_failure_is_not_retried(self):
        code, calls, delays, _, _ = self.run_case([(1, "", "Authentication error 10000: invalid API token")])
        self.assertEqual(code, 1)
        self.assertEqual(len(calls), 1)
        self.assertEqual(delays, [])

    def test_persistent_failure_never_reports_success(self):
        code, calls, delays, _, _ = self.run_case([(1, "", "503 Service Unavailable")] * 3)
        self.assertEqual(code, 1)
        self.assertEqual(len(calls), 3)
        self.assertEqual(delays, [10, 20])

    def test_command_timeout_is_bounded_and_retried(self):
        code, calls, delays, _, _ = self.run_case([
            subprocess.TimeoutExpired("npx", 300), (0, "deployed", "")])
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 2)
        self.assertEqual(delays, [10])

    def test_json_stdout_stays_separate_from_retry_diagnostics(self):
        code, _, _, out, err = self.run_case([(0, '[{"name":"AUTH_USERS_JSON"}]', "")])
        self.assertEqual(code, 0)
        self.assertEqual(out, '[{"name":"AUTH_USERS_JSON"}]')
        self.assertEqual(err, "")

    def test_secret_input_is_replayed_in_memory_and_never_in_arguments(self):
        payload = "synthetic-secret-for-test"
        inputs, out, err = [], io.StringIO(), io.StringIO()

        def runner(command, **kwargs):
            self.assertNotIn(payload, " ".join(command))
            inputs.append(kwargs['input'])
            return subprocess.CompletedProcess(command, 1 if len(inputs) == 1 else 0,
                                               "", "503 Service Unavailable" if len(inputs) == 1 else "")

        code = retry.run_wrangler(["secret", "put", "TEST_SECRET"], input_data=payload,
                                  runner=runner, sleeper=lambda _: None, stdout=out, stderr=err)
        self.assertEqual(code, 0)
        self.assertEqual(inputs, [payload, payload])
        self.assertNotIn(payload, out.getvalue() + err.getvalue())


if __name__ == "__main__":
    unittest.main()
