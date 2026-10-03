# Dark Web Intelligence — connecting the collector

The workspace provides an authenticated CT Atlas workspace for known onion outlets:
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
   **main/start page** URL. Set optional comma-separated alert keywords. Re-enter the
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

New PDF/video/audio/image links are acquired after the baseline. File type is
inferred from the path, media tags and Content-Type when visiting extensionless
download links. The initial local inventory is never bulk-downloaded. Thereafter,
failed acquisitions are retried when their links are rediscovered during a later crawl. Files stay
in `private-outlet-watch/evidence`, named by content SHA-256 with a `.bin` suffix.
The local SQLite manifest maps each source URL and title to its hash and size.
No files are executed, rendered, served publicly or sent to an AI provider.

Downloads are capped per file (50 MB by default, configurable to 500 MB). Partial
files are deleted on failure. Redirects outside the registered onion host are
rejected before fetching. An HTML login/error response is not acquired as a file.
There is no overall evidence-directory retention or disk budget in v1; provision
and manage disk storage before running acquisition continuously.

## Recursive collection and coverage

- The first complete inventory is labelled BASELINE and produces no new-item
  alerts. Subsequent previously unseen URLs produce unreviewed feed entries.
- Detection time is **not** publication time. A newly discovered URL is not proof
  of new material, group attribution or a confirmed event.
- URL identity deduplicates repeated scans. A content SHA-256 is available only
  after acquisition. Different URLs with the same hash can be recognized as the
  same downloaded bytes, but each source occurrence remains a separate feed row.
- Keyword alerts match titles and the short page excerpts, not AI threat assessments. ALERTS lists all
  unreviewed discoveries; keyword hits are highlighted. Marking a feed reviewed
  updates only that analyst's state up to the snapshot they viewed.
- Starting from the registered main page, collection follows internal links,
  categories, thread/publication pages, query-string pagination, `rel=next`,
  embedded video/audio sources and same-host frames. The visited queue avoids
  revisiting an identical URL in a cycle. Account/moderation action links and
  static scripts/styles/fonts are skipped; no forms are submitted.
- The SQLite queue persists across passes and restarts. `--pages-per-scan 100`
  limits each pass. Once all reachable queued pages succeed, the cycle completes;
  a subsequent cycle starts at the main page to look for new internal links.
  `--once` means one pass, which may cover only part of a large outlet.
- The initial baseline is finalized only after every queued page succeeds and
  all metadata uploads are acknowledged. Pending/failed pages prevent completion.
  Failed pages are retried up to three times in a pass and then on the next pass.
  Upload failures retain an outbox so already collected metadata is replayed
  without losing the discovery or restarting the crawl.
- `--max-pages 10000` caps successfully visited pages per cycle; it can be raised
  up to 40,000 without losing the pending queue. The frontier also has a 50,000-URL
  guard (it may overshoot by one page of links). Reaching it requires reducing
  crawl scope or a source-specific adapter. Limits are reported, never presented
  as complete coverage. One page can contribute at most 500 links and 2 MB HTML;
  a page hitting the link limit is reported as incomplete and needs an adapter.
- OUTLETS displays cumulative successful pages, pending pages, failed pages and
  incomplete coverage. A network failure is not evidence of no new material.
- Extracted HTML text, including forum comments present in the response, is retained locally in
  the SQLite `pages` table (latest snapshot, up to 100,000 text characters/page).
  Scripts/styles and HTML comments are excluded. A 600-character page excerpt
  and source-page URL accompany feed entries. Text outside that excerpt remains
  local. Existing-page comment edits do not produce separate new-item alerts;
  per-comment change detection is not implemented.
- No JavaScript execution, login bypass or cross-host crawling is performed.
  Material hosted on another onion/clear-web domain, hidden/unlinked pages,
  script-only pagination, player APIs and session-gated content need explicit
  source-specific configuration. Reachable static links are the coverage scope;
  no generic crawler can guarantee discovering every page an outlet contains.
- Server ingestion batches contain at most 100 links and are byte-bounded. The
  online feed retains the newest 500 discoveries. Separate bounded URL-history
  shards prevent ordinary eviction from creating repeat alerts. Local manifests,
  page text and acquired originals remain independent. Stable-URL content
  replacements are not new discoveries in this URL-based alert model.
- A stale check (over 45 minutes) is shown as STALE, rather than LIVE. A successful
  check only establishes success at its recorded time.

## Validation and current activation status

### Publication selection

Traversal and publication selection are separate: internal category and pagination
links are still followed, but an unfetched HTML link is never a feed item. PDF,
video and audio links remain candidates. Standalone images are excluded to avoid
logos, banners and icons. File types are inferred from links or response MIME;
this does not prove that a file is an official publication.

HTML results require substantive body text (at least 1,200 characters in eligible
blocks or accumulated paragraphs), or an explicit comment/reply HTML marker with
at least 80 characters of body text. Navigation, headings, forms, scripts,
footers and link-heavy blocks are excluded. Excerpts come from selected body
text. Comments are currently represented as page results, not individual comment
events. Changes at an existing URL still do not generate new-item alerts.

These are structural rules, not a trained AI model. Unusual HTML, short official
statements and unmarked comments can be missed; long category descriptions can
still pass. Validate examples from each outlet before treating this as a reliable
publication classifier. A future model would need analyst-labelled positive and
negative examples and independent evaluation, especially for source attribution.

Admin keywords only annotate matches in titles/excerpts; they do not select or
exclude publications. Use distinctive topics, organizations or locations you
actually monitor, with relevant spelling/language variants (up to 10 keywords).
Generic words such as PDF, video or إصدار will create broad alerts and do not
establish authenticity. Leaving this field empty does not stop collection.

Updating the local script applies selection to subsequent scans and discards old
navigation entries still waiting in the local upload queue. It does not delete
previously ingested server results. Preserve the state database and evidence:
existing baselines and acquisition history are retained. An unfinished traversal
continues, and previously visited pages are reconsidered in the next full cycle.

Automated tests use synthetic fixtures only. This implementation has not accessed
any operational outlet. Live validation requires the actual listing URLs, Worker
secret and a running collector with Tor. No real-time collection is active merely
because the new workspace has been deployed.

## Windows update from the original single-page collector

Keep the same Worker secret, outlet registrations and `private-outlet-watch`
folder. Download the updated script from the merged main branch:

```cmd
cd /d "%USERPROFILE%\CT-Atlas-Collector"
curl.exe -fL "https://raw.githubusercontent.com/pro-map/CT-Atlas/main/darkweb-collector/collector.py" -o collector.py
py collector.py --proxy socks5h://127.0.0.1:9150 --once --pages-per-scan 10
```

Set `DARKWEB_INGEST_TOKEN` in that CMD session before running the collector, as
before. After the short test, start continuous collection without `--once`:

```cmd
py collector.py --proxy socks5h://127.0.0.1:9150
```

The new SQLite tables are added automatically. If an older single-page collector
already completed its baseline, previously unseen internal URLs will initially
be reported as new discoveries rather than claimed as new publications.
