import { useSyncExternalStore } from "react";
import { instruments, entryMid, riskPerUnit, getInstrument } from "./seed";
import { rng } from "./prng";
import type { Instrument, LiveStatus } from "./types";
import { isTrade } from "./types";

/**
 * Live tick simulation (shared rules with the extension):
 * - every instrument ticks every 1.2–2.0 s
 * - mean-reverting random walk around the seed price, sigma/tick: 0.03% (FX 0.01%, crypto 0.08%)
 * - clamped so active / t1_hit never cross stop or target 2, pending stays out of the entry zone
 * - only status change simulated: queued -> active|pending after revealAfterSec from load
 */

export const LOAD_AT = Date.now();
const HISTORY = 64;

export interface Tick {
  price: number;
  prev: number;
  dir: 1 | -1 | 0;
  seq: number;
  history: number[];
}

function sigmaFor(inst: Instrument): number {
  if (inst.assetClass === "fx") return 0.0001;
  if (inst.assetClass === "crypto") return 0.0008;
  return 0.0003;
}

function roundTo(v: number, d: number): number {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

function seedHistory(inst: Instrument): number[] {
  // deterministic recent path ending at the seed price (so sparklines render immediately)
  const r = rng(`${inst.symbol}:history`);
  const s = sigmaFor(inst) * inst.price;
  const out: number[] = [inst.price];
  let p = inst.price;
  for (let i = 1; i < 40; i++) {
    p = p - s * r.normal() * 1.4 + 0.05 * (inst.price - p);
    out.unshift(roundTo(p, inst.decimals));
  }
  return out;
}

type Listener = () => void;

class LiveStore {
  private ticks = new Map<string, Tick>();
  private nextAt = new Map<string, number>();
  private side = new Map<string, "above" | "below">();
  private statuses: Record<string, LiveStatus> = {};
  private revealedAt = new Map<string, number>();
  private all: Record<string, Tick> = {};
  private symListeners = new Map<string, Set<Listener>>();
  private anyListeners = new Set<Listener>();
  private statusListeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    const now = Date.now();
    for (const inst of instruments) {
      const t: Tick = { price: inst.price, prev: inst.price, dir: 0, seq: 0, history: seedHistory(inst) };
      this.ticks.set(inst.symbol, t);
      this.all[inst.symbol] = t;
      this.nextAt.set(inst.symbol, now + 400 + Math.random() * 1600);
      this.statuses[inst.symbol] = inst.signal.status;
      this.recordSide(inst, inst.price);
    }
  }

  private recordSide(inst: Instrument, price: number) {
    const s = inst.signal;
    if (!isTrade(s)) return;
    this.side.set(inst.symbol, price > s.entryHigh ? "above" : "below");
  }

  private ensureRunning() {
    if (this.timer || typeof window === "undefined") return;
    this.timer = setInterval(() => this.loop(), 200);
  }

  bounds(inst: Instrument): [number, number] {
    const s = inst.signal;
    const p0 = inst.price;
    if (!isTrade(s)) return [p0 * 0.97, p0 * 1.03];
    const status = this.statuses[inst.symbol];
    const risk = riskPerUnit(s);
    const m = risk * 0.06;
    const long = s.direction === "LONG";
    const lo = long ? s.stop : s.target2;
    const hi = long ? s.target2 : s.stop;
    if (status === "t1_hit") {
      const be = entryMid(s);
      return long ? [be + m, s.target2 - m] : [s.target2 + m, be - m];
    }
    if (status === "pending") {
      return this.side.get(inst.symbol) === "above" ? [s.entryHigh + m, hi - m] : [lo + m, s.entryLow - m];
    }
    return [lo + m, hi - m];
  }

  private step(inst: Instrument, t: Tick): number {
    const sigma = sigmaFor(inst) * inst.price;
    // Box-Muller with Math.random (live ticks need not be deterministic)
    const u = 1 - Math.random();
    const v = Math.random();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    let p = t.price + 0.05 * (inst.price - t.price) + sigma * z;
    const [lo, hi] = this.bounds(inst);
    if (p < lo) p = lo + Math.min(lo - p, (hi - lo) * 0.05);
    if (p > hi) p = hi - Math.min(p - hi, (hi - lo) * 0.05);
    p = Math.min(hi, Math.max(lo, p));
    return roundTo(p, inst.decimals);
  }

  private loop() {
    const now = Date.now();
    const changed: string[] = [];
    let statusChanged = false;
    for (const inst of instruments) {
      const s = inst.signal;
      if (s.status === "queued" && this.statuses[inst.symbol] === "queued" && isTrade(s)) {
        const at = LOAD_AT + (s.revealAfterSec ?? 30) * 1000;
        if (now >= at) {
          const p = this.ticks.get(inst.symbol)!.price;
          const inZone = p >= s.entryLow && p <= s.entryHigh;
          this.statuses = { ...this.statuses, [inst.symbol]: inZone ? "active" : "pending" };
          this.revealedAt.set(inst.symbol, now);
          this.recordSide(inst, p);
          statusChanged = true;
        }
      }
      const due = this.nextAt.get(inst.symbol)!;
      if (now < due) continue;
      this.nextAt.set(inst.symbol, now + 1200 + Math.random() * 800);
      const t = this.ticks.get(inst.symbol)!;
      const price = this.step(inst, t);
      if (price === t.price) continue;
      const history = t.history.length >= HISTORY ? t.history.slice(1) : t.history.slice();
      history.push(price);
      const nt: Tick = { price, prev: t.price, dir: price > t.price ? 1 : -1, seq: t.seq + 1, history };
      this.ticks.set(inst.symbol, nt);
      changed.push(inst.symbol);
    }
    if (changed.length) {
      this.all = { ...this.all };
      for (const sym of changed) {
        this.all[sym] = this.ticks.get(sym)!;
        this.symListeners.get(sym)?.forEach((l) => l());
      }
      this.anyListeners.forEach((l) => l());
    }
    if (statusChanged) this.statusListeners.forEach((l) => l());
  }

  subscribeSymbol = (symbol: string) => (l: Listener) => {
    this.ensureRunning();
    let set = this.symListeners.get(symbol);
    if (!set) this.symListeners.set(symbol, (set = new Set()));
    set.add(l);
    return () => {
      set!.delete(l);
    };
  };
  subscribeAll = (l: Listener) => {
    this.ensureRunning();
    this.anyListeners.add(l);
    return () => {
      this.anyListeners.delete(l);
    };
  };
  subscribeStatus = (l: Listener) => {
    this.ensureRunning();
    this.statusListeners.add(l);
    return () => {
      this.statusListeners.delete(l);
    };
  };

  getTick(symbol: string): Tick {
    return this.ticks.get(symbol) ?? EMPTY_TICK;
  }
  getAll = () => this.all;
  getStatuses = () => this.statuses;
  getStatus(symbol: string): LiveStatus {
    return this.statuses[symbol] ?? "sit_out";
  }
  getRevealedAt(symbol: string): number | undefined {
    return this.revealedAt.get(symbol);
  }
}

