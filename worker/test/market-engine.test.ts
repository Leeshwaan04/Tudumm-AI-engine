// Engine v0 + lifecycle unit tests on deterministic fixture candles. Run: npm run test:market
import "../../runner/lib/register.ts";
import { test } from "node:test";
import assert from "node:assert/strict";

const { evaluate, computeLevels } = await import("../src/engine/engine.ts");
const { stepLifecycle, invalidate } = await import("../src/engine/lifecycle.ts");
const { ema, rsi, atr, macd, supertrend, donchian, volumeRatio, swingLevels, vwap } = await import("../src/engine/indicators.ts");
const { bookImbalance } = await import("../src/engine/orderbook.ts");
type Candle = import("../src/engine/types.ts").Candle;
type EngineInput = import("../src/engine/types.ts").EngineInput;
type LifecycleSignal = import("../src/engine/lifecycle.ts").LifecycleSignal;

/** Deterministic LCG so the fixture is identical on every run. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

const D = 86400;
const T0 = Date.UTC(2025, 0, 6) / 1000;

/** 260 daily bars: steady uptrend (drift +0.35%/bar) with noise; more volume on up days. */
function trendBars(drift = 0.0035, n = 260, seed = 7): Candle[] {
  const r = lcg(seed);
  const out: Candle[] = [];
  let c = 100;
  for (let i = 0; i < n; i++) {
    const o = c;
    const ret = drift + (r() - 0.5) * 0.02;
    c = o * (1 + ret);
    const h = Math.max(o, c) * (1 + r() * 0.006);
    const l = Math.min(o, c) * (1 - r() * 0.006);
    const v = (c > o ? 1.4 : 0.8) * (1e6 + r() * 2e5);
    out.push({ t: T0 + i * D, o, h, l, c, v });
  }
  return out;
}

function flatBars(n = 260, seed = 11): Candle[] {
  const r = lcg(seed);
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const c = 100 + Math.sin(i / 3) * 0.6 + (r() - 0.5) * 0.4;
    out.push({ t: T0 + i * D, o: c - 0.1, h: c + 0.5, l: c - 0.5, c, v: 1e6 });
  }
  return out;
}

function input(bars: Candle[], extra: Partial<EngineInput> = {}): EngineInput {
  const last = bars[bars.length - 1] ?? { t: T0, o: 100, h: 100, l: 100, c: 100, v: 0 };
  return {
    symbol: "TEST",
    market: "IN",
    assetClass: "equity",
    decimals: 2,
    style: "positional",
    tf: "1D",
    tfSec: D,
    expiryBars: 40,
    bars,
    lastPrice: last.c,
    nowSec: last.t + D + 3600,
    staleAfterSec: 6 * D,
    venueLabel: "NSE",
    flowMode: "volume",
    ...extra,
  };
}

const supportive: Partial<EngineInput> = {
  chain: { pcr: 1.3, pcrVolume: null, maxPain: null, callWall: null, putWall: null, ivAtm: 14, skew: null, callDOI: 100, putDOI: 400, expiry: "2026-11-17", convention: "india" },
  futures: { class: "long_buildup", priceChangePct: 0.8, oiChangePct: 4.1 },
  context: { vix: { value: 12, change5dPct: -12, label: "India VIX", calm: 13, elevated: 20 }, benchmark: { symbol: "NIFTY", aboveEma200: true, ema50Rising: true } },
};

test("indicators: EMA/RSI/ATR/MACD basics", () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.deepEqual(ema(xs, 3).slice(0, 3), [null, null, 2]);
  assert.equal(ema(xs, 3)[3], 3); // 4*0.5 + 2*0.5
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.equal(rsi(up, 14)[29], 100);
  const bars = trendBars();
  const a = atr(bars, 14);
  assert.equal(a[12], null);
  assert.ok((a[13] as number) > 0);
  const m = macd(bars.map((b) => b.c));
  assert.ok((m[259]?.hist ?? null) !== null);
  assert.equal(supertrend(bars)[259]?.dir, 1);
  assert.ok((donchian(bars, 20)[259]?.upper ?? 0) > 0);
  assert.ok((volumeRatio(bars) ?? 0) > 0);
  assert.ok(swingLevels(bars).lows.length > 0);
  assert.ok((vwap(bars)[0] ?? 0) > 0);
});

