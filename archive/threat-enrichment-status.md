# Specialist six-month backfill

Last checkpoint (UTC): 2026-10-09T13:23:59.267653+00:00

**Batch result: partial. Whole backfill complete: NO.**

| Category | Root queries processed / planned | Rejected queries | Pending work | Awaiting AI review | New event records this batch |
|---|---:|---:|---:|---:|---:|
| Radiological/Nuclear | 1816 / 7236 | 0 | 5423 | 0 | 6 |
| Chemicals and Explosives | 1221 / 2241 | 0 | 1021 | 0 | 11 |
| Biological Terrorism | 517 / 2754 | 0 | 2237 | 0 | 0 |

Processed roots include windows replaced by narrower queries. Rejected queries are NOT successful retrievals. Pending work includes these replacement queries and tasks awaiting review.

Catch-up rounds started: 8. Acceleration ends at 2026-10-09T22:00:00+00:00.

## Latest batch / source limitations

### Additional Radiological/Nuclear keyword backfill
```json
{
  "version": "radiological-nuclear-keywords-v1-20261009",
  "supplied_keywords": 181,
  "from": "2026-04-12",
  "through": "2026-10-09",
  "planned_searches": 5076,
  "completed_searches": 0,
  "pending_searches": 5076,
  "queued_candidates": 0,
  "processing_complete": false
}
```

### Radiological/Nuclear
```json
{
  "stop": "deadline reached (15 min); review queue saved",
  "reviewed_this_batch": 595,
  "successful_fetches_this_batch": 191,
  "rejected_queries": 0,
  "unresolved_saturated_queries": 0,
  "historical_coverage_issues": {
    "query_errors": 0,
    "full_single_day": 2,
    "failed_searches": 34
  }
}
```

### Chemicals and Explosives
```json
{
  "stop": "deadline reached (15 min); review queue saved",
  "reviewed_this_batch": 81,
  "successful_fetches_this_batch": 273,
  "rejected_queries": 0,
  "unresolved_saturated_queries": 0,
  "historical_coverage_issues": {
    "query_errors": 20,
    "full_single_day": 254,
    "failed_searches": 27
  }
}
```

### Biological Terrorism
```json
{
  "stop": "deadline reached (15 min); review queue saved",
  "reviewed_this_batch": 97,
  "successful_fetches_this_batch": 287,
  "rejected_queries": 0,
  "unresolved_saturated_queries": 0,
  "historical_coverage_issues": {
    "query_errors": 11,
    "full_single_day": 533,
    "failed_searches": 24
  }
}
```

Keyword matching does not establish terrorism. Source validation, English translation, incident deduplication and reported-status safeguards remain enabled.
