// Fixed-window rate limiter in D1 (one atomic UPSERT ... RETURNING per check).
// Keys never contain raw PII: callers pass hashes (ip hash, email hash) or opaque ids.
import type { Env } from "../env";
import { HttpError } from "./http";

export interface RateResult {
  ok: boolean;
  count: number;
  limit: number;
  retryAfter: number; // seconds until the window resets
}

export async function hit(env: Pick<Env, "DB">, key: string, limit: number, windowSec: number): Promise<RateResult> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSec);
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, window_start) VALUES (?1, 1, ?2)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start = ?2 THEN rate_limits.count + 1 ELSE 1 END,
       window_start = ?2
     RETURNING count`,
  )
    .bind(key, windowStart)
    .first<{ count: number }>();
  const count = Number(row?.count ?? 1);
  return { ok: count <= limit, count, limit, retryAfter: windowStart + windowSec - now };
}

/** Throws 429 (with Retry-After) when the key is over its limit. */
export async function enforce(env: Pick<Env, "DB">, key: string, limit: number, windowSec: number): Promise<void> {
  const r = await hit(env, key, limit, windowSec);
  if (!r.ok) {
    throw new HttpError(429, "rate_limited", { retryAfter: r.retryAfter }, { "retry-after": String(Math.max(1, r.retryAfter)) });
  }
}

/** Opportunistic housekeeping; called from waitUntil on a small fraction of requests. */
export async function prune(env: Pick<Env, "DB">): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const dayAgoIso = new Date(Date.now() - 86_400_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(now - 86_400),
    env.DB.prepare("DELETE FROM otp_codes WHERE created_at < ?").bind(dayAgoIso),
    env.DB.prepare("DELETE FROM ext_link_codes WHERE created_at < ? AND (consumed_at IS NOT NULL OR expires_at < ?)").bind(dayAgoIso, dayAgoIso),
    env.DB.prepare("DELETE FROM dev_outbox WHERE created_at < ?").bind(dayAgoIso),
  ]);
}