test("engine: uptrend with supportive layers => deterministic LONG with consistent levels", () => {
  const v = evaluate(input(trendBars(), supportive));
  assert.equal(v.engine, "v0");
  assert.equal(v.calibrated, false);
  assert.equal(v.decision, "trade", v.thesis);
  assert.equal(v.direction, "LONG");
  assert.ok(v.agree >= 3);
  const L = v.levels!;
  assert.ok(L.stop < L.entryLow && L.entryLow < L.entryHigh && L.entryHigh < L.target1 && L.target1 < L.target2);
  const mid = (L.entryLow + L.entryHigh) / 2;
  const risk = mid - L.stop;
  assert.ok(Math.abs(L.target1 - (mid + 1.5 * risk)) < 0.02);
  assert.ok(Math.abs(L.target2 - (mid + 2.5 * risk)) < 0.02);
  assert.ok(Math.abs(L.rr1 - 1.5) <= 0.02 && Math.abs(L.rr2 - 2.5) <= 0.02);
  assert.ok(v.confidence! >= 0.5 && v.confidence! <= 0.78);
  assert.equal(v.layers.fundamentals, null);
  assert.ok(v.layerNotes.fundamentals && v.layerNotes.fundamentals.length > 5, "null layer has a reason");
  assert.ok(/50-EMA/.test(v.thesis));
  // deterministic: same input => same output
  assert.deepEqual(evaluate(input(trendBars(), supportive)), v);
});

test("engine: downtrend mirrors to SHORT", () => {
  const bars = trendBars(-0.0035, 260, 3);
  const v = evaluate(
    input(bars, {
      futures: { class: "short_buildup", priceChangePct: -0.8, oiChangePct: 3 },
      chain: { pcr: 0.7, pcrVolume: null, maxPain: null, callWall: null, putWall: null, ivAtm: 15, skew: null, callDOI: 500, putDOI: 50, expiry: "x", convention: "india" },
      context: { vix: { value: 24, change5dPct: 20, label: "India VIX", calm: 13, elevated: 20 }, benchmark: { symbol: "NIFTY", aboveEma200: false, ema50Rising: false } },
    }),
  );
  assert.equal(v.candidate, "SHORT");
  if (v.decision === "trade") {
    const L = v.levels!;
    assert.ok(L.stop > L.entryHigh && L.target1 < L.entryLow && L.target2 < L.target1);
  } else assert.equal(v.sitOutReason, "insufficient_agreement");
});

test("engine: only price + flow available => sits out with reasons for null layers", () => {
  const v = evaluate(input(trendBars()));
  assert.equal(v.decision, "sit_out");
  assert.equal(v.sitOutReason, "insufficient_agreement");
  assert.equal(v.direction, null);
  assert.equal(v.confidence, null);
  for (const l of ["derivatives", "fundamentals", "context"] as const) assert.ok(v.layerNotes[l], `${l} reason`);
});

test("engine: range-bound series => no trend / momentum conflict sit-out", () => {
  const v = evaluate(input(flatBars(), supportive));
  assert.equal(v.decision, "sit_out");
  assert.ok(["no_trend", "momentum_conflict", "insufficient_agreement"].includes(v.sitOutReason as string), String(v.sitOutReason));
});

test("engine: stale data and short history sit out", () => {
  const bars = trendBars();
  const last = bars[bars.length - 1] as Candle;
  assert.equal(evaluate(input(bars, { ...supportive, nowSec: last.t + 30 * D })).sitOutReason, "stale_data");
  assert.equal(evaluate(input(bars.slice(0, 40), supportive)).sitOutReason, "insufficient_history");
  assert.equal(evaluate(input([], supportive)).sitOutReason, "no_data");
});

test("levels: ATR stop and R multiples; extended price => pending pullback to EMA20", () => {
  const bars = trendBars();
  const L = computeLevels(bars, 1, 110, 108, 2, 2);
  assert.equal(L.pending, false);
  assert.equal(L.entryLow, 109.5);
  assert.equal(L.entryHigh, 110.5);
  assert.ok(L.stop <= 108 && L.stop >= 107); // 1.5 ATR = 107, or a tighter swing >= 1 ATR away
  const P = computeLevels(bars, 1, 120, 110, 2, 2);
  assert.equal(P.pending, true);
  assert.equal((P.entryLow + P.entryHigh) / 2, 110);
});

function sig(over: Partial<LifecycleSignal> = {}): LifecycleSignal {
  return {
    direction: "LONG",
    status: "active",
    entryLow: 99,
    entryHigh: 101,
    stop: 97,
    stopCurrent: 97,
    target1: 104.5,
    target2: 107.5,
    decimals: 2,
    issuedBarT: 0,
    tfSec: D,
    expiryBars: 15,
    pendingBars: 5,
    barsElapsed: 0,
    checkedThroughT: null,
    activatedAt: null,
    t1At: null,
    closedAt: null,
    closedBarT: null,
    outcome: null,
    exit: null,
    r: null,
    ...over,
  };
}
const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({ t: i * D, o, h, l, c, v: 1 });
const NOW = 100 * D;

