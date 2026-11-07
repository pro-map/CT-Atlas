#!/usr/bin/env bash
# Pushes the commit a data workflow has just made to main: fetch, rebase onto
# main, check the rebased tree, push. A push that loses the race to another
# writer is tried again, 5 times in all, 4, 8, 12 and 16 s apart.
#
# A rebase merges events.json as text, so two writers' edits on different lines
# can merge without a conflict into a database that no longer parses or holds an
# id twice. When the rebased commit changes events.json, it must pass the
# snapshot step's rule (daily_reliability.rows) before it is pushed.
#
# Exit status 1, with nothing pushed: a rebase conflict (the rebase is aborted),
# a rebased events.json that fails the check, or 5 failed tries.
#
# Usage, from the repository root after `git commit`: bash tools/push_data_commit.sh
set -euo pipefail

check_rebased_database() {
  if git diff --quiet origin/main HEAD -- events.json; then
    return 0
  fi
  python3 - <<'PY'
import json
import subprocess
import sys

blob = subprocess.run(["git", "cat-file", "blob", "HEAD:events.json"], capture_output=True)
if blob.returncode:
    sys.exit("events.json is missing from the rebased commit.")
try:
    database = json.loads(blob.stdout)
except ValueError as error:
    sys.exit(f"events.json no longer parses after the rebase: {error}")
events = database.get("events") if isinstance(database, dict) else None
if not isinstance(events, list):
    sys.exit("events.json has no events list after the rebase.")
seen = set()
for event in events:
    if not isinstance(event, dict) or not isinstance(event.get("id"), str) or not event["id"]:
        sys.exit("events.json holds an event without an id after the rebase.")
    if event["id"] in seen:
        sys.exit(f"events.json holds the id {event['id']} twice after the rebase.")
    seen.add(event["id"])
PY
}

# Run as one function: bash reads a script as it goes, and the rebase can
# rewrite this very file.
main() {
  local attempt
  for attempt in 1 2 3 4 5; do
    if git fetch origin main; then
      if ! git rebase origin/main; then
        git rebase --abort || true
        echo "The commit does not rebase onto main, so the rebase was aborted. Nothing was pushed." >&2
        exit 1
      fi
      if ! check_rebased_database; then
        echo "The rebased events.json failed its check. Nothing was pushed." >&2
        exit 1
      fi
      if git push origin HEAD:main; then
        exit 0
      fi
    fi
    if [ "$attempt" -lt 5 ]; then
      echo "Try $attempt to push to main failed; trying again in $((attempt * 4)) s." >&2
      sleep $((attempt * 4))
    fi
  done
  echo "Pushing to main failed 5 times. Nothing was pushed." >&2
  exit 1
}

main
