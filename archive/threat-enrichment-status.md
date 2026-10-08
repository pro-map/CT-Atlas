# Specialist six-month backfill

Last checkpoint (UTC): 2026-10-08T12:35:09.839812+00:00

**A successful batch is not completion of the whole backfill.**

| Category | Main searches processed | Pending searches | Candidates awaiting review | Complete |
|---|---:|---:|---:|---|
| Radiological/Nuclear | 617 / 2133 | 1516 | 30 | No |
| Chemicals and Explosives | 346 / 1836 | 1490 | 2 | No |
| Biological Terrorism | 224 / 1944 | 1723 | 17 | No |

Catch-up rounds started: 4. Acceleration ends at 2026-10-08T22:00:00+00:00.

## Latest batch / source limitations

### Radiological/Nuclear
```json
{
  "stop": "deadline reached (15 min); review queue saved",
  "reviewed_this_batch": 525,
  "coverage_issues": {
    "query_errors": 0,
    "full_single_day": 1,
    "failed_searches": 19
  }
}
```

### Chemicals and Explosives
```json
{
  "stop": "deadline reached (15 min); review queue saved",
  "reviewed_this_batch": 50,
  "coverage_issues": {
    "query_errors": 7,
    "full_single_day": 135,
    "failed_searches": 12
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
    "full_single_day": 309,
    "failed_searches": 12
  }
}
```

Keyword matching does not establish terrorism. Existing source validation, English translation, incident deduplication and reported-status safeguards remain enabled.
