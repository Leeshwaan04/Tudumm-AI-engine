// CONTRACT: admin-facing engine functions. Implemented by the data/engine agent; called by the
// backend-core agent's /api/admin/engine/* routes AFTER admin auth + audit logging. Keep signatures.
import type { Env } from "../env";
import type { AdminSignalRow, EngineHealth, Freshness, SignalStatus, SourceHealth, StrategyRow } from "./types";
import { MARKET_IDS, SOURCES, STRATEGIES } from "./instruments";
import { d1Db, stmt } from "./store";
import { holdSignal, invalidateSignalRow } from "./service";
import { dispatchOutbox } from "./outbox";
import { runMarketCycle } from "../cron";

const FRESH = new Map<string, Freshness>(SOURCES.map((s) => [s.id, s.freshness]));

export async function engineHealth(env: Env): Promise<EngineHealth> {
  const db = d1Db(env.DB);
  const [src, run, open, led] = await db.read([
    stmt(`SELECT source, ok, last_success_at, last_error, last_run_at FROM source_health ORDER BY source`),
    stmt(`SELECT as_of FROM snapshots WHERE key = 'meta:engine_run'`),
    stmt(`SELECT COUNT(*) AS n FROM live_signals WHERE status IN ('pending', 'active', 't1_hit')`),
    stmt(`SELECT COUNT(*) AS n FROM live_ledger`),
  ]);
  const now = Date.now();
  const sources: SourceHealth[] = (src ?? []).map((r) => {
    const last = r.last_success_at === null ? null : String(r.last_success_at);
    return {
      source: String(r.source),
      ok: Number(r.ok) === 1,
      lastSuccessAt: last,
      lastError: r.last_error === null ? null : String(r.last_error),
      staleSeconds: last ? Math.max(0, Math.round((now - Date.parse(last)) / 1000)) : null,
      freshness: FRESH.get(String(r.source)) ?? "eod",
    };
  });
  return {
    sources,
    lastRunAt: run?.[0] ? String(run[0].as_of) : null,
    liveSignals: Number(open?.[0]?.n ?? 0),
    ledgerEntries: Number(led?.[0]?.n ?? 0),
  };
}

const STATUS_FILTER = new Set(["pending", "active", "t1_hit", "closed", "held", "invalidated", "open"]);

export async function listSignals(
  env: Env,
  opts: { status?: string; market?: string; q?: string; limit?: number; offset?: number },
): Promise<{ items: AdminSignalRow[]; total: number }> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.status && STATUS_FILTER.has(opts.status)) {
    if (opts.status === "held") where.push("held = 1 AND status <> 'closed'");
    else if (opts.status === "invalidated") where.push("outcome = 'invalidated'");
    else if (opts.status === "open") where.push("status IN ('pending', 'active', 't1_hit')");
    else {
      where.push("status = ?");
      params.push(opts.status);
    }
  }
  if (opts.market && (MARKET_IDS as string[]).includes(opts.market)) {
    where.push("market = ?");
    params.push(opts.market);
  }
  if (opts.q && /^[A-Za-z0-9^._-]{1,32}$/.test(opts.q)) {
    where.push("(symbol LIKE ? OR id LIKE ?)");
    params.push(`%${opts.q.toUpperCase()}%`, `%${opts.q.toUpperCase()}%`);
  }
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
  const offset = Math.min(100000, Math.max(0, Math.floor(opts.offset ?? 0)));
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const db = d1Db(env.DB);
  const [rows, cnt] = await db.read([
    stmt(`SELECT id, symbol, market, status, direction, strategy, confidence, issued_at, updated_at, held, outcome FROM live_signals ${w} ORDER BY issued_at DESC LIMIT ? OFFSET ?`, ...params, limit, offset),
    stmt(`SELECT COUNT(*) AS n FROM live_signals ${w}`, ...params),
  ]);
  return {
    items: (rows ?? []).map((r) => ({
      id: String(r.id),
      symbol: String(r.symbol),
      market: String(r.market),
      status: (r.outcome === "invalidated" ? "invalidated" : String(r.status)) as SignalStatus,
      direction: (r.direction as "LONG" | "SHORT") ?? null,
      strategy: r.strategy === null ? null : String(r.strategy),
      confidence: r.confidence === null ? null : Number(r.confidence),
      issuedAt: String(r.issued_at),
      updatedAt: String(r.updated_at),
      held: Number(r.held) === 1,
    })),
    total: Number(cnt?.[0]?.n ?? 0),
  };
}

