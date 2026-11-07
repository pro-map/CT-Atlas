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

    python tools/check_committed_sizes.py
"""
from __future__ import annotations

import os
import subprocess
import sys

MIB = 1024 * 1024
WARN_BYTES = int(float(os.getenv("COMMITTED_FILE_WARN_MIB", "80")) * MIB)
LIMIT_BYTES = 100 * MIB


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


def main(files=None):
    status = 0
    for name in staged_files() if files is None else files:
        size = staged_size(name)
        if size is None:
            continue
        if size >= LIMIT_BYTES:
            print(f"::error title=File too large for GitHub::{name} is {size / MIB:.1f} MiB; "
                  "GitHub refuses files over 100 MiB, so this commit could not be pushed.")
            status = 1
        elif size >= WARN_BYTES:
            print(f"::warning title=File approaching GitHub's 100 MiB limit::{name} is {size / MIB:.1f} MiB.")
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:] or None))
