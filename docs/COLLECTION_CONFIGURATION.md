# CT Atlas collection configuration

## Which code runs?

**Daily map:** `.github/workflows/update-map.yml` invokes
`tools/run_collector_quota_safe.py`, which imports and runs `collector.py`.
The wrapper sets the active Gemini model, threshold and budgets. Initial defaults
in `collector.py` are not the complete scheduled configuration.

**Specialist historical backfill:** `.github/workflows/groq-free-backfill.yml`
invokes `tools/enrich_threat_categories.py`. It imports collector functions for
schema, selection and deduplication, but runs fixed historical source tasks and
separate checkpoints. `CT_ATLAS_BACKFILL_PROVIDER=groq` selects the Groq backend.

**Other active topics in Chinese:** the same workflow invokes
`tools/enrich_chinese_map.py`. Its `gemini-chinese-map-*` checkpoint filenames are
historical compatibility names; its separate historical lane is disabled.

**Custom Intelligence:** `cloudflare-worker/deep-search.js` and `deep-search.js`
are a separate interactive search system. Its 14 language/script codes are not
the daily/specialist pipeline's 21 codes.

## Authoritative vocabulary and effective settings

| File/API | Role |
|---|---|
| `threat-category-keywords.json` | Curated CE/BIO words, context and native search groups for all configured codes. Existing English 95-term CE list and curated seed sets are retained. |
| `radnuc.py` | Existing multilingual RN discovery and scope rules. |
| `radnuc-keywords.json` / `radnuc_vocabulary.py` | The 181-term RN supplement and its bounded query construction. The full English vocabulary is not 181 individually translated terms in every language. |
| `threat_categories.collection_queries(category, code)` | Complete shared specialist query API for daily and historical intake. |
| `threat_categories.queries(category, code)` | Original curated query subset, retained for compatibility and frozen general-archive replay. |
| `collection_config.py` | Missing specialist editions, effective language counts and validation against published runtime metadata. |
| `ct-atlas-runtime.json` | UI metadata and existing scheduled threshold; language fields must match the loaded collector. |
| `tools/historical_specialist_queries.py` | Compatibility interface only. Its old inline seed lists now come from the shared vocabulary file. |

`collector.py` installs specialist settings before collection. Superseded initial
CBRN blocks have been removed. Remaining CBRN source queries are broad discovery
hints; `primary_event_type=CBRN`, `legacy_category` and `cbrn_subgroups` preserve
machine compatibility. None reintroduces a user-facing CBRN parent. Do not delete
these fields or source hints indiscriminately.

## What the language counts mean

The daily specialist searches now cover **21 codes representing 20 languages**:
`ar bn de en es fa fr ha he hi id it ps pt ru so sw tr ur zh zh-Hant`.
Both Chinese writing systems are searched. English output remains unchanged.
There are 19 non-English languages (20 non-English codes) configured for
translation. These are configured capabilities, **not numbers of completed
translations or proof of exhaustive discovery**.

The additional daily editions are specialist-only: expanding the three threat
topics does not assert that every other category has dedicated native searches
in every language. Source editions are never incident locations. Somali/Swahili
use the existing English-edition fallback; zero results is not a successful-
coverage claim.

## Inspect without collecting

```sh
python tools/describe_collection.py --check
```

This prints effective codes, per-topic query counts, vocabulary paths, the
scheduled threshold and planned daily source requests. It performs no HTTP calls,
AI reviews, source collection, database edits or quota writes. The daily collector
also checks metadata consistency before it starts. CI checks every authoritative
configuration file and tests against the loaded settings, not just JSON literals.

## Daily priority and progress

Daily collection separates candidates published within the recent three-day
window from older candidates. Fresh reporting is reviewed first; old queue
recovery follows, and existing-record maintenance runs last. A missing or invalid
publication date cannot enter the recent lane. Completed AI decisions remain
cached without resetting the cache version or quota ledger.

`daily_candidate_queue.json` stores raw candidates before AI selection. Only
completed candidates whose database write succeeded leave that queue. It is
committed and retained in recovery artifacts even after failures, so articles
do not disappear merely because a later feed no longer includes them. It is
excluded from the published site.

Scheduled selection uses 32 candidates per batch. Request ceilings stay at
30/run and 60/Pacific day for the primary model, with 25/run and 50/day for
overflow. Historical recovery and maintenance together may use at most ten
requests per run, including a maintenance cap of two. These are sub-envelopes
inside the existing caps; they do not create additional provider quota.

The map exposes `events.json.collection_status` independently of GitHub's job
conclusion. It reports recent reviewed/pending candidates, the earlier backlog,
source errors, geolocation pending, and separate attempt/publication timestamps.
The Radiological/Nuclear background daily publishes its own status and attempt
timestamp in the same view. Completed but unlocated events are counted separately
from events still awaiting an AI location decision.

`tools/finalize_daily_status.py` runs after geolocation even when a preceding
step fails. For a failed collector it restores the Git database first, preserving
all events and the previous publication timestamp, then adds current progress
metadata. Only telemetry from the current attempt supplies new run counters.
Recovery artifacts contain the queue, selection cache, database and
`daily-collection-status.json`; the sidecar is also excluded from the site.

`--refresh-existing` updates progress display without collection or AI calls.
Legacy counters formerly named `recent_pending`/`backlog_pending` were input
totals including cache hits; they appear as candidate totals with unknown
reviewed/pending counts. Missing evidence never becomes a complete status.

## Historical continuity

Judicial collection and its keywords are retired. RadNuc and ChemEx historical
backfills and the separate Chinese historical lane remain disabled by
`backfill-control.json`; daily collection continues according to its active
configuration. Changing daily priority or batch size does not restart those
backfills. Existing checkpoints and the historical replay profile remain intact.
Configured searches describe discovery capability, not exhaustive coverage or
proof of a completed update.
