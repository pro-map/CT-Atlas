# Dark Web Intelligence — connecting the collector

This first version adds an authenticated CT Atlas workspace for known onion outlets:
Latest, Outlets, Alerts and Tor Connection. Only the admin may register or update
outlets. All authenticated CT Atlas accounts can read the shared feed. The public
repository contains no outlet addresses, original evidence or collector credential.

## Architecture

The collector runs beside a Tor client on your own machine or a dedicated host.
It fetches source pages through `socks5h://127.0.0.1:9050`, so onion hostnames are
passed to Tor. It then sends metadata over HTTPS to the existing CT Atlas Worker.
The existing authenticated Worker and private ReportGate storage serve the feed.
There is no inbound collector API, open SOCKS port, public Tor gateway or embedded
Tor browser. The Worker does not run the Tor process.

A computer is sufficient for testing. Continuous monitoring needs a machine that
remains powered on, with the collector and Tor supervised by its service manager.
Tor Browser commonly uses local port 9150; a standalone Tor client commonly uses
9050. Confirm your actual SOCKS listener before choosing the collector parameter.
Never expose that port to the Internet. The collector refuses non-local proxies
and requires `socks5h`, with no direct-network fallback for source requests.

## Setup

1. Merge and deploy the UI and report Worker changes. No new database binding is
   required. The existing ReportGate stores bounded private metadata.
2. Generate a random token of at least 32 characters, e.g.:

   ```bash
   python -c 'import secrets; print(secrets.token_urlsafe(48))'
   ```

3. Set `DARKWEB_INGEST_TOKEN` as a **Cloudflare Worker secret** on
   `ct-report-generator`, using the Cloudflare dashboard or, from `cloudflare-worker`:

   ```bash
   npx wrangler secret put DARKWEB_INGEST_TOKEN
   ```

   Paste the same token into the collector's environment. Do not put it in the
   frontend, a URL, the public repository or a GitHub issue.
4. Start Tor locally. Install collector dependencies:

   ```bash
   python -m pip install -r darkweb-collector/requirements.txt
   ```

5. Sign in as admin, open Dark Web Intelligence → OUTLETS, and register each known
   **listing page** URL. Set optional comma-separated alert keywords. Re-enter the
   same URL to update a record, or use EDIT OUTLET. Uncheck monitoring to pause it.
   At most 20 sources can be registered. This version follows links only on the
   same v3 onion host, without a nonstandard port or embedded URL credentials.
6. Supply the token to the collector and run one inventory scan:

   Linux/macOS shell (read without echoing the token):

   ```bash
   read -rs DARKWEB_INGEST_TOKEN
   export DARKWEB_INGEST_TOKEN
   python darkweb-collector/collector.py --once
   ```

   Windows PowerShell (read token interactively):

   ```powershell
   $collectorSecret = Read-Host 'Collector token' -AsSecureString
   $env:DARKWEB_INGEST_TOKEN = [System.Net.NetworkCredential]::new('', $collectorSecret).Password
   python darkweb-collector/collector.py --proxy socks5h://127.0.0.1:9150 --once
   ```

7. Confirm a recent successful check in CT Atlas. Start continuous monitoring:

   ```bash
   python darkweb-collector/collector.py
   ```

   With Tor Browser on port 9150, append `--proxy socks5h://127.0.0.1:9150`.
   The default polling interval is 15 minutes (`--interval 900`). No email or
   external messaging is sent; alerts appear in the CT Atlas workspace.

## Optional local acquisition

```bash
python darkweb-collector/collector.py --acquire --max-file-mb 50
```

Only new links classified by their path extension as PDF/video/audio/image are
acquired. The initial local inventory is never bulk-downloaded. Thereafter,
failed acquisitions are retried if their links remain in the listing. Files stay
in `private-outlet-watch/evidence`, named by content SHA-256 with a `.bin` suffix.
The local SQLite manifest maps each source URL and title to its hash and size.
No files are executed, rendered, served publicly or sent to an AI provider.

Downloads are capped per file (50 MB by default, configurable to 500 MB). Partial
files are deleted on failure. Redirects outside the registered onion host are
rejected before fetching. An HTML login/error response is not acquired as a file.
There is no overall evidence-directory retention or disk budget in v1; provision
and manage disk storage before running acquisition continuously.

## What the first version can establish

- The first complete inventory is labelled BASELINE and produces no new-item
  alerts. Subsequent previously unseen URLs produce unreviewed feed entries.
- Detection time is **not** publication time. A newly discovered URL is not proof
  of new material, group attribution or a confirmed event.
- URL identity deduplicates repeated scans. A content SHA-256 is available only
  after acquisition. Different URLs with the same hash can be recognized as the
  same downloaded bytes, but each source occurrence remains a separate feed row.
- Keyword alerts are title matches, not AI threat assessments. ALERTS lists all
  unreviewed discoveries; keyword hits are highlighted. Marking a feed reviewed
  updates only that analyst's state up to the snapshot they viewed.
- Collection does not browse subpages recursively, execute JavaScript, bypass
  accounts/captchas, download external-host files or search the entire dark web.
  Outlets with script-generated listings, detail-page download buttons, RSS or
  custom pagination will need source-specific adapters after their structure is
  inspected. The generic parser records same-host anchors from a single listing.
- Listing HTML is limited to 2 MB and 500 unique links per scan. Truncation is
  displayed and does not finalize the initial baseline. Server ingestion batches
  contain at most 100 links. The online feed retains the newest 500 discoveries;
  the local manifest/evidence remain independent. Separate bounded URL-history
  shards (up to 32,768 fingerprints per outlet) prevent ordinary feed eviction
  from creating repeat alerts. Once a fingerprint ages out of that history it
  can be rediscovered; this bounded feed is not a complete archive. Replaced
  content at an already known URL is not detected by this link-based version.
- A stale check (over 45 minutes) is shown as STALE, rather than LIVE. A successful
  check only establishes success at its recorded time.

## Validation and current activation status

Automated tests use synthetic fixtures only. This implementation has not accessed
any operational outlet. Live validation requires the actual listing URLs, Worker
secret and a running collector with Tor. No real-time collection is active merely
because the new workspace has been deployed.
