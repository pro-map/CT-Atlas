# CT Atlas Report Worker — usage analytics upgrade

This folder contains the upgraded Cloudflare Worker used by CT Atlas.

## What this version adds

- All CT Atlas accounts are recognised by the Worker.
- Report Generator activity is linked to the authenticated username rather than a browser UUID.
- Non-admin accounts are limited to one accepted Report Generator request every 20 minutes.
- `admin` is exempt from the 20-minute per-user interval.
- The existing global concurrency safeguard (maximum four active reports) is preserved.
- The existing global daily safety ceiling (100 accepted report requests/day) is preserved.
- Usage counters are stored in the existing `REPORT_GATE` Durable Object:
  - logins
  - searches
  - map searches
  - event-list searches
  - report requests
  - actual AI reports generated
  - cached reports served
  - blocked report requests
  - last activity
- Admin statistics support Today / 7 days / 30 days / All time.
- Search history (since 2026-10-06): each counted search also stores one row
  `usage-log:<Paris day>:<user>:<feature>:<ms>:<random>` in the same put as its
  counter, with whitelisted, capped fields only (text, filters, address, outcome;
  never tokens or passwords). The admin opens
  it by clicking a count (`GET /usage-history?period=&username=&metric=`, admin
  session only). Rows older than 90 days are deleted by the Durable Object alarm.
- Admin statistics require an authenticated admin session.

## Files

- `deep-search.js` — multilingual search planning, retrieval and reports
- `index.js` — Worker HTTP entry point
- `shared.js` — report generation, authentication and common helpers
- `report-gate.js` — Durable Object, sessions, cooldown and usage accounting

## Deploy to the existing Worker

Deploy these four files to the existing `ct-report-generator` Worker, with `index.js` as the entry module.

Preserve the existing Worker bindings and variables, especially:

- Durable Object binding: `REPORT_GATE`
- `EVENTS_URL`
- `GEMINI_API_KEY`
- `GEMINI_MODEL` if configured
- `ALLOWED_ORIGIN` if configured
- `ADMIN_LOG_KEY` if still used for the legacy `/login-stats` endpoint

Do not create a new Durable Object namespace if the existing Worker already has the `REPORT_GATE` binding; keeping the existing binding preserves its stored data and cache.

## Important

GitHub Pages deployment does not deploy Cloudflare Workers. The Worker files in this folder must therefore be deployed separately to the existing Cloudflare Worker before server-side 20-minute enforcement and the Admin Usage dashboard become authoritative.

## Deep Search v5.9

Country-priority languages receive fallback Google edition searches using the same
native query and are first in GDELT rescue and evidence selection. All 12 languages
are still searched. Search calls are bounded at 36. The planner also identifies local
languages for country names in any language. Old report caches are invalidated.

Deploy the four Worker modules together to the existing ct-report-generator Worker,
preserving its existing bindings and secrets. GitHub Pages only deploys the frontend.
GET /health must report deep_search_version: deep-search-v5.9-local-language-pdf.

Validation: node --test tests/deep-search-recall.test.cjs (5 mocked tests).
These verify priority, fallback requests, request limits, error handling and bounded
PDF pagination. Live search recall and actual browser PDF rendering are not verified.

## Authentication secret

The complete account roster is stored only in the Cloudflare Worker secret
AUTH_USERS_JSON as a JSON object mapping each username to its SHA-256 password
hash. The Worker rejects authentication when the secret is missing, malformed
or incomplete; there is no hard-coded compatibility roster. Do not commit the
JSON or password hashes to the repository.

Accounts added later live in the optional secret AUTH_USERS_EXTRA_JSON (same
format), generated locally with tools/make_auth_users.py. They are added to
AUTH_USERS_JSON; existing accounts keep their password and a malformed extra
secret is ignored. See docs/SECURITY_MIGRATION.md.

## Shared crypto exchange address registry

Exchange labels are stored in the existing `REPORT_GATE` Durable Object. Do not add
a new Durable Object binding or move user workspaces: analyst labels remain private
until their owner proposes them and an admin approves them.

The Crypto admin panel includes an importer for sourced starter addresses from
Crypto.com, Binance, Bybit and OKX. The Binance and Crypto.com lists date to
November 2022 and are partial; the OKX addresses are examples from its official
verification guide, not the full current downloadable list. The Bybit entries are
a subset visible in its official PoR audit PDF. Each label carries its own source
and historical-data caveat.
The admin-only `action=seed` route writes sourced labels into the shared registry and
the Durable Object skips existing addresses. Verify current control before relying on
any historic disclosure. Current full Binance/OKX files could not be fetched from
this environment; do not present these seed records as complete current PoR lists.

- `/crypto-analyze` looks up approved registry labels for the query and its visible
  transaction counterparties. Labels include the chain, exchange name, wallet role,
  confidence, source and reviewer.
- `/crypto-analyze` also returns exchange-behaviour screening for each analysed
  wallet. A candidate is shown only at 80/100 or above; the rules-based score is not
  a calibrated probability and does not prove exchange ownership or custody.
- `/crypto-analyze` also returns `risk_assessment`, from the pure rules in
  `crypto-risk.mjs`. The label is an automated indicator for analyst review, not a
  finding. Its thresholds have only been checked on synthetic fixtures, and the
  response says so. `coverage` states how much history was read.
- `/crypto-workspace` returns a `revision`. A save must send it back and gets 409 with
  the current workspace if it is stale or missing. Alerts and `last_snapshot` belong to
  the gate: a page can edit watches and acknowledge alerts, not replace either.
- `POST /crypto-monitor-check` runs one monitored wallet through the same alert builder
  as the schedule, because the gate will not take alerts from the page.
