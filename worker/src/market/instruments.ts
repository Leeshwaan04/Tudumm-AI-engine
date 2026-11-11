// The live universe (22 instruments, same symbols as shared/seed.json). Static source of truth for the
// Worker and the runner; 0002_market.sql mirrors it into the `instruments` table (ops can disable a row).
import type { InstrumentDef, MarketId, SourceId, Freshness } from "./types";

const H4 = 14400;
const D1 = 86400;

type Base = Pick<InstrumentDef, "symbol" | "name" | "exchange" | "market" | "assetClass" | "currency" | "decimals" | "aliases" | "dataSymbol">;

function india(b: Base, foSymbol: string, benchmark: string | null): InstrumentDef {
  return {
    ...b,
    source: "nse-archives",
    freshness: "eod",
    proxyNote: null,
    ohlc: true,
    style: "positional",
    tf: "1D",
    tfSec: D1,
    expiryBars: 40,
    pendingBars: 5,
    staleAfterSec: 6 * D1,
    closeOffsetSec: 37800, // 10:30 UTC = 16:00 IST
    derivKind: "option_chain",
    flowMode: "volume",
    venueLabel: "NSE",
    benchmark,
    cik: null,
    foSymbol,
  };
}

function us(b: Base, cik: string | null, benchmark: string | null, proxyNote: string | null = null): InstrumentDef {
  return {
    ...b,
    source: "cboe",
    freshness: "delayed-15m",
    proxyNote,
    ohlc: true,
    style: "swing",
    tf: "1D",
    tfSec: D1,
    expiryBars: 15,
    pendingBars: 5,
    staleAfterSec: 5 * D1,
    closeOffsetSec: 76500, // 21:15 UTC: after the 16:00 ET close + 15 min delay (EST or EDT)
    derivKind: "option_chain",
    flowMode: "volume",
    venueLabel: "Cboe (delayed)",
    benchmark,
    cik,
    foSymbol: null,
  };
}

function binance(b: Base, derivKind: InstrumentDef["derivKind"], proxyNote: string | null = null): InstrumentDef {
  return {
    ...b,
    source: "binance",
    freshness: "realtime",
    proxyNote,
    ohlc: true,
    style: "swing",
    tf: "4H",
    tfSec: H4,
    expiryBars: 30,
    pendingBars: 6,
    staleAfterSec: 6 * 3600,
    closeOffsetSec: H4,
    derivKind,
    flowMode: "book",
    venueLabel: "Binance",
    benchmark: null,
    cik: null,
    foSymbol: null,
  };
}

function fx(b: Base): InstrumentDef {
  return {
    ...b,
    source: "ecb-frankfurter",
    freshness: "daily-ref",
    proxyNote: "ECB euro foreign-exchange reference rate (one fix per business day, ~16:00 CET). Close only, no intraday high/low.",
    ohlc: false,
    style: "swing",
    tf: "1D",
    tfSec: D1,
    expiryBars: 15,
    pendingBars: 5,
    staleAfterSec: 5 * D1,
    closeOffsetSec: 61200, // 17:00 UTC
    derivKind: "none",
    flowMode: "none",
    venueLabel: "ECB",
    benchmark: null,
    cik: null,
    foSymbol: null,
  };
}

