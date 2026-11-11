// Turn stored snapshots/quotes/bars into an EngineInput for one instrument (pure; runner-safe).
import type { Candle, ContextInput, EngineInput, FundamentalsInput } from "../engine/types";
import { percentileRank } from "../engine/util";
import type { InstrumentDef } from "./types";
import { naReasons } from "./instruments";
import type { ChainSnapshot, DepthSnapshot, FngSnapshot, IndexFundSnapshot, PerpSnapshot, UsdSnapshot, VixHistorySnapshot } from "./snapshots";
import { benchmarkTrend } from "./snapshots";
import type { SecFundamentals } from "../data/sec";

export interface LoadedQuote {
  price: number;
  prevClose: number | null;
  asOf: string;
}

export interface LoadedData {
  snapshots: Map<string, { json: unknown; asOf: string }>;
  quotes: Map<string, LoadedQuote>;
  bars: Map<string, Candle[]>; // engine-tf bars per symbol (may include a forming bar)
}

/** Keys an instrument's engine input reads. */
export function snapshotKeysFor(i: InstrumentDef): string[] {
  const k: string[] = [];
  if (i.flowMode === "book") k.push(`depth:${i.symbol}`);
  if (i.derivKind !== "none") k.push(`deriv:${i.symbol}`);
  if (i.market === "US" || i.market === "EU" || (i.market === "IN" && i.assetClass === "index")) k.push(`fund:${i.symbol}`);
  if (i.assetClass === "crypto") k.push("ctx:CRYPTO");
  if (i.source === "cboe" && i.symbol !== "CL") k.push("ctx:US");
  if (i.market === "IN") k.push("ctx:IN");
  if (i.symbol === "XAUUSD") k.push("ctx:USD");
  return k;
}

export function auxQuotesFor(i: InstrumentDef): string[] {
  const q = [i.symbol];
  if (i.source === "cboe" && i.symbol !== "CL") q.push("^VIX");
  if (i.market === "IN") q.push("INDIAVIX");
  if (i.symbol === "ASML") q.push("EURUSD");
  return q;
}

/** A bar is final once its session is over (daily) or its 4H window has closed. */
export function completedBars(i: InstrumentDef, bars: Candle[], nowSec: number): Candle[] {
  const off = i.tf === "4H" ? i.tfSec : i.closeOffsetSec;
  return bars.filter((b) => b.t + off <= nowSec);
}

const ageSec = (iso: string, nowSec: number) => nowSec - Math.floor(Date.parse(iso) / 1000);

function snap<T>(d: LoadedData, key: string, maxAgeSec: number, nowSec: number): T | null {
  const s = d.snapshots.get(key);
  if (!s || ageSec(s.asOf, nowSec) > maxAgeSec) return null;
  return s.json as T;
}

function vixInput(d: LoadedData, quoteKey: string, histKey: string, nowSec: number, label: string, calm: number, elevated: number): ContextInput["vix"] {
  const q = d.quotes.get(quoteKey);
  if (!q || ageSec(q.asOf, nowSec) > 6 * 86400) return null;
  const h = snap<VixHistorySnapshot>(d, histKey, 10 * 86400, nowSec);
  let change5d: number | null = null;
  if (h && h.history.length >= 6) {
    const past = h.history[h.history.length - 6];
    if (past && past[1] > 0) change5d = ((q.price - past[1]) / past[1]) * 100;
  }
  return { value: q.price, change5dPct: change5d, label, calm, elevated };
}

