# Specialist six-month backfill

Last checkpoint (UTC): 2026-10-08T15:08:43.505364+00:00

**A successful batch is not completion of the whole backfill.**

| Category | Main searches processed | Pending searches | Candidates awaiting review | Complete |
|---|---:|---:|---:|---|
| Radiological/Nuclear | 693 / 2133 | 1442 | 10 | No |
| Chemicals and Explosives | 527 / 1836 | 1309 | 2 | No |
| Biological Terrorism | 339 / 1944 | 1606 | 2 | No |

Catch-up rounds started: 7. Acceleration ends at 2026-10-08T22:00:00+00:00.

## Latest batch / source limitations

### Radiological/Nuclear
```json
{
  "stop": "deadline reached (15 min); review queue saved",
  "reviewed_this_batch": 175,
  "coverage_issues": {
    "query_errors": 0,
    "full_single_day": 1,
    "failed_searches": 31
  }
}
```

### Chemicals and Explosives
```json
{
  "stop": "deadline reached (15 min); review queue saved",
  "reviewed_this_batch": 50,
  "coverage_issues": {
    "query_errors": 13,
    "full_single_day": 205,
    "failed_searches": 21
  }
}
```

### Biological Terrorism
```json
{
  "stop": "deadline reached (15 min); review queue saved",
  "reviewed_this_batch": 0,
  "coverage_issues": {
    "query_errors": 9,
    "full_single_day": 477,
    "failed_searches": 21
  }
}
```

Keyword matching does not establish terrorism. Existing source validation, English translation, incident deduplication and reported-status safeguards remain enabled.
