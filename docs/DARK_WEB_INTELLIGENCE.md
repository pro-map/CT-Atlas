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
with its shorter excerpt. Other site templates use the generic article adapter
or the generic parser (see the next section).

Supported source categories:

- `news`: news and communiqués, including short title-only statements.
- `naba`: magazine publication records.
- `videos`: video publication records.
- `audios`: audio publication records.

These are source categories, not authenticity findings. A magazine title alone
is not evidence of the document's contents.

## Latin-script and multilingual outlets

The structured adapter above was built for one Arabic outlet. Outlets written in
Latin-script languages (for example Turkish, Bosnian/Croatian/Serbian Latin,
Albanian, Kurmanji Kurdish, Indonesian/Malay, French, German or English) use the
same pipeline with the following additions. Nobody has to describe the outlet's
markup in advance: common WordPress, Blogger and generic article layouts are
recognized from their standard markers.

**Collector**

- **Multilingual dates:** besides ISO dates and Arabic day/month/year labels, the
  date parser reads Latin month names (full and abbreviated) in the languages
  above and day-first numeric dates such as `12.10.2026`. Month names are
  compared after removing diacritics and folding the Turkish dotted and dotless
  `i`, so `12 EKİM 2026` and `12 ekim 2026` give the same date. Relative labels
  ("2 gün önce", "il y a 2 jours") remain undated: crawl time is never used as
  a publication date, and undated items stay in local review as before. The
  Arabic outlet's template keeps its previous date rule (the first ISO date,
  then an Arabic day-month-year date), so its stored dates, and therefore its
  translations, do not change.
- **Generic article adapter:** an article page outside the Arabic template
  becomes a structured record (`publication_version` 1) with the same fields as
  the Arabic detail records: URL, cleaned title, original text, category (from
  the URL), the raw source date label, text status, same-host attachments,
  publication date and its evidence (`url`, `html` or `source_page`), and a
  preview URL when applicable. Such records appear under **PUBLICATIONS**, get
  full-text English overviews, PDF synchronization and HTML/JSON exports. Pages
  without article markers keep the generic parser and appear under **OTHER
  MATERIAL**. A page that carries the Arabic template's markers (`read-area` or
  `post-card-holder`) but is not one of its card lists or permalinks with
  `post-content` (a video page, for example) is read exactly as before: no
  article record, the same file dates and the same followed links.
- **Source language:** each record may carry `source_language`, a lowercase
  BCP-47 primary language subtag of two or three letters (`tr`, `bs`, `sq`,
  `ku`, `id`, `fr`, `de`, `en`, `ar`…), taken from `<html lang>`, then
  `og:locale`, then the `Content-Language` header. It is omitted when unknown.
- **Character sets:** pages that declare a legacy charset (such as Windows-1254
  or ISO-8859-9 for Turkish, or Latin-1) are decoded with it instead of being
  forced to UTF-8, so letters are not replaced by `�`.

**Worker and Atlas**

- **Ingest:** `source_language` is optional. The Worker keeps it only when it is
  2–3 letters after lowercasing and drops anything else; collectors that do not
  send it keep working. It is stored on the feed card, the archive record and
  the detail record. It is not part of the content hash, so a collector that
  starts sending it does not invalidate existing translations. Categories other
  than `news`, `naba`, `videos` and `audios` are accepted and shown as
  `PUBLICATION`.
- **Outlet translations:** an item may also carry `source_translation`. The only
  accepted value is `outlet`, which the collector sends for English records that
  are the outlet's own (possibly automatic) translation of its originals; any
  other value is dropped. It is stored on the feed card, the archive record and
  the detail record, and is not part of the content hash, so adding it never
  requeues a translation. An unchanged re-send without it (an older collector)
  keeps it; a pass that changes the text without it removes it.
- **Translation:** the model instruction is language-neutral. Each title is
  translated faithfully from whatever language it is in; the record's
  `source_language`, when known, is sent with it as a hint. A record declared
  English (`en`) whose title contains no letters from another script keeps its
  title as the English title (`title_en_kind` `original`) when it is ingested:
  no model call and no daily request is spent on that title. A structured English
  record still receives its English overview in the normal enrichment batch, so
  it uses a request only while that overview is pending. If a later pass declares
  another language, the record returns to the translation queue with its attempt
  counter reset, so attempts already spent on the overview do not keep the title
  from being translated.
