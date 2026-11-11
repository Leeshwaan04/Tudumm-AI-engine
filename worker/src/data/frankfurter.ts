// ECB euro reference rates via Frankfurter (base USD). EURUSD = 1 / (EUR per USD). Close only.
import { getJson } from "./http";

export const FRANKFURTER = "https://api.frankfurter.dev/v1";
export const FX_SYMBOLS = ["EUR", "INR", "JPY"] as const;

export interface FxPoint {
  date: string; // YYYY-MM-DD
  EURUSD: number;
  USDINR: number;
  USDJPY: number;
}

function toPoint(date: string, rates: Record<string, unknown>): FxPoint | null {
  const eur = Number(rates.EUR);
  const inr = Number(rates.INR);
  const jpy = Number(rates.JPY);
  if (!(eur > 0) || !(inr > 0) || !(jpy > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { date, EURUSD: Number((1 / eur).toFixed(5)), USDINR: inr, USDJPY: jpy };
}

export function parseLatest(raw: unknown): FxPoint {
  const r = raw as { date?: string; rates?: Record<string, unknown> };
  const p = r?.rates && r.date ? toPoint(r.date, r.rates) : null;
  if (!p) throw new Error("frankfurter: bad latest payload");
  return p;
}

export function parseSeries(raw: unknown): FxPoint[] {
  const r = raw as { rates?: Record<string, Record<string, unknown>> };
  if (!r?.rates || typeof r.rates !== "object") throw new Error("frankfurter: bad series payload");
  return Object.entries(r.rates)
    .map(([d, v]) => toPoint(d, v))
    .filter((p): p is FxPoint => p !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export const fetchFxLatest = async () => parseLatest(await getJson(`${FRANKFURTER}/latest?base=USD&symbols=${FX_SYMBOLS.join(",")}`, { timeoutMs: 8000 }));

export const fetchFxSeries = async (start: string, end: string) =>
  parseSeries(await getJson(`${FRANKFURTER}/${start}..${end}?base=USD&symbols=${FX_SYMBOLS.join(",")}`, { timeoutMs: 12000 }));

/** Unix seconds for a YYYY-MM-DD date at 00:00 UTC (daily bar open). */
export function dayT(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
}
