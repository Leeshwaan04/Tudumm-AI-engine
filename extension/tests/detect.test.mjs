// Unit checks for URL/title → symbol detection and the live simulation rules.
// Run from the repo root:  node extension/tests/detect.test.mjs
import { readFileSync } from "node:fs";
import { createEngine, siteFor, SITES } from "../lib/engine.js";

const seed = JSON.parse(readFileSync(new URL("../data/seed.json", import.meta.url), "utf8"));
const engine = createEngine(seed, { loadedAt: Date.now() });

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL  ${name}${detail ? `  (${detail})` : ""}`);
  }
}

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

// Every seed alias resolves to its own instrument (no cross-symbol collisions)
for (const inst of seed.instruments) {
  for (const a of [inst.symbol, ...inst.aliases]) {
    check(`alias ${a}`, engine.resolve(a) === inst.symbol, `got ${engine.resolve(a)}`);
  }
}

// Live simulation: deterministic, and clamped per the shared rules over a long window
const t0 = Date.now();
check("deterministic across engines", createEngine(seed).priceAt("NIFTY", t0) === engine.priceAt("NIFTY", t0));
for (const inst of seed.instruments) {
  const s = inst.signal;
  if (!["active", "t1_hit", "pending"].includes(s.status)) continue;
  const mid = (s.entryLow + s.entryHigh) / 2;
  let bad = 0;
  for (let i = 0; i < 4000; i++) {
    const p = engine.priceAt(inst.symbol, t0 + i * 1700);
    if (s.status === "active" || s.status === "t1_hit") {
      const stop = s.status === "t1_hit" ? mid : s.stop;
      if (s.direction === "LONG" ? p <= stop || p >= s.target2 : p >= stop || p <= s.target2) bad++;
    } else if (p >= s.entryLow && p <= s.entryHigh) bad++;
  }
  check(`clamp ${inst.symbol} (${s.status})`, bad === 0, `${bad} violations`);
}

// Queued → revealed: status depends on price in the entry zone at reveal time
for (const inst of seed.instruments.filter((i) => i.signal.status === "queued")) {
  const before = engine.signalState(inst.symbol, engine.loadedAt + 1000);
  const after = engine.signalState(inst.symbol, engine.loadedAt + inst.signal.revealAfterSec * 1000 + 10);
  check(`queued ${inst.symbol} before reveal`, before.status === "queued");
  check(`queued ${inst.symbol} after reveal`, ["active", "pending"].includes(after.status), after.status);
}

// Snapshot levels match the brief's NIFTY example exactly
const nifty = engine.snapshot("NIFTY");
check("NIFTY levels", nifty.levels.entry === "25,900–25,960" && nifty.levels.stop === "25,760" && nifty.levels.t1 === "26,180" && nifty.levels.t2 === "26,350" && nifty.levels.rr === "1.47 / 2.47", JSON.stringify(nifty.levels));
check("NIFTY confidence 71%", nifty.confidencePct === 71);
check("NIFTY map labels", nifty.map.stop.rText === "−1R" && nifty.map.entry.rText === "0" && nifty.map.t1.rText === "+1.5R" && nifty.map.t2.rText === "+2.5R");
check("INR grouping", engine.snapshot("NIFTY").priceText.startsWith("₹") && /₹\d{2},\d{3}\.\d{2}/.test(nifty.priceText), nifty.priceText);
check("USDT suffix", engine.snapshot("BTCUSDT").priceText.endsWith(" USDT"));
check("sit-out has no levels", engine.snapshot("BANKNIFTY").levels === null && engine.snapshot("BANKNIFTY").invalidation === null);

// Ledger stats computed, never hard-coded
const ls = engine.ledgerStats();
check("ledger 320", ls.count === 320 && ls.head === seed.ledger[319].hash);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
