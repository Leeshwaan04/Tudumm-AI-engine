// Snapshot JSON shapes stored in `snapshots.json` (compact; written by the cron, runner or ingest)
// and the builders that turn raw provider data into them. Pure (no I/O).
import type { BuildUpClass, Candle } from "../engine/types";
import type { ChainRow, OptionLeg } from "../engine/options";
import { BUILDUP_EXPLAIN, BUILDUP_LABEL, classifyBuildUp, ivAtm, ladder, maxPain, oiWalls, pcrOI, pcrVolume, skew, toRows } from "../engine/options";
import { bookImbalance } from "../engine/orderbook";
import { percentileRank, roundTo } from "../engine/util";
import type { SourceId } from "./types";

export interface BuildUp {
  class: BuildUpClass;
  label: string;
  priceChangePct: number;
  oiChangePct: number;
  explanation: string;
  basis: string;
}

export function buildUpOf(priceChangePct: number, oiChangePct: number, basis: string): BuildUp {
  const c = classifyBuildUp(priceChangePct, oiChangePct);
  return { class: c, label: BUILDUP_LABEL[c], priceChangePct: roundTo(priceChangePct, 2), oiChangePct: roundTo(oiChangePct, 2), explanation: BUILDUP_EXPLAIN[c], basis };
}

/* ---------------- option chain ---------------- */
export interface ChainSnapshot {
  kind: "option_chain";
  symbol: string;
  underlying: string;
  spot: number;
  expiry: string;
  dte: number;
  tradeDate: string;
  rows: Omit<ChainRow, "callVolume" | "putVolume">[];
  atm: number | null;
  step: number | null;
  pcr: number | null;
  pcrVolume: number | null;
  maxPain: number | null;
  ivAtm: number | null;
  ivRank: number | null;
  ivHistory: [string, number][];
  skew: number | null;
  callWall: number | null;
  putWall: number | null;
  totals: { callOI: number; putOI: number; callDOI: number | null; putDOI: number | null };
  buildUp: BuildUp | null;
  futures: { nearExpiry: string; close: number; prevClose: number; oi: number; oiChange: number } | null;
  lotSize: number | null;
  lotNote: string;
  convention: "india" | "us";
  notes: string[];
  source: SourceId;
  asOf: string;
}

/**
 * Build the compact chain snapshot from all legs of one expiry. PCR and max pain use the WHOLE expiry;
 * rows are the ±15-strike ladder around ATM. `prev` (yesterday's snapshot) supplies ΔOI when the
 * provider doesn't (Cboe) and the IV history used for IV rank.
 */
