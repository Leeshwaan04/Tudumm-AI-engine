import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EMPTY_UNIVERSE, setDataset } from "../engine/universe";
import { LiveStore, setActiveLive, activeLive } from "../engine/live";
import type { Instrument } from "../engine/types";
import { marketApi, normalizeUniverse, type UnavailableInstrument } from "../api/market";
import { useConfig } from "../api/config";
import { toast } from "./ui";

/**
 * Live market data for the whole app: GET /api/v1/market/universe, polled every 5 s while the tab is visible (60 s hidden), plus the
 * Binance public stream for crypto and the PAXG gold proxy. There is no fallback dataset: until
 * the API answers (or while it can't), `phase` is "loading" / "unavailable" and the UI says so.
 */
export interface DataState {
  phase: "loading" | "ready" | "unavailable";
  /** Why live data is unavailable (phase "unavailable"). */
  reason: string | null;
  /** Instruments in the universe with no data from their source yet (with the API's reason). */
  unavailable: UnavailableInstrument[];
  lastPollAt: number | null;
  /** Data is loaded but the last refresh failed (shown values are from lastPollAt). */
  stale: boolean;
  /** When the next automatic attempt runs (phase "unavailable" or stale). */
  nextRetryAt: number | null;
  retry: () => void;
}

const Ctx = createContext<DataState>({
  phase: "loading",
  reason: null,
  unavailable: [],
  lastPollAt: null,
  stale: false,
  nextRetryAt: null,
  retry: () => undefined,
});

export function useData(): DataState {
  return useContext(Ctx);
}

/** Fast while the tab is visible (live quotes and call status change every few seconds), slow in the background. */
const POLL_VISIBLE_MS = 5_000;
const POLL_HIDDEN_MS = 60_000;
const pollMs = () => (typeof document !== "undefined" && document.visibilityState === "hidden" ? POLL_HIDDEN_MS : POLL_VISIBLE_MS);

/** Binance spot stream symbol for a live instrument (crypto + the PAXG gold proxy). */
export function binanceStreamSymbol(inst: Instrument): string | null {
  if (inst.symbol === "XAUUSD") return "PAXGUSDT";
  if (inst.source === "binance" || (inst.assetClass === "crypto" && inst.freshness === "realtime")) return inst.symbol;
  return null;
}

async function fetchUniverse() {
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), 10_000);
  try {
    return normalizeUniverse(await marketApi.universe(ctrl.signal));
  } finally {
    window.clearTimeout(t);
  }
}

type Core = Omit<DataState, "retry">;

