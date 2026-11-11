// Layer scorers (pure). Each returns a score in -100..100 TOWARD the candidate direction
// (positive = the layer agrees with the call) and a sentence with the real numbers behind it.
// A layer with no data returns score:null and the reason. These rules are v0 and UNCALIBRATED.
import type {
  Candle,
  ChainSummaryInput,
  ContextInput,
  DepthInput,
  FundamentalsInput,
  FuturesBuildUpInput,
  IndicatorSnapshot,
  LayerResult,
  PerpInput,
  BuildUpClass,
} from "./types";
import { atr, donchian, ema, macd, rsi, supertrend, upVolumeShare, volumeRatio } from "./indicators";
import { bookImbalance } from "./orderbook";
import { BUILDUP_LABEL } from "./options";
import { clamp, fmt, pct } from "./util";

export interface Series {
  closes: number[];
  ema20: (number | null)[];
  ema50: (number | null)[];
  ema200: (number | null)[];
  rsi: (number | null)[];
  macdHist: (number | null)[];
  atr: (number | null)[];
  stDir: (1 | -1 | null)[];
  donHigh: (number | null)[];
  donLow: (number | null)[];
}

export function computeSeries(bars: readonly Candle[]): Series {
  const closes = bars.map((b) => b.c);
  const m = macd(closes);
  const st = supertrend(bars, 10, 3);
  const dc = donchian(bars, 20);
  return {
    closes,
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    rsi: rsi(closes, 14),
    macdHist: m.map((x) => x.hist),
    atr: atr(bars, 14),
    stDir: st.map((x) => x.dir),
    donHigh: dc.map((x) => x.upper),
    donLow: dc.map((x) => x.lower),
  };
}

export function snapshot(bars: readonly Candle[], s: Series): IndicatorSnapshot {
  const i = bars.length - 1;
  const close = s.closes[i] ?? NaN;
  const a = s.atr[i] ?? null;
  return {
    close,
    ema20: s.ema20[i] ?? null,
    ema50: s.ema50[i] ?? null,
    ema200: s.ema200[i] ?? null,
    rsi: s.rsi[i] ?? null,
    macdHist: s.macdHist[i] ?? null,
    atr: a,
    atrPct: a !== null && close > 0 ? (a / close) * 100 : null,
    supertrendDir: s.stDir[i] ?? null,
    donchianHigh: s.donHigh[i] ?? null,
    donchianLow: s.donLow[i] ?? null,
    volumeRatio: volumeRatio(bars, 5, 20),
  };
}

/* ---------------- price & structure ---------------- */
export function scorePrice(bars: readonly Candle[], s: Series, d: 1 | -1, decimals: number): LayerResult {
  const i = bars.length - 1;
  const close = s.closes[i] as number;
  const e20 = s.ema20[i] ?? null;
  const e50 = s.ema50[i] ?? null;
  const e200 = s.ema200[i] ?? null;
  const a = s.atr[i] ?? null;
  const r = s.rsi[i] ?? null;
  const h = s.macdHist[i] ?? null;
  if (e20 === null || e50 === null || a === null || r === null) return { score: null, note: "Not enough bars for the 20/50-EMA, ATR and RSI yet." };
  let sc = 0;
  let stack: string;
  if (e200 !== null) {
    const full = d > 0 ? e20 > e50 && e50 > e200 : e20 < e50 && e50 < e200;
    const opp = d > 0 ? e20 < e50 && e50 < e200 : e20 > e50 && e50 > e200;
    sc += full ? 30 : opp ? -30 : d * (e20 - e50) > 0 ? 10 : -10;
    stack = full ? (d > 0 ? "20>50>200 EMA stack" : "20<50<200 EMA stack") : opp ? "EMA stack against the call" : "mixed EMA stack";
  } else {
    sc += d * (e20 - e50) > 0 ? 20 : -20;
    stack = "20/50-EMA only (under 200 bars)";
  }
  const distAtr = ((close - e50) / a) * d;
  sc += clamp(distAtr * 8, -25, 20);
  const e50Prev = s.ema50[i - 10] ?? null;
  const rising = e50Prev !== null ? e50 > e50Prev : null;
  if (e50Prev !== null) sc += clamp((((e50 - e50Prev) / a) * d) * 5, -10, 10);
  sc += clamp((r - 50) * d, -20, 20);
  if (d > 0 && r > 75) sc -= 10;
  if (d < 0 && r < 25) sc -= 10;
  if (h !== null) sc += h * d > 0 ? 10 : -10;
  const st = s.stDir[i] ?? null;
  if (st !== null) sc += st === d ? 10 : -10;
  const dh = s.donHigh[i] ?? null;
  const dl = s.donLow[i] ?? null;
  const breakout = d > 0 ? dh !== null && close > dh : dl !== null && close < dl;
  if (breakout) sc += 5;
  const gap = ((close - e50) / e50) * 100;
  const slope = rising === null ? "" : rising ? "rising " : "falling ";
  const note =
    `Price ${Math.abs(gap).toFixed(1)}% ${gap >= 0 ? "above" : "below"} a ${slope}50-EMA (${fmt(e50, decimals)}), ${stack}; ` +
    `RSI ${r.toFixed(0)}, MACD histogram ${h === null ? "n/a" : h >= 0 ? "positive" : "negative"}` +
    (breakout ? `, fresh 20-bar ${d > 0 ? "high" : "low"}` : "") +
    ".";
  return { score: Math.round(clamp(sc, -100, 100)), note };
}