const EMPTY_TICK: Tick = { price: 0, prev: 0, dir: 0, seq: 0, history: [] };

export const live = new LiveStore();

const symSubs = new Map<string, (l: Listener) => () => void>();
function subFor(symbol: string) {
  let s = symSubs.get(symbol);
  if (!s) symSubs.set(symbol, (s = live.subscribeSymbol(symbol)));
  return s;
}

export function useTick(symbol: string): Tick {
  return useSyncExternalStore(subFor(symbol), () => live.getTick(symbol));
}
export function useAllTicks(): Record<string, Tick> {
  return useSyncExternalStore(live.subscribeAll, live.getAll);
}
export function useStatuses(): Record<string, LiveStatus> {
  return useSyncExternalStore(live.subscribeStatus, live.getStatuses);
}
export function useLiveStatus(symbol: string): LiveStatus {
  const all = useStatuses();
  return all[symbol] ?? "sit_out";
}

/* ---------- shared 1s clock ---------- */
let now = Date.now();
const clockListeners = new Set<Listener>();
let clockTimer: ReturnType<typeof setInterval> | null = null;
function subscribeClock(l: Listener) {
  clockListeners.add(l);
  if (!clockTimer) {
    clockTimer = setInterval(() => {
      now = Date.now();
      clockListeners.forEach((fn) => fn());
    }, 250);
  }
  return () => {
    clockListeners.delete(l);
    if (!clockListeners.size && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}
/** Current time, refreshed 4x a second; `stepMs` floors it so slower consumers re-render less. */
export function useNow(stepMs = 250): number {
  return useSyncExternalStore(subscribeClock, () => (stepMs > 250 ? Math.floor(now / stepMs) * stepMs : now));
}

/* ---------- time helpers ---------- */
export function issuedAtMs(inst: Instrument): number {
  const s = inst.signal;
  if (s.status === "queued" && isTrade(s)) {
    return live.getRevealedAt(inst.symbol) ?? LOAD_AT + (s.revealAfterSec ?? 30) * 1000;
  }
  return LOAD_AT - s.issuedMinutesAgo * 60_000;
}
export function secondsToReveal(inst: Instrument, at: number): number {
  const s = inst.signal;
  if (!isTrade(s) || s.status !== "queued") return 0;
  return Math.max(0, (LOAD_AT + (s.revealAfterSec ?? 30) * 1000 - at) / 1000);
}

export function changePct(symbol: string, price: number): number {
  const inst = getInstrument(symbol);
  if (!inst) return 0;
  return ((price - inst.prevClose) / inst.prevClose) * 100;
}
