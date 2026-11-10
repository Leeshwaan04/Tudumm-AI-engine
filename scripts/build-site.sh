#!/usr/bin/env bash
# Builds everything the Cloudflare Worker serves into deploy/.stage/public.
# Runs locally (macOS) and in Cloudflare Workers Builds (Linux): `wrangler deploy` calls it
# via the "build" section of wrangler.jsonc.
#
#   SITE_URL  public origin the hosted extension preview / zip opens for "Open terminal"
#             (default https://tudumm-ai-engine.sumitbagewadi6.workers.dev; set it to
#             https://tudumm.in once the custom domain is attached).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE_URL="${SITE_URL:-https://tudumm-ai-engine.sumitbagewadi6.workers.dev}"
case "$SITE_URL" in https://*) ;; *) echo "SITE_URL must start with https://" >&2; exit 1 ;; esac

echo "▸ ledger + seed"
node "$ROOT/scripts/verify-ledger.mjs"
bash "$ROOT/scripts/sync-seed.sh"

echo "▸ web build"
cd "$ROOT/web"
if [[ ! -d node_modules ]]; then npm ci --no-audit --no-fund; fi
npm run build
cd "$ROOT"

STAGE="$ROOT/deploy/.stage"
PUB="$STAGE/public"
rm -rf "$STAGE"
mkdir -p "$PUB/extension" "$PUB/downloads" "$STAGE/ext-build"
cp -R "$ROOT/web/dist/." "$PUB/"

echo "▸ extension (terminal URL -> $SITE_URL)"
cp -R "$ROOT/extension/." "$STAGE/ext-build/"
rm -rf "$STAGE/ext-build/tests"
find "$STAGE/ext-build" -name '.DS_Store' -delete
# Point the staged copy (never the source) at the hosted terminal.
export SITE_URL
perl -pi -e 's#webUrl: "http://localhost:5180"#webUrl: "$ENV{SITE_URL}"#g' \
  "$STAGE/ext-build/lib/engine.js" "$STAGE/ext-build/content.js"
grep -q "$SITE_URL" "$STAGE/ext-build/lib/engine.js" || { echo "failed to set extension webUrl" >&2; exit 1; }
cp -R "$STAGE/ext-build/." "$PUB/extension/"

VER="$(node -p "require('$ROOT/extension/manifest.json').version")"
ZIP="$PUB/downloads/tudumm-extension-$VER.zip"
if command -v zip >/dev/null 2>&1; then
  (cd "$STAGE/ext-build" && zip -qr "$ZIP" .)
else
  python3 - "$STAGE/ext-build" "$ZIP" <<'PY'
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for base, _, files in os.walk(src):
        for f in files:
            p = os.path.join(base, f)
            z.write(p, os.path.relpath(p, src))
PY
fi
echo "✓ staged $(find "$PUB" -type f | wc -l | tr -d ' ') files -> $PUB"