/* ---------------- order flow ---------------- */
export function scoreFlowBook(bars: readonly Candle[], depth: DepthInput | null | undefined, d: 1 | -1): LayerResult {
  let sc = 0;
  const parts: string[] = [];
  let have = false;
  if (depth) {
    const im = bookImbalance(depth.bids, depth.asks, 1);
    if (im && im.ratio !== null) {
      have = true;
      sc += clamp(im.imbalance * d * 80, -40, 40);
      parts.push(
        im.ratio >= 1
          ? `${depth.venue} bids ${im.ratio.toFixed(2)}× asks within 1% of mid`
          : `${depth.venue} asks ${(1 / im.ratio).toFixed(2)}× bids within 1% of mid`,
      );
    }
  }
  const n = Math.min(6, bars.length);
  if (n >= 3 && bars.slice(-n).every((b) => b.tb !== undefined)) {
    let tb = 0;
    let v = 0;
    for (const b of bars.slice(-n)) {
      tb += b.tb as number;
      v += b.v;
    }
    if (v > 0) {
      have = true;
      const share = tb / v;
      sc += clamp((share - 0.5) * d * 400, -30, 30);
      parts.push(`taker buys ${(share * 100).toFixed(0)}% of volume over ${n} bars`);
    }
  }
  const vr = volumeRatio(bars, 5, 20);
  if (vr !== null && bars.length > 6) {
    const move = (bars[bars.length - 1] as Candle).c - (bars[bars.length - 6] as Candle).c;
    if (vr > 1.2) {
      sc += Math.sign(move) === d ? 15 : -15;
      parts.push(`volume ${vr.toFixed(1)}× its 20-bar average`);
    }
  }
  if (!have) return { score: null, note: "Order book and taker-volume data are unavailable right now." };
  return { score: Math.round(clamp(sc, -100, 100)), note: cap(parts.join("; ")) + "." };
}

export function scoreFlowVolume(bars: readonly Candle[], d: 1 | -1, label: string): LayerResult {
  const share = upVolumeShare(bars, 10);
  if (share === null) return { score: null, note: "No volume data for this instrument." };
  let sc = clamp((share - 0.5) * d * 160, -40, 40);
  const parts = [`up-day volume ${(share * 100).toFixed(0)}% of the last 10 sessions`];
  const vr = volumeRatio(bars, 5, 20);
  if (vr !== null && bars.length > 6) {
    const move = (bars[bars.length - 1] as Candle).c - (bars[bars.length - 6] as Candle).c;
    if (vr > 1.15) {
      sc += Math.sign(move) === d ? 15 : -15;
      parts.push(`volume ${vr.toFixed(1)}× its 20-day average`);
    } else if (vr < 0.8) parts.push(`volume light at ${vr.toFixed(1)}× average`);
  }
  // On-balance volume trend over 20 bars
  if (bars.length > 21) {
    let obv = 0;
    let obv20 = 0;
    for (let i = bars.length - 20; i < bars.length; i++) {
      const b = bars[i] as Candle;
      const p = bars[i - 1] as Candle;
      obv += b.c > p.c ? b.v : b.c < p.c ? -b.v : 0;
      if (i === bars.length - 11) obv20 = obv;
    }
    if (obv !== 0) sc += Math.sign(obv - obv20) === d ? 10 : -10;
  }
  return { score: Math.round(clamp(sc, -100, 100)), note: cap(parts.join("; ")) + ` (${label}).` };
}

/* ---------------- derivatives ---------------- */
/** Funding (fraction per interval) read toward direction d: [score delta, words]. */
export function fundingRead(f: number, d: 1 | -1): [number, string] {
  if (d > 0) {
    if (f > 0.0003) return [-25, "running hot: longs are crowded"];
    if (f < 0) return [20, "negative: shorts are paying"];
    if (f <= 0.0001) return [10, "neutral, leverage not crowded"];
    return [0, "mildly positive"];
  }
  if (f < -0.0003) return [-25, "deeply negative: shorts are crowded"];
  if (f > 0.0002) return [20, "positive: longs are paying to stay in"];
  if (Math.abs(f) <= 0.0001) return [5, "neutral"];
  return [0, f > 0 ? "mildly positive" : "mildly negative"];
}

