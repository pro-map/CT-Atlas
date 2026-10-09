# Specialist six-month backfill

Last checkpoint (UTC): 2026-10-09T10:16:42.930951+00:00

**Batch result: partial. Whole backfill complete: NO.**

| Category | Root queries processed / planned | Rejected queries | Pending work | Awaiting AI review | New event records this batch |
|---|---:|---:|---:|---:|---:|
| Radiological/Nuclear | 1192 / 7236 | 0 | 6047 | 0 | 6 |
| Chemicals and Explosives | 941 / 2241 | 0 | 1301 | 0 | 6 |
| Biological Terrorism | 435 / 2754 | 0 | 2321 | 0 | 0 |

Processed roots include windows replaced by narrower queries. Rejected queries are NOT successful retrievals. Pending work includes these replacement queries and tasks awaiting review.

Catch-up rounds started: 4. Acceleration ends at 2026-10-09T22:00:00+00:00.

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
  "reviewed_this_batch": 655,
  "successful_fetches_this_batch": 196,
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
  "reviewed_this_batch": 52,
  "successful_fetches_this_batch": 271,
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
  "reviewed_this_batch": 11,
  "successful_fetches_this_batch": 294,
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
