import { useSyncExternalStore } from "react";
import type { MarketId, Style } from "./types";
import { MARKET_ORDER } from "./universe";

/* ---------- safe localStorage (works when blocked / private mode) ---------- */
const memory = new Map<string, string>();
export const storage = {
  get(key: string): string | null {
    try {
      const v = window.localStorage.getItem(key);
      return v ?? memory.get(key) ?? null;
    } catch {
      return memory.get(key) ?? null;
    }
  },
  set(key: string, value: string) {
    memory.set(key, value);
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* in-memory fallback already set */
    }
  },
  remove(key: string) {
    memory.delete(key);
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
  keys(): string[] {
    const out = new Set(memory.keys());
    try {
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k) out.add(k);
      }
    } catch {
      /* ignore */
    }
    return [...out];
  },
};

type Listener = () => void;

export interface Store<T> {
  get: () => T;
  set: (next: T | ((prev: T) => T)) => void;
  subscribe: (l: Listener) => () => void;
  reset: () => void;
  /** Switch to server-backed mode: `value` comes from the API, every change is pushed with `push`
   * (optimistic; rolled back if the push fails). localStorage (the guest copy) is left untouched. */
  attach: (value: T, push: (prev: T, next: T) => Promise<T | void>, onError?: (err: unknown) => void) => void;
  /** Back to the guest copy in localStorage (sign-out). */
  detach: () => void;
  isRemote: () => boolean;
  /** The guest copy, regardless of mode (used for the one-shot sync after sign-in). */
  guest: () => T;
}

function persistent<T>(key: string, fallback: T, validate: (v: unknown) => T | null): Store<T> {
  const readGuest = (): T => {
    const raw = storage.get(key);
    if (!raw) return fallback;
    try {
      return validate(JSON.parse(raw)) ?? fallback;
    } catch {
      return fallback;
    }
  };
  let value: T = readGuest();
  let remote: { push: (prev: T, next: T) => Promise<T | void>; onError?: (err: unknown) => void } | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let epoch = 0;
  const listeners = new Set<Listener>();
  const emit = () => listeners.forEach((l) => l());
  if (typeof window !== "undefined") {
    window.addEventListener("storage", (e) => {
      if (e.key !== key || remote) return;
      try {
        value = e.newValue ? (validate(JSON.parse(e.newValue)) ?? fallback) : fallback;
      } catch {
        value = fallback;
      }
      emit();
    });
  }
  return {
    get: () => value,
    set(next) {
      const prev = value;
      const computed = typeof next === "function" ? (next as (p: T) => T)(value) : next;
      value = computed;
      emit();
      if (!remote) {
        storage.set(key, JSON.stringify(value));
        return;
      }
      const r = remote;
      const myEpoch = epoch;
      queue = queue
        .then(() => r.push(prev, computed))
        .then((server) => {
          if (myEpoch !== epoch || server === undefined) return;
          // adopt the server's normalised copy unless the user changed it again meanwhile
          if (value === computed) {
            value = (validate(server) ?? computed) as T;
            emit();
          }
        })
        .catch((err) => {
          if (myEpoch !== epoch) return;
          if (value === computed) {
            value = prev;
            emit();
          }
          r.onError?.(err);
        });
    },
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    reset() {
      storage.remove(key);
      if (remote) return;
      value = fallback;
      emit();
    },
    attach(v, push, onError) {
      epoch++;
      remote = { push, onError };
      value = (validate(v) ?? fallback) as T;
      emit();
    },
    detach() {
      epoch++;
      remote = null;
      value = readGuest();
      emit();
    },
    isRemote: () => remote !== null,
    guest: readGuest,
  };
}

export function useStore<T>(s: Store<T>): T {
  return useSyncExternalStore(s.subscribe, s.get);
}

/* ---------- profile ---------- */
export type Persona = "scalper" | "swing" | "options" | "investor";
export type ProfileCurrency = "INR" | "USD" | "EUR" | "JPY";

export interface Profile {
  persona: Persona;
  markets: MarketId[];
  capital: number;
  currency: ProfileCurrency;
  riskPct: number;
  onboarded: boolean;
}

