// Engine cycle: lifecycle for open signals + (re)evaluation + issuance + ledger + outbox events.
// Runner-safe: depends only on MarketDb (D1 in the Worker, wrangler in Node) and pure modules.
// Hooks are NOT called here: events land in signal_events with notified_at NULL and the Worker
// dispatches them (market/outbox.ts), so runner-issued signals notify users on the next cron.
import type { Candle, EngineView } from "../engine/types";
import { evaluate } from "../engine/engine";
import type { LifecycleSignal, Transition } from "../engine/lifecycle";
import { invalidate, stepLifecycle } from "../engine/lifecycle";
import type { LedgerEntry } from "../engine/ledger";
import { appendEntry, GENESIS_HASH } from "../engine/ledger";
import type { InstrumentDef, SignalEvent } from "./types";
import { BY_SYMBOL, INSTRUMENTS } from "./instruments";
import type { MarketDb, Row, SqlStmt } from "./store";
import { jsonList, parseJson, readCandlesStmt, readSnapshotsStmt, stmt } from "./store";
import type { LoadedData } from "./inputs";
import { auxQuotesFor, buildEngineInput, completedBars, snapshotKeysFor } from "./inputs";

export const OPEN = ["pending", "active", "t1_hit"] as const;

export interface CycleInput {
  now: Date;
  runBy: "cron" | "runner" | "ingest" | "admin";
  /** Symbols to evaluate when they have a new completed bar (or always with force). */
  evaluate: string[];
  force?: boolean;
  /** In-memory bars (engine tf, may include the forming bar) — e.g. freshly fetched Binance klines. */
  memBars?: Record<string, Candle[]>;
  /** Fresh snapshots fetched this run (key -> {json, asOf}); override stored ones. */
  memSnapshots?: Record<string, { json: unknown; asOf: string }>;
  /** Fresh prices fetched this run. */
  memQuotes?: Record<string, { price: number; prevClose: number | null; asOf: string }>;
  /** Lifecycle-step every open signal (default true). */
  lifecycleAll?: boolean;
  /** Feature flag require_signal_approval (read by the caller; defaults to off). */
  requireApproval?: boolean;
}

export interface CycleResult {
  evaluated: string[];
  unchanged: string[];
  issued: string[];
  held: string[];
  sitOut: string[];
  transitions: { symbol: string; type: string; outcome?: string }[];
  events: number;
  ledgerAppended: number;
}

export interface SignalRow {
  id: string;
  symbol: string;
  market: string;
  status: string;
  held: number;
  published: number;
  direction: "LONG" | "SHORT";
  style: string;
  timeframe: string;
  tf_sec: number;
  strategy: string;
  strategy_label: string;
  regime: string;
  confidence: number;
  entry_low: number;
  entry_high: number;
  stop: number;
  stop_current: number;
  target1: number;
  target2: number;
  rr1: number;
  rr2: number;
  decimals: number;
  layers: string;
  layer_notes: string;
  layer_detail: string;
  thesis: string;
  invalidation: string | null;
  issued_at: string;
  issued_bar_t: number;
  expiry_bars: number;
  pending_bars: number;
  bars_elapsed: number;
  checked_through_t: number | null;
  activated_at: string | null;
  t1_at: string | null;
  closed_at: string | null;
  closed_bar_t: number | null;
  outcome: string | null;
  exit_price: number | null;
  r: number | null;
  hold_reason: string | null;
  source: string;
  freshness: string;
  updated_at: string;
}

