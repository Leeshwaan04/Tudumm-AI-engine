// Cron dispatcher (data + engine agent). Keep each invocation lean (possible 10 ms CPU Free plan):
// small JSON fetches, bulk JSON writes (few D1 statements), engine math on ~250 bars per instrument.
import type { Env } from "./env";
import type { MarketDb } from "./market/store";
import { d1Db, healthStmts, stmt } from "./market/store";
import { Health } from "./data/http";
import { BINANCE_SET, cryptoJob, dueDailyEvaluations, fxJob, FX_SET, usQuotesJob, usSessionOpen } from "./market/jobs";
import type { JobOutput } from "./market/jobs";
import { readFlag, runCycle } from "./market/service";
import { dispatchOutbox, dispatchPrices } from "./market/outbox";
import { runWatchdog } from "./market/watchdog";

/** Wraps a MarketDb and counts statements (D1 Free plan allows 50 queries per invocation). */
function counted(db: MarketDb): MarketDb & { n: number } {
  const w = {
    n: 0,
    async read(s: Parameters<MarketDb["read"]>[0]) {
      w.n += s.length;
      return db.read(s);
    },
    async write(s: Parameters<MarketDb["write"]>[0]) {
      w.n += s.length;
      return db.write(s);
    },
  };
  return w;
}

function merge(a: JobOutput, b: JobOutput): JobOutput {
  return {
    writes: [...a.writes, ...b.writes],
    memBars: { ...a.memBars, ...b.memBars },
    memSnapshots: { ...a.memSnapshots, ...b.memSnapshots },
    memQuotes: { ...a.memQuotes, ...b.memQuotes },
    prices: { ...a.prices, ...b.prices },
    symbols: [...a.symbols, ...b.symbols],
  };
}

export interface CycleSummary {
  summary: string;
  d1Statements: number;
}

// The every-15-minutes job (also the admin "Run engine" button).
export async function runMarketCycle(env: Env, now: Date, opts: { forceFetch?: boolean; runBy?: "cron" | "admin"; dailyBudget?: number } = {}): Promise<CycleSummary> {
  const db = counted(d1Db(env.DB));
  const health = new Health();
  const nowIso = now.toISOString();
  const liveData = await readFlag(db, "live_data", true);
  let job: JobOutput = { writes: [], memBars: {}, memSnapshots: {}, memQuotes: {}, prices: {}, symbols: [] };
  const notes: string[] = [];
  if (liveData) {
    const [probe] = await db.read([
      stmt(`SELECT (SELECT COUNT(*) FROM quotes WHERE symbol = 'SPY') AS spy, (SELECT as_of FROM quotes WHERE symbol = 'BTCUSDT') AS btc_as_of`),
    ]);
    const usDue = opts.forceFetch || usSessionOpen(now) || Number(probe?.[0]?.spy ?? 0) === 0;
    // The live runner (runner/live.ts) streams crypto from its own egress every few seconds; when it has
    // pushed within 3 minutes, don't re-fetch from Cloudflare (Binance/Bybit refuse some CF egress and
    // would only flap the source health). Evaluation below still runs on the stored bars.
    const btcAsOf = probe?.[0]?.btc_as_of ? Date.parse(String(probe[0].btc_as_of)) : 0;
    const runnerFed = !opts.forceFetch && now.getTime() - btcAsOf < 180_000;
    const empty: JobOutput = { writes: [], memBars: {}, memSnapshots: {}, memQuotes: {}, prices: {}, symbols: [] };
    const [c, u] = await Promise.all([runnerFed ? Promise.resolve(empty) : cryptoJob(db, health, now), usDue ? usQuotesJob(health, now) : Promise.resolve(null)]);
    job = u ? merge(c, u) : c;
    if (runnerFed) notes.push("crypto streamed by the live runner: fetch skipped");
    if (!usDue) notes.push("US closed: quotes skipped");
    await db.write([...job.writes, ...healthStmts(health.entries(), nowIso)]);
  } else notes.push("live_data flag is off: fetching skipped");
  const daily = await dueDailyEvaluations(db, now, opts.dailyBudget ?? 2);
  const requireApproval = await readFlag(db, "require_signal_approval", false);
  const r = await runCycle(db, {
    now,
    runBy: opts.runBy ?? "cron",
    evaluate: [...BINANCE_SET.map((i) => i.symbol), ...daily],
    memBars: job.memBars,
    memSnapshots: job.memSnapshots,
    memQuotes: job.memQuotes,
    requireApproval,
  });
  const ob = await dispatchOutbox(env, db);
  const pr = await dispatchPrices(env, db, job.prices);
  const summary =
    `fetched ${job.symbols.length} instruments; evaluated ${r.evaluated.join(",") || "none"} (unchanged ${r.unchanged.length}); ` +
    `issued ${r.issued.join(",") || "none"}${r.held.length ? `; held ${r.held.join(",")}` : ""}; transitions ${r.transitions.length}; ` +
    `ledger +${r.ledgerAppended}; hooks: ${ob.delivered} events, ${pr} prices` +
    (notes.length ? `; ${notes.join("; ")}` : "") +
    `; health ${health.entries().map((h) => `${h.source}:${h.ok ? "ok" : h.error}`).join(" ")}; d1 statements ${db.n}`;
  return { summary, d1Statements: db.n };
}

