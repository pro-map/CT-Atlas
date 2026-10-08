# Specialist six-month backfill

Last checkpoint (UTC): 2026-10-08T11:01:55.135719+00:00

**A successful batch is not completion of the whole backfill.**

| Category | Main searches processed | Pending searches | Candidates awaiting review | Complete |
|---|---:|---:|---:|---|
| Radiological/Nuclear | 462 / 2133 | 1672 | 13 | No |
| Chemicals and Explosives | 183 / 1836 | 1654 | 14 | No |
| Biological Terrorism | 136 / 1944 | 1819 | 18 | No |

Catch-up rounds started: 2. Acceleration ends at 2026-10-08T22:00:00+00:00.

## Latest batch / source limitations

### Radiological/Nuclear
```json
{
  "stop": "deadline reached (15 min); review queue saved",
  "reviewed_this_batch": 450,
  "coverage_issues": {
    "query_errors": 0,
    "full_single_day": 1,
    "failed_searches": 13
  }
}
```

### Chemicals and Explosives
```json
{
  "stop": "deadline reached (15 min); review queue saved",
  "reviewed_this_batch": 75,
  "coverage_issues": {
    "query_errors": 3,
    "full_single_day": 71,
    "failed_searches": 6
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
    "full_single_day": 171,
    "failed_searches": 6
  }
}
```

Keyword matching does not establish terrorism. Existing source validation, English translation, incident deduplication and reported-status safeguards remain enabled.
