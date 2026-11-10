import raw from "../data/seed.json";
import type { Instrument, LayerId, MarketId, Seed, TradeSignal, Style } from "./types";
import { isTrade } from "./types";

export const seed = raw as unknown as Seed;

export const instruments: Instrument[] = seed.instruments;
export const markets = seed.markets;
export const layers = seed.layers;
export const ledger = seed.ledger;

const bySymbol = new Map(instruments.map((i) => [i.symbol, i]));
export function getInstrument(symbol: string | undefined): Instrument | undefined {
  if (!symbol) return undefined;
  return bySymbol.get(symbol.toUpperCase()) ?? resolveAlias(symbol);
}

const aliasIndex = new Map<string, Instrument>();
for (const inst of instruments) {
  aliasIndex.set(inst.symbol.toUpperCase(), inst);
  for (const a of inst.aliases) aliasIndex.set(a.toUpperCase(), inst);
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

/** Layers with score >= 15 count as "agreeing" (same threshold the seed copy uses). */
export const AGREE_THRESHOLD = 15;
export function agreement(scores: Record<LayerId, number | null>) {
  let agree = 0;
  let applicable = 0;
  let na = 0;
  for (const l of LAYER_ORDER) {
    const v = scores[l];
    if (v === null) {
      na++;
      continue;
    }
    applicable++;
    if (v >= AGREE_THRESHOLD) agree++;
  }
  return { agree, applicable, na };
}

export const tradeInstruments = instruments.filter((i) => isTrade(i.signal));
export const sitOutInstruments = instruments.filter((i) => i.signal.status === "sit_out");
export const queuedInstruments = instruments.filter((i) => i.signal.status === "queued");
