// Bindings, vars and secrets available to the Worker. Every secret is OPTIONAL at runtime:
// features whose secret is missing must report themselves as unavailable (capability-gated),
// never crash and never pretend to work. See /api/v1/config `capabilities`.
export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;

  // vars (wrangler.jsonc)
  APP_ENV: string; // "production" | "development"
  AUTH_DEV_CODES?: string; // "on" => if no email provider, OTP codes are returned to the client (UAT only)
  SEC_USER_AGENT?: string; // SEC EDGAR fair-access User-Agent
  SITE_URL?: string;

  // secrets (set by the owner with scripts/set-secrets.sh — never committed)
  ADMIN_PASSWORD?: string; // admin portal login; absent => admin login disabled
  SESSION_PEPPER?: string; // extra HMAC key for token/OTP hashing (optional hardening)
  UAT_PASSWORD?: string; // optional Basic-auth gate for /app, /extension, /downloads
  INGEST_TOKEN?: string; // bearer token for runner -> /api/internal/ingest
  RESEND_API_KEY?: string; // email delivery
  EMAIL_FROM?: string; // e.g. "Tudumm <hello@tudumm.in>"
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
  RAZORPAY_WEBHOOK_SECRET?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
}
