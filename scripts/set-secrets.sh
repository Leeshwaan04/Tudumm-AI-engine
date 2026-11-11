#!/usr/bin/env bash
# Tudumm: set the production Worker's secrets (run once by the OWNER, interactively).
#
#   scripts/set-secrets.sh            # talks to Cloudflare via `npx wrangler secret put`
#   scripts/set-secrets.sh --dry-run  # walk through the prompts without touching Cloudflare
#
# * Generates ADMIN_PASSWORD (24 chars), SESSION_PEPPER (64 hex) and INGEST_TOKEN (64 hex).
#   Secrets that already exist are kept unless you choose to rotate them.
# * Saves the admin password and the ingest token to ~/.config/tudumm/ (chmod 600).
# * Optionally asks for provider keys (press Enter to skip any of them).
# * Values are piped to wrangler over stdin. Nothing secret is echoed, logged or put in argv.
set -euo pipefail
umask 077

WORKER="tudumm-ai-engine"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF_DIR="${HOME}/.config/tudumm"
DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

cd "$ROOT"
if [[ $DRY -eq 0 ]] && ! { : </dev/tty; } 2>/dev/null; then
  echo "Run this in an interactive terminal (it prompts on /dev/tty)." >&2
  exit 1
fi
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }

gen_hex() { node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))'; }
gen_password() {
  node -e 'const c=require("crypto");const a="ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";let s="";while(s.length<24){const b=c.randomBytes(1)[0];if(b<a.length*4)s+=a[b%a.length];}process.stdout.write(s)'
}

# Names of secrets already on the Worker (names only; values can never be read back).
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

SET_NOW=()
put_secret() { # name, value (value via stdin to wrangler; never printed)
  local name="$1" value="$2"
  if [[ $DRY -eq 1 ]]; then
    info "[dry-run] would set $name (${#value} chars)"
  else
    printf '%s' "$value" | npx wrangler secret put "$name" --name "$WORKER" >/dev/null
    info "set $name"
  fi
  SET_NOW+=("$name")
  EXISTING="$EXISTING $name"
}

ask_yes() { # prompt -> 0 for yes
  local ans
  read -r -p "  $1 [y/N] " ans </dev/tty || ans=""
  [[ "$ans" == "y" || "$ans" == "Y" ]]
}

save_file() { # name, value -> ~/.config/tudumm/<name> (600)
  if [[ $DRY -eq 1 ]]; then
    info "[dry-run] would save $CONF_DIR/$1 (chmod 600)"
    return
  fi
  mkdir -p "$CONF_DIR"
  chmod 700 "$CONF_DIR"
  printf '%s\n' "$2" >"$CONF_DIR/$1"
  chmod 600 "$CONF_DIR/$1"
  info "saved to $CONF_DIR/$1 (chmod 600)"
}

bold "Tudumm secrets for Worker '$WORKER'$([[ $DRY -eq 1 ]] && echo ' (dry run)')"
[[ -n "$EXISTING" ]] && info "already set: $EXISTING"
echo

# ---------------- generated secrets ----------------
bold "1/3 Generated secrets"
for NAME in ADMIN_PASSWORD SESSION_PEPPER INGEST_TOKEN; do
  if has_secret "$NAME"; then
    case "$NAME" in
      SESSION_PEPPER) warn="rotating it signs every user and admin out once" ;;
      ADMIN_PASSWORD) warn="the old admin password stops working" ;;
      INGEST_TOKEN) warn="update the runner / GitHub secret afterwards" ;;
    esac
    if ! ask_yes "$NAME is already set — rotate it? ($warn)"; then
      info "kept existing $NAME"
      continue
    fi
  fi
  if [[ "$NAME" == "ADMIN_PASSWORD" ]]; then VAL="$(gen_password)"; else VAL="$(gen_hex)"; fi
  put_secret "$NAME" "$VAL"
  case "$NAME" in
    ADMIN_PASSWORD) save_file admin-password "$VAL" ;;
    INGEST_TOKEN) save_file ingest-token "$VAL" ;;
  esac
  unset VAL
done
echo

