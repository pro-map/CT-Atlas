"""Shared, dependency-free policy for the retired Judicial collection.

Structured retention rules also protect old snapshots and resumed backfills.
The headline screen is only for fresh candidates: it must never reinterpret
an existing operational incident from incidental words in its headline.
"""
from __future__ import annotations

import re

JUDICIAL_CATEGORY = "Legal / Judicial"
_PRIMARY_CATEGORIES = {
    "ATTACK": "Attacks",
    "ATTEMPTED_ATTACK": "Attacks",
    "DISRUPTED_PLOT": "Counter Terrorism Action",
    "CT_OPERATION": "Counter Terrorism Action",
    "ARREST": "Arrests",
    "FINANCING": "Terrorist Financing",
    "WEAPONS": "Weapons",
    "ONLINE_CYBER_AI": "Online / Cyber / AI",
    "PIRACY": "Maritime Piracy",
}


def is_judicial_category(value) -> bool:
    name = re.sub(r"\s+", " ", str(value or "")).strip().casefold()
    return name in {"legal / judicial", "legal/judicial", "judicial"}


def _categories(event: dict) -> list[str]:
    raw = event.get("categories")
    if not isinstance(raw, list) or not raw:
        raw = [event.get("category")] if event.get("category") else []
    return list(dict.fromkeys(str(value).strip() for value in raw if str(value or "").strip()))


def is_retired_judicial_event(event: dict) -> bool:
    """Court events retire even when another threat topic labels them.

    Operational records with a secondary Judicial label retain their actual
    primary type. Older Judicial-only OTHER_CT/untyped records retire too.
    """
    primary = str(event.get("primary_event_type") or "").strip().upper()
    if primary == "JUDICIAL":
        return True
    categories = _categories(event)
    return primary in {"", "OTHER_CT"} and bool(categories) and all(
        is_judicial_category(value) for value in categories
    )


def active_categories(event: dict) -> list[str]:
    """Remove the retired label, using a known operational type if needed."""
    categories = [value for value in _categories(event) if not is_judicial_category(value)]
    if not categories:
        fallback = _PRIMARY_CATEGORIES.get(str(event.get("primary_event_type") or "").strip().upper())
        if fallback:
            categories = [fallback]
    return categories


def active_event(event: dict) -> dict:
    """A copy with the retired category stripped; no other evidence changes."""
    result = dict(event)
    if is_judicial_category(event.get("category")) or any(
        is_judicial_category(value) for value in _categories(event)
    ):
        categories = active_categories(event)
        result["categories"] = categories
        result["category"] = categories[0] if categories else ""
    return result


# Preserve clear operational developments, including a fresh arrest/seizure
# reported alongside a court mention. An ordinary mention of an old attack
# ("sentenced for the attack") does not satisfy this exception.
_OPERATIONAL_HEADLINE = re.compile(
    r"\b(?:arrest(?:s|ed|ing)?|detain(?:s|ed|ing)?|seiz(?:e|es|ed|ing)|seizures?|"
    r"raid(?:s|ed|ing)?|kill(?:s|ed|ing)?|injur(?:e|es|ed)|wound(?:s|ed)?|"
    r"shooting|shot dead|explod(?:es|ed)|foiled|thwarted|disrupted)\b",
    re.I,
)
_JUDICIAL_HEADLINE = re.compile(
    r"\b(?:convicted|convictions?|sentenced|sentencing|indicted|indictments?)\b|"
    r"\b(?:trial\s+(?:begins|starts|opens)|(?:stands?|faces?|facing)\s+(?:a\s+)?trial)\b|"
    r"\bcourt\b.{0,90}\b(?:appeals?|rulings?|verdicts?)\b|"
    r"\b(?:appeals?|rulings?|verdicts?)\b.{0,90}\bcourt\b|"
    r"\bcharged\s+with\b.{0,90}\bterror(?:ism|ist)?\b",
    re.I,
)


def judicial_headline_reason(event: dict) -> str | None:
    """Cheap, conservative English title-only screen before candidate AI."""
    title = re.sub(r"\s+", " ", str(event.get("title") or "")).strip()
    if _JUDICIAL_HEADLINE.search(title) and not _OPERATIONAL_HEADLINE.search(title):
        return "judicial-only development; Judicial collection is retired"
    return None
