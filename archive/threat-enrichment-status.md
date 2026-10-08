# Specialist six-month backfill

Last checkpoint (UTC): 2026-10-08T13:29:56.534722+00:00

**A successful batch is not completion of the whole backfill.**

| Category | Main searches processed | Pending searches | Candidates awaiting review | Complete |
|---|---:|---:|---:|---|
| Radiological/Nuclear | 628 / 2133 | 1508 | 16 | No |
| Chemicals and Explosives | 437 / 1836 | 1402 | 9 | No |
| Biological Terrorism | 263 / 1944 | 1689 | 24 | No |

Catch-up rounds started: 5. Acceleration ends at 2026-10-08T22:00:00+00:00.

## Latest batch / source limitations

### Radiological/Nuclear
```json
{
  "stop": "deadline reached (15 min); review queue saved",
  "reviewed_this_batch": 100,
  "coverage_issues": {
    "query_errors": 0,
    "full_single_day": 1,
    "failed_searches": 23
  }
}
```

### Chemicals and Explosives
```json
{
  "stop": "deadline reached (15 min); review queue saved",
  "reviewed_this_batch": 50,
  "coverage_issues": {
    "query_errors": 8,
    "full_single_day": 170,
    "failed_searches": 15
  }
}
```

### Biological Terrorism
```json
{
  "stop": "deadline reached (15 min); review queue saved",
  "reviewed_this_batch": 0,
  "coverage_issues": {
    "query_errors": 4,
    "full_single_day": 367,
    "failed_searches": 15
  }
}
```

Keyword matching does not establish terrorism. Existing source validation, English translation, incident deduplication and reported-status safeguards remain enabled.
