# Tudumm v0.2 — Frontend integration spec (web app, admin portal, extension)

Read first:
- `docs/DESIGN-BRIEF.md` (design system and rules)
- `worker/README.md` (core and admin API; the code in `worker/src/api`, `worker/src/admin` and `worker/src/lib` is the source of truth)
- `worker/README-market.md` (market API and the **live ledger v2 hash spec**; `worker/src/market` is the source of truth)

**Current state:** v0.2 work was started by earlier agents and **is partially done on disk**. Inspect `git status` / `git diff`, and the untracked files under `web/src/api`, `web/src/admin`, `web/src/components/{DataProvider,Turnstile,badges}.tsx` and `extension/lib/{account,datasource,ticks}.js`. **Continue from that state.** Don't restart from scratch, but do fix anything broken.


> ## ⚠️ OWNER DIRECTIVE (overrides anything below): NO demo / simulated / dummy / hard-coded market data ANYWHERE
> - **Remove Demo mode entirely** (web app, landing page, admin, extension). No `LIVE/DEMO` switch, no `DEMO DATA` badge, no fallback to `seed.json`.
> - Do not ship the seed dataset or the simulated generators (`web/src/engine/{candles,orderflow,derivatives,fundamentals,prng}` random walk, generated order book/option chain/fundamentals, simulated ledger) in any runtime bundle. Delete or confine them to tests.
> - Every number shown comes from the live API: landing hero cards = real live signals (or a real sit-out card when nothing is open), ticker strip = live quotes, stats = computed from the **live ledger** (if closed calls < 30 say so: "Live track record started <date> · N closed calls — too few to judge yet"), Proof page = live ledger only (keep Verify chain + Tamper test on the live chain, in memory).
> - If the API is unreachable or a source is down: show an explicit state ("Live data temporarily unavailable — retrying") or the API's honest reason — never fake or cached-demo numbers. Freshness labels (real-time / 15-min delayed / end of day / daily reference) and stale warnings stay — they are honesty, not demo.
> - Extension: no bundled-seed fallback; offline state instead. `preview.html` must render real API data (real candles on the mock host-page chart, labelled "Preview of the chip on a chart site").

**Global rules**
- **Honesty**
  - Live signals come from engine v0, which is rule-based and uncalibrated: show `ENGINE V0 · UNCALIBRATED` with a tooltip.
  - Every price shows its freshness badge, and proxies are labelled.
  - In **Live mode, never run the simulated random-walk tick or the generated order book, option chain or fundamentals.** If the API has no data, show the API's honest reason (`layerNotes`, `reason`).
  - The simulated generators remain **only in Demo mode**.
- **Capabilities:** read `GET /api/v1/config` once at boot, then on window focus at most every 5 min. Hide or explain any capability that's false: email delivery, devCodes, Google, Turnstile, payments, adminConfigured, liveData, extensionLinking.
- **API calls:**
  - Use `credentials: "same-origin"` everywhere, and `content-type: application/json` on writes.
  - Handle 401 (sign in), 403 (suspended / bad origin), 429 ("Slow down — try again in a minute"), 503 (capability unavailable) and network failure (an offline banner with retry).
- **Local dev**
  - API: run `npx wrangler dev --local --port 8789 --persist-to .wrangler/state-fe` from the repo root. The local workerd supports compat dates up to 2026-07-29; wrangler.jsonc is already set to that.
  - Migrations: `npx wrangler d1 migrations apply tudumm-db --local --persist-to .wrangler/state-fe`.
  - Live data locally: use the runner (see README-market) with the persist dir.
  - Vite dev proxy: `/api` → `http://127.0.0.1:${TUDUMM_API_PORT ?? 8789}`.
- **Ports:**
  - web agent: 8789 for the API, 5181 for Vite. Run `npm run dev -- --port 5181 --strictPort` in `web/` if it isn't already running.
  - extension agent: 5192.
  - orchestrator: 8790/5191. Never use those.
- **Done:**
  - `npm run build` in `web/` passes with zero TS errors.
  - No console errors on any route.
  - No horizontal scroll at 390 px.
  - Never git commit or push. Never touch `worker/`, `wrangler.jsonc` or root files; ask in your report if the API needs a change.

