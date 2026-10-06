"""tools/make_auth_users.py hashes passwords the way the Worker checks them and
never prints a password or writes the roster inside the repository."""
import contextlib
import hashlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("make_auth_users", "tools/make_auth_users.py")
make = importlib.util.module_from_spec(spec)
spec.loader.exec_module(make)


def answers(*values):
    queue = list(values)
    return lambda prompt="": queue.pop(0)


def run(argv, ask):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = make.main(argv, ask=ask)
    return code, out.getvalue(), err.getvalue()


class MakeAuthUsersTests(unittest.TestCase):
    def test_template_covers_groups_i_s_p_11_to_20(self):
        rule = "Rule-{GROUP}{number}-{group}"
        code, out, err = run(["--template"], answers(rule, rule))
        self.assertEqual(code, 0)
        roster = json.loads(out)
        self.assertEqual(len(roster), 30)
        self.assertEqual(sorted({name.rsplit("-", 1)[0] for name in roster}), ["group-i", "group-p", "group-s"])
        self.assertEqual(roster["group-i-11"], hashlib.sha256(b"Rule-I11-i").hexdigest())
        self.assertEqual(roster["group-s-20"], hashlib.sha256(b"Rule-S20-s").hexdigest())
        self.assertNotIn("Rule-", out + err, "no password or rule is ever printed")

    def test_individual_passwords_are_confirmed(self):
        code, out, _ = run(["--groups", "s", "--first", "11", "--last", "11"],
                           answers("one", "typo", "secret-pass", "secret-pass"))
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), {"group-s-11": hashlib.sha256(b"secret-pass").hexdigest()})

    def test_roster_is_never_written_inside_the_repository(self):
        with self.assertRaises(SystemExit):
            run(["--template", "--out", "roster.json"], answers("x{number}", "x{number}"))
        self.assertFalse(Path("roster.json").exists())
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "roster.json"
            code, out, _ = run(["--template", "--groups", "p", "--out", str(target)], answers("x{number}", "x{number}"))
            self.assertEqual(code, 0)
            self.assertEqual(out, "")
            self.assertEqual(len(json.loads(target.read_text(encoding="utf-8"))), 10)


if __name__ == "__main__":
    unittest.main()
