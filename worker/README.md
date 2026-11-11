# Tudumm Worker: backend core

One Cloudflare Worker (`worker/src/index.ts`) serves the static site, the market API (`/api/v1/market/*`, see `worker/README-market.md`) and the **core API** described here: accounts, sessions, personalisation, alerts and notifications, activity events, support, billing, extension linking and the admin portal. Storage is D1 (`tudumm-db`). No frameworks are used: the router is hand-rolled in `worker/src/api/router.ts`.

```
worker/
├── migrations/0001_core.sql   core schema (this doc)      0002_market.sql  market schema (data+engine agent)
├── src/api/                   public + user API (router, auth, me, alerts, support, events, billing, ext, hooks)
├── src/admin/                 admin API (auth, overview, users, content, support, engine)
├── src/lib/                   http, crypto, session, db, validate, ratelimit, flags, plans, email, turnstile, audit, log
└── test/core.test.mjs         integration suite vs `wrangler dev --local` (+ core.hooks.test.mjs unit tests)
```

## Local dev loop

```bash
npm ci                                              # repo root
npx wrangler d1 migrations apply tudumm-db --local  # fresh local D1 (.wrangler/state)
npx wrangler dev --local --port 8787                # runs scripts/build-site.sh first (builds web/)
npx tsc -p worker/tsconfig.json                     # typecheck
npm run test:core                                   # integration + hooks tests (starts its own workers on :8787/:8788)
```

- **Compatibility date.** The local workerd bundled with wrangler 4.114.0 only supports compat dates up to `2026-07-29`, and `wrangler.jsonc` says `2026-10-01`. If `wrangler dev` refuses to start, run `npx wrangler dev --local --port 8787 --compatibility-date 2026-07-29`. The test harness works this out by itself.
- **Admin locally:** add `--var ADMIN_PASSWORD:test`.
- **Frontend dev from Vite** (another origin): add `--var APP_ENV:development`. This also allows `http://localhost:*` origins.
- **Codes during UAT:** with no email provider and `AUTH_DEV_CODES=on`, `POST /auth/start` returns the code in `devCode`. Admins can also see the last 50 codes at `GET /api/admin/dev-outbox`.

## Conventions for clients

