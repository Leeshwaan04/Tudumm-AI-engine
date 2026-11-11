// Worker-only: deliver queued signal events and fresh prices to backend-core's hooks.
// signal_events rows with notified_at NULL form the outbox (written by the cron, runner, ingest or admin).
import type { Env } from "../env";
import { onPricesUpdated, onSignalEvent } from "../api/hooks";
import type { SignalEvent } from "./types";
import type { MarketDb } from "./store";
import { parseJson, stmt } from "./store";

export async function dispatchOutbox(env: Env, db: MarketDb, limit = 40): Promise<{ delivered: number; failed: number }> {
  const [rows] = await db.read([stmt(`SELECT id, signal_id, symbol, market, type, direction, at, detail FROM signal_events WHERE notified_at IS NULL ORDER BY id LIMIT ?`, limit)]);
  if (!rows?.length) return { delivered: 0, failed: 0 };
  const ok: number[] = [];
  const bad: [number, string][] = [];
  for (const r of rows) {
    const ev: SignalEvent = {
      type: r.type as SignalEvent["type"],
      signalId: String(r.signal_id),
      symbol: String(r.symbol),
      market: String(r.market),
      direction: (r.direction as SignalEvent["direction"]) ?? null,
      at: String(r.at),
      detail: parseJson<Record<string, unknown> | undefined>(r.detail, undefined),
    };
    try {
      await onSignalEvent(env, ev);
      ok.push(Number(r.id));
    } catch (e) {
      // marked as notified anyway (no infinite retries); the error is kept for ops
      bad.push([Number(r.id), e instanceof Error ? e.message.slice(0, 200) : "hook_error"]);
    }
  }
  const now = new Date().toISOString();
  const writes = [stmt(`UPDATE signal_events SET notified_at = ? WHERE id IN (SELECT value FROM json_each(?))`, now, JSON.stringify([...ok, ...bad.map((b) => b[0])]))];
  if (bad.length) writes.push(stmt(`UPDATE signal_events SET notify_error = json_extract(?, '$."' || id || '"') WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(Object.fromEntries(bad)), JSON.stringify(bad.map((b) => b[0]))));
  await db.write(writes);
  return { delivered: ok.length, failed: bad.length };
}

/**
 * Call onPricesUpdated with every instrument quote newer than the last delivery watermark
 * (covers prices written by the runner between cron runs).
 */
export async function dispatchPrices(env: Env, db: MarketDb, fresh: Record<string, number> = {}): Promise<number> {
  const [wm] = await db.read([stmt(`SELECT json FROM snapshots WHERE key = 'meta:prices_hook'`)]);
  const since = parseJson<{ at?: string }>(wm?.[0]?.json, {}).at ?? "1970-01-01T00:00:00.000Z";
  const [rows] = await db.read([stmt(`SELECT q.symbol, q.price, q.updated_at FROM quotes q JOIN instruments i ON i.symbol = q.symbol WHERE q.updated_at > ?`, since)]);
  const prices: Record<string, number> = { ...fresh };
  let maxAt = since;
  for (const r of rows ?? []) {
    prices[String(r.symbol)] = Number(r.price);
    if (String(r.updated_at) > maxAt) maxAt = String(r.updated_at);
  }
  if (!Object.keys(prices).length) return 0;
  try {
    await onPricesUpdated(env, prices);
  } catch (e) {
    console.error("onPricesUpdated failed", e instanceof Error ? e.message : "error");
  }
  await db.write([stmt(`INSERT OR REPLACE INTO snapshots (key, json, as_of, source, updated_at) VALUES ('meta:prices_hook', ?, ?, 'engine', ?)`, JSON.stringify({ at: maxAt }), maxAt, new Date().toISOString())]);
  return Object.keys(prices).length;
}
