// Walk-forward backtest of engine v0 on the cached NSE EOD archive (runner/.cache/nse/day-*.json).
//
// It replays history one trading day at a time through the SAME code production runs:
//   1. the nse-eod runner batch for that day (candles, quotes, ctx:IN India VIX history, fund:NIFTY/BANKNIFTY P/E
//      history), built like runner/jobs/nse.ts:113-170 (that logic lives inside nseEod() with network + D1
//      side effects, so the per-day batch assembly is mirrored here line for line; mergeHist is copied from nse.ts:204);
//   2. written with the production store.ts upserts (upsertCandles, pruneCandles(400), upsertQuotes, upsertSnapshots),
//      exactly like runner/main.ts commit(), into an in-memory SQLite copy of the D1 schema (0002_market.sql);
//   3. the production market/service.ts runCycle (unmodified): lifecycle for open signals (stepLifecycle over the
//      bars after the issue bar + the latest quote), then completedBars -> buildEngineInput -> evaluate and the
//      issuance rules (one open signal per symbol, cooldown after a close, strategy kill switch, pending vs active by
//      entry zone), ledger hash chain and events.
// Nothing in worker/src is re-implemented. On day d the DB only holds bars, quotes and snapshots up to d's close,
// and the cycle runs at d 14:00 UTC (19:30 IST, after the bhavcopy is published), so the engine cannot see the
// future and fills/exits only ever use bars after the issue bar.
//
// What is NOT replayed: the derivatives layer (only one F&O bhavcopy is cached, so deriv:SYM snapshots are never
// written and that layer is null, exactly as production behaves when the snapshot is missing or > 7 days old).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Candle, EngineView } from "../../worker/src/engine/types.ts";
import type { CmRow, IndexRow } from "../../worker/src/data/nse.ts";
import { isoDateToT, ymdToT } from "../../worker/src/data/nse.ts";
import { INSTRUMENTS } from "../../worker/src/market/instruments.ts";
import type { IndexFundSnapshot, VixHistorySnapshot } from "../../worker/src/market/snapshots.ts";
import { jsonList, pruneCandles, stmt, upsertCandles, upsertQuotes, upsertSnapshots } from "../../worker/src/market/store.ts";
import type { SignalRow } from "../../worker/src/market/service.ts";
import { runCycle } from "../../worker/src/market/service.ts";
import { roundTo } from "../../worker/src/engine/util.ts";
import { emptyBatch, ROOT } from "../lib/sink.ts";
import { MemDb } from "../lib/memdb.ts";
import type { BootCI, TTest } from "../lib/stats.ts";
import { bootstrapMean, clusterBootstrapMean, mean, mulberry32, spearman, tTest } from "../lib/stats.ts";

/* ---------------- options ---------------- */

export interface Opts {
  cacheDir: string;
  runUtcSec: number;
  out: string | null;
  trades: boolean;
  seed: number;
  boot: number;
  eqSlip: number; // per side, fraction of notional
  idxSide: number; // all-in per side for the index proxy, fraction of notional
}

