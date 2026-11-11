// Alerts CRUD + notifications. Every query is scoped by user_id (IDOR-safe: other users' ids 404).
import { json } from "../lib/edge";
import { all, first, newId, nowIso } from "../lib/db";
import { HttpError, notFound, readJsonObject } from "../lib/http";
import { effectivePlan, PLAN_BY_ID } from "../lib/plans";
import * as v from "../lib/validate";
import type { Ctx, RouteDef } from "./context";
import { param, requireUser } from "./context";

export const ALERT_KINDS = ["price_above", "price_below", "new_signal", "signal_update"] as const;
type AlertKind = (typeof ALERT_KINDS)[number];
const PRICE_KINDS: readonly string[] = ["price_above", "price_below"];

interface AlertRow {
  id: string;
  symbol: string;
  kind: AlertKind;
  threshold: number | null;
  one_shot: number;
  active: number;
  created_at: string;
  last_triggered_at: string | null;
}

const ALERT_COLS = "id, symbol, kind, threshold, one_shot, active, created_at, last_triggered_at";

function mapAlert(r: AlertRow) {
  return {
    id: r.id,
    symbol: r.symbol,
    kind: r.kind,
    threshold: r.threshold,
    oneShot: r.one_shot === 1,
    active: r.active === 1,
    createdAt: r.created_at,
    lastTriggeredAt: r.last_triggered_at,
  };
}

function alertSymbol(raw: unknown, kind: AlertKind): string {
  if (raw === "*" && !PRICE_KINDS.includes(kind)) return "*";
  return v.symbol(raw);
}

async function listAlerts(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const rows = await all<AlertRow>(c.env, `SELECT ${ALERT_COLS} FROM alerts WHERE user_id = ? ORDER BY created_at DESC LIMIT 500`, user.id);
  const plan = effectivePlan(user.plan, user.plan_expires_at);
  return json({ items: rows.map(mapAlert), limit: PLAN_BY_ID[plan].limits.alerts });
}

async function createAlert(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const body = await readJsonObject(c.req, 2048);
  const kind = v.oneOf(body.kind, "kind", ALERT_KINDS);
  const symbol = alertSymbol(body.symbol, kind);
  let threshold: number | null = null;
  if (PRICE_KINDS.includes(kind)) threshold = v.num(body.threshold, "threshold", { gt: 0, max: 1e12 });
  const oneShot = body.oneShot === undefined ? PRICE_KINDS.includes(kind) : v.bool(body.oneShot, "oneShot");

  const plan = effectivePlan(user.plan, user.plan_expires_at);
  const limit = PLAN_BY_ID[plan].limits.alerts;
  const id = newId();
  // Insert only while under the plan limit (single statement, no check-then-act race).
  const res = await c.env.DB.prepare(
    `INSERT INTO alerts (id, user_id, symbol, kind, threshold, one_shot, active, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, 1, ?7
     WHERE (SELECT COUNT(*) FROM alerts WHERE user_id = ?2) < ?8`,
  )
    .bind(id, user.id, symbol, kind, threshold, oneShot ? 1 : 0, nowIso(), limit)
    .run();
  if (!Number(res.meta?.changes ?? 0)) throw new HttpError(409, "alert_limit_reached", { limit, plan });
  const row = await first<AlertRow>(c.env, `SELECT ${ALERT_COLS} FROM alerts WHERE id = ? AND user_id = ?`, id, user.id);
  return json({ alert: row ? mapAlert(row) : null }, {}, 201);
}

async function getAlert(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const id = v.uuid(param(c, "id"));
  const row = await first<AlertRow>(c.env, `SELECT ${ALERT_COLS} FROM alerts WHERE id = ? AND user_id = ?`, id, user.id);
  if (!row) throw notFound();
  return json({ alert: mapAlert(row) });
}

