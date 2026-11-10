import { rng } from "./prng";
import type { Instrument } from "./types";
import { isTrade } from "./types";
import { dirSign, score } from "./orderflow";

export type DerivKind = "chain" | "crypto" | "futures";
export function derivKind(inst: Instrument): DerivKind {
  if (inst.assetClass === "crypto") return "crypto";
  if (inst.assetClass === "fx" || inst.assetClass === "commodity") return "futures";
  return "chain";
}

/* ---------- option chain ---------- */
const STRIKE_STEP: Record<string, number> = {
  NIFTY: 50,
  BANKNIFTY: 100,
  RELIANCE: 10,
  HDFCBANK: 10,
  TCS: 20,
  INFY: 20,
  ICICIBANK: 10,
  SBIN: 5,
  SPY: 1,
  NVDA: 2.5,
  AAPL: 2.5,
  TSLA: 5,
  MSFT: 5,
  ASML: 10,
};
const BASE_IV: Record<string, number> = {
  NIFTY: 12.4,
  BANKNIFTY: 14.8,
  RELIANCE: 23.5,
  HDFCBANK: 19.6,
  TCS: 22.8,
  INFY: 36.2,
  ICICIBANK: 21.4,
  SBIN: 26.9,
  SPY: 14.1,
  NVDA: 45.8,
  AAPL: 21.9,
  TSLA: 57.6,
  MSFT: 23.7,
  ASML: 32.4,
};
const DTE: Record<string, number> = { NIFTY: 2, BANKNIFTY: 9, SPY: 3 };

function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
function bs(spot: number, k: number, ivPct: number, t: number, call: boolean): number {
  const v = (ivPct / 100) * Math.sqrt(t);
  if (v <= 0) return Math.max(0, call ? spot - k : k - spot);
  const d1 = (Math.log(spot / k) + 0.5 * v * v) / v;
  const d2 = d1 - v;
  return call ? spot * normCdf(d1) - k * normCdf(d2) : k * normCdf(-d2) - spot * normCdf(-d1);
}

export interface ChainRow {
  strike: number;
  callOI: number;
  callChg: number;
  callIV: number;
  callLTP: number;
  putLTP: number;
  putIV: number;
  putChg: number;
  putOI: number;
}
export interface OptionChain {
  rows: ChainRow[];
  atm: number;
  step: number;
  pcr: number;
  maxPain: number;
  ivRank: number;
  atmIV: number;
  dte: number;
  expiryLabel: string;
  callWall: number;
  putWall: number;
  lotNote: string;
}

