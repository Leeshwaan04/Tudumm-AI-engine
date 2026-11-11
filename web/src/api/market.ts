// Public market API (worker/src/market/routes.ts) + normalisation of the live universe into
// the shape the UI renders. Normalisation is defensive: anything malformed is
// dropped or turned into an honest "not available" state — never filled with made-up values.
import { api } from "./client";
import type { Freshness, Instrument, LayerId, LayerScores, Regime, Signal, TradeSignal, Universe } from "../engine/types";
import { LAYERS, MARKETS } from "../engine/universe";

const enc = encodeURIComponent;
const LAYER_IDS: LayerId[] = ["price", "flow", "derivatives", "fundamentals", "context"];
const REGIMES: Regime[] = ["trending-up", "trending-down", "range", "high-vol"];
const FRESH: Freshness[] = ["realtime", "delayed-15m", "eod", "daily-ref"];

type Raw = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export interface UnavailableInstrument {
  symbol: string;
  name: string;
  market: string;
  reason: string;
}

export interface LiveUniverse {
  universe: Universe;
  withData: number;
  unavailable: UnavailableInstrument[];
  rawLedger: unknown[];
  asOf: string | null;
}

function normLayers(v: unknown): LayerScores {
  const o = (v && typeof v === "object" ? v : {}) as Raw;
  const out = {} as LayerScores;
  for (const l of LAYER_IDS) {
    const n = num(o[l]);
    out[l] = n === null ? null : Math.max(-100, Math.min(100, Math.round(n)));
  }
  return out;
}

function normNotes(v: unknown): Partial<Record<LayerId, string>> {
  const o = (v && typeof v === "object" ? v : {}) as Raw;
  const out: Partial<Record<LayerId, string>> = {};
  for (const l of LAYER_IDS) {
    const s = str(o[l]);
    if (s) out[l] = s;
  }
  return out;
}

function normSignal(symbol: string, rawSig: unknown, inst: Raw, now: number): Signal {
  const s = (rawSig && typeof rawSig === "object" ? rawSig : null) as Raw | null;
  const layerNotes = normNotes(s?.layerNotes ?? inst.layerNotes);
  const issuedAt = str(s?.issuedAt) ?? str(inst.issuedAt);
  const issuedMs = issuedAt ? Date.parse(issuedAt) : NaN;
  const issuedMinutesAgo = Number.isFinite(issuedMs) ? Math.max(0, (now - issuedMs) / 60_000) : Math.max(0, num(s?.issuedMinutesAgo) ?? 0);
  const regime = (REGIMES as string[]).includes(String(s?.regime)) ? (s!.regime as Regime) : "unknown";
  const base = {
    id: str(s?.id) ?? `${symbol}-unevaluated`,
    symbol,
    regime,
    issuedMinutesAgo,
    layers: normLayers(s?.layers),
    thesis: str(s?.thesis) ?? "Engine v0 hasn't evaluated this instrument yet. It re-checks on every completed bar.",
    invalidation: str(s?.invalidation),
    live: true,
    engine: str(s?.engine) ?? str(inst.engine) ?? "v0",
    calibrated: s?.calibrated === true || inst.calibrated === true,
    issuedAt: issuedAt ?? undefined,
    layerNotes,
    layerDetail: normNotes(s?.layerDetail),
    sitOutReason: str(s?.sitOutReason),
    candidate: s?.candidate === "LONG" || s?.candidate === "SHORT" ? (s.candidate as "LONG" | "SHORT") : null,
    lastClosed:
      s?.lastClosed && typeof s.lastClosed === "object"
        ? {
            id: str((s.lastClosed as Raw).id) ?? "",
            outcome: str((s.lastClosed as Raw).outcome),
            r: num((s.lastClosed as Raw).r),
            closedAt: str((s.lastClosed as Raw).closedAt),
          }
        : null,
  };
  const status = String(s?.status ?? "sit_out");
  const tradeStatus = status === "active" || status === "pending" || status === "t1_hit" ? status : null;
  const dir = s?.direction === "LONG" || s?.direction === "SHORT" ? s.direction : null;
  const lv = {
    entryLow: num(s?.entryLow),
    entryHigh: num(s?.entryHigh),
    stop: num(s?.stop),
    target1: num(s?.target1),
    target2: num(s?.target2),
  };
  const levelsOk = Object.values(lv).every((x) => x !== null);
  if (!tradeStatus || !dir || !levelsOk) return { ...base, status: "sit_out" };
  const conf = num(s?.confidence);
  const t: TradeSignal = {
    ...base,
    status: tradeStatus,
    direction: dir,
    style: (["intraday", "swing", "positional", "investing"] as const).includes(s?.style as never) ? (s!.style as TradeSignal["style"]) : "swing",
    timeframe: str(s?.timeframe) ?? "1D",
    strategy: str(s?.strategy) ?? "Engine v0",
    confidence: conf === null ? 0.5 : Math.max(0, Math.min(1, conf)),
    entryLow: lv.entryLow as number,
    entryHigh: lv.entryHigh as number,
    stop: lv.stop as number,
    target1: lv.target1 as number,
    target2: lv.target2 as number,
    rr1: num(s?.rr1) ?? 1.5,
    rr2: num(s?.rr2) ?? 2.5,
  };
  return t;
}

