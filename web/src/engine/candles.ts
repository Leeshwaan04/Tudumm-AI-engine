import { rng } from "./prng";
import type { Instrument } from "./types";
import { isTrade } from "./types";

export const TIMEFRAMES = ["15m", "1H", "4H", "1D", "1W"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const TF_SEC: Record<Timeframe, number> = { "15m": 900, "1H": 3600, "4H": 14400, "1D": 86400, "1W": 604800 };
const TF_DAYS: Record<Timeframe, number> = { "15m": 1 / 26, "1H": 1 / 6.5, "4H": 1 / 1.6, "1D": 1, "1W": 5 };
/** 24-hour markets: a 4H bar is a sixth of a day, a week is seven days. */
const TF_DAYS_24H: Record<Timeframe, number> = { "15m": 1 / 96, "1H": 1 / 24, "4H": 1 / 6, "1D": 1, "1W": 7 };

export interface Candle {
  time: number; // unix seconds (UTC)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const DAILY_VOL_OVERRIDE: Record<string, number> = { NVDA: 0.026, TSLA: 0.034, SOLUSDT: 0.045, ETHUSDT: 0.035, CL: 0.021 };
export function dailyVol(inst: Instrument): number {
  if (DAILY_VOL_OVERRIDE[inst.symbol]) return DAILY_VOL_OVERRIDE[inst.symbol];
  switch (inst.assetClass) {
    case "index":
      return 0.009;
    case "etf":
      return 0.009;
    case "equity":
      return 0.016;
    case "crypto":
      return 0.03;
    case "fx":
      return 0.0045;
    case "commodity":
      return 0.013;
  }
}

const BASE_DAILY_VOLUME: Record<string, number> = { index: 2.4e8, etf: 6.5e7, equity: 9e6, crypto: 2.6e4, fx: 1.8e5, commodity: 2.4e5 };

export function asTimeframe(tf: string | undefined): Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(tf ?? "") ? (tf as Timeframe) : "1D";
}

/** Signed trend bias for the generator from the signal's regime/direction. */
function trendBias(inst: Instrument): number {
  const s = inst.signal;
  const dir = isTrade(s) ? (s.direction === "LONG" ? 1 : -1) : 0;
  switch (s.regime) {
    case "trending-up":
      return 1;
    case "trending-down":
      return -1;
    case "high-vol":
      return dir === 0 ? 0 : dir * 0.7;
    default:
      return 0;
  }
}

/**
 * Deterministic candles (same shape every reload) scaled so the final close equals `anchor`
 * (the live price at generation time).
 */
export function genCandles(inst: Instrument, tf: Timeframe, anchor: number, count = 240, nowMs = Date.now()): Candle[] {
  const r = rng(`${inst.symbol}:candles:${tf}`);
  const days = inst.assetClass === "crypto" ? TF_DAYS_24H[tf] : TF_DAYS[tf];
  const sig = dailyVol(inst) * Math.sqrt(days) * 0.8 * (inst.signal.regime === "high-vol" ? 1.25 : 1);
  const bias = trendBias(inst);
  const range = inst.signal.regime === "range";
  const xs: number[] = [];
  let x = 0;
  let volState = 1;
  for (let i = 0; i < count; i++) {
    const phase = i / count;
    volState = Math.max(0.6, Math.min(1.8, volState + r.normal() * 0.08 + (1 - volState) * 0.1));
    let drift = bias * sig * 0.05 - 0.02 * x * (bias === 0 ? 1 : 0.15);
    // structure: an impulse, a pullback, then continuation into the present
    if (bias !== 0 && phase > 0.55 && phase < 0.72) drift = -bias * sig * 0.1;
    if (bias !== 0 && phase >= 0.72) drift = bias * sig * 0.14;
    if (range) drift = -0.06 * x;
    x += drift + sig * volState * r.normal();
    xs.push(x);
  }
  const offset = Math.log(anchor) - xs[xs.length - 1];
  const tfSec = TF_SEC[tf];
  const lastTime = Math.floor(nowMs / 1000 / tfSec) * tfSec;
  const baseVol = (BASE_DAILY_VOLUME[inst.assetClass] ?? 1e6) * days;
  const d = inst.decimals;
  const round = (v: number) => Math.round(v * 10 ** d) / 10 ** d;
  const out: Candle[] = [];
  let prevClose = Math.exp(xs[0] + offset - sig * r.normal() * 0.5);
  for (let i = 0; i < count; i++) {
    const close = Math.exp(xs[i] + offset);
    const open = prevClose * Math.exp(sig * 0.08 * r.normal());
    const wickU = Math.abs(r.normal()) * sig * 0.45;
    const wickD = Math.abs(r.normal()) * sig * 0.45;
    const high = Math.max(open, close) * Math.exp(wickU);
    const low = Math.min(open, close) * Math.exp(-wickD);
    const ret = Math.abs(Math.log(close / open)) / sig;
    const volume = Math.round(baseVol * Math.exp(0.35 * r.normal()) * (0.7 + 0.45 * ret));
    out.push({ time: lastTime - (count - 1 - i) * tfSec, open: round(open), high: round(high), low: round(low), close: round(close), volume });
    prevClose = close;
  }
  // exact anchor on the last close
  const last = out[out.length - 1];
  last.close = round(anchor);
  last.high = Math.max(last.high, last.close);
  last.low = Math.min(last.low, last.close);
  return out;
}

/** Updates the forming candle with a live price (immutably). */
export function withLivePrice(c: Candle, price: number): Candle {
  return { ...c, close: price, high: Math.max(c.high, price), low: Math.min(c.low, price) };
}
