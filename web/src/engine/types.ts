export type MarketId = "IN" | "US" | "EU" | "CRYPTO" | "FX" | "CMDTY";
export type LayerId = "price" | "flow" | "derivatives" | "fundamentals" | "context";
export type AssetClass = "index" | "equity" | "etf" | "crypto" | "fx" | "commodity";
export type SignalStatus = "active" | "pending" | "t1_hit" | "sit_out";
/** Status as shown at runtime (engine v0 lifecycle). */
export type LiveStatus = SignalStatus;
export type Direction = "LONG" | "SHORT";
export type Style = "intraday" | "swing" | "positional" | "investing";
export type Regime = "trending-up" | "trending-down" | "range" | "high-vol" | "unknown";
export type Freshness = "realtime" | "delayed-15m" | "eod" | "daily-ref";
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
  status: SignalStatus;
  regime: Regime;
  issuedMinutesAgo: number;
  layers: LayerScores;
  thesis: string;
  invalidation: string | null;
  /* ---- engine v0 extras ---- */
  live?: boolean;
  engine?: string;
  calibrated?: boolean;
  issuedAt?: string;
  /** Reason per layer when its score is null (no data / not applicable). */
  layerNotes?: Partial<Record<LayerId, string>>;
  /** Plain-language explanation per layer (live). */
  layerDetail?: Partial<Record<LayerId, string>>;
  /** Why engine v0 is sitting out (live sit-outs only). */
  sitOutReason?: string | null;
  /** The direction engine v0 was considering when it sat out. */
  candidate?: Direction | null;
  lastClosed?: { id: string; outcome: string | null; r: number | null; closedAt: string | null } | null;
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
  /* ---- from GET /api/v1/market/universe ---- */
  source?: string;
  freshness?: Freshness;
  asOf?: string | null;
  proxyNote?: string | null;
  ohlc?: boolean;
  live?: boolean;
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

/** GET /api/v1/market/universe after normalisation (api/market.ts). */
export interface Universe {
  meta: {
    live?: boolean;
    engine?: string;
    calibrated?: boolean;
    note?: string;
    generatedAt?: string;
    ledgerVersion?: number;
  } | null;
  markets: Market[];
  layers: Layer[];
  instruments: Instrument[];
}

export function isTrade(s: Signal): s is TradeSignal {
  return s.status !== "sit_out" && (s as TradeSignal).direction !== undefined;
}
