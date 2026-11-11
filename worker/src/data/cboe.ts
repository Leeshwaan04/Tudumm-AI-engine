// Cboe delayed quotes (15 min), daily history and option chains. No CORS => server-side only.
// Quotes are small (Worker cron); history (~600 KB) and chains (2-6 MB) are parsed in the runner.
import type { Candle } from "../engine/types";
import type { OptionLeg } from "../engine/options";
import { getJson } from "./http";

export const CBOE = "https://cdn.cboe.com/api/global/delayed_quotes";

const num = (x: unknown): number => {
  const n = typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN;
  return Number.isFinite(n) ? n : NaN;
};

export interface CboeQuote {
  symbol: string;
  price: number;
  prevClose: number | null;
  changePct: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  iv30: number | null;
  asOf: string; // ISO (Cboe "timestamp" is UTC)
  lastTradeEt: string | null;
}

const posOrNull = (x: unknown) => {
  const n = num(x);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Cboe "YYYY-MM-DD HH:MM:SS" (UTC) -> ISO. */
export function cboeTs(ts: unknown): string {
  const s = String(ts ?? "");
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(s);
  return m ? `${m[1]}T${m[2]}Z` : new Date().toISOString();
}

export function parseQuote(raw: unknown): CboeQuote {
  const r = raw as { timestamp?: string; data?: Record<string, unknown> };
  const d = r?.data;
  if (!d) throw new Error("cboe quote: bad payload");
  const price = num(d.current_price);
  if (!(price > 0)) throw new Error("cboe quote: no price");
  const vol = num(d.volume);
  return {
    symbol: String(d.symbol ?? ""),
    price,
    prevClose: posOrNull(d.prev_day_close),
    changePct: Number.isFinite(num(d.price_change_percent)) ? num(d.price_change_percent) : null,
    open: posOrNull(d.open),
    high: posOrNull(d.high),
    low: posOrNull(d.low),
    volume: Number.isFinite(vol) ? vol : null,
    bid: posOrNull(d.bid),
    ask: posOrNull(d.ask),
    bidSize: Number.isFinite(num(d.bid_size)) ? num(d.bid_size) : null,
    askSize: Number.isFinite(num(d.ask_size)) ? num(d.ask_size) : null,
    iv30: posOrNull(d.iv30),
    asOf: cboeTs(r.timestamp),
    lastTradeEt: typeof d.last_trade_time === "string" ? d.last_trade_time : null,
  };
}

/** Daily history -> candles (t = 00:00 UTC of the session date), oldest first, last `limit` bars. */
export function parseHistory(raw: unknown, limit = 400): Candle[] {
  const r = raw as { data?: Record<string, unknown>[] };
  if (!Array.isArray(r?.data)) throw new Error("cboe history: bad payload");
  const out: Candle[] = [];
  for (const d of r.data) {
    const date = String(d.date ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const c: Candle = { t: Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000), o: num(d.open), h: num(d.high), l: num(d.low), c: num(d.close), v: num(d.volume) || 0 };
    if ([c.o, c.h, c.l, c.c].every((x) => Number.isFinite(x) && x > 0)) out.push(c);
  }
  out.sort((a, b) => a.t - b.t);
  return out.slice(-limit);
}

/** OSI option symbol: ROOT + YYMMDD + C|P + strike*1000 (8 digits). */
export function parseOsi(sym: string): { root: string; expiry: string; type: "C" | "P"; strike: number } | null {
  const m = /^([A-Z.^_]+?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(sym);
  if (!m) return null;
  return { root: m[1] as string, expiry: `20${m[2]}-${m[3]}-${m[4]}`, type: m[5] as "C" | "P", strike: Number(m[6]) / 1000 };
}

export interface CboeChain {
  underlying: CboeQuote;
  byExpiry: Map<string, OptionLeg[]>;
}

export function parseOptions(raw: unknown): CboeChain {
  const r = raw as { timestamp?: string; data?: Record<string, unknown> & { options?: Record<string, unknown>[] } };
  const d = r?.data;
  if (!d || !Array.isArray(d.options)) throw new Error("cboe options: bad payload");
  const underlying = parseQuote({ timestamp: r.timestamp, data: d });
  const byExpiry = new Map<string, OptionLeg[]>();
  for (const o of d.options) {
    const osi = parseOsi(String(o.option ?? ""));
    if (!osi) continue;
    const bid = num(o.bid);
    const ask = num(o.ask);
    const last = num(o.last_trade_price);
    const iv = num(o.iv);
    const leg: OptionLeg = {
      strike: osi.strike,
      type: osi.type,
      oi: Math.max(0, num(o.open_interest) || 0),
      doi: null,
      volume: Math.max(0, num(o.volume) || 0),
      iv: Number.isFinite(iv) && iv > 0 ? Math.round(iv * 10000) / 100 : null, // Cboe gives a fraction
      ltp: last > 0 ? last : bid > 0 && ask > 0 ? Math.round(((bid + ask) / 2) * 100) / 100 : null,
    };
    let arr = byExpiry.get(osi.expiry);
    if (!arr) byExpiry.set(osi.expiry, (arr = []));
    arr.push(leg);
  }
  return { underlying, byExpiry };
}

export const fetchQuote = async (sym: string) => parseQuote(await getJson(`${CBOE}/quotes/${encodeURIComponent(sym)}.json`, { timeoutMs: 8000 }));