export function toLifecycle(r: SignalRow): LifecycleSignal {
  return {
    direction: r.direction,
    status: r.status as LifecycleSignal["status"],
    entryLow: r.entry_low,
    entryHigh: r.entry_high,
    stop: r.stop,
    stopCurrent: r.stop_current,
    target1: r.target1,
    target2: r.target2,
    decimals: r.decimals,
    issuedBarT: r.issued_bar_t,
    tfSec: r.tf_sec,
    expiryBars: r.expiry_bars,
    pendingBars: r.pending_bars,
    barsElapsed: r.bars_elapsed,
    checkedThroughT: r.checked_through_t,
    activatedAt: r.activated_at,
    t1At: r.t1_at,
    closedAt: r.closed_at,
    closedBarT: r.closed_bar_t,
    outcome: (r.outcome as LifecycleSignal["outcome"]) ?? null,
    exit: r.exit_price,
    r: r.r,
  };
}

export interface Pending {
  stmts: SqlStmt[];
  events: SignalEvent[];
  ledger: LedgerEntry[];
  head: { seq: number; hash: string };
}

export function eventStmt(e: SignalEvent): SqlStmt {
  return stmt(
    `INSERT INTO signal_events (signal_id, symbol, market, type, direction, at, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    e.signalId,
    e.symbol,
    e.market,
    e.type,
    e.direction,
    e.at,
    e.detail ? JSON.stringify(e.detail) : null,
  );
}

function ledgerStmt(e: LedgerEntry, market: string, style: string, strategy: string): SqlStmt {
  return stmt(
    `INSERT INTO live_ledger (seq, type, signal_id, symbol, market, style, strategy, direction, entry_low, entry_high, stop, target1, target2, exit, outcome, r, at, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    e.seq,
    e.type,
    e.signalId,
    e.symbol,
    market,
    style,
    strategy,
    e.direction,
    e.entryLow,
    e.entryHigh,
    e.stop,
    e.target1,
    e.target2,
    e.exit,
    e.outcome,
    e.r,
    e.at,
    e.prevHash,
    e.hash,
  );
}

/** Append a ledger entry for a signal row (issue or close) and queue its INSERT. */
export async function queueLedger(p: Pending, r: Pick<SignalRow, "id" | "symbol" | "market" | "style" | "strategy" | "direction" | "entry_low" | "entry_high" | "stop" | "target1" | "target2">, type: "issue" | "close", at: string, close?: { exit: number | null; outcome: string; r: number | null }): Promise<void> {
  const e = await appendEntry(p.head, {
    type,
    signalId: r.id,
    symbol: r.symbol,
    direction: r.direction,
    entryLow: r.entry_low,
    entryHigh: r.entry_high,
    stop: r.stop,
    target1: r.target1,
    target2: r.target2,
    exit: close ? close.exit : null,
    outcome: close ? close.outcome : null,
    r: close ? close.r : null,
    at,
  });
  p.head = { seq: e.seq, hash: e.hash };
  p.ledger.push(e);
  p.stmts.push(ledgerStmt(e, r.market, r.style, r.strategy));
}

export function lifecycleUpdateStmt(id: string, s: LifecycleSignal, now: string, closeReason: string | null = null): SqlStmt {
  return stmt(
    `UPDATE live_signals SET status = ?, stop_current = ?, bars_elapsed = ?, checked_through_t = ?, activated_at = ?, t1_at = ?, closed_at = ?, closed_bar_t = ?,
       outcome = ?, exit_price = ?, r = ?, close_reason = COALESCE(?, close_reason), updated_at = ? WHERE id = ?`,
    s.status,
    s.stopCurrent,
    s.barsElapsed,
    s.checkedThroughT,
    s.activatedAt,
    s.t1At,
    s.closedAt,
    s.closedBarT,
    s.outcome,
    s.exit,
    s.r,
    closeReason,
    now,
    id,
  );
}

/** Queue events (+ ledger close entry when published) for lifecycle transitions. */
export async function applyTransitions(p: Pending, row: SignalRow, ts: Transition[], next: LifecycleSignal, extraDetail: Record<string, unknown> = {}): Promise<void> {
  for (const t of ts) {
    const base = { signalId: row.id, symbol: row.symbol, market: row.market, direction: row.direction, at: t.at };
    if (t.type === "activated") p.events.push({ ...base, type: "activated", detail: { price: t.price, ...extraDetail } });
    else if (t.type === "t1_hit") p.events.push({ ...base, type: "t1_hit", detail: { price: t.price, stopMovedTo: next.stopCurrent, ...extraDetail } });
    else if (t.type === "closed") {
      const type = t.outcome === "invalidated" ? "invalidated" : "closed";
      p.events.push({ ...base, type, detail: { outcome: t.outcome, exit: t.exit ?? null, r: t.r ?? null, filled: t.filled ?? null, ...extraDetail } });
      if (row.published) await queueLedger(p, row, "close", t.at, { exit: t.exit ?? null, outcome: t.outcome as string, r: t.r ?? null });
    }
  }
}

function sigId(symbol: string, now: Date): string {
  const iso = now.toISOString(); // 2026-11-10T17:15:00.000Z
  return `SIG-${symbol}-${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}

export async function readFlag(db: MarketDb, key: string, fallback: boolean): Promise<boolean> {
  try {
    const [rows] = await db.read([stmt(`SELECT enabled FROM feature_flags WHERE key = ?`, key)]);
    const r = rows?.[0];
    return r ? Number(r.enabled) === 1 : fallback;
  } catch {
    return fallback; // table not created yet (0001 not applied) => treat as default
  }
}

export async function readHead(db: MarketDb): Promise<{ seq: number; hash: string }> {
  const [rows] = await db.read([stmt(`SELECT seq, hash FROM live_ledger ORDER BY seq DESC LIMIT 1`)]);
  const r = rows?.[0];
  return r ? { seq: Number(r.seq), hash: String(r.hash) } : { seq: 0, hash: GENESIS_HASH };
}

/** Run one engine cycle. Writes everything in ONE batch at the end. */
export async function runCycle(db: MarketDb, input: CycleInput): Promise<CycleResult> {
  const now = input.now;
  const nowIso = now.toISOString();
  const nowSec = Math.floor(now.getTime() / 1000);
  const evalDefs = input.evaluate.map((s) => BY_SYMBOL.get(s)).filter((x): x is InstrumentDef => !!x);

  // ---------- read state (one round trip)
  const [openRows, enabledRows, stateRows, stratRows, headRows, closedRows] = await db.read([
    stmt(`SELECT * FROM live_signals WHERE status IN ('pending', 'active', 't1_hit')`),
    stmt(`SELECT symbol, enabled FROM instruments`),
    stmt(`SELECT symbol, last_bar_t FROM engine_state WHERE symbol IN (SELECT value FROM json_each(?))`, jsonList(evalDefs.map((i) => i.symbol))),
    stmt(`SELECT strategy, market, enabled FROM strategies`),
    stmt(`SELECT seq, hash FROM live_ledger ORDER BY seq DESC LIMIT 1`),
    stmt(
      `SELECT symbol, MAX(closed_bar_t) AS closed_bar_t FROM live_signals WHERE status = 'closed' AND symbol IN (SELECT value FROM json_each(?)) GROUP BY symbol`,
      jsonList(evalDefs.map((i) => i.symbol)),
    ),
  ]);
  const open = (openRows ?? []) as unknown as SignalRow[];
  const disabledInst = new Set((enabledRows ?? []).filter((r) => Number(r.enabled) === 0).map((r) => String(r.symbol)));
  const lastBarT = new Map((stateRows ?? []).map((r) => [String(r.symbol), r.last_bar_t === null ? null : Number(r.last_bar_t)]));
  const stratOn = new Map((stratRows ?? []).map((r) => [`${r.strategy}|${r.market}`, Number(r.enabled) === 1]));
  const lastClosedBar = new Map((closedRows ?? []).map((r) => [String(r.symbol), r.closed_bar_t === null ? null : Number(r.closed_bar_t)]));
  const h0 = headRows?.[0];
  const p: Pending = { stmts: [], events: [], ledger: [], head: h0 ? { seq: Number(h0.seq), hash: String(h0.hash) } : { seq: 0, hash: GENESIS_HASH } };

  const lifeDefs = (input.lifecycleAll ?? true) ? open.map((r) => BY_SYMBOL.get(r.symbol)).filter((x): x is InstrumentDef => !!x) : [];
  const evalActive = evalDefs.filter((i) => !disabledInst.has(i.symbol));
  const need = new Map<string, InstrumentDef>();
  for (const i of [...evalActive, ...lifeDefs]) need.set(i.symbol, i);

  // ---------- data reads: snapshots, quotes, bars (one round trip)
  const keys = new Set<string>();
  const qsyms = new Set<string>();
  for (const i of need.values()) {
    for (const k of snapshotKeysFor(i)) keys.add(k);
    for (const q of auxQuotesFor(i)) qsyms.add(q);
  }
  // full history only for instruments we evaluate (+ their benchmark); open signals elsewhere only
  // need the bars after their issue bar (one join query).
  const barNeed = new Map<string, string[]>(); // tf -> symbols
  const evalSet = new Set(evalActive.map((i) => i.symbol));
  for (const i of evalActive) {
    if (!input.memBars?.[i.symbol]) barNeed.set(i.tf, [...(barNeed.get(i.tf) ?? []), i.symbol]);
    if (i.benchmark && !evalSet.has(i.benchmark) && !input.memBars?.[i.benchmark]) {
      const a = barNeed.get("1D") ?? [];
      if (!a.includes(i.benchmark)) barNeed.set("1D", [...a, i.benchmark]);
    }
  }
  const lifeOnly = open.filter((r) => !evalSet.has(r.symbol) && !input.memBars?.[r.symbol]).map((r) => [r.symbol, r.timeframe, r.issued_bar_t]);
  const tfs = [...barNeed.keys()];
  const reads: SqlStmt[] = [
    readSnapshotsStmt([...keys]),
    stmt(`SELECT symbol, price, prev_close, as_of FROM quotes WHERE symbol IN (SELECT value FROM json_each(?))`, jsonList([...qsyms])),
    stmt(
      `SELECT c.symbol AS symbol, c.t AS t, c.o AS o, c.h AS h, c.l AS l, c.c AS c, c.v AS v FROM candles c
       JOIN json_each(?) j ON c.symbol = json_extract(j.value, '$[0]') AND c.tf = json_extract(j.value, '$[1]') AND c.t > json_extract(j.value, '$[2]')
       ORDER BY c.symbol, c.t`,
      JSON.stringify(lifeOnly),
    ),
  ];
  for (const tf of tfs) reads.push(readCandlesStmt(barNeed.get(tf) ?? [], tf, 400));
  const res = await db.read(reads);
  const data: LoadedData = { snapshots: new Map(), quotes: new Map(), bars: new Map() };
  for (const r of res[0] ?? []) data.snapshots.set(String(r.key), { json: parseJson(r.json, null), asOf: String(r.as_of) });
  for (const r of res[1] ?? []) data.quotes.set(String(r.symbol), { price: Number(r.price), prevClose: r.prev_close === null ? null : Number(r.prev_close), asOf: String(r.as_of) });
  for (let k = 2; k < res.length; k++) {
    for (const r of res[k] ?? []) {
      const s = String(r.symbol);
      let a = data.bars.get(s);
      if (!a) data.bars.set(s, (a = []));
      a.push({ t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) });
    }
  }
  for (const [s, b] of Object.entries(input.memBars ?? {})) data.bars.set(s, b);
  for (const [k, v] of Object.entries(input.memSnapshots ?? {})) data.snapshots.set(k, v);
  for (const [s, q] of Object.entries(input.memQuotes ?? {})) data.quotes.set(s, q);

  const out: CycleResult = { evaluated: [], unchanged: [], issued: [], held: [], sitOut: [], transitions: [], events: 0, ledgerAppended: 0 };
  const priceOf = (i: InstrumentDef): number | null => {
    const q = data.quotes.get(i.symbol);
    if (q && q.price > 0) return q.price;
    const b = data.bars.get(i.symbol);
    return b && b.length ? (b[b.length - 1] as Candle).c : null;
  };

  // ---------- lifecycle for every open signal
  const stillOpen = new Set<string>();
  for (const row of open) {
    const i = BY_SYMBOL.get(row.symbol);
    if (!i) continue;
    const bars = (data.bars.get(row.symbol) ?? []).filter((b) => b.t > row.issued_bar_t);
    const { signal: next, transitions } = stepLifecycle(toLifecycle(row), bars, priceOf(i), nowSec);
    const changed = transitions.length > 0 || next.barsElapsed !== row.bars_elapsed || next.checkedThroughT !== row.checked_through_t;
    if (changed) p.stmts.push(lifecycleUpdateStmt(row.id, next, nowIso));
    await applyTransitions(p, row, transitions, next);
    for (const t of transitions) out.transitions.push({ symbol: row.symbol, type: t.type, outcome: t.outcome });
    if (next.status === "closed") lastClosedBar.set(row.symbol, Math.max(lastClosedBar.get(row.symbol) ?? 0, next.closedBarT ?? nowSec));
    else stillOpen.add(row.symbol);
  }

  // ---------- evaluation + issuance
  for (const i of evalActive) {
    const all = data.bars.get(i.symbol) ?? [];
    const done = completedBars(i, all, nowSec);
    const barT = done.length ? (done[done.length - 1] as Candle).t : null;
    if (!input.force && barT !== null && lastBarT.get(i.symbol) === barT) {
      out.unchanged.push(i.symbol);
      continue;
    }
    const price = priceOf(i) ?? (done.length ? (done[done.length - 1] as Candle).c : 0);
    const view: EngineView & { evaluatedAt?: string; blockedBy?: string | null } = evaluate(buildEngineInput(i, done, price, data, nowSec));
    view.evaluatedAt = nowIso;
    view.blockedBy = null;
    out.evaluated.push(i.symbol);
    if (view.decision === "trade" && view.levels && view.direction) {
      const closedBar = lastClosedBar.get(i.symbol) ?? null;
      const strategyEnabled = stratOn.get(`${view.strategy}|${i.market}`) ?? true;
      if (stillOpen.has(i.symbol)) {
        view.blockedBy = "open_signal";
      } else if (closedBar !== null && barT !== null && barT <= closedBar) {
        downgrade(view, "cooldown", "Cooling down: the last call on this instrument closed during the current bar. A new call needs at least one more completed bar.");
      } else if (!strategyEnabled) {
        downgrade(view, "strategy_disabled", `The ${view.strategyLabel ?? "strategy"} is paused for ${i.market} by the risk desk, so no new call is published.`);
      } else {
        const id = sigId(i.symbol, now);
        const lv = view.levels;
        const inZone = price >= lv.entryLow && price <= lv.entryHigh;
        const status = !lv.pending && inZone ? "active" : "pending";
        const held = input.requireApproval ? 1 : 0;
        const row: SignalRow = {
          id,
          symbol: i.symbol,
          market: i.market,
          status,
          held,
          published: held ? 0 : 1,
          direction: view.direction,
          style: i.style,
          timeframe: i.tf,
          tf_sec: i.tfSec,
          strategy: view.strategy as string,
          strategy_label: view.strategyLabel as string,
          regime: view.regime,
          confidence: view.confidence as number,
          entry_low: lv.entryLow,
          entry_high: lv.entryHigh,
          stop: lv.stop,
          stop_current: lv.stop,
          target1: lv.target1,
          target2: lv.target2,
          rr1: lv.rr1,
          rr2: lv.rr2,
          decimals: lv.entryLow < 1 ? Math.max(i.decimals, 4) : i.decimals,
          layers: JSON.stringify(view.layers),
          layer_notes: JSON.stringify(view.layerNotes),
          layer_detail: JSON.stringify(view.layerDetail),
          thesis: view.thesis,
          invalidation: view.invalidation,
          issued_at: nowIso,
          issued_bar_t: barT as number,
          expiry_bars: i.expiryBars,
          pending_bars: i.pendingBars,
          bars_elapsed: 0,
          checked_through_t: null,
          activated_at: status === "active" ? nowIso : null,
          t1_at: null,
          closed_at: null,
          closed_bar_t: null,
          outcome: null,
          exit_price: null,
          r: null,
          hold_reason: held ? "approval_required" : null,
          source: i.source,
          freshness: i.freshness,
          updated_at: nowIso,
        };
        p.stmts.push(insertSignalStmt(row, input.runBy));
        const detail = { status, entryLow: lv.entryLow, entryHigh: lv.entryHigh, stop: lv.stop, target1: lv.target1, target2: lv.target2, confidence: view.confidence, strategy: view.strategy, engine: "v0", calibrated: false };
        if (held) {
          p.events.push({ type: "held", signalId: id, symbol: i.symbol, market: i.market, direction: view.direction, at: nowIso, detail: { ...detail, reason: "approval_required" } });
          out.held.push(i.symbol);
        } else {
          p.events.push({ type: "issued", signalId: id, symbol: i.symbol, market: i.market, direction: view.direction, at: nowIso, detail });
          await queueLedger(p, row, "issue", nowIso);
          out.issued.push(i.symbol);
        }
        (view as EngineView & { signalId?: string }).signalId = id;
      }
    }
    if (view.decision === "sit_out") out.sitOut.push(i.symbol);
    p.stmts.push(
      stmt(
        `INSERT OR REPLACE INTO engine_state (symbol, last_bar_t, evaluated_at, view, run_by) VALUES (?, ?, ?, ?, ?)`,
        i.symbol,
        barT,
        nowIso,
        JSON.stringify(view),
        input.runBy,
      ),
    );
  }

  for (const e of p.events) p.stmts.push(eventStmt(e));
  if (p.ledger.length) p.stmts.push(stmt(`INSERT OR REPLACE INTO snapshots (key, json, as_of, source, updated_at) VALUES ('meta:ledger_head', ?, ?, 'engine', ?)`, JSON.stringify(p.head), nowIso, nowIso));
  p.stmts.push(stmt(`INSERT OR REPLACE INTO snapshots (key, json, as_of, source, updated_at) VALUES ('meta:engine_run', ?, ?, 'engine', ?)`, JSON.stringify({ runBy: input.runBy, evaluated: out.evaluated.length, issued: out.issued.length, transitions: out.transitions.length }), nowIso, nowIso));
  await db.write(p.stmts);
  out.events = p.events.length;
  out.ledgerAppended = p.ledger.length;
  return out;
}

function downgrade(v: EngineView & { blockedBy?: string | null }, reason: "cooldown" | "strategy_disabled", thesis: string): void {
  v.decision = "sit_out";
  v.sitOutReason = reason;
  v.thesis = thesis;
  v.direction = null;
  v.confidence = null;
  v.levels = null;
  v.invalidation = null;
}

function insertSignalStmt(r: SignalRow, runBy: string): SqlStmt {
  const cols: (keyof SignalRow)[] = [
    "id", "symbol", "market", "status", "held", "hold_reason", "published", "direction", "style", "timeframe", "tf_sec", "strategy", "strategy_label",
    "regime", "confidence", "entry_low", "entry_high", "stop", "stop_current", "target1", "target2", "rr1", "rr2", "decimals", "layers", "layer_notes",
    "layer_detail", "thesis", "invalidation", "issued_at", "issued_bar_t", "expiry_bars", "pending_bars", "bars_elapsed", "checked_through_t",
    "activated_at", "source", "freshness", "updated_at",
  ];
  return stmt(
    `INSERT INTO live_signals (${cols.join(", ")}, engine, calibrated, issued_by) VALUES (${cols.map(() => "?").join(", ")}, 'v0', 0, ?)`,
    ...cols.map((c) => r[c] as string | number | null),
    runBy,
  );
}

/* ---------------- admin-triggered changes (shared with market/admin.ts) ---------------- */

export async function loadSignal(db: MarketDb, id: string): Promise<SignalRow | null> {
  const [rows] = await db.read([stmt(`SELECT * FROM live_signals WHERE id = ?`, id)]);
  return ((rows?.[0] as unknown) as SignalRow) ?? null;
}

export async function holdSignal(db: MarketDb, id: string, hold: boolean, actor: string, reason: string, now: Date): Promise<{ ok: boolean; error?: string }> {
  const row = await loadSignal(db, id);
  if (!row) return { ok: false, error: "not_found" };
  if (row.status === "closed") return { ok: false, error: "already_closed" };
  if (Boolean(row.held) === hold) return { ok: true };
  const nowIso = now.toISOString();
  const p: Pending = { stmts: [], events: [], ledger: [], head: await readHead(db) };
  p.stmts.push(stmt(`UPDATE live_signals SET held = ?, hold_reason = ?, updated_at = ? WHERE id = ?`, hold ? 1 : 0, hold ? reason.slice(0, 300) : null, nowIso, id));
  p.events.push({ type: hold ? "held" : "released", signalId: id, symbol: row.symbol, market: row.market, direction: row.direction, at: nowIso, detail: { actor, reason: reason.slice(0, 300) } });
  if (!hold && !row.published) {
    // first publication: the "issue" ledger entry is written when users can first see the signal
    await queueLedger(p, row, "issue", nowIso);
    p.stmts.push(stmt(`UPDATE live_signals SET published = 1 WHERE id = ?`, id));
    p.events.push({ type: "issued", signalId: id, symbol: row.symbol, market: row.market, direction: row.direction, at: nowIso, detail: { released: true, entryLow: row.entry_low, entryHigh: row.entry_high, stop: row.stop, target1: row.target1, target2: row.target2, confidence: row.confidence, engine: "v0", calibrated: false } });
  }
  for (const e of p.events) p.stmts.push(eventStmt(e));
  await db.write(p.stmts);
  return { ok: true };
}

export async function invalidateSignalRow(db: MarketDb, id: string, actor: string, reason: string, now: Date): Promise<{ ok: boolean; error?: string }> {
  const row = await loadSignal(db, id);
  if (!row) return { ok: false, error: "not_found" };
  if (row.status === "closed") return { ok: false, error: "already_closed" };
  const [q] = await db.read([stmt(`SELECT price FROM quotes WHERE symbol = ?`, row.symbol)]);
  const price = q?.[0] ? Number(q[0].price) : null;
  const nowIso = now.toISOString();
  const { signal: next, transitions } = invalidate(toLifecycle(row), price, Math.floor(now.getTime() / 1000));
  const p: Pending = { stmts: [], events: [], ledger: [], head: await readHead(db) };
  p.stmts.push(lifecycleUpdateStmt(id, next, nowIso, `invalidated by ${actor}: ${reason}`.slice(0, 300)));
  await applyTransitions(p, row, transitions, next, { actor, reason: reason.slice(0, 300) });
  for (const e of p.events) p.stmts.push(eventStmt(e));
  await db.write(p.stmts);
  return { ok: true };
}

export function defsFor(market?: string): InstrumentDef[] {
  return market ? INSTRUMENTS.filter((i) => i.market === market) : INSTRUMENTS;
}

export type { Row };
