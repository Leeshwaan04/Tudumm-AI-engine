import type { Candle } from "./candles";

export function ema(values: number[], n: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < n) return out;
  const k = 2 / (n + 1);
  let prev = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = prev;
  for (let i = n; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rsi(closes: number[], n = 14): number {
  if (closes.length <= n) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(0, d)) / n;
    loss = (loss * (n - 1) + Math.max(0, -d)) / n;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

export function macd(closes: number[]) {
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const line = closes.map((_, i) => e12[i] - e26[i]);
  const valid = line.filter((v) => !Number.isNaN(v));
  const sig = ema(valid, 9);
  const m = valid[valid.length - 1] ?? 0;
  const s = sig[sig.length - 1] ?? 0;
  return { macd: m, signal: s, hist: m - s };
}

export function atrSeries(c: Candle[], n = 14): number[] {
  const tr = c.map((k, i) =>
    i === 0 ? k.high - k.low : Math.max(k.high - k.low, Math.abs(k.high - c[i - 1].close), Math.abs(k.low - c[i - 1].close)),
  );
  const out = new Array<number>(c.length).fill(NaN);
  if (c.length < n) return out;
  let a = tr.slice(0, n).reduce((x, y) => x + y, 0) / n;
  out[n - 1] = a;
  for (let i = n; i < c.length; i++) {
    a = (a * (n - 1) + tr[i]) / n;
    out[i] = a;
  }
  return out;
}

export function supertrend(c: Candle[], n = 10, mult = 3): { dir: 1 | -1; value: number; flippedBarsAgo: number } {
  const atr = atrSeries(c, n);
  let dir: 1 | -1 = 1;
  let upper = NaN;
  let lower = NaN;
  let lastFlip = 0;
  for (let i = n; i < c.length; i++) {
    const hl2 = (c[i].high + c[i].low) / 2;
    const bu = hl2 + mult * atr[i];
    const bl = hl2 - mult * atr[i];
    upper = Number.isNaN(upper) || bu < upper || c[i - 1].close > upper ? bu : upper;
    lower = Number.isNaN(lower) || bl > lower || c[i - 1].close < lower ? bl : lower;
    const prevDir: 1 | -1 = dir;
    if (c[i].close > upper) dir = 1;
    else if (c[i].close < lower) dir = -1;
    if (dir !== prevDir) lastFlip = i;
  }
  return { dir, value: dir === 1 ? lower : upper, flippedBarsAgo: c.length - 1 - lastFlip };
}

export function vwap(c: Candle[], bars: number): number {
  const slice = c.slice(-bars);
  let pv = 0;
  let v = 0;
  for (const k of slice) {
    const tp = (k.high + k.low + k.close) / 3;
    pv += tp * k.volume;
    v += k.volume;
  }
  return v ? pv / v : c[c.length - 1]?.close ?? 0;
}

/** Nearest swing support / resistance levels from pivot highs and lows. */
export function keyLevels(c: Candle[], price: number, atr: number): { supports: number[]; resistances: number[] } {
  const w = 3;
  const highs: number[] = [];
  const lows: number[] = [];
  const start = Math.max(w, c.length - 160);
  for (let i = start; i < c.length - w; i++) {
    let isH = true;
    let isL = true;
    for (let j = 1; j <= w; j++) {
      if (c[i].high < c[i - j].high || c[i].high < c[i + j].high) isH = false;
      if (c[i].low > c[i - j].low || c[i].low > c[i + j].low) isL = false;
    }
    if (isH) highs.push(c[i].high);
    if (isL) lows.push(c[i].low);
  }
  const dedupe = (arr: number[]) => {
    const out: number[] = [];
    for (const v of arr) if (!out.some((o) => Math.abs(o - v) < atr * 0.6)) out.push(v);
    return out;
  };
  const resistances = dedupe([...highs, ...lows].filter((v) => v > price + atr * 0.15).sort((a, b) => a - b)).slice(0, 3);
  const supports = dedupe([...highs, ...lows].filter((v) => v < price - atr * 0.15).sort((a, b) => b - a)).slice(0, 3);
  return { supports, resistances };
}

export interface PriceIndicators {
  rsi: number;
  macd: { macd: number; signal: number; hist: number };
  ema20: number;
  ema50: number;
  ema200: number;
  atr: number;
  supertrend: { dir: 1 | -1; value: number; flippedBarsAgo: number };
  vwap: number;
  vwapBars: number;
  levels: { supports: number[]; resistances: number[] };
  price: number;
}

export function priceIndicators(c: Candle[], vwapBars: number): PriceIndicators {
  const closes = c.map((k) => k.close);
  const last = (a: number[]) => a[a.length - 1];
  const price = last(closes);
  const atr = last(atrSeries(c, 14));
  return {
    rsi: rsi(closes, 14),
    macd: macd(closes),
    ema20: last(ema(closes, 20)),
    ema50: last(ema(closes, 50)),
    ema200: last(ema(closes, 200)),
    atr,
    supertrend: supertrend(c),
    vwap: vwap(c, vwapBars),
    vwapBars,
    levels: keyLevels(c, price, atr),
    price,
  };
}
