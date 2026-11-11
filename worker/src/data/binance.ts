// Binance public market data (spot via data-api.binance.vision; futures via fapi.binance.com, which is
// geo-blocked from some regions) + the Bybit fallback for funding/OI. Pure parsers + thin fetchers.
import type { Candle } from "../engine/types";
import { getJson } from "./http";

export const SPOT = "https://data-api.binance.vision/api/v3";
export const FAPI = "https://fapi.binance.com";
export const BYBIT = "https://api.bybit.com/v5/market/tickers";

const num = (x: unknown): number => {
  const n = typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN;
  return Number.isFinite(n) ? n : NaN;
};

/* ---------- parsers (pure; exercised by unit tests on saved fixtures) ---------- */

/** Klines: [openTime, o, h, l, c, v, closeTime, quoteVol, trades, takerBuyBase, takerBuyQuote, ignore] */
export function parseKlines(raw: unknown): Candle[] {
  if (!Array.isArray(raw)) throw new Error("klines: not an array");
  const out: Candle[] = [];
  for (const k of raw) {
    if (!Array.isArray(k) || k.length < 10) continue;
    const c: Candle = { t: Math.floor(num(k[0]) / 1000), o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), v: num(k[5]), tb: num(k[9]) };
    if ([c.t, c.o, c.h, c.l, c.c, c.v].every(Number.isFinite)) out.push(c);
  }
  return out;
}

export interface Ticker24h {
  symbol: string;
  last: number;
  open: number; // price 24h ago (rolling window open)
  high: number;
  low: number;
  changePct: number;
  volume: number;
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
  closeTime: number; // ms
}

export function parseTicker(raw: unknown): Ticker24h {
  const r = raw as Record<string, unknown>;
  const t: Ticker24h = {
    symbol: String(r.symbol ?? ""),
    last: num(r.lastPrice),
    open: num(r.openPrice),
    high: num(r.highPrice),
    low: num(r.lowPrice),
    changePct: num(r.priceChangePercent),
    volume: num(r.volume),
    bid: num(r.bidPrice),
    ask: num(r.askPrice),
    bidQty: num(r.bidQty),
    askQty: num(r.askQty),
    closeTime: num(r.closeTime),
  };
  if (!t.symbol || !Number.isFinite(t.last) || t.last <= 0) throw new Error("ticker: bad payload");
  return t;
}

export function parseTickers(raw: unknown): Ticker24h[] {
  if (!Array.isArray(raw)) return [parseTicker(raw)];
  return raw.map(parseTicker);
}

export interface Depth {
  bids: [number, number][];
  asks: [number, number][];
}

export function parseDepth(raw: unknown, keep = 100): Depth {
  const r = raw as { bids?: unknown; asks?: unknown };
  const side = (x: unknown): [number, number][] =>
    (Array.isArray(x) ? x : [])
      .map((l): [number, number] => (Array.isArray(l) ? [num(l[0]), num(l[1])] : [NaN, NaN]))
      .filter(([p, q]) => Number.isFinite(p) && Number.isFinite(q) && p > 0 && q > 0)
      .slice(0, keep);
  const d = { bids: side(r.bids), asks: side(r.asks) };
  if (!d.bids.length || !d.asks.length) throw new Error("depth: empty book");
  return d;
}

export interface PremiumIndex {
  markPrice: number;
  indexPrice: number;
  fundingRate: number; // fraction per interval
  nextFundingTime: number; // ms
  time: number; // ms
}

export function parsePremiumIndex(raw: unknown): PremiumIndex {
  const r = raw as Record<string, unknown>;
  const p = { markPrice: num(r.markPrice), indexPrice: num(r.indexPrice), fundingRate: num(r.lastFundingRate), nextFundingTime: num(r.nextFundingTime), time: num(r.time) };
  if (!Number.isFinite(p.fundingRate) || !Number.isFinite(p.markPrice)) throw new Error("premiumIndex: bad payload");
  return p;
}

export interface OiPoint {
  t: number; // ms
  oi: number; // contracts (base asset)
  oiUsd: number;
}

export function parseOiHist(raw: unknown): OiPoint[] {
  if (!Array.isArray(raw)) throw new Error("openInterestHist: not an array");
  return raw
    .map((x) => {
      const r = x as Record<string, unknown>;
      return { t: num(r.timestamp), oi: num(r.sumOpenInterest), oiUsd: num(r.sumOpenInterestValue) };
    })
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.oi))
    .sort((a, b) => a.t - b.t);
}

export interface BybitTicker {
  markPrice: number;
  indexPrice: number;
  fundingRate: number;
  fundingIntervalHours: number;
  nextFundingTime: number;
  openInterest: number;
  openInterestValue: number;
  prevPrice24h: number;
  price24hPcnt: number; // fraction
  time: number;
}

export function parseBybitTicker(raw: unknown): BybitTicker {
  const r = raw as { retCode?: number; result?: { list?: Record<string, unknown>[] }; time?: number };
  const t = r?.result?.list?.[0];
  if (r?.retCode !== 0 || !t) throw new Error("bybit: bad payload");
  const b = {
    markPrice: num(t.markPrice),
    indexPrice: num(t.indexPrice),
    fundingRate: num(t.fundingRate),
    fundingIntervalHours: num(t.fundingIntervalHour) || 8,
    nextFundingTime: num(t.nextFundingTime),
    openInterest: num(t.openInterest),
    openInterestValue: num(t.openInterestValue),
    prevPrice24h: num(t.prevPrice24h),
    price24hPcnt: num(t.price24hPcnt),
    time: num(r.time),
  };
  if (!Number.isFinite(b.fundingRate)) throw new Error("bybit: no funding");
  return b;
}

/* ---------- fetchers ---------- */

export const fetchKlines = async (symbol: string, interval: string, limit: number) =>
  parseKlines(await getJson(`${SPOT}/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`, { timeoutMs: 8000 }));

export const fetchTickers = async (symbols: string[]) =>
  parseTickers(await getJson(`${SPOT}/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(symbols))}`, { timeoutMs: 8000 }));

export const fetchDepth = async (symbol: string, limit = 100) =>
  parseDepth(await getJson(`${SPOT}/depth?symbol=${encodeURIComponent(symbol)}&limit=${limit}`, { timeoutMs: 6000 }), limit);

export const fetchPremiumIndex = async (symbol: string) =>
  parsePremiumIndex(await getJson(`${FAPI}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`, { timeoutMs: 6000, retries: 0 }));

export const fetchOiHist = async (symbol: string) =>
  parseOiHist(await getJson(`${FAPI}/futures/data/openInterestHist?symbol=${encodeURIComponent(symbol)}&period=1h&limit=25`, { timeoutMs: 6000, retries: 0 }));

export const fetchBybit = async (symbol: string) =>
  parseBybitTicker(await getJson(`${BYBIT}?category=linear&symbol=${encodeURIComponent(symbol)}`, { timeoutMs: 6000, retries: 0 }));

/** Binance kline interval for our timeframes. */
export const BINANCE_TF: Record<string, string> = { "15m": "15m", "1H": "1h", "4H": "4h", "1D": "1d", "1W": "1w" };
