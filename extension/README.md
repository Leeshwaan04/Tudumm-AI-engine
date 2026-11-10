# Tudumm: Market Signals (Chrome extension, MV3)

The Tudumm verdict on every chart you open: a floating chip on supported sites, a toolbar popup and a side panel. It's a prototype that runs on **simulated data** from `data/seed.json`. Nothing here is investment advice.

There's no build step: plain ES modules, plain CSS and bundled fonts. Load the folder as it is.

## Install the developer build

1. Open `chrome://extensions` (Chrome 116 or newer).
2. Switch on **Developer mode** (top right).
3. Click **Load unpacked** and select `Tudumm-AI-engine/extension`.
4. Pin the two-beat icon. Open a supported page, e.g. `https://www.tradingview.com/chart/?symbol=NSE%3ARELIANCE`.

The web terminal opens at `http://localhost:5180/app/i/{SYMBOL}` by default. You can change this under **Options**.

## Preview without installing

```bash
cd Tudumm-AI-engine/extension
python3 -m http.server 5190
```

- `http://localhost:5190/preview.html`: the chip on a mock chart page, the popup (380×600) and the side panel (400 wide) side by side. Pick one of 20 example pages, or paste any URL, and all three follow it.
- `http://localhost:5190/popup.html?symbol=RELIANCE`: `?symbol=` simulates page detection. `?url=…&title=…` also works.
- `http://localhost:5190/sidepanel.html?symbol=BTCUSDT`: add `&tab=feed` or `&tab=watch`.
- `http://localhost:5190/options.html`

Outside Chrome the pages use a small shim. Storage is held in memory and mirrored to `localStorage` so the preview frames share it. Controls that need a Chrome API, such as opening the side panel, show **"Available when installed"**. Python's `http.server` has a listen backlog of 5, so on macOS it can refuse a burst of parallel requests. When a module fails to load, `lib/boot-check.js` retries the page (up to 3 times). If that still fails, it shows a Reload button.

## Supported sites

| Site | Detection |
| --- | --- |
| tradingview.com | `?symbol=NSE%3ARELIANCE`, `/symbols/NSE-RELIANCE/`, chart title fallback |
| finance.yahoo.com | `/quote/RELIANCE.NS`, `BTC-USD`, `EURUSD=X`, `GC=F`, `%5ENSEI` |
| google.com/finance | `/quote/RELIANCE:NSE` |
| kite.zerodha.com | `/chart/ext/ciq/NSE/RELIANCE/…`, `/chart/web/tvc/NSE/RELIANCE/…` |
| nseindia.com | `/get-quotes/equity?symbol=RELIANCE` |
| binance.com | `/en/trade/BTC_USDT`, `/en/futures/BTCUSDT`, `/en/price/bitcoin` |
| investing.com, moneycontrol.com | page title only |

Candidates are resolved against the seed `aliases`. A ticker that isn't covered shows **"Not covered yet"**. A page with no ticker shows no chip.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest. Permissions are `storage`, `sidePanel` and `activeTab`. Content scripts run only on the eight sites |
| `background.js` | Module service worker. It owns the seed and engine, answers the chip, stores per-tab detections in `chrome.storage.session`, and opens the side panel and terminal |
| `lib/engine.js` | Seed loader, alias resolution, URL/title detection, live tick simulation, sizing, ledger stats and formatting |
| `lib/protocol.js` | Chip ↔ background messages. Strict allowlist and schema validation |
| `lib/ui.js`, `lib/ui.css` | SignalCard, TradeMap, ConfluenceMeter, pills, rows, layer bars, sizer. Shared by the popup, side panel and preview |
| `lib/platform.js` | Chrome APIs when installed, the preview shim otherwise |
| `lib/tokens.css` | Design tokens and `@font-face` rules for extension pages |
| `content.js` | Classic, self-contained chip in a closed Shadow DOM with system fonts. It exposes `window.TudummChip` in preview |
| `popup.*`, `sidepanel.*`, `options.*`, `preview.*` | The surfaces |
| `data/seed.json` | Copy of `shared/seed.json`. Never edit it by hand; re-copy it, or run `scripts/sync-seed.sh` |
| `fonts/` | Instrument Serif, Geist and Geist Mono (latin + latin-ext woff2, OFL) |
| `icons/` | 16, 32, 48 and 128 px PNGs of the two-beat mark on ink |
| `tests/detect.test.mjs` | `node extension/tests/detect.test.mjs`: every example URL from the brief, plus alias, clamp and format checks |

## Live simulation (matches the web app's rules)

- A deterministic, mean-reverting random walk around the seed price. Each instrument ticks every 1.2–2.0 s. σ per tick is 0.03%, with FX at 0.01% and crypto at 0.08%.
- The price is a pure function of wall-clock time, built from mulberry32 seeded by a hash of the symbol. That's why the popup, side panel and chip all show the same price at the same moment, even though the MV3 worker sleeps when idle.
- Prices are clamped: active and T1-hit trades never cross their stop (breakeven after T1) or target 2, and pending trades stay out of the entry zone.
- Queued signals reveal `revealAfterSec` after each surface loads. A revealed signal is `active` if the price is inside the entry zone at that moment, otherwise `pending`. `issuedMinutesAgo` is counted from page load.

## Security

- **Untrusted page data.** The content script builds its DOM only with `createElement` and `textContent`. It never uses `innerHTML`, `eval` or `new Function`, anywhere in the extension.
- **Messaging.** The background ignores any sender whose `sender.id` isn't the extension, and checks every message against a strict type allowlist with schema checks (`lib/protocol.js`). A `detect` message must come from a tab's top frame with a matching origin. There is no `externally_connectable` key.
- **No `web_accessible_resources`.** The chip inlines its mark and styles.
- **CSP.** `script-src 'self'; object-src 'none'` for extension pages, with no remote code. The pages have no inline scripts or handlers.
- **"Open terminal".** The URL is validated as http(s) before `chrome.tabs.create`, in Options, in the popup and side panel, and again in the background.