- **Keyword alerts:** keywords and text are both folded before comparison
  (compatibility decomposition, diacritics removed, Turkish `İ`/`ı` read as `i`,
  lowercase, single spaces), and matched against the title, the excerpt and, for
  structured records, the original text. `saldiri` therefore matches `saldırı`,
  `istanbul` matches `İSTANBUL`, and `declaration` matches `Déclaration`. The
  same folding applies to Arabic: harakat and hamza seats are ignored. The
  workspace search box uses the same folding.
- **Display:** cards show a small language chip (`TR`, `BS`, `EN`…) when
  `source_language` is known. The source title and source text carry `lang` set
  to the declared language, or `ar` only when the text is in Arabic script, and
  otherwise no `lang`; direction stays automatic. The disclosure reads **READ
  ORIGINAL TEXT**. An English original is shown once, without a machine-translation
  label. Exports head the source text "Original source text", followed by the
  language name when it is known.
- **Outlet translations on screen and in exports:** an English record flagged
  `source_translation` `outlet` is never presented as an English original. Its
  card shows an **OUTLET TRANSLATION** chip and the note "English version
  published by the outlet (its own, possibly automatic, translation; not verified
  by CT Atlas)", and its disclosure reads **READ OUTLET'S ENGLISH TEXT**. The HTML
  export heads the title section "English title · outlet translation" with that
  note, heads the text "Source text · English · outlet translation, not the
  original" and repeats the note under Provenance; the JSON export keeps
  `source_translation` and adds `source_translation_note`. Records without the
  flag are shown and exported as before.

## News-portal outlet (second outlet)

The second outlet is a multilingual news portal (Arabic, English, Russian and
French versions chosen in its own language menu). Its saved home and article
pages were supplied and checked locally; no onion address or source text is
stored in this repository, and tests use neutral synthetic markup.

- **News only.** On the home page the collector reads the two news sections
  (news cards and the priority list with the weekly newspaper and agency items)
  and follows only the next page of each section: the page's own number in
  `?news_page=N` or `?priority_news_page=N` (1 when absent) plus one, when the
  section's pager links to it. Other numbered pages and the last (oldest) page
  are never requested, and nor are videos, audio, magazines, supporter posts,
  comments, profiles, login and other menus.
- **Template recognition.** A page belongs to this template when it has the
  outlet's language menu (`.language-option` elements with `data-lang`) together
  with the auto-translate switch (`autoTranslateCheckbox`), an article
  (`article.blog-post`) or one of the two news sections. Such a page never falls
  back to the generic reader: an article without its body block becomes a
  title-only record (with its files), and an article without a heading or any
  other page of the site (empty news sections, a "not found" page, a profile or
  video page) gives no record and no link. News cards may link any
  single-segment `/posts/<slug>` permalink, percent-encoded slugs included.
  Pages of the site queued by an earlier collector version are read once more in
  the current run and give nothing.
- **English version.** When a page of this template is served in another
  language, the collector opens the outlet's own English menu link once
  (`/language/change?locale=en&auto_translate=true&force_translate=false`, a
  plain same-host GET, no form or login) and rereads the page; the session cookie
  keeps English for the following pages. It retries at most once every ten
  minutes. If the switch fails (an HTTP error, a redirect off the outlet's host
  or a timeout), the page already read is kept in the language it was served
  in, one warning without addresses is logged, and the page is not counted as
  failed. The English text is the outlet's own, possibly automatic, translation
  of its Arabic originals: records read in English (cards and articles) carry
  `source_language` `en` and `source_translation` `outlet`, so their titles need
  no model translation (English overviews are still generated) and Atlas labels
  them as the outlet's translation. A record read in another language carries no
  `source_translation`, and a later reading in that language drops it.
