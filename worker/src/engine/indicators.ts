// Technical indicators (pure). Every series is aligned with its input: index i = value at bar i,
// null until enough history exists. Conventions follow the common definitions (Wilder for RSI/ATR).
import type { Candle } from "./types";

export function sma(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i] as number;
    if (i >= period) sum -= values[i - period] as number;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** EMA seeded with the SMA of the first `period` values. */
export function ema(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period || period < 1) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i] as number;
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = (values[i] as number) * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder RSI. */
export function rsi(closes: readonly number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = (closes[i] as number) - (closes[i - 1] as number);
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = (closes[i] as number) - (closes[i - 1] as number);
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function trueRange(bars: readonly Candle[]): number[] {
  return bars.map((b, i) => {
    if (i === 0) return b.h - b.l;
    const pc = (bars[i - 1] as Candle).c;
    return Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
  });
}

/** Wilder ATR. */
export function atr(bars: readonly Candle[], period = 14): (number | null)[] {
  const tr = trueRange(bars);
  const out: (number | null)[] = new Array(bars.length).fill(null);
  if (bars.length < period) return out;
  let a = 0;
  for (let i = 0; i < period; i++) a += tr[i] as number;
  a /= period;
  out[period - 1] = a;
  for (let i = period; i < bars.length; i++) {
    a = (a * (period - 1) + (tr[i] as number)) / period;
    out[i] = a;
  }
  return out;
}

export interface MacdPoint {
  macd: number | null;
  signal: number | null;
  hist: number | null;
}

export function macd(closes: readonly number[], fast = 12, slow = 26, signalPeriod = 9): MacdPoint[] {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line: (number | null)[] = closes.map((_, i) => {
    const a = ef[i];
    const b = es[i];
    return a === null || a === undefined || b === null || b === undefined ? null : a - b;
  });
  const firstIdx = line.findIndex((v) => v !== null);
  const sig: (number | null)[] = new Array(closes.length).fill(null);
  if (firstIdx >= 0) {
    const compact = line.slice(firstIdx) as number[];
    const e = ema(compact, signalPeriod);
    for (let i = 0; i < e.length; i++) sig[firstIdx + i] = e[i] ?? null;
  }
  return line.map((m, i) => {
    const s = sig[i] ?? null;
    return { macd: m, signal: s, hist: m === null || s === null ? null : m - s };
  });
}

export interface SupertrendPoint {
  value: number | null;
  dir: 1 | -1 | null; // 1 = uptrend (price above the band)
}

/** Supertrend (ATR period, multiplier) with the standard band-ratchet rules. */
export function supertrend(bars: readonly Candle[], period = 10, mult = 3): SupertrendPoint[] {
  const a = atr(bars, period);
  const out: SupertrendPoint[] = bars.map(() => ({ value: null, dir: null }));
  let upper = 0;
  let lower = 0;
  let dir: 1 | -1 = 1;
  let started = false;
  for (let i = 0; i < bars.length; i++) {
    const at = a[i];
    const b = bars[i] as Candle;
    if (at === null || at === undefined) continue;
    const mid = (b.h + b.l) / 2;
    const bu = mid + mult * at;
    const bl = mid - mult * at;
    if (!started) {
      upper = bu;
      lower = bl;
      dir = b.c >= mid ? 1 : -1;
      started = true;
    } else {
      const pc = (bars[i - 1] as Candle).c;
      upper = bu < upper || pc > upper ? bu : upper;
      lower = bl > lower || pc < lower ? bl : lower;
      if (dir === 1 && b.c < lower) dir = -1;
      else if (dir === -1 && b.c > upper) dir = 1;
    }
    out[i] = { value: dir === 1 ? lower : upper, dir };
  }
  return out;
}

/** Session VWAP for intraday bars: resets at each UTC day (or at `sessionOffsetSec` past midnight UTC). */
export function vwap(bars: readonly Candle[], sessionOffsetSec = 0): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  let day = -1;
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i] as Candle;
    const d = Math.floor((b.t - sessionOffsetSec) / 86400);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    const tp = (b.h + b.l + b.c) / 3;
    pv += tp * b.v;
    vol += b.v;
    out[i] = vol > 0 ? pv / vol : null;
  }
  return out;
}

export interface DonchianPoint {
  upper: number | null;
  lower: number | null;
}

/** Donchian channel of the PRIOR `period` bars (excludes bar i, so "close > upper" is a breakout). */
export function donchian(bars: readonly Candle[], period = 20): DonchianPoint[] {
  return bars.map((_, i) => {
    if (i < period) return { upper: null, lower: null };
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period; j < i; j++) {
      const b = bars[j] as Candle;
      if (b.h > hi) hi = b.h;
      if (b.l < lo) lo = b.l;
    }
    return { upper: hi, lower: lo };
  });
}

/** Average volume of the last `short` bars divided by the last `long` bars (null if no volume). */
export function volumeRatio(bars: readonly Candle[], short = 5, long = 20): number | null {
  if (bars.length < long) return null;
  let s = 0;
  let l = 0;
  for (let i = bars.length - long; i < bars.length; i++) {
    const v = (bars[i] as Candle).v;
    l += v;
    if (i >= bars.length - short) s += v;
  }
  if (l <= 0) return null;
  return s / short / (l / long);
}

export interface SwingLevel {
  i: number;
  t: number;
  price: number;
}

/** Fractal swing highs/lows: bar i is a swing high if its high is the max of [i-k, i+k]. */
export function swingLevels(bars: readonly Candle[], k = 2, lookback = 60): { highs: SwingLevel[]; lows: SwingLevel[] } {
  const highs: SwingLevel[] = [];
  const lows: SwingLevel[] = [];
  const start = Math.max(k, bars.length - lookback);
  for (let i = start; i < bars.length - k; i++) {
    const b = bars[i] as Candle;
    let isH = true;
    let isL = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      const o = bars[j] as Candle;
      if (o.h >= b.h) isH = false;
      if (o.l <= b.l) isL = false;
    }
    if (isH) highs.push({ i, t: b.t, price: b.h });
    if (isL) lows.push({ i, t: b.t, price: b.l });
  }
  return { highs, lows };
}

/** Up-volume share over the last n bars (volume on up-closes / volume on up+down closes). */
export function upVolumeShare(bars: readonly Candle[], n = 10): number | null {
  if (bars.length < n + 1) return null;
  let up = 0;
  let dn = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const b = bars[i] as Candle;
    const p = bars[i - 1] as Candle;
    if (b.c > p.c) up += b.v;
    else if (b.c < p.c) dn += b.v;
  }
  if (up + dn <= 0) return null;
  return up / (up + dn);
}
