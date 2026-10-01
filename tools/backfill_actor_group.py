"""One-off backfill: extract the canonical actor_group field on events already
sitting in events.json that were collected before this field existed.

This intentionally does NOT re-run full AI selection (relevance scoring,
is_current_ct_event, translation, geolocation, categories). It only asks
Gemini to identify and canonicalize the primary named non-state actor/group
for events that don't have an actor_group value yet, so the map's new
Actor / group filter has real data for the existing database instead of
bucketing everything under "Unspecified" until it fills in naturally over
the coming weeks. Every other field on every event is left untouched, and
events that already have an actor_group key (even an empty string, meaning
"no group identified") are skipped -- an empty string is a real, already-made
decision, not a gap to redo.

Usage: GEMINI_API_KEY=... python tools/backfill_actor_group.py
Env overrides: RECAT_WINDOW_DAYS (default 180), RECAT_MAX_CALLS (default 400,
a safety cap -- re-run the script to continue if it stops early).
"""

import json
import os
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import collector  # noqa: E402  (reuses extract_interaction_text, load_database_strict, etc.)

BATCH_SIZE = 25
WINDOW_DAYS = int(os.getenv("RECAT_WINDOW_DAYS", "180"))
MAX_CALLS = int(os.getenv("RECAT_MAX_CALLS", "400"))
MODEL = collector.AI_SELECTION_MODEL
INTERACTIONS_URL = collector.GEMINI_INTERACTIONS_URL

INSTRUCTIONS = """
You are extracting the primary named non-state actor/group for
ALREADY-CONFIRMED counter-terrorism events on a mapping tool. Do not judge
relevance, do not decide whether the event belongs on the map -- it already
does. Only identify actor_group for each event.

actor_group: the primary named non-state actor, terrorist/militant
organisation, cell or group responsible for or centrally involved in this
event, normalized to ONE consistent canonical English name so the SAME group
is never split into several map-filter values by alias, spelling or
translation. Use these canonical names whenever the text refers to any of
their aliases:
- "ISIS" for ISIS, ISIL, Daesh, Islamic State, Islamic State of Iraq and
  Syria/the Levant -- but keep distinct regional branches under their OWN
  canonical name instead of folding them into plain "ISIS": "ISIS-K" (also
  called ISKP / Islamic State Khorasan), "ISWAP" (Islamic State West Africa
  Province), etc. -- these are operationally separate branches, not spelling
  variants.
- "Al-Qaeda" for Al-Qaeda, AQ, al-Qaida, al-Qa'ida -- but keep "AQAP"
  (Al-Qaeda in the Arabian Peninsula), "AQIM" (Al-Qaeda in the Islamic
  Maghreb) and "JNIM" as their own separate canonical names.
- "Hezbollah" for Hezbollah, Hizballah, Hizbollah, Hizbullah.
- "Boko Haram" for Boko Haram, Jama'atu Ahlis Sunna Lidda'awati wal-Jihad --
  but keep "ISWAP" separate; it split from Boko Haram and is now distinct.
- "Taliban" for the AFGHAN Taliban only -- keep "TTP" (Tehrik-i-Taliban
  Pakistan / Pakistani Taliban) as its own separate canonical name; despite
  the shared name it is a distinct organisation.
- "Al-Shabaab" for Al-Shabaab, Al-Shabab, Harakat al-Shabaab al-Mujahideen.
- "Houthis" for Houthis, Ansar Allah.
- "PKK" for PKK, Kurdistan Workers' Party -- keep "PJAK" separate.
- "ADF" for ADF, Allied Democratic Forces.
- "ISGS" for ISGS, Islamic State Sahel Province, Islamic State in the
  Greater Sahara -- keep separate from plain "ISIS", same reasoning as
  ISIS-K/ISWAP above.
For any other named group, cell, faction or actor not listed above:
- decide which single form (the acronym, or the full name) is the one most
  commonly used to refer to this group in English-language open-source
  reporting, and ALWAYS use exactly that one form -- never alternate
  between the acronym and the spelled-out name for the same group across
  different events (e.g. always "JNIM", never spelling out the full name
  once an established acronym exists; conversely use the full name, not an
  obscure acronym, when English reporting overwhelmingly uses the full
  name).
- use standard, dictionary-style capitalization every time (e.g. always
  "Antifa", never "antifa" or "ANTIFA"; always "Wagner", never "wagner").
  The exact same group must never appear with different capitalization in
  different events.
- preserve the correct spelling/diacritics of the group's own name exactly
  (e.g. "FETÖ" keeps its Ö; do not silently drop or ASCII-fold accents, and
  do not invent alternate transliterations of the same name).
If the event involves an unnamed or unidentified individual, cell or group
with no specific named organisation stated (e.g. "a lone gunman",
"unidentified militants", "a local criminal network"), or if it is a state
actor / government operation with no non-state actor named, return an empty
string rather than guessing.

For every event, return its event_id and actor_group. Base your judgement
only on the supplied title and summary text; do not invent facts not stated
there.
"""

