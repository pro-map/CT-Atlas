# Dark Web Intelligence — controlled collection

## Current version and reset

The v4 Worker and collector selection protocol 2 add dated collection, readable
original titles, AI English titles, an AI briefing and bounded visual previews.
Deploy both sides together. Older collectors receive HTTP 409 and cannot refill
the feed with pre-filtered data.

The first authenticated Dark Web request after deployment performs the user's
requested one-time reset of the online feed. It preserves outlet registrations,
keywords, URL deduplication history and local evidence files, clears the briefing,
and starts a new inventory for **2025-01-01 through 2026-12-31**. Future dates are
excluded. This reset has not occurred merely because a PR has been opened.

The new collector observes the collection epoch and clears its metadata inventory,
frontier, upload queue and undated review queue once for that epoch. It does not
delete the local evidence directory. Never delete the SQLite database manually to
restart: use the admin controls, which coordinate both sides.

## Windows update

Stop the running collector with Ctrl+C. Leave Tor Browser connected. In the same
CMD window (retaining the existing DARKWEB_INGEST_TOKEN variable):

```cmd
cd /d "%USERPROFILE%\CT-Atlas-Collector"
curl.exe -fL "https://raw.githubusercontent.com/pro-map/CT-Atlas/main/darkweb-collector/collector.py" -o collector.py
curl.exe -fL "https://raw.githubusercontent.com/pro-map/CT-Atlas/main/darkweb-collector/requirements.txt" -o requirements.txt
py -m pip install -r requirements.txt
py collector.py --proxy socks5h://127.0.0.1:9150 --once
```

If this is a new CMD window, set the existing secret before the last command:

```cmd
set /p "DARKWEB_INGEST_TOKEN=Paste the collector secret and press Enter: "
```

After the first check, run continuously:

```cmd
py collector.py --proxy socks5h://127.0.0.1:9150
```

Do not use `--acquire` for normal metadata collection. That opt-in flag separately
retains new original files locally and is not needed for previews. Tor and CMD
must stay open and the computer awake. No source page needs to be opened manually
in Tor Browser. No scheduled ChatGPT task drives this collection.

## Admin collection controls

- **From / Through:** allowed publication-date range. Changing it requires
  **RESET RESULTS & COLLECT THIS PERIOD**, which deletes the current online feed
  and starts a fresh local metadata inventory on the collector's next pass.
- **Pages per pass:** 1–50 per outlet, default 10. The command-line
  `--pages-per-scan` is an additional ceiling (default 50), not a way to exceed the
  configured admin limit. Normal passes run every 15 minutes.
- **Pause / Resume:** collection policy is read before each pass. A pass already
  running may finish its current source requests; ingest is refused while paused.
  Pause is not an immediate remote process kill.
- **Previews:** enable/disable bounded local thumbnail generation. Existing
  previews remain visible when disabled.

The initial **backfill** traverses internal links, categories and pagination,
resuming its queue between passes. It is capped at 10,000 pages per outlet.
Limits, failed pages and incomplete inventory are shown. Complete backfill sets
an inventory baseline without treating historical entries as newly published.

Once complete, each outlet enters **watch**: start page plus internal links up to
two levels, with at most 200 fetched pages per round. This lowers ongoing load and
checks likely recent listings, but can miss new publications deeper in a site.
A capped watch round restarts from the starting page next time so a large archive
cannot permanently prevent it seeing new starting-page links. Site-specific
adapters would be needed to guarantee better coverage; no exhaustive guarantee is
made for the three actual outlets, whose HTML has not been supplied for validation.

## Selection and dates

Exploration and publication selection are separate. Navigation links are followed
but are not feed items. Candidate types are PDF, video, audio, dated linked images,
substantive text and explicit comment/reply blocks. Body rules use 1,200 characters
for substantive text or 80 characters for identifiable comments. Navigation,
headings, forms, scripts and link-heavy blocks are excluded.

The collector recognizes full ISO calendar dates in publication metadata,
HTML `time` attributes, JSON-LD `datePublished`, and file URLs. Arabic-Indic digits
are normalized. A publication page's explicit date may be associated with its
attachments and is labelled **source_page**; file URL evidence is labelled **url**.
These are evidence of dates, not independent verification. Multiple conflicting
HTML times do not produce a guessed date. Crawl time and HTTP Last-Modified are
never substituted for publication dates.