export function DataProvider({ children }: { children: ReactNode }) {
  const cfg = useConfig();
  const liveFlagOff = cfg.status === "ready" && cfg.config?.capabilities.liveData === false;
  const [state, setState] = useState<Core>({ phase: "loading", reason: null, unavailable: [], lastPollAt: null, stale: false, nextRetryAt: null });
  const storeRef = useRef<LiveStore | null>(null);
  const streamed = useRef<Set<string>>(new Set());
  const [nonce, setNonce] = useState(0);
  const retry = useCallback(() => setNonce((n) => n + 1), []);
  const [streamKey, setStreamKey] = useState("");

  useEffect(() => {
    let alive = true;
    let timer = 0;
    let failures = 0;
    const clear = (reason: string) => {
      storeRef.current = null;
      setDataset(EMPTY_UNIVERSE);
      setActiveLive(new LiveStore([]));
      setStreamKey("");
      return reason;
    };
    const schedule = (ms: number) => {
      if (!alive) return;
      timer = window.setTimeout(poll, ms);
      return Date.now() + ms;
    };
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await pollOnce();
      } finally {
        inFlight = false;
      }
    };
    const pollOnce = async () => {
      if (liveFlagOff) {
        const reason = clear("Live data is switched off by the Tudumm team right now.");
        setState({ phase: "unavailable", reason, unavailable: [], lastPollAt: null, stale: false, nextRetryAt: null });
        return;
      }
      try {
        const u = await fetchUniverse();
        if (!alive) return;
        failures = 0;
        if (u.withData === 0) {
          const reason = clear("No instrument has live data yet — the ingest jobs haven't produced prices.");
          setState({ phase: "unavailable", reason, unavailable: u.unavailable, lastPollAt: Date.now(), stale: false, nextRetryAt: schedule(pollMs()) ?? null });
          return;
        }
        const insts = u.universe.instruments;
        const streamSet = new Set(insts.filter((i) => binanceStreamSymbol(i)).map((i) => i.symbol));
        streamed.current = streamSet;
        setDataset(u.universe);
        if (!storeRef.current) {
          const store = new LiveStore(insts);
          storeRef.current = store;
          setActiveLive(store);
        } else {
          const fresh = storeRef.current.applyUniverse(insts, streamSet);
          for (const f of fresh.slice(0, 3)) {
            const s = f.inst.signal as { direction?: string };
            toast(`New signal: ${f.symbol} ${s.direction === "SHORT" ? "▼ SHORT" : "▲ LONG"}`);
          }
        }
        setStreamKey([...streamSet].sort().join(","));
        setState({ phase: "ready", reason: null, unavailable: u.unavailable, lastPollAt: Date.now(), stale: false, nextRetryAt: schedule(pollMs()) ?? null });
      } catch (err) {
        if (!alive) return;
        failures++;
        const wait = Math.min(POLL_HIDDEN_MS, 5_000 * 2 ** Math.min(failures - 1, 4));
        const next = schedule(wait) ?? null;
        if (storeRef.current) {
          setState((s) => ({ ...s, stale: true, nextRetryAt: next }));
        } else {
          const unreachable = (err as { unreachable?: boolean; status?: number })?.unreachable || (err as { status?: number })?.status === 0;
          setState({
            phase: "unavailable",
            reason: unreachable ? "The Tudumm market API can't be reached." : "The live universe didn't load.",
            unavailable: [],
            lastPollAt: null,
            stale: false,
            nextRetryAt: next,
          });
        }
      }
    };
    void poll();
    // back to the tab: refresh now instead of waiting out the background interval
    const onVisible = () => {
      if (!alive || document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [liveFlagOff, nonce]);

  // Binance public stream for crypto + PAXG, closed while the tab is hidden
  useEffect(() => {
    const store = storeRef.current;
    if (!store || !streamKey) return;
    const map = new Map<string, string>(); // stream symbol -> our symbol
    for (const sym of streamed.current) {
      const inst = store.instrument(sym);
      const ss = inst ? binanceStreamSymbol(inst) : null;
      if (ss) map.set(ss.toLowerCase(), sym);
    }
    if (!map.size) return;
    let ws: WebSocket | null = null;
    let backoff = 1000;
    let retryT = 0;
    let closedByUs = false;
    const url = `wss://data-stream.binance.vision/stream?streams=${[...map.keys()].map((s) => `${s}@miniTicker`).join("/")}`;
    const open = () => {
      if (document.visibilityState === "hidden" || ws) return;
      closedByUs = false;
      try {
        ws = new WebSocket(url);
      } catch {
        schedule();
        return;
      }
      ws.onopen = () => {
        backoff = 1000;
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as { data?: { s?: string; c?: string; E?: number } };
          const d = msg.data;
          if (!d?.s || !d.c) return;
          const sym = map.get(d.s.toLowerCase());
          const px = Number(d.c);
          if (sym && Number.isFinite(px)) activeLive().pushPrice(sym, px, d.E ?? Date.now());
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        ws = null;
        if (!closedByUs) schedule();
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
      };
    };
    const schedule = () => {
      window.clearTimeout(retryT);
      retryT = window.setTimeout(open, backoff);
      backoff = Math.min(30_000, backoff * 2);
    };
    const close = () => {
      closedByUs = true;
      window.clearTimeout(retryT);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      ws = null;
    };
    const onVis = () => (document.visibilityState === "hidden" ? close() : open());
    document.addEventListener("visibilitychange", onVis);
    open();
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      close();
    };
  }, [streamKey]);

  const value = useMemo<DataState>(() => ({ ...state, retry }), [state, retry]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
