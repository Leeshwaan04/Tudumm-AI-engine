// Signal lifecycle (pure). pending -> active (price enters the zone) -> t1_hit (stop to breakeven) ->
// closed (target | trailed | stopped | expired). Bars are processed in order with their high/low;
// within one bar the STOP is checked before targets (conservative). Positions are full-size (no
// partials), so r = dir * (exit - entryMid) / |entryMid - originalStop|, recomputable from the ledger.
import type { Candle, Direction, Outcome } from "./types";
import { roundTo } from "./util";

export type OpenStatus = "pending" | "active" | "t1_hit";

export interface LifecycleSignal {
  direction: Direction;
  status: OpenStatus | "closed";
  entryLow: number;
  entryHigh: number;
  stop: number; // original stop (defines 1R)
  stopCurrent: number; // moves to breakeven after T1
  target1: number;
  target2: number;
  decimals: number;
  issuedBarT: number; // open time of the bar the signal was issued on (its close)
  tfSec: number;
  expiryBars: number; // max completed bars after issue before an open trade expires
  pendingBars: number; // max completed bars a pending entry waits before it expires unfilled
  barsElapsed: number; // completed bars after issue processed so far
  checkedThroughT: number | null; // open time of the last COMPLETED bar processed
  activatedAt: string | null;
  t1At: string | null;
  closedAt: string | null;
  closedBarT: number | null;
  outcome: Outcome | null;
  exit: number | null;
  r: number | null;
}

export interface Transition {
  type: "activated" | "t1_hit" | "closed";
  at: string;
  barT: number | null;
  price: number | null;
  outcome?: Outcome;
  exit?: number | null;
  r?: number;
  filled?: boolean;
}

export function entryMid(s: Pick<LifecycleSignal, "entryLow" | "entryHigh">): number {
  return (s.entryLow + s.entryHigh) / 2;
}

export function rMultiple(s: Pick<LifecycleSignal, "entryLow" | "entryHigh" | "stop" | "direction">, exit: number): number {
  const mid = entryMid(s);
  const risk = Math.abs(mid - s.stop);
  if (risk <= 0) return 0;
  const d = s.direction === "LONG" ? 1 : -1;
  return roundTo((d * (exit - mid)) / risk, 2);
}

function close(s: LifecycleSignal, out: Transition[], outcome: Outcome, exit: number | null, at: string, barT: number | null): void {
  s.status = "closed";
  s.outcome = outcome;
  s.exit = exit === null ? null : roundTo(exit, s.decimals);
  s.r = exit === null ? 0 : rMultiple(s, s.exit as number);
  s.closedAt = at;
  s.closedBarT = barT;
  out.push({ type: "closed", at, barT, price: s.exit, outcome, exit: s.exit, r: s.r, filled: exit !== null });
}

/** Apply one bar (or a single price point when o=h=l=c) to an open signal. */
function touch(s: LifecycleSignal, b: Candle, at: string, out: Transition[]): void {
  if (s.status === "closed") return;
  const long = s.direction === "LONG";
  if (s.status === "pending") {
    if (b.l <= s.entryHigh && b.h >= s.entryLow) {
      s.status = "active";
      s.activatedAt = at;
      out.push({ type: "activated", at, barT: b.t, price: long ? Math.min(s.entryHigh, b.h) : Math.max(s.entryLow, b.l) });
      // same bar: conservative stop check (no target checks until the next bar)
      if (long ? b.l <= s.stopCurrent : b.h >= s.stopCurrent) close(s, out, "stopped", s.stopCurrent, at, b.t);
    }
    return;
  }
  const stopHit = long ? b.l <= s.stopCurrent : b.h >= s.stopCurrent;
  if (stopHit) {
    const gap = long ? b.o < s.stopCurrent : b.o > s.stopCurrent;
    close(s, out, s.status === "t1_hit" ? "trailed" : "stopped", gap ? b.o : s.stopCurrent, at, b.t);
    return;
  }
  if (long ? b.h >= s.target2 : b.l <= s.target2) {
    close(s, out, "target", s.target2, at, b.t);
    return;
  }
  if (s.status === "active" && (long ? b.h >= s.target1 : b.l <= s.target1)) {
    s.status = "t1_hit";
    s.t1At = at;
    s.stopCurrent = roundTo(entryMid(s), s.decimals);
    out.push({ type: "t1_hit", at, barT: b.t, price: s.target1 });
  }
}

/**
 * Advance a signal with the bars after its issue bar (oldest first; the last one may still be forming)
 * and the latest price. Idempotent for already-processed bars. Returns the transitions that happened.
 */
export function stepLifecycle(
  sig: LifecycleSignal,
  bars: readonly Candle[],
  lastPrice: number | null,
  nowSec: number,
): { signal: LifecycleSignal; transitions: Transition[] } {
  const s: LifecycleSignal = { ...sig };
  const out: Transition[] = [];
  const nowIso = new Date(nowSec * 1000).toISOString();
  const sorted = [...bars].sort((a, b) => a.t - b.t);
  for (const b of sorted) {
    if (s.status === "closed") break;
    if (b.t <= s.issuedBarT) continue;
    if (s.checkedThroughT !== null && b.t <= s.checkedThroughT) continue;
    const complete = b.t + s.tfSec <= nowSec;
    touch(s, b, nowIso, out);
    if (!complete) continue;
    s.checkedThroughT = b.t;
    s.barsElapsed += 1;
    if (s.status === "pending" && s.barsElapsed >= s.pendingBars) close(s, out, "expired", null, nowIso, b.t);
    else if ((s.status === "active" || s.status === "t1_hit") && s.barsElapsed >= s.expiryBars) close(s, out, "expired", b.c, nowIso, b.t);
  }
  if (s.status !== "closed" && lastPrice !== null && Number.isFinite(lastPrice) && lastPrice > 0) {
    const t = s.checkedThroughT !== null ? s.checkedThroughT + s.tfSec : s.issuedBarT + s.tfSec;
    touch(s, { t, o: lastPrice, h: lastPrice, l: lastPrice, c: lastPrice, v: 0 }, nowIso, out);
  }
  return { signal: s, transitions: out };
}

/** Close an open signal by hand (admin invalidation) at the latest price. */
export function invalidate(sig: LifecycleSignal, price: number | null, nowSec: number): { signal: LifecycleSignal; transitions: Transition[] } {
  const s: LifecycleSignal = { ...sig };
  const out: Transition[] = [];
  if (s.status === "closed") return { signal: s, transitions: out };
  const filled = s.status !== "pending";
  close(s, out, "invalidated", filled && price !== null ? price : null, new Date(nowSec * 1000).toISOString(), s.checkedThroughT);
  return { signal: s, transitions: out };
}
