# Dark Web Intelligence — structured publications

Version: `darkweb-v6-private-pdfs`. Create the private R2 bucket below before
deploying the Worker/UI, then update the Windows collector. Existing collection
state and downloaded files are reused; do not reset results or delete SQLite.
The existing collector credential is reused. Ingest protocol 2 stays compatible.

## Activate private PDF storage (before merging/deploying)

1. In Cloudflare, open **Storage & databases → R2 → Overview** and activate R2.
   Activation includes a subscription/checkout flow even when usage stays within
   the free allowances. This PR does not activate billing or create the bucket.
2. Create a dedicated bucket named **`ct-atlas-darkweb-files`**, with **Standard**
   storage. Leave both the public `r2.dev` URL and custom public domains disabled.
3. Merge/deploy this PR. `cloudflare-worker/wrangler.toml` binds that bucket as
   **`DARKWEB_FILES`** on `ct-report-generator`. The bucket must exist first;
   otherwise the Worker deployment fails. No new collector secret is needed.
4. Check `/health`: `darkweb_pdf_storage_configured` should be `true`. In the
   Dark Web admin tab, **Private PDF storage** shows the usage and storage limit.
5. Stop the old collector with Ctrl+C, update `collector.py` as below, and resume
   the same command. Keep the `private-outlet-watch` directory unchanged.

The default limit is **8 GB decimal**, adjustable between 1 MB and 10 GB in
Atlas. It includes completed objects and bytes reserved for interrupted uploads.
New objects are refused at the limit; existing downloads and local evidence are
preserved. The counter covers only this module's dedicated bucket objects; other
R2 buckets, manual uploads and other Cloudflare services are outside this limit.
It is not a guarantee against charges for other account usage or operation quotas.

Existing structured PDFs are synchronized automatically, at most two per
outlet/pass. For a transfer-only pass (without any source/Tor request), use:

```cmd
py collector.py --only-outlet "YOUR-REGISTERED-OUTLET-ID" --upload-only --once
```

Remove `--once` to drain the existing local files in bounded passes; Ctrl+C stops
the process. A new CMD window still needs `DARKWEB_INGEST_TOKEN`. Upload-only mode
needs Atlas connectivity, not Tor. Collection must be enabled and not paused.
Normal mode uploads after each collection pass, using already acquired files.