---
## Part C1 — Web app user-facing integration (`web/src/**` except `web/src/admin/**`)
1. **API layer** `web/src/api/`: a typed client (config, auth, me, profile, watchlist, tracked, alerts, notifications, support, events, consents, billing, ext link, market) plus a `useApi` stale-while-revalidate hook.
2. **Live data only** (see the owner directive at the top; no Demo mode).
   - `DataProvider` loads `/api/v1/market/universe` (seed-shaped), polled every 60 s. Swapping the source must keep every page working.
   - If the universe fails, show the unavailable state with retry — never demo data.
   - Crypto and the PAXG proxy tick over `wss://data-stream.binance.vision/stream?streams=...@miniTicker`, with reconnect and backoff, closed while the tab is hidden. Everything else updates from polling.
   - **Live reveals:** when a new signal id appears between polls, run the Reveal animation on its card and toast "New signal: BTCUSDT ▲ LONG".
   - Remove the simulated "Next reveal" drumroll; the rail shows "Engine runs every 15 min · last run N min ago" from `/api/v1/market/health`.
3. **Instrument page in Live**
   - Chart: `/api/v1/market/candles`. Use a line series when `ohlc:false`, and offer only the supported timeframes. The last candle updates from ticks for crypto.
   - Order Flow: `/depth` (crypto); otherwise show the N/A reason.
   - Derivatives: `/derivatives` (option-chain rows, PCR, max pain, IV, build-up class; perp funding and OI for crypto).
   - Fundamentals: `/fundamentals` (US from SEC).
   - Context: `/context` (Fear & Greed for crypto).
   - Every widget shows `source · as of hh:mm`.
4. **Auth**
   - A Sign in button in the top bar and on the landing nav.
   - Sheet: email → 6-digit code (paste, auto-advance, resend after 30 s).
   - In dev-codes mode, show the code in a clearly labelled box: "UAT MODE — email delivery isn't configured; your code is …", plus a warning not to enter real financial details.
   - Show Turnstile when the capability is on (site key from config; load `https://challenges.cloudflare.com/turnstile/v0/api.js` lazily).
   - Show Google sign-in only if its capability is on.
   - Avatar menu: Account, Support, Sign out.
   - First sign-in: `POST /api/v1/sync` with the guest's localStorage (profile, watchlist, tracked), then switch to server-backed stores with optimistic updates and rollback. Guests keep localStorage.
5. **Onboarding:** add a consent step for Terms, Risk and Privacy, with versions from config and links to the legal pages. It's required for signed-in users (`POST /consents`).
6. **Alerts and notifications:** on the instrument page, "Set price alert" (above/below, prefilled with the current price) and a "Notify me about new signals" toggle. A bell with the unread count and a dropdown (mark read / mark all), polling every 60 s while signed in. Alerts are listed and deletable in Account.
7. **Account `/app/account`:**
   - Plan and features, profile, sessions (revoke; the current one is marked), linked extension devices.
   - Consents (view and withdraw), notification preferences, and "Allow product analytics" (when off, events send nothing).
   - Download my data (`/me/export`); delete account (type DELETE, then sign out).
8. **Support `/app/support`:** a form (category, subject, message; email for guests), my tickets with their threads and reply. For India: "Unresolved grievance? You'll be able to escalate on SEBI SCORES once Tudumm is registered." Never claim registration.
9. **Legal `/terms`, `/privacy`, `/risk`:**
   - Prototype text with the version and date from config, and a header "Draft — pending legal review".
   - Privacy discloses: first-party product analytics (event names), sessions, the data stored, retention, export and delete, the processors (Cloudflare including Cloudflare Web Analytics, which is cookieless; Resend when enabled), and DPDP Act and GDPR rights.
   - Risk covers: probabilistic signals, uncalibrated v0, delayed and EOD data, proxies, not investment advice, and registration status.
   - Link all three from the footer.
