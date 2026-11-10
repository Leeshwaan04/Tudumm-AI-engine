import { useSyncExternalStore } from "react";
import type { MarketId, Style } from "./types";
import { MARKET_ORDER } from "./seed";

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
}

function persistent<T>(key: string, fallback: T, validate: (v: unknown) => T | null): Store<T> {
  let value: T = fallback;
  const raw = storage.get(key);
  if (raw) {
    try {
      value = validate(JSON.parse(raw)) ?? fallback;
    } catch {
      value = fallback;
    }
  }
  const listeners = new Set<Listener>();
  const emit = () => listeners.forEach((l) => l());
  if (typeof window !== "undefined") {
    window.addEventListener("storage", (e) => {
      if (e.key !== key) return;
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
      value = typeof next === "function" ? (next as (p: T) => T)(value) : next;
      storage.set(key, JSON.stringify(value));
      emit();
    },
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    reset() {
      value = fallback;
      storage.remove(key);
      emit();
    },
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

function validateProfile(v: unknown): Profile | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Partial<Profile>;
  const persona = PERSONAS.some((p) => p.id === o.persona) ? (o.persona as Persona) : DEFAULT_PROFILE.persona;
  const markets = Array.isArray(o.markets)
    ? (o.markets.filter((m) => MARKET_ORDER.includes(m as MarketId)) as MarketId[])
    : DEFAULT_PROFILE.markets;
  const capital = typeof o.capital === "number" && o.capital > 0 ? o.capital : DEFAULT_PROFILE.capital;
  const currency = CURRENCIES.includes(o.currency as ProfileCurrency)
    ? (o.currency as ProfileCurrency)
    : DEFAULT_PROFILE.currency;
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
export const watchlistStore = persistent<string[]>(`${KEY_PREFIX}watchlist.v1`, [], strList);
export const trackingStore = persistent<string[]>(`${KEY_PREFIX}tracking.v1`, [], strList);

export function useProfile() {
  return useStore(profileStore);
}
export function updateProfile(patch: Partial<Profile>) {
  profileStore.set((p) => ({ ...p, ...patch }));
}

export function toggleIn(store: Store<string[]>, symbol: string) {
  store.set((list) => (list.includes(symbol) ? list.filter((s) => s !== symbol) : [...list, symbol]));
}

export function resetDemo() {
  for (const k of storage.keys()) if (k.startsWith(KEY_PREFIX)) storage.remove(k);
  profileStore.reset();
  watchlistStore.reset();
  trackingStore.reset();
}
