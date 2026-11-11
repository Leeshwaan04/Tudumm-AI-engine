// GET /api/v1/market/universe — the seed.json shape with live data.
import type { EngineView } from "../engine/types";
import { GENESIS_HASH } from "../engine/ledger";
import { INSTRUMENTS, LAYERS, MARKETS, nseSessionOpen, servedFreshness } from "./instruments";
import type { InstrumentDef } from "./types";
import type { MarketDb, Row } from "./store";
import { parseJson, stmt } from "./store";
import type { SignalRow } from "./service";

const STALE_SEC: Record<string, number> = { realtime: 1800, "delayed-15m": 4 * 86400, eod: 6 * 86400, "daily-ref": 6 * 86400 };

/** Realtime India quotes are stale after 2 min without a push during the NSE session; outside it, the
 *  last session's close stays valid over weekends and short holidays. */
function isStale(i: InstrumentDef, freshness: string, asOf: string | null, now: number): boolean {
  if (!asOf) return true;
  const age = (now - Date.parse(asOf)) / 1000;
  if (i.market === "IN" && freshness === "realtime") return nseSessionOpen(now) ? age > 120 : age > 4 * 86400;
  return age > (STALE_SEC[freshness] ?? 86400);
}

export function ledgerOut(r: Row) {
  return {
    seq: Number(r.seq),
    type: String(r.type),
    signalId: String(r.signal_id),
    symbol: String(r.symbol),
    market: String(r.market),
    style: String(r.style),
    strategy: String(r.strategy),
    direction: String(r.direction),
    entryLow: Number(r.entry_low),
    entryHigh: Number(r.entry_high),
    stop: Number(r.stop),
    target1: Number(r.target1),
    target2: Number(r.target2),
    exit: r.exit === null ? null : Number(r.exit),
    outcome: r.outcome === null ? null : String(r.outcome),
    r: r.r === null ? null : Number(r.r),
    at: String(r.at),
    prevHash: String(r.prev_hash),
    hash: String(r.hash),
  };
}

const minsAgo = (iso: string, now: number) => Math.max(0, Math.round((now - Date.parse(iso)) / 60000));

export function publicSignal(r: SignalRow, now: number) {
  const base = {
    id: r.id,
    symbol: r.symbol,
    status: r.status,
    regime: r.regime,
    issuedMinutesAgo: minsAgo(r.issued_at, now),
    issuedAt: r.issued_at,
    layers: parseJson(r.layers, {}),
    layerNotes: parseJson(r.layer_notes, {}),
    layerDetail: parseJson(r.layer_detail, {}),
    thesis: r.thesis,
    invalidation: r.invalidation,
    direction: r.direction,
    style: r.style,
    timeframe: r.timeframe,
    strategy: r.strategy_label,
    strategyKey: r.strategy,
    confidence: r.confidence,
    entryLow: r.entry_low,
    entryHigh: r.entry_high,
    stop: r.stop,
    stopCurrent: r.stop_current,
    target1: r.target1,
    target2: r.target2,
    rr1: r.rr1,
    rr2: r.rr2,
    activatedAt: r.activated_at,
    t1At: r.t1_at,
    barsElapsed: r.bars_elapsed,
    expiryBars: r.expiry_bars,
    engine: "v0" as const,
    calibrated: false as const,
    live: true as const,
  };
  if (r.status !== "closed") return base;
  return { ...base, outcome: r.outcome, exitPrice: r.exit_price, r: r.r, closedAt: r.closed_at };
}

type View = EngineView & { evaluatedAt?: string };

function sitOutSignal(i: InstrumentDef, view: View | null, now: number, over?: { reason: string; thesis: string }, lastClosed?: SignalRow | null) {
  const at = view?.evaluatedAt ?? new Date(now).toISOString();
  return {
    id: `SIT-${i.symbol}-${view?.barT ?? 0}`,
    symbol: i.symbol,
    status: "sit_out" as const,
    regime: view?.regime ?? "range",
    issuedMinutesAgo: minsAgo(at, now),
    issuedAt: at,
    layers: view?.layers ?? { price: null, flow: null, derivatives: null, fundamentals: null, context: null },
    layerNotes: view?.layerNotes ?? {},
    layerDetail: view?.layerDetail ?? {},
    thesis: over?.thesis ?? view?.thesis ?? "No market data has been ingested for this instrument yet.",
    invalidation: null,
    direction: null,
    confidence: null,
    style: i.style,
    timeframe: i.tf,
    sitOutReason: over?.reason ?? view?.sitOutReason ?? "no_data",
    candidate: view?.candidate ?? null,
    lastClosed: lastClosed ? { id: lastClosed.id, outcome: lastClosed.outcome, r: lastClosed.r, closedAt: lastClosed.closed_at } : null,
    engine: "v0" as const,
    calibrated: false as const,
    live: true as const,
  };
}