function niceStep(price: number): number {
  const raw = price * 0.005;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

export function optionChain(inst: Instrument, spot: number): OptionChain {
  const r = rng(`${inst.symbol}:chain`);
  const step = STRIKE_STEP[inst.symbol] ?? niceStep(inst.price);
  const atm = Math.round(spot / step) * step;
  const sign = dirSign(inst);
  const s = score(inst, "derivatives");
  const baseIV = BASE_IV[inst.symbol] ?? 25;
  const dte = DTE[inst.symbol] ?? (inst.market === "IN" ? 16 : 10);
  const t = dte / 365;
  const sig = inst.signal;
  // walls: support strike for LONG near the stop, resistance strike for SHORT near the stop
  const supportStrike = isTrade(sig) && sign > 0 ? Math.floor(sig.stop / step) * step + step : atm - 3 * step;
  const resistStrike = isTrade(sig) && sign < 0 ? Math.ceil(sig.stop / step) * step - step : atm + 3 * step;
  const roundAbove = Math.ceil((spot + step * 0.01) / (step * 2)) * step * 2;
  const roundBelow = Math.floor((spot - step * 0.01) / (step * 2)) * step * 2;
  const unit = inst.assetClass === "index" ? 75 : inst.market === "IN" ? 500 : 100;
  const baseOI = (inst.assetClass === "index" ? 9_000_000 : inst.market === "IN" ? 2_400_000 : 60_000) / unit;
  const rows: ChainRow[] = [];
  for (let i = -6; i <= 6; i++) {
    const k = atm + i * step;
    const dist = Math.abs(i);
    const callShape = Math.exp(-Math.max(0, -i) / 1.6) * (0.7 + 0.5 * Math.exp(-Math.max(0, i - 2) / 5));
    const putShape = Math.exp(-Math.max(0, i) / 1.6) * (0.7 + 0.5 * Math.exp(-Math.max(0, -i - 2) / 5));
    let callOI = baseOI * callShape * (0.75 + r.next() * 0.5) * (1 - sign * s * 0.25);
    let putOI = baseOI * putShape * (0.75 + r.next() * 0.5) * (1 + sign * s * 0.35);
    let callChg = callOI * (r.next() - 0.5) * 0.16;
    let putChg = putOI * (r.next() - 0.5) * 0.16;
    if (sign > 0) {
      putChg = Math.abs(putChg) * (i <= 0 ? 1 : 0.4);
      if (k === supportStrike) {
        putOI *= 1.9;
        const pct = 0.18 + s * 0.25;
        putChg = (putOI * pct) / (1 + pct);
      }
      if (k === roundAbove) {
        callOI *= 1.5;
        callChg = -callOI * (0.1 + s * 0.12);
      }
    } else if (sign < 0) {
      callChg = Math.abs(callChg) * (i >= 0 ? 1 : 0.4);
      if (k === resistStrike) {
        callOI *= 1.9;
        const pct = 0.18 + s * 0.25;
        callChg = (callOI * pct) / (1 + pct);
      }
      if (k === roundBelow) {
        putOI *= 1.5;
        putChg = -putOI * (0.1 + s * 0.12);
      }
    } else if (dist === 0) {
      callOI *= 1.5;
      putOI *= 1.5; // straddle writers pin a range
    }
    const m = (k - spot) / spot;
    const callIV = baseIV * (1 + 6 * m * m - 0.6 * m) * (sign > 0 ? 1 + s * 0.03 : 1);
    const putIV = baseIV * (1 + 6 * m * m - 1.2 * m) * (sign < 0 ? 1 + s * 0.04 : 1);
    rows.push({
      strike: k,
      callOI: Math.round(callOI),
      callChg: Math.round(callChg),
      callIV,
      callLTP: bs(spot, k, callIV, t, true),
      putLTP: bs(spot, k, putIV, t, false),
      putIV,
      putChg: Math.round(putChg),
      putOI: Math.round(putOI),
    });
  }
  const totC = rows.reduce((a, x) => a + x.callOI, 0);
  const totP = rows.reduce((a, x) => a + x.putOI, 0);
  let maxPain = atm;
  let best = Infinity;
  for (const cand of rows) {
    let pay = 0;
    for (const x of rows) pay += x.callOI * Math.max(0, cand.strike - x.strike) + x.putOI * Math.max(0, x.strike - cand.strike);
    if (pay < best) {
      best = pay;
      maxPain = cand.strike;
    }
  }
  const callWall = rows.reduce((a, x) => (x.callOI > a.callOI ? x : a), rows[0]).strike;
  const putWall = rows.reduce((a, x) => (x.putOI > a.putOI ? x : a), rows[0]).strike;
  const ivRank = inst.symbol === "INFY" ? 91 : Math.round(18 + r.next() * 38 + (inst.signal.regime === "high-vol" ? 24 : 0));
  const atmRow = rows[6];
  const expiry = new Date(Date.now() + dte * 86400000);
  return {
    rows,
    atm,
    step,
    pcr: totP / totC,
    maxPain,
    ivRank,
    atmIV: (atmRow.callIV + atmRow.putIV) / 2,
    dte,
    expiryLabel: expiry.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }),
    callWall,
    putWall,
    lotNote:
      inst.assetClass === "index"
        ? "OI in contracts; lot sizes vary by exchange and are revised periodically."
        : inst.market === "IN"
          ? "OI in contracts; stock F&O lot sizes vary."
          : "OI in contracts (100 shares each).",
  };
}

/* ---------- OI build-up ---------- */
export type BuildUp = "Long build-up" | "Short build-up" | "Short covering" | "Long unwinding";
export const BUILDUP_EXPLAIN: Record<BuildUp, string> = {
  "Long build-up": "Price up with open interest up: new longs are entering.",
  "Short build-up": "Price down with open interest up: new shorts are entering.",
  "Short covering": "Price up with open interest down: shorts are buying back to exit.",
  "Long unwinding": "Price down with open interest down: longs are taking profit or exiting.",
};
const FUT_OI_OVERRIDE: Record<string, number> = { RELIANCE: 9.0, TCS: 6.4, ETHUSDT: 6.1, BTCUSDT: -4.2 };

/** Futures/perp OI change % for the session (deterministic; sign follows the call). */
export function futuresOIChange(inst: Instrument, price: number): number {
  if (FUT_OI_OVERRIDE[inst.symbol] !== undefined) return FUT_OI_OVERRIDE[inst.symbol];
  const r = rng(`${inst.symbol}:futoi`);
  const up = price >= inst.prevClose;
  const sign = dirSign(inst);
  const mag = 1.5 + r.next() * 5;
  if (sign === 0) return (r.next() < 0.5 ? -1 : 1) * mag * 0.6;
  const oiUp = (sign > 0 && up) || (sign < 0 && !up);
  return (oiUp ? 1 : -1) * mag;
}
export function buildUp(inst: Instrument, price: number): BuildUp {
  const up = price >= inst.prevClose;
  const oiUp = futuresOIChange(inst, price) >= 0;
  if (up && oiUp) return "Long build-up";
  if (!up && oiUp) return "Short build-up";
  if (up && !oiUp) return "Short covering";
  return "Long unwinding";
}

