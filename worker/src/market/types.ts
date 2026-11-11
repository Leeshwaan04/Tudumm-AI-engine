// Shared market/engine types. Data/engine agent owns and may EXTEND (not rename) these.

export type SignalStatus = "pending" | "active" | "t1_hit" | "sit_out" | "closed" | "held" | "invalidated";
export type Freshness = "realtime" | "delayed-15m" | "eod" | "daily-ref";

export interface SignalEvent {
  type: "issued" | "activated" | "t1_hit" | "closed" | "invalidated" | "held" | "released";
  signalId: string;
  symbol: string;
  market: string;
  direction: "LONG" | "SHORT" | null;
  at: string; // ISO
  detail?: Record<string, unknown>; // e.g. { outcome, r, exit } on close
}

export interface SourceHealth {
  source: string; // "binance" | "cboe" | "nse-eod" | "ecb" | ...
  ok: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  staleSeconds: number | null;
  freshness: Freshness;
}

export interface EngineHealth {
  sources: SourceHealth[];
  lastRunAt: string | null;
  liveSignals: number;
  ledgerEntries: number;
}

export interface AdminSignalRow {
  id: string;
  symbol: string;
  market: string;
  status: SignalStatus;
  direction: "LONG" | "SHORT" | null;
  strategy: string | null;
  confidence: number | null;
  issuedAt: string;
  updatedAt: string;
  held: boolean;
}

export interface StrategyRow {
  strategy: string;
  market: string;
  enabled: boolean;
  signals: number;
  closed: number;
  winRate: number | null;
  avgR: number | null;
}

/* ---------------- extensions (data + engine agent) ---------------- */

export type MarketId = "IN" | "US" | "EU" | "CRYPTO" | "FX" | "CMDTY";
export type AssetClass = "index" | "equity" | "etf" | "crypto" | "fx" | "commodity";
export type Currency = "INR" | "USD" | "EUR" | "JPY" | "USDT";
export type SourceId = "binance" | "binance-futures" | "bybit" | "alternative-me" | "cboe" | "sec-edgar" | "nse-archives" | "ecb-frankfurter";
export type DerivKind = "option_chain" | "perp" | "futures" | "none";
export type CandleTf = "15m" | "1H" | "4H" | "1D" | "1W";
export type Outcome = "target" | "trailed" | "stopped" | "expired" | "invalidated";

/** Static instrument definition (source of truth; mirrored into the `instruments` table by 0002). */
export interface InstrumentDef {
  symbol: string;
  name: string;
  exchange: string;
  market: MarketId;
  assetClass: AssetClass;
  currency: Currency;
  decimals: number;
  aliases: string[];
  source: SourceId; // primary price source
  freshness: Freshness;
  proxyNote: string | null;
  ohlc: boolean; // false => close-only series (ECB reference rates): draw a line
  dataSymbol: string; // provider symbol (PAXGUSDT for XAUUSD, USO for CL, "Nifty 50" for NIFTY ...)
  style: "swing" | "positional";
  tf: "4H" | "1D";
  tfSec: number;
  expiryBars: number;
  pendingBars: number;
  staleAfterSec: number;
  /** seconds after a daily bar's 00:00 UTC open when that session's bar is final (daily instruments) */
  closeOffsetSec: number;
  derivKind: DerivKind;
  flowMode: "book" | "volume" | "none";
  venueLabel: string;
  benchmark: string | null; // SPY / NIFTY for single stocks (context layer)
  cik: string | null; // SEC EDGAR CIK (10 digits) for US filers
  foSymbol: string | null; // NSE F&O TckrSymb
}

/** A row the cron / runner / ingest route writes into `candles`. t = bar open, unix seconds UTC. */
export interface CandleRow {
  symbol: string;
  tf: CandleTf;
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface QuoteRow {
  symbol: string;
  price: number;
  prevClose: number | null;
  changePct: number | null;
  dayOpen?: number | null;
  dayHigh?: number | null;
  dayLow?: number | null;
  volume?: number | null;
  bid?: number | null;
  ask?: number | null;
  bidSize?: number | null;
  askSize?: number | null;
  asOf: string;
  source: SourceId;
}

export interface SnapshotRow {
  key: string; // deriv:SYM | depth:SYM | fund:SYM | ctx:CRYPTO | ctx:US | ctx:IN | ctx:USD | perp:SYM
  json: unknown;
  asOf: string;
  source: SourceId;
}

export interface HealthRow {
  source: SourceId;
  ok: boolean;
  error?: string | null;
  at: string;
}