function buildUpScore(c: BuildUpClass, d: 1 | -1): number {
  const long: Record<BuildUpClass, number> = { long_buildup: 35, short_covering: 15, short_buildup: -35, long_unwinding: -15, flat: 0 };
  const short: Record<BuildUpClass, number> = { short_buildup: 35, long_unwinding: 15, long_buildup: -35, short_covering: -15, flat: 0 };
  return d > 0 ? long[c] : short[c];
}

export function scorePerp(perp: PerpInput | null | undefined, d: 1 | -1, cls: BuildUpClass | null): LayerResult {
  if (!perp || (perp.fundingRate === null && perp.oiChange24hPct === null)) return { score: null, note: "Perpetual funding and open interest are unavailable from Binance and Bybit right now." };
  let sc = 0;
  const parts: string[] = [];
  const f = perp.fundingRate;
  if (f !== null) {
    const fp = f * 100;
    const [delta, w] = fundingRead(f, d);
    sc += delta;
    parts.push(`funding ${w} at ${fp.toFixed(4)}%/${perp.fundingIntervalHours}h`);
  }
  if (cls && perp.oiChange24hPct !== null && perp.priceChange24hPct !== null) {
    sc += buildUpScore(cls, d) * (30 / 35);
    parts.push(`perp OI ${pct(perp.oiChange24hPct)} with price ${pct(perp.priceChange24hPct)} in 24h (${BUILDUP_LABEL[cls].toLowerCase()})`);
  }
  return { score: Math.round(clamp(sc, -100, 100)), note: cap(parts.join("; ")) + ` (${perp.venue}).` };
}

export function scoreChain(
  chain: ChainSummaryInput | null | undefined,
  futures: FuturesBuildUpInput | null | undefined,
  d: 1 | -1,
  close: number,
  atrV: number | null,
  decimals: number,
): LayerResult {
  if (!chain && !futures) return { score: null, note: "No option-chain or futures snapshot yet." };
  let sc = 0;
  const parts: string[] = [];
  if (futures) {
    sc += buildUpScore(futures.class, d);
    parts.push(`futures ${BUILDUP_LABEL[futures.class].toLowerCase()} (price ${pct(futures.priceChangePct)}, OI ${pct(futures.oiChangePct)})`);
  }
  if (chain) {
    if (chain.pcr !== null) {
      if (chain.convention === "india") {
        // NSE convention: option WRITERS dominate, so a high put/call OI means put writing = support.
        sc += clamp((chain.pcr - 1) * 50, -25, 25) * d;
      } else {
        // US convention: more call OI than put OI reads as bullish positioning.
        sc += clamp((0.9 - chain.pcr) * 40, -20, 20) * d;
      }
      parts.push(`PCR ${chain.pcr.toFixed(2)}`);
    }
    if (chain.convention === "us" && chain.pcrVolume !== null) {
      sc += clamp((0.9 - chain.pcrVolume) * 40, -20, 20) * d;
      parts.push(`volume P/C ${chain.pcrVolume.toFixed(2)}`);
    }
    if (chain.convention === "us" && chain.skew !== null) {
      sc += clamp((4 - chain.skew) * 3, -15, 15) * d;
      parts.push(`put skew ${chain.skew.toFixed(1)} vol pts`);
    }
    if (chain.callDOI !== null && chain.putDOI !== null) {
      const tot = Math.abs(chain.callDOI) + Math.abs(chain.putDOI);
      if (tot > 0) {
        // Writers add OI at the side they think won't be reached: put adds = support (India); for the US
        // we read it as positioning (call adds = bullish). Same sign either way for v0.
        const x = chain.convention === "india" ? (chain.putDOI - chain.callDOI) / tot : (chain.callDOI - chain.putDOI) / tot;
        sc += clamp(x * 20, -20, 20) * d;
      }
    }
    if (atrV !== null) {
      if (d > 0 && chain.callWall !== null && chain.callWall > close && chain.callWall - close < atrV) {
        sc -= 10;
        parts.push(`call wall ${fmt(chain.callWall, decimals)} is less than 1 ATR overhead`);
      } else if (d < 0 && chain.putWall !== null && chain.putWall < close && close - chain.putWall < atrV) {
        sc -= 10;
        parts.push(`put wall ${fmt(chain.putWall, decimals)} is less than 1 ATR below`);
      } else if (d > 0 && chain.putWall !== null) parts.push(`biggest put wall ${fmt(chain.putWall, decimals)}`);
      else if (d < 0 && chain.callWall !== null) parts.push(`biggest call wall ${fmt(chain.callWall, decimals)}`);
    }
  }
  return { score: Math.round(clamp(sc, -100, 100)), note: cap(parts.join("; ")) + (chain ? ` (expiry ${chain.expiry}).` : ".") };
}