test("lifecycle: pending -> active -> t1_hit (stop to breakeven) -> trailed at 0R", () => {
  const bars = [bar(1, 103, 103.5, 102, 103), bar(2, 102, 102.5, 100.5, 101), bar(3, 101, 104.8, 100.6, 104), bar(4, 103, 103.2, 99.9, 100.2)];
  const { signal, transitions } = stepLifecycle(sig({ status: "pending" }), bars, null, NOW);
  assert.deepEqual(transitions.map((t) => t.type), ["activated", "t1_hit", "closed"]);
  assert.equal(signal.status, "closed");
  assert.equal(signal.outcome, "trailed");
  assert.equal(signal.exit, 100);
  assert.equal(signal.r, 0);
  assert.equal(signal.barsElapsed, 4);
});

test("lifecycle: target, gap stop, same-bar stop-first, expiry and unfilled pending", () => {
  const t = stepLifecycle(sig(), [bar(1, 101, 105, 100, 104.9), bar(2, 105, 108, 104.6, 107)], null, NOW).signal;
  assert.equal(t.outcome, "target");
  assert.equal(t.r, 2.5);
  const g = stepLifecycle(sig(), [bar(1, 96, 96.5, 95, 95.5)], null, NOW).signal;
  assert.equal(g.outcome, "stopped");
  assert.equal(g.exit, 96);
  assert.equal(g.r, -1.33);
  const both = stepLifecycle(sig(), [bar(1, 100, 108, 96.5, 100)], null, NOW).signal;
  assert.equal(both.outcome, "stopped", "stop is checked before targets within one bar");
  const e = stepLifecycle(sig({ expiryBars: 3 }), [bar(1, 100, 101, 99.5, 100.5), bar(2, 100.5, 101.5, 99.6, 101), bar(3, 101, 102, 100, 101.5)], null, NOW).signal;
  assert.equal(e.outcome, "expired");
  assert.equal(e.exit, 101.5);
  assert.equal(e.r, 0.5);
  const u = stepLifecycle(sig({ status: "pending", pendingBars: 2 }), [bar(1, 103, 104, 102, 103), bar(2, 103, 104, 102.5, 103)], null, NOW).signal;
  assert.equal(u.outcome, "expired");
  assert.equal(u.exit, null);
  assert.equal(u.r, 0);
});

test("lifecycle: idempotent on re-processed bars; forming bar doesn't count toward expiry", () => {
  const bars = [bar(1, 100, 101, 99.5, 100.5), bar(2, 100.5, 101, 100, 100.8)];
  const a = stepLifecycle(sig(), bars, 100.8, 2 * D + 3600); // bar 2 still forming
  assert.equal(a.signal.barsElapsed, 1);
  assert.equal(a.signal.checkedThroughT, D);
  const b = stepLifecycle(a.signal, bars, 100.8, 2 * D + 3600);
  assert.equal(b.transitions.length, 0);
  assert.deepEqual(b.signal, a.signal);
});

test("lifecycle: SHORT mirror and admin invalidation", () => {
  const s = sig({ direction: "SHORT", entryLow: 99, entryHigh: 101, stop: 103, stopCurrent: 103, target1: 95.5, target2: 92.5 });
  const r = stepLifecycle(s, [bar(1, 100, 100.5, 95, 95.4)], null, NOW).signal;
  assert.equal(r.status, "t1_hit");
  assert.equal(r.stopCurrent, 100);
  const inv = invalidate(s, 98, NOW).signal;
  assert.equal(inv.outcome, "invalidated");
  assert.equal(inv.r, 0.67);
  const invPending = invalidate(sig({ status: "pending" }), 98, NOW).signal;
  assert.equal(invPending.exit, null);
});

test("order book imbalance within ±1% of mid", () => {
  const im = bookImbalance([[100, 3], [99.5, 1], [98, 50]], [[100.1, 1], [100.8, 1], [102, 50]], 1)!;
  assert.equal(im.bidQty, 4); // 98 is outside the band
  assert.equal(im.askQty, 2);
  assert.equal(im.ratio, 2);
  assert.ok(Math.abs(im.imbalance - 1 / 3) < 1e-9);
});

// ---- forming-bar watermark (live quotes step an open call many times inside one bar) ----

