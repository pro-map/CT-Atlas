"""One-off backfill: re-check the Attacks / Counter Terrorism Action / Arrests
three-way distinction on events already sitting in events.json that were
collected before the "Counter Terrorism Action" category existed.

This intentionally does NOT re-run full AI selection (relevance scoring,
is_current_ct_event, translation, geolocation). It only asks Gemini to
re-classify these three specific category tags for events that are already
confirmed CT events and already tagged "Attacks" and/or "Arrests" -- so a
raid that captured (not just killed) militants finally gets its own category
instead of being buried under "Arrests". Every other field on every event
(title, summary, location, other categories, relevance, dates) is left
completely untouched, and events already tagged "Counter Terrorism Action"
are skipped.

Usage: GEMINI_API_KEY=... python tools/recategorize_ct_action.py
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

RELEVANT_TAGS = ("Attacks", "Counter Terrorism Action", "Arrests")

INSTRUCTIONS = """
You are re-checking the category tags of ALREADY-CONFIRMED counter-terrorism
events for a mapping tool. Do not judge relevance, do not decide whether the
event belongs on the map -- it already does. Only decide which of these three
categories apply to each event, using this exact distinction:

"Attacks" vs "Counter Terrorism Action" vs "Arrests" -- these three are easily
confused and must be kept separate:
- "Attacks" is for violence INITIATED BY terrorists/militants/extremists: an
  attack, attempted attack, bombing, shooting, ambush, or a terrorist who
  attacked security forces and was then killed in the ensuing fight. The
  defining feature is who started the violence.
- "Counter Terrorism Action" is for an OFFENSIVE or COMBAT operation BY
  security/military forces AGAINST terrorists: a raid, strike, siege, clearance
  operation, ambush of a terrorist position, or firefight in which militants
  are killed, wounded OR CAPTURED as the result of that operation. A raid that
  ends in a capture still belongs here, not in "Arrests" -- what matters is
  the offensive/combat nature of the operation, not whether the outcome was a
  kill or a capture.
- "Arrests" is for the plain apprehension, detention, indictment or custody of
  a suspect with NO described raid, assault, clash or combat -- e.g. a suspect
  arrested at a checkpoint, at home, or during a routine investigation. If a
  raid or firefight is described, use "Counter Terrorism Action" instead of
  "Arrests" even if an arrest also results from it.
An event can legitimately carry both "Attacks" and "Counter Terrorism Action"
when terrorists attacked first and were then killed/captured by responding
forces. A routine arrest with no combat should carry "Arrests" only, never
"Counter Terrorism Action".

For every event, return its event_id and a "tags" array containing only the
applicable ones of "Attacks", "Counter Terrorism Action", "Arrests" (at least
one). List the MOST prominent/primary aspect of the event first -- this
determines which category is treated as primary downstream. Base your
judgement only on the supplied title and summary text; do not invent facts
not stated there.
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
                    "tags": {
                        "type": "array",
                        "items": {
                            "type": "string",
                            "enum": list(RELEVANT_TAGS),
                        },
                    },
                },
                "required": ["event_id", "tags"],
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
        categories = event.get("categories") or ([event.get("category")] if event.get("category") else [])
        if "Counter Terrorism Action" in categories:
            continue
        if not (set(categories) & {"Attacks", "Arrests"}):
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
            "Re-check category tags for every event below.\n\n"
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

    raise RuntimeError("Gemini recategorization request failed after retries.")


def main():
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=WINDOW_DAYS)

    db = collector.load_database_strict()
    events = db["events"]

    candidates = select_candidates(events, cutoff)
    print(f"Total events in database: {len(events)}")
    print(f"Candidates to re-check (last {WINDOW_DAYS} days, tagged Attacks/Arrests, not already Counter Terrorism Action): {len(candidates)}")

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
        # non-Latin headlines, and an answer keyed by it would retag them all.
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
        tags_by_id = {str(r.get("event_id")): r.get("tags") for r in results if isinstance(r, dict)}

        for index, event in batch:
            tags = tags_by_id.get(f"idx{index}")
            if not tags or not isinstance(tags, list):
                continue
            tags = [t for t in tags if t in RELEVANT_TAGS]
            if not tags:
                continue

            existing = event.get("categories") or ([event.get("category")] if event.get("category") else [])
            other_categories = [c for c in existing if c not in RELEVANT_TAGS]
            new_categories = tags + other_categories

            if new_categories != existing:
                event["categories"] = new_categories
                event["category"] = new_categories[0]
                updated_count += 1

    print(f"Total events updated: {updated_count}")

    if updated_count:
        output_path = ROOT / "events.json"
        with open(output_path, "w", encoding="utf-8") as handle:
            json.dump(db, handle, ensure_ascii=False, indent=2)
        print(f"events.json written with {updated_count} updated categorizations.")
    else:
        print("No changes to write.")


if __name__ == "__main__":
    main()