const OUTCOME_WORD: Record<string, string> = { target: "hit target 2", trailed: "was stopped at breakeven after T1", stopped: "was stopped out", expired: "expired", invalidated: "was withdrawn" };

export async function buildUniverse(db: MarketDb, now = Date.now()) {
  const [quotes, states, open, recent, ledger, enabled] = await db.read([
    stmt(`SELECT symbol, price, prev_close, change_pct, as_of, source FROM quotes`),
    stmt(`SELECT symbol, evaluated_at, view FROM engine_state`),
    stmt(`SELECT * FROM live_signals WHERE status IN ('pending', 'active', 't1_hit')`),
    stmt(
      `SELECT * FROM live_signals s WHERE status = 'closed' AND published = 1 AND closed_at = (SELECT MAX(closed_at) FROM live_signals x WHERE x.symbol = s.symbol AND x.status = 'closed' AND x.published = 1)`,
    ),
    stmt(`SELECT * FROM (SELECT * FROM live_ledger ORDER BY seq DESC LIMIT 200) ORDER BY seq`),
    stmt(`SELECT symbol, enabled FROM instruments`),
  ]);
  const q = new Map((quotes ?? []).map((r) => [String(r.symbol), r]));
  const st = new Map((states ?? []).map((r) => [String(r.symbol), { at: String(r.evaluated_at), view: parseJson<View | null>(r.view, null) }]));
  const op = new Map(((open ?? []) as unknown as SignalRow[]).map((r) => [r.symbol, r]));
  const lc = new Map(((recent ?? []) as unknown as SignalRow[]).map((r) => [r.symbol, r]));
  const off = new Set((enabled ?? []).filter((r) => Number(r.enabled) === 0).map((r) => String(r.symbol)));

  const instruments = INSTRUMENTS.filter((i) => !off.has(i.symbol)).map((i) => {
    const qr = q.get(i.symbol);
    const asOf = qr ? String(qr.as_of) : null;
    const freshness = servedFreshness(i, qr ? String(qr.source) : null);
    const stale = isStale(i, freshness, asOf, now);
    const s = st.get(i.symbol);
    const o = op.get(i.symbol);
    const closed = lc.get(i.symbol) ?? null;
    let signal;
    if (o && !o.held) signal = publicSignal(o, now);
    else if (o && o.held) signal = sitOutSignal(i, s?.view ?? null, now, { reason: "under_review", thesis: "A new setup is under review and isn't published yet." });
    else if (closed && (!s || Date.parse(String(closed.closed_at)) >= Date.parse(s.at))) {
      signal = sitOutSignal(i, s?.view ?? null, now, {
        reason: "closed",
        thesis: `The last ${closed.direction} call ${OUTCOME_WORD[closed.outcome ?? ""] ?? "closed"} (${(closed.r ?? 0) >= 0 ? "+" : ""}${closed.r ?? 0}R). Waiting for the next completed ${i.tf} bar before a new call.`,
      }, closed);
    } else signal = sitOutSignal(i, s?.view ?? null, now, undefined, closed);
    return {
      symbol: i.symbol,
      name: i.name,
      exchange: i.exchange,
      market: i.market,
      assetClass: i.assetClass,
      currency: i.currency,
      decimals: i.decimals,
      price: qr ? Number(qr.price) : null,
      prevClose: qr && qr.prev_close !== null ? Number(qr.prev_close) : null,
      aliases: i.aliases,
      changePct: qr && qr.change_pct !== null ? Number(qr.change_pct) : null,
      // The venue that actually served the latest quote (e.g. Bybit when Binance refuses our egress).
      source: qr && qr.source ? String(qr.source) : i.source,
      proxyNote: qr && String(qr.source) === "bybit" && i.symbol === "XAUUSD" ? "XAUT (Tether Gold) on Bybit — tokenized gold used as a proxy for spot gold" : i.proxyNote,
      freshness,
      asOf,
      stale,
      hasData: !!qr,
      ohlc: i.ohlc,
      live: true,
      engine: "v0",
      calibrated: false,
      signal,
    };
  });
  const iso = new Date(now).toISOString();
  return {
    meta: {
      product: "Tudumm",
      version: 2,
      simulated: false,
      live: true,
      engine: "v0",
      calibrated: false,
      note: "Live market data from free public sources (realtime, 15-min delayed, end-of-day or daily reference, as marked per instrument). Engine v0 is rule-based and its confidence is uncalibrated. Not investment advice.",
      generatedFor: iso.slice(0, 10),
      generatedAt: iso,
      ledgerVersion: 2,
      ledgerHash: "sha256(JSON.stringify([prevHash,seq,type,signalId,symbol,direction,entryLow,entryHigh,stop,target1,target2,exit,outcome,r,at]))",
      ledgerGenesisPrevHash: GENESIS_HASH,
    },
    markets: MARKETS,
    layers: LAYERS,
    instruments,
    ledger: (ledger ?? []).map(ledgerOut),
  };
}
