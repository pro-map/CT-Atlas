#!/usr/bin/env python3
"""Prepare lossless mirror data; preserve every JSON token and string byte.

Workers static assets must fit within 25 MiB. Oversized publication files
(events.json, events-lite.json, events-map.json) are split into immutable byte
chunks and streamed at their unchanged URLs.
Never truncate events, change source data, or omit the full-data fallback.
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
CHUNK_BYTES = 8 * 1024 * 1024
SHARD_MANIFEST = "events-shards.json"
SHARD_FORMAT = "ct-atlas-byte-shards-v1"
# The routes tools/mirror-worker.mjs can stream from chunks (its DATASETS).
CHUNKED_FILES = ("events.json", "events-lite.json", "events-map.json")
JSON_WHITESPACE = frozenset(b" \t\r\n")


def shard_manifest_name(name: str) -> str:
    """'<stem>-shards.json'; events.json keeps the deployed 'events-shards.json'."""
    return Path(name).stem + "-shards.json"


def shard_path(name: str, checksum: str, index: int) -> str:
    return f"_events/{Path(name).stem}-{checksum[:16]}-{index:05d}.bin"


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


def _validate_target(source: Path, target: Path) -> None:
    if source.resolve() == target.resolve() or (target.exists() and os.path.samefile(source, target)):
        raise ValueError("Mirror output must not replace the tracked source")


def _atomic_write(target: Path, content: bytes) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix=target.name + ".",
                                         suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def write_compact_copy(source: Path, target: Path, *, limit: int = MAX_ASSET_BYTES) -> dict:
    source, target = Path(source), Path(target)
    _validate_target(source, target)
    raw = source.read_bytes()
    compact = compact_json_bytes(raw)
    if len(compact) > limit:
        raise ValueError(f"Compacted asset still exceeds {limit} bytes; no data was removed")
    _atomic_write(target, compact)
    report = {"source_bytes": len(raw), "asset_bytes": len(compact),
              "limit_bytes": limit, "source_sha256": hashlib.sha256(raw).hexdigest(),
              "asset_sha256": hashlib.sha256(compact).hexdigest(), "json_data_equal": True}
    print("MIRROR_JSON_COMPACTION " + json.dumps(report, sort_keys=True))
    return report


def write_mirror_copy(source: Path, target: Path, *, limit: int = MAX_ASSET_BYTES,
                      chunk_bytes: int = CHUNK_BYTES) -> dict:
    """Stage the complete JSON, chunking bytes only when a single asset cannot fit."""
    source, target = Path(source), Path(target)
    _validate_target(source, target)
    if target.name not in CHUNKED_FILES:
        raise ValueError("The mirror chunked routes are " + ", ".join(CHUNKED_FILES))
    if limit <= 0 or chunk_bytes <= 0:
        raise ValueError("Asset and chunk size limits must be positive")
    raw = source.read_bytes()
    compact = compact_json_bytes(raw)
    manifest_path = target.parent / shard_manifest_name(target.name)
    if len(compact) <= limit:
        _atomic_write(target, compact)
        manifest_path.unlink(missing_ok=True)
        report = {"format": "single-json", "size_bytes": len(compact), "parts": []}
    else:
        size = min(chunk_bytes, limit)
        checksum = hashlib.sha256(compact).hexdigest()
        parts = []
        for index, offset in enumerate(range(0, len(compact), size)):
            chunk = compact[offset:offset + size]
            name = shard_path(target.name, checksum, index)
            _atomic_write(target.parent / name, chunk)
            parts.append({"path": name, "size_bytes": len(chunk),
                          "sha256": hashlib.sha256(chunk).hexdigest()})
        report = {"format": SHARD_FORMAT, "filename": target.name,
                  "size_bytes": len(compact), "sha256": checksum, "parts": parts}
        encoded = (json.dumps(report, sort_keys=True, separators=(",", ":")) + "\n").encode()
        if len(encoded) > MAX_ASSET_BYTES:
            raise ValueError("Mirror shard manifest exceeds the asset size limit")
        _atomic_write(manifest_path, encoded)
        # A previously copied oversized file must not be uploaded alongside its chunks.
        # Remove it only after the complete replacement and manifest have been written.
        target.unlink(missing_ok=True)
    report.update(source_bytes=len(raw), json_data_equal=True,
                  source_sha256=hashlib.sha256(raw).hexdigest())
    print("MIRROR_JSON_PREPARATION " + json.dumps(report, sort_keys=True))
    return report


def read_mirror_bytes(directory: Path, name: str = "events.json") -> bytes:
    """Reconstruct staged bytes for publication auditing, checking every chunk."""
    directory = Path(directory)
    if (directory / name).is_file():
        return (directory / name).read_bytes()
    manifest_path = directory / shard_manifest_name(name)
    if name not in CHUNKED_FILES or not manifest_path.is_file():
        raise ValueError("Missing publication dataset: " + name)
    manifest = json.loads(manifest_path.read_bytes())
    if manifest.get("format") != SHARD_FORMAT or manifest.get("filename") != name:
        raise ValueError("Unsupported mirror shard manifest")
    output = bytearray()
    for index, part in enumerate(manifest["parts"]):
        expected = shard_path(name, manifest["sha256"], index)
        if part["path"] != expected:
            raise ValueError("Invalid mirror shard path")
        content = (directory / expected).read_bytes()
        if len(content) != part["size_bytes"] or hashlib.sha256(content).hexdigest() != part["sha256"]:
            raise ValueError("Mirror shard content does not match its manifest")
        output.extend(content)
    content = bytes(output)
    if len(content) != manifest["size_bytes"] or hashlib.sha256(content).hexdigest() != manifest["sha256"]:
        raise ValueError("Reconstructed mirror JSON does not match its manifest")
    return content


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
    parser.add_argument("--allow-chunks", action="store_true",
                        help="Stream an oversized " + "/".join(CHUNKED_FILES) + " from lossless static byte chunks")
    args = parser.parse_args()
    try:
        if args.check_directory is not None:
            if args.input is not None or args.output is not None or args.allow_chunks:
                parser.error("Use directory validation separately from compaction")
            check_asset_sizes(args.check_directory)
        else:
            if args.input is None or args.output is None:
                parser.error("Both --input and --output are required")
            writer = write_mirror_copy if args.allow_chunks else write_compact_copy
            writer(args.input, args.output)
    except (OSError, ValueError) as exc:
        parser.exit(1, f"Mirror asset preparation failed: {exc}\n")


if __name__ == "__main__":
    main()