export function buildChainSnapshot(a: {
  symbol: string;
  underlying: string;
  spot: number;
  expiry: string;
  dte: number;
  tradeDate: string;
  legs: OptionLeg[];
  convention: "india" | "us";
  source: SourceId;
  asOf: string;
  lotSize: number | null;
  futures?: { nearExpiry: string; close: number; prevClose: number; oi: number; oiChange: number; priceChangePct: number; oiChangePct: number } | null;
  prev?: ChainSnapshot | null;
  decimals: number;
}): ChainSnapshot {
  const all = toRows(a.legs);
  const lad = ladder(all, a.spot, 15);
  const notes: string[] = [];
  // ΔOI from the previous snapshot when the source doesn't report it (same expiry only)
  const prevRows = a.prev && a.prev.expiry === a.expiry ? new Map(a.prev.rows.map((r) => [r.strike, r])) : null;
  if (a.convention === "us") {
    if (prevRows) {
      for (const r of lad) {
        const p = prevRows.get(r.strike);
        if (p) {
          r.callDOI = r.callOI - p.callOI;
          r.putDOI = r.putOI - p.putOI;
        }
      }
      notes.push(`ΔOI is versus the previous runner snapshot (${a.prev?.tradeDate ?? "earlier"}).`);
    } else notes.push("ΔOI appears after the second daily snapshot of this expiry (Cboe doesn't publish OI change).");
  }
  const steps = lad.slice(1).map((r, i) => roundTo(r.strike - (lad[i] as ChainRow).strike, 4));
  const step = steps.length ? (steps.sort((x, y) => x - y)[steps.length >> 1] ?? null) : null;
  const walls = oiWalls(lad, a.spot);
  const iv = ivAtm(all, a.spot);
  const hist = [...(a.prev?.ivHistory ?? []).filter(([d]) => d !== a.tradeDate)];
  if (iv !== null) hist.push([a.tradeDate, roundTo(iv, 2)]);
  const ivHistory = hist.slice(-260);
  const ivRank = ivHistory.length >= 20 && iv !== null ? percentileRank(ivHistory.map((x) => x[1]), iv) : null;
  if (ivRank === null) notes.push(`IV rank needs 20+ daily snapshots (have ${ivHistory.length}).`);
  const sumNull = (xs: (number | null)[]) => (xs.some((x) => x === null) ? null : xs.reduce((s: number, x) => s + (x as number), 0));
  const totals = {
    callOI: lad.reduce((s, r) => s + r.callOI, 0),
    putOI: lad.reduce((s, r) => s + r.putOI, 0),
    callDOI: sumNull(lad.map((r) => r.callDOI)),
    putDOI: sumNull(lad.map((r) => r.putDOI)),
  };
  const fut = a.futures ?? null;
  const rd = (x: number | null) => (x === null ? null : roundTo(x, 2));
  return {
    kind: "option_chain",
    symbol: a.symbol,
    underlying: a.underlying,
    spot: roundTo(a.spot, a.decimals),
    expiry: a.expiry,
    dte: a.dte,
    tradeDate: a.tradeDate,
    rows: lad.map((r) => ({ strike: r.strike, callOI: r.callOI, callDOI: r.callDOI, callIV: rd(r.callIV), callLTP: rd(r.callLTP), putLTP: rd(r.putLTP), putIV: rd(r.putIV), putDOI: r.putDOI, putOI: r.putOI })),
    atm: lad.length ? (lad.reduce((b, r) => (Math.abs(r.strike - a.spot) < Math.abs(b.strike - a.spot) ? r : b), lad[0] as ChainRow).strike) : null,
    step,
    pcr: rd(pcrOI(all)),
    pcrVolume: rd(pcrVolume(all)),
    maxPain: maxPain(all),
    ivAtm: rd(iv),
    ivRank,
    ivHistory,
    skew: rd(skew(all, a.spot)),
    callWall: walls.callWall,
    putWall: walls.putWall,
    totals,
    buildUp: fut ? buildUpOf(fut.priceChangePct, fut.oiChangePct, "futures OI, all expiries (NSE F&O bhavcopy)") : null,
    futures: fut ? { nearExpiry: fut.nearExpiry, close: fut.close, prevClose: fut.prevClose, oi: fut.oi, oiChange: fut.oiChange } : null,
    lotSize: a.lotSize,
    lotNote:
      a.convention === "india"
        ? `OI in contracts${a.lotSize ? `; current lot size ${a.lotSize}` : ""}. Lot sizes are revised periodically by NSE.`
        : "OI in contracts (100 shares each).",
    convention: a.convention,
    notes,
    source: a.source,
    asOf: a.asOf,
  };
}

/* ---------------- crypto perp ---------------- */
export interface PerpSnapshot {
  kind: "perp";
  symbol: string;
  venue: string;
  markPrice: number | null;
  indexPrice: number | null;
  premiumPct: number | null;
  fundingRate: number | null; // fraction per interval
  fundingPct: number | null; // percent per interval
  fundingIntervalHours: number;
  fundingAnnualizedPct: number | null;
  nextFundingTime: string | null;
  openInterest: { contracts: number | null; usd: number | null; change24hPct: number | null; window: string | null };
  priceChange24hPct: number | null;
  buildUp: BuildUp | null;
  oiSamples: [number, number][]; // [unix sec, contracts], newest last, ≤ 100 (for OI change when only a spot value is available)
  longShortRatio: null;
  liquidations: null;
  notes: string[];
  source: SourceId;
  asOf: string;
}

