"""New text files are stored with LF. The files listed here predate the policy
and keep their bytes; renormalising index.html would conflict with every agent."""
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
KEEP_THEIR_ENDINGS = {
    "index.html": "crlf",
    "privacy.html": "mixed",
    "requirements.txt": "crlf",
    "crypto.css": "mixed",
    "crypto.js": "mixed",
    "tests/exchange-paths.test.cjs": "mixed",
}


def stored_endings():
    listing = subprocess.run(["git", "ls-files", "--eol"], cwd=ROOT, capture_output=True,
                             text=True, encoding="utf-8", check=True).stdout
    endings = {}
    for line in listing.splitlines():
        info, path = line.split("\t", 1)
        endings[path.strip('"')] = info.split()[0].removeprefix("i/")
    return endings


class EolPolicyTests(unittest.TestCase):
    def test_no_new_file_is_stored_with_carriage_returns(self):
        found = {path: eol for path, eol in stored_endings().items() if eol in ("crlf", "mixed")}
        self.assertEqual(sorted(set(found) - set(KEEP_THEIR_ENDINGS)), [])

    def test_a_listed_file_comes_off_the_list_once_it_is_clean(self):
        endings = stored_endings()
        changed = {path: endings.get(path) for path, eol in KEEP_THEIR_ENDINGS.items()
                   if path in endings and endings[path] != eol and endings[path] not in ("lf", "crlf", "mixed")}
        self.assertEqual(changed, {})


if __name__ == "__main__":
    unittest.main()