export function buildEngineInput(i: InstrumentDef, completed: Candle[], lastPrice: number, d: LoadedData, nowSec: number): EngineInput {
  const input: EngineInput = {
    symbol: i.symbol,
    market: i.market,
    assetClass: i.assetClass,
    decimals: i.decimals,
    style: i.style,
    tf: i.tf,
    tfSec: i.tfSec,
    expiryBars: i.expiryBars,
    bars: completed,
    lastPrice,
    nowSec,
    staleAfterSec: i.staleAfterSec,
    venueLabel: i.venueLabel,
    flowMode: i.flowMode,
    naReasons: naReasons(i),
  };
  // ---- flow
  if (i.flowMode === "book") {
    const dp = snap<DepthSnapshot>(d, `depth:${i.symbol}`, 3600, nowSec);
    input.depth = dp ? { bids: dp.bids, asks: dp.asks, asOf: dp.asOf, venue: dp.venue } : null;
  }
  // ---- derivatives
  if (i.derivKind === "perp") {
    const p = snap<PerpSnapshot>(d, `deriv:${i.symbol}`, 2 * 3600, nowSec);
    input.perp = p
      ? { fundingRate: p.fundingRate, fundingIntervalHours: p.fundingIntervalHours, oiChange24hPct: p.openInterest.change24hPct, priceChange24hPct: p.priceChange24hPct, venue: p.venue, asOf: p.asOf }
      : null;
  } else if (i.derivKind === "option_chain") {
    const c = snap<ChainSnapshot>(d, `deriv:${i.symbol}`, 7 * 86400, nowSec);
    if (c) {
      input.chain = {
        pcr: c.pcr,
        pcrVolume: c.pcrVolume,
        maxPain: c.maxPain,
        callWall: c.callWall,
        putWall: c.putWall,
        ivAtm: c.ivAtm,
        skew: c.skew,
        callDOI: c.totals.callDOI,
        putDOI: c.totals.putDOI,
        expiry: c.expiry,
        convention: c.convention,
      };
      input.futures = c.buildUp ? { class: c.buildUp.class, priceChangePct: c.buildUp.priceChangePct, oiChangePct: c.buildUp.oiChangePct } : null;
    }
  }
  // ---- fundamentals
  if (i.cik) {
    const f = snap<SecFundamentals & { asOf: string }>(d, `fund:${i.symbol}`, 30 * 86400, nowSec);
    if (f) input.fundamentals = secToInput(f, lastPrice, d);
  } else if (i.market === "IN" && i.assetClass === "index") {
    const f = snap<IndexFundSnapshot>(d, `fund:${i.symbol}`, 10 * 86400, nowSec);
    if (f && f.pe !== null) {
      const pctl = f.peHistory.length >= 60 ? percentileRank(f.peHistory.map((x) => x[1]), f.pe) : null;
      input.fundamentals = { kind: "index", pe: f.pe, pePercentile1y: pctl, label: `NSE index P/E, ${f.date}` };
    }
  }
  // ---- context
  const ctx: ContextInput = {};
  let any = false;
  if (i.assetClass === "crypto") {
    const f = snap<FngSnapshot>(d, "ctx:CRYPTO", 3 * 86400, nowSec);
    const p0 = f?.points[0];
    if (p0) {
      ctx.fearGreed = { value: p0.value, prev: f?.points[1]?.value ?? null };
      any = true;
    }
  }
  if (i.source === "cboe" && i.symbol !== "CL") {
    ctx.vix = vixInput(d, "^VIX", "ctx:US", nowSec, "VIX", 15, 25);
    any ||= !!ctx.vix;
  }
  if (i.market === "IN") {
    ctx.vix = vixInput(d, "INDIAVIX", "ctx:IN", nowSec, "India VIX", 13, 20);
    any ||= !!ctx.vix;
  }
  if (i.benchmark) {
    const bb = d.bars.get(i.benchmark);
    const bt = bb ? benchmarkTrend(i.benchmark, bb) : null;
    if (bt) {
      ctx.benchmark = bt;
      any = true;
    }
  }
  if (i.symbol === "XAUUSD") {
    const u = snap<UsdSnapshot>(d, "ctx:USD", 7 * 86400, nowSec);
    if (u) {
      ctx.usdTrend = { eurusdChange20dPct: u.eurusdChange20dPct };
      any = true;
    }
  }
  input.context = any ? ctx : null;
  return input;
}

export function secToInput(f: SecFundamentals, price: number, d: LoadedData): FundamentalsInput {
  return {
    kind: "equity",
    revenueGrowthPct: f.revenueGrowthPct,
    netMarginPct: f.netMarginPct,
    epsGrowthPct: f.epsGrowthPct,
    pe: peOf(f, price, d),
    label: `SEC ${f.form ?? "filings"} to ${f.periodEnd}, ${f.basis}`,
  };
}

/** P/E from the live price and diluted EPS (TTM or FY), converting EUR filers with the ECB rate. */
export function peOf(f: SecFundamentals, price: number, d: LoadedData): number | null {
  if (f.epsTtm === null || !(price > 0)) return null;
  let eps = f.epsTtm;
  if (f.currency !== "USD") {
    if (f.currency !== "EUR") return null;
    const fx = d.quotes.get("EURUSD");
    if (!fx) return null;
    eps = eps * fx.price;
  }
  if (eps === 0) return null;
  return Math.round((price / eps) * 10) / 10;
}