- **Dates and categories.** Card dates ("06 October 2026") and the article
  header date next to the calendar icon are used; otherwise the day-month-year
  date in the permalink when it has that form (`/posts/<category>-06-10-2026`);
  a permalink without it stays undated. Weekly newspaper issues (`an-naba`
  permalinks) are typed `naba`/PDF, everything else `news`. The article body
  keeps its line breaks as paragraphs; related posts, comments and the
  cover-image download link are excluded; same-host files referenced through
  `media.php?file=` are attached to the article. The page's PDF viewer names its
  file only in an inline script (`const pdfUrl = "…"`); when the article has no
  other PDF, that same-host file is attached as the issue's PDF (and previewed
  from its first page). An empty `pdfUrl` attaches nothing.
- **Period.** Cards older than the collection period's **From** date are neither
  stored nor opened, and a section stops paging at the first page that is
  entirely older, so the initial backfill reads about one listing page per four
  news items plus one page per article.
- **Continuous feed.** Start `start-collector.cmd` (below) and leave it open.
  Each pass checks the first news pages; new items are added and nothing is
  deleted. While Tor Browser is closed, passes fail without using up page
  attempts and resume on their own when Tor is connected again.

### Leaving the collector running

`darkweb-collector/start-collector.cmd` runs the collector for all enabled
outlets through Tor Browser (port 9150), checks every five minutes and restarts
it if it stops. Download it next to `collector.py` and double-click it:

```cmd
curl.exe -fL "https://raw.githubusercontent.com/pro-map/CT-Atlas/main/darkweb-collector/start-collector.cmd" -o start-collector.cmd
```

Each time it starts the collector it asks for the collector secret if
`DARKWEB_INGEST_TOKEN` is not set. When the collector stops with a
configuration error (exit code 2, for example an empty or too short secret), the
launcher forgets the secret it was given and asks for it again at the next
restart, 60 seconds later. A secret of the right length that the Worker rejects
does not stop the collector: it logs "credentials rejected" at each pass, so
close the window and start the launcher again with the correct secret. To
start it at Windows sign-in, place a shortcut to it in the folder opened by
`shell:startup`.

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
requests. After backfill, the default watch interval is 15 minutes, and every
watch pass fetches the start page first (ahead of older queued pages), so a new
publication linked from it is found within one interval. Tor and the collector
window must remain open; Ctrl+C stops the process cleanly.

### Source connection failures

Tor source requests allow 90 seconds to establish a connection, including the
SOCKS handshake, and a 90-second read timeout. The previous 30-second connection
budget could expire while establishing a slow onion connection. Set
`--connect-timeout 120` if needed (10–300 seconds). The read timeout measures
network inactivity, not the total page download duration. API timeouts are unchanged.

Page failures report a timeout, connection category, HTTP status, known collection
limit or exception type, without emitting source URLs, response text or credentials.
A failed page is retried once per pass, for at most three passes. Timeouts,
connection errors and HTTP 5xx count against a page only when the outlet answered
in the same pass, so a Tor or onion-service outage uses up no attempt. When nothing
selectable is left (a page that failed three times, a 'limited' page, the backfill
page cap or the frontier cap), the run finishes, the leftovers are reported as
abandoned, and the next run starts again from the start page: one dead link can
no longer stop an outlet from finding new publications. Links longer than 2,000
characters once percent-encoded are dropped, and a queued row Atlas would refuse
moves to the local `rejected` table instead of blocking the outlet's outbox.
A successful curl response through the same proxy establishes reachability at that
time, not the cause of a previous Python failure. No reset or new collector key is
needed to retry with this update.

## Original text, English, files and exports

Original source text (Arabic for the structured Arabic outlet, any language for
other outlets) is stored separately from AI fields. The adapter preserves
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
The legacy `--acquire` option keeps its generic-media behavior for documents,
video and audio, but never fetches generic image links.