References: [R2 activation](https://developers.cloudflare.com/r2/get-started/),
[R2 pricing](https://developers.cloudflare.com/r2/pricing/),
[Worker binding](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/).

## Validated structure

The supplied saved homepage contains 12 `post-card` blocks and links to page 221.
Its `post-summary` is the Arabic title, `card-footer` contains the Arabic date,
and the reading link identifies the publication. The supplied short news detail
uses `read-area`, `title` and `post-content`; its entire news text is in the title,
with an empty body. The supplied magazine detail exposes a PDF through the
viewer's relative, percent-encoded `data-url`. This resolves to one PDF attachment;
viewer page counters and controls are excluded from publication text. No real
onion address or supplied propaganda HTML is stored in this repository. Tests use
neutral, synthetic versions of the observed layout.

The adapter recognizes these structural markers automatically. It collects each
card separately, follows the list's own pagination, and opens every permalink.
It excludes sidebars, navigation, donation prompts, and previous/next story boxes.
A detail page replaces the listing excerpt without generating another record.
Revisiting a list or running an older collector cannot replace a complete record
with its shorter excerpt. Other site templates retain the generic parser.

Supported source categories:

- `news`: news and communiqués, including short title-only statements.
- `naba`: magazine publication records.
- `videos`: video publication records.
- `audios`: audio publication records.

These are source categories, not authenticity findings. A magazine title alone
is not evidence of the document's contents.

## Windows update and a single-outlet run

Stop the collector with **Ctrl+C**. Keep Tor Browser connected. In CMD:

```cmd
cd /d "%USERPROFILE%\CT-Atlas-Collector"
curl.exe -fL "https://raw.githubusercontent.com/pro-map/CT-Atlas/main/darkweb-collector/collector.py" -o collector.py
```

Use the existing requirements/environment and `DARKWEB_INGEST_TOKEN`. A new CMD
window needs the existing collector secret again; do not publish it or paste it
into a repository issue. If dependencies are missing:

```cmd
curl.exe -fL "https://raw.githubusercontent.com/pro-map/CT-Atlas/main/darkweb-collector/requirements.txt" -o requirements.txt
py -m pip install -r requirements.txt
set /p "DARKWEB_INGEST_TOKEN=Paste the collector secret and press Enter: "
```

For a first bounded pass, substitute the exact registered starting URL:

```cmd
py collector.py --proxy socks5h://127.0.0.1:9150 --only-outlet "http://YOUR-REGISTERED-OUTLET.onion/" --once
```

Then remove `--once` to continue the archive traversal and enter ongoing watch.
`--only-outlet` also accepts the registered outlet ID. It does not change the
other outlets' server settings. An unregistered or disabled selection produces
an error. No source page needs to be opened manually in Tor Browser.

The first run after this parser upgrade revisits the selected outlet's pages
without deleting existing metadata or evidence. Its queue survives restarts.
Initial backfill continues in bounded passes, with a minimum 15-second cadence
(or the duration of the pass if longer), and the existing delay between source
requests. After backfill, the default watch interval is 15 minutes. Tor and the
collector window must remain open; Ctrl+C stops the process cleanly.

### Source connection failures

Tor source requests allow 90 seconds to establish a connection, including the
SOCKS handshake, and a 90-second read timeout. The previous 30-second connection
budget could expire while establishing a slow onion connection. Set
`--connect-timeout 120` if needed (10–300 seconds). The read timeout measures
network inactivity, not the total page download duration. API timeouts are unchanged.

Page failures report a timeout, connection category, HTTP status, known collection
limit or exception type, without emitting source URLs, response text or credentials.
The failed page remains queued. A successful curl response through the same proxy
establishes reachability at that time, not the cause of a previous Python failure.
No reset or new collector key is needed to retry with this update.

## Arabic, English, files and exports

Original Arabic text is stored separately from AI fields. The adapter preserves
Unicode and paragraph breaks while normalizing HTML layout whitespace. Short
news text contained entirely in the title is retained. Complete detail records
are distinguishable from listing-only records and truncated records.

Every structured publication has its own stable identity based on outlet and
permalink, original title/text, publication date and its raw source label,
category, source link, collection timestamps, and associated attachments.
PDF/audio/video/image links inside the article remain in the same publication.
Same-host PDF.js `file=` links and media/embed/data-URL attributes are supported.
Scripts are never executed. Cross-host files are not fetched.

**PDFs:** up to two attachment downloads per outlet/pass, including historical
backfill. Default file cap: 50 MiB (`--max-file-mb`, allowed 1–500). Originals are
stored on the collector computer in `private-outlet-watch/evidence/SHA256.pdf`.
The header must start `%PDF-`; HTML responses and oversized files are rejected,
partial files removed, and identical bytes share a hash-named file. Metadata
records the acquisition status, hash and byte count. Up to three failed attempts
are made automatically. Other original media are not automatically downloaded.
The legacy `--acquire` option retains its original generic-media behavior.

**PDF access in Atlas:** acquired structured PDF attachments up to **50 MiB**
are uploaded over authenticated HTTPS to private R2 storage. The collector
checks the local signature, size and SHA-256; the Worker binds the request to a
current registered attachment, streams bounded bytes and lets R2 verify SHA-256.
Uploads use the existing ingest credential. Reads require an allowed Atlas
session, never the ingest credential, a public R2 URL or a token in the URL.
**OPEN PDF** and **DOWNLOAD PDF** appear only after the server acknowledges storage.
The browser fetches the authenticated PDF into a temporary blob; it needs neither
Tor nor the collector to read an uploaded PDF. Downloads retain readable Arabic
filenames. **COPY FILE URL** still copies the source onion link and requires Tor.

Retries check the server before sending bytes again. A write with a lost
acknowledgement is found by its hash; it neither duplicates the object nor adds
its size twice. Missing/corrupt/oversized local files remain pending, with bounded
retry backoff. Increasing local acquisition beyond 50 MiB does not increase the
Atlas upload limit. Automatic syncing covers structured publication attachments;
unassociated legacy binary files are not uploaded blindly.

Interrupted uploads retain their quota reservation until a successful retry;
this prevents undercounting an R2 write whose acknowledgement was lost. Resetting
the feed does not delete R2 objects or release that storage budget. Old objects
cannot be downloaded through Atlas unless a current publication references them.
Do not manually alter the dedicated bucket or the accounting keys; removing
orphaned objects and reconciling usage is a separate administrative operation.

**Exports:** each structured card has HTML and JSON exports. The HTML file opens
independently, with original Arabic, separately labelled English overview, date,
source, collection time and attachment metadata. It contains no scripts, remote
images or embedded credentials. Exports do not embed the original PDF. JSON
preserves the publication fields for further analytical work.

**English:** the existing Gemini configuration faithfully translates the entire
Arabic title into English. It is instructed to preserve names, dates, numbers
and attributed claims rather than invent or summarize a headline. Original
Arabic remains visible beside the labelled machine translation. Existing
generated English titles are progressively requeued without resetting records.
A separate one/two-sentence overview is based only on supplied page text. Up to
8,000 characters of original text are sent per item; a flag tells the model when
that input is excerpted. Onion links are removed. It does not read PDFs, listen
to audio or view videos. Model output must attribute claims to the source.

AI enrichment runs when the admin opens/refreshes the tab, in batches of up to
10 records (with a 6,000-character combined title budget), at most once per minute
globally. A pending queue also covers older
archived publications. It is not an unattended AI scheduler. Failures preserve
original Arabic and show pending status. Source changes invalidate the English
fields; content fingerprints prevent an old in-flight response from replacing
newer material. Semantic accuracy still needs analyst review.

The top briefing uses up to 20 latest publication titles/excerpts/dates, including
archived records, with source links. It describes publications and source claims,
not verified events or the current situation independently of publication dates.

## Archive and collection controls

**PUBLICATIONS** is the structured archive, loaded 50 records at a time in reverse
publication-date order. **LOAD OLDER PUBLICATIONS** advances its cursor. Filters
apply to loaded records, as stated beside the list. Original text is fetched when
opening a card or exporting, keeping list responses small.

Structured records are retained independently of the 500-item legacy/hot feed.
**OTHER MATERIAL** retains access to earlier generic collection results. This
upgrade does not automatically delete those results, source registrations or
local evidence. The archive requires storage proportional to the collected
records; it is not an unlimited-storage guarantee.

Admin controls:

- **From / Through:** collection remains restricted to the selected publication
  period. Traversal can follow all list pages, but out-of-period records are not
  retained or downloaded. Future dates are excluded.
- **Pages per pass:** 1–50, default 10; the CLI limit is an additional ceiling.
- **Pause / Resume:** read before each pass. A request already in flight can
  finish; ingest is refused while paused.
- **Previews:** optional, up to two attempts/pass and 8 MiB/source, JPEG thumbnails
  up to 240×240 pixels. PDFs use the first page; images use Pillow; video posters
  or optional FFmpeg may supply a frame. If a PDF cannot yield a preview, its
  page's cover image is tried. Older unsuccessful previews are retried once with
  this update. Cards display compact 72×82px visuals (56×66px on mobile); a neutral
  file-type icon appears until a source image loads. Audio normally uses that icon.
- **RESET RESULTS & COLLECT THIS PERIOD:** explicitly deletes both the online feed
  and structured archive, and resets collector metadata next pass. Original local
  evidence and outlet registrations are preserved. Date-range changes require
  this action. Do not delete the local SQLite database manually to restart.

Backfill is capped at 10,000 pages/outlet and a 50,000-entry local frontier.
Afterward watch follows the start page and links two levels deep, up to 200 pages
per round; deeper newly added publications may need another backfill. Failed
pages are retried and displayed. Limits/failures never imply complete coverage.
No number of pages is hardcoded from the saved homepage's 221-page snapshot.

Full dates are read from explicit publication metadata or per-card Arabic day,
month and year labels (including Arabic-Indic digits). Crawl time and HTTP
Last-Modified are never substituted for publication dates. Undated candidates
stay in the bounded local SQLite review queue (500 latest), with an admin count.
Keywords annotate title/excerpt matches; they do not determine eligibility.

Limits per structured record: 48 KB of UTF-8 original text, 2,000 title characters,
12 attachments. Larger source text/attachment sets are labelled incomplete;
source links remain available. Truncation is never presented as full capture.

## Security and validation

All source requests use a loopback `socks5h` Tor proxy (9150 for Tor Browser,
commonly 9050 for a standalone Tor service), remote DNS, and same-onion-host
redirect validation before every request. There is no direct source fallback,
form submission or login bypass. Collector credentials travel only to the
configured HTTPS API origin. The clearnet UI never requests an onion URL.

Feed, archive, detail, thumbnail and PDF download endpoints require an allowed Atlas session.
Admin controls and AI generation require admin; ingest/config use the separate
collector credential. Payload, date, epoch and pause checks apply to every batch.
Source/model text is rendered with textContent, not inserted as HTML. Inert HTML
exports encode source text and apply a restrictive Content Security Policy.

Validation uses the three supplied saved pages, synthetic pagination/PDF fixtures,
collector tests and authenticated Worker/storage tests (including >500 archived
records, reset and stale AI races). The magazine detail's PDF link and viewer
markup are validated; a listing's unavailable preview is retried when its detail
reveals the PDF. The actual PDF bytes were not supplied or fetched over Tor here.
The saved viewer's page count is not an independently verified PDF page count.
Successful saved-page tests do not establish live availability or exhaustive site
coverage.

Private PDF storage is tested with an emulated R2 bucket, including content-hash
validation, fragmented/truncated uploads, authenticated downloads, concurrent
quota reservations and recovery after a lost acknowledgement. Chromium checks
cover the download bytes and Arabic filename, the open action, compact previews,
placeholder icons, storage-limit editing and mobile layout using mocked API
responses. Provisioning the actual R2 bucket and the first live upload remain
deployment checks. The headless test does not validate native PDF viewer rendering.
