// Where the runner writes: (a) D1 through `wrangler d1 execute` (local by default, --remote opt-in),
// or (b) the Worker's POST /api/internal/ingest (Bearer INGEST_TOKEN). Reads (engine state, previous
// snapshots) use `wrangler d1 execute --json` in mode (a).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MarketDb, Row, SqlStmt, SqlVal } from "../../worker/src/market/store.ts";
import type { CandleRow, QuoteRow, SnapshotRow, SourceId } from "../../worker/src/market/types.ts";
import type { Args } from "./args.ts";

export const ROOT = resolve(import.meta.dirname, "../..");
const TMP = join(ROOT, "runner", ".tmp");

/** Inline bound parameters as SQL literals (strings quoted with '' escaping; numbers must be finite). */
export function inline(s: SqlStmt): string {
  let i = 0;
  let out = "";
  let q: string | null = null;
  for (const ch of s.sql) {
    if (q) {
      out += ch;
      if (ch === q) q = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      q = ch;
      out += ch;
      continue;
    }
    if (ch === "?") {
      out += lit(s.params[i++] ?? null);
      continue;
    }
    out += ch;
  }
  if (i !== s.params.length) throw new Error(`inline: ${s.params.length} params but ${i} placeholders`);
  return out.replace(/\s+\n/g, "\n");
}

function lit(v: SqlVal): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("inline: non-finite number");
    return String(v);
  }
  return `'${String(v).replace(/\u0000/g, "").replace(/'/g, "''")}'`;
}

function wranglerArgs(a: Args): string[] {
  const x = ["wrangler", "d1", "execute", "tudumm-db", a.remote ? "--remote" : "--local", "--yes"];
  if (a.persistTo) x.push("--persist-to", resolve(a.persistTo));
  if (a.config) x.push("--config", resolve(a.config));
  return x;
}

function runWrangler(a: Args, extra: string[]): string {
  const local = join(ROOT, "node_modules", ".bin", "wrangler");
  const [cmd, args] = existsSync(local) ? [local, wranglerArgs(a).slice(1)] : ["npx", wranglerArgs(a)];
  const r = spawnSync(cmd, [...args, ...extra], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  if (r.status !== 0) throw new Error(`wrangler d1 execute failed (${r.status}): ${(r.stderr || r.stdout || "").slice(-800)}`);
  return r.stdout;
}

export class WranglerDb implements MarketDb {
  a: Args;
  statements = 0;
  constructor(a: Args) {
    this.a = a;
  }
  async read(stmts: SqlStmt[]): Promise<Row[][]> {
    if (!stmts.length) return [];
    const sql = stmts.map(inline).join(";\n") + ";";
    const out = runWrangler(this.a, ["--json", "--command", sql]);
    const start = out.indexOf("[");
    const parsed = JSON.parse(out.slice(start)) as { results?: Row[] }[];
    return parsed.map((r) => r.results ?? []);
  }
  async write(stmts: SqlStmt[]): Promise<void> {
    if (!stmts.length) return;
    mkdirSync(TMP, { recursive: true });
    for (let i = 0; i < stmts.length; i += 500) {
      const chunk = stmts.slice(i, i + 500);
      const file = join(TMP, `batch-${process.pid}-${Date.now()}-${i}.sql`);
      writeFileSync(file, chunk.map(inline).join(";\n") + ";\n");
      this.statements += chunk.length;
      if (this.a.dryRun) {
        console.log(`  (dry-run) would execute ${chunk.length} statements: ${file}`);
        continue;
      }
      try {
        runWrangler(this.a, ["--file", file]);
      } finally {
        rmSync(file, { force: true });
      }
    }
  }
}

export interface Batch {
  candles: CandleRow[];
  quotes: QuoteRow[];
  snapshots: SnapshotRow[];
  health: { source: SourceId; ok: boolean; error: string | null }[];
}

export const emptyBatch = (): Batch => ({ candles: [], quotes: [], snapshots: [], health: [] });

/** POST a batch to /api/internal/ingest in chunks (< 1 MB each), optionally asking for an engine run. */
export async function postIngest(url: string, job: string, b: Batch, runEngine: string[]): Promise<unknown> {
  const token = process.env.INGEST_TOKEN;
  if (!token) throw new Error("INGEST_TOKEN env var is required with --ingest-url");
  const send = async (body: Record<string, unknown>) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ job, ...body }) });
    const text = await res.text();
    if (!res.ok) throw new Error(`ingest ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as unknown;
  };
  for (let i = 0; i < b.candles.length; i += 1500) await send({ candles: b.candles.slice(i, i + 1500) });
  for (let i = 0; i < b.snapshots.length; i += 8) await send({ snapshots: b.snapshots.slice(i, i + 8) });
  return send({ quotes: b.quotes.slice(0, 50), health: b.health, runEngine });
}
