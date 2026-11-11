// Option + futures analytics (pure): PCR, max pain, OI walls, ATM IV, Black-Scholes implied vol,
// strike ladders and the OI build-up class.
import type { BuildUpClass } from "./types";
import { roundTo } from "./util";

export interface OptionLeg {
  strike: number;
  type: "C" | "P";
  oi: number;
  doi: number | null; // change in OI vs previous session (null if unknown)
  volume: number;
  iv: number | null; // percent
  ltp: number | null;
}

export interface ChainRow {
  strike: number;
  callOI: number;
  callDOI: number | null;
  callIV: number | null;
  callLTP: number | null;
  putLTP: number | null;
  putIV: number | null;
  putDOI: number | null;
  putOI: number;
  callVolume: number;
  putVolume: number;
}

/** Merge legs into one row per strike, sorted ascending. */
export function toRows(legs: readonly OptionLeg[]): ChainRow[] {
  const m = new Map<number, ChainRow>();
  for (const g of legs) {
    let r = m.get(g.strike);
    if (!r) {
      r = { strike: g.strike, callOI: 0, callDOI: null, callIV: null, callLTP: null, putLTP: null, putIV: null, putDOI: null, putOI: 0, callVolume: 0, putVolume: 0 };
      m.set(g.strike, r);
    }
    if (g.type === "C") {
      r.callOI += g.oi;
      r.callDOI = g.doi === null ? r.callDOI : (r.callDOI ?? 0) + g.doi;
      r.callIV = g.iv ?? r.callIV;
      r.callLTP = g.ltp ?? r.callLTP;
      r.callVolume += g.volume;
    } else {
      r.putOI += g.oi;
      r.putDOI = g.doi === null ? r.putDOI : (r.putDOI ?? 0) + g.doi;
      r.putIV = g.iv ?? r.putIV;
      r.putLTP = g.ltp ?? r.putLTP;
      r.putVolume += g.volume;
    }
  }
  return [...m.values()].sort((a, b) => a.strike - b.strike);
}

/** Put/call ratio of open interest (null when there is no call OI). */
export function pcrOI(rows: readonly ChainRow[]): number | null {
  let c = 0;
  let p = 0;
  for (const r of rows) {
    c += r.callOI;
    p += r.putOI;
  }
  return c > 0 ? p / c : null;
}

export function pcrVolume(rows: readonly ChainRow[]): number | null {
  let c = 0;
  let p = 0;
  for (const r of rows) {
    c += r.callVolume;
    p += r.putVolume;
  }
  return c > 0 ? p / c : null;
}

/**
 * Max pain: the expiry price (among listed strikes) that minimises the total intrinsic value paid to
 * option holders, i.e. sum(callOI * max(0, S-K)) + sum(putOI * max(0, K-S)).
 */
export function maxPain(rows: readonly ChainRow[]): number | null {
  if (!rows.length) return null;
  let best = Infinity;
  let at: number | null = null;
  for (const cand of rows) {
    const s = cand.strike;
    let pay = 0;
    for (const r of rows) {
      if (s > r.strike) pay += r.callOI * (s - r.strike);
      if (s < r.strike) pay += r.putOI * (r.strike - s);
    }
    if (pay < best) {
      best = pay;
      at = s;
    }
  }
  return at;
}

/** Strike with the largest call OI at/above spot (resistance) and put OI at/below spot (support). */
export function oiWalls(rows: readonly ChainRow[], spot: number): { callWall: number | null; putWall: number | null } {
  let cw: ChainRow | null = null;
  let pw: ChainRow | null = null;
  for (const r of rows) {
    if (r.strike >= spot && r.callOI > 0 && (!cw || r.callOI > cw.callOI)) cw = r;
    if (r.strike <= spot && r.putOI > 0 && (!pw || r.putOI > pw.putOI)) pw = r;
  }
  return { callWall: cw ? cw.strike : null, putWall: pw ? pw.strike : null };
}

export function atmStrike(rows: readonly ChainRow[], spot: number): number | null {
  let best: ChainRow | null = null;
  for (const r of rows) if (!best || Math.abs(r.strike - spot) < Math.abs(best.strike - spot)) best = r;
  return best ? best.strike : null;
}

/** ±n strikes around ATM. */
export function ladder(rows: readonly ChainRow[], spot: number, n = 15): ChainRow[] {
  const atm = atmStrike(rows, spot);
  if (atm === null) return [];
  const i = rows.findIndex((r) => r.strike === atm);
  return rows.slice(Math.max(0, i - n), i + n + 1);
}