function parseOpts(argv: string[]): Opts {
  const o: Opts = {
    cacheDir: join(ROOT, "runner", ".cache", "nse"),
    runUtcSec: 14 * 3600,
    out: null,
    trades: false,
    seed: 20261111,
    boot: 10000,
    eqSlip: 0.0005,
    idxSide: 0.0005,
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i] as string;
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${x} needs a value`);
      return v;
    };
    if (x === "--out") o.out = resolve(val());
    else if (x === "--cache") o.cacheDir = resolve(val());
    else if (x === "--trades") o.trades = true;
    else if (x === "--seed") o.seed = Number(val());
    else if (x === "--boot") o.boot = Math.max(1000, Number(val()));
    else if (x === "--slip") o.eqSlip = Number(val()) / 100;
    else if (x === "--idx-cost") o.idxSide = Number(val()) / 100;
    else if (x === "--run-utc") {
      const m = /^(\d{1,2}):(\d{2})$/.exec(val());
      if (!m) throw new Error("--run-utc must be HH:MM (HH may exceed 23 for a run after midnight UTC)");
      o.runUtcSec = Number(m[1]) * 3600 + Number(m[2]) * 60;
    } else throw new Error(`unknown argument ${x}`);
  }
  if (o.runUtcSec < 37800 || o.runUtcSec >= 86400 + 13500) {
    throw new Error("--run-utc must be between 10:30 (the NSE daily bar is final at 16:00 IST) and 27:44 (= 03:44 UTC next day, before the 09:15 IST open)");
  }
  if (!Number.isFinite(o.eqSlip) || o.eqSlip < 0 || !Number.isFinite(o.idxSide) || o.idxSide < 0) throw new Error("costs must be >= 0");
  return o;
}

/* ---------------- costs ---------------- */

export interface CostModel {
  kind: "equity" | "index";
  label: string;
  perSide: number; // fraction of notional charged on entry AND on exit
  detail: string;
}

function costModels(o: Opts): Record<"equity" | "index", CostModel> {
  const stt = 0.001; // 0.1% delivery STT on the buy and on the sell
  const charges = 0.0001; // exchange txn + SEBI + stamp ~ 0.02% per round trip
  const gst = 0.18 * charges; // 18% GST, conservatively on the whole bucket (stamp duty is actually GST-exempt)
  return {
    equity: {
      kind: "equity",
      label: "NSE cash delivery via Zerodha",
      perSide: stt + charges + gst + o.eqSlip,
      detail:
        `STT 0.100% + exch/SEBI/stamp 0.010% + GST 0.0018% + brokerage 0 + slippage ${(o.eqSlip * 100).toFixed(3)}% = ` +
        `${((stt + charges + gst + o.eqSlip) * 100).toFixed(4)}% per side, ${((stt + charges + gst + o.eqSlip) * 200).toFixed(4)}% per round trip. ` +
        `DP charge (~Rs 15.34 + GST per scrip per sell day) is fixed per trade and not included.`,
    },
    index: {
      kind: "index",
      label: "NIFTY/BANKNIFTY proxy: index futures (or NIFTYBEES/BANKBEES ETF for longs)",
      perSide: o.idxSide,
      detail:
        `${(o.idxSide * 100).toFixed(3)}% per side, ${(o.idxSide * 200).toFixed(3)}% per round trip, all-in: futures STT (sell side only), ` +
        `exchange/SEBI/stamp/GST, Rs 20/order brokerage on a 10-20 lakh lot, ~0.02% slippage per side. NOT modelled: futures cost of carry ` +
        `(~5%/yr of notional against longs, in favour of shorts), monthly roll, ETF tracking error.`,
    },
  };
}

/* ---------------- data ---------------- */

const IN = INSTRUMENTS.filter((i) => i.market === "IN");
const IN_SYMBOLS = IN.map((i) => i.symbol);
const STOCKS = new Set(IN.filter((i) => i.assetClass === "equity").map((i) => i.dataSymbol));
const BY_INDEX: Record<string, string> = { "Nifty 50": "NIFTY", "Nifty Bank": "BANKNIFTY" };
const KIND = new Map(IN.map((i) => [i.symbol, i.assetClass === "index" ? ("index" as const) : ("equity" as const)]));

interface DayFile {
  ymd: string;
  date: string; // YYYY-MM-DD
  cm: CmRow[];
  idx: IndexRow[];
}

function loadDays(dir: string): { days: DayFile[]; holidays: string[]; noIndex: string[] } {
  const files = readdirSync(dir).filter((f: string) => /^day-\d{8}\.json$/.test(f)).sort();
  const days: DayFile[] = [];
  const holidays: string[] = [];
  const noIndex: string[] = [];
  for (const f of files) {
    const ymd = f.slice(4, 12);
    const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as { cm: CmRow[] | null; idx: IndexRow[] | null };
    if (!j.cm || !j.cm.length) {
      holidays.push(ymd);
      continue;
    }
    if (!j.idx || !j.idx.length) noIndex.push(ymd);
    const date = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
    // look-ahead guard: every row in a day file must belong to that trading day
    for (const r of [...j.cm, ...(j.idx ?? [])]) if (r.date !== date) throw new Error(`${f}: row dated ${r.date}`);
    days.push({ ymd, date, cm: j.cm.filter((r) => STOCKS.has(r.symbol)), idx: j.idx ?? [] });
  }
  return { days, holidays, noIndex };
}

/** Copied from runner/jobs/nse.ts:204 (not exported there). */
function mergeHist(old: [string, number][], add: [string, number][]): [string, number][] {
  const m = new Map<string, number>(old);
  for (const [d, v] of add) m.set(d, v);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-260);
}

/* ---------------- replay ---------------- */

interface ViewRec {
  date: string;
  symbol: string;
  decision: "trade" | "sit_out";
  reason: string | null;
  blockedBy: string | null;
  signalId: string | null;
  confidence: number | null;
  strategy: string | null;
  candidate: string | null;
  applicable: number;
  agree: number;
  disagree: number;
  layers: Record<string, number | null>;
}

interface Replay {
  signals: SignalRow[];
  views: ViewRec[];
  bars: Map<string, Candle[]>;
  dates: string[];
  /** cycle timestamp (ISO, as written to issued_at / activated_at / closed_at) -> trading session it ran for */
  runDate: Map<string, string>;
  transitions: number;
  ledgerEntries: number;
  events: number;
}

async function replay(days: DayFile[], o: Opts): Promise<Replay> {
  const db = new MemDb();
  const bars = new Map<string, Candle[]>();
  const prevClose = new Map<string, number>();
  const peHist = new Map<string, [string, number][]>();
  let vixHist: [string, number][] = [];
  const views: ViewRec[] = [];
  const runDate = new Map<string, string>();
  let transitions = 0;
  const asOf = (date: string) => `${date}T10:00:00.000Z`; // as runner/jobs/nse.ts:146 (15:30 IST close)

  for (const d of days) {
    // ---- the nse-eod batch for ONE day (mirrors runner/jobs/nse.ts:113-170 with a 1-day window)
    const b = emptyBatch();
    const closes = new Map<string, { date: string; c: number }>();
    const lastIdx = new Map<string, IndexRow>();
    const vixToday: [string, number][] = [];
    const peToday = new Map<string, [string, number][]>();
    for (const r of d.cm) {
      b.candles.push({ symbol: r.symbol, tf: "1D", ...r.candle });
      closes.set(r.symbol, { date: r.date, c: r.candle.c });
    }
    for (const r of d.idx) {
      if (r.name === "India VIX") {
        vixToday.push([r.date, r.candle.c]);
        lastIdx.set("INDIAVIX", r);
        continue;
      }
      const sym = BY_INDEX[r.name];
      if (!sym) continue;
      b.candles.push({ symbol: sym, tf: "1D", ...r.candle });
      closes.set(sym, { date: r.date, c: r.candle.c });
      lastIdx.set(sym, r);
      if (r.pe !== null) peToday.set(sym, [[r.date, r.pe]]);
    }
    for (const i of IN) {
      const last = closes.get(i.symbol);
      if (!last) continue;
      const prev = prevClose.get(i.symbol) ?? d.cm.find((r) => r.symbol === i.symbol)?.prevClose ?? null;
      b.quotes.push({ symbol: i.symbol, price: last.c, prevClose: prev, changePct: prev ? roundTo(((last.c - prev) / prev) * 100, 3) : null, asOf: asOf(last.date), source: "nse-archives" });
      prevClose.set(i.symbol, last.c);
    }
    const lv = lastIdx.get("INDIAVIX");
    if (lv) {
      vixHist = mergeHist(vixHist, vixToday);
      const pc = vixHist.length > 1 ? (vixHist[vixHist.length - 2] as [string, number])[1] : null;
      b.quotes.push({ symbol: "INDIAVIX", price: lv.candle.c, prevClose: pc, changePct: lv.changePct, asOf: asOf(lv.date), source: "nse-archives" });
      b.snapshots.push({ key: "ctx:IN", json: { label: "India VIX", history: vixHist, asOf: asOf(lv.date) } satisfies VixHistorySnapshot, asOf: asOf(lv.date), source: "nse-archives" });
    }
    for (const sym of ["NIFTY", "BANKNIFTY"]) {
      const r = lastIdx.get(sym);
      if (!r) continue;
      const h = mergeHist(peHist.get(sym) ?? [], peToday.get(sym) ?? []);
      peHist.set(sym, h);
      const f: IndexFundSnapshot = { kind: "index", symbol: sym, date: r.date, pe: r.pe, pb: r.pb, divYield: r.divYield, peHistory: h, source: "nse-archives", asOf: asOf(r.date) };
      b.snapshots.push({ key: `fund:${sym}`, json: f, asOf: f.asOf, source: "nse-archives" });
    }
    for (const c of b.candles) {
      let a = bars.get(c.symbol);
      if (!a) bars.set(c.symbol, (a = []));
      a.push({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
    }

    // ---- commit like runner/main.ts commit(), then the production engine cycle
    const now = new Date((ymdToT(d.ymd) + o.runUtcSec) * 1000);
    const nowIso = now.toISOString();
    runDate.set(nowIso, d.date);
    const pairs = [...new Map(b.candles.map((c) => [`${c.symbol}|${c.tf}`, { symbol: c.symbol, tf: c.tf }])).values()];
    await db.write([...upsertCandles(b.candles), ...pruneCandles(pairs, 400), ...upsertQuotes(b.quotes, nowIso), ...upsertSnapshots(b.snapshots, nowIso)]);
    const [maxT] = await db.read([stmt(`SELECT MAX(t) AS t FROM candles`)]);
    if (Number(maxT?.[0]?.t) > isoDateToT(d.date)) throw new Error(`look-ahead: DB holds a bar after ${d.date}`);

    const r = await runCycle(db, { now, runBy: "runner", evaluate: IN_SYMBOLS, requireApproval: false });
    transitions += r.transitions.length;
    if (!r.evaluated.length) continue;
    const [rows] = await db.read([stmt(`SELECT symbol, view FROM engine_state WHERE symbol IN (SELECT value FROM json_each(?))`, jsonList(r.evaluated))]);
    for (const row of rows ?? []) {
      const v = JSON.parse(String(row.view)) as EngineView & { blockedBy?: string | null; signalId?: string };
      if (v.barT !== null && v.barT > isoDateToT(d.date)) throw new Error(`look-ahead: ${v.symbol} evaluated a bar after ${d.date}`);
      views.push({
        date: d.date,
        symbol: String(row.symbol),
        decision: v.decision,
        reason: v.sitOutReason,
        blockedBy: v.blockedBy ?? null,
        signalId: v.signalId ?? null,
        confidence: v.confidence,
        strategy: v.strategy,
        candidate: v.candidate,
        applicable: v.applicable,
        agree: v.agree,
        disagree: v.disagree,
        layers: v.layers,
      });
    }
  }
  const [sig, led, ev] = await db.read([
    stmt(`SELECT * FROM live_signals ORDER BY issued_at, symbol`),
    stmt(`SELECT COUNT(*) AS n FROM live_ledger`),
    stmt(`SELECT COUNT(*) AS n FROM signal_events`),
  ]);
  return {
    signals: (sig ?? []) as unknown as SignalRow[],
    views,
    bars,
    dates: days.map((d) => d.date),
    runDate,
    transitions,
    ledgerEntries: Number(led?.[0]?.n ?? 0),
    events: Number(ev?.[0]?.n ?? 0),
  };
}

/* ---------------- trades ---------------- */

export interface Trade {
  id: string;
  symbol: string;
  kind: "equity" | "index";
  strategy: string;
  direction: "LONG" | "SHORT";
  confidence: number;
  layers: Record<string, number | null>;
  issueDate: string;
  issueClose: number;
  activeAtIssue: boolean;
  status: "closed" | "open";
  filled: boolean;
  fillDate: string | null;
  outcome: string | null; // target | trailed | stopped | expired | invalidated | unfilled | open
  exitDate: string | null;
  entryLow: number;
  entryHigh: number;
  entryMid: number;
  stop: number;
  target1: number;
  target2: number;
  risk: number; // |entryMid - original stop| = 1R, as the lifecycle defines it
  exit: number | null; // production lifecycle exit price
  rLedger: number | null; // production r (fill assumed at entryMid)
  fillExec: number | null; // executable fill (see methodology)
  exitExec: number | null;
  rExec: number | null;
  notionalOverRisk: number | null; // (fill + exit) / risk, so cost in R = perSide * this
  costExec: number | null;
  costLedger: number | null;
  netLedger: number | null;
  netExec: number | null;
  holdSessions: number | null;
  nextOpenOutsideZone: boolean | null;
  gapThroughStopOnFill: boolean;
  closedBarLag: number | null; // sessions between the bar the lifecycle closed on (closed_bar_t) and the cycle that reported it
  mtmExec: number | null; // open trades only: mark-to-market at the last close
  issueQuarter: string;
  issueMonth: string;
}

const dateOfT = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

function buildTrades(rp: Replay, costs: Record<"equity" | "index", CostModel>): Trade[] {
  const idxOf = new Map<string, Map<string, number>>();
  for (const [s, a] of rp.bars) idxOf.set(s, new Map(a.map((b, i) => [dateOfT(b.t), i])));
  const out: Trade[] = [];
  for (const s of rp.signals) {
    const bars = rp.bars.get(s.symbol) as Candle[];
    const ix = idxOf.get(s.symbol) as Map<string, number>;
    const kind = KIND.get(s.symbol) ?? "equity";
    const dir = s.direction === "LONG" ? 1 : -1;
    const issueDate = dateOfT(s.issued_bar_t);
    const issueIdx = ix.get(issueDate);
    const sess = (iso: string | null) => (iso ? (rp.runDate.get(iso) ?? null) : null);
    if (issueIdx === undefined || sess(s.issued_at) !== issueDate) throw new Error(`${s.id}: issue bar ${issueDate} vs run ${s.issued_at}`);
    const entryMid = (s.entry_low + s.entry_high) / 2;
    const risk = Math.abs(entryMid - s.stop);
    const activeAtIssue = s.activated_at !== null && s.activated_at === s.issued_at;
    const filled = s.activated_at !== null;
    const closed = s.status === "closed";
    let fillIdx: number | null = null;
    let fillExec: number | null = null;
    let nextOpenOutsideZone: boolean | null = null;
    let gapThroughStopOnFill = false;
    if (filled) {
      if (activeAtIssue) {
        // published after the close of the issue bar => the earliest executable fill is the next session's open
        fillIdx = issueIdx + 1 < bars.length ? issueIdx + 1 : null;
        if (fillIdx !== null) {
          const fb = bars[fillIdx] as Candle;
          fillExec = fb.o;
          nextOpenOutsideZone = fb.o < s.entry_low || fb.o > s.entry_high;
        }
      } else {
        // pending pullback: a limit order at the near edge of the zone; a gap through the zone fills at the open
        fillIdx = ix.get(sess(s.activated_at) ?? "") ?? null;
        if (fillIdx === null || fillIdx <= issueIdx) throw new Error(`${s.id}: activation bar not after the issue bar`);
        const fb = bars[fillIdx] as Candle;
        fillExec = dir > 0 ? (fb.o <= s.entry_high ? fb.o : s.entry_high) : fb.o >= s.entry_low ? fb.o : s.entry_low;
      }
      if (fillExec !== null && (dir > 0 ? fillExec <= s.stop : fillExec >= s.stop)) gapThroughStopOnFill = true;
    }
    const exitIdx = closed && s.closed_at ? (ix.get(sess(s.closed_at) ?? "") ?? null) : null;
    if (closed && exitIdx === null) throw new Error(`${s.id}: no bar for close date ${s.closed_at}`);
    if (filled && closed && fillIdx !== null && exitIdx !== null && exitIdx < fillIdx) throw new Error(`${s.id}: exit before fill`);
    const exitExec = filled && closed && s.exit_price !== null ? (gapThroughStopOnFill ? fillExec : s.exit_price) : null;
    const rExec = fillExec !== null && exitExec !== null && risk > 0 ? (dir * (exitExec - fillExec)) / risk : null;
    const per = costs[kind].perSide;
    const notionalOverRisk = fillExec !== null && exitExec !== null && risk > 0 ? (fillExec + exitExec) / risk : null;
    const costExec = notionalOverRisk !== null ? per * notionalOverRisk : null;
    const costLedger = filled && closed && s.exit_price !== null && risk > 0 ? (per * (entryMid + s.exit_price)) / risk : null;
    const rLedger = filled && closed ? s.r : null;
    const lastBar = bars[bars.length - 1] as Candle;
    const mtmExec = !closed && fillExec !== null && risk > 0 ? (dir * (lastBar.c - fillExec)) / risk : null;
    const q = Math.floor((Number(issueDate.slice(5, 7)) - 1) / 3) + 1;
    out.push({
      id: s.id,
      symbol: s.symbol,
      kind,
      strategy: s.strategy,
      direction: s.direction,
      confidence: s.confidence,
      layers: JSON.parse(s.layers) as Record<string, number | null>,
      issueDate,
      issueClose: (bars[issueIdx] as Candle).c,
      activeAtIssue,
      status: closed ? "closed" : "open",
      filled,
      fillDate: fillIdx !== null ? dateOfT((bars[fillIdx] as Candle).t) : null,
      outcome: !closed ? "open" : !filled ? "unfilled" : (s.outcome as string),
      exitDate: exitIdx !== null ? dateOfT((bars[exitIdx] as Candle).t) : null,
      entryLow: s.entry_low,
      entryHigh: s.entry_high,
      entryMid,
      stop: s.stop,
      target1: s.target1,
      target2: s.target2,
      risk,
      exit: s.exit_price,
      rLedger,
      fillExec,
      exitExec,
      rExec,
      notionalOverRisk,
      costExec,
      costLedger,
      netLedger: rLedger !== null && costLedger !== null ? rLedger - costLedger : null,
      netExec: rExec !== null && costExec !== null ? rExec - costExec : null,
      holdSessions: fillIdx !== null && exitIdx !== null ? exitIdx - fillIdx + 1 : null,
      nextOpenOutsideZone,
      gapThroughStopOnFill,
      closedBarLag: exitIdx !== null && s.closed_bar_t !== null ? exitIdx - bars.findIndex((b) => b.t >= (s.closed_bar_t as number)) : null,
      mtmExec,
      issueQuarter: `${issueDate.slice(0, 4)}-Q${q}`,
      issueMonth: issueDate.slice(0, 7),
    });
  }
  return out;
}

/* ---------------- metrics ---------------- */

interface Group {
  name: string;
  calls: number;
  open: number;
  activeAtIssue: number;
  pending: number;
  pendingFilled: number;
  pendingUnfilled: number;
  filled: number; // closed + filled
  unfilled: number;
  outcomes: Record<string, number>;
  winRate: number;
  winRateGross: number;
  avgRLedger: number;
  avgNetLedger: number;
  avgRExec: number;
  tt: TTest; // on net executable R
  boot: BootCI;
  pf: number;
  maxDD: number;
  avgHold: number;
  totalNet: number;
  nextOpenOutside: number;
}

function maxDrawdown(ts: Trade[]): number {
  const seq = [...ts].sort((a, b) => (a.exitDate as string).localeCompare(b.exitDate as string) || a.issueDate.localeCompare(b.issueDate) || a.symbol.localeCompare(b.symbol));
  let eq = 0;
  let peak = 0;
  let dd = 0;
  for (const t of seq) {
    eq += t.netExec as number;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  return dd;
}

function group(name: string, ts: Trade[], rng: () => number, iters: number): Group {
  const closed = ts.filter((t) => t.status === "closed");
  const fl = closed.filter((t) => t.filled && t.netExec !== null);
  const net = fl.map((t) => t.netExec as number);
  const outcomes: Record<string, number> = { target: 0, trailed: 0, stopped: 0, expired: 0, invalidated: 0 };
  for (const t of fl) outcomes[t.outcome as string] = (outcomes[t.outcome as string] ?? 0) + 1;
  const pos = net.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const neg = -net.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  const pend = closed.filter((t) => !t.activeAtIssue);
  return {
    name,
    calls: ts.length,
    open: ts.length - closed.length,
    activeAtIssue: ts.filter((t) => t.activeAtIssue).length,
    pending: ts.filter((t) => !t.activeAtIssue).length,
    pendingFilled: pend.filter((t) => t.filled).length,
    pendingUnfilled: pend.filter((t) => !t.filled).length,
    filled: fl.length,
    unfilled: closed.filter((t) => !t.filled).length,
    outcomes,
    winRate: fl.length ? net.filter((x) => x > 0).length / fl.length : NaN,
    winRateGross: fl.length ? fl.filter((t) => (t.rExec as number) > 0).length / fl.length : NaN,
    avgRLedger: mean(fl.map((t) => t.rLedger as number)),
    avgNetLedger: mean(fl.map((t) => t.netLedger as number)),
    avgRExec: mean(fl.map((t) => t.rExec as number)),
    tt: tTest(net),
    boot: bootstrapMean(net, iters, rng),
    pf: neg > 0 ? pos / neg : pos > 0 ? Infinity : NaN,
    maxDD: fl.length ? maxDrawdown(fl) : NaN,
    avgHold: mean(fl.map((t) => t.holdSessions as number)),
    totalNet: net.reduce((a, b) => a + b, 0),
    nextOpenOutside: ts.filter((t) => t.nextOpenOutsideZone).length,
  };
}

/* ---------------- report formatting ---------------- */

const clock = (sec: number) => `${String(Math.floor(sec / 3600) % 24).padStart(2, "0")}:${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}${sec >= 86400 ? " (+1 day)" : ""}`;
const fx = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : x === Infinity ? "inf" : "-");
const fr = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "-");
const fp = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "-");
const ci = (lo: number, hi: number) => (Number.isFinite(lo) ? `[${fr(lo)}, ${fr(hi)}]` : "-");

function table(head: string[], rows: (string | number)[][]): string {
  const cells = [head, ...rows.map((r) => r.map(String))];
  const w = head.map((_, j) => Math.max(...cells.map((r) => (r[j] ?? "").length)));
  const line = (r: string[]) => r.map((c, j) => (j === 0 ? c.padEnd(w[j] as number) : c.padStart(w[j] as number))).join("  ");
  return [line(head), w.map((x) => "-".repeat(x)).join("  "), ...cells.slice(1).map(line)].join("\n");
}

function outcomeRow(g: Group): (string | number)[] {
  const pendFill = g.pendingFilled + g.pendingUnfilled ? fp(g.pendingFilled / (g.pendingFilled + g.pendingUnfilled)) : "-";
  const fillAll = g.filled + g.unfilled ? fp(g.filled / (g.filled + g.unfilled)) : "-";
  return [g.name, g.calls, g.activeAtIssue, g.pending, `${g.pendingFilled}/${g.pendingFilled + g.pendingUnfilled}`, pendFill, fillAll, g.outcomes.target ?? 0, g.outcomes.trailed ?? 0, g.outcomes.stopped ?? 0, g.outcomes.expired ?? 0, g.outcomes.invalidated ?? 0, g.unfilled, g.open, fx(g.avgHold, 1)];
}
const OUTCOME_HEAD = ["group", "calls", "act@iss", "pending", "pend fill", "pend fill%", "fill%", "T2", "trail", "stop", "expir", "inval", "unfill", "open", "hold"];

function perfRow(g: Group): (string | number)[] {
  return [g.name, g.filled, fp(g.winRateGross), fp(g.winRate), fr(g.avgRLedger), fr(g.avgNetLedger), fr(g.avgRExec), fr(g.tt.mean), ci(g.tt.lo, g.tt.hi), ci(g.boot.lo, g.boot.hi), fx(g.tt.p, 3), fx(g.pf), fx(g.maxDD), fr(g.totalNet, 1)];
}
const PERF_HEAD = ["group", "n", "win% gr", "win% net", "R ledger", "net ledger", "R exec", "E[net exec]", "95% CI (t)", "95% CI (boot)", "p (t)", "PF net", "maxDD R", "sum net R"];

/* ---------------- main ---------------- */

export async function backtestMain(argv: string[]): Promise<number> {
  let o: Opts;
  try {
    o = parseOpts(argv);
  } catch (e) {
    console.error(`✖ ${e instanceof Error ? e.message : e}`);
    console.error("usage: node --experimental-strip-types runner/backtest.ts [--trades] [--out FILE.json] [--slip PCT_PER_SIDE] [--idx-cost PCT_PER_SIDE] [--seed N] [--boot N] [--run-utc HH:MM] [--cache DIR]");
    return 2;
  }
  const t0 = Date.now();
  const { days, holidays, noIndex } = loadDays(o.cacheDir);
  if (!days.length) {
    console.error(`✖ no NSE day files in ${o.cacheDir}`);
    return 1;
  }
  const costs = costModels(o);
  const rp = await replay(days, o);
  const trades = buildTrades(rp, costs);
  const rng = mulberry32(o.seed);
  const P: string[] = [];
  const say = (s = "") => P.push(s);

  // ---------- header
  const first = days[0] as DayFile;
  const last = days[days.length - 1] as DayFile;
  const evalDates = [...new Set(rp.views.filter((v) => v.reason !== "insufficient_history" && v.reason !== "no_data").map((v) => v.date))].sort();
  say(`Tudumm engine v0 walk-forward backtest — India universe (${IN_SYMBOLS.join(", ")}), positional, 1D bars`);
  say(`Data: ${days.length} NSE sessions ${first.date} … ${last.date} (cached bhavcopy + index closes; ${holidays.length} holiday files skipped${noIndex.length ? `; ${noIndex.length} days without index file: ${noIndex.join(",")}` : ""}).`);
  say(`Engine past warm-up (>= 60 bars) from ${evalDates[0] ?? "-"}; ${evalDates.length} sessions with live evaluations. Cycle time each session: ${clock(o.runUtcSec)} UTC = ${clock(o.runUtcSec + 19800)} IST.`);
  say(`Production code path: runCycle x ${days.length} on in-memory D1 schema; ${rp.signals.length} signals, ${rp.transitions} lifecycle transitions, ${rp.ledgerEntries} ledger entries (hash chain enforced by the 0002 trigger), ${rp.events} events.`);
  say(`Derivatives layer: NULL on every evaluation (no F&O history cached). Fundamentals: index P/E percentile for NIFTY/BANKNIFTY only. Event-risk calendar: not wired (engine never flags it).`);
  say();
  say(`Costs (net R = gross R - cost in R; cost in R = per-side% x (entry + exit price) / 1R):`);
  say(`  stocks : ${costs.equity.detail}`);
  say(`  indices: ${costs.index.label}: ${costs.index.detail}`);
  say(`R definitions: "ledger" = the production lifecycle r (assumes a fill at the entry-zone midpoint); "exec" = same exits, but the fill a trader could actually get:`);
  say(`  active-at-issue calls -> next session's open (calls are published after the close); pending pullbacks -> limit at the near zone edge, or the open if it gapped through.`);
  say(`  1R = |zone mid - original stop| in both. Expected value / win% / PF / drawdown below use NET EXEC R unless labelled.`);
  say();

  // ---------- groups
  const G = (name: string, f: (t: Trade) => boolean) => group(name, trades.filter(f), rng, o.boot);
  const overall = G("ALL", () => true);
  const bySym = IN_SYMBOLS.map((s) => G(s, (t) => t.symbol === s));
  const byStrat = ["trend_continuation", "ema20_pullback"].map((s) => G(s, (t) => t.strategy === s));
  const byDir = ["LONG", "SHORT"].map((d) => G(d, (t) => t.direction === d));
  const byKind = [G("stocks", (t) => t.kind === "equity"), G("indices", (t) => t.kind === "index"), G("stocks LONG (delivery-executable)", (t) => t.kind === "equity" && t.direction === "LONG")];
  // EMA200 (price layer) needs 200 bars and the NIFTY benchmark (stocks' context layer) 210: before that the engine
  // runs a reduced configuration that production (which has ~260+ bars today) no longer runs.
  const nb = rp.bars.get("NIFTY") ?? [];
  const fullFrom = nb.length >= 210 ? dateOfT((nb[209] as Candle).t) : "9999-12-31";
  const byHist = [G(`issued < ${fullFrom} (warm-up config)`, (t) => t.issueDate < fullFrom), G(`issued >= ${fullFrom} (full history)`, (t) => t.issueDate >= fullFrom)];
  const quarters = [...new Set(trades.map((t) => t.issueQuarter))].sort();
  const byQ = quarters.map((q) => G(`issued ${q}`, (t) => t.issueQuarter === q));
  const sections: [string, Group[]][] = [
    ["overall", [overall]],
    ["by instrument", bySym],
    ["by strategy", byStrat],
    ["by direction", byDir],
    ["by asset class", byKind],
    ["by issue quarter (stability)", byQ],
    ["by indicator history", byHist],
  ];
  say("== Calls and outcomes ==  (act@iss = active at issue; pend fill = pending pullbacks filled / resolved; fill% = filled / resolved calls;");
  say("   T2/trail/stop/expir/inval = outcomes of FILLED closed trades; unfill = pending that expired unfilled; open = still open on the last day; hold = avg sessions held)");
  say(table(OUTCOME_HEAD, sections.flatMap(([, gs]) => gs.map(outcomeRow))));
  say();
  say("== Performance (closed, filled trades) ==  (R ledger/net ledger = production accounting; R exec = gross executable; E[net exec] = expectancy per trade, net of costs)");
  say(table(PERF_HEAD, sections.flatMap(([, gs]) => gs.map(perfRow))));
  say();

  // ---------- correlation-aware uncertainty for the headline number
  const fl = trades.filter((t) => t.status === "closed" && t.filled && t.netExec !== null);
  const byMonth = new Map<string, number[]>();
  for (const t of fl) byMonth.set(t.issueMonth, [...(byMonth.get(t.issueMonth) ?? []), t.netExec as number]);
  const cb = clusterBootstrapMean([...byMonth.values()], o.boot, rng);
  say(`Overall E[net exec] = ${fr(overall.tt.mean, 3)} R/trade over n = ${overall.filled}; t-test p = ${fx(overall.tt.p, 3)}; iid bootstrap 95% CI ${ci(overall.boot.lo, overall.boot.hi)} (P[mean <= 0] = ${fx(overall.boot.pLeq0, 3)});`);
  say(`month-cluster bootstrap 95% CI ${ci(cb.lo, cb.hi)} over ${byMonth.size} issue months (trades in the same month share one market regime, so this interval is the more honest one).`);
  const mde = Number.isFinite(overall.tt.sd) ? (2.8 * overall.tt.sd) / Math.sqrt(Math.max(1, overall.filled)) : NaN;
  say(`With sd = ${fx(overall.tt.sd)} R per trade, the smallest true edge this sample could detect with 80% power at 5% is ~${fx(mde)} R/trade; ` +
      `detecting +0.10 R/trade would need ~${Number.isFinite(overall.tt.sd) ? Math.ceil(((2.8 * overall.tt.sd) / 0.1) ** 2) : "-"} trades.`);
  const gapLedger = mean(fl.map((t) => (t.rLedger as number) - (t.rExec as number)));
  say(`Ledger vs executable: production r overstates the executable R by ${fr(gapLedger, 3)} R/trade on average (fill-price assumption).`);
  const aai = trades.filter((t) => t.activeAtIssue && t.nextOpenOutsideZone !== null);
  say(`Active-at-issue calls whose next open was already outside the entry zone: ${aai.filter((t) => t.nextOpenOutsideZone).length}/${aai.length}. Pending fills that gapped through the stop: ${trades.filter((t) => t.gapThroughStopOnFill).length}.`);
  const sens = [0, o.eqSlip, 2 * o.eqSlip].map((sl) => {
    const per = { equity: 0.001 + 0.0001 + 0.18 * 0.0001 + sl, index: o.idxSide };
    return `stock slippage ${(sl * 100).toFixed(2)}%/side -> ${fr(mean(fl.map((t) => (t.rExec as number) - per[t.kind] * (t.notionalOverRisk as number))), 3)}`;
  });
  say(`Cost sensitivity (overall E[net exec]): ${sens.join("; ")}; zero costs -> ${fr(overall.avgRExec, 3)}.`);
  say(`Average cost per trade: ${fx(mean(fl.map((t) => t.costExec as number)), 3)} R (stocks ${fx(mean(fl.filter((t) => t.kind === "equity").map((t) => t.costExec as number)), 3)} R, indices ${fx(mean(fl.filter((t) => t.kind === "index").map((t) => t.costExec as number)), 3)} R); avg 1R = ${fx(mean(fl.map((t) => (t.risk / t.entryMid) * 100)), 2)}% of price.`);
  say();

  // ---------- confidence sensitivity
  say("== Does confidence predict outcomes? ==  (confidence = clamp(0.50 + 0.25*mean(agreeing scores)/100 - 0.05*disagreeing layers, 0.50, 0.78); thresholds fixed in advance, not tuned)");
  const confs = fl.map((t) => t.confidence).sort((a, b) => a - b);
  const med = confs.length ? (confs[Math.floor((confs.length - 1) / 2)] as number) : NaN;
  const dist = new Map<number, number>();
  for (const c of confs) dist.set(c, (dist.get(c) ?? 0) + 1);
  say(`Distribution over filled trades: min ${fx(confs[0] ?? NaN)}, median ${fx(med)}, max ${fx(confs[confs.length - 1] ?? NaN)}; values: ${[...dist.entries()].map(([c, n]) => `${c.toFixed(2)}x${n}`).join(" ")}`);
  const cuts: [string, (t: Trade) => boolean][] = [
    ["all filled", () => true],
    ["conf < 0.60", (t) => t.confidence < 0.6],
    ["conf >= 0.60", (t) => t.confidence >= 0.6],
    ["conf >= 0.65", (t) => t.confidence >= 0.65],
    ["conf >= 0.70", (t) => t.confidence >= 0.7],
    [`conf <= median (${fx(med)})`, (t) => t.confidence <= med],
    [`conf > median (${fx(med)})`, (t) => t.confidence > med],
    ["stocks, conf < 0.60", (t) => t.kind === "equity" && t.confidence < 0.6],
    ["stocks, conf >= 0.60", (t) => t.kind === "equity" && t.confidence >= 0.6],
  ];
  const confGroups = cuts.map(([name, f]) => {
    const sub = fl.filter(f);
    return { g: group(name, sub, rng, o.boot), meanConf: mean(sub.map((t) => t.confidence)) };
  });
  say(table(["cut", "n", "mean conf", "win% gr", "win% net", "T2 hit%", "E[net exec]", "95% CI (t)", "PF net"], confGroups.map(({ g, meanConf }) => [
    g.name, g.filled, fx(meanConf), fp(g.winRateGross), fp(g.winRate), g.filled ? fp((g.outcomes.target ?? 0) / g.filled) : "-", fr(g.tt.mean), ci(g.tt.lo, g.tt.hi), fx(g.pf),
  ])));
  const sp = spearman(fl.map((t) => t.confidence), fl.map((t) => t.netExec as number));
  const flS = fl.filter((t) => t.kind === "equity");
  const spS = spearman(flS.map((t) => t.confidence), flS.map((t) => t.netExec as number));
  say(`Index calls carry systematically lower confidence (fewer agreeing points), so the all-trades split is confounded by asset class; the stock-only rows control for that.`);
  say(`Spearman rank correlation(confidence, net exec R) = ${fx(sp.rho, 3)} (n = ${sp.n}, p = ${fx(sp.p, 3)}); stocks only ${fx(spS.rho, 3)} (n = ${spS.n}, p = ${fx(spS.p, 3)}). Mean stated confidence ${fx(mean(confs))} vs realised gross win rate ${fp(overall.winRateGross)} and T2 hit rate ${overall.filled ? fp((overall.outcomes.target ?? 0) / overall.filled) : "-"}.`);
  say();

  // ---------- decisions / sit-out
  say("== Engine decisions per evaluated session ==  (warm-up = insufficient_history; sit-out% over post-warm-up evaluations; 'flat' = no open call on that symbol at evaluation time)");
  const openOn = (sym: string, date: string) => trades.some((t) => t.symbol === sym && t.issueDate < date && (t.status === "open" || (t.exitDate as string) > date || (t.outcome === "unfilled" && (t.exitDate as string) > date)));
  const reasons = ["no_trend", "momentum_conflict", "insufficient_agreement", "cooldown", "stale_data", "event_risk", "strategy_disabled"];
  const decRow = (name: string, vs: ViewRec[]) => {
    const warm = vs.filter((v) => v.reason === "insufficient_history" || v.reason === "no_data").length;
    const post = vs.filter((v) => v.reason !== "insufficient_history" && v.reason !== "no_data");
    const so = post.filter((v) => v.decision === "sit_out");
    const flat = post.filter((v) => !openOn(v.symbol, v.date));
    const soFlat = flat.filter((v) => v.decision === "sit_out");
    const cnt = (r: string) => so.filter((v) => v.reason === r).length;
    return [name, vs.length, warm, post.length, post.filter((v) => v.decision === "trade" && v.signalId).length, post.filter((v) => v.blockedBy === "open_signal").length, so.length, fp(post.length ? so.length / post.length : NaN), fp(flat.length ? soFlat.length / flat.length : NaN), ...reasons.slice(0, 4).map(cnt), fx(mean(post.map((v) => v.applicable)), 1)];
  };
  say(table(["symbol", "evals", "warm-up", "post", "issued", "blocked(open)", "sit-out", "sit-out%", "sit-out% flat", "no_trend", "mom_conflict", "insuff_agree", "cooldown", "avg layers"], [
    ...IN_SYMBOLS.map((s) => decRow(s, rp.views.filter((v) => v.symbol === s))),
    decRow("ALL", rp.views),
  ]));
  // buy & hold over the post-warm-up window, for context
  const bh = IN_SYMBOLS.map((s) => {
    const a = rp.bars.get(s) ?? [];
    const start = a.find((b) => dateOfT(b.t) >= (evalDates[0] ?? ""));
    const end = a[a.length - 1];
    return start && end ? `${s} ${fr(((end.c - start.c) / start.c) * 100, 1)}%` : `${s} -`;
  });
  say(`Buy & hold over the post-warm-up window (context for LONG/SHORT results): ${bh.join(", ")}`);
  say();

  // ---------- engine quirk diagnostics
  const cdViews = rp.views.filter((v) => v.reason === "cooldown");
  let extraCooldown = 0;
  for (const v of cdViews) {
    const closedSameDay = trades.some((t) => t.symbol === v.symbol && t.exitDate === v.date);
    if (!closedSameDay) extraCooldown++;
  }
  const lag = trades.filter((t) => t.closedBarLag !== null && t.closedBarLag > 0);
  const closedN = trades.filter((t) => t.closedBarLag !== null).length;
  say(`Closes recorded against an EARLIER bar than the cycle that reported them (the bar was only checkpointed once lifecycle.ts:118 saw it as complete): ${lag.length}/${closedN}` +
      ` (${["unfilled", "expired", "target", "trailed", "stopped"].map((k) => `${k} ${lag.filter((t) => t.outcome === k).length}`).join(", ")}).`);
  say(`Cooldown sit-outs: ${cdViews.length}; of these ${extraCooldown} fell on a session AFTER the closing session (the extra-bar cooldown those closes can cause).`);

  // ---------- open at end
  const open = trades.filter((t) => t.status === "open");
  if (open.length) {
    say(`Open on ${last.date} (excluded from the stats above): ` + open.map((t) => `${t.symbol} ${t.direction} ${t.strategy} issued ${t.issueDate} ${t.filled ? `MTM ${fr(t.mtmExec as number)} R` : "pending"}`).join("; "));
  }
  say();

  if (o.trades) {
    say("== Trades ==");
    say(table(["id", "dir", "strategy", "conf", "issued", "fill", "exit", "outcome", "zone", "stop", "T1", "T2", "fill px", "exit px", "R ledger", "R exec", "cost", "net exec", "hold"], trades.map((t) => [
      t.id, t.direction, t.strategy === "trend_continuation" ? "trend" : "pullback", fx(t.confidence), t.issueDate, t.fillDate ?? "-", t.exitDate ?? "-", t.outcome ?? "-",
      `${t.entryLow}-${t.entryHigh}`, t.stop, t.target1, t.target2, t.fillExec ?? "-", t.exitExec ?? "-", t.rLedger === null ? "-" : fr(t.rLedger), t.rExec === null ? "-" : fr(t.rExec),
      t.costExec === null ? "-" : fx(t.costExec), t.netExec === null ? "-" : fr(t.netExec), t.holdSessions ?? "-",
    ])));
    say();
  }
  say(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(P.join("\n"));

  if (o.out) {
    mkdirSync(dirname(o.out), { recursive: true });
    writeFileSync(
      o.out,
      JSON.stringify({ generatedAt: new Date().toISOString(), opts: o, costs, data: { first: first.date, last: last.date, sessions: days.length, holidays, evalFrom: evalDates[0] ?? null }, groups: Object.fromEntries(sections.map(([k, gs]) => [k, gs])), clusterBootstrap: cb, spearman: sp, trades, views: rp.views }, null, 1),
    );
    console.log(`wrote ${o.out}`);
  }
  return 0;
}