- In Crypto → Labels & Attribution, analysts can propose an `EXCHANGE` label. Admins
  can review the queue, collect existing private exchange labels for review, or
  import verified CSV/JSON data. Imports are approved immediately and must include
  source information.
- CSV columns: `chain,address,name,wallet_role,confidence,source_type,source_title,source_url,notes`.
  Accepted chain names: `bitcoin`, `ethereum`, `bsc`, `polygon`, `arbitrum`, `base`,
  and `tron`. `bsc` and `base` are labels only: those chains can no longer be analysed
  (see Retired chains). The admin panel can download an empty CSV template.
- The graph and transaction table identify approved exchange addresses by name.
  A transaction relationship alone is never treated as proof that an address
  belongs to an exchange.

The optional provider lookup is disabled by default and makes no extra outbound
requests unless enabled (Etherscan's name-tag endpoint needs a paid Pro Plus plan
and is not used; EVM exchange identification relies on the reviewed registry and
the behaviour score):

- Set `TRONSCAN_TAG_LOOKUP_ENABLED=true` and provide `TRONSCAN_API_KEY` to enable
  TronScan account tags. Its tag endpoint requires a TronScan API key:
  [Get Account Tags](https://docs.tronscan.org/en/api/deep-analysis/account-tag).

Provider results are cached for 24 hours and shown as medium-confidence sourced
tags; they are not added to the reviewed registry automatically. API keys belong in
Cloudflare secrets and must not be committed to Git. The current Worker can keep both
optional flags unset for a no-new-cost setup.

## Crypto provider status

`GET /health` carries `crypto_provider_status`, which answers "which Crypto provider really
works right now, with the real keys?". `/health/status` cannot: it asks Etherscan about chain 1
only, and a plan can allow one chain and refuse another.

`crypto-provider-health.js` runs on the ten-minute cron, at most once an hour, and within ten
minutes of the first deploy. No route can start it. It makes one small call to Blockstream, to
Etherscan V2 for each chain in `EVM_CHAINS`, and to TronGrid, through the same request code as a
real analysis: at most 5 upstream calls an hour, none of them Gemini, and no retry. When
`TRONSCAN_TAG_LOOKUP_ENABLED` and its key are set, Tronscan takes turns with Blockstream, so the
two are each up to two hours old and the budget stays 5. A run skips the six-hour monitor's tick,
which spends the same keys.

Each entry of `providers` has a `status`, its own `checked_at` and a `message` stripped of any
URL, query string, header or key, at most 120 characters.

| `status` | Meaning |
| --- | --- |
| `ok` | The provider answered this key with real data. |
| `rate_limited` | Over a per-second, daily or shared-pool limit, or a short throttle on the Worker's IP after invalid keys. Usually passes by itself. |
| `plan_restricted` | This key's tier does not cover the chain. It says nothing about whether the key is valid: Etherscan answers the same to a key it does not know. Read `etherscan_ethereum` for that. |
| `auth_failed` | The provider refused the key. |
| `unavailable` | No usable answer: down, timed out, not JSON, or an unknown refusal. |
| `not_configured` | No key in the Worker, so no call was made. |

`checked_at: null` with empty `providers` means no run has finished yet. `stale: true` means the
last run is over 130 minutes old, so the result no longer describes the present. `read_failed: true`
means the Durable Object did not answer within 800 ms; `/health` still answers. It reads the object
directly, so it never waits for the EU migration or starts it. An ok on Etherscan
proves the `balance` call for that chain; the status is read through a 60-second cache.

## Retired chains

BNB Smart Chain (`bsc`, chain 56) and Base (`base`, chain 8453) left the tool on 2026-11-07: the
probe, with the real key, found Etherscan answering "Free API access is not supported for this
chain". The analysable chains are now Bitcoin, Ethereum, Polygon, Arbitrum One and TRON.

- A request naming a retired chain gets a 400 that says so, from `/crypto-analyze`,
  `/crypto-monitor-check` and `/crypto-exchange-attribution`. It is never read on another chain.
  Any other chain name the Worker does not know is refused too: only `auto`, or no chain at all,
  reads a 0x address as Ethereum.
- Saved data stays valid. `safeChain` in `crypto-workspace.js` keeps both names on purpose: a blank
  chain would drop a label, watch or cross-chain link at the next save. The page shows them with
  the chain's name and a link to bscscan.com or basescan.org, from its display-only
  `RETIRED_CHAINS`.
- A case on a retired chain takes no new seed or path. Neither has a chain of its own, and nothing
  read now is on that chain, so the page refuses and points to a new case or a cross-chain link.
  Its case PDF says which read its analysis sections come from.
- The monitor does not check these watches. The gate keeps them out of the rotation, so they cost
  no batch slot, and reports them as `retired`; the run counts them under `skipped`. Baselines and
  alerts stay as they are. The page marks them NOT CHECKED and leaves them out of CHECK MONITORED
  NOW.
- `/health` no longer lists `etherscan_bsc` or `etherscan_base`. The gate drops both from a record
  stored before the change.
- Sanctions matching, exchange labels and the risk tables still name both chains. They are
  reference data, not chain APIs.

Deploy `index.js`, `crypto.js`, `crypto-risk.mjs`, `crypto-monitor.js`, `crypto-provider-health.js`, `crypto-workspace.js`,
`exchange-addresses.js`, `exchange-behavior.mjs`, `report-gate.js`, and their existing shared dependencies together to the existing
Worker. GitHub Pages deploys only the Crypto UI; it does not deploy these Worker
routes or Durable Object changes.