export function normalizeUniverse(raw: unknown): LiveUniverse {
  const r = (raw && typeof raw === "object" ? raw : {}) as Raw;
  const list = Array.isArray(r.instruments) ? (r.instruments as Raw[]) : [];
  const now = Date.now();
  const instruments: Instrument[] = [];
  const unavailable: UnavailableInstrument[] = [];
  for (const i of list) {
    const symbol = str(i.symbol)?.toUpperCase();
    if (!symbol) continue;
    const name = str(i.name) ?? symbol;
    const market = (str(i.market) ?? "US") as Instrument["market"];
    const price = num(i.price);
    if (price === null || price <= 0) {
      unavailable.push({
        symbol,
        name,
        market,
        reason:
          str(i.reason) ??
          str(i.unavailableReason) ??
          str((i.signal as Raw | undefined)?.thesis) ??
          "No price from its free source yet (the ingest job hasn't produced data for it).",
      });
      continue;
    }
    const prev = num(i.prevClose);
    const fresh = (FRESH as string[]).includes(String(i.freshness)) ? (i.freshness as Freshness) : undefined;
    instruments.push({
      symbol,
      name,
      exchange: str(i.exchange) ?? "",
      market,
      assetClass: (str(i.assetClass) ?? "equity") as Instrument["assetClass"],
      currency: (str(i.currency) ?? "USD") as Instrument["currency"],
      decimals: Math.max(0, Math.min(8, Math.round(num(i.decimals) ?? 2))),
      price,
      prevClose: prev !== null && prev > 0 ? prev : price,
      aliases: Array.isArray(i.aliases) ? (i.aliases as unknown[]).filter((a): a is string => typeof a === "string") : [symbol],
      signal: normSignal(symbol, i.signal, i, now),
      source: str(i.source) ?? undefined,
      freshness: fresh,
      asOf: str(i.asOf),
      proxyNote: str(i.proxyNote),
      ohlc: i.ohlc === false ? false : true,
      live: true,
    });
  }
  const universe: Universe = {
    meta: (r.meta && typeof r.meta === "object" ? r.meta : null) as Universe["meta"],
    markets: Array.isArray(r.markets) && r.markets.length ? (r.markets as Universe["markets"]) : MARKETS,
    layers: Array.isArray(r.layers) && r.layers.length ? (r.layers as Universe["layers"]) : LAYERS,
    instruments,
  };
  const asOf = str((r.meta as Raw | undefined)?.asOf) ?? str(r.asOf) ?? null;
  return { universe, withData: instruments.length, unavailable, rawLedger: Array.isArray(r.ledger) ? r.ledger : [], asOf };
}

/* ---------------- endpoint shapes ---------------- */

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}
export interface CandlesRes {
  symbol: string;
  tf: string;
  ohlc: boolean;
  bars: Bar[];
  source?: string;
  freshness?: string;
  asOf?: string;
  available?: boolean;
  reason?: string;
  timeframes?: string[];
}

export interface DepthRes {
  available: boolean;
  reason?: string;
  bids: [number, number][];
  asks: [number, number][];
  imbalance?: number | null;
  bidAskRatio?: number | null;
  mid?: number;
  spreadBps?: number;
  venue?: string;
  source?: string;
  asOf?: string;
}

export interface ChainRowRes {
  strike: number;
  callOI: number | null;
  callDOI: number | null;
  callIV: number | null;
  callLTP: number | null;
  putLTP: number | null;
  putIV: number | null;
  putDOI: number | null;
  putOI: number | null;
}

export interface BuildUpRes {
  class: string;
  label?: string;
  priceChangePct: number | null;
  oiChangePct: number | null;
  explanation?: string;
  basis?: string;
}