/* ---------- crypto perps ---------- */
export interface CryptoDerivs {
  funding: number; // % per 8h
  fundingNote: string;
  perpOI: number; // USD
  oiChg24h: number; // %
  longShort: number;
  liqClusters: { price: number; usd: number; side: "shorts" | "longs" }[];
  basis: number; // annualised %
}
export function cryptoDerivs(inst: Instrument, price: number): CryptoDerivs {
  const presets: Record<string, Omit<CryptoDerivs, "liqClusters">> = {
    BTCUSDT: { funding: 0.0041, fundingNote: "Neutral after the reset: leverage flushed", perpOI: 38.2e9, oiChg24h: -4.2, longShort: 1.04, basis: 6.8 },
    ETHUSDT: { funding: 0.0312, fundingNote: "Running hot: longs paying up to stay in", perpOI: 21.4e9, oiChg24h: 6.1, longShort: 1.38, basis: 11.9 },
    SOLUSDT: { funding: 0.0118, fundingNote: "Mildly positive, not crowded", perpOI: 5.8e9, oiChg24h: 3.4, longShort: 1.12, basis: 8.2 },
  };
  const p = presets[inst.symbol] ?? presets.BTCUSDT;
  const r = rng(`${inst.symbol}:liq`);
  const sign = dirSign(inst);
  const scale = p.perpOI / 40;
  const liq: CryptoDerivs["liqClusters"] = [];
  for (const pct of [0.015, 0.03, 0.05]) {
    const up = scale * (0.4 + r.next()) * (sign > 0 ? 1.6 : sign < 0 ? 0.7 : 1);
    const dn = scale * (0.4 + r.next()) * (sign < 0 ? 1.6 : sign > 0 ? 0.7 : 1);
    liq.push({ price: price * (1 + pct), usd: up, side: "shorts" });
    liq.push({ price: price * (1 - pct), usd: dn, side: "longs" });
  }
  liq.sort((a, b) => b.price - a.price);
  return { ...p, liqClusters: liq };
}

/* ---------- futures OI + COT-style positioning (FX & commodities) ---------- */
export interface Positioning {
  contract: string;
  venue: string;
  oi: number;
  oiChgPct: number;
  groups: { name: string; net: number; wow: number }[];
  note: string;
  unit: string;
}
export function positioning(inst: Instrument): Positioning {
  switch (inst.symbol) {
    case "EURUSD":
      return {
        contract: "6E Euro FX futures",
        venue: "CME · CFTC COT (simulated)",
        oi: 712_400,
        oiChgPct: 2.6,
        unit: "contracts",
        groups: [
          { name: "Leveraged funds", net: 41_200, wow: 9_800 },
          { name: "Asset managers", net: 156_300, wow: 4_100 },
          { name: "Dealers", net: -172_900, wow: -11_600 },
        ],
        note: "Speculators flipped net long three weeks ago and keep adding.",
      };
    case "USDJPY":
      return {
        contract: "6J Japanese yen futures (long yen = short USDJPY)",
        venue: "CME · CFTC COT (simulated)",
        oi: 248_900,
        oiChgPct: 4.0,
        unit: "contracts",
        groups: [
          { name: "Leveraged funds (yen)", net: 38_400, wow: 12_300 },
          { name: "Asset managers (yen)", net: 61_800, wow: 5_200 },
          { name: "Dealers (yen)", net: -92_700, wow: -15_900 },
        ],
        note: "Funds are building yen longs ahead of the BoJ: positioning supports a lower USDJPY.",
      };
    case "USDINR":
      return {
        contract: "USDINR futures",
        venue: "NSE currency derivatives (simulated)",
        oi: 2_860_000,
        oiChgPct: -1.4,
        unit: "contracts",
        groups: [
          { name: "Foreign portfolio investors", net: -18_200, wow: 1_100 },
          { name: "Proprietary desks", net: 9_400, wow: -2_300 },
          { name: "Clients", net: 8_800, wow: 1_200 },
        ],
        note: "Flat positioning; RBI supply near 88.80 caps the upside.",
      };
    case "XAUUSD":
      return {
        contract: "GC Gold futures",
        venue: "COMEX · CFTC COT (simulated)",
        oi: 512_600,
        oiChgPct: 3.1,
        unit: "contracts",
        groups: [
          { name: "Managed money", net: 182_400, wow: 14_900 },
          { name: "Producers / merchants", net: -215_300, wow: -9_100 },
          { name: "Swap dealers", net: 21_600, wow: -3_400 },
        ],
        note: "Open interest rising with price: trend-following money is adding, not covering.",
      };
    default:
      return {
        contract: "CL WTI crude futures",
        venue: "NYMEX · CFTC COT (simulated)",
        oi: 1_918_000,
        oiChgPct: 1.8,
        unit: "contracts",
        groups: [
          { name: "Managed money", net: 98_300, wow: -14_200 },
          { name: "Producers / merchants", net: -162_800, wow: 6_700 },
          { name: "Swap dealers", net: 41_900, wow: 2_100 },
        ],
        note: "Funds are trimming longs while OI rises: new shorts are leaning on the glut story.",
      };
  }
}