**PDF access in Atlas:** acquired structured PDF attachments up to **50 MiB**
are uploaded over authenticated HTTPS to private R2 storage. The collector
checks the local signature, size and SHA-256; the Worker binds the request to a
current registered attachment, streams bounded bytes and lets R2 verify SHA-256.
Uploads use the existing ingest credential. Reads require an allowed Atlas
session, never the ingest credential, a public R2 URL or a token in the URL.
**OPEN PDF** and **DOWNLOAD PDF** appear only after the server acknowledges storage.
The browser fetches the authenticated PDF into a temporary blob; it needs neither
Tor nor the collector to read an uploaded PDF. Downloads retain readable
original-language filenames. **COPY FILE URL** still copies the source onion
link and requires Tor.

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
independently, with the original-language text (headed with its language when
known), separately labelled English overview, date, source, collection time and
attachment metadata. It contains no scripts, remote
images or embedded credentials. Exports do not embed the original PDF. JSON
preserves the publication fields for further analytical work.

**English:** a background Gemini model (`DARKWEB_GEMINI_MODEL`, default
`gemini-3.1-flash-lite`; never the interactive `GEMINI_MODEL` used by reports and
Deep Search) faithfully translates the entire original title into English,
whatever its language (Arabic for the structured Arabic outlet). It is
instructed to preserve names, dates, numbers and attributed claims rather than
invent or summarize a headline. The original title remains visible beside the
labelled machine translation; a title already in English is kept as it is (see
"Latin-script and multilingual outlets"). Existing
generated English titles are progressively requeued without resetting records.
A separate one/two-sentence overview is based only on supplied page text. Up to
8,000 characters of original text are sent per item; a flag tells the model when
that input is excerpted. Onion links are removed. It does not read PDFs, listen
to audio or view videos. Model output must attribute claims to the source.

AI enrichment runs when an admin first opens the tab and when **UPDATE
TRANSLATIONS & OVERVIEWS** is pressed; the 60-second background refresh, REFRESH
FEED and other actions never call it. Each request covers up to 10 records (with
a 6,000-character combined title budget), at most once per minute globally and at
most `DARKWEB_ENRICH_DAILY` requests (default 40) per Pacific day, counted in the
ReportGate. After a failed request, or one that saves no title and no valid
briefing, the next attempt waits 15 minutes, doubling up to 6 hours; a useful
result resets the wait. A record still unfinished after three attempts stays
stored and queued but is skipped until its source changes. An unusable briefing
for the same sources is not requested again for 6 hours. Grouped citations such
as `[1, 2]` are accepted. A pending queue also covers older archived
publications. It is not an unattended AI scheduler. Failures preserve the
original text and show pending status. Source changes invalidate the English fields;
content fingerprints prevent an old in-flight response from replacing newer
material. Semantic accuracy still needs analyst review.

The archive-review workflow (`review-archive-backlog.yml`) shares the 3.1 Flash
Lite pool; its backlog is done, so it now uses at most 40 requests a day.

The top briefing uses up to 20 latest publication titles/excerpts/dates, including
archived records, with source links. A source link opens the cited card: it
switches view, clears filters that hide the card, or loads an archived record that
is not on a loaded page. It describes publications and source claims, not
verified events or the current situation independently of publication dates.

## Archive and collection controls

**PUBLICATIONS** is the structured archive, loaded 50 records at a time in reverse
publication-date order. **LOAD OLDER PUBLICATIONS** advances its cursor. Filters
apply to loaded records, as stated beside the list. Original text is fetched when
opening a card or exporting, keeping list responses small.

Structured records are retained independently of the 500-item legacy/hot feed.
When that feed is full, publication cards (whose archive record remains) leave
it before generic records, which have no other copy. **OTHER MATERIAL** retains
access to earlier generic collection results. This upgrade does not
automatically delete those results, source registrations or local evidence. The
archive requires storage proportional to the collected records; it is not an
unlimited-storage guarantee.

The background refresh (every 60 seconds while the tab is visible) leaves
unchanged cards in place, so an opened **READ ORIGINAL TEXT** panel, its
loaded text, keyboard focus and an open outlet selector are kept. **KEYWORD
ALERTS** lists unreviewed items that match an outlet's alert keywords. **MARK ALL
AS REVIEWED** asks for confirmation and states its scope: every unreviewed item
across all outlets, views and filters, for the current analyst only.

