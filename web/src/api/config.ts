import { useSyncExternalStore } from "react";
import { configApi } from "./endpoints";
import type { AppConfig, Capabilities, PlanDef } from "./types";

/**
 * GET /api/v1/config once at boot, again on window focus at most every 5 minutes.
 * When the API is unreachable every capability reads as false, so capability-gated UI
 * (sign-in, alerts, billing, Turnstile…) hides itself instead of offering dead controls.
 */

export const NO_CAPS: Capabilities = {
  emailDelivery: false,
  devCodes: false,
  googleSignIn: false,
  turnstile: false,
  payments: false,
  paymentProviders: [],
  adminConfigured: false,
  liveData: false,
  extensionLinking: false,
  signups: false,
};

/** Static fallback mirroring worker/src/lib/plans.ts, used only until config loads. */
export const FALLBACK_PLANS: PlanDef[] = [
  { id: "free", name: "Free", priceUsdCents: 0, priceInrPaise: 0, features: ["Every sit-out, with the reason", "3 live calls a day, one market", "The public ledger and chain check", "Extension chip on supported sites"] },
  { id: "pro", name: "Pro", priceUsdCents: 2400, priceInrPaise: 199900, features: ["All live calls across all six markets", "Full five-layer evidence and position sizer", "Extension side panel and watchlist", "Signal and price alerts"] },
  { id: "elite", name: "Elite", priceUsdCents: 6900, priceInrPaise: 549900, features: ["Everything in Pro", "Raw layer scores and history export", "API and webhooks (at launch)", "Early access to new instruments"] },
];

export interface ConfigState {
  status: "loading" | "ready" | "unavailable";
  config: AppConfig | null;
  caps: Capabilities;
  /** The API answered at least once in this page session. */
  apiReachable: boolean;
}

let state: ConfigState = { status: "loading", config: null, caps: NO_CAPS, apiReachable: false };
const listeners = new Set<() => void>();
let lastFetch = 0;
let inflight: Promise<void> | null = null;

function set(next: ConfigState) {
  state = next;
  listeners.forEach((l) => l());
}

export function loadConfig(force = false): Promise<void> {
  if (inflight) return inflight;
  if (!force && Date.now() - lastFetch < 5 * 60_000 && state.status !== "loading") return Promise.resolve();
  lastFetch = Date.now();
  inflight = configApi
    .get()
    .then((c) => {
      set({ status: "ready", config: c, caps: { ...NO_CAPS, ...(c.capabilities ?? {}) }, apiReachable: true });
    })
    .catch(() => {
      // keep a previously loaded config when a refresh fails
      if (state.config) return;
      set({ status: "unavailable", config: null, caps: NO_CAPS, apiReachable: false });
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

if (typeof window !== "undefined") {
  void loadConfig(true);
  window.addEventListener("focus", () => void loadConfig());
}

export function getConfigState(): ConfigState {
  return state;
}

export function useConfig(): ConfigState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export function useCaps(): Capabilities {
  return useConfig().caps;
}

export function usePlans(): PlanDef[] {
  const c = useConfig().config;
  return c?.plans?.length ? c.plans : FALLBACK_PLANS;
}

export function useLegal() {
  const c = useConfig().config;
  return c?.legal ?? null;
}
