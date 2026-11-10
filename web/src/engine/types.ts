export type MarketId = "IN" | "US" | "EU" | "CRYPTO" | "FX" | "CMDTY";
export type LayerId = "price" | "flow" | "derivatives" | "fundamentals" | "context";
export type AssetClass = "index" | "equity" | "etf" | "crypto" | "fx" | "commodity";
export type SeedStatus = "active" | "pending" | "t1_hit" | "sit_out" | "queued";
/** Status as shown at runtime: queued signals become active/pending when revealed. */
export type LiveStatus = SeedStatus;
export type Direction = "LONG" | "SHORT";
export type Style = "intraday" | "swing" | "positional" | "investing";
export type Regime = "trending-up" | "trending-down" | "range" | "high-vol";
export type Currency = "INR" | "USD" | "EUR" | "JPY" | "USDT";

export interface Market {
  id: MarketId;
  label: string;
  flag: string;
}

export interface Layer {
  id: LayerId;
  label: string;
}

export type LayerScores = Record<LayerId, number | null>;

export interface SignalBase {
  id: string;
  symbol: string;
  status: SeedStatus;
  regime: Regime;
  issuedMinutesAgo: number;
  layers: LayerScores;
  thesis: string;
  invalidation: string | null;
}

export interface TradeSignal extends SignalBase {
  direction: Direction;
  style: Style;
  timeframe: string;
  strategy: string;
  confidence: number;
  entryLow: number;
  entryHigh: number;
  stop: number;
  target1: number;
  target2: number;
  rr1: number;
  rr2: number;
  revealAfterSec?: number;
}

export type Signal = SignalBase | TradeSignal;

export interface Instrument {
  symbol: string;
  name: string;
  exchange: string;
  market: MarketId;
  assetClass: AssetClass;
  currency: Currency;
  decimals: number;
  price: number;
  prevClose: number;
  aliases: string[];
  signal: Signal;
}

export type Outcome = "target" | "trailed" | "expired" | "stopped";

export interface LedgerEntry {
  id: string;
  issuedAt: string;
  symbol: string;
  market: MarketId;
  style: Style;
  strategy: string;
  direction: Direction;
  entry: number;
  stop: number;
  target: number;
  exit: number;
  closedAt: string;
  outcome: Outcome;
  r: number;
  prevHash: string;
  hash: string;
}

export interface Seed {
  meta: {
    product: string;
    version: number;
    simulated: boolean;
    note: string;
    generatedFor: string;
    ledgerHash: string;
    ledgerGenesisPrevHash: string;
  };
  markets: Market[];
  layers: Layer[];
  instruments: Instrument[];
  ledger: LedgerEntry[];
}

export function isTrade(s: Signal): s is TradeSignal {
  return s.status !== "sit_out" && (s as TradeSignal).direction !== undefined;
}