SCHEMA = {
    "type": "object",
    "properties": {
        "results": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "event_id": {"type": "string"},
                    "actor_group": {"type": "string"},
                },
                "required": ["event_id", "actor_group"],
            },
        }
    },
    "required": ["results"],
}


def parse_event_datetime(event):
    for field in ("event_date", "occurrence_date", "first_reported", "published", "last_reported"):
        raw = event.get(field)
        if not raw:
            continue
        try:
            return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        except ValueError:
            continue
    return None


def select_candidates(events, cutoff):
    candidates = []
    for index, event in enumerate(events):
        if "actor_group" in event:
            continue
        occurred_at = parse_event_datetime(event)
        if occurred_at is not None and occurred_at < cutoff:
            continue
        candidates.append((index, event))
    return candidates


def call_batch(items):
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is missing.")

    body = {
        "model": MODEL,
        "input": (
            "Identify actor_group for every event below.\n\n"
            + json.dumps({"events": items}, ensure_ascii=False)
        ),
        "system_instruction": INSTRUCTIONS,
        "store": False,
        "response_format": {
            "type": "text",
            "mime_type": "application/json",
            "schema": SCHEMA,
        },
        "generation_config": {
            "max_output_tokens": 8000,
            "thinking_level": "minimal",
        },
    }
    headers = {"x-goog-api-key": api_key, "Content-Type": "application/json"}

    for attempt in range(1, 6):
        response = requests.post(INTERACTIONS_URL, headers=headers, json=body, timeout=120)

        if response.status_code == 429:
            delay = min(60, 15 * attempt)
            print(f"   429 rate limit; retrying in {delay}s (attempt {attempt}/5)")
            time.sleep(delay)
            continue

        if response.status_code >= 500:
            delay = min(60, 10 * attempt)
            print(f"   HTTP {response.status_code}; retrying in {delay}s (attempt {attempt}/5)")
            time.sleep(delay)
            continue

        if response.status_code >= 400:
            raise RuntimeError(f"Gemini API error {response.status_code}: {response.text[:1200]}")

        payload = response.json()
        output_text = collector.extract_interaction_text(payload)
        parsed = json.loads(output_text)
        results = parsed.get("results")
        if not isinstance(results, list):
            raise RuntimeError("Gemini response had no results array.")
        time.sleep(2)
        return results

    raise RuntimeError("Gemini actor_group backfill request failed after retries.")


def main():
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=WINDOW_DAYS)

    db = collector.load_database_strict()
    events = db["events"]

    candidates = select_candidates(events, cutoff)
    print(f"Total events in database: {len(events)}")
    print(f"Candidates missing actor_group (last {WINDOW_DAYS} days): {len(candidates)}")

    if not candidates:
        print("Nothing to do.")
        return

    updated_count = 0
    calls_made = 0
    total_batches = (len(candidates) + BATCH_SIZE - 1) // BATCH_SIZE

    for start in range(0, len(candidates), BATCH_SIZE):
        if calls_made >= MAX_CALLS:
            print(f"Reached the {MAX_CALLS}-call safety cap; stopping early. Re-run the script to continue with the rest.")
            break

        batch = candidates[start:start + BATCH_SIZE]
        batch_number = start // BATCH_SIZE + 1
        print(f"Batch {batch_number}/{total_batches} -- {len(batch)} events")

        # The wire id is the event's position, never its stored id: until the
        # old ids age out (spring 2027) one id can cover dozens of unrelated
        # non-Latin headlines, and an answer keyed by it would apply to them all.
        payload_items = [
            {
                "event_id": f"idx{index}",
                "title": (event.get("title") or "")[:280],
                "summary": (event.get("summary") or "")[:560],
            }
            for index, event in batch
        ]

        try:
            results = call_batch(payload_items)
        except Exception as error:  # noqa: BLE001
            print(f"   Batch failed, skipping: {error}")
            continue

        calls_made += 1
        groups_by_id = {str(r.get("event_id")): r.get("actor_group") for r in results if isinstance(r, dict)}

        for index, event in batch:
            wire_id = f"idx{index}"
            if wire_id not in groups_by_id:
                continue
            event["actor_group"] = collector.canonicalize_actor_group(groups_by_id[wire_id])
            updated_count += 1

    print(f"Total events updated: {updated_count}")

    if updated_count:
        output_path = ROOT / "events.json"
        with open(output_path, "w", encoding="utf-8") as handle:
            json.dump(db, handle, ensure_ascii=False, indent=2)
        print(f"events.json written with actor_group set on {updated_count} event(s).")
    else:
        print("No changes to write.")


if __name__ == "__main__":
    main()
