#!/usr/bin/env bash
# Tudumm: set the production Worker's Zerodha Kite secrets (run once by the OWNER, interactively).
#
#   scripts/set-kite-secrets.sh            # talks to Cloudflare via `npx wrangler secret put`
#   scripts/set-kite-secrets.sh --dry-run  # walk through the prompts without touching Cloudflare
#
# * KITE_API_KEY      — asked (not secret: it appears in Kite login URLs).
# * KITE_API_SECRET   — asked with HIDDEN input. Paste it only here, never into chat or screenshots.
# * BROKER_VAULT_KEY  — generated (64 hex). Encrypts the stored Kite access token, so a leaked
#                       KITE_API_SECRET alone can't open it. Not saved anywhere else (if it's ever
#                       rotated, the owner simply reconnects Kite).
# * RELAY_TOKEN       — generated (64 hex), also saved to ~/.config/tudumm/relay-token (chmod 600)
#                       for the static-IP order relay (relay/kite-relay.mjs).
# Existing values are kept unless you choose to replace them. Values go to wrangler over stdin;
# nothing secret is echoed, logged or put in argv.
set -euo pipefail
umask 077

WORKER="tudumm-ai-engine"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF_DIR="${HOME}/.config/tudumm"
DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

cd "$ROOT"
if ! { : </dev/tty; } 2>/dev/null; then
  echo "Run this in an interactive terminal (it prompts on /dev/tty)." >&2
  exit 1
fi
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
gen_hex() { node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))'; }

EXISTING=""
if [[ $DRY -eq 0 ]]; then
  if ! npx wrangler whoami >/dev/null 2>&1; then
    echo "Not logged in to Cloudflare. Run: npx wrangler login" >&2
    exit 1
  fi
  EXISTING="$(npx wrangler secret list --name "$WORKER" 2>/dev/null | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s.slice(s.indexOf("[")));
    process.stdout.write(j.map(x=>x.name).join(" "))}catch{process.stdout.write("")}})' || true)"
fi
has_secret() { [[ " $EXISTING " == *" $1 "* ]]; }

put_secret() { # name, value (value via stdin; never printed)
  if [[ $DRY -eq 1 ]]; then
    info "[dry-run] would set $1 (${#2} chars)"
  else
    printf '%s' "$2" | npx wrangler secret put "$1" --name "$WORKER" >/dev/null
    info "set $1"
  fi
}
ask_yes() {
  local ans
  read -r -p "  $1 [y/N] " ans </dev/tty || ans=""
  [[ "$ans" == "y" || "$ans" == "Y" ]]
}
keep() { # name, consequence -> 0 when the existing value should be kept
  has_secret "$1" && ! ask_yes "$1 is already set — replace it? ($2)"
}

bold "Zerodha Kite secrets for Worker '$WORKER'$([[ $DRY -eq 1 ]] && echo ' (dry run)')"
[[ -n "$EXISTING" ]] && info "already set: $EXISTING"
echo

bold "1/4 KITE_API_KEY (developers.kite.trade -> My apps -> your app -> API key)"
if keep KITE_API_KEY "only if you created a new Kite app"; then
  info "kept existing KITE_API_KEY"
else
  read -r -p "  API key: " KEY </dev/tty
  [[ "$KEY" =~ ^[a-z0-9]{8,40}$ ]] || { echo "  That doesn't look like a Kite API key (lowercase letters/digits)." >&2; exit 1; }
  put_secret KITE_API_KEY "$KEY"
  unset KEY
fi
echo

bold "2/4 KITE_API_SECRET (hidden input). Use a FRESHLY regenerated secret."
if keep KITE_API_SECRET "do this after clicking Re-generate API secret"; then
  info "kept existing KITE_API_SECRET"
else
  read -r -s -p "  API secret (hidden): " SECRET </dev/tty
  echo
  [[ "$SECRET" =~ ^[a-z0-9]{16,64}$ ]] || { echo "  That doesn't look like a Kite API secret (lowercase letters/digits)." >&2; exit 1; }
  put_secret KITE_API_SECRET "$SECRET"
  unset SECRET
fi
echo

bold "3/4 BROKER_VAULT_KEY (generated)"
if keep BROKER_VAULT_KEY "a stored Kite session stops opening; you'd reconnect Kite"; then
  info "kept existing BROKER_VAULT_KEY"
else
  put_secret BROKER_VAULT_KEY "$(gen_hex)"
fi
echo

bold "4/4 RELAY_TOKEN (generated; also saved for the relay machine)"
if keep RELAY_TOKEN "the running relay must be restarted with the new token"; then
  info "kept existing RELAY_TOKEN"
else
  VAL="$(gen_hex)"
  put_secret RELAY_TOKEN "$VAL"
  if [[ $DRY -eq 1 ]]; then
    info "[dry-run] would save $CONF_DIR/relay-token (chmod 600)"
  else
    mkdir -p "$CONF_DIR" && chmod 700 "$CONF_DIR"
    printf '%s\n' "$VAL" >"$CONF_DIR/relay-token" && chmod 600 "$CONF_DIR/relay-token"
    info "saved to $CONF_DIR/relay-token (chmod 600). On the relay machine: RELAY_TOKEN=\$(cat ~/.config/tudumm/relay-token) node relay/kite-relay.mjs"
  fi
  unset VAL
fi
echo
bold "Done. Kite login and orders work once the broker code is deployed (migration 0003 applied)."