/** ATM IV = mean of the call and put IV at the ATM strike (whichever exist). */
export function ivAtm(rows: readonly ChainRow[], spot: number): number | null {
  const atm = atmStrike(rows, spot);
  const r = rows.find((x) => x.strike === atm);
  if (!r) return null;
  const xs = [r.callIV, r.putIV].filter((v): v is number => v !== null && v > 0);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Put IV ~5% below spot minus call IV ~5% above spot (vol points). Positive = downside fear premium. */
export function skew(rows: readonly ChainRow[], spot: number, distance = 0.05): number | null {
  const nearest = (target: number, pick: (r: ChainRow) => number | null) => {
    let best: ChainRow | null = null;
    for (const r of rows) {
      const v = pick(r);
      if (v === null || v <= 0) continue;
      if (!best || Math.abs(r.strike - target) < Math.abs(best.strike - target)) best = r;
    }
    return best ? pick(best) : null;
  };
  const p = nearest(spot * (1 - distance), (r) => r.putIV);
  const c = nearest(spot * (1 + distance), (r) => r.callIV);
  return p === null || c === null ? null : p - c;
}

/* ---------- Black-Scholes ---------- */

/** Standard normal CDF (Abramowitz-Stegun 26.2.17, |err| < 7.5e-8). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/** Black-Scholes price. sigma as a fraction (0.2 = 20%), t in years, r and q continuous. */
export function bsPrice(spot: number, strike: number, t: number, r: number, sigma: number, call: boolean, q = 0): number {
  if (t <= 0 || sigma <= 0) return Math.max(0, call ? spot - strike : strike - spot);
  const sq = sigma * Math.sqrt(t);
  const d1 = (Math.log(spot / strike) + (r - q + 0.5 * sigma * sigma) * t) / sq;
  const d2 = d1 - sq;
  const df = Math.exp(-r * t);
  const dq = Math.exp(-q * t);
  return call ? spot * dq * normCdf(d1) - strike * df * normCdf(d2) : strike * df * normCdf(-d2) - spot * dq * normCdf(-d1);
}

/**
 * Implied volatility by bisection (robust; ~40 iterations). Returns a PERCENT, or null when the price is
 * below intrinsic / outside the 1%..500% band (e.g. stale settlement prices of illiquid strikes).
 */
export function impliedVol(price: number, spot: number, strike: number, t: number, r: number, call: boolean, q = 0): number | null {
  if (!(price > 0) || !(spot > 0) || !(strike > 0) || !(t > 0)) return null;
  const intrinsic = Math.max(0, call ? spot * Math.exp(-q * t) - strike * Math.exp(-r * t) : strike * Math.exp(-r * t) - spot * Math.exp(-q * t));
  if (price <= intrinsic + 1e-9) return null;
  let lo = 0.01;
  let hi = 5;
  if (bsPrice(spot, strike, t, r, hi, call, q) < price) return null;
  if (bsPrice(spot, strike, t, r, lo, call, q) > price) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const p = bsPrice(spot, strike, t, r, mid, call, q);
    if (p > price) hi = mid;
    else lo = mid;
    if (hi - lo < 1e-6) break;
  }
  return roundTo(((lo + hi) / 2) * 100, 2);
}

/* ---------- OI build-up ---------- */

export const BUILDUP_LABEL: Record<BuildUpClass, string> = {
  long_buildup: "Long build-up",
  short_buildup: "Short build-up",
  short_covering: "Short covering",
  long_unwinding: "Long unwinding",
  flat: "No clear build-up",
};

export const BUILDUP_EXPLAIN: Record<BuildUpClass, string> = {
  long_buildup: "Price up with open interest up: new longs are entering.",
  short_buildup: "Price down with open interest up: new shorts are entering.",
  short_covering: "Price up with open interest down: shorts are buying back to exit.",
  long_unwinding: "Price down with open interest down: longs are taking profit or exiting.",
  flat: "Open interest or price barely moved, so positioning gives no read.",
};

/** Classify price change x OI change. Moves smaller than the thresholds (percent) read as "flat". */
export function classifyBuildUp(priceChangePct: number, oiChangePct: number, minPrice = 0.1, minOi = 0.5): BuildUpClass {
  if (Math.abs(oiChangePct) < minOi || Math.abs(priceChangePct) < minPrice) return "flat";
  if (priceChangePct > 0) return oiChangePct > 0 ? "long_buildup" : "short_covering";
  return oiChangePct > 0 ? "short_buildup" : "long_unwinding";
}

/** Third Friday of a month (UTC date string) — US monthly option expiry. */
export function thirdFriday(year: number, month0: number): string {
  const first = new Date(Date.UTC(year, month0, 1));
  const dow = first.getUTCDay();
  const firstFri = 1 + ((5 - dow + 7) % 7);
  const d = new Date(Date.UTC(year, month0, firstFri + 14));
  return d.toISOString().slice(0, 10);
}
