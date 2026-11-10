#!/usr/bin/env bash
# Copies the canonical dataset (shared/seed.json) into the web app and the extension.
# Usage:
#   scripts/sync-seed.sh            # sync both targets
#   scripts/sync-seed.sh web        # web only   -> web/src/data/seed.json
#   scripts/sync-seed.sh extension  # extension  -> extension/data/seed.json
# Regenerate the dataset first with: python3 scripts/gen-seed.py
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/shared/seed.json"
TARGET="${1:-all}"

if [[ ! -f "$SRC" ]]; then
  echo "error: $SRC not found (run: python3 scripts/gen-seed.py)" >&2
  exit 1
fi

copy_to() {
  local dest="$1"
  mkdir -p "$(dirname "$dest")"
  cp "$SRC" "$dest"
  echo "synced -> ${dest#"$ROOT"/}"
}

case "$TARGET" in
  all)       copy_to "$ROOT/web/src/data/seed.json"; copy_to "$ROOT/extension/data/seed.json" ;;
  web)       copy_to "$ROOT/web/src/data/seed.json" ;;
  extension) copy_to "$ROOT/extension/data/seed.json" ;;
  *) echo "usage: $0 [all|web|extension]" >&2; exit 2 ;;
esac

if command -v node >/dev/null 2>&1; then
  node "$ROOT/scripts/verify-ledger.mjs" "$SRC"
fi