10. **Announcements:** a dismissible top banner (per-id dismissal).
11. **Pricing:** plans from config. Upgrade calls `/api/v1/billing`; if it's disabled, show "Billing isn't live yet — you're on the free plan; ask us for early access", linking to Support.
12. **`/app/link?code=XXXX-XXXX`:** sign in if needed, then "Approve Tudumm extension on this device?" (`POST /api/v1/ext/link/approve`), then a success state.
13. **Events:** `track(name, props)` batches events (every 10 s, on `visibilitychange` and via `sendBeacon`), keeps an anonId in localStorage and sends only allowlisted names. Wire up: page_view, instrument_view, signal_view, track_toggle, watchlist_toggle, alert_create, search, onboarding_step, onboarding_complete, plan_view, upgrade_click, extension_preview, verify_chain, tamper_test, signup_start, login, logout, support_submit, sizer_use and filter_change.
14. **Proof:** live ledger only.
   - Live: verify the v2 chain in the browser exactly per README-market, and compare the head with `/ledger/head`. Keep the tamper test.
   - Show "n closed calls — too few to judge" when n < 30.
15. **Landing copy:** "Live beta on free data: crypto (real-time), US (15-min delayed), India (end of day), FX (daily reference)."

## Part C2 — Admin portal (`web/src/admin/**` + one lazy `/admin/*` route block in `web/src/App.tsx`)
- Lazy-loaded so the admin code is a separate chunk.
- `/admin/login` is a password form. When `adminConfigured` is false: "Admin isn't configured yet. Owner: run scripts/set-secrets.sh."
- A denser operator layout with a left nav: Overview, Users, Activity, Engine, Support, Content, Compliance, Audit log, Dev outbox (only when devCodes is on).
- **Overview:**
  - KPI tiles: users, new users over 7 and 30 days, DAU/WAU/MAU, onboarding completion, free→paid, extension-linked, open tickets.
  - Charts: new users per day, DAU per day, the funnel, plan mix, top instruments, a retention cohort table.
  - Use plain SVG or the existing lightweight-charts only. Read `/Users/sumitbagewadi/.claude/skills/dataviz/SKILL.md` first if it exists.
- **Users:** search and filter, a paginated table, and a detail page (profile, plan, sessions, watchlist, tracked, alerts, tickets, the event timeline, notes). Actions: suspend/unsuspend, grant plan (with expiry), note and revoke sessions. Each takes a reason and confirms in a modal.
- **Activity:** the live feed (10 s refresh, pause, filters).
- **Engine:** source health; the signals table with hold/release and invalidate (reason required); the strategies kill-switch grid; "Run engine now"; the ledger head.
- **Support:** inbox by status, thread, reply, status change, and grievance age badges (>7 d amber, >21 d red).
- **Content:** flags (confirm before changing `signups` or `live_data`) and announcements CRUD.
- **Compliance:** consent stats, data requests, aged grievances.
- **Audit log:** paginated, read-only.
- **Dev outbox:** masked emails with their codes.
- Works at 1280 and is usable at 390. Admin data is never cached in localStorage.

## Part D — Chrome extension (`extension/**`, version 0.2.0)
- **Data:**
  - The background loads `{webUrl}/api/v1/market/universe` (cached 60 s), with an explicit offline state when unreachable (no bundled seed fallback).
  - Crypto ticks come from the Binance stream; never run the random walk in Live.
  - Freshness and engine-v0 badges.
- **Manifest:**
  - Extension-page CSP `connect-src 'self' https://tudumm.in https://tudumm-ai-engine.sumitbagewadi6.workers.dev https://data-api.binance.vision wss://data-stream.binance.vision` (plus `http://localhost:*` / `http://127.0.0.1:*` only for dev use).
  - Host permissions only for the Tudumm origins.
  - The default webUrl is `https://tudumm.in`; http is allowed for localhost only.
- **Linking:**
  - `ext/link/start` → show the user code → open verifyUrl.
  - The background polls every `interval` seconds.
  - The token is stored in `chrome.storage.local` only and never sent to any origin except webUrl.
  - When linked, the server watchlist syncs. Unlink revokes the token and clears it.
- **Security:** keep all v0.1 properties: sender checks, the message-schema allowlist, no `innerHTML`, http(s) URL validation.
- **Tests:** `node extension/tests/*.test.mjs` passes. Preview mode keeps working (demo fallback).