Items received from the collector are stored even when its pass failed; the
failure only sets the outlet status and prevents a baseline. Items refused
because their date is outside the period or invalid are counted on the outlet.

Admin controls:

- **From / Through:** collection remains restricted to the selected publication
  period. Traversal can follow all list pages, but out-of-period records are not
  retained or downloaded. Future dates are excluded. **SAVE (KEEPS ARCHIVE)** can
  widen the period (an earlier From and/or a later Through) without deleting
  anything; the collection epoch is unchanged. When newly covered dates are in
  the past, every outlet returns to backfill and re-crawls from its start page.
  A crawl already under way when the period changed is not counted: the outlet
  returns to watch only after a complete crawl that began afterwards. Until then
  newly found publications are stored as baseline, without alerts; records that
  already carry an alert keep it. Narrowing the period requires RESET. The
  controls warn when Through is within 30 days or has passed; publications dated
  after Through are not stored. Unsaved edits are kept during background
  refreshes until saved or discarded with **DISCARD EDITS**.
- **Pages per pass:** 1–50, default 10; the CLI limit is an additional ceiling.
- **Pause / Resume:** read before each pass. A request already in flight can
  finish; ingest is refused while paused. It keeps the stored period and limits.
- **Previews:** optional, up to two attempts/pass and 8 MiB/source, JPEG thumbnails
  up to 240×240 pixels, for structured publication records only: the first page of
  their PDF, or the cover image the structured parser identified. Generic and forum
  pages, generic image items and arbitrary page images are never fetched for a
  preview (a safety rule in the code, whatever this setting says), and video frames
  are no longer extracted. Timeouts, connection errors and HTTP 5xx are retried for
  up to three passes, then shown as "Preview source unreachable after 3 attempts".
  Cards display compact 72×82px visuals (56×66px on mobile); a neutral file-type
  icon appears otherwise.
- **RESET: DELETE ARCHIVE & COLLECT THIS PERIOD:** explicitly deletes both the
  online feed and structured archive (with English translations, overviews and
  the briefing), and resets collector metadata next pass. Its confirmation names
  the exact period to collect. Original local evidence and outlet registrations
  are preserved. Only narrowing the period requires this action; widening does
  not. Do not delete the local SQLite database manually to restart.

Backfill is capped at 10,000 pages/outlet and a 50,000-entry local frontier;
reaching the cap ends the backfill (the leftovers are reported as abandoned).
Afterward watch follows the start page and links two levels deep, up to 200 pages
per round; deeper newly added publications may need another backfill. Failed
pages are retried and displayed. Limits/failures never imply complete coverage.
No number of pages is hardcoded from the saved homepage's 221-page snapshot.

Full dates are read from explicit publication metadata, per-card Arabic day,
month and year labels (including Arabic-Indic digits) or the Latin-script date
labels described in "Latin-script and multilingual outlets". Crawl time and HTTP
Last-Modified are never substituted for publication dates. Undated candidates
stay in the bounded local SQLite review queue (500 latest), with an admin count.
Keywords annotate matches in the title, the excerpt and, for structured records,
the original text, compared after diacritic folding; they do not determine
eligibility.

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

Multilingual handling is tested with synthetic Turkish, Bosnian, French and
English records: `source_language` validation and storage, unchanged Arabic
content hashes and translations, English originals that never reach the model,
folded keyword alerts (including original text), and the page's language chip,
`lang` attributes, neutral labels and exports. No Latin-script outlet page was
available, so markup recognition for a new outlet still needs a first bounded
collection pass and a review of PUBLICATIONS and OTHER MATERIAL.

Private PDF storage is tested with an emulated R2 bucket, including content-hash
validation, fragmented/truncated uploads, authenticated downloads, concurrent
quota reservations and recovery after a lost acknowledgement. Chromium checks
cover the download bytes and Arabic filename, the open action, compact previews,
placeholder icons, storage-limit editing and mobile layout using mocked API
responses. Provisioning the actual R2 bucket and the first live upload remain
deployment checks. The headless test does not validate native PDF viewer rendering.
