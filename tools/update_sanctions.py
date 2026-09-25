#!/usr/bin/env python3
"""Build sanctions-crypto.json from the official OFAC SDN list.

OFAC publishes cryptocurrency addresses on SDN entries as ID records of type
"Digital Currency Address - <CURRENCY>". This reads the full sdn.xml (NOT the
legacy sdn.csv: its Remarks column is length-capped, which silently truncates
the last address of long entries -- roughly half of all addresses), keeps the
designation programs so terrorism designations (SDGT / FTO / SDT) stay
distinguishable from e.g. Iran or DPRK programs, and writes a compact JSON
file the CT Atlas Worker screens crypto analyses against.

Standard library only. Usage:
    python tools/update_sanctions.py                 # download + write
    python tools/update_sanctions.py --input sdn.xml # parse a local file

Safety rails: the existing file is never replaced by a suspiciously smaller
one (a truncated/garbled download must not silently erase the list).
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

OFAC_SDN_URL = "https://www.treasury.gov/ofac/downloads/sdn.xml"
OUTPUT = Path(__file__).resolve().parent.parent / "sanctions-crypto.json"
FORMAT_VERSION = "sanctions-crypto-v1"

# Programs that mark a terrorism designation (as opposed to e.g. IRAN, DPRK).
TERRORISM_PROGRAMS = {"SDGT", "FTO", "SDT"}

ID_TYPE_PREFIX = "Digital Currency Address - "
EVM_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
TRON_RE = re.compile(r"^T[1-9A-HJ-NP-Za-km-z]{33}$")
BITCOIN_RE = re.compile(r"^(?:bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{24,34})$", re.I)

# OFAC removes designations occasionally, but never most of the list at once.
MIN_RETAINED_RATIO = 0.6

# OFAC changes crypto entries only occasionally. An unchanged list is left
# untouched (no daily no-op commit) but is re-stamped after this long so the
# Worker's "stale after 7 days" check keeps meaning "we have not verified
# recently", not "OFAC has not changed anything".
REFRESH_AFTER = timedelta(days=3)


def classify(address: str) -> str:
    """Chain family by address format. The same EVM key is valid on every EVM
    chain, so 'evm' is deliberately chain-agnostic."""
    if EVM_RE.match(address):
        return "evm"
    if TRON_RE.match(address):
        return "tron"
    if BITCOIN_RE.match(address):
        return "bitcoin"
    return "other"


def normalize(family: str, address: str) -> str:
    if family == "evm":
        return address.lower()
    if family == "bitcoin" and address.lower().startswith("bc1"):
        return address.lower()
    return address


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def child_text(element: ET.Element, name: str) -> str:
    for child in element:
        if local(child.tag) == name:
            return (child.text or "").strip()
    return ""


def display_name(entry: ET.Element) -> str:
    last = re.sub(r"\s+", " ", child_text(entry, "lastName")).strip()
    first = re.sub(r"\s+", " ", child_text(entry, "firstName")).strip()
    return f"{last}, {first}" if first and last else (last or first)


def parse_sdn(raw: bytes) -> tuple[list[dict], list[dict], str]:
    """Returns (entities, address records, publish date) from sdn.xml bytes.

    Streams the (~30 MB) document so memory stays flat.
    """
    entities: list[dict] = []
    addresses: list[dict] = []
    published = ""

    for _, element in ET.iterparse(io.BytesIO(raw), events=("end",)):
        name = local(element.tag)

        if name == "Publish_Date":
            published = (element.text or "").strip()

        if name != "sdnEntry":
            continue

        found: list[tuple[str, str]] = []
        programs: list[str] = []
        for child in element:
            kind = local(child.tag)
            if kind == "programList":
                for program in child:
                    value = (program.text or "").strip()
                    if value and value not in programs:
                        programs.append(value)
            elif kind == "idList":
                for record in child:
                    id_type = child_text(record, "idType")
                    if id_type.startswith(ID_TYPE_PREFIX):
                        currency = id_type[len(ID_TYPE_PREFIX):].strip()
                        address = child_text(record, "idNumber").rstrip(".").strip()
                        if currency and address:
                            found.append((currency, address))

        if found:
            entities.append({
                "id": child_text(element, "uid"),
                "name": display_name(element),
                "type": child_text(element, "sdnType").lower() or "entity",
                "programs": programs,
                "terrorism": any(program in TERRORISM_PROGRAMS for program in programs),
                "list": "OFAC_SDN",
            })
            index = len(entities) - 1
            for currency, address in found:
                family = classify(address)
                addresses.append({"a": normalize(family, address), "c": currency, "f": family, "e": [index]})

        element.clear()

    return entities, addresses, published


def publish_date_iso(value: str) -> str:
    try:
        return datetime.strptime(value, "%m/%d/%Y").date().isoformat()
    except ValueError:
        return ""


def build_document(raw: bytes, source_url: str, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    entities, addresses, published = parse_sdn(raw)

    # Merge identical (family, address) pairs that appear under several entities.
    merged: dict[tuple[str, str], dict] = {}
    for item in addresses:
        key = (item["f"], item["a"])
        if key in merged:
            merged[key]["e"] = sorted(set(merged[key]["e"] + item["e"]))
        else:
            merged[key] = {**item}
    merged_list = sorted(merged.values(), key=lambda item: (item["f"], item["a"]))

    return {
        "version": FORMAT_VERSION,
        "retrieved_at": now.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "sources": [{
            "id": "OFAC_SDN",
            "name": "OFAC Specially Designated Nationals (SDN) List",
            "url": source_url,
            "published": publish_date_iso(published),
            "sha256": hashlib.sha256(raw).hexdigest(),
            "entities": len(entities),
            "addresses": len(merged_list),
        }],
        "entities": entities,
        "addresses": merged_list,
    }


def read_existing(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def is_unchanged(existing: dict | None, document: dict, now: datetime) -> bool:
    """True when rewriting would only bump the timestamp/hash of an identical list."""
    if not existing:
        return False
    try:
        retrieved = datetime.strptime(existing["retrieved_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (KeyError, ValueError, TypeError):
        return False
    if now - retrieved >= REFRESH_AFTER:
        return False
    old_source = (existing.get("sources") or [{}])[0]
    new_source = document["sources"][0]
    return (
        existing.get("entities") == document["entities"]
        and existing.get("addresses") == document["addresses"]
        and old_source.get("published") == new_source.get("published")
    )


def download(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "CT-Atlas-sanctions-updater/1"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--input", help="parse a local sdn.xml instead of downloading")
    parser.add_argument("--output", default=str(OUTPUT))
    parser.add_argument("--url", default=OFAC_SDN_URL)
    args = parser.parse_args(argv)

    output = Path(args.output)
    raw = Path(args.input).read_bytes() if args.input else download(args.url)
    now = datetime.now(timezone.utc)
    document = build_document(raw, args.url, now)

    count = len(document["addresses"])
    if count == 0:
        print("Refusing to write: no digital-currency addresses parsed (format change or bad download).", file=sys.stderr)
        return 1

    existing = read_existing(output)
    if existing and isinstance(existing.get("addresses"), list):
        previous = len(existing["addresses"])
        if previous and count < previous * MIN_RETAINED_RATIO:
            print(
                f"Refusing to overwrite: new list has {count} addresses vs {previous} before "
                f"(below {int(MIN_RETAINED_RATIO * 100)}% retention) -- likely a truncated or changed source.",
                file=sys.stderr,
            )
            return 1

    if is_unchanged(existing, document, now):
        print(f"Unchanged: {output.name} already matches OFAC ({count} addresses); not rewriting.")
        return 0

    output.write_text(json.dumps(document, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    by_family: dict[str, int] = {}
    for item in document["addresses"]:
        by_family[item["f"]] = by_family.get(item["f"], 0) + 1
    print(f"Wrote {output.name}: {len(document['entities'])} entities, {count} addresses {by_family}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
