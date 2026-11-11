// Bybit spot market data — fallback when Binance refuses Cloudflare egress (HTTP 403/451).
// Same shapes as the Binance adapter so callers can swap venues; callers must label the venue.
import type { Candle } from "../engine/types";
import type { Depth, Ticker24h } from "./binance";
import { getJson } from "./http";

const BASE = "https://api.bybit.com/v5/market";

/** Binance symbol -> Bybit spot symbol. PAXG isn't listed on Bybit spot; XAUT (Tether Gold) is the gold proxy there. */
const SPOT_SYMBOL: Record<string, string> = { PAXGUSDT: "XAUTUSDT" };
export const bybitSpotSymbol = (binanceSymbol: string): string => SPOT_SYMBOL[binanceSymbol] ?? binanceSymbol;

/** Our timeframes -> Bybit kline intervals. */
export const BYBIT_TF: Record<string, string> = { "15m": "15", "1H": "60", "4H": "240", "1D": "D", "1W": "W" };

const num = (x: unknown): number => {
  const n = typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN;
  return Number.isFinite(n) ? n : NaN;
};

function result(raw: unknown): Record<string, unknown> {
  const r = raw as { retCode?: number; result?: Record<string, unknown> };
  if (r?.retCode !== 0 || !r.result) throw new Error("bybit: bad payload");
  return r.result;
}

/** Kline rows are newest-first: [startMs, o, h, l, c, volume, turnover]. Returned ascending. */
export function parseBybitKlines(raw: unknown): Candle[] {
  const list = result(raw).list;
  if (!Array.isArray(list)) throw new Error("bybit klines: not an array");
  const out: Candle[] = [];
  for (const k of list) {
    if (!Array.isArray(k) || k.length < 6) continue;
    const c: Candle = { t: Math.floor(num(k[0]) / 1000), o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), v: num(k[5]) };
    if ([c.t, c.o, c.h, c.l, c.c, c.v].every(Number.isFinite)) out.push(c);
  }
  if (!out.length) throw new Error("bybit klines: empty");
  return out.sort((a, b) => a.t - b.t);
}

/** Spot ticker mapped onto the Binance Ticker24h shape. `symbol` is the BINANCE symbol so callers can key by it. */
export function parseBybitSpotTicker(raw: unknown, binanceSymbol: string): Ticker24h {
  const list = result(raw).list;
  const t = Array.isArray(list) ? (list[0] as Record<string, unknown> | undefined) : undefined;
  if (!t) throw new Error("bybit ticker: empty");
  const out: Ticker24h = {
    symbol: binanceSymbol,
    last: num(t.lastPrice),
    open: num(t.prevPrice24h),
    high: num(t.highPrice24h),
    low: num(t.lowPrice24h),
    changePct: num(t.price24hPcnt) * 100,
    volume: num(t.volume24h),
    bid: num(t.bid1Price),
    ask: num(t.ask1Price),
    bidQty: num(t.bid1Size),
    askQty: num(t.ask1Size),
    closeTime: Date.now(),
  };
  if (!Number.isFinite(out.last) || out.last <= 0) throw new Error("bybit ticker: bad price");
  return out;
}

export function parseBybitDepth(raw: unknown, keep = 100): Depth {
  const r = result(raw);
  const side = (x: unknown): [number, number][] =>
    (Array.isArray(x) ? x : [])
      .map((l): [number, number] => (Array.isArray(l) ? [num(l[0]), num(l[1])] : [NaN, NaN]))
      .filter(([p, q]) => Number.isFinite(p) && Number.isFinite(q) && p > 0 && q > 0)
      .slice(0, keep);
  const d = { bids: side(r.b), asks: side(r.a) };
  if (!d.bids.length || !d.asks.length) throw new Error("bybit depth: empty book");
  return d;
}

export const fetchBybitKlines = async (binanceSymbol: string, tf: string, limit: number) =>
  parseBybitKlines(
    await getJson(`${BASE}/kline?category=spot&symbol=${encodeURIComponent(bybitSpotSymbol(binanceSymbol))}&interval=${BYBIT_TF[tf] ?? "240"}&limit=${Math.min(1000, Math.max(1, limit))}`, { timeoutMs: 8000 }),
  );

export const fetchBybitSpotTicker = async (binanceSymbol: string) =>
  parseBybitSpotTicker(await getJson(`${BASE}/tickers?category=spot&symbol=${encodeURIComponent(bybitSpotSymbol(binanceSymbol))}`, { timeoutMs: 6000 }), binanceSymbol);

export const fetchBybitDepth = async (binanceSymbol: string, limit = 100) =>
  parseBybitDepth(await getJson(`${BASE}/orderbook?category=spot&symbol=${encodeURIComponent(bybitSpotSymbol(binanceSymbol))}&limit=${Math.min(200, limit)}`, { timeoutMs: 6000 }), limit);

/** Human label for the venue that actually served a symbol (honest proxy labelling). */
export const bybitVenueLabel = (binanceSymbol: string): string => (SPOT_SYMBOL[binanceSymbol] ? `Bybit (${bybitSpotSymbol(binanceSymbol).replace("USDT", "")} proxy)` : "Bybit");
