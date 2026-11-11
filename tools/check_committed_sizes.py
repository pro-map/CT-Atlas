#!/usr/bin/env python3
"""Size check for the files a workflow is about to commit.

GitHub refuses a push that contains a file over 100 MiB (GH001), which would
stop the map updates with an obscure push failure. This check runs right
before `git commit`: a warning annotation once a staged file passes 80 MiB,
so there is time to act, and a clear error at the limit itself, where the
push could not succeed anyway.

It measures the staged blob, which is what the commit will hold, not the file
in the working tree. Names given as arguments are paths in the index, relative
to the repository root.

The monthly store (data/events/, docs/STORAGE_MIGRATION.md) warns earlier, at
40 MiB a month file: a busier month may need half-month files, which takes one
verified migration commit. Once the store is the database (authority "store"),
staging events.json again is an error: it is rebuilt after checkout, and
committing it would bring back the 100 MiB problem.

    python tools/check_committed_sizes.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

MIB = 1024 * 1024
WARN_BYTES = int(float(os.getenv("COMMITTED_FILE_WARN_MIB", "80")) * MIB)
LIMIT_BYTES = 100 * MIB
STORE_PREFIX = "data/events/"
STORE_WARN_BYTES = int(float(os.getenv("STORE_FILE_WARN_MIB", "40")) * MIB)


def staged_files():
    # Without --no-renames a staged rename is listed as R, which AM leaves out.
    output = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--no-renames", "--diff-filter=AM", "-z"],
        check=True, capture_output=True,
    ).stdout
    return [name for name in output.decode("utf-8").split("\0") if name]


def staged_size(name):
    """Bytes of the index entry for name, or None if the index has none."""
    result = subprocess.run(["git", "cat-file", "-s", f":{name}"], capture_output=True, text=True)
    return int(result.stdout) if result.returncode == 0 else None


def staged_store_authority():
    """The authority in the staged data/events/meta.json, or None."""
    result = subprocess.run(["git", "cat-file", "blob", ":data/events/meta.json"], capture_output=True)
    if result.returncode:
        return None
    try:
        return json.loads(result.stdout.decode("utf-8")).get("authority")
    except (ValueError, AttributeError):
        return None


def main(files=None):
    status = 0
    names = staged_files() if files is None else files
    if staged_store_authority() == "store" and staged_size("events.json") is not None:
        print("::error title=events.json staged again::data/events is the database; events.json is rebuilt "
              "from it and must not be committed (git rm --cached events.json).")
        status = 1
    for name in names:
        size = staged_size(name)
        if size is None:
            continue
        if size >= LIMIT_BYTES:
            print(f"::error title=File too large for GitHub::{name} is {size / MIB:.1f} MiB; "
                  "GitHub refuses files over 100 MiB, so this commit could not be pushed.")
            status = 1
        elif size >= WARN_BYTES:
            print(f"::warning title=File approaching GitHub's 100 MiB limit::{name} is {size / MIB:.1f} MiB.")
        elif name.startswith(STORE_PREFIX) and size >= STORE_WARN_BYTES:
            print(f"::warning title=Month file growing::{name} is {size / MIB:.1f} MiB; at about 50 MiB "
                  "split the store into half-month files (docs/STORAGE_MIGRATION.md).")
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:] or None))
