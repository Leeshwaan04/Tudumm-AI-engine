// fx-backfill: ~400 days of ECB reference rates (Frankfurter) for EURUSD, USDINR, USDJPY.
import type { Ctx } from "../main.ts";
import { emptyBatch } from "../lib/sink.ts";
import { fetchFxSeries } from "../../worker/src/data/frankfurter.ts";
import { fxRows } from "../../worker/src/market/jobs.ts";

export async function fxBackfill(ctx: Ctx): Promise<void> {
  const b = emptyBatch();
  const end = ctx.now.toISOString().slice(0, 10);
  const start = new Date(ctx.now.getTime() - 400 * 86400000).toISOString().slice(0, 10);
  let pts;
  try {
    pts = await fetchFxSeries(start, end);
    b.health.push({ source: "ecb-frankfurter", ok: true, error: null });
  } catch (e) {
    b.health.push({ source: "ecb-frankfurter", ok: false, error: e instanceof Error ? e.message : "error" });
    await ctx.commit("fx-backfill", b, []);
    throw new Error(`Frankfurter (ECB) unreachable: ${e instanceof Error ? e.message : e}`);
  }
  const { candles, quotes, usd } = fxRows(pts, ctx.now.toISOString());
  b.candles.push(...candles);
  b.quotes.push(...quotes);
  if (usd) b.snapshots.push(usd);
  console.log(`  ECB ${pts.length} fixes ${pts[0]?.date} … ${pts[pts.length - 1]?.date}; EURUSD ${quotes[0]?.price}, USDINR ${quotes[1]?.price}, USDJPY ${quotes[2]?.price}`);
  await ctx.commit("fx-backfill", b, ["EURUSD", "USDINR", "USDJPY"]);
}
