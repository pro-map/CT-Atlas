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

## Adding accounts later

Secrets cannot be read back, so new accounts go into a second, optional Worker secret,
`AUTH_USERS_EXTRA_JSON`, with the same `{"username":"sha256(password)"}` format. The Worker
adds its accounts to `AUTH_USERS_JSON`:

- an account that already exists in `AUTH_USERS_JSON` keeps its current password;
- a malformed `AUTH_USERS_EXTRA_JSON` is ignored, so it can never lock out the existing users;
- without `AUTH_USERS_JSON` nobody can log in, as before.

Build it locally with `tools/make_auth_users.py`. It asks for the passwords at hidden prompts
(or for one rule using `{group}`, `{GROUP}`, `{number}`, `{username}`) and outputs only hashes.
Run it from PowerShell or cmd, where the prompts stay hidden, and pipe it straight into Cloudflare:

```
py -3.11 tools/make_auth_users.py --template | npx wrangler secret put AUTH_USERS_EXTRA_JSON --config cloudflare-worker/wrangler.toml
```

Or paste the JSON into Cloudflare dashboard → Workers & Pages → ct-report-generator →
Settings → Variables and Secrets → Add → Secret `AUTH_USERS_EXTRA_JSON`. Putting the secret
again replaces the whole extra roster, so regenerate every extra account each time.
New accounts appear in the admin usage statistics as soon as the secret is set; give them a
display name in `ADMIN_DISPLAY_NAMES` (`cloudflare-worker/report-gate.js`).

The repository must never contain plaintext passwords or the JSON secret.