test("lifecycle: a forming bar's earlier high can't count as T1 after a later activation", () => {
  // day 1 is forming. Pass 1: price opened high (105.5 > T1) then fell into the zone -> activated.
  const s0 = sig({ status: "pending" });
  const now1 = 1 * D + 3600;
  const p1 = stepLifecycle(s0, [bar(1, 105.5, 105.5, 100.5, 100.5)], 100.5, now1, D);
  assert.equal(p1.signal.status, "active");
  assert.equal(p1.signal.formingT, 1 * D);
  assert.equal(p1.signal.formingHigh, 105.5);
  // Pass 2 (same bar, no new extremes): the 105.5 high was printed BEFORE activation -> no T1.
  const p2 = stepLifecycle(p1.signal, [bar(1, 105.5, 105.5, 100.4, 101)], 101, now1 + 5, D);
  assert.deepEqual(p2.transitions.map((t) => t.type), []);
  assert.equal(p2.signal.status, "active");
  // Pass 3: a NEW high above T1 after activation does count.
  const p3 = stepLifecycle(p2.signal, [bar(1, 105.5, 105.8, 100.4, 105.8)], 105.8, now1 + 10, D);
  assert.deepEqual(p3.transitions.map((t) => t.type), ["t1_hit"]);
});

test("lifecycle: after T1 inside a forming bar, the day's earlier low can't trail it out at breakeven", () => {
  const s0 = sig({ status: "active" });
  const now1 = 1 * D + 3600;
  // low 99.2 first (above the 97 stop), then a rally to 104.6 -> T1, stop -> breakeven 100
  const p1 = stepLifecycle(s0, [bar(1, 100, 104.6, 99.2, 104.6)], 104.6, now1, D);
  assert.equal(p1.signal.status, "t1_hit");
  assert.equal(p1.signal.stopCurrent, 100);
  // next pass: same bar range (99.2 low is old) -> still open at T1
  const p2 = stepLifecycle(p1.signal, [bar(1, 100, 104.6, 99.2, 103)], 103, now1 + 5, D);
  assert.equal(p2.signal.status, "t1_hit");
  assert.deepEqual(p2.transitions, []);
  // when the bar completes with no new extremes, nothing changes either; the bar is counted once
  const p3 = stepLifecycle(p2.signal, [bar(1, 100, 104.6, 99.2, 103)], 103, 2 * D, D);
  assert.equal(p3.signal.status, "t1_hit");
  assert.equal(p3.signal.barsElapsed, 1);
  assert.equal(p3.signal.checkedThroughT, 1 * D);
  assert.equal(p3.signal.formingT, null);
  // a NEW low below breakeven after T1 does trail it out
  const p4 = stepLifecycle(p3.signal, [bar(1, 100, 104.6, 99.2, 103), bar(2, 103, 103, 99.8, 99.9)], 99.9, 2 * D + 60, D);
  assert.equal(p4.signal.status, "closed");
  assert.equal(p4.signal.outcome, "trailed");
});

test("lifecycle: a bar is complete at its session close (closeOffsetSec), not 24 h after its open", () => {
  const CLOSE = 37800; // NSE daily bar: 16:00 IST after its 00:00 UTC open time
  const s0 = sig({ status: "active" });
  const before = stepLifecycle(s0, [bar(1, 100, 101, 99.5, 100.5)], 100.5, 1 * D + CLOSE - 60, CLOSE);
  assert.equal(before.signal.barsElapsed, 0);
  const after = stepLifecycle(before.signal, [bar(1, 100, 101, 99.5, 100.5)], 100.5, 1 * D + CLOSE + 60, CLOSE);
  assert.equal(after.signal.barsElapsed, 1);
  assert.equal(after.signal.checkedThroughT, 1 * D);
  // and re-stepping later (e.g. the */15 cron overnight) doesn't touch that bar again
  const later = stepLifecycle(after.signal, [bar(1, 100, 101, 99.5, 100.5)], 100.5, 1 * D + 80000, CLOSE);
  assert.equal(later.signal.barsElapsed, 1);
  assert.deepEqual(later.transitions, []);
});

test("lifecycle: without a watermark (first sight of a bar) behaviour is unchanged", () => {
  const a = stepLifecycle(sig(), [bar(1, 101, 105, 100, 104.9), bar(2, 105, 108, 104.6, 107)], null, NOW);
  const b = stepLifecycle(sig(), [bar(1, 101, 105, 100, 104.9), bar(2, 105, 108, 104.6, 107)], null, NOW, D);
  assert.deepEqual(a.signal, b.signal);
});
