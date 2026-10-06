"""Build the AUTH_USERS_EXTRA_JSON roster for new CT Atlas accounts.

Run this on your own computer. Passwords are typed at hidden prompts, hashed
in memory exactly the way the Worker checks them (SHA-256 of the password),
and never printed or written anywhere. Only {"username": "sha256"} JSON is
produced, which becomes the Cloudflare Worker secret AUTH_USERS_EXTRA_JSON.

Accounts in that secret are added to the ones in AUTH_USERS_JSON; an account
that already exists there keeps its current password.

Default accounts: group-i-11..20, group-s-11..20, group-p-11..20.

Same rule for every account (asked once, then confirmed):
    py -3.11 tools/make_auth_users.py --template
  The rule may use {group} (i, s, p), {GROUP} (I, S, P), {number} (11..20)
  and {username} (group-i-11 ...), e.g. a rule like  Name-{GROUP}{number}!

One password per account (each asked twice):
    py -3.11 tools/make_auth_users.py

Send it straight to Cloudflare without saving it anywhere:
    py -3.11 tools/make_auth_users.py --template | npx wrangler secret put AUTH_USERS_EXTRA_JSON --config cloudflare-worker/wrangler.toml
"""
import argparse
import getpass
import hashlib
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
USERNAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")


def usernames(groups, first, last):
    return [f"group-{group}-{number}" for group in groups for number in range(first, last + 1)]


def password_hash(password):
    return hashlib.sha256(password.encode("utf-8")).hexdigest()


def apply_template(template, username):
    _, group, number = username.split("-", 2)
    return (template.replace("{username}", username).replace("{group}", group)
            .replace("{GROUP}", group.upper()).replace("{number}", number))


def ask_twice(prompt, ask=getpass.getpass):
    while True:
        first = ask(prompt)
        if not first:
            print("Empty password, try again.", file=sys.stderr)
            continue
        if ask("Repeat to confirm: ") == first:
            return first
        print("The two entries differ, try again.", file=sys.stderr)


def build_roster(names, template=None, ask=getpass.getpass):
    roster = {}
    for username in names:
        password = apply_template(template, username) if template is not None else \
            ask_twice(f"Password for {username}: ", ask)
        roster[username] = password_hash(password)
    return roster


def main(argv=None, ask=getpass.getpass):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--groups", default="i,s,p", help="comma-separated groups (default i,s,p)")
    parser.add_argument("--first", type=int, default=11)
    parser.add_argument("--last", type=int, default=20)
    parser.add_argument("--template", action="store_true", help="one password rule for every account")
    parser.add_argument("--out", help="write the JSON to this file (must be outside the repository)")
    args = parser.parse_args(argv)

    groups = [g.strip().lower() for g in args.groups.split(",") if g.strip()]
    names = usernames(groups, args.first, args.last)
    if not names or not all(USERNAME.match(name) for name in names) or args.first > args.last:
        parser.error("no valid usernames to create")
    if args.out and REPO in Path(args.out).resolve().parents:
        parser.error("refusing to write the roster inside the repository; it must never be committed")

    print(f"Creating {len(names)} accounts: {names[0]} ... {names[-1]}", file=sys.stderr)
    template = None
    if args.template:
        template = ask_twice("Password rule (hidden, e.g. uses {GROUP} and {number}): ", ask)
        if not any(token in template for token in ("{group}", "{GROUP}", "{number}", "{username}")):
            print("Warning: the rule has no placeholder, so every account gets the same password.",
                  file=sys.stderr)
    roster = build_roster(names, template, ask)
    payload = json.dumps(roster, separators=(",", ":"))

    if args.out:
        Path(args.out).write_text(payload, encoding="utf-8")
        print(f"Wrote {len(roster)} hashes to {args.out}. Delete the file once the secret is set.",
              file=sys.stderr)
    else:
        sys.stdout.write(payload)
        sys.stdout.flush()
        print(f"\n{len(roster)} hashes generated (no password was printed).", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
