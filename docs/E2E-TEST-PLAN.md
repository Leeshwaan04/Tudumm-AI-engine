# Tudumm — End-to-end test plan (all user flows and scenarios)

Automated with Playwright in `e2e/`.
- **Local:** wrangler dev + Vite, with a fresh D1 seeded by the real runner. Every flow runs here.
- **Production smoke:** https://tudumm.in, read-only flows plus one throwaway account, cleaned up with the account-delete flow.
- Every run checks at 1440×900 and 390×844, and fails on any console error, any horizontal page scroll, or any **demo/simulated/dummy text**.

## 0. Global invariants (run on every page)
- No "demo", "simulated", "dummy", "sample data" or "seed" text. Every price carries a freshness badge (`REAL-TIME` / `DELAYED 15M` / `END OF DAY` / `DAILY REF`) plus its source, and proxies are labelled.
- Live signals show `ENGINE V0 · UNCALIBRATED`. The words "accuracy" and "guaranteed" appear nowhere.
- Footer disclaimer and legal links are present. Security headers are present. HTTP→HTTPS and www→apex redirects work.
- With the API blocked, pages show the "Live data temporarily unavailable — retrying" state and never fall back to fake numbers.

## 1. Visitor (not signed in)
1. **Landing:**
   - The hero shows a real live signal, or a real sit-out card.
   - The ticker shows live quotes.
   - Stats come from the live ledger, with honest copy when the sample is small.
   - Every nav link and CTA works: Open terminal, Add to Chrome (scrolls to the steps), Pricing → Try terminal, the "Built for" persona cards.
2. **Terminal as guest:**
   - The onboarding wizard runs (persona → markets → capital/risk → consent prompt to sign in).
   - The feed filters work (market, style, direction, status, sort).
   - The sit-out rail and the "engine last run" line are shown.
3. **Instrument pages, for one of each:** NSE stock, NSE index, US stock, crypto, FX, the gold proxy, the crude proxy.
   - Chart timeframes, with a line series when there's no OHLC data.
   - The 5 evidence tabs show real data or an honest N/A with its reason.
   - Position sizer maths, including INR grouping.
   - Watchlist and Track saved to localStorage for guests.
4. **Markets heatmap and table view.** **Proof:** Verify chain reports intact; Tamper test breaks at the edited row, and Reset restores it.
5. **⌘K search:** symbol, name and alias (`GC=F` → XAUUSD; `RELIANCE.NS` → RELIANCE). Unknown symbols show a clear message.
6. **Legal pages, the 404 page, and deep links** (refresh on `/app/i/NIFTY` keeps the page).

## 2. Sign-up / sign-in
1. Email → code:
   - Dev-codes UAT box (prod today).
   - Turnstile shown and verified (prod).
   - Wrong code: an attempts counter, then lockout after 5.
   - Expired code.
   - Resend after 30 s.
   - Rate limit (429) message.
2. First sign-in:
   - Guest watchlist, tracked signals and profile merge into the account (sync).
   - Consent step is required.
   - The account is created with a "UAT/unverified" note in dev-code mode.
3. Sign out. Sign in again on a second browser, then see both sessions in Account and revoke the other one.
4. Suspended user: a clear 403 message.

## 3. Signed-in daily use
- Watchlist and track toggles persist on the server across browsers. Profile edits change the feed defaults and sizer defaults.
- Price alerts (above/below), creation validation, and deletion.
  - Trigger: run the engine cron locally with a threshold set to cross, and expect a notification in the bell.
  - The new-signal alert for a watched symbol fires on the next issued signal.
- Notifications: unread count, mark read, mark all read.
- Support: create a ticket (and as a guest with email), reply, and see the status updated by the admin. Includes the grievance wording.
- Account:
  - Plan shown.
  - Export downloads valid JSON containing only this user's data.
  - Consent withdraw.
  - Analytics opt-out (the events endpoint receives nothing afterwards).
  - Delete account: type DELETE, signed out, and signing in again creates a fresh account.
- Pricing: upgrade shows "Billing isn't live yet" (payments capability off).

## 4. Extension
- Load unpacked in Chrome (CDP).
- The chip appears on supported sites. Covered URL patterns: TradingView, Yahoo, Google Finance, Kite, NSE, Binance, Investing.com, Moneycontrol.
- Unknown ticker shows "Not covered yet".
- The chip and popup show live data with badges, offline state when the API is unreachable, and the × dismiss with Undo.
- Linking:
  - start → code shown → `/app/link?code=` approve → extension shows "linked"
  - watchlist syncs both ways
  - unlink revokes the session, which then disappears from Account → Sessions
- Security: messages from foreign senders are ignored, there's no innerHTML, and the token is only ever sent to webUrl.

## 5. Brokers (end users), once phase 2 lands
- The catalog per market shows honest statuses.
- OAuth connect happy path, using each broker's sandbox or paper account where available (Alpaca paper, Kite/Upstox live login by the owner).
- Errors: user cancels, state mismatch, expired session (shows "Reconnect").
- API-key brokers: the checklist, the masked form, a failed validation, then success.
- Portfolio sync renders.
- The order ticket from a signal is disabled with a reason while `user_trading` is off.

## 6. Owner broker: Zerodha, real money, manual
- Connect Kite → callback → status connected with an expiry countdown.
- The relay shows online with its public IP. The static IP gets registered (manual step).
- Guardrails:
  - Trading off → ticket blocked.
  - Value over the limit → blocked.
  - Quantity over the limit → blocked.
  - Daily cap → blocked.
  - Confirm token expired → blocked.
- 1-share CNC test order, end to end:
  - intent → confirm → relay claims → Kite places it → postback updates the status
  - the audit log shows every step
  - the order appears in the Kite order book
- Kill switch mid-queue: queued orders are not placed.
- Disconnect wipes the token.

## 7. Admin
- Login: bad password rate limiting; good password works; cookie flags are correct; the admin pages are blocked for normal users.
- Overview KPIs equal the counts from direct D1 queries.
- Users: search, detail timeline (events from flows 1–3), suspend, unsuspend, grant plan with expiry, note, revoke sessions. Each writes an audit row.
- Engine:
  - source health (Binance 403 → Bybit fallback is visible)
  - hold/release a signal, which hides and unhides it in the user feed
  - invalidate with a reason, which appends a ledger event
  - strategy kill switch, after which no new signals come from it
  - Run engine now
- Support inbox reply and status. Content: flag toggles (signups off → sign-up blocked with a message), announcement banner shown to users and dismissible.
- Compliance and Audit pages. Dev outbox shows recent dev codes, with emails masked.

## 8. Data pipeline
- The */15 cron runs within limits (D1 statement count logged).
- The NSE EOD runner (remote) is idempotent on rerun.
- US daily, FX and the gold proxy work.
- When a source fails, health turns red in admin, the UI shows stale age, and no fake data appears.
- Live ledger v2: the browser verification matches `/ledger/head`.

## 9. Security (VAPT checklist)
- CSRF: a cross-origin POST to every mutating route gets 403.
- IDOR: user B can't read or change user A's alerts, tickets, sessions, broker connections or orders.
- Auth bypass attempts on the admin, relay and ingest routes.
- Rate limits.
- Cookie flags (`__Host-`, Secure, HttpOnly, SameSite).
- CSP violations: none.
- `npm audit` for web/ and the root.
- Secrets scan of the repo and the built bundle: no keys, and no admin or broker tokens in client code.
- Broker credentials are never returned to the browser.
- Postback checksum forgery gets rejected.