/** OI change over ~24h from our own samples (Bybit fallback path). */
export function oiChangeFromSamples(samples: [number, number][], nowSec: number): { pct: number | null; window: string | null } {
  const cur = samples[samples.length - 1];
  if (!cur) return { pct: null, window: null };
  const target = nowSec - 86400;
  let best: [number, number] | null = null;
  for (const s of samples) if (s[0] <= target + 1800 && (!best || Math.abs(s[0] - target) < Math.abs(best[0] - target))) best = s;
  if (!best) {
    const first = samples[0] as [number, number];
    if (cur[0] - first[0] < 3600) return { pct: null, window: null };
    best = first;
  }
  if (!(best[1] > 0)) return { pct: null, window: null };
  const hours = Math.round((cur[0] - best[0]) / 3600);
  return { pct: roundTo(((cur[1] - best[1]) / best[1]) * 100, 2), window: `${hours}h` };
}

/* ---------------- depth ---------------- */
export interface DepthSnapshot {
  symbol: string;
  venue: string;
  bids: [number, number][];
  asks: [number, number][];
  mid: number;
  spread: number;
  spreadBps: number;
  imbalance: number;
  bidAskRatio: number | null;
  bandPct: number;
  asOf: string;
}

export function buildDepthSnapshot(symbol: string, venue: string, bids: [number, number][], asks: [number, number][], asOf: string, keep = 25): DepthSnapshot | null {
  const im = bookImbalance(bids, asks, 1);
  if (!im) return null;
  return {
    symbol,
    venue,
    bids: bids.slice(0, keep),
    asks: asks.slice(0, keep),
    mid: im.mid,
    spread: im.spread,
    spreadBps: roundTo(im.spreadBps, 2),
    imbalance: roundTo(im.imbalance, 4),
    bidAskRatio: im.ratio === null ? null : roundTo(im.ratio, 3),
    bandPct: 1,
    asOf,
  };
}

/* ---------------- fundamentals & context ---------------- */
export interface IndexFundSnapshot {
  kind: "index";
  symbol: string;
  date: string;
  pe: number | null;
  pb: number | null;
  divYield: number | null;
  peHistory: [string, number][]; // ≤ 260 sessions
  source: SourceId;
  asOf: string;
}

export interface FngSnapshot {
  points: { value: number; label: string; t: number }[]; // newest first
  asOf: string;
}

export interface VixHistorySnapshot {
  label: string;
  history: [string, number][]; // oldest first, ≤ 260
  asOf: string;
}

export interface UsdSnapshot {
  eurusdChange20dPct: number;
  asOf: string;
}

/** Benchmark trend for the context layer (SPY / NIFTY), from daily bars. */
export function benchmarkTrend(symbol: string, bars: Candle[]): { symbol: string; aboveEma200: boolean; ema50Rising: boolean } | null {
  if (bars.length < 210) return null;
  const closes = bars.map((b) => b.c);
  const k200 = 2 / 201;
  const k50 = 2 / 51;
  let e200 = closes.slice(0, 200).reduce((a, b) => a + b, 0) / 200;
  let e50 = closes.slice(150, 200).reduce((a, b) => a + b, 0) / 50;
  const e50s: number[] = [];
  for (let i = 200; i < closes.length; i++) {
    e200 = (closes[i] as number) * k200 + e200 * (1 - k200);
    e50 = (closes[i] as number) * k50 + e50 * (1 - k50);
    e50s.push(e50);
  }
  const last = closes[closes.length - 1] as number;
  const prev = e50s[e50s.length - 11] ?? e50s[0] ?? e50;
  return { symbol, aboveEma200: last > e200, ema50Rising: e50 > prev };
}
