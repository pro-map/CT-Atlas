# Specialist six-month backfill

Last checkpoint (UTC): 2026-10-08T10:15:14.188454+00:00

**A successful batch is not completion of the whole backfill.**

| Category | Main searches processed | Pending searches | Candidates awaiting review | Complete |
|---|---:|---:|---:|---|
| Radiological/Nuclear | 392 / 2133 | 1743 | 7 | No |
| Chemicals and Explosives | 109 / 1836 | 1730 | 16 | No |
| Biological Terrorism | 85 / 1944 | 1867 | 14 | No |

Catch-up rounds started: 1. Acceleration ends at 2026-10-08T22:00:00+00:00.

## Latest batch / source limitations

### Radiological/Nuclear
```json
{
  "stop": "deadline reached (15 min); review queue saved",
  "reviewed_this_batch": 475,
  "coverage_issues": {
    "query_errors": 0,
    "full_single_day": 1,
    "failed_searches": 10
  }
}
```

### Chemicals and Explosives
```json
{
  "stop": "deadline reached (15 min); review queue saved",
  "reviewed_this_batch": 100,
  "coverage_issues": {
    "query_errors": 1,
    "full_single_day": 42,
    "failed_searches": 3
  }
}
```

### Biological Terrorism
```json
{
  "stop": "deadline reached (15 min); review queue saved",
  "reviewed_this_batch": 0,
  "coverage_issues": {
    "query_errors": 2,
    "full_single_day": 99,
    "failed_searches": 3
  }
}
```

Keyword matching does not establish terrorism. Existing source validation, English translation, incident deduplication and reported-status safeguards remain enabled.