# ---------------- optional provider keys ----------------
bold "2/3 Optional providers (press Enter to skip; input is hidden)"
ask_secret() { # name, description
  local name="$1" desc="$2" val=""
  local note=""
  has_secret "$name" && note=" (already set — Enter keeps it)"
  read -r -s -p "  $name — $desc$note: " val </dev/tty || val=""
  echo
  if [[ -n "$val" ]]; then put_secret "$name" "$val"; fi
  unset val
}
ask_secret RESEND_API_KEY "Resend API key for sign-in codes and alert emails (re_...)"
ask_secret EMAIL_FROM "From address, e.g. Tudumm <hello@tudumm.in> (domain verified in Resend)"
ask_secret TURNSTILE_SECRET "Cloudflare Turnstile secret key (site key lives in wrangler.jsonc vars)"
ask_secret GOOGLE_CLIENT_ID "Google OAuth client id (redirect URI: https://tudumm.in/api/v1/auth/google/callback)"
ask_secret GOOGLE_CLIENT_SECRET "Google OAuth client secret"
ask_secret RAZORPAY_KEY_ID "Razorpay key id (rzp_live_... or rzp_test_...)"
ask_secret RAZORPAY_KEY_SECRET "Razorpay key secret"
ask_secret RAZORPAY_WEBHOOK_SECRET "Razorpay webhook secret (webhook URL: https://tudumm.in/api/v1/billing/webhook/razorpay)"
ask_secret STRIPE_SECRET_KEY "Stripe secret key (sk_...)"
ask_secret STRIPE_WEBHOOK_SECRET "Stripe webhook signing secret (whsec_...; URL: https://tudumm.in/api/v1/billing/webhook/stripe)"

UAT_NOTE=""
read -r -p "  UAT_PASSWORD — Basic-auth gate for /app, /admin, /extension, /downloads: [g]enerate, [t]ype one, Enter to skip: " UATC </dev/tty || UATC=""
if [[ "$UATC" == "g" || "$UATC" == "G" ]]; then
  VAL="$(gen_password)"
  put_secret UAT_PASSWORD "$VAL"
  save_file uat-password "$VAL"
  UAT_NOTE="(share the saved password with invited testers; username can be anything)"
  unset VAL
elif [[ "$UATC" == "t" || "$UATC" == "T" ]]; then
  read -r -s -p "  UAT_PASSWORD: " VAL </dev/tty || VAL=""
  echo
  [[ -n "$VAL" ]] && put_secret UAT_PASSWORD "$VAL"
  unset VAL
fi
echo

# ---------------- summary ----------------
bold "3/3 Capabilities (after the next request; no redeploy needed for secrets)"
on() { has_secret "$1"; }
cap() { printf '  %-18s %s\n' "$1" "$2"; }
cap adminConfigured "$(on ADMIN_PASSWORD && echo ON || echo off)"
cap emailDelivery "$({ on RESEND_API_KEY && on EMAIL_FROM; } && echo 'ON  (dev codes switch off automatically)' || echo 'off (UAT dev codes while AUTH_DEV_CODES=on)')"
cap turnstile "$(on TURNSTILE_SECRET && echo 'ON  (if TURNSTILE_SITE_KEY var is set)' || echo off)"
cap googleSignIn "$({ on GOOGLE_CLIENT_ID && on GOOGLE_CLIENT_SECRET; } && echo ON || echo off)"
cap payments "$({ { on RAZORPAY_KEY_ID && on RAZORPAY_KEY_SECRET && on RAZORPAY_WEBHOOK_SECRET; } || { on STRIPE_SECRET_KEY && on STRIPE_WEBHOOK_SECRET; }; } && echo ON || echo off)"
cap hashingPepper "$(on SESSION_PEPPER && echo ON || echo off)"
cap ingest "$(on INGEST_TOKEN && echo ON || echo off)"
cap uatGate "$(on UAT_PASSWORD && echo "ON $UAT_NOTE" || echo off)"
echo
if [[ ${#SET_NOW[@]} -gt 0 ]]; then info "changed this run: ${SET_NOW[*]}"; else info "nothing changed"; fi
info "Verify: curl -s https://tudumm.in/api/v1/config | jq .capabilities"
info "Before public launch: set AUTH_DEV_CODES to \"off\" in wrangler.jsonc once email delivery works."
