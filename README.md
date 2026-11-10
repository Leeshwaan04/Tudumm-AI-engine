# Tudumm: AI market-intelligence engine (v0.1 prototype)

> Tudumm reads every layer of a market and turns it into clear trade setups with defined risk. It works for any instrument, in any market, and every call it makes is publicly tracked.

This repo is a **frontend prototype on simulated data**: a landing page, a trading terminal and a Chrome extension. Every price, signal and track-record number is simulated. Nothing here is investment advice. Trading involves risk of loss.

```
Tudumm-AI-engine/
├── shared/seed.json         canonical simulated dataset (22 instruments, 320-entry hash-chained ledger)
├── scripts/
│   ├── gen-seed.py          regenerates shared/seed.json (do not hand-edit the JSON)
│   ├── verify-ledger.mjs    recomputes the ledger hash chain in Node
│   ├── sync-seed.sh         copies the seed into web/ and extension/
│   └── gen-hero-texture.mjs regenerates the landing hero texture (web/public/assets/hero-terrain.webp)
├── web/                     Vite + React 18 + TypeScript app (landing + terminal)
└── extension/               Chrome MV3 extension, no build step (see extension/README.md)
```

## Run the web app

Requires Node 20.19+ (tested on Node 25 / npm 11).

```bash
cd web
npm install
npm run dev          # http://localhost:5180 (strict port)
```

Other scripts:

```bash
npm run build        # tsc (strict, zero errors) + vite build -> web/dist
npm run preview      # serve the production build on http://localhost:5180
npm run typecheck    # tsc only
npm run sync-seed    # copy shared/seed.json -> web/src/data/seed.json
```

### Routes

| Route | What it is |
| --- | --- |
| `/` | Landing: live hero signal performing the Reveal, ticker, five layers, anatomy of a signal, sit-outs, proof, markets, personas, extension install, pricing |
| `/app` | Signals feed: regime strip, filters (from your profile), signal cards with Track toggles, drumroll countdown for queued reveals, sit-out list, “Your risk” |
| `/app/i/:symbol` | Instrument deep-dive: lightweight-charts candles + volume (15m–1W), EMA 20/50, SL/T1/T2 lines and an entry-zone band, signal panel with position sizer, five evidence tabs, analyst note, related signals |
| `/app/markets` | Heatmap by market (colour = % change vs previous close), or a sortable table view |
| `/app/proof` | Track record computed from the ledger: KPIs, equity curve + drawdown, monthly R heatmap, breakdowns, paginated ledger, **Verify chain** (Web Crypto SHA-256 over all 320 entries) and **Tamper test** |
| `/app/profile` | Persona, markets, capital, currency, risk %, watchlist/tracking, extension web-URL note, Reset demo |

Search anywhere in the terminal with **⌘K / Ctrl K** (symbols, names and aliases such as `RELIANCE.NS`, `BTC-USD`, `GC=F`, `^NSEI`).

Profile, watchlist and tracked signals live in `localStorage` (`tudumm.*` keys). If storage is blocked the app falls back to memory. **Reset demo** on the Profile page clears them and shows onboarding again.

### Verify the ledger yourself

```bash
node scripts/verify-ledger.mjs
# Chain intact: 320/320 entries
```

The browser check on `/app/proof` uses the identical canonical string:
`sha256hex(JSON.stringify([prevHash, id, issuedAt, symbol, direction, entry, stop, target, exit, closedAt, r]))`, with a genesis `prevHash` of 64 zeros. It should end with `Chain intact · 320/320 · head 73c46d…`.

### Regenerate or re-sync data

```bash
python3 scripts/gen-seed.py        # rewrites shared/seed.json
scripts/sync-seed.sh               # copies it to web/src/data and extension/data
scripts/sync-seed.sh web           # web only
```

## Load the Chrome extension

Full details: **see [extension/README.md](extension/README.md)**.

1. Open `chrome://extensions` in Chrome.
2. Switch on **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select the `Tudumm-AI-engine/extension` folder, then pin the two-beat icon.

The extension’s “Open terminal” button opens `http://localhost:5180/app/i/{SYMBOL}` by default, so keep `npm run dev` running in `web/`. While the dev server runs, the extension’s no-install preview is also served at `http://localhost:5180/extension/preview.html` (the landing page links to it only when it exists).

## Notes

- Charts use [TradingView Lightweight Charts™](https://www.tradingview.com/) (Apache-2.0). The TradingView attribution logo stays on every chart.
- Fonts: Instrument Serif, Geist and Geist Mono via Fontsource (bundled, no external requests).
- Live ticks are a mean-reverting random walk around each seed price, clamped so active trades never cross their stop or target 2 and pending entries stay out of their entry zone. Queued signals reveal `revealAfterSec` seconds after load. Historical shapes (candles, order book, option chain) are deterministic per symbol.
- At launch, Tudumm will register where required (e.g., as a SEBI Research Analyst in India).