Unknown dates stay outside the online feed and are retained in a bounded local
`undated` SQLite table (latest 500 candidates). The admin sees its count. This is a
local review queue, not an online review interface. Other date formats, ambiguous
pages, short official statements and unmarked comments may be missed. A date and
file extension do not prove official authorship. Provide representative HTML
examples if an outlet needs a dedicated date/publication parser.

The online feed holds up to 500 discoveries. The local metadata inventory is
separate; the UI is not a complete online archive. Stable-URL content changes are
updated when revisited but do not generate a new-discovery event. Keywords only
annotate title/excerpt matches; they do not set collection eligibility.

## Original and AI English titles

Percent-encoded filenames are decoded for display, underscores become spaces,
and path-only fallback titles use the filename. Source URLs are left unchanged.
Original Arabic text is rendered with automatic text direction and textContent.

English titles are generated by the **existing Gemini configuration** on the
Worker, not by a new ChatGPT connection. Source titles remain visible. Up to 20
pending titles are handled per request, at most one request per minute globally.
Enrichment runs when the authenticated admin opens/refreshes the workspace and
continues with its one-minute refresh while that page remains visible. It is not a
background AI scheduler. Other users read the saved enrichment. Failures leave
explicit pending titles and retain originals. Source-title/excerpt changes
invalidate the old translation. A reset prevents an in-flight old response from
repopulating the new feed.

## AI briefing

The top paragraph uses titles, excerpts and dates of up to 20 latest dated
publications currently retained, with links to numbered feed items. It summarizes
outlet claims rather than certifying events. Backfilled historical material must
not be described as current events. New data invalidates the saved summary hash;
unchanged data reuses the cache.

Only titles, short excerpts, dates and internal source numbers are sent to the
configured model; onion addresses and original media are not sent. Source text is
treated as untrusted data. Output is rendered as text, never model HTML. Unknown
citation numbers are rejected. These checks cannot prove semantic accuracy:
analyst review remains necessary. There is no claim that AI has viewed the media
or read full PDFs. Provider errors do not erase originals or invent substitutes.

## Visual previews and storage limits

Previews are created on the Tor collector, then uploaded as small JPEG thumbnails.
The clearnet browser never requests an onion URL. Authenticated thumbnail requests
are lazy-loaded; base64 image data is omitted from the main feed response.

- Up to **2 preview attempts per outlet per pass**, filling missing previews over
  later passes. At most **8 MiB of source bytes** per attempt; larger sources are
  skipped, not fully downloaded. Original bytes are discarded after rendering.
- Image / outlet poster: Pillow produces a JPEG up to 240×240 pixels and 16,000
  base64 characters. EXIF metadata is not retained in the newly encoded image.
- PDF without supplied thumbnail: PyMuPDF renders the first page within the cap.
- Video: use the supplied poster first. Without one, optional locally installed
  **FFmpeg** can extract one frame from a video small enough to fit the cap. The
  process accepts only pipe protocols and has a 20-second timeout. FFmpeg is not
  installed by requirements.txt. Large videos and non-streamable containers may
  have no preview; this is shown explicitly.
- Audio normally has no picture unless the outlet supplies a suitable image.
- Cross-host previews, invalid media and failed decodes show an unavailable
  status. No generated illustration is passed off as a real screenshot.

Preview attempts are cached in local metadata; after installing a missing preview
renderer, use a new controlled inventory if you need failed items retried. Actual
outlet media and live Gemini responses have not been accessed in synthetic tests.

## Security and operation

The collector uses a local `socks5h` proxy (9150 for Tor Browser, commonly 9050 for a
standalone Tor service), remote DNS and same-onion-host redirect checks. It does
not fall back to a direct source connection, submit forms, bypass logins or follow
another host. API credentials travel only to the configured HTTPS API origin.

The Worker reuses REPORT_GATE storage. Feed/preview access requires an allowed
session; outlet changes, reset/pause and AI generation require admin. Ingest and
collector configuration require the separate DARKWEB_INGEST_TOKEN secret. Each
ingest is checked against the date window, protocol version, current epoch and
pause state. No public reset endpoint is introduced.
