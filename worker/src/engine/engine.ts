// Engine v0 — rule-based, UNCALIBRATED. Pure: evaluate(input) -> EngineView. No I/O.
//
// 1. Candidate direction = trend (EMA 20/50 vs price, 200 for the stack) confirmed by momentum (RSI, MACD).
// 2. Score 5 layers toward the candidate (-100..100, null = no data + reason).
// 3. Sit out unless >= 3 non-null layers agree (score >= 15), data is fresh and no event-risk flag.
// 4. Levels from ATR: entry = close ± 0.25 ATR (or a pending pullback to the 20-EMA when price is
//    extended > 1.5 ATR), stop = 1.5 ATR (or just beyond the nearest swing if tighter but >= 1 ATR),
//    T1 = 1.5R, T2 = 2.5R.
// 5. Confidence = clamp(0.50 + 0.25 * mean(agreeing scores)/100 - 0.05 * disagreeing layers, 0.50, 0.78).
//    It is a heuristic, NOT a probability: calibrated:false everywhere.
import type { Candle, Direction, EngineInput, EngineView, LayerId, LayerResult, Levels, Regime, SitOutReason } from "./types";
import { AGREE, LAYER_IDS } from "./types";
import { swingLevels } from "./indicators";
import { classifyBuildUp } from "./options";
import { computeSeries, scoreChain, scoreContext, scoreFlowBook, scoreFlowVolume, scoreFundamentals, scorePerp, scorePrice, snapshot } from "./layers";
import { clamp, fmt, levelDecimals, median, roundTo } from "./util";

export const MIN_BARS = 60;

const TF_WORD: Record<string, string> = { "4H": "4-hour", "1D": "daily" };

export function strategyFor(pending: boolean): { key: string; label: string } {
  return pending ? { key: "ema20_pullback", label: "Pullback to 20-EMA (v0)" } : { key: "trend_continuation", label: "Trend continuation (v0)" };
}

function emptyLayers(): Record<LayerId, number | null> {
  return { price: null, flow: null, derivatives: null, fundamentals: null, context: null };
}

function baseView(input: EngineInput): EngineView {
  return {
    engine: "v0",
    calibrated: false,
    symbol: input.symbol,
    decision: "sit_out",
    sitOutReason: null,
    direction: null,
    candidate: null,
    regime: "range",
    style: input.style,
    timeframe: input.tf,
    layers: emptyLayers(),
    layerNotes: {},
    layerDetail: { price: "", flow: "", derivatives: "", fundamentals: "", context: "" },
    agree: 0,
    disagree: 0,
    applicable: 0,
    confidence: null,
    thesis: "",
    invalidation: null,
    levels: null,
    strategy: null,
    strategyLabel: null,
    barT: input.bars.length ? (input.bars[input.bars.length - 1] as Candle).t : null,
    indicators: null,
    eventRisk: { checked: false, flag: false, note: "No free earnings/events calendar is wired yet — check the calendar before acting." },
  };
}

function sitOut(v: EngineView, reason: SitOutReason, thesis: string): EngineView {
  v.decision = "sit_out";
  v.sitOutReason = reason;
  v.direction = null;
  v.confidence = null;
  v.levels = null;
  v.strategy = null;
  v.strategyLabel = null;
  v.invalidation = null;
  v.thesis = thesis;
  return v;
}

function ageWords(sec: number): string {
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 172800) return `${Math.round(sec / 3600)} h`;
  return `${Math.round(sec / 86400)} days`;
}

