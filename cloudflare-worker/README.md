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
- Search terms themselves are not stored.
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
- In Crypto → Labels & Attribution, analysts can propose an `EXCHANGE` label. Admins
  can review the queue, collect existing private exchange labels for review, or
  import verified CSV/JSON data. Imports are approved immediately and must include
  source information.
- CSV columns: `chain,address,name,wallet_role,confidence,source_type,source_title,source_url,notes`.
  Accepted chain names: `bitcoin`, `ethereum`, `bsc`, `polygon`, `arbitrum`, `base`,
  and `tron`. The admin panel can download an empty CSV template.
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

Deploy `index.js`, `crypto.js`, `crypto-workspace.js`, `exchange-addresses.js`,
`exchange-behavior.mjs`, `report-gate.js`, and their existing shared dependencies together to the existing
Worker. GitHub Pages deploys only the Crypto UI; it does not deploy these Worker
routes or Durable Object changes.