const ID_RE = /^SIG-[A-Z0-9]{1,16}-\d{8}T\d{4}$/;

/** Hold hides a live signal from users (or releases it). Must emit a SignalEvent. */
export async function setSignalHold(env: Env, id: string, hold: boolean, actor: string, reason: string): Promise<void> {
  if (!ID_RE.test(id)) throw new Error("invalid_signal_id");
  const db = d1Db(env.DB);
  const r = await holdSignal(db, id, hold, String(actor).slice(0, 64), String(reason ?? "").slice(0, 300), new Date());
  if (!r.ok) throw new Error(r.error ?? "hold_failed");
  await dispatchOutbox(env, db);
}

/** Invalidate closes a signal early with a reason; recorded in the ledger as an event, never an edit. */
export async function invalidateSignal(env: Env, id: string, actor: string, reason: string): Promise<void> {
  if (!ID_RE.test(id)) throw new Error("invalid_signal_id");
  const db = d1Db(env.DB);
  const r = await invalidateSignalRow(db, id, String(actor).slice(0, 64), String(reason ?? "").slice(0, 300), new Date());
  if (!r.ok) throw new Error(r.error ?? "invalidate_failed");
  await dispatchOutbox(env, db);
}

export async function listStrategies(env: Env): Promise<StrategyRow[]> {
  const db = d1Db(env.DB);
  const [rows, stats] = await db.read([
    stmt(`SELECT strategy, market, enabled FROM strategies ORDER BY strategy, market`),
    stmt(
      `SELECT strategy, market, COUNT(*) AS n,
              SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed,
              SUM(CASE WHEN status = 'closed' AND r > 0 THEN 1 ELSE 0 END) AS wins,
              AVG(CASE WHEN status = 'closed' THEN r END) AS avg_r
       FROM live_signals GROUP BY strategy, market`,
    ),
  ]);
  const st = new Map((stats ?? []).map((r) => [`${r.strategy}|${r.market}`, r]));
  return (rows ?? []).map((r) => {
    const s = st.get(`${r.strategy}|${r.market}`);
    const closed = Number(s?.closed ?? 0);
    return {
      strategy: String(r.strategy),
      market: String(r.market),
      enabled: Number(r.enabled) === 1,
      signals: Number(s?.n ?? 0),
      closed,
      winRate: closed ? Math.round((Number(s?.wins ?? 0) / closed) * 1000) / 1000 : null,
      avgR: closed && s?.avg_r !== null && s?.avg_r !== undefined ? Math.round(Number(s.avg_r) * 100) / 100 : null,
    };
  });
}

/** Kill switch per strategy x market. Disabled strategies issue no new signals. */
export async function setStrategyEnabled(env: Env, strategy: string, market: string, enabled: boolean, actor: string): Promise<void> {
  if (!(STRATEGIES as readonly string[]).includes(strategy)) throw new Error("unknown_strategy");
  if (!(MARKET_IDS as string[]).includes(market)) throw new Error("unknown_market");
  await d1Db(env.DB).write([
    stmt(
      `INSERT INTO strategies (strategy, market, enabled, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (strategy, market) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      strategy,
      market,
      enabled ? 1 : 0,
      new Date().toISOString(),
      String(actor).slice(0, 64),
    ),
  ]);
}

/** Force an engine run now (admin "Run engine" button). Returns a short summary. */
export async function runEngineNow(env: Env): Promise<{ ok: boolean; summary: string }> {
  try {
    const r = await runMarketCycle(env, new Date(), { forceFetch: true, runBy: "admin", dailyBudget: 4 });
    return { ok: true, summary: r.summary };
  } catch (e) {
    return { ok: false, summary: `engine run failed: ${e instanceof Error ? e.message.slice(0, 160) : "error"}` };
  }
}

