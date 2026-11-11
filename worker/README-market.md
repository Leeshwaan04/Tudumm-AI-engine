# Tudumm market data + engine v0 (Worker `market/`, `data/`, `engine/`, `runner/`)

Real market data from **free** sources plus a **rule-based, uncalibrated** signal engine. Every live
signal carries `engine: "v0"` and `calibrated: false`; confidence is a heuristic, not a probability.
Sitting out is a first-class outcome: any layer without data is `null` with a reason in `layerNotes`.

## Layout
| Path | What |
|---|---|
| `worker/src/engine/*` | PURE TS (no Worker/Node APIs): indicators, option analytics, order-book imbalance, layer scorers, engine v0, lifecycle, ledger v2 hash chain |
| `worker/src/data/*` | One adapter per source: pure parsers + thin fetchers with timeouts/retries (`http.ts`) |
| `worker/src/market/*` | Universe (`instruments.ts`), storage (`store.ts`), engine cycle (`service.ts`), Worker jobs (`jobs.ts`), hook outbox (`outbox.ts`), public routes (`routes.ts`), ingest route, admin contract (`admin.ts`) |
| `worker/src/cron.ts` | Cron dispatcher |
| `worker/migrations/0002_market.sql` | Tables (independent of 0001) |
| `runner/` | Node 25 ingest runner for heavy sources (NSE zips, Cboe history + chains, SEC) |
| `.github/workflows/ci.yml` | CI on every push to main: Worker typecheck, engine/broker/live/extension tests, Worker integration tests, web build. (There is no scheduled ingest workflow: NSE blocks GitHub-hosted runners, so `npm run ingest:nse` runs from an Indian IP.) |
| `runner/backtest.ts` | `npm run backtest`: walk-forward replay of the production engine over the cached NSE history, with costs and confidence intervals |