export const INSTRUMENTS: InstrumentDef[] = [
  india({ symbol: "NIFTY", name: "NIFTY 50", exchange: "NSE", market: "IN", assetClass: "index", currency: "INR", decimals: 2, dataSymbol: "Nifty 50",
    aliases: ["NIFTY", "NIFTY50", "NIFTY 50", "NSE:NIFTY", "NSE:NIFTY50", "^NSEI", "NIFTY_50:INDEXNSE", "NIFTY 50:INDEXNSE"] }, "NIFTY", null),
  india({ symbol: "BANKNIFTY", name: "Nifty Bank", exchange: "NSE", market: "IN", assetClass: "index", currency: "INR", decimals: 2, dataSymbol: "Nifty Bank",
    aliases: ["BANKNIFTY", "NIFTY BANK", "NSE:BANKNIFTY", "^NSEBANK", "NIFTY_BANK:INDEXNSE"] }, "BANKNIFTY", null),
  india({ symbol: "RELIANCE", name: "Reliance Industries", exchange: "NSE", market: "IN", assetClass: "equity", currency: "INR", decimals: 2, dataSymbol: "RELIANCE",
    aliases: ["RELIANCE", "RELIANCE.NS", "NSE:RELIANCE", "RELIANCE:NSE", "BSE:RELIANCE"] }, "RELIANCE", "NIFTY"),
  india({ symbol: "HDFCBANK", name: "HDFC Bank", exchange: "NSE", market: "IN", assetClass: "equity", currency: "INR", decimals: 2, dataSymbol: "HDFCBANK",
    aliases: ["HDFCBANK", "HDFCBANK.NS", "NSE:HDFCBANK", "HDFCBANK:NSE"] }, "HDFCBANK", "NIFTY"),
  india({ symbol: "TCS", name: "Tata Consultancy Services", exchange: "NSE", market: "IN", assetClass: "equity", currency: "INR", decimals: 2, dataSymbol: "TCS",
    aliases: ["TCS", "TCS.NS", "NSE:TCS", "TCS:NSE"] }, "TCS", "NIFTY"),
  india({ symbol: "INFY", name: "Infosys", exchange: "NSE", market: "IN", assetClass: "equity", currency: "INR", decimals: 2, dataSymbol: "INFY",
    aliases: ["INFY", "INFY.NS", "NSE:INFY", "INFY:NSE"] }, "INFY", "NIFTY"),
  india({ symbol: "ICICIBANK", name: "ICICI Bank", exchange: "NSE", market: "IN", assetClass: "equity", currency: "INR", decimals: 2, dataSymbol: "ICICIBANK",
    aliases: ["ICICIBANK", "ICICIBANK.NS", "NSE:ICICIBANK", "ICICIBANK:NSE"] }, "ICICIBANK", "NIFTY"),
  india({ symbol: "SBIN", name: "State Bank of India", exchange: "NSE", market: "IN", assetClass: "equity", currency: "INR", decimals: 2, dataSymbol: "SBIN",
    aliases: ["SBIN", "SBIN.NS", "NSE:SBIN", "SBIN:NSE"] }, "SBIN", "NIFTY"),
  us({ symbol: "SPY", name: "SPDR S&P 500 ETF", exchange: "NYSE Arca", market: "US", assetClass: "etf", currency: "USD", decimals: 2, dataSymbol: "SPY",
    aliases: ["SPY", "AMEX:SPY", "SPY:NYSEARCA", "NYSEARCA:SPY"] }, null, null),
  us({ symbol: "NVDA", name: "NVIDIA", exchange: "NASDAQ", market: "US", assetClass: "equity", currency: "USD", decimals: 2, dataSymbol: "NVDA",
    aliases: ["NVDA", "NASDAQ:NVDA", "NVDA:NASDAQ"] }, "0001045810", "SPY"),
  us({ symbol: "AAPL", name: "Apple", exchange: "NASDAQ", market: "US", assetClass: "equity", currency: "USD", decimals: 2, dataSymbol: "AAPL",
    aliases: ["AAPL", "NASDAQ:AAPL", "AAPL:NASDAQ"] }, "0000320193", "SPY"),
  us({ symbol: "TSLA", name: "Tesla", exchange: "NASDAQ", market: "US", assetClass: "equity", currency: "USD", decimals: 2, dataSymbol: "TSLA",
    aliases: ["TSLA", "NASDAQ:TSLA", "TSLA:NASDAQ"] }, "0001318605", "SPY"),
  us({ symbol: "MSFT", name: "Microsoft", exchange: "NASDAQ", market: "US", assetClass: "equity", currency: "USD", decimals: 2, dataSymbol: "MSFT",
    aliases: ["MSFT", "NASDAQ:MSFT", "MSFT:NASDAQ"] }, "0000789019", "SPY"),
  us({ symbol: "ASML", name: "ASML Holding", exchange: "NASDAQ (US listing)", market: "EU", assetClass: "equity", currency: "USD", decimals: 2, dataSymbol: "ASML",
    aliases: ["ASML", "ASML.AS", "EURONEXT:ASML", "ASML:AMS", "NASDAQ:ASML", "ASML:NASDAQ"] }, "0000937966", "SPY",
    "Priced from ASML's NASDAQ listing in USD (free Cboe delayed feed). The Euronext Amsterdam line in EUR isn't on a free feed."),
  binance({ symbol: "BTCUSDT", name: "Bitcoin", exchange: "Binance", market: "CRYPTO", assetClass: "crypto", currency: "USDT", decimals: 1, dataSymbol: "BTCUSDT",
    aliases: ["BTCUSDT", "BTC_USDT", "BTC-USD", "BTCUSD", "BINANCE:BTCUSDT", "BTC-USDT"] }, "perp"),
  binance({ symbol: "ETHUSDT", name: "Ethereum", exchange: "Binance", market: "CRYPTO", assetClass: "crypto", currency: "USDT", decimals: 2, dataSymbol: "ETHUSDT",
    aliases: ["ETHUSDT", "ETH_USDT", "ETH-USD", "ETHUSD", "BINANCE:ETHUSDT", "ETH-USDT"] }, "perp"),
  binance({ symbol: "SOLUSDT", name: "Solana", exchange: "Binance", market: "CRYPTO", assetClass: "crypto", currency: "USDT", decimals: 2, dataSymbol: "SOLUSDT",
    aliases: ["SOLUSDT", "SOL_USDT", "SOL-USD", "SOLUSD", "BINANCE:SOLUSDT", "SOL-USDT"] }, "perp"),
  fx({ symbol: "EURUSD", name: "Euro / US Dollar", exchange: "FX (OTC)", market: "FX", assetClass: "fx", currency: "USD", decimals: 5, dataSymbol: "EUR",
    aliases: ["EURUSD", "EURUSD=X", "FX:EURUSD", "EUR-USD", "EURUSD:CUR", "OANDA:EURUSD"] }),
  fx({ symbol: "USDINR", name: "US Dollar / Indian Rupee", exchange: "FX (OTC)", market: "FX", assetClass: "fx", currency: "INR", decimals: 4, dataSymbol: "INR",
    aliases: ["USDINR", "INR=X", "USDINR=X", "FX_IDC:USDINR", "USD-INR"] }),
  fx({ symbol: "USDJPY", name: "US Dollar / Japanese Yen", exchange: "FX (OTC)", market: "FX", assetClass: "fx", currency: "JPY", decimals: 3, dataSymbol: "JPY",
    aliases: ["USDJPY", "JPY=X", "USDJPY=X", "FX:USDJPY", "USD-JPY", "OANDA:USDJPY"] }),
  binance({ symbol: "XAUUSD", name: "Gold Spot (PAXG proxy)", exchange: "Binance (PAXG)", market: "CMDTY", assetClass: "commodity", currency: "USD", decimals: 2, dataSymbol: "PAXGUSDT",
    aliases: ["XAUUSD", "GOLD", "GC=F", "OANDA:XAUUSD", "TVC:GOLD", "COMEX:GC1!", "PAXGUSDT", "PAXG"] }, "none",
    "PAXG proxy: Paxos Gold token on Binance (1 PAXG = 1 fine troy oz), quoted in USDT. It tracks spot gold closely but can deviate; it is not the XAUUSD OTC rate or COMEX GC."),
  us({ symbol: "CL", name: "WTI Crude Oil (USO proxy)", exchange: "NYSE Arca (USO)", market: "CMDTY", assetClass: "commodity", currency: "USD", decimals: 2, dataSymbol: "USO",
    aliases: ["CL", "CL=F", "WTI", "NYMEX:CL1!", "USOIL", "TVC:USOIL", "CRUDEOIL", "USO", "NYSEARCA:USO"] }, null, null,
    "USO proxy: prices are the United States Oil Fund ETF (holds near-month WTI futures), NOT the NYMEX CL contract. Levels are in USO dollars; roll costs make USO drift from spot WTI."),
];

