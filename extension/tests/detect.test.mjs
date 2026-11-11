// Unit checks for URL/title → symbol detection, alias resolution, formatting,
// and the live engine's honesty rules (no random walk, no client-side reveals,
// ledger stats from closed calls only), over a recorded live universe.
// Run from the repo root:  node extension/tests/detect.test.mjs
import { readFileSync } from "node:fs";
import { createEngine, siteFor, SITES } from "../lib/engine.js";
import { sanitizeUniverse } from "../lib/datasource.js";

const recorded = sanitizeUniverse(JSON.parse(readFileSync(new URL("./fixtures/universe-live.json", import.meta.url), "utf8")));
if (!recorded.ok) throw new Error(`fixture rejected: ${recorded.reason}`);
// Test data: NIFTY carries the brief's example setup so level formatting can be checked exactly.
const NIFTY_SETUP = { id: "SIG-NIFTY-TEST", symbol: "NIFTY", status: "active", regime: "trending-up", issuedMinutesAgo: 38, layers: { price: 72, flow: 55, derivatives: 81, fundamentals: 20, context: 35 }, thesis: "Test setup.", invalidation: "Hourly close below 25,760.", direction: "LONG", style: "swing", timeframe: "1H", confidence: 0.71, entryLow: 25900, entryHigh: 25960, stop: 25760, target1: 26180, target2: 26350, rr1: 1.47, rr2: 2.47 };
const universe = {
  ...recorded.universe,
  instruments: recorded.universe.instruments.map((i) => (i.symbol === "NIFTY" ? { ...i, price: 25962.4, prevClose: 25884.1, signal: NIFTY_SETUP } : i)),
};
const engine = createEngine(universe, { loadedAt: Date.now() });

import { check, done, section } from "./harness.mjs";

section("detect (live engine)");

// [url, title, expected symbol | null, expected ticker for "Not covered yet" | undefined]
const CASES = [
  // Every example URL listed in the brief
  ["https://www.tradingview.com/chart/?symbol=NSE%3ARELIANCE", "", "RELIANCE"],
  ["https://www.tradingview.com/symbols/NSE-RELIANCE/", "", "RELIANCE"],
  ["https://finance.yahoo.com/quote/RELIANCE.NS", "", "RELIANCE"],
  ["https://finance.yahoo.com/quote/BTC-USD", "", "BTCUSDT"],
  ["https://finance.yahoo.com/quote/EURUSD=X", "", "EURUSD"],
  ["https://finance.yahoo.com/quote/GC=F", "", "XAUUSD"],
  ["https://finance.yahoo.com/quote/%5ENSEI", "", "NIFTY"],
  ["https://www.google.com/finance/quote/RELIANCE:NSE", "", "RELIANCE"],
  ["https://kite.zerodha.com/chart/ext/ciq/NSE/RELIANCE/738561", "", "RELIANCE"],
  ["https://kite.zerodha.com/chart/web/tvc/NSE/RELIANCE/738561", "", "RELIANCE"],
  ["https://www.nseindia.com/get-quotes/equity?symbol=RELIANCE", "", "RELIANCE"],
  ["https://www.binance.com/en/trade/BTC_USDT", "", "BTCUSDT"],
  ["https://www.binance.com/en/futures/BTCUSDT", "", "BTCUSDT"],
  // Title-only sites
  ["https://www.investing.com/equities/apple-computer-inc", "Apple Inc (AAPL) Stock Price Today - Investing.com", "AAPL"],
  ["https://www.investing.com/currencies/eur-usd", "EUR/USD - Euro US Dollar Live Rate - Investing.com", "EURUSD"],
  ["https://www.investing.com/crypto/bitcoin", "Bitcoin Price Today | BTC USD Live Chart - Investing.com", "BTCUSDT"],
  ["https://www.moneycontrol.com/india/stockpricequote/refineries/relianceindustries/RI", "Reliance Industries Share Price Today, Reliance Industries Stock Price NSE/BSE", "RELIANCE"],
  ["https://www.moneycontrol.com/indian-indices/nifty-bank-23.html", "Nifty Bank Live - Nifty Bank Index Today | Moneycontrol", "BANKNIFTY"],
  ["https://www.moneycontrol.com/indian-indices/nifty-50-9.html", "Nifty 50 Live - NIFTY 50 Index Today | Moneycontrol", "NIFTY"],
  // Variants seen in the wild
  ["https://www.tradingview.com/chart/xyz123/?symbol=BINANCE%3ABTCUSDT", "", "BTCUSDT"],
  ["https://www.tradingview.com/chart/abc/", "RELIANCE 1,486.20 ▲ +0.99% Unnamed", "RELIANCE"],
  ["https://finance.yahoo.com/quote/RELIANCE.NS/", "", "RELIANCE"],
  ["https://finance.yahoo.com/quote/^NSEI/", "", "NIFTY"],
  ["https://www.google.com/finance/quote/NIFTY_50:INDEXNSE", "", "NIFTY"],
  ["https://kite.zerodha.com/chart/ext/ciq/NSE/NIFTY%2050/256265", "", "NIFTY"],
  ["https://kite.zerodha.com/chart/web/tvc/NSE/SBIN/779521", "", "SBIN"],
  ["https://www.nseindia.com/get-quotes/derivatives?symbol=BANKNIFTY", "", "BANKNIFTY"],
  ["https://www.binance.com/en/trade/SOL_USDT?type=spot", "", "SOLUSDT"],
  ["https://www.binance.com/en-IN/futures/ETHUSDT", "", "ETHUSDT"],
  ["https://www.binance.com/en/price/bitcoin", "", "BTCUSDT"],
  // Supported site, ticker not in the 22 → "Not covered yet"
  ["https://www.tradingview.com/chart/?symbol=NASDAQ%3AAMZN", "", null, "AMZN"],
  ["https://www.tradingview.com/symbols/NASDAQ-AMZN/", "", null, "AMZN"],
  ["https://kite.zerodha.com/chart/ext/ciq/NSE/WIPRO/969473", "", null, "WIPRO"],
  ["https://finance.yahoo.com/quote/AMZN", "", null, "AMZN"],
  // Supported site, nothing to detect → no chip
  ["https://www.tradingview.com/", "TradingView — Track All Markets", null, null],
  ["https://kite.zerodha.com/dashboard", "Dashboard / Kite", null, null],
  ["https://www.investing.com/news/", "Latest News - Investing.com", null, null],
];

