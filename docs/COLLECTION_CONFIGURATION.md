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

**Other eight topics in Chinese:** the same workflow invokes
`tools/enrich_chinese_map.py`. Its `gemini-chinese-map-*` checkpoint filenames are
historical compatibility names; the active workflow chooses Groq.

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

## Historical continuity and operational limits

This alignment adds 78 daily source searches (1,056 to 1,134 on the reviewed
snapshot). It changes neither AI quotas nor schedules. More candidates can exceed
a run's existing AI review allowance; existing budget/recovery behavior still
applies. More configured queries do not imply more events or a completed backfill.

Full historical plan objects and ordering are unchanged at this migration:
7,560 RN roots (including 5,238 supplement roots), 3,429 CE, 3,429 BIO and 1,248
Chinese roots. These are planned totals, not remaining counts. State, queues,
reviews, event IDs and quota ledgers are not reset. The old general archive's
replay surface is retained as `HISTORICAL_REPLAY_PROFILES`, so daily expansion
cannot silently create a second historical catch-up project.

Backend and publication evidence must still be verified from actual run records
and deployed data. This configuration change does not certify any new event or
the completion of either historical project.