export const BY_SYMBOL = new Map(INSTRUMENTS.map((i) => [i.symbol, i]));

const ALIAS = new Map<string, InstrumentDef>();
for (const i of INSTRUMENTS) {
  ALIAS.set(i.symbol.toUpperCase(), i);
  for (const a of i.aliases) ALIAS.set(a.toUpperCase(), i);
}

/** Resolve a user-supplied symbol or alias (case-insensitive). Input is length-checked. */
export function resolveSymbol(q: string | null | undefined): InstrumentDef | null {
  if (!q || q.length > 32) return null;
  return ALIAS.get(q.trim().toUpperCase()) ?? null;
}

export const MARKETS: { id: MarketId; label: string; flag: string }[] = [
  { id: "IN", label: "India", flag: "IN" },
  { id: "US", label: "United States", flag: "US" },
  { id: "EU", label: "Europe", flag: "EU" },
  { id: "CRYPTO", label: "Crypto", flag: "CRYPTO" },
  { id: "FX", label: "Forex", flag: "FX" },
  { id: "CMDTY", label: "Commodities", flag: "CMDTY" },
];

export const LAYERS = [
  { id: "price", label: "Price & Structure" },
  { id: "flow", label: "Order Flow" },
  { id: "derivatives", label: "Derivatives" },
  { id: "fundamentals", label: "Fundamentals" },
  { id: "context", label: "Context & Sentiment" },
] as const;

export const STRATEGIES = ["trend_continuation", "ema20_pullback"] as const;
export const MARKET_IDS: MarketId[] = MARKETS.map((m) => m.id);

