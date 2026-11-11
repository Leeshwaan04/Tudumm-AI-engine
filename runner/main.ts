// Runner jobs: nse-eod | us-daily | fx-backfill | all. Heavy parsing happens here; compact rows go to D1.
import { parseArgs } from "./lib/args.ts";
import type { Args } from "./lib/args.ts";
import { WranglerDb, emptyBatch, postIngest } from "./lib/sink.ts";
import type { Batch } from "./lib/sink.ts";
import { healthStmts, parseJson, pruneCandles, readSnapshotsStmt, upsertCandles, upsertQuotes, upsertSnapshots } from "../worker/src/market/store.ts";
import { readFlag, runCycle } from "../worker/src/market/service.ts";
import { nseEod } from "./jobs/nse.ts";
import { usDaily } from "./jobs/us.ts";
import { fxBackfill } from "./jobs/fx.ts";

export interface Ctx {
  a: Args;
  db: WranglerDb | null;
  now: Date;
  /** Previous snapshot (wrangler mode reads D1; ingest mode reads the public API where possible). */
  snapshot<T>(key: string): Promise<{ json: T; asOf: string } | null>;
  snapshots<T>(keys: string[]): Promise<Map<string, { json: T; asOf: string }>>;
  commit(job: string, b: Batch, engineSymbols: string[]): Promise<void>;
}

const JOBS = ["nse-eod", "us-daily", "fx-backfill", "all"];

function makeCtx(a: Args): Ctx {
  const db = a.ingestUrl ? null : new WranglerDb(a);
  const now = new Date();
  const ctx: Ctx = {
    a,
    db,
    now,
    async snapshots<T>(keys: string[]) {
      const m = new Map<string, { json: T; asOf: string }>();
      if (!keys.length) return m;
      if (db) {
        const [rows] = await db.read([readSnapshotsStmt(keys)]);
        for (const r of rows ?? []) m.set(String(r.key), { json: parseJson<T>(r.json, null as T), asOf: String(r.as_of) });
        return m;
      }
      // ingest mode: previous option chains via the public derivatives route (rows + ivHistory)
      const base = new URL(a.ingestUrl as string).origin;
      for (const k of keys) {
        const [kind, sym] = k.split(":");
        if (kind !== "deriv" || !sym) continue;
        try {
          const res = await fetch(`${base}/api/v1/market/derivatives?symbol=${encodeURIComponent(sym)}`);
          const j = (await res.json()) as { available?: boolean; asOf?: string };
          if (j.available && j.asOf) m.set(k, { json: j as unknown as T, asOf: j.asOf });
        } catch {
          /* none */
        }
      }
      return m;
    },
    async snapshot<T>(key: string) {
      return (await ctx.snapshots<T>([key])).get(key) ?? null;
    },
    async commit(job, b, engineSymbols) {
      const nowIso = new Date().toISOString();
      b.snapshots.push({ key: `meta:runner:${job}`, json: { job, at: nowIso, candles: b.candles.length, quotes: b.quotes.length, snapshots: b.snapshots.length }, asOf: nowIso, source: job === "us-daily" ? "cboe" : job === "fx-backfill" ? "ecb-frankfurter" : "nse-archives" });
      const runEngine = a.noEngine ? [] : engineSymbols;
      if (!db) {
        const r = await postIngest(a.ingestUrl as string, job, b, runEngine);
        console.log(`  ✓ posted to ${a.ingestUrl}: ${JSON.stringify(r).slice(0, 400)}`);
        return;
      }
      const pairs = [...new Map(b.candles.map((c) => [`${c.symbol}|${c.tf}`, { symbol: c.symbol, tf: c.tf }])).values()];
      const stmts = [...upsertCandles(b.candles), ...pruneCandles(pairs, 400), ...upsertQuotes(b.quotes, nowIso), ...upsertSnapshots(b.snapshots, nowIso), ...healthStmts(b.health, nowIso)];
      const t0 = Date.now();
      await db.write(stmts);
      console.log(`  ✓ wrote ${b.candles.length} candles, ${b.quotes.length} quotes, ${b.snapshots.length} snapshots (${stmts.length} statements, ${a.remote ? "remote" : "local"} D1, ${Date.now() - t0} ms)`);
      if (!runEngine.length || a.dryRun) return;
      const requireApproval = await readFlag(db, "require_signal_approval", false);
      const r = await runCycle(db, { now: new Date(), runBy: "runner", evaluate: runEngine, requireApproval });
      console.log(
        `  ✓ engine v0: evaluated ${r.evaluated.join(",") || "none"}; unchanged ${r.unchanged.join(",") || "none"}; issued ${r.issued.join(",") || "none"}` +
          `${r.held.length ? `; held ${r.held.join(",")}` : ""}; sit-out ${r.sitOut.length}; transitions ${r.transitions.length}; ledger +${r.ledgerAppended}` +
          (r.events ? ` (events queued for the Worker's hook outbox: ${r.events})` : ""),
      );
    },
  };
  return ctx;
}

export async function main(argv: string[]): Promise<number> {
  let a: Args;
  try {
    a = parseArgs(argv);
  } catch (e) {
    console.error(`✖ ${e instanceof Error ? e.message : e}`);
    return 2;
  }
  if (!JOBS.includes(a.job)) {
    console.error(`usage: node --experimental-strip-types runner/ingest.ts <${JOBS.join("|")}> [--local|--remote] [--persist-to DIR] [--config PATH] [--ingest-url URL] [--date YYYYMMDD] [--backfill N] [--no-engine] [--dry-run] [--force-sec]`);
    return 2;
  }
  const ctx = makeCtx(a);
  console.log(`▸ tudumm runner: ${a.job} → ${a.ingestUrl ? a.ingestUrl : `${a.remote ? "REMOTE" : "local"} D1${a.persistTo ? ` (${a.persistTo})` : ""}`}`);
  const run = async (name: string, fn: (c: Ctx) => Promise<void>) => {
    const t0 = Date.now();
    console.log(`▸ ${name}`);
    await fn(ctx);
    console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  };
  if (a.job === "fx-backfill" || a.job === "all") await run("fx-backfill", fxBackfill);
  if (a.job === "nse-eod" || a.job === "all") await run("nse-eod", nseEod);
  if (a.job === "us-daily" || a.job === "all") await run("us-daily", usDaily);
  return 0;
}

export { emptyBatch };