export interface DerivativesRes {
  available: boolean;
  reason?: string;
  kind?: "option_chain" | "perp" | "futures" | "none" | string;
  expiry?: string | null;
  dte?: number | null;
  underlying?: string;
  spot?: number | null;
  rows?: ChainRowRes[];
  atm?: number | null;
  step?: number | null;
  pcr?: number | null;
  maxPain?: number | null;
  ivAtm?: number | null;
  ivRank?: number | null;
  callWall?: number | null;
  putWall?: number | null;
  buildUp?: BuildUpRes | null;
  lotNote?: string;
  notes?: string[];
  // perp
  venue?: string;
  funding?: { rate?: number | null; pct?: number | null; annualizedPct?: number | null; intervalHours?: number | null; nextAt?: string | null } | number | null;
  fundingPct?: number | null;
  fundingAnnualizedPct?: number | null;
  fundingIntervalHours?: number | null;
  nextFundingTime?: string | null;
  markPrice?: number | null;
  premiumPct?: number | null;
  openInterest?: { contracts?: number | null; usd?: number | null; change24hPct?: number | null; window?: string | null } | number | null;
  asOf?: string;
  source?: string;
}

export interface FundamentalsRes {
  available: boolean;
  reason?: string;
  metrics?: { key: string; label: string; value: number | string | null; unit?: string | null; note?: string | null }[];
  asOf?: string;
  source?: string;
  period?: string;
}

export interface ContextRes {
  available: boolean;
  reason?: string;
  items?: { kind: string; label: string; value: number | string | null; note?: string | null }[];
  asOf?: string;
  source?: string;
}

export interface LedgerEntryV2 {
  seq: number;
  type: "issue" | "close";
  signalId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  entryLow: number;
  entryHigh: number;
  stop: number;
  target1: number;
  target2: number;
  exit: number | null;
  outcome: string | null;
  r: number | null;
  at: string;
  prevHash: string;
  hash: string;
  market?: string;
  style?: string;
  strategy?: string;
}

export interface LedgerPage {
  items: LedgerEntryV2[];
  nextCursor: string | null;
}

export interface LedgerHead {
  count: number;
  headHash: string | null;
  asOf: string | null;
}

export interface MarketHealth {
  ok?: boolean;
  lastRunAt?: string | null;
  engine?: { lastRunAt?: string | null; cadenceMin?: number; version?: string } | null;
  cadenceMin?: number;
  sources?: { source: string; ok: boolean; lastSuccessAt: string | null; freshness?: string }[];
  liveSignals?: number;
  ledgerEntries?: number;
}

function pickLedgerItems(r: Raw): LedgerEntryV2[] {
  const arr = (Array.isArray(r.items) ? r.items : Array.isArray(r.entries) ? r.entries : Array.isArray(r.ledger) ? r.ledger : []) as Raw[];
  return arr.filter((e) => typeof e.hash === "string" && typeof e.seq === "number") as unknown as LedgerEntryV2[];
}

export const marketApi = {
  universe: (signal?: AbortSignal) => api<unknown>("/api/v1/market/universe", { signal }),
  health: () => api<MarketHealth>("/api/v1/market/health"),
  candles: (symbol: string, tf: string, limit = 300) => api<CandlesRes>(`/api/v1/market/candles?symbol=${enc(symbol)}&tf=${enc(tf)}&limit=${limit}`),
  depth: (symbol: string) => api<DepthRes>(`/api/v1/market/depth?symbol=${enc(symbol)}`),
  derivatives: (symbol: string) => api<DerivativesRes>(`/api/v1/market/derivatives?symbol=${enc(symbol)}`),
  fundamentals: (symbol: string) => api<FundamentalsRes>(`/api/v1/market/fundamentals?symbol=${enc(symbol)}`),
  context: (symbol: string) => api<ContextRes>(`/api/v1/market/context?symbol=${enc(symbol)}`),
  ledgerHead: () => api<LedgerHead>("/api/v1/market/ledger/head"),
  async ledgerPage(cursor: string | null, limit = 500): Promise<LedgerPage> {
    const r = await api<Raw>(`/api/v1/market/ledger?limit=${limit}${cursor ? `&cursor=${enc(cursor)}` : ""}`);
    const next = str(r.nextCursor) ?? (typeof r.nextCursor === "number" ? String(r.nextCursor) : null) ?? str(r.cursor) ?? null;
    return { items: pickLedgerItems(r), nextCursor: next };
  },
  /** Whole chain, oldest first (bounded). */
  async ledgerAll(max = 5000): Promise<LedgerEntryV2[]> {
    const out: LedgerEntryV2[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let i = 0; i < 20 && out.length < max; i++) {
      const page = await marketApi.ledgerPage(cursor);
      for (const e of page.items) {
        if (seen.has(e.hash)) continue;
        seen.add(e.hash);
        out.push(e);
      }
      if (!page.nextCursor || page.nextCursor === cursor || page.items.length === 0) break;
      cursor = page.nextCursor;
    }
    return out.sort((a, b) => a.seq - b.seq);
  },
};
