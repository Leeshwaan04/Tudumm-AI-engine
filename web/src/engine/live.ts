import { useSyncExternalStore } from "react";
import { getInstrument } from "./universe";
import type { Instrument, LiveStatus } from "./types";
import { isTrade } from "./types";

/**
 * Price + status store. Nothing here is simulated:
 * - prices come from the universe poll (every 5 s while visible) and, for crypto + the PAXG gold proxy,
 *   from the Binance public WebSocket; statuses come from engine v0 via the universe.
 * - sparkline history only contains prices actually received in this session.
 */

const HISTORY = 64;

export interface Tick {
  price: number;
  prev: number;
  dir: 1 | -1 | 0;
  seq: number;
  history: number[];
  /** ms timestamp of the last real update. */
  at?: number;
}

function roundTo(v: number, d: number): number {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

type Listener = () => void;

export class LiveStore {
  private bySym = new Map<string, Instrument>();
  private ticks = new Map<string, Tick>();
  private statuses: Record<string, LiveStatus> = {};
  private revealedAt = new Map<string, number>();
  private all: Record<string, Tick> = {};
  private symListeners = new Map<string, Set<Listener>>();
  private anyListeners = new Set<Listener>();
  private statusListeners = new Set<Listener>();

  constructor(instruments: Instrument[]) {
    const now = Date.now();
    for (const inst of instruments) {
      this.bySym.set(inst.symbol, inst);
      const t: Tick = { price: inst.price, prev: inst.price, dir: 0, seq: 0, history: [inst.price], at: now };
      this.ticks.set(inst.symbol, t);
      this.all[inst.symbol] = t;
      this.statuses[inst.symbol] = inst.signal.status;
    }
  }

  instrument(symbol: string): Instrument | undefined {
    return this.bySym.get(symbol);
  }

  private write(symbol: string, price: number, t: Tick, at?: number) {
    const history = t.history.length >= HISTORY ? t.history.slice(1) : t.history.slice();
    history.push(price);
    const nt: Tick = { price, prev: t.price, dir: price > t.price ? 1 : price < t.price ? -1 : 0, seq: t.seq + 1, history, at: at ?? Date.now() };
    this.ticks.set(symbol, nt);
  }

  private flush(changed: string[]) {
    if (!changed.length) return;
    this.all = { ...this.all };
    for (const sym of changed) {
      this.all[sym] = this.ticks.get(sym)!;
      this.symListeners.get(sym)?.forEach((l) => l());
    }
    this.anyListeners.forEach((l) => l());
  }

  /* ---------- inputs ---------- */

  /** A real price (Binance stream or universe poll). */
  pushPrice(symbol: string, price: number, at = Date.now()) {
    if (!(price > 0)) return;
    const t = this.ticks.get(symbol);
    const inst = this.bySym.get(symbol);
    if (!t || !inst) return;
    const p = roundTo(price, Math.max(inst.decimals, 2));
    if (p === t.price && t.seq > 0) {
      this.ticks.set(symbol, { ...t, at });
      return;
    }
    this.write(symbol, p, t, at);
    this.flush([symbol]);
  }

  /**
   * Swap in a new poll of the universe. Keeps tick history; updates prices for
   * instruments that aren't streamed, statuses for all. Returns symbols whose signal id changed.
   */
  applyUniverse(next: Instrument[], streamed: Set<string>): { symbol: string; inst: Instrument }[] {
    const changedSignals: { symbol: string; inst: Instrument }[] = [];
    const prevBy = this.bySym;
    this.bySym = new Map(next.map((i) => [i.symbol, i]));
    const nextStatuses: Record<string, LiveStatus> = {};
    const priceChanged: string[] = [];
    const now = Date.now();
    for (const inst of next) {
      nextStatuses[inst.symbol] = inst.signal.status;
      const old = prevBy.get(inst.symbol);
      if (old && old.signal.id !== inst.signal.id && isTrade(inst.signal)) {
        changedSignals.push({ symbol: inst.symbol, inst });
        this.revealedAt.set(inst.symbol, now);
      }
      const t = this.ticks.get(inst.symbol);
      if (!t) {
        const nt: Tick = { price: inst.price, prev: inst.price, dir: 0, seq: 0, history: [inst.price], at: now };
        this.ticks.set(inst.symbol, nt);
        this.all = { ...this.all, [inst.symbol]: nt };
        continue;
      }
      if (!streamed.has(inst.symbol) && inst.price !== t.price) {
        this.write(inst.symbol, inst.price, t, now);
        priceChanged.push(inst.symbol);
      }
    }
    this.statuses = nextStatuses;
    this.flush(priceChanged);
    this.statusListeners.forEach((l) => l());
    return changedSignals;
  }

  /* ---------- subscriptions ---------- */
  private symSubs = new Map<string, (l: Listener) => () => void>();
  subscribeSymbol = (symbol: string) => {
    let s = this.symSubs.get(symbol);
    if (!s) {
      s = (l: Listener) => {
        let set = this.symListeners.get(symbol);
        if (!set) this.symListeners.set(symbol, (set = new Set()));
        set.add(l);
        return () => {
          set!.delete(l);
        };
      };
      this.symSubs.set(symbol, s);
    }
    return s;
  };
  subscribeAll = (l: Listener) => {
    this.anyListeners.add(l);
    return () => {
      this.anyListeners.delete(l);
    };
  };
  subscribeStatus = (l: Listener) => {
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

let active: LiveStore = new LiveStore([]);
const activeListeners = new Set<Listener>();
/** Install the store for a freshly loaded universe (DataProvider does this on the first poll). */
export function setActiveLive(store: LiveStore) {
  if (store === active) return;
  active = store;
  activeListeners.forEach((l) => l());
}
/** Non-hook access to the active store (chart updates, timers). */
export function activeLive(): LiveStore {
  return active;
}
export function useLiveStore(): LiveStore {
  return useSyncExternalStore(
    (l) => {
      activeListeners.add(l);
      return () => activeListeners.delete(l);
    },
    () => active,
  );
}

export function useTick(symbol: string): Tick {
  const store = useLiveStore();
  return useSyncExternalStore(store.subscribeSymbol(symbol), () => store.getTick(symbol));
}
export function useAllTicks(): Record<string, Tick> {
  const store = useLiveStore();
  return useSyncExternalStore(store.subscribeAll, store.getAll);
}
export function useStatuses(): Record<string, LiveStatus> {
  const store = useLiveStore();
  return useSyncExternalStore(store.subscribeStatus, store.getStatuses);
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
  if (s.issuedAt) {
    const t = Date.parse(s.issuedAt);
    if (Number.isFinite(t)) return t;
  }
  return Date.now() - s.issuedMinutesAgo * 60_000;
}

export function changePct(symbol: string, price: number): number {
  const inst = getInstrument(symbol);
  if (!inst || !inst.prevClose) return 0;
  return ((price - inst.prevClose) / inst.prevClose) * 100;
}