/** Fixed, honest "not applicable" reasons per layer (used when the source simply doesn't exist). */
export function naReasons(i: InstrumentDef): Partial<Record<"price" | "flow" | "derivatives" | "fundamentals" | "context", string>> {
  const r: Partial<Record<"price" | "flow" | "derivatives" | "fundamentals" | "context", string>> = {};
  if (i.assetClass === "fx") {
    r.flow = "Spot FX is OTC: there's no central order book or volume, and ECB reference rates are one fix per day.";
    r.derivatives = "No free FX futures/options feed (CME and NSE currency derivatives data aren't free).";
    r.fundamentals = "Rate-differential and inflation feeds aren't wired to a free source yet.";
    r.context = "No free macro calendar or news feed is wired yet.";
  }
  if (i.assetClass === "crypto") {
    r.fundamentals = "Not applicable: crypto assets have no earnings, balance sheet or cash flows.";
  }
  if (i.symbol === "XAUUSD") {
    r.derivatives = "COMEX gold futures/options aren't on a free licensed feed, and the PAXG perp is too thin to read gold positioning.";
    r.fundamentals = "Central-bank and ETF gold flows aren't on a free source yet.";
  }
  if (i.symbol === "CL") {
    r.fundamentals = "EIA inventories and OPEC+ supply data aren't wired yet.";
    r.context = "No free oil-specific sentiment or macro input is wired yet.";
  }
  if (i.symbol === "SPY") r.fundamentals = "ETF: no company filings to read, and index valuation needs a licensed source.";
  if (i.market === "IN" && i.assetClass === "equity") r.fundamentals = "No free licensed source for Indian company fundamentals yet.";
  return r;
}

export interface SourceInfo {
  id: SourceId;
  name: string;
  url: string;
  freshness: Freshness;
  usedFor: string;
  runsIn: "worker" | "runner" | "worker+runner";
  license: string;
  commercialUse: "allowed" | "restricted" | "license_required";
}

export const SOURCES: SourceInfo[] = [
  { id: "binance", name: "Binance public market data (spot)", url: "https://data-api.binance.vision", freshness: "realtime",
    usedFor: "BTC, ETH, SOL and PAXG (gold proxy): 4H klines, 24h ticker, order book depth", runsIn: "worker",
    license: "Binance public market-data endpoints, free with rate limits; Binance Terms of Use apply. Redistribution in a commercial product needs Binance's written consent.",
    commercialUse: "license_required" },
  { id: "binance-futures", name: "Binance USDⓈ-M futures (funding, open interest)", url: "https://fapi.binance.com", freshness: "realtime",
    usedFor: "Crypto perp funding rate and open-interest history", runsIn: "worker",
    license: "Public endpoints; geo-restricted from some regions (incl. some Cloudflare egress). Same Binance terms as spot.", commercialUse: "license_required" },
  { id: "bybit", name: "Bybit v5 linear tickers (fallback)", url: "https://api.bybit.com", freshness: "realtime",
    usedFor: "Funding and open interest when Binance futures is unreachable", runsIn: "worker",
    license: "Public market data; Bybit Terms of Service apply; geo-restricted in some regions.", commercialUse: "license_required" },
  { id: "alternative-me", name: "Alternative.me Crypto Fear & Greed Index", url: "https://api.alternative.me/fng/", freshness: "daily-ref",
    usedFor: "Crypto context layer (sentiment)", runsIn: "worker",
    license: "Free API that asks for attribution to alternative.me; confirm their terms in writing before commercial use.", commercialUse: "restricted" },
  { id: "cboe", name: "Cboe delayed quotes, history and option chains", url: "https://cdn.cboe.com/api/global/delayed_quotes/", freshness: "delayed-15m",
    usedFor: "SPY, NVDA, AAPL, TSLA, MSFT, ASML (US listing), USO (WTI proxy), VIX: quotes (Worker), daily history + option chains (runner)", runsIn: "worker+runner",
    license: "Delayed data for personal, non-commercial use under Cboe's website terms. A Cboe/OPRA data license is required before a paid launch.", commercialUse: "restricted" },
  { id: "sec-edgar", name: "SEC EDGAR XBRL companyfacts", url: "https://data.sec.gov/api/xbrl/companyfacts/", freshness: "eod",
    usedFor: "US fundamentals (revenue, net income, EPS, shares, debt/equity)", runsIn: "runner",
    license: "US government public-domain data; SEC fair-access policy (declared User-Agent, <= 10 requests/s).", commercialUse: "allowed" },
  { id: "nse-archives", name: "NSE end-of-day archives (CM + F&O bhavcopy, index closes)", url: "https://nsearchives.nseindia.com", freshness: "eod",
    usedFor: "India daily candles, option-chain summaries, futures OI build-up, India VIX, index P/E", runsIn: "runner",
    license: "NSE website terms restrict commercial use and redistribution; an NSE data-vending licence is needed before a paid launch. Live NSE JSON APIs are not used.", commercialUse: "license_required" },
  { id: "ecb-frankfurter", name: "ECB euro reference rates via Frankfurter", url: "https://api.frankfurter.dev", freshness: "daily-ref",
    usedFor: "EURUSD, USDINR, USDJPY daily reference closes", runsIn: "worker+runner",
    license: "ECB reference rates are free to reuse (informational, not for transactions); Frankfurter is an open-source proxy.", commercialUse: "allowed" },
];