- **Base URL:** same origin (`https://tudumm.in`). All bodies are JSON.
- **Writes:** every `POST`/`PUT`/`PATCH` needs `content-type: application/json`, even when the body is `{}`. Browser calls are same-origin, so the `Origin` header is automatic. A cross-origin `Origin`, or a missing one, gets `403 bad_origin`.
- **Errors:** `{ "error": "<code>", ...extra }`. Validation errors add `field` and `message`: `400 { "error":"invalid_input", "field":"riskPct", "message":"must be between 0.1 and 5" }`.
- **Rate limits:** `429 { "error":"rate_limited", "retryAfter": <s> }`, plus a `Retry-After` header.
- **Auth for the web:** the HttpOnly cookie `__Host-tdm_s` (30 days, sliding). Use `fetch(url, { credentials: "same-origin" })`; that's the default.
- **Auth for the extension:** `Authorization: Bearer <token>` from the device-link flow. CORS is allowed for `chrome-extension://<32 a-p>` origins on routes marked **ext** below. CORS is never credentialed.
- **Status codes:** `401 auth_required`, `401 invalid_token`, `403 account_suspended`, `404 not_found` (also returned for rows you don't own), `409` (limits/state), `503` (capability off).
- **Timestamps:** ISO-8601 UTC strings. Money is in integer minor units.

## Shapes

```ts
// user (every response that includes the account)
User = { id, email, emailVerified: boolean, displayName: string|null, status: "active"|"suspended"|"deleted",
         plan: "free"|"pro"|"elite" /* effective: expired paid => free */, planSource: "default"|"admin_grant"|"billing",
         planExpiresAt: string|null, createdAt, lastSeenAt, country: string|null, marketingOptIn: boolean }

// profile — mirrors web/src/engine/profile.ts (localStorage `tudumm.profile.v1`)
Profile = { persona: "intraday"|"swing"|"options"|"investor",   // input also accepts the web's "scalper" (=> "intraday")
            markets: ("IN"|"US"|"EU"|"CRYPTO"|"FX"|"CMDTY")[],  // non-empty
            capital: number /* >0 */, currency: "INR"|"USD"|"EUR"|"USDT"|"JPY",
            riskPct: number /* 0.1–5 (web allows up to 10: sync clamps, PUT rejects) */,
            onboarded: boolean, updatedAt: string|null }
// profile is null until the user saves one (=> show onboarding)

Watchlist = { symbols: string[] /* insertion order, uppercase */, items: { symbol, addedAt }[] }
// tracked: the web stores SYMBOLS (`tudumm.tracking.v1`); the API keeps symbol-level rows and,
// optionally, a specific live signal id.
Tracked = { symbols: string[] /* unique */, items: { symbol, signalId: string|null, addedAt }[] }

Alert = { id, symbol /* or "*" = any watchlist symbol (signal kinds only) */,
          kind: "price_above"|"price_below"|"new_signal"|"signal_update",
          threshold: number|null /* > 0, price kinds only */, oneShot: boolean /* default true for price */,
          active: boolean, createdAt, lastTriggeredAt: string|null }

Notification = { id, kind: "price_alert"|"new_signal"|"signal_update"|"support_reply"|"system",
                 title, body, link /* relative, e.g. "/app/i/BTCUSDT" */, createdAt, readAt: string|null }

Ticket = { id, userId, email, category: "bug"|"billing"|"signal"|"account"|"grievance"|"other",
           subject, body, status: "open"|"pending"|"resolved"|"closed", createdAt, updatedAt,
           messages: { author: "user"|"admin", body, createdAt }[] }

Consent = { kind: "terms"|"risk_disclosure"|"privacy"|"marketing", version, acceptedAt, withdrawnAt: string|null }
```

## Route table

Legend: **pub** = no auth · **opt** = session if present · **user** = cookie or Bearer · **cookie** = web cookie only · **admin** = admin cookie · **ext** = CORS for chrome-extension origins.

### Public

| Method & path | Auth | Request → Response |
|---|---|---|
| `GET /api/v1/config` | pub, ext | → `{ appEnv, capabilities:{ emailDelivery, devCodes, googleSignIn, turnstile, payments, paymentProviders[], adminConfigured, liveData, extensionLinking, signups }, turnstileSiteKey: string\|null, flags:{ live_data, signups, extension_linking }, announcements:[{id, level:"info"\|"warning"\|"critical", message, link, startsAt, endsAt}], plans:[{id, name, priceUsdCents, priceInrPaise, features[], limits:{alerts}}], legal:{termsVersion, riskVersion, privacyVersion}, engine:{version:"v0", calibrated:false} }`. Cached 30 s. |
| `GET /api/v1/health` | pub, ext | → `{ ok, db:"ok"\|"error", time }` |

### Auth

| Method & path | Auth | Request → Response |
|---|---|---|
| `POST /api/v1/auth/start` | pub | `{ email, turnstileToken? }` (the token is **required** when `capabilities.turnstile`). Email provider configured: `{ sent:true, expiresIn:600 }`. Dev mode: `{ sent:false, devMode:true, devCode:"123456", expiresIn:600, notice }`. Neither: `503 email_unavailable`. Other errors: `400 turnstile_required\|turnstile_failed`, `503 turnstile_unavailable`, `429` (5 per email per 15 min, 20 per IP per hour), `502 email_send_failed`. The answer is the same whether or not the account exists. |
| `POST /api/v1/auth/verify` | pub | `{ email, code }` → `{ user, profile, isNew }`, and sets `__Host-tdm_s`. Errors: `400 invalid_code {attemptsLeft?}`, `400 code_expired`, `403 account_suspended`, `403 signups_closed`, `403 email_verification_required` (a dev code can't open an email-verified account), `429` (30 per IP per 15 min). |
| `POST /api/v1/auth/logout` | opt, ext | `{}` → `{ ok:true }`. Revokes the current session and clears the cookie. |
| `POST /api/v1/auth/logout-all` | user, ext | `{}` → `{ ok:true, revoked:n }` |
| `GET /api/v1/auth/google/start?next=/app/...` | pub | `302` to Google (PKCE + state cookie `__Host-tdm_g`). Returns `503 google_unavailable` unless `GOOGLE_CLIENT_ID/SECRET` are set. |
| `GET /api/v1/auth/google/callback` | pub | `302` to `next` (default `/app`) with the session cookie set, or to `/app?auth_error=<code>`. |

### Me

| Method & path | Auth | Request → Response |
|---|---|---|
| `GET /api/v1/me` | user, ext | → `{ user, profile, consents: Consent[], pendingConsents:[{kind, version}], plan:{id, name, features[], limits:{alerts}, expiresAt, source}, counts:{watchlist, tracked, alerts, unread}, session:{id, kind, expiresAt} }` |
| `PATCH /api/v1/me` | user, ext | `{ displayName?: string\|null (≤60), marketingOptIn?: boolean }` → `{ user }` |
| `DELETE /api/v1/me` | cookie | `{ confirm:"DELETE" }` → `{ ok, deleted:true }`. Soft-deletes: the email becomes `deleted+<id>@invalid`; profile, watchlist, tracked, alerts, notifications and sessions are deleted; events and tickets are kept but de-linked. |
| `GET /api/v1/me/sessions` | user, ext | → `{ items:[{ id, kind:"web"\|"extension", userAgent, createdAt, lastUsedAt, expiresAt, current }] }` |
| `DELETE /api/v1/me/sessions/:id` | user, ext | → `{ ok:true }`. Returns 404 if the session isn't yours. |
| `GET /api/v1/me/export` | cookie | JSON download (`content-disposition: attachment`) of every row the user owns. Logs a `data_requests` row. Limited to 5 per day. |
| `GET /api/v1/profile` | user, ext | → `{ profile: Profile\|null, defaults }` |
| `PUT /api/v1/profile` | user, ext | `Profile` fields (all optional; omitted fields keep their value or the default), or `{ profile:{...} }` → `{ profile }` |
| `GET /api/v1/watchlist` | user, ext | → `Watchlist` |
| `PUT /api/v1/watchlist` | user, ext | `{ symbols: string[] (≤200) }` → `Watchlist` (full replace; order kept) |
| `POST /api/v1/watchlist/:symbol` | user, ext | `{}` → `Watchlist` (409 `limit_reached` at 200) |
| `DELETE /api/v1/watchlist/:symbol` | user, ext | → `Watchlist` |
| `GET /api/v1/tracked` | user, ext | → `Tracked` |
| `PUT /api/v1/tracked` | user, ext | `{ symbols: string[] }` (the web's shape) or `{ items:[{symbol, signalId?}] }` (≤200) → `Tracked` |
| `POST /api/v1/tracked/:symbol` | user, ext | `{ signalId? }` → `Tracked`. Without `signalId`, it tracks the symbol. |
| `DELETE /api/v1/tracked/:symbol[?signalId=]` | user, ext | → `Tracked` |
| `POST /api/v1/sync` | user | `{ profile?, watchlist?: string[], tracked?: string[]\|items }` → `{ profile, watchlist, tracked, merged:{ profile:boolean, watchlistAdded, trackedAdded } }`. Call once right after login with the guest's localStorage. Lists are unioned. The server wins for the profile unless it has none. Input is lenient (bad entries are skipped). |
| `POST /api/v1/consents` | user | `{ kind, version }` → `201 { consents, pendingConsents }` (idempotent) |
| `DELETE /api/v1/consents/:kind` | user | → `{ consents, pendingConsents }` (withdraw) |

### Alerts and notifications

| Method & path | Auth | Request → Response |
|---|---|---|
| `GET /api/v1/alerts` | user, ext | → `{ items: Alert[], limit }` (limit is 50 on free, 500 on pro/elite) |
| `POST /api/v1/alerts` | user, ext | `{ symbol, kind, threshold?, oneShot? }` → `201 { alert }`. Errors: `409 alert_limit_reached`. |
| `GET/PATCH/DELETE /api/v1/alerts/:id` | user, ext | `PATCH { active?, threshold?, oneShot? }` → `{ alert }`. Returns 404 if the alert isn't yours. |
| `GET /api/v1/notifications?unread=1&limit=50&before=<iso>` | user, ext | → `{ items: Notification[], unread, nextBefore }` |
| `POST /api/v1/notifications/read` | user, ext | `{ ids: string[] }` or `{ all:true }` → `{ ok, marked, unread }` |

How alerts fire (`src/api/hooks.ts`, called by the engine cron):

- **Price alerts** fire once when the refreshed price is ≥ or ≤ the threshold. One-shot alerts then deactivate. Repeating alerts re-fire at most once a day.
- **`new_signal`** fires for alerts on the symbol, or on `"*"` when the symbol is on the user's watchlist.
- **Signal updates** (activated, T1, closed, invalidated) go to users tracking the signal or the symbol, and to `signal_update` alerts.
- **Delivery:** notifications are always written in-app. A copy is emailed only when Resend is configured **and** the user's email is verified. Notifications are deduplicated per event, and held signals never notify.

### Support

| Method & path | Auth | Request → Response |
|---|---|---|
| `POST /api/v1/support` | opt | `{ category, subject (3–140), body (10–5000), email? (required when signed out), turnstileToken? (signed out + turnstile on) }` → `201 { ticket:{id, status, category, subject, createdAt} }` |
| `GET /api/v1/support` | user | → `{ items: Ticket[] }` (your tickets with messages) |
| `POST /api/v1/support/:id/reply` | user | `{ body }` → `201 { ok }`. Returns 404 if the ticket isn't yours and `409 ticket_closed` if it's closed. |

### Activity events

| Method & path | Auth | Request → Response |
|---|---|---|
| `POST /api/v1/events` | opt, ext | `{ anonId (8–64 [A-Za-z0-9_-]), source?: "web"\|"extension", events:[{ name, props?, path?, ts? }] (≤25) }` → `202 { accepted, dropped, at }` |

- **Allowed names:** page_view, instrument_view, signal_view, track_toggle, watchlist_toggle, alert_create, search, onboarding_step, onboarding_complete, plan_view, upgrade_click, extension_preview, extension_link, verify_chain, tamper_test, signup_start, login, logout, support_submit, sizer_use, filter_change. Unknown names are dropped and counted in `dropped`.
- **props:** flat values only (string ≤200, number, boolean, null), at most 20 keys and 2 KB. Values that look like an email or phone number are dropped.
- **path:** the query string and fragment are stripped.
- **No IP is stored.** Only country and device class are kept.
- **Limit:** 60 batches per minute per IP.
- **Admin overview:** send `instrument_view` with `props.symbol` so it can rank instruments.

### Billing (capability-gated)

| Method & path | Auth | Request → Response |
|---|---|---|
| `GET /api/v1/billing` | opt | Without keys: `{ enabled:false, reason, providers:[], current }`. With keys: `{ enabled:true, providers, razorpayKeyId, plans, current }`. |
| `POST /api/v1/billing/checkout` | user | `{ plan:"pro"\|"elite", provider:"razorpay"\|"stripe" }`. Razorpay → `{ provider, orderId, amount, currency, keyId, plan, notes }`. Stripe → `{ provider, sessionId, url }`. Without that provider's keys: `503 billing_unavailable`. |
| `POST /api/v1/billing/webhook/razorpay` | signature | `X-Razorpay-Signature` = HMAC-SHA256(webhook secret, raw body). Handles `order.paid` and `payment.captured`. Returns 503 without keys. |
| `POST /api/v1/billing/webhook/stripe` | signature | `Stripe-Signature` (`t`, `v1`, 5-minute tolerance). Handles `checkout.session.completed`. Returns 503 without keys. |

The plan changes only when the webhook lands: it sets `plan`, `plan_source=billing` and `plan_expires_at` = now (or the current expiry) + 30 days. Payments are recorded idempotently.

### Extension linking (device flow)

| Method & path | Auth | Request → Response |
|---|---|---|
| `POST /api/v1/ext/link/start` | pub (extension origin), ext | `{}` → `{ userCode:"ABCD-EF23", deviceToken, verifyUrl: SITE_URL + "/app/link?code=ABCD-EF23", expiresIn:600, interval:5 }` |
| `POST /api/v1/ext/link/approve` | cookie | `{ userCode }` (case and dash insensitive) → `{ ok, approved:true }`. Errors: `404 code_not_found`. |
| `POST /api/v1/ext/link/poll` | pub (extension origin), ext | `{ deviceToken }` → `{ status:"pending", interval }`, or (exactly once) `{ status:"approved", token, tokenType:"Bearer", sessionId, expiresAt }`, or `410 { status:"expired"\|"consumed" }`. |

- The token is a `kind=extension` session: Bearer only, valid 180 days (sliding), listed and revocable in `/me/sessions`.
- `DELETE /me`, `/me/export` and `/ext/link/approve` refuse Bearer tokens.

### Admin (`/api/admin/*`)

- **Availability:** every admin route returns `503 { error:"admin_not_configured", hint:"Owner: run scripts/set-secrets.sh" }` while `ADMIN_PASSWORD` is unset.
- **Session:** the `__Host-tdm_a` cookie (SameSite=Strict, 8 hours).
- **CSRF:** mutations need a same-origin `Origin`. GETs reject `Sec-Fetch-Site: cross-site`.
- **Audit:** every mutation writes an audit row in the same batch.

| Method & path | Request → Response |
|---|---|
| `POST /api/admin/login` | `{ password }` → `{ ok, expiresAt }`, or `401 invalid_credentials`, or `429` (5 per IP per 15 min). Every attempt is audited. |
| `POST /api/admin/logout` · `GET /api/admin/me` | → `{ ok }` · `{ ok, actor, sessionId, expiresAt, capabilities }` |
| `GET /api/admin/overview?days=30` | → `{ days, since, kpis:{ totalUsers, newUsers, newUsersPerDay[{day,n}], dau/wau/mau:{users, guests}, onboardingCompletionRate, paidShare, planMix:{free,pro,elite}, activeAlerts, trackedSignals, trackingUsers, extensionLinkedUsers, openTickets }, topInstruments[{symbol, views, viewers}], funnel[{step, actors}], retention[{cohort:"YYYY-MM-DD"(Monday), size, weeks:number[]}] }` (`days` ≤ 90) |
| `GET /api/admin/users?q=&plan=&status=&page=` | → `{ items: User[], total, page, pageSize:25 }` |
| `GET /api/admin/users/:id` | → `{ user, rawPlan, profile, consents, pendingConsents, sessions[], watchlist[], tracked[], alerts[], tickets[], timeline[≤200 events], notes[], payments[] }` |
| `POST /api/admin/users/:id/suspend` | `{ reason }`: suspends and revokes all sessions |
| `POST /api/admin/users/:id/unsuspend` | `{ reason? }` |
| `POST /api/admin/users/:id/plan` | `{ plan, expiresAt?, reason }` |
| `POST /api/admin/users/:id/notes` | `{ body }` |
| `POST /api/admin/users/:id/revoke-sessions` | `{}` |
| `GET /api/admin/events?name=&userId=&since=&page=&limit=` | → `{ items:[{id, userId, anonId, name, props, path, at, country, device, source}], page, limit, hasMore }` |
| `GET /api/admin/flags` · `GET/PUT /api/admin/flags/:key` | `PUT { enabled, value? }`. Seeded keys: `require_signal_approval`, `live_data`, `signups`, `extension_linking`. |
| `GET/POST /api/admin/announcements` · `PATCH /api/admin/announcements/:id` | `{ level, message, link? (/path or https://), startsAt?, endsAt?, active? }` |
| `GET /api/admin/support?status=&category=&page=` · `GET /api/admin/support/:id` | → `{ items: Ticket[] }` · `{ ticket }` |
| `POST /api/admin/support/:id/reply` · `/status` | `{ body, status? (default "pending") }` → `{ ok, status, emailed }`. The reply also creates a notification for the user. `{ status }` changes the status. |
| `GET /api/admin/audit?page=&action=&targetId=` | → `{ items:[{id, actor, action, targetType, targetId, detail, at}], page, hasMore }` (read-only) |
| `GET /api/admin/dev-outbox` | → `{ items:[{email (masked), code, createdAt, expiresAt, state, attempts}] }` (last 50). `404 dev_codes_off` unless dev codes are active. Each view is audited. |
| `GET /api/admin/compliance` | → `{ consents:[{kind, version, total, active, withdrawn}], dataRequests:{pending[], last30Days[]}, grievances:{olderThan7Days, olderThan21Days, items[]} }` |
| `GET /api/admin/engine/health` · `GET /api/admin/engine/signals?status=&market=&q=&limit=&offset=` · `GET /api/admin/engine/strategies` | These delegate to `market/admin.ts`. A failure returns `502 engine_error` and is audited. |
| `POST /api/admin/engine/signals/:id/hold` · `/invalidate` | `{ hold, reason }` · `{ reason }` |
| `POST /api/admin/engine/strategies` · `POST /api/admin/engine/run` | `{ strategy, market, enabled }` · `{}` (6 per 10 min) |

## Capabilities: what's on with no secrets

| Capability | Needs | Without it |
|---|---|---|
| `emailDelivery` | `RESEND_API_KEY` + `EMAIL_FROM` | Dev codes (if `AUTH_DEV_CODES=on`), otherwise `503 email_unavailable`. Notifications are in-app only. |
| `devCodes` | `AUTH_DEV_CODES=on` and no email provider | — |
| `turnstile` | `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET` | No human check. When on, it fails closed (400 or 503). |
| `googleSignIn` | `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | Routes return 503. Register `https://tudumm.in/api/v1/auth/google/callback` as the redirect URI. |
| `payments` | `RAZORPAY_KEY_ID/KEY_SECRET/WEBHOOK_SECRET` and/or `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` | `/billing` says `enabled:false`. Admins grant plans. |
| `adminConfigured` | `ADMIN_PASSWORD` | Every admin route returns 503. |
| hashing pepper | `SESSION_PEPPER` | Plain SHA-256 instead of HMAC. Setting it later **signs everyone out once**. |

## Security model (summary)

See `SECURITY-REVIEW.md` for the full self-VAPT checklist.

- **Secrets at rest:**
  - Session, admin and device tokens are 256-bit random and stored only as `HMAC-SHA256(SESSION_PEPPER, purpose:value)`.
  - OTPs are stored the same way: the hash covers `email:code`, the row holds only the email hash, and rows are pruned after 24 hours.
  - IPs are only ever stored hashed.
- **Cookies:** `__Host-` prefixed, `Secure; HttpOnly; Path=/`, with SameSite=Lax for users and Strict for admins. No `Domain` attribute.
- **CSRF:** writes need JSON plus a same-origin `Origin`, or an extension Bearer token. Webhooks are verified by HMAC instead.
- **Authorization:** every user query has `WHERE user_id = <session user>`, so IDOR attempts get 404. Admin routes need the admin cookie and the configured password.
- **SQL:** every statement uses `prepare().bind()`. List inputs go in as one JSON parameter expanded with `json_each()`, which keeps clear of D1's 100-parameter limit.
- **Abuse limits:** fixed-window rate limits are stored in D1. OTPs allow 5 attempts, expire after 10 minutes and are single-use. No account enumeration.
- **Audit:** `audit_log` is append-only, enforced by triggers. Every admin mutation and login attempt is audited, and so is self-deletion.
- **Logs:** JSON lines with only a component tag and our own error message. No emails, tokens, IPs or bodies.
