// Admin engine controls. Delegates to market/admin.ts (data+engine agent) AFTER admin auth (router)
// and AFTER writing the audit row. A failure in the engine is audited too and returned as 502.
import type { Env } from "../env";
import { audit } from "../lib/audit";
import { json } from "../lib/edge";
import { HttpError, readJsonObject } from "../lib/http";
import { logError } from "../lib/log";
import { enforce } from "../lib/ratelimit";
import * as v from "../lib/validate";
import type { Ctx, RouteDef } from "../api/context";
import { param, requireAdmin } from "../api/context";
import { engineHealth, invalidateSignal, listSignals, listStrategies, runEngineNow, setSignalHold, setStrategyEnabled } from "../market/admin";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

async function guarded<T>(env: Env, actor: string, action: string, targetId: string | null, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logError(`admin.engine.${action}`, err);
    await audit(env, actor, `${action}.failed`, "engine", targetId, { error: err instanceof Error ? err.message.slice(0, 200) : "error" });
    throw new HttpError(502, "engine_error", { message: "The engine call failed; see the audit log." });
  }
}

async function health(c: Ctx): Promise<Response> {
  const a = requireAdmin(c);
  return json(await guarded(c.env, a.actor, "engine.health", null, () => engineHealth(c.env)));
}

async function signals(c: Ctx): Promise<Response> {
  const a = requireAdmin(c);
  const sp = c.url.searchParams;
  const opts: { status?: string; market?: string; q?: string; limit?: number; offset?: number } = {
    limit: v.intParam(sp.get("limit"), 50, 1, 200),
    offset: v.intParam(sp.get("offset"), 0, 0, 100_000),
  };
  const status = sp.get("status");
  if (status) opts.status = v.oneOf(status, "status", ["pending", "active", "t1_hit", "sit_out", "closed", "held", "invalidated"] as const);
  const market = sp.get("market");
  if (market) opts.market = v.oneOf(market, "market", ["IN", "US", "EU", "CRYPTO", "FX", "CMDTY"] as const);
  const q = sp.get("q");
  if (q) opts.q = v.str(q, "q", { max: 40, pattern: /^[A-Za-z0-9 ._:-]+$/ });
  return json(await guarded(c.env, a.actor, "engine.signals", null, () => listSignals(c.env, opts)));
}

async function hold(c: Ctx): Promise<Response> {
  const a = requireAdmin(c);
  const id = v.str(param(c, "id"), "id", { max: 64, pattern: ID_RE });
  const body = await readJsonObject(c.req, 4096);
  const h = v.bool(body.hold, "hold");
  const reason = v.str(body.reason, "reason", { min: 3, max: 500 });
  await audit(c.env, a.actor, h ? "engine.signal_hold" : "engine.signal_release", "signal", id, { reason });
  await guarded(c.env, a.actor, "engine.signal_hold", id, () => setSignalHold(c.env, id, h, a.actor, reason));
  return json({ ok: true, id, hold: h });
}

async function invalidate(c: Ctx): Promise<Response> {
  const a = requireAdmin(c);
  const id = v.str(param(c, "id"), "id", { max: 64, pattern: ID_RE });
  const body = await readJsonObject(c.req, 4096);
  const reason = v.str(body.reason, "reason", { min: 3, max: 500 });
  await audit(c.env, a.actor, "engine.signal_invalidate", "signal", id, { reason });
  await guarded(c.env, a.actor, "engine.signal_invalidate", id, () => invalidateSignal(c.env, id, a.actor, reason));
  return json({ ok: true, id });
}

async function strategies(c: Ctx): Promise<Response> {
  const a = requireAdmin(c);
  return json({ items: await guarded(c.env, a.actor, "engine.strategies", null, () => listStrategies(c.env)) });
}

async function setStrategy(c: Ctx): Promise<Response> {
  const a = requireAdmin(c);
  const body = await readJsonObject(c.req, 2048);
  const strategy = v.str(body.strategy, "strategy", { max: 40, pattern: KEY_RE });
  const market = v.oneOf(body.market, "market", ["IN", "US", "EU", "CRYPTO", "FX", "CMDTY"] as const);
  const enabled = v.bool(body.enabled, "enabled");
  await audit(c.env, a.actor, "engine.strategy_set", "strategy", `${strategy}:${market}`, { enabled });
  await guarded(c.env, a.actor, "engine.strategy_set", `${strategy}:${market}`, () => setStrategyEnabled(c.env, strategy, market, enabled, a.actor));
  return json({ ok: true, strategy, market, enabled });
}

async function run(c: Ctx): Promise<Response> {
  const a = requireAdmin(c);
  await readJsonObject(c.req, 1024);
  await enforce(c.env, `engine_run:${a.sessionId}`, 6, 600);
  await audit(c.env, a.actor, "engine.run", "engine", null);
  const out = await guarded(c.env, a.actor, "engine.run", null, () => runEngineNow(c.env));
  return json(out);
}

export const adminEngineRoutes: RouteDef[] = [
  { method: "GET", path: "/api/admin/engine/health", auth: "admin", handler: health },
  { method: "GET", path: "/api/admin/engine/signals", auth: "admin", handler: signals },
  { method: "POST", path: "/api/admin/engine/signals/:id/hold", auth: "admin", handler: hold },
  { method: "POST", path: "/api/admin/engine/signals/:id/invalidate", auth: "admin", handler: invalidate },
  { method: "GET", path: "/api/admin/engine/strategies", auth: "admin", handler: strategies },
  { method: "POST", path: "/api/admin/engine/strategies", auth: "admin", handler: setStrategy },
  { method: "POST", path: "/api/admin/engine/run", auth: "admin", handler: run },
];