export function evaluate(input: EngineInput): EngineView {
  const v = baseView(input);
  const bars = input.bars;
  const dec = input.decimals;
  if (!bars.length) return sitOut(v, "no_data", "No market data has been ingested for this instrument yet.");
  const lastBar = bars[bars.length - 1] as Candle;
  const ageSec = input.nowSec - (lastBar.t + input.tfSec);
  if (bars.length < MIN_BARS) {
    fillNaLayers(v, input);
    return sitOut(v, "insufficient_history", `Only ${bars.length} ${input.tf} bars of history so far; the engine needs at least ${MIN_BARS}.`);
  }

  const s = computeSeries(bars);
  const snap = snapshot(bars, s);
  v.indicators = roundSnapshot(snap, dec);
  const { close, ema20: e20, ema50: e50, rsi: r, macdHist: h, atr: a } = snap;
  if (e20 === null || e50 === null || r === null || a === null || h === null) {
    fillNaLayers(v, input);
    return sitOut(v, "insufficient_history", "Indicators are still warming up.");
  }

  // ---- candidate direction
  const trend: 1 | -1 | 0 = close > e50 && e20 > e50 ? 1 : close < e50 && e20 < e50 ? -1 : 0;
  const mom: 1 | -1 | 0 = r > 50 && h > 0 ? 1 : r < 50 && h < 0 ? -1 : 0;
  const lean: 1 | -1 = trend !== 0 ? trend : close >= e50 ? 1 : -1;
  const candidate: Direction | null = trend === 0 || mom === -trend ? null : trend > 0 ? "LONG" : "SHORT";
  v.candidate = candidate;
  v.regime = regimeOf(s.atr, s.closes, snap, trend);

  // ---- layers (scored toward the candidate, or toward the lean when there's no candidate)
  const d = lean;
  const res: Record<LayerId, LayerResult> = {
    price: scorePrice(bars, s, d, dec),
    flow:
      input.flowMode === "book"
        ? scoreFlowBook(bars, input.depth, d)
        : input.flowMode === "volume"
          ? scoreFlowVolume(bars, d, `EOD volume proxy from ${input.venueLabel}; no tape on free data`)
          : { score: null, note: input.naReasons?.flow ?? "No order-flow data on free sources." },
    derivatives: input.perp
      ? scorePerp(input.perp, d, input.perp.oiChange24hPct !== null && input.perp.priceChange24hPct !== null ? classifyBuildUp(input.perp.priceChange24hPct, input.perp.oiChange24hPct) : null)
      : input.chain || input.futures
        ? scoreChain(input.chain, input.futures, d, close, a, dec)
        : { score: null, note: input.naReasons?.derivatives ?? "No derivatives snapshot yet." },
    fundamentals: input.fundamentals ? scoreFundamentals(input.fundamentals, d) : { score: null, note: input.naReasons?.fundamentals ?? "No fundamentals snapshot yet." },
    context: input.context ? scoreContext(input.context, d) : { score: null, note: input.naReasons?.context ?? "No free sentiment or macro input yet." },
  };
  for (const id of LAYER_IDS) {
    const lr = res[id];
    // a fixed "not applicable" reason wins over a generic "no data" one
    if (lr.score === null && input.naReasons?.[id]) lr.note = input.naReasons[id] as string;
    v.layers[id] = lr.score;
    v.layerDetail[id] = lr.note;
    if (lr.score === null) v.layerNotes[id] = lr.note;
  }
  const scored = LAYER_IDS.filter((id) => v.layers[id] !== null);
  const agreeing = scored.filter((id) => (v.layers[id] as number) >= AGREE);
  const disagreeing = scored.filter((id) => (v.layers[id] as number) <= -AGREE);
  v.applicable = scored.length;
  v.agree = agreeing.length;
  v.disagree = disagreeing.length;

  // ---- gates
  if (ageSec > input.staleAfterSec) {
    return sitOut(v, "stale_data", `Data is stale: the last ${input.venueLabel} ${input.tf} bar closed ${ageWords(ageSec)} ago. No call on stale data.`);
  }
  if (trend === 0) {
    return sitOut(
      v,
      "no_trend",
      `No trend to follow: price ${fmt(close, dec)} is caught between the 20-EMA (${fmt(e20, dec)}) and 50-EMA (${fmt(e50, dec)}), RSI ${r.toFixed(0)}. Sitting out until structure resolves.`,
    );
  }
  if (!candidate) {
    return sitOut(
      v,
      "momentum_conflict",
      `The trend points ${trend > 0 ? "up" : "down"} but momentum disagrees (RSI ${r.toFixed(0)}, MACD histogram ${h >= 0 ? "positive" : "negative"}). Sitting out.`,
    );
  }
  if (v.eventRisk.flag) return sitOut(v, "event_risk", `Event risk: ${v.eventRisk.note}`);
  if (agreeing.length < 3) {
    const list = scored.map((id) => `${id} ${fmtScore(v.layers[id] as number)}`).join(", ");
    return sitOut(
      v,
      "insufficient_agreement",
      `Only ${agreeing.length} of ${scored.length} available layers agree with a ${candidate} (${list}); Tudumm needs at least 3. Sitting out.`,
    );
  }

  // ---- trade
  const levels = computeLevels(bars, d, close, e20, a, dec);
  const strat = strategyFor(levels.pending);
  const meanAgree = agreeing.reduce((x, id) => x + (v.layers[id] as number), 0) / agreeing.length;
  v.decision = "trade";
  v.direction = candidate;
  v.levels = levels;
  v.strategy = strat.key;
  v.strategyLabel = strat.label;
  v.confidence = roundTo(clamp(0.5 + 0.25 * (meanAgree / 100) - 0.05 * disagreeing.length, 0.5, 0.78), 2);
  const top = [...agreeing].sort((x, y) => (v.layers[y] as number) - (v.layers[x] as number)).slice(0, 3);
  const body = top.map((id) => res[id].note.replace(/\.$/, "")).join("; ") + ".";
  const ld = levelDecimals(close, dec);
  v.thesis = levels.pending
    ? `Extended ${((Math.abs(close - e20) / a)).toFixed(1)} ATR from the 20-EMA, so the entry waits for a pullback to ${fmt(e20, ld)}. ${body}`
    : body;
  v.invalidation = `A ${TF_WORD[input.tf] ?? input.tf} close ${d > 0 ? "below" : "above"} ${fmt(levels.stop, ld)} (the stop) breaks the ${d > 0 ? "up" : "down"}trend structure.`;
  return v;
}