async function fxCycle(env: Env, now: Date): Promise<string> {
  const db = counted(d1Db(env.DB));
  const health = new Health();
  const job = await fxJob(db, health, now);
  await db.write([...job.writes, ...healthStmts(health.entries(), now.toISOString())]);
  const r = await runCycle(db, { now, runBy: "cron", evaluate: FX_SET.map((i) => i.symbol), memQuotes: job.memQuotes, requireApproval: await readFlag(db, "require_signal_approval", false) });
  const ob = await dispatchOutbox(env, db);
  await dispatchPrices(env, db, job.prices);
  return `fx: ${job.symbols.length} quotes; evaluated ${r.evaluated.join(",") || "none"}; issued ${r.issued.join(",") || "none"}; hooks ${ob.delivered}; d1 statements ${db.n}`;
}

async function nseHandoff(env: Env, now: Date): Promise<string> {
  // NSE zips (0.2-1.3 MB) + CSV parsing are too heavy for a 10 ms Worker: the runner owns them
  // (.github/workflows/ingest.yml at the same time). Here we only record that and keep lifecycle moving.
  const db = d1Db(env.DB);
  const iso = now.toISOString();
  await db.write([
    stmt(
      `INSERT OR REPLACE INTO snapshots (key, json, as_of, source, updated_at) VALUES ('meta:nse_cron', ?, ?, 'nse-archives', ?)`,
      JSON.stringify({ note: "NSE EOD ingestion runs in the Node runner (runner/ingest.ts nse-eod), not in the Worker.", at: iso }),
      iso,
      iso,
    ),
  ]);
  const r = await runCycle(db, { now, runBy: "cron", evaluate: [], requireApproval: false });
  const ob = await dispatchOutbox(env, db);
  return `nse: runner-owned; lifecycle transitions ${r.transitions.length}; hooks ${ob.delivered}`;
}

export async function runScheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
  const now = new Date(event.scheduledTime || Date.now());
  try {
    let msg: string;
    switch (event.cron) {
      case "45 13 * * 1-5":
        msg = await nseHandoff(env, now);
        break;
      case "30 15 * * 1-5":
        msg = await fxCycle(env, now);
        break;
      case "* 3-10 * * 1-5": // every minute 08:30–16:29 IST on weekdays: India feed watchdog + Kite reminder
        msg = await runWatchdog(env, d1Db(env.DB), now.getTime(), "india");
        break;
      default:
        msg = (await runMarketCycle(env, now)).summary;
        msg += `; ${await runWatchdog(env, d1Db(env.DB), now.getTime(), "crypto")}`;
    }
    console.log(`[cron ${event.cron}] ${msg}`);
  } catch (e) {
    console.error(`[cron ${event.cron}] failed: ${e instanceof Error ? e.message : "error"}`);
  }
}
