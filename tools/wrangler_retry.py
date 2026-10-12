"""Run a pinned Wrangler command, retrying only transient Cloudflare failures."""
import subprocess
import sys
import time

WRANGLER_VERSION = "4.149.0"  # Version used by the last successful production deploy.
TRANSIENT_ERRORS = (
    "received a malformed response from the api",
    "gateway timeout", "bad gateway", "service unavailable",
    "too many requests", "429", "500 internal server", "502", "503", "504",
    "econnreset", "etimedout", "eai_again", "fetch failed",
)


def run_wrangler(args, *, runner=subprocess.run, sleeper=time.sleep, attempts=3, input_data=None,
                 stdout=None, stderr=None):
    stdout = sys.stdout if stdout is None else stdout
    stderr = sys.stderr if stderr is None else stderr
    command = ["npx", "--yes", f"wrangler@{WRANGLER_VERSION}", *args]
    for attempt in range(1, attempts + 1):
        try:
            result = runner(command, capture_output=True, text=True, timeout=300, input=input_data)
        except subprocess.TimeoutExpired:
            result = subprocess.CompletedProcess(command, 124, "", "Wrangler command timed out.\n")
        stdout.write(result.stdout or "")
        stderr.write(result.stderr or "")
        stdout.flush()
        stderr.flush()
        if result.returncode == 0:
            return 0
        output = ((result.stdout or "") + (result.stderr or "")).lower()
        retryable = result.returncode == 124 or any(marker in output for marker in TRANSIENT_ERRORS)
        if not retryable or attempt == attempts:
            return result.returncode
        delay = 10 * attempt
        print(f"::warning::Transient Cloudflare response; retrying Wrangler in {delay}s "
              f"(attempt {attempt + 1}/{attempts}).", file=stderr, flush=True)
        sleeper(delay)
    return 1


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("Usage: wrangler_retry.py <Wrangler command and arguments>")
    args = sys.argv[1:]
    # Replay secret input only from memory. Never put it in argv, files or diagnostics.
    input_data = sys.stdin.read() if args[:2] == ["secret", "put"] else None
    raise SystemExit(run_wrangler(args, input_data=input_data))
