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

cp index.html privacy.html robots.txt ct-atlas.png interpol-logo.png events.json \
   deep-search.js deep-search.css quick-ask.js quick-ask.css feedback.js feedback.css \
   usage-admin.js usage-admin.css usage-auth-fix.js \
   "$STAGING"/

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