function fmtScore(x: number): string {
  return `${x > 0 ? "+" : ""}${x}`;
}

function fillNaLayers(v: EngineView, input: EngineInput): void {
  for (const id of LAYER_IDS) {
    const why = input.naReasons?.[id] ?? "Waiting for enough history.";
    v.layerNotes[id] = why;
    v.layerDetail[id] = why;
  }
}

function regimeOf(atrS: readonly (number | null)[], closes: readonly number[], snap: ReturnType<typeof snapshot>, trend: 1 | -1 | 0): Regime {
  const pcts: number[] = [];
  for (let i = Math.max(0, closes.length - 100); i < closes.length; i++) {
    const a = atrS[i];
    const c = closes[i] as number;
    if (a !== null && a !== undefined && c > 0) pcts.push(a / c);
  }
  const med = median(pcts);
  if (med !== null && snap.atrPct !== null && snap.atrPct / 100 > 1.6 * med) return "high-vol";
  if (trend === 0 || snap.ema50 === null || snap.atr === null) return "range";
  if (Math.abs(snap.close - snap.ema50) < 0.5 * snap.atr) return "range";
  return trend > 0 ? "trending-up" : "trending-down";
}

export function computeLevels(bars: readonly Candle[], d: 1 | -1, close: number, e20: number, a: number, decimals: number): Levels {
  const extended = d * (close - e20) > 1.5 * a;
  const mid = extended ? e20 : close;
  const base = mid - d * 1.5 * a;
  let stop = base;
  const { highs, lows } = swingLevels(bars, 2, 60);
  if (d > 0) {
    const below = lows.filter((x) => x.price < mid).sort((x, y) => y.price - x.price)[0];
    if (below) {
      const s2 = below.price - 0.1 * a;
      if (s2 > base && mid - s2 >= a) stop = s2;
    }
  } else {
    const above = highs.filter((x) => x.price > mid).sort((x, y) => x.price - y.price)[0];
    if (above) {
      const s2 = above.price + 0.1 * a;
      if (s2 < base && s2 - mid >= a) stop = s2;
    }
  }
  const dec = levelDecimals(close, decimals);
  const entryLow = roundTo(mid - 0.25 * a, dec);
  const entryHigh = roundTo(mid + 0.25 * a, dec);
  const midR = (entryLow + entryHigh) / 2;
  const stopR = roundTo(stop, dec);
  const risk = Math.abs(midR - stopR);
  const target1 = roundTo(midR + d * 1.5 * risk, dec);
  const target2 = roundTo(midR + d * 2.5 * risk, dec);
  return {
    entryLow,
    entryHigh,
    stop: stopR,
    target1,
    target2,
    rr1: risk > 0 ? roundTo(Math.abs(target1 - midR) / risk, 2) : 0,
    rr2: risk > 0 ? roundTo(Math.abs(target2 - midR) / risk, 2) : 0,
    pending: extended,
  };
}

function roundSnapshot(s: ReturnType<typeof snapshot>, dec: number): ReturnType<typeof snapshot> {
  const r = (x: number | null, d = dec) => (x === null ? null : roundTo(x, d));
  return {
    close: s.close,
    ema20: r(s.ema20),
    ema50: r(s.ema50),
    ema200: r(s.ema200),
    rsi: r(s.rsi, 1),
    macdHist: r(s.macdHist, Math.max(dec, 4)),
    atr: r(s.atr, Math.max(dec, 2)),
    atrPct: r(s.atrPct, 2),
    supertrendDir: s.supertrendDir,
    donchianHigh: r(s.donchianHigh),
    donchianLow: r(s.donchianLow),
    volumeRatio: r(s.volumeRatio, 2),
  };
}
