// Storage abstraction shared by the Worker (D1 binding) and the Node runner (wrangler d1 execute).
// Bulk writes use ONE prepared statement per table with a single JSON parameter expanded by
// json_each(), which keeps every invocation far below D1's per-invocation query limit (50 on the
// Free plan) and below the 100-bound-parameter limit, while staying fully parameterised.
import type { CandleRow, QuoteRow, SnapshotRow, SourceId } from "./types";

export type SqlVal = string | number | null;
export interface SqlStmt {
  sql: string;
  params: SqlVal[];
}
export type Row = Record<string, unknown>;

export interface MarketDb {
  /** Run several read statements in one round trip; results in order. */
  read(stmts: SqlStmt[]): Promise<Row[][]>;
  /** Run write statements as one atomic batch (D1) / one file (runner). */
  write(stmts: SqlStmt[]): Promise<void>;
}

export const stmt = (sql: string, ...params: SqlVal[]): SqlStmt => ({ sql, params });

export function d1Db(db: D1Database): MarketDb {
  return {
    async read(stmts) {
      if (!stmts.length) return [];
      const res = await db.batch(stmts.map((s) => db.prepare(s.sql).bind(...s.params)));
      return res.map((r) => (r.results ?? []) as Row[]);
    },
    async write(stmts) {
      if (!stmts.length) return;
      await db.batch(stmts.map((s) => db.prepare(s.sql).bind(...s.params)));
    },
  };
}

export async function readOne(db: MarketDb, s: SqlStmt): Promise<Row[]> {
  const [r] = await db.read([s]);
  return r ?? [];
}

const fin = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

/* ---------------- bulk upserts (one statement each) ---------------- */

export function upsertCandles(rows: CandleRow[]): SqlStmt[] {
  if (!rows.length) return [];
  const out: SqlStmt[] = [];
  // chunk so the runner's inlined SQL stays under D1's 100 KB statement limit
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400).map((r) => [r.symbol, r.tf, r.t, r.o, r.h, r.l, r.c, r.v]);
    out.push(
      stmt(
        `INSERT OR REPLACE INTO candles (symbol, tf, t, o, h, l, c, v)
         SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'),
                json_extract(value, '$[4]'), json_extract(value, '$[5]'), json_extract(value, '$[6]'), json_extract(value, '$[7]')
         FROM json_each(?)`,
        JSON.stringify(chunk),
      ),
    );
  }
  return out;
}

/** Keep the newest `keep` bars for each (symbol, tf). */
export function pruneCandles(pairs: { symbol: string; tf: string }[], keep = 400): SqlStmt[] {
  if (!pairs.length) return [];
  return [
    stmt(
      `DELETE FROM candles WHERE (symbol, tf, t) IN (
         SELECT symbol, tf, t FROM (
           SELECT symbol, tf, t, ROW_NUMBER() OVER (PARTITION BY symbol, tf ORDER BY t DESC) AS rn FROM candles
           WHERE (symbol, tf) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))
         ) WHERE rn > ?)`,
      JSON.stringify(pairs.map((p) => [p.symbol, p.tf])),
      keep,
    ),
  ];
}

export function upsertQuotes(rows: QuoteRow[], now: string): SqlStmt[] {
  if (!rows.length) return [];
  const data = rows.map((q) => [
    q.symbol,
    q.price,
    fin(q.prevClose),
    fin(q.changePct),
    fin(q.dayOpen),
    fin(q.dayHigh),
    fin(q.dayLow),
    fin(q.volume),
    fin(q.bid),
    fin(q.ask),
    fin(q.bidSize),
    fin(q.askSize),
    q.asOf,
    q.source,
  ]);
  return [
    stmt(
      `INSERT OR REPLACE INTO quotes (symbol, price, prev_close, change_pct, day_open, day_high, day_low, volume, bid, ask, bid_size, ask_size, as_of, source, updated_at)
       SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'),
              json_extract(value, '$[5]'), json_extract(value, '$[6]'), json_extract(value, '$[7]'), json_extract(value, '$[8]'), json_extract(value, '$[9]'),
              json_extract(value, '$[10]'), json_extract(value, '$[11]'), json_extract(value, '$[12]'), json_extract(value, '$[13]'), ?
       FROM json_each(?)`,
      now,
      JSON.stringify(data),
    ),
  ];
}

export function upsertSnapshots(rows: SnapshotRow[], now: string): SqlStmt[] {
  if (!rows.length) return [];
  const data = rows.map((s) => [s.key, JSON.stringify(s.json), s.asOf, s.source]);
  return [
    stmt(
      `INSERT OR REPLACE INTO snapshots (key, json, as_of, source, updated_at)
       SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), ?
       FROM json_each(?)`,
      now,
      JSON.stringify(data),
    ),
  ];
}

export function healthStmts(entries: { source: SourceId; ok: boolean; error: string | null }[], now: string): SqlStmt[] {
  if (!entries.length) return [];
  const data = entries.map((e) => [e.source, e.ok ? 1 : 0, e.ok ? now : null, e.ok ? null : (e.error ?? "error").slice(0, 200)]);
  return [
    stmt(
      `INSERT INTO source_health (source, ok, last_success_at, last_error, last_run_at)
       SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), ?
       FROM json_each(?) WHERE true
       ON CONFLICT (source) DO UPDATE SET
         ok = excluded.ok,
         last_run_at = excluded.last_run_at,
         last_error = CASE WHEN excluded.ok = 1 THEN source_health.last_error ELSE excluded.last_error END,
         last_success_at = COALESCE(excluded.last_success_at, source_health.last_success_at)`,
      now,
      JSON.stringify(data),
    ),
  ];
}

/* ---------------- common reads ---------------- */

export const jsonList = (xs: readonly string[]) => JSON.stringify(xs);

export function readCandlesStmt(symbols: readonly string[], tf: string, perSymbol: number): SqlStmt {
  return stmt(
    `SELECT symbol, t, o, h, l, c, v FROM (
       SELECT symbol, t, o, h, l, c, v, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY t DESC) AS rn
       FROM candles WHERE tf = ? AND symbol IN (SELECT value FROM json_each(?))
     ) WHERE rn <= ? ORDER BY symbol, t`,
    tf,
    jsonList(symbols),
    perSymbol,
  );
}

export function readSnapshotsStmt(keys: readonly string[]): SqlStmt {
  return stmt(`SELECT key, json, as_of, source FROM snapshots WHERE key IN (SELECT value FROM json_each(?))`, jsonList(keys));
}

export function parseJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== "string") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
