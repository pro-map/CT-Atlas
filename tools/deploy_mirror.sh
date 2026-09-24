#!/usr/bin/env bash
# Rebuilds and redeploys the ct-atlas-mirror Cloudflare Worker (a static
# mirror of the site on a domain independent of ct-atlas.com/github.io, for
# networks that block the main domain). Run this after any push that changes
# the tracked static frontend files -- the mirror never updates on its own.
#
# Usage: CLOUDFLARE_API_TOKEN=... tools/deploy_mirror.sh
set -euo pipefail
cd "$(dirname "$0")/.."

STAGING=_pages_mirror
rm -rf "$STAGING"
mkdir -p "$STAGING"

cp index.html main.html crypto.html social.html privacy.html robots.txt events.json ct-atlas-runtime.json \
   pdf-export.js deep-search.js deep-search.css quick-ask.js quick-ask.css feedback.js feedback.css \
   crypto.js crypto.css crypto-launcher.js social.js social.css \
   intelligence-map.svg crypto-intelligence.svg social-intelligence.svg \
   daily-quiz.js daily-quiz.css daily-quiz.json \
   usage-admin.js usage-admin.css usage-auth-fix.js \
   "$STAGING"/

# index.html references the logo as "CT-ATLAS.png" (exact case) -- GitHub
# Pages serves it fine regardless of case, but Cloudflare Workers assets are
# an exact-match lookup, so the on-disk lowercase ct-atlas.png must be
# copied under the exact uppercase name the page actually requests.
cp ct-atlas.png "$STAGING/CT-ATLAS.png"

cat > "$STAGING/wrangler.toml" <<'EOF'
name = "ct-atlas-mirror"
compatibility_date = "2026-09-11"

[assets]
directory = "."
EOF

cat > "$STAGING/.assetsignore" <<'EOF'
.wrangler
wrangler.toml
.assetsignore
EOF

(cd "$STAGING" && npx wrangler@latest deploy)