export const PERSONAS: { id: Persona; label: string; short: string; blurb: string; styles: Style[] }[] = [
  {
    id: "scalper",
    label: "Intraday / Scalper",
    short: "Intraday",
    blurb: "Minutes to hours. Opening ranges, order-book pushes, VWAP reclaims.",
    styles: ["intraday"],
  },
  {
    id: "swing",
    label: "Swing trader",
    short: "Swing",
    blurb: "Days to weeks. Structure, OI build-ups and breakout retests.",
    styles: ["swing"],
  },
  {
    id: "options",
    label: "Options trader",
    short: "Options",
    blurb: "Reads the chain first: OI walls, IV rank, PCR and max pain.",
    styles: [],
  },
  {
    id: "investor",
    label: "Long-term investor",
    short: "Investor",
    blurb: "Months and longer. Fundamentals lead, price confirms.",
    styles: ["positional", "investing"],
  },
];
export const PERSONA_BY_ID = Object.fromEntries(PERSONAS.map((p) => [p.id, p])) as Record<
  Persona,
  (typeof PERSONAS)[number]
>;

export const CURRENCIES: ProfileCurrency[] = ["INR", "USD", "EUR", "JPY"];

export const DEFAULT_PROFILE: Profile = {
  persona: "swing",
  markets: [...MARKET_ORDER],
  capital: 500000,
  currency: "INR",
  riskPct: 1,
  onboarded: false,
};

export function validateProfile(v: unknown): Profile | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Partial<Profile>;
  const rawPersona = (o.persona as string) === "intraday" ? "scalper" : o.persona;
  const persona = PERSONAS.some((p) => p.id === rawPersona) ? (rawPersona as Persona) : DEFAULT_PROFILE.persona;
  const markets = Array.isArray(o.markets)
    ? (o.markets.filter((m) => MARKET_ORDER.includes(m as MarketId)) as MarketId[])
    : DEFAULT_PROFILE.markets;
  const capital = typeof o.capital === "number" && o.capital > 0 ? o.capital : DEFAULT_PROFILE.capital;
  const rawCur = (o.currency as string) === "USDT" ? "USD" : o.currency;
  const currency = CURRENCIES.includes(rawCur as ProfileCurrency) ? (rawCur as ProfileCurrency) : DEFAULT_PROFILE.currency;
  const riskPct =
    typeof o.riskPct === "number" && o.riskPct > 0 && o.riskPct <= 10 ? o.riskPct : DEFAULT_PROFILE.riskPct;
  return {
    persona,
    markets: markets.length ? markets : DEFAULT_PROFILE.markets,
    capital,
    currency,
    riskPct,
    onboarded: Boolean(o.onboarded),
  };
}

const KEY_PREFIX = "tudumm.";
export const profileStore = persistent<Profile>(`${KEY_PREFIX}profile.v1`, DEFAULT_PROFILE, validateProfile);

const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null);

/** Server profile shape (worker/src/api/userdata.ts). */
export function toServerProfile(p: Profile) {
  return {
    persona: p.persona === "scalper" ? ("intraday" as const) : p.persona,
    markets: p.markets,
    capital: p.capital,
    currency: p.currency,
    riskPct: Math.min(5, Math.max(0.1, p.riskPct)),
    onboarded: p.onboarded,
  };
}

/* analytics hook for list toggles (wired by api/events.ts, kept here to avoid an import cycle) */
let toggleHook: ((store: "watchlist" | "tracking", symbol: string, on: boolean) => void) | null = null;
export function onListToggle(fn: typeof toggleHook) {
  toggleHook = fn;
}
export const watchlistStore = persistent<string[]>(`${KEY_PREFIX}watchlist.v1`, [], strList);
export const trackingStore = persistent<string[]>(`${KEY_PREFIX}tracking.v1`, [], strList);

export function useProfile() {
  return useStore(profileStore);
}
export function updateProfile(patch: Partial<Profile>) {
  profileStore.set((p) => ({ ...p, ...patch }));
}

export function toggleIn(store: Store<string[]>, symbol: string) {
  const on = !store.get().includes(symbol);
  store.set((list) => (list.includes(symbol) ? list.filter((s) => s !== symbol) : [...list, symbol]));
  toggleHook?.(store === watchlistStore ? "watchlist" : "tracking", symbol, on);
}

export function resetDemo() {
  for (const k of storage.keys()) if (k.startsWith(KEY_PREFIX)) storage.remove(k);
  profileStore.reset();
  watchlistStore.reset();
  trackingStore.reset();
}
