# Specialist six-month backfill

Last checkpoint (UTC): 2026-10-08T14:19:23.250640+00:00

**A successful batch is not completion of the whole backfill.**

| Category | Main searches processed | Pending searches | Candidates awaiting review | Complete |
|---|---:|---:|---:|---|
| Radiological/Nuclear | 631 / 2133 | 1504 | 0 | No |
| Chemicals and Explosives | 479 / 1836 | 1357 | 0 | No |
| Biological Terrorism | 303 / 1944 | 1641 | 1 | No |

Catch-up rounds started: 6. Acceleration ends at 2026-10-08T22:00:00+00:00.

## Latest batch / source limitations

### Radiological/Nuclear
```json
{
  "stop": "deadline reached (14 min); review queue saved",
  "reviewed_this_batch": 125,
  "coverage_issues": {
    "query_errors": 0,
    "full_single_day": 1,
    "failed_searches": 28
  }
}
```

### Chemicals and Explosives
```json
{
  "stop": "deadline reached (15 min); review queue saved",
  "reviewed_this_batch": 50,
  "coverage_issues": {
    "query_errors": 10,
    "full_single_day": 184,
    "failed_searches": 18
  }
}
```

### Biological Terrorism
```json
{
  "stop": "deadline reached (15 min); review queue saved",
  "reviewed_this_batch": 25,
  "coverage_issues": {
    "query_errors": 7,
    "full_single_day": 421,
    "failed_searches": 18
  }
}
```

Keyword matching does not establish terrorism. Existing source validation, English translation, incident deduplication and reported-status safeguards remain enabled.
