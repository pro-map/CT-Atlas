#!/usr/bin/env bash
# Rebuilds and redeploys the ct-atlas-mirror Cloudflare Worker (a static
# mirror of the site on a domain independent of ct-atlas.com/github.io, for
# networks that block the main domain). Run this after any push that changes
# the tracked static frontend files; the mirror workflow also invokes this script.
#
# Usage: CLOUDFLARE_API_TOKEN=... tools/deploy_mirror.sh
set -euo pipefail
if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != "--prepare-only" ]; }; then
  echo "Usage: tools/deploy_mirror.sh [--prepare-only]" >&2
  exit 2
fi
# A lower asset cap (tools/compact_mirror_json.py) is for rehearsing the chunked path
# with small files, never for files that will be uploaded.
if [ -n "${CT_ATLAS_MIRROR_REHEARSAL_CAP+set}" ] && [ "${1:-}" != "--prepare-only" ]; then
  echo "CT_ATLAS_MIRROR_REHEARSAL_CAP is only for --prepare-only rehearsals" >&2
  exit 2
fi
cd "$(dirname "$0")/.."

STAGING=_pages_mirror
rm -rf "$STAGING"
mkdir -p "$STAGING"

cp index.html main.html crypto.html privacy.html robots.txt ct-atlas-runtime.json \
   pdf-export.js deep-search.js deep-search.css report-illustration.js feedback.js feedback.css \
   crypto.js crypto-report.js crypto.css crypto-launcher.js \
   intelligence-map.svg crypto-intelligence.svg \
   daily-quiz.js daily-quiz.css daily-quiz.json \
   usage-admin.js usage-admin.css usage-auth-fix.js \
   workspace-ui.js workspace-ui.css sound-effects.js sound-check.html \
   tab-health.js tab-health.css tab-access.js \
   "$STAGING"/

# The map's own copies of Leaflet and its plugins: the mirror exists for networks
# that block things, so it must not depend on a third-party script host.
cp -R vendor "$STAGING/vendor"

# Preserve the complete fallback, using byte chunks when compaction alone cannot
# meet the 25 MiB asset cap. The Worker streams it at the same /events.json URL
# (and the derived files below at theirs).
python3 tools/compact_mirror_json.py --input events.json --output "$STAGING/events.json" --allow-chunks
cp tools/mirror-worker.mjs "$STAGING/mirror-worker.mjs"

# Lightweight map data, derived from the same source events.json (so it can never be
# older than it). Both grow with the database, so they are staged like events.json:
# byte chunks at the same URL once a file outgrows the 25 MiB asset cap. The
# publication manifest below requires all three files, so a failed build stops here.
DERIVED="$(mktemp -d)"
trap 'rm -rf "$DERIVED"' EXIT
python3 tools/build_events_lite.py --input events.json --output "$DERIVED/events-lite.json"
python3 tools/compact_mirror_json.py --input "$DERIVED/events-lite.json" --output "$STAGING/events-lite.json" --allow-chunks
python3 tools/build_events_map.py --input events.json --output "$DERIVED/events-map.json"
python3 tools/compact_mirror_json.py --input "$DERIVED/events-map.json" --output "$STAGING/events-map.json" --allow-chunks

python3 tools/daily_publication_audit.py manifest --directory "$STAGING" --output "$STAGING/publication-manifest.json"

# The pages request the logo as "CT-ATLAS.png" (exact case), the file the logo
# workflow versions. GitHub Pages serves it regardless of case, but Cloudflare
# Workers assets are an exact-match lookup, so stage that exact name (the
# tracked lowercase ct-atlas.png duplicate is not what the pages use).
cp CT-ATLAS.png "$STAGING/CT-ATLAS.png"
cp CT-ATLAS-256.png "$STAGING/CT-ATLAS-256.png"

for required in tab-health.js tab-health.css \
    vendor/leaflet-1.9.4/leaflet.js vendor/leaflet.markercluster-1.5.3/leaflet.markercluster.js \
    vendor/leaflet.heat-0.2.0/leaflet-heat.js; do
  if [ ! -s "$STAGING/$required" ]; then
    echo "Mirror is missing required asset: $required" >&2
    exit 1
  fi
done

cat > "$STAGING/wrangler.toml" <<'EOF'
name = "ct-atlas-mirror"
main = "mirror-worker.mjs"
compatibility_date = "2026-09-11"

[assets]
directory = "."
binding = "ASSETS"
run_worker_first = ["/events.json", "/events-lite.json", "/events-map.json"]
EOF

cat > "$STAGING/.assetsignore" <<'EOF'
.wrangler
wrangler.toml
.assetsignore
mirror-worker.mjs
EOF

# Fail before upload if any future asset exceeds the platform file-size limit.
python3 tools/compact_mirror_json.py --check-directory "$STAGING"

if [ "${1:-}" = "--prepare-only" ]; then
  exit 0
fi
(cd "$STAGING" && python3 ../tools/wrangler_retry.py deploy)
