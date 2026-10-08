# Specialist six-month backfill

Last checkpoint (UTC): 2026-10-08T11:48:36.979974+00:00

**A successful batch is not completion of the whole backfill.**

| Category | Main searches processed | Pending searches | Candidates awaiting review | Complete |
|---|---:|---:|---:|---|
| Radiological/Nuclear | 534 / 2133 | 1600 | 6 | No |
| Chemicals and Explosives | 249 / 1836 | 1587 | 0 | No |
| Biological Terrorism | 177 / 1944 | 1770 | 4 | No |

Catch-up rounds started: 3. Acceleration ends at 2026-10-08T22:00:00+00:00.

## Latest batch / source limitations

### Radiological/Nuclear
```json
{
  "stop": "deadline reached (15 min); review queue saved",
  "reviewed_this_batch": 350,
  "coverage_issues": {
    "query_errors": 0,
    "full_single_day": 1,
    "failed_searches": 16
  }
}
```

### Chemicals and Explosives
```json
{
  "stop": "deadline reached (15 min); review queue saved",
  "reviewed_this_batch": 25,
  "coverage_issues": {
    "query_errors": 7,
    "full_single_day": 93,
    "failed_searches": 9
  }
}
```

### Biological Terrorism
```json
{
  "stop": "deadline reached (15 min); review queue saved",
  "reviewed_this_batch": 25,
  "coverage_issues": {
    "query_errors": 2,
    "full_single_day": 239,
    "failed_searches": 9
  }
}
```

Keyword matching does not establish terrorism. Existing source validation, English translation, incident deduplication and reported-status safeguards remain enabled.
