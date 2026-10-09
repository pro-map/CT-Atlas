# Specialist six-month backfill

Last checkpoint (UTC): 2026-10-09T08:43:13.792000+00:00

**Batch result: partial. Whole backfill complete: NO.**

| Category | Root queries processed / planned | Rejected queries | Pending work | Awaiting AI review | New event records this batch |
|---|---:|---:|---:|---:|---:|
| Radiological/Nuclear | 851 / 2160 | 0 | 1312 | 0 | 2 |
| Chemicals and Explosives | 733 / 2241 | 0 | 1511 | 0 | 8 |
| Biological Terrorism | 393 / 2754 | 0 | 2365 | 0 | 0 |

Processed roots include windows replaced by narrower queries. Rejected queries are NOT successful retrievals. Pending work includes these replacement queries and tasks awaiting review.

Catch-up rounds started: 2. Acceleration ends at 2026-10-09T22:00:00+00:00.

## Latest batch / source limitations

### Radiological/Nuclear
```json
{
  "stop": "deadline reached (15 min); review queue saved",
  "reviewed_this_batch": 457,
  "successful_fetches_this_batch": 141,
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
  "stop": "deadline reached (14 min); review queue saved",
  "reviewed_this_batch": 86,
  "successful_fetches_this_batch": 210,
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
  "reviewed_this_batch": 183,
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
