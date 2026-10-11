#!/usr/bin/env python3
"""Compact the mirror copy only; preserve every JSON token and string byte.

Workers static assets must fit within 25 MiB. Never truncate events, change
source data, or silently omit the full-data fallback to satisfy this limit.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
from decimal import Decimal
from pathlib import Path

MAX_ASSET_BYTES = 25 * 1024 * 1024
JSON_WHITESPACE = frozenset(b" \t\r\n")


def _reject_constant(value: str):
    raise ValueError("Non-standard JSON numeric constant")


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON object key")
        result[key] = value
    return result


def _decode(raw: bytes):
    return json.loads(raw.decode("utf-8"), parse_float=Decimal,
                      parse_constant=_reject_constant, object_pairs_hook=_unique_object)


def compact_json_bytes(raw: bytes) -> bytes:
    """Remove whitespace outside strings only, without reserializing numbers."""
    parsed = _decode(raw)
    output = bytearray()
    quoted = escaped = False
    for char in raw:
        if quoted:
            output.append(char)
            if escaped:
                escaped = False
            elif char == 92:  # backslash
                escaped = True
            elif char == 34:  # double quote
                quoted = False
        elif char == 34:
            quoted = True
            output.append(char)
        elif char not in JSON_WHITESPACE:
            output.append(char)
    result = bytes(output) + b"\n"
    if _decode(result) != parsed:
        raise ValueError("Compaction changed the JSON data; refusing output")
    return result


def write_compact_copy(source: Path, target: Path, *, limit: int = MAX_ASSET_BYTES) -> dict:
    source, target = Path(source), Path(target)
    if source.resolve() == target.resolve() or (target.exists() and os.path.samefile(source, target)):
        raise ValueError("Mirror output must not replace the tracked source")
    raw = source.read_bytes()
    compact = compact_json_bytes(raw)
    if len(compact) > limit:
        raise ValueError(f"Compacted asset still exceeds {limit} bytes; no data was removed")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix=target.name + ".",
                                         suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(compact)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    report = {"source_bytes": len(raw), "asset_bytes": len(compact),
              "limit_bytes": limit, "source_sha256": hashlib.sha256(raw).hexdigest(),
              "asset_sha256": hashlib.sha256(compact).hexdigest(), "json_data_equal": True}
    print("MIRROR_JSON_COMPACTION " + json.dumps(report, sort_keys=True))
    return report


def check_asset_sizes(directory: Path, *, limit: int = MAX_ASSET_BYTES) -> int:
    directory = Path(directory)
    if not directory.is_dir():
        raise ValueError("Mirror staging directory is missing")
    count = 0
    for path in sorted(directory.rglob("*")):
        if path.is_file():
            size = path.stat().st_size
            if size > limit:
                raise ValueError(f"Mirror asset {path.relative_to(directory)} is {size} bytes; limit {limit}")
            count += 1
    if not count:
        raise ValueError("Mirror staging directory is empty")
    print(f"MIRROR_ASSET_SIZES_OK files={count} limit_bytes={limit}")
    return count


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--check-directory", type=Path)
    args = parser.parse_args()
    try:
        if args.check_directory is not None:
            if args.input is not None or args.output is not None:
                parser.error("Use directory validation separately from compaction")
            check_asset_sizes(args.check_directory)
        else:
            if args.input is None or args.output is None:
                parser.error("Both --input and --output are required")
            write_compact_copy(args.input, args.output)
    except (OSError, ValueError) as exc:
        parser.exit(1, f"Mirror asset preparation failed: {exc}\n")


if __name__ == "__main__":
    main()