for (const [url, title, sym, ticker] of CASES) {
  const d = engine.detect(url, title);
  check(`detect ${url}`, d.symbol === sym, `got ${d.symbol}, want ${sym}`);
  check(`site ${url}`, d.site !== null, "site not recognized");
  if (ticker !== undefined) check(`ticker ${url}`, d.ticker === ticker, `got ${d.ticker}, want ${ticker}`);
}

// Unsupported sites are ignored entirely
for (const url of ["https://www.google.com/search?q=reliance", "https://example.com/quote/RELIANCE.NS", "http://finance.yahoo.com/quote/AAPL", "not a url"]) {
  const d = engine.detect(url, "Reliance Industries");
  check(`unsupported ${url}`, d.site === null && d.symbol === null, JSON.stringify(d));
}
check("google finance requires /finance path", siteFor("https://www.google.com/finance/quote/AAPL:NASDAQ")?.key === "google" && siteFor("https://www.google.com/maps") === null);
check("8 supported sites", SITES.length === 8);

// Every alias resolves to its own instrument (no cross-symbol collisions)
for (const inst of universe.instruments) {
  for (const a of [inst.symbol, ...inst.aliases]) {
    check(`alias ${a}`, engine.resolve(a) === inst.symbol, `got ${engine.resolve(a)}`);
  }
}

// Prices change only when real data arrives: no random walk, ever.
const t0 = Date.now();
check("deterministic across engines", createEngine(universe).priceAt("NIFTY", t0) === engine.priceAt("NIFTY", t0));
for (const inst of universe.instruments) {
  const want = inst.price ?? null;
  let moved = 0;
  for (let i = 0; i < 400; i++) if (engine.priceAt(inst.symbol, t0 + i * 17_000) !== want) moved++;
  check(`no random walk ${inst.symbol}`, moved === 0, `${moved} prices differ from the universe's ${want}`);
}

// A legacy "queued" signal (v0.1 demo drumroll) is never shown: no client-side reveal.
{
  const btc = universe.instruments.find((i) => i.symbol === "BTCUSDT");
  const legacy = createEngine({ ...universe, instruments: [{ ...btc, signal: { ...NIFTY_SETUP, symbol: "BTCUSDT", status: "queued", revealAfterSec: 25 } }] });
  const later = legacy.signalState("BTCUSDT");
  const snap = legacy.snapshot("BTCUSDT");
  check("legacy queued → sitting out", legacy.instruments[0].signal.status === "sit_out" && later.status === "sit_out" && snap.status === "sit_out");
  check("no countdown / reveal fields", !("countdown" in snap) && !("secondsToReveal" in snap) && !("revealAt" in later));
}

// Snapshot levels match the brief's NIFTY example exactly
const nifty = engine.snapshot("NIFTY");
check("NIFTY levels", nifty.levels.entry === "25,900–25,960" && nifty.levels.stop === "25,760" && nifty.levels.t1 === "26,180" && nifty.levels.t2 === "26,350" && nifty.levels.rr === "1.47 / 2.47", JSON.stringify(nifty.levels));
check("NIFTY confidence 71%", nifty.confidencePct === 71);
check("NIFTY map labels", nifty.map.stop.rText === "−1R" && nifty.map.entry.rText === "0" && nifty.map.t1.rText === "+1.5R" && nifty.map.t2.rText === "+2.5R");
check("INR grouping", engine.snapshot("NIFTY").priceText.startsWith("₹") && /₹\d{2},\d{3}\.\d{2}/.test(nifty.priceText), nifty.priceText);
check("USDT suffix", engine.snapshot("BTCUSDT").priceText.endsWith(" USDT"));
check("sit-out has no levels", engine.snapshot("BANKNIFTY").levels === null && engine.snapshot("BANKNIFTY").invalidation === null);

// Ledger stats computed from the live (v2) ledger, never hard-coded: closed calls only.
const L = universe.ledger;
const ls = engine.ledgerStats();
check("ledger: issues aren't counted as closed calls", L.length > 0 && ls.entries === L.length && ls.count === L.filter((e) => e.type === "close" && e.r != null).length && ls.head === L[L.length - 1].hash);
check("ledger: under 30 closes is too few to judge", ls.tooFew === true);
{
  const close = { ...L[0], type: "close", r: 1.5, outcome: "target", hash: "f".repeat(64) };
  const st = createEngine({ ...universe, ledger: [...L, close] }).ledgerStats();
  check("ledger: a close counts, with its R", st.count === ls.count + 1 && st.totalR === (ls.totalR || 0) + 1.5 && st.head === close.hash);
}

await done(import.meta.url);
