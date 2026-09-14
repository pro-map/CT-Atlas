# CT Atlas authentication migration

The frontend now authenticates against the Worker and validates the session server-side. The Worker accepts a secret-backed user roster through `AUTH_USERS_JSON`.

## Required secret

Create a JSON object whose values are SHA-256 password hashes:

```json
{"group-i-1":"<64-hex-character-sha256>","admin":"<64-hex-character-sha256>"}
```

Store the complete JSON as the GitHub Actions repository secret:

```
CT_ATLAS_AUTH_USERS_JSON
```

The Worker deployment workflow provisions it automatically when the secret exists. After deployment, `/health` must report `{"auth_mode":"secret"}`.

Only then should the legacy compatibility roster in `cloudflare-worker/shared.js` be removed and all user passwords rotated.

The repository must never contain plaintext passwords or the JSON secret.
