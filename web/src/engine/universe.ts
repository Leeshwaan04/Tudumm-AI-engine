import { useSyncExternalStore } from "react";
import type { Instrument, Layer, LayerId, Market, MarketId, Universe, TradeSignal, Style } from "./types";
import { isTrade } from "./types";

/**
 * The live dataset: GET /api/v1/market/universe, normalised by api/market.ts and installed by
 * DataProvider (polled every 60 s). There is no bundled or simulated fallback — until the API
 * answers, the universe is empty and the UI says so. The exports below are ES-module live
 * bindings (`export let`), so importers always see the current universe; components that render
 * from it subscribe with `useDataset()`.
 */

/** Static labels (not market data). The API sends the same lists. */
export const MARKETS: Market[] = [
  { id: "IN", label: "India", flag: "IN" },
  { id: "US", label: "United States", flag: "US" },
  { id: "EU", label: "Europe", flag: "EU" },
  { id: "CRYPTO", label: "Crypto", flag: "CRYPTO" },
  { id: "FX", label: "Forex", flag: "FX" },
  { id: "CMDTY", label: "Commodities", flag: "CMDTY" },
];
export const LAYERS: Layer[] = [
  { id: "price", label: "Price & Structure" },
  { id: "flow", label: "Order Flow" },
  { id: "derivatives", label: "Derivatives" },
  { id: "fundamentals", label: "Fundamentals" },
  { id: "context", label: "Context & Sentiment" },
];

export const EMPTY_UNIVERSE: Universe = { meta: null, markets: MARKETS, layers: LAYERS, instruments: [] };

export let universe: Universe = EMPTY_UNIVERSE;
export let instruments: Instrument[] = [];
export let markets: Market[] = MARKETS;
export let layers: Layer[] = LAYERS;

let bySymbol = new Map<string, Instrument>();
let aliasIndex = new Map<string, Instrument>();
export let tradeInstruments: Instrument[] = [];
export let sitOutInstruments: Instrument[] = [];

function index(list: Instrument[]) {
  bySymbol = new Map(list.map((i) => [i.symbol, i]));
  aliasIndex = new Map<string, Instrument>();
  for (const inst of list) {
    aliasIndex.set(inst.symbol.toUpperCase(), inst);
    for (const a of inst.aliases ?? []) aliasIndex.set(a.toUpperCase(), inst);
  }
  tradeInstruments = list.filter((i) => isTrade(i.signal));
  sitOutInstruments = list.filter((i) => i.signal.status === "sit_out");
}
index(instruments);

let version = 0;
const listeners = new Set<() => void>();

export function setDataset(next: Universe) {
  universe = next;
  instruments = next.instruments;
  markets = next.markets?.length ? next.markets : MARKETS;
  layers = next.layers?.length ? next.layers : LAYERS;
  index(instruments);
  version++;
  listeners.forEach((l) => l());
}

export function datasetVersion() {
  return version;
}

/** Re-render when the universe changes (every live poll). */
export function useDataset(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
}

export function getInstrument(symbol: string | undefined): Instrument | undefined {
  if (!symbol) return undefined;
  return bySymbol.get(symbol.toUpperCase()) ?? resolveAlias(symbol);
}

export function resolveAlias(q: string): Instrument | undefined {
  return aliasIndex.get(q.trim().toUpperCase());
}

export const MARKET_LABEL: Record<MarketId, string> = {
  IN: "India",
  US: "United States",
  EU: "Europe",
  CRYPTO: "Crypto",
  FX: "Forex",
  CMDTY: "Commodities",
};
export const MARKET_SHORT: Record<MarketId, string> = {
  IN: "India",
  US: "US",
  EU: "Europe",
  CRYPTO: "Crypto",
  FX: "FX",
  CMDTY: "Commodities",
};
export const MARKET_ORDER: MarketId[] = ["IN", "US", "EU", "CRYPTO", "FX", "CMDTY"];

export const LAYER_ORDER: LayerId[] = ["price", "flow", "derivatives", "fundamentals", "context"];
export const LAYER_SHORT: Record<LayerId, string> = {
  price: "Price",
  flow: "Flow",
  derivatives: "Derivs",
  fundamentals: "Fund",
  context: "Context",
};
export const LAYER_LABEL: Record<LayerId, string> = {
  price: "Price & Structure",
  flow: "Order Flow",
  derivatives: "Derivatives",
  fundamentals: "Fundamentals",
  context: "Context & Sentiment",
};

export const STYLE_LABEL: Record<Style, string> = {
  intraday: "Intraday",
  swing: "Swing",
  positional: "Positional",
  investing: "Investing",
};

export function instrumentsIn(market: MarketId): Instrument[] {
  return instruments.filter((i) => i.market === market);
}

export function entryMid(s: TradeSignal): number {
  return (s.entryLow + s.entryHigh) / 2;
}
export function riskPerUnit(s: TradeSignal): number {
  return Math.abs(entryMid(s) - s.stop);
}
/** Signed R multiple of a price for this signal (positive = in favour of the call). */
export function rAt(s: TradeSignal, price: number): number {
  const risk = riskPerUnit(s);
  if (risk === 0) return 0;
  const d = s.direction === "LONG" ? price - entryMid(s) : entryMid(s) - price;
  return d / risk;
}

/** Layers with score >= 15 count as "agreeing" (engine v0 uses the same threshold). */
export const AGREE_THRESHOLD = 15;
export function agreement(scores: Record<LayerId, number | null>) {
  let agree = 0;
  let applicable = 0;
  let na = 0;
  for (const l of LAYER_ORDER) {
    const v = scores[l];
    if (v === null || v === undefined) {
      na++;
      continue;
    }
    applicable++;
    if (v >= AGREE_THRESHOLD) agree++;
  }
  return { agree, applicable, na };
}