/* ---------------- fundamentals ---------------- */
export function scoreFundamentals(f: FundamentalsInput | null | undefined, d: 1 | -1): LayerResult {
  if (!f) return { score: null, note: "No fundamentals snapshot yet." };
  let raw = 0;
  const parts: string[] = [];
  if (f.kind === "index") {
    if (f.pePercentile1y === null || f.pePercentile1y === undefined || f.pe === null || f.pe === undefined) return { score: null, note: "Index valuation history is too short." };
    raw = clamp((50 - f.pePercentile1y) * 0.6, -30, 30);
    parts.push(`P/E ${f.pe.toFixed(1)} sits at the ${f.pePercentile1y}th percentile of the past year`);
  } else {
    const g = f.revenueGrowthPct ?? null;
    const nm = f.netMarginPct ?? null;
    const eg = f.epsGrowthPct ?? null;
    const pe = f.pe ?? null;
    if (g === null && nm === null && pe === null) return { score: null, note: "SEC filings lack the revenue/income tags we read." };
    if (g !== null) {
      raw += g > 20 ? 30 : g > 8 ? 15 : g > 0 ? 5 : -20;
      parts.push(`revenue ${pct(g)} TTM`);
    }
    if (nm !== null) {
      raw += nm > 20 ? 15 : nm > 8 ? 5 : nm < 0 ? -25 : 0;
      parts.push(`net margin ${nm.toFixed(0)}%`);
    }
    if (eg !== null) {
      raw += eg > 15 ? 15 : eg > 0 ? 5 : -15;
      parts.push(`EPS ${pct(eg)}`);
    }
    if (pe !== null) {
      raw += pe <= 0 ? -10 : pe > 80 ? -20 : pe > 45 ? -10 : pe < 20 ? 10 : 0;
      parts.push(pe > 0 ? `P/E ${pe.toFixed(0)}` : "loss-making (no P/E)");
    }
  }
  return { score: Math.round(clamp(raw * d, -100, 100)), note: cap(parts.join(", ")) + ` (${f.label}).` };
}

/* ---------------- context & sentiment ---------------- */
export function scoreContext(c: ContextInput | null | undefined, d: 1 | -1): LayerResult {
  if (!c) return { score: null, note: "No free sentiment or macro input for this instrument yet." };
  let rawLong = 0;
  const parts: string[] = [];
  let have = false;
  if (c.fearGreed) {
    have = true;
    const v = c.fearGreed.value;
    // v0 reads Fear & Greed as CONTRARIAN: fear supports longs, greed supports shorts.
    rawLong += clamp((50 - v) * 0.8, -30, 30);
    parts.push(`Crypto Fear & Greed ${v}${c.fearGreed.prev !== null ? ` (yesterday ${c.fearGreed.prev})` : ""}`);
  }
  if (c.vix) {
    have = true;
    const v = c.vix.value;
    const calm = c.vix.calm;
    const el = c.vix.elevated;
    rawLong += v < calm ? 20 : v < (calm + el) / 2 ? 10 : v < el ? -5 : v < el * 1.25 ? -20 : -30;
    if (c.vix.change5dPct !== null) {
      if (c.vix.change5dPct < -10) rawLong += 10;
      else if (c.vix.change5dPct > 15) rawLong -= 10;
    }
    parts.push(`${c.vix.label} ${v.toFixed(2)}${c.vix.change5dPct !== null ? ` (${pct(c.vix.change5dPct, 0)} over 5 sessions)` : ""}`);
  }
  if (c.benchmark) {
    have = true;
    const up = c.benchmark.aboveEma200 && c.benchmark.ema50Rising;
    const dn = !c.benchmark.aboveEma200 && !c.benchmark.ema50Rising;
    rawLong += up ? 15 : dn ? -15 : 0;
    parts.push(`${c.benchmark.symbol} ${up ? "in an uptrend" : dn ? "in a downtrend" : "mixed"} (${c.benchmark.aboveEma200 ? "above" : "below"} its 200-EMA)`);
  }
  if (c.usdTrend) {
    have = true;
    const ch = c.usdTrend.eurusdChange20dPct;
    rawLong += clamp(ch * 20, -30, 30); // EURUSD up = USD weaker = supportive for gold
    parts.push(`USD ${ch >= 0 ? "weaker" : "stronger"} vs EUR over 20 sessions (EURUSD ${pct(ch)})`);
  }
  if (!have) return { score: null, note: "No free sentiment or macro input for this instrument yet." };
  return { score: Math.round(clamp(rawLong * d, -100, 100)), note: cap(parts.join("; ")) + "." };
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
