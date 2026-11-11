# Backend core: self-VAPT checklist (2026-11-10)

- **Scope:** `worker/src/api/**`, `worker/src/admin/**`, `worker/src/lib/**` and `migrations/0001_core.sql`.
- **Method:** code review, plus automated tests against `wrangler dev --local` (`worker/test/core.test.mjs`, 48 tests) and hook unit tests (`core.hooks.test.mjs`, 5 tests).
- **Status:** ✅ = verified by an automated test · 🔎 = verified by code review only · ⚠️ = residual risk or owner action.

## OWASP API Security Top 10 (2023)

| # | Risk | Controls | Status |
|---|---|---|---|
| API1 | Broken object-level authorization | Every user query is scoped `WHERE user_id = <session user>`. Rows you don't own return **404** (so their existence isn't revealed). Admin reads are behind the admin session only. | ✅ test "alerts: validation and ownership", "support tickets: owner-only…", "sessions: users can't revoke someone else's…" |
| API2 | Broken authentication | Email OTP: 6 digits from a CSPRNG, stored as an HMAC of `email:code`, **5 attempts**, **10-minute** expiry, single use (atomic claim). Only the newest code is valid. Start is limited to 5 per email per 15 min and 20 per IP per hour; verify to 30 per IP per 15 min. Sessions are 256-bit tokens stored only as hashes, 30 days sliding, revocable. Admin: constant-time password compare, 5 attempts per 15 min per IP, 8-hour session, every attempt audited. | ✅ OTP attempts/expiry/single-use, rate-limit 429, admin rate limit, logout / logout-all |
| API3 | Broken object property-level authorization | Responses are built from explicit mappers (`publicUser`, `mapAlert`…). Writes accept whitelisted fields only (no mass assignment of plan, status or email). Token hashes never leave the DB, and the export excludes them. | ✅ export has no `*_hash`; 🔎 mappers |
| API4 | Unrestricted resource consumption | Body caps (1–64 KB per route), list caps (watchlist and tracked ≤ 200, events ≤ 25 per batch, alerts 50/500 by plan), `LIMIT` on every list query, admin overview window ≤ 90 days. Bulk writes are one `json_each` statement (also avoids D1's 100-parameter cap). Generic write limit: 120/min per user and 300/min per admin session. | ✅ batch cap, list cap, 429s; 🔎 caps |
| API5 | Broken function-level authorization | `/api/admin/*` needs the admin cookie and `ADMIN_PASSWORD` configured (otherwise 503). A user session can't reach admin. Account-level actions (delete, export, approving an extension link) refuse extension Bearer tokens. | ✅ "a user session is not an admin session", 503 without password, Bearer refused on export |
| API6 | Unrestricted access to sensitive business flows | Signup/login: rate limits plus Turnstile (fails **closed**: missing or invalid token → 400, siteverify down → 503). Device-link codes: 31⁸ space, 10-minute life, approve limited to 10 per 15 min per user, token issued exactly once. Anonymous support: email required, 5 per hour per IP, 3 per hour per email, plus Turnstile. Webhooks: HMAC verification, amount and currency checks, idempotent by provider reference. | ✅ Turnstile fail-closed, device flow once-only; 🔎 webhooks (no live keys) |
| API7 | Server-side request forgery | No user-supplied URL is ever fetched. Outbound calls go only to fixed hosts (Resend, Turnstile, Google OAuth, Razorpay, Stripe), each with `AbortSignal.timeout`. | 🔎 |
| API8 | Security misconfiguration | `secure()` adds CSP, HSTS, nosniff, XFO, COOP/CORP and `Cache-Control: no-store` on the API. CORS is **non-credentialed**, limited to the `chrome-extension://[a-p]{32}` pattern on listed routes, and never on admin. Unexpected errors return `500 internal_error` with no stack trace. Cookies are `__Host-`, `Secure; HttpOnly; Path=/`, with SameSite=Lax (user) or Strict (admin). | ✅ headers, cookie flags, CORS preflight |
| API9 | Improper inventory management | Every route is listed in `worker/README.md` (and `routeTable()` in the router). There are no debug or test routes. The dev outbox exists only while dev codes are active, and every view of it is audited. | ✅ dev outbox gated |
| API10 | Unsafe consumption of APIs | Google: PKCE + state cookie, id_token from the token endpoint, checks on `iss`, `aud`, `exp` and `email_verified`. Stripe: 5-minute timestamp tolerance. Provider responses are validated before use. | 🔎 (no live credentials yet) |

## Other checks

| Area | Control | Status |
|---|---|---|
| CSRF | Writes need `content-type: application/json` **and** an allowed `Origin` (own origin or `SITE_URL`). A missing Origin is refused for cookie auth, as is `Sec-Fetch-Site: cross-site`. Login CSRF is blocked the same way. | ✅ |
| SQL injection | Every statement uses `prepare().bind()`. The only dynamic SQL fragments are fixed column whitelists. `LIKE` input is escaped. | ✅ `%` search returns 0 rows; 🔎 |
| XSS (stored) | The API returns JSON only. Announcement links must be `/path` or `https://…` (`javascript:` is rejected). Notification links are relative. **The frontend must render all API text as text.** | ✅ link validation; ⚠️ frontend |
| Enumeration | `auth/start` gives the same answer for existing and unknown emails and doesn't touch `users`. Anonymous support echoes only the ticket id. | ✅ |
| Secrets at rest | `HMAC-SHA256(SESSION_PEPPER, purpose:value)`, or plain SHA-256 until the pepper is set. IPs are hashed. OTP rows hold only an email hash and are pruned after 24 hours. | ✅ DB inspection test |
| Logging and PII | JSON log lines carry a component tag and our own error text only. No emails, tokens, IPs or bodies. Events strip query strings and drop email- or phone-like values and nested props. | ✅ events test; 🔎 logs |
| Audit | Every admin mutation writes an audit row **in the same D1 batch** as the change. Logins (both outcomes), dev-outbox views and self-deletion are audited too. `audit_log` is append-only, enforced by **triggers**. | ✅ 18 actions asserted; UPDATE/DELETE abort |
| DPDP / GDPR | JSON export with a `data_requests` row. Delete anonymises the user, removes personal tables and de-links events and tickets. Consents are versioned and can be withdrawn. Compliance view tracks grievances older than 7 and 21 days. | ✅ export + delete test |
| Honesty and capabilities | `/config` reports every capability from real secrets and flags. Billing, Google and email return 503 or `enabled:false` instead of faking success. Signal notifications carry "engine v0, uncalibrated". | ✅ |

## Residual risks and owner actions

1. ⚠️ **Dev-code mode is a UAT-only weakness.** While `AUTH_DEV_CODES=on` and no email provider is set, anyone can sign in as any email that hasn't been verified. Mitigations: Turnstile, rate limits, dev codes can never open an email-verified account, and these accounts stay `emailVerified:false` and get no email. **Before public launch:** set `RESEND_API_KEY` + `EMAIL_FROM`, then set `AUTH_DEV_CODES` to `"off"`. Dev-mode accounts are UAT accounts; consider purging them at launch.
2. ⚠️ **Admin is one shared password with no MFA.** Put Cloudflare Access (Zero Trust, free for up to 50 users) in front of `/admin*` and `/api/admin/*`. `UAT_PASSWORD` gates `/admin` pages but not `/api/admin`.
3. ⚠️ **Fixed-window limits allow up to twice the limit across a window boundary.** At worst that is 10 OTP guesses per 15 min per email per code chain, about 25 guesses in total across codes, against 10⁶ codes. For volumetric abuse, add a Cloudflare WAF rate-limit rule on `/api/v1/auth/*`.
4. ⚠️ **Extension tokens last 180 days (sliding)** and aren't bound to a device. They can be revoked in `/me/sessions` or by `logout-all`.
5. ⚠️ **`events` grows without bound.** Add a retention job (for example, delete after 180 days) before scale.
6. ⚠️ **Not live-tested:** Google OAuth, Razorpay and Stripe have no credentials yet. Their signature checks are code-reviewed only, so re-test with provider test keys before enabling them.
7. ⚠️ **Hook fan-out is capped** at 1,000 recipients per signal event and 500 price triggers per run, with at most 100 emails per hook call (one Resend batch). Move fan-out to Cloudflare Queues at scale.
8. ⚠️ **Rotating `SESSION_PEPPER` signs everyone out** (all hashes change). That is intended, but don't rotate it casually.
9. ℹ️ **CSP keeps `style-src 'unsafe-inline'`** (owned by the orchestrator in `lib/edge.ts`).