async function patchAlert(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const id = v.uuid(param(c, "id"));
  const body = await readJsonObject(c.req, 2048);
  const row = await first<AlertRow>(c.env, `SELECT ${ALERT_COLS} FROM alerts WHERE id = ? AND user_id = ?`, id, user.id);
  if (!row) throw notFound();
  const active = body.active === undefined ? row.active === 1 : v.bool(body.active, "active");
  const oneShot = body.oneShot === undefined ? row.one_shot === 1 : v.bool(body.oneShot, "oneShot");
  let threshold = row.threshold;
  if (body.threshold !== undefined) {
    if (!PRICE_KINDS.includes(row.kind)) throw v.invalid("threshold", "only price alerts have a threshold");
    threshold = v.num(body.threshold, "threshold", { gt: 0, max: 1e12 });
  }
  await c.env.DB.prepare("UPDATE alerts SET active = ?, one_shot = ?, threshold = ? WHERE id = ? AND user_id = ?")
    .bind(active ? 1 : 0, oneShot ? 1 : 0, threshold, id, user.id)
    .run();
  const fresh = await first<AlertRow>(c.env, `SELECT ${ALERT_COLS} FROM alerts WHERE id = ? AND user_id = ?`, id, user.id);
  return json({ alert: fresh ? mapAlert(fresh) : null });
}

async function deleteAlert(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const id = v.uuid(param(c, "id"));
  const res = await c.env.DB.prepare("DELETE FROM alerts WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  if (!Number(res.meta?.changes ?? 0)) throw notFound();
  return json({ ok: true });
}

/* ---------------- notifications ---------------- */

async function listNotifications(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const unreadOnly = c.url.searchParams.get("unread") === "1";
  const limit = v.intParam(c.url.searchParams.get("limit"), 50, 1, 100);
  const beforeRaw = c.url.searchParams.get("before");
  const before = beforeRaw ? v.isoDate(beforeRaw, "before") : "9999-12-31T00:00:00.000Z";
  const rows = await all<{ id: string; kind: string; title: string; body: string | null; link: string | null; created_at: string; read_at: string | null }>(
    c.env,
    `SELECT id, kind, title, body, link, created_at, read_at FROM notifications
     WHERE user_id = ?1 AND created_at < ?2 ${unreadOnly ? "AND read_at IS NULL" : ""}
     ORDER BY created_at DESC LIMIT ?3`,
    user.id,
    before,
    limit,
  );
  const unread = await first<{ n: number }>(c.env, "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL", user.id);
  return json({
    items: rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link, createdAt: r.created_at, readAt: r.read_at })),
    unread: unread?.n ?? 0,
    nextBefore: rows.length === limit ? (rows[rows.length - 1]?.created_at ?? null) : null,
  });
}

async function markRead(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const body = await readJsonObject(c.req, 8192);
  const now = nowIso();
  let changed = 0;
  if (body.all === true) {
    const r = await c.env.DB.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").bind(now, user.id).run();
    changed = Number(r.meta?.changes ?? 0);
  } else {
    const ids = v.stringArray(body.ids, "ids", 100).map((x, i) => v.uuid(x, `ids[${i}]`));
    if (!ids.length) throw v.invalid("ids", "send {ids:[...]} or {all:true}");
    const r = await c.env.DB.prepare(
      "UPDATE notifications SET read_at = ?1 WHERE user_id = ?2 AND read_at IS NULL AND id IN (SELECT value FROM json_each(?3))",
    )
      .bind(now, user.id, JSON.stringify(ids))
      .run();
    changed = Number(r.meta?.changes ?? 0);
  }
  const unread = await first<{ n: number }>(c.env, "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL", user.id);
  return json({ ok: true, marked: changed, unread: unread?.n ?? 0 });
}

export const alertRoutes: RouteDef[] = [
  { method: "GET", path: "/api/v1/alerts", auth: "user", cors: true, handler: listAlerts },
  { method: "POST", path: "/api/v1/alerts", auth: "user", cors: true, handler: createAlert },
  { method: "GET", path: "/api/v1/alerts/:id", auth: "user", cors: true, handler: getAlert },
  { method: "PATCH", path: "/api/v1/alerts/:id", auth: "user", cors: true, handler: patchAlert },
  { method: "DELETE", path: "/api/v1/alerts/:id", auth: "user", cors: true, handler: deleteAlert },
  { method: "GET", path: "/api/v1/notifications", auth: "user", cors: true, handler: listNotifications },
  { method: "POST", path: "/api/v1/notifications/read", auth: "user", cors: true, handler: markRead },
];
