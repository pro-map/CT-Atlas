# Specialist six-month backfill

Last checkpoint (UTC): 2026-10-09T09:29:59.482310+00:00

**Batch result: partial. Whole backfill complete: NO.**

| Category | Root queries processed / planned | Rejected queries | Pending work | Awaiting AI review | New event records this batch |
|---|---:|---:|---:|---:|---:|
| Radiological/Nuclear | 996 / 7236 | 0 | 6243 | 0 | 1 |
| Chemicals and Explosives | 837 / 2241 | 0 | 1406 | 0 | 13 |
| Biological Terrorism | 414 / 2754 | 0 | 2343 | 0 | 1 |

Processed roots include windows replaced by narrower queries. Rejected queries are NOT successful retrievals. Pending work includes these replacement queries and tasks awaiting review.

Catch-up rounds started: 3. Acceleration ends at 2026-10-09T22:00:00+00:00.

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
  "reviewed_this_batch": 656,
  "successful_fetches_this_batch": 145,
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
  "reviewed_this_batch": 99,
  "successful_fetches_this_batch": 267,
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
  "reviewed_this_batch": 60,
  "successful_fetches_this_batch": 256,
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
