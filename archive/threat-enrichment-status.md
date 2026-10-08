# Specialist six-month backfill

Last checkpoint (UTC): 2026-10-08T17:12:02.927462+00:00

**A successful batch is not completion of the whole backfill.**

| Category | Main searches processed | Pending searches | Candidates awaiting review | Complete |
|---|---:|---:|---:|---|
| Radiological/Nuclear | 0 / 0 | ? | 0 | No |
| Chemicals and Explosives | 652 / 1836 | 1187 | 22 | No |
| Biological Terrorism | 0 / 0 | ? | 0 | No |

Catch-up rounds started: 9. Acceleration ends at 2026-10-08T22:00:00+00:00.

## Latest batch / source limitations

### Radiological/Nuclear
```json
{
  "stop": null,
  "reviewed_this_batch": 0,
  "coverage_issues": {}
}
```

### Chemicals and Explosives
```json
{
  "stop": "deadline reached (15 min); review queue saved",
  "reviewed_this_batch": 0,
  "coverage_issues": {
    "query_errors": 20,
    "full_single_day": 254,
    "failed_searches": 27
  }
}
```

### Biological Terrorism
```json
{
  "stop": null,
  "reviewed_this_batch": 0,
  "coverage_issues": {}
}
```

Keyword matching does not establish terrorism. Existing source validation, English translation, incident deduplication and reported-status safeguards remain enabled.
