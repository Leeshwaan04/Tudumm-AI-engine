// Engine types. PURE: no Worker or Node APIs anywhere under engine/ (shared by the cron and the runner).

export type LayerId = "price" | "flow" | "derivatives" | "fundamentals" | "context";
export const LAYER_IDS: readonly LayerId[] = ["price", "flow", "derivatives", "fundamentals", "context"];
export type Direction = "LONG" | "SHORT";
export type Regime = "trending-up" | "trending-down" | "range" | "high-vol";
export type Style = "intraday" | "swing" | "positional" | "investing";
export type EngineTf = "4H" | "1D";
export type Outcome = "target" | "trailed" | "stopped" | "expired" | "invalidated";

/** One OHLCV bar. t = bar OPEN time, unix seconds UTC. tb = taker-buy base volume (Binance only). */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  tb?: number;
}

export interface LayerResult {
  score: number | null; // -100..100 toward the candidate direction; null = no data
  note: string; // human sentence with real numbers, or the reason when score is null
}

/* ---------- inputs the layer scorers consume (all optional: missing => null layer + reason) ---------- */

export interface DepthInput {
  bids: [number, number][]; // [price, qty], best first
  asks: [number, number][];
  asOf: string;
  venue: string;
}

export interface PerpInput {
  fundingRate: number | null; // fraction per interval (0.0001 = 0.01%)
  fundingIntervalHours: number;
  oiChange24hPct: number | null;
  priceChange24hPct: number | null;
  venue: string;
  asOf: string;
}

export type BuildUpClass = "long_buildup" | "short_buildup" | "short_covering" | "long_unwinding" | "flat";

export interface ChainSummaryInput {
  pcr: number | null; // put/call open interest, whole expiry
  pcrVolume: number | null;
  maxPain: number | null;
  callWall: number | null;
  putWall: number | null;
  ivAtm: number | null; // percent
  skew: number | null; // put IV - call IV at ~5% OTM, vol points
  callDOI: number | null; // summed OI change, ladder
  putDOI: number | null;
  expiry: string;
  convention: "india" | "us"; // PCR reading differs by market (see README-market.md)
}

export interface FuturesBuildUpInput {
  class: BuildUpClass;
  priceChangePct: number;
  oiChangePct: number;
}

export interface FundamentalsInput {
  kind: "equity" | "index";
  revenueGrowthPct?: number | null;
  netMarginPct?: number | null;
  epsGrowthPct?: number | null;
  pe?: number | null;
  pePercentile1y?: number | null; // index: P/E percentile over the last year (0..100)
  label: string; // e.g. "SEC filings to 2026-09-26"
}

export interface ContextInput {
  fearGreed?: { value: number; prev: number | null } | null;
  vix?: { value: number; change5dPct: number | null; label: string; calm: number; elevated: number } | null;
  benchmark?: { symbol: string; aboveEma200: boolean; ema50Rising: boolean } | null;
  usdTrend?: { eurusdChange20dPct: number } | null; // for gold: USD weaker => supportive
}

export interface EngineInput {
  symbol: string;
  market: string;
  assetClass: string;
  decimals: number;
  style: Style;
  tf: EngineTf;
  tfSec: number;
  expiryBars: number;
  bars: Candle[]; // COMPLETED bars only, oldest first
  lastPrice: number;
  nowSec: number;
  staleAfterSec: number; // max age of the last completed bar's CLOSE before we sit out
  venueLabel: string; // e.g. "Binance", "NSE", "Cboe (delayed)"
  depth?: DepthInput | null;
  perp?: PerpInput | null;
  chain?: ChainSummaryInput | null;
  futures?: FuturesBuildUpInput | null;
  fundamentals?: FundamentalsInput | null;
  context?: ContextInput | null;
  /** Reasons for layers that have no source at all for this instrument (fixed, honest). */
  naReasons?: Partial<Record<LayerId, string>>;
  flowMode: "book" | "volume" | "none";
}

export interface Levels {
  entryLow: number;
  entryHigh: number;
  stop: number;
  target1: number;
  target2: number;
  rr1: number;
  rr2: number;
  pending: boolean; // true => pullback entry (status starts "pending")
}

export type SitOutReason =
  | "no_trend"
  | "momentum_conflict"
  | "insufficient_agreement"
  | "stale_data"
  | "insufficient_history"
  | "event_risk"
  | "strategy_disabled"
  | "cooldown"
  | "no_data";

export interface IndicatorSnapshot {
  close: number;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  rsi: number | null;
  macdHist: number | null;
  atr: number | null;
  atrPct: number | null;
  supertrendDir: 1 | -1 | null;
  donchianHigh: number | null;
  donchianLow: number | null;
  volumeRatio: number | null;
}

export interface EngineView {
  engine: "v0";
  calibrated: false;
  symbol: string;
  decision: "trade" | "sit_out";
  sitOutReason: SitOutReason | null;
  direction: Direction | null; // only set for trades
  candidate: Direction | null; // what the trend/momentum pointed to (even when sitting out)
  regime: Regime;
  style: Style;
  timeframe: EngineTf;
  layers: Record<LayerId, number | null>;
  layerNotes: Partial<Record<LayerId, string>>; // reason for every NULL layer
  layerDetail: Record<LayerId, string>; // explanation for every layer (null or not)
  agree: number;
  disagree: number;
  applicable: number;
  confidence: number | null; // UNCALIBRATED heuristic, 0.50..0.78
  thesis: string;
  invalidation: string | null;
  levels: Levels | null;
  strategy: string | null; // key: trend_continuation | ema20_pullback
  strategyLabel: string | null;
  barT: number | null; // open time of the last completed bar used
  indicators: IndicatorSnapshot | null;
  eventRisk: { checked: boolean; flag: boolean; note: string };
}

export const AGREE = 15;