## Sources (also `GET /api/v1/market/sources`)
| Market | Source | Freshness | Runs in | Commercial use |
|---|---|---|---|---|
| BTC, ETH, SOL, XAUUSD (PAXG proxy) | Binance spot `data-api.binance.vision` (klines 4H, 24h ticker, depth 100) | realtime | Worker (*/15) | licence needed |
| Crypto perps | Binance `fapi` premiumIndex + openInterestHist, fallback Bybit v5 tickers | realtime | Worker | licence needed |
| Crypto sentiment | alternative.me Fear & Greed | daily | Worker (cached 3 h) | attribution; confirm terms |
| SPY, NVDA, AAPL, TSLA, MSFT, ASML (US listing), CL (USO proxy), VIX | Cboe delayed quotes (Worker, US hours) + daily history and option chains (runner) | delayed-15m / EOD | Worker + runner | personal/non-commercial — licence needed |
| US fundamentals | SEC EDGAR companyfacts (User-Agent `SEC_USER_AGENT`) | quarterly (weekly refresh) | runner | public domain |
| NIFTY, BANKNIFTY, RELIANCE, HDFCBANK, TCS, INFY, ICICIBANK, SBIN, India VIX | **5paisa Xstream** (owner's own account): WebSocket ticks, today's forming daily bar, daily history | **realtime** while `npm run live` runs | live runner | owner's personal use only — no redistribution |
| NIFTY, BANKNIFTY, RELIANCE, HDFCBANK, TCS, INFY, ICICIBANK, SBIN | NSE archives: CM + F&O bhavcopy, `ind_close_all` (fallback + option chains + index P/E) | EOD | runner | NSE terms restrict commercial use — licence needed |
| EURUSD, USDINR, USDJPY | ECB reference rates via Frankfurter | daily-ref (close only, `ohlc:false`) | Worker (daily cron) + runner backfill | free reuse |

Yahoo, Stooq and the live NSE JSON APIs are **not** used.

## Engine v0 (rules)
- Style/timeframe: crypto + gold **swing 4H** (expiry 30 bars), US (incl. ASML, CL/USO) **swing 1D** (15 bars), India **positional 1D** (40 bars), FX **swing 1D** (15 bars). Pending entries expire unfilled after 6 (4H) / 5 (1D) bars.
- Candidate direction: trend = close vs EMA50 and EMA20 vs EMA50; momentum (RSI vs 50 and MACD histogram) must not contradict it.
- Layers (−100..100 toward the candidate; `null` + reason when there's no data):
  - **price**: EMA 20/50/200 stack, distance from EMA50 in ATR, EMA50 slope, RSI, MACD, Supertrend(10,3), 20-bar Donchian breakout.
  - **flow**: crypto/PAXG = Binance book imbalance within ±1% of mid + taker-buy share + volume ratio; US/India = EOD volume proxy (up-volume share, volume vs 20-day average, OBV); FX = null (OTC, no volume).
  - **derivatives**: India = futures OI build-up (all expiries) + PCR (NSE writer convention: high PCR = support) + ΔOI + OI walls; US/USO = Cboe chain PCR (OI and volume), put skew, ΔOI vs previous snapshot, walls; crypto = funding + perp OI build-up; FX/gold = null.
  - **fundamentals**: US equities from SEC (revenue growth, net margin, EPS growth, P/E from live price); NIFTY/BANKNIFTY = NSE index P/E percentile over the past year; others null with a reason.
  - **context**: crypto = Fear & Greed (read contrarian); US = VIX level/5-day change + SPY trend for single stocks; India = India VIX + NIFTY trend for stocks; gold = USD trend (ECB EURUSD 20-day change); FX/CL = null.
- **Sit out** when: no trend, momentum conflicts, fewer than **3 non-null layers ≥ +15**, data stale (4H: > 6 h; US/FX: > 5 days; India: > 6 days), too little history (< 60 bars), strategy disabled, cooldown (one bar after a close), or an event-risk flag (earnings calendar isn't free, so `eventRisk.checked:false`).
- Levels: entry = close ± 0.25·ATR14, or a **pending** pullback to EMA20 ± 0.25·ATR when price is > 1.5·ATR from EMA20; stop = 1.5·ATR beyond entry mid, or just beyond the nearest swing (fractal, 60 bars) if tighter but ≥ 1·ATR; T1 = 1.5R, T2 = 2.5R.
- Confidence (uncalibrated) = clamp(0.50 + 0.25·mean(agreeing scores)/100 − 0.05·(#layers ≤ −15), 0.50, 0.78).
- Lifecycle on every run: pending → active when price enters the zone; active → t1_hit at T1 (stop to breakeven); closed at T2 (`target`), stop (`stopped`, or `trailed` after T1), expiry (`expired`), or admin (`invalidated`). Stop is checked before targets within a bar (conservative). Full position, no partials: `r = dir·(exit − entryMid)/|entryMid − originalStop|` — recomputable from the ledger. An unfilled pending signal closes `expired` with `exit:null, r:0`.
- Never two open signals per symbol (enforced by a partial UNIQUE index too). `require_signal_approval` (0001 `feature_flags`; treated as off if the table is missing) → new signals are **held** (not visible) until an admin releases them.

## Ledger hash chain v2
Append-only (`live_ledger`, UPDATE/DELETE blocked by triggers, a trigger rejects a wrong `prev_hash`).
An `issue` entry is written when a signal becomes visible (issued unheld, or released); a `close` entry when a published signal closes.

```
hash = sha256hex(JSON.stringify([prevHash, seq, type, signalId, symbol, direction,
                                 entryLow, entryHigh, stop, target1, target2,
                                 exit ?? null, outcome ?? null, r ?? null, at]))
genesis prevHash = "0000000000000000000000000000000000000000000000000000000000000000"
seq starts at 1; numbers are plain JSON numbers already rounded to the instrument's decimals
(integers stay integers, e.g. 25900 not 25900.0); `at` is an ISO string.
```
Browser verification:
```js
async function verify(entries /* ascending seq, from genesis */) {
  let prev = "0".repeat(64);
  for (const e of entries) {
    const s = JSON.stringify([prev, e.seq, e.type, e.signalId, e.symbol, e.direction, e.entryLow, e.entryHigh,
      e.stop, e.target1, e.target2, e.exit ?? null, e.outcome ?? null, e.r ?? null, e.at]);
    const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    if (e.prevHash !== prev || e.hash !== h) return { ok: false, brokenAt: e.seq };
    prev = h;
  }
  return { ok: true, headHash: prev };
}
```

## Public API (all GET, JSON, `Cache-Control: public, max-age=…`)
Symbols accept any seed alias (case-insensitive). Unknown symbol → 404 `{"error":"unknown_symbol"}`; bad params → 400 `{"error":"bad_request","detail":…}`; non-GET → 405.

### `GET /api/v1/market/universe` (max-age 3)
Same top-level shape as `shared/seed.json`: `{ meta, markets, layers, instruments[], ledger[] }`.
```jsonc
{
  "meta": { "product": "Tudumm", "version": 2, "simulated": false, "live": true, "engine": "v0", "calibrated": false,
            "note": "…", "generatedFor": "2026-11-10", "generatedAt": "ISO",
            "ledgerVersion": 2, "ledgerHash": "sha256(JSON.stringify([prevHash,seq,type,signalId,symbol,direction,entryLow,entryHigh,stop,target1,target2,exit,outcome,r,at]))",
            "ledgerGenesisPrevHash": "000…000" },
  "markets": [{ "id": "IN", "label": "India", "flag": "IN" }, …],          // identical to seed
  "layers":  [{ "id": "price", "label": "Price & Structure" }, …],         // identical to seed
  "instruments": [{
    // seed fields
    "symbol": "NIFTY", "name": "NIFTY 50", "exchange": "NSE", "market": "IN", "assetClass": "index",
    "currency": "INR", "decimals": 2, "price": 25044.65, "prevClose": 24986.4, "aliases": ["NIFTY", …],
    // added live fields
    "changePct": 0.23, "source": "nse-archives", "freshness": "eod", "asOf": "ISO|null", "stale": false,
    "hasData": true,            // false => price/prevClose are null (source not ingested yet)
    "proxyNote": null | "PAXG proxy: …", "ohlc": true, "live": true, "engine": "v0", "calibrated": false,
    "signal": { /* see below */ }
  }],
  "ledger": [ /* last 200 ledger v2 entries, ascending seq (see /ledger) */ ]
}
```
`signal` when there is an open, visible call (`status` ∈ `active|pending|t1_hit`):
```jsonc
{ "id": "SIG-BTCUSDT-20261110T1715", "symbol": "BTCUSDT", "status": "active", "regime": "trending-up",
  "issuedMinutesAgo": 38, "issuedAt": "ISO",
  "layers": { "price": 72, "flow": 31, "derivatives": 18, "fundamentals": null, "context": 22 },
  "layerNotes": { "fundamentals": "Not applicable: crypto assets have no earnings…" },   // reason for every null layer
  "layerDetail": { "price": "Price 3.1% above a rising 50-EMA …", … },                // explanation for every layer
  "thesis": "…real numbers…", "invalidation": "A 4-hour close below 72,140.0 (the stop) …",
  "direction": "LONG", "style": "swing", "timeframe": "4H",
  "strategy": "Trend continuation (v0)", "strategyKey": "trend_continuation",
  "confidence": 0.66, "entryLow": 72800, "entryHigh": 73100, "stop": 72140, "stopCurrent": 72140,
  "target1": 74300, "target2": 75400, "rr1": 1.5, "rr2": 2.5,
  "activatedAt": "ISO|null", "t1At": "ISO|null", "barsElapsed": 3, "expiryBars": 30,
  "engine": "v0", "calibrated": false, "live": true }
```
`signal` when sitting out (no open call; also used while a new call is **held** for approval, or after a close):
```jsonc
{ "id": "SIT-BANKNIFTY-1794268800", "symbol": "BANKNIFTY", "status": "sit_out", "regime": "range",
  "issuedMinutesAgo": 12, "issuedAt": "ISO (evaluation time)",
  "layers": {…}, "layerNotes": {…}, "layerDetail": {…},
  "thesis": "Only 2 of 4 available layers agree with a LONG (…); Tudumm needs at least 3. Sitting out.",
  "invalidation": null, "direction": null, "confidence": null,
  "style": "positional", "timeframe": "1D",
  "sitOutReason": "no_trend|momentum_conflict|insufficient_agreement|stale_data|insufficient_history|event_risk|strategy_disabled|cooldown|no_data|under_review|closed",
  "candidate": "LONG|SHORT|null", "lastClosed": { "id", "outcome", "r", "closedAt" } | null,
  "engine": "v0", "calibrated": false, "live": true }
```
`queued` is never used in live data.

### `GET /api/v1/market/candles?symbol=&tf=15m|1H|4H|1D|1W&limit=1..1000` (crypto and India max-age 30, else 300)
```jsonc
{ "symbol": "BTCUSDT", "tf": "4H", "requestedTf": "4H", "ohlc": true,
  "bars": [{ "t": 1794297600, "o": 74848.6, "h": 74890.01, "l": 74115.65, "c": 74420.01, "v": 2054.39 }],  // t = bar open, unix sec UTC, ascending
  "source": "binance", "freshness": "realtime", "asOf": "ISO", "note": null }
```
Crypto/PAXG: any tf, proxied from Binance (short cache). Others store **1D only**: `1W` is aggregated from 1D (weeks start Monday); `15m/1H/4H` return daily bars with `tf:"1D"` and a `note` (no free intraday data). FX: `ohlc:false` (o=h=l=c) — draw a line.

### `GET /api/v1/market/depth?symbol=` (max-age 5)
Crypto + XAUUSD (PAXG) — live Binance book, falls back to the last 15-min snapshot:
```jsonc
{ "available": true, "symbol": "BTCUSDT", "venue": "Binance", "bids": [[72891.88, 6.95], …], "asks": [[72891.89, 2.26], …],   // top 25 each, best first
  "mid": 72891.885, "spread": 0.01, "spreadBps": 0.0, "imbalance": 0.12, "bidAskRatio": 1.27, "bandPct": 1,   // imbalance = (bid−ask)/(bid+ask) qty within ±1% of mid
  "asOf": "ISO", "source": "binance", "live": true }
```
Others: `{ "available": false, "symbol", "reason": "…", "topOfBook": { "bid", "ask", "bidSize", "askSize", "asOf" } | null }`
(US/USO include Cboe delayed top-of-book; India: "NSE order book isn't available on free data — connect your broker (coming soon)").

### `GET /api/v1/market/derivatives?symbol=` (max-age 60)
Option chain (India from NSE F&O bhavcopy; US/ASML/USO from Cboe):
```jsonc
{ "available": true, "kind": "option_chain", "symbol": "NIFTY", "underlying": "NIFTY", "spot": 25044.65,
  "expiry": "2026-11-17", "dte": 8, "tradeDate": "2026-11-09",
  "rows": [{ "strike": 25000, "callOI": 123450, "callDOI": 2300, "callIV": 11.8, "callLTP": 182.5,
             "putLTP": 131.2, "putIV": 12.6, "putDOI": 9800, "putOI": 154300 }],   // ±15 strikes around ATM; IV in percent; DOI may be null
  "atm": 25050, "step": 50, "pcr": 1.12, "pcrVolume": 0.94, "maxPain": 25000, "ivAtm": 12.2, "ivRank": null,
  "skew": 2.1, "callWall": 25500, "putWall": 24800,
  "buildUp": { "class": "long_buildup", "label": "Long build-up", "priceChangePct": 0.42, "oiChangePct": 3.1,
               "explanation": "Price up with open interest up: new longs are entering.", "basis": "futures OI, all expiries…" } | null,
  "futures": { "nearExpiry", "close", "prevClose", "oi", "oiChange" } | null,
  "lotSize": 65, "lotNote": "…", "notes": ["…"], "convention": "india|us",
  "asOf": "ISO", "source": "nse-archives|cboe", "freshness": "eod", "proxyNote": null }
```
`pcr` and `maxPain` use the whole expiry; walls/rows use the ladder. India IV = Black-Scholes implied vol from the settlement price (r = 6.5%, q = 0). US ΔOI is versus the previous runner snapshot (Cboe doesn't publish it). `ivRank` needs ≥ 20 daily snapshots.
Perp (BTC/ETH/SOL):
```jsonc
{ "available": true, "kind": "perp", "symbol": "BTCUSDT", "venue": "Binance USDⓈ-M perpetual",
  "markPrice": 72872.8, "indexPrice": 72899.84, "premiumPct": -0.0371,
  "funding": { "rate": 0.00005518, "ratePct": 0.00552, "intervalHours": 8, "annualizedPct": 6.04, "nextFundingTime": "ISO" },
  "openInterest": { "contracts": 100668.2, "usd": 7334653077, "change24hPct": 2.4, "window": "24h" },
  "priceChange24hPct": -2.67, "buildUp": { …as above… } | null,
  "longShortRatio": null, "liquidations": null, "notes": ["…"], "asOf": "ISO", "source": "binance-futures|bybit" }
```
Unavailable: `{ "available": false, "kind": "futures|none", "symbol", "reason": "…" }` (FX, XAUUSD).

### `GET /api/v1/market/fundamentals?symbol=` (max-age 300)
```jsonc
{ "available": true, "symbol": "AAPL", "kind": "equity",
  "metrics": [{ "key": "revenueTtm", "label": "Revenue (TTM)", "value": 416161000000, "unit": "USD" },
              { "key": "revenueGrowthPct", "label": "Revenue growth (YoY)", "value": 6.4, "unit": "%" },
              { "key": "netMarginPct", …, "unit": "%" }, { "key": "epsTtm", …, "unit": "USD" }, { "key": "pe", …, "unit": "x" },
              { "key": "marketCap", …, "unit": "USD" }, { "key": "debtToEquity", …, "unit": "x" }, …],
  "basis": "TTM|FY", "periodEnd": "2026-09-26", "filed": "2026-11-03", "form": "10-K", "currency": "USD",
  "asOf": "ISO", "source": "sec-edgar" }
```
Index (NIFTY/BANKNIFTY): `kind:"index"`, metrics `pe`, `pb`, `divYield`, `pePercentile1y` from NSE index closes.
Not available: `{ "available": false, "symbol", "kind": "na", "reason": "…", "metrics": [] }` (India stocks: "No free licensed source yet"; crypto: not applicable; SPY/FX/gold/CL: reason).

### `GET /api/v1/market/context?symbol=` (max-age 300)
```jsonc
{ "available": true, "symbol": "BTCUSDT",
  "items": [{ "kind": "sentiment", "label": "Crypto Fear & Greed", "value": 32, "note": "Fear · yesterday 29 · 7-day avg 30" },
            { "kind": "macro", "label": "SPY trend", "value": "above 200-EMA", "note": "…" }],
  "asOf": "ISO", "reason": null }
```
Unavailable: `{ "available": false, "symbol", "items": [], "reason": "…", "asOf": null }`.

### `GET /api/v1/market/ledger?cursor=&limit=1..500` (max-age 30)
`{ "entries": [LedgerEntry…], "nextCursor": 42 | null, "count": 57, "headHash": "…" }` — ascending `seq`; `cursor` = last seq you have (entries with seq > cursor).
LedgerEntry: `{ seq, type: "issue"|"close", signalId, symbol, market, style, strategy, direction, entryLow, entryHigh, stop, target1, target2, exit, outcome, r, at, prevHash, hash }`.
### `GET /api/v1/market/ledger/head` → `{ "count", "headSeq", "headHash", "asOf" }`
### `GET /api/v1/market/signal?id=SIG-…` → `{ "signal": <public signal incl. closed: status "closed", outcome, exitPrice, r, closedAt>, "events": [{type, at, detail}] }` (held/unpublished → 404)
### `GET /api/v1/market/sources` → `{ "sources": [{ id, name, url, freshness, usedFor, runsIn, license, commercialUse, health: { ok, lastSuccessAt, lastError, lastRunAt, staleSeconds } }], "note" }`
### `GET /api/v1/market/health` → `{ ok, engine:"v0", calibrated:false, lastRunAt, liveSignals, ledgerEntries, sources:[{source, ok, staleSeconds, freshness}], runner: { nseEod, usDaily, fx } }`

## Internal ingest (`POST /api/internal/ingest`)
Bearer `INGEST_TOKEN` (constant-time compare). 503 `ingest_not_configured` when the secret is unset; 401 on a bad token; body ≤ 1 MB JSON:
`{ job, candles?: [{symbol, tf, t, o, h, l, c, v}] (≤ 2000), quotes?: [QuoteRow] (≤ 50), snapshots?: [{key, json, asOf, source}] (≤ 50, json ≤ 256 KB), health?: [{source, ok, error?}], runEngine?: [symbols], lifecycle?: boolean }`.
Symbols must be in the universe (quotes also allow `^VIX`, `INDIAVIX`); snapshot keys must match `^(deriv|depth|fund|ctx):[A-Z^]+$`. With `runEngine`, the Worker runs the engine for those symbols (and steps every open call); with `lifecycle: true` alone it only steps open calls against the pushed quotes. Either way it then dispatches signal hooks and price alerts.

## Live feed (`npm run live`, `runner/live.ts`)
A long-running Node process (your Mac or the Kite relay's VPS) that makes calls refresh in near-realtime. It never places orders; orders go through Zerodha Kite (`relay/kite-relay.mjs`) after owner confirmation.
- **India (5paisa):** TOTP login at startup and 08:45 IST on weekdays (token valid to 23:59 IST) → scrip master (cached per day in `runner/.cache/5paisa/`) → daily history backfill (600 days first run, 10 days after) → `MarketFeedV3` WebSocket 09:00–15:35 IST. A REST `V1/MarketFeed` fallback covers any scrip quiet for 20 s. Pushes changed quotes every `PUSH_MS_IN` (5 s), a heartbeat of all quotes and today's forming 1D bars every 60 s (only while the stream is alive), the final bars at 15:36 and `runEngine` for India at 16:01 IST (closeOffset 16:00). India VIX → `INDIAVIX` quote + `ctx:IN` history. Two refused logins pause India so a wrong PIN can't lock the account.
- **Crypto:** the Worker's own `cryptoJob` (klines, depth, perp funding/OI, F&G) run from this machine's egress every `CRYPTO_JOB_MS` (5 min) and just after each 4H boundary (evaluates the completed bar), plus a one-call ticker refresh every `PUSH_MS_CRYPTO` (15 s). While it runs, the */15 cron skips its own crypto fetch (Binance/Bybit refuse some Cloudflare egress) and only evaluates.
- **Every push sends `lifecycle: true`**, so open calls step through entry → T1 → T2/stop within seconds, and price alerts fire on fresh prices.
- Freshness is labelled by what actually served the quote: 5paisa quotes are `realtime` (stale after 2 min without a push during the NSE session; outside it the last close stays valid for 4 days); otherwise the NSE EOD fallback stays `eod`.
- Config: `runner/live.env` (template `runner/live.env.example`, git-ignored). `--once` (backfill + one push, then exit), `--dry-run` (send nothing), `--no-india`, `--no-crypto`. Tests: `npm run test:live`.
- D1 budget at the defaults: roughly 40–60k rows written per day, under the Workers Free plan's 100k/day.

## Cron (`wrangler.jsonc` triggers)
- `*/15 * * * *`: Binance (tickers, 4H klines ×4, depth ×4, perp funding/OI ×3 with Bybit fallback, Fear & Greed when > 3 h old), Cboe delayed quotes + VIX (US hours, or when no quote exists yet), engine for crypto/PAXG when a new 4H bar completes, up to 2 daily instruments whose newest completed bar hasn't been evaluated, lifecycle for every open signal, then the hook outbox (`onSignalEvent`) and `onPricesUpdated`. Kill switch: `feature_flags.live_data = 0` skips fetching.
- `45 13 * * 1-5`: records that the **runner** owns NSE EOD (zip parsing is too heavy for the Worker); runs lifecycle + outbox.
- `30 15 * * 1-5`: ECB FX (one ~20 KB JSON, self-backfills 420 days if empty) + FX engine.

## Runner
```
node --experimental-strip-types runner/ingest.ts <job> [--local|--remote] [--persist-to DIR] [--config PATH]
     [--ingest-url URL (env INGEST_TOKEN)] [--date YYYYMMDD] [--backfill N] [--no-engine] [--dry-run] [--force-sec]
jobs: nse-eod | us-daily | fx-backfill | all
```
- Default target is the **local** D1 (`wrangler d1 execute tudumm-db --local`); `--persist-to` is passed through (e.g. `.wrangler/state-fe`).
- Writes are generated as SQL files (≤ 500 statements each) and executed with wrangler; reads use `wrangler d1 execute --json`.
- With `--ingest-url https://…/api/internal/ingest`, it POSTs JSON chunks instead (no wrangler needed) and asks the Worker to run the engine.
- NSE downloads use a browser-like UA, ≤ 4 concurrent requests, and a disk cache of compact rows in `runner/.cache/` (holidays/weekends 404 and are skipped).
- Runner-issued signals land in the outbox; the next Worker cron delivers them to `onSignalEvent`.

Local loop:
```
npx wrangler d1 migrations apply tudumm-db --local [--persist-to DIR]
node --experimental-strip-types runner/ingest.ts fx-backfill --local
node --experimental-strip-types runner/ingest.ts nse-eod --backfill 260 --local
node --experimental-strip-types runner/ingest.ts us-daily --local
npx wrangler dev --local --port 8788 --test-scheduled
curl "http://localhost:8788/__scheduled?cron=*/15+*+*+*+*"
curl http://localhost:8788/api/v1/market/universe
npm run test:market
```
