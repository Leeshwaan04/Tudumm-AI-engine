// Admin: users list/detail and actions (suspend, unsuspend, plan, notes, revoke-sessions).
// Every mutation writes an audit row in the SAME D1 batch as the change.
import { auditStmt } from "../lib/audit";
import { json } from "../lib/edge";
import { all, first, likeEscape, newId, nowIso, parseJson } from "../lib/db";
import { HttpError, notFound, readJsonObject } from "../lib/http";
import { PLAN_IDS, type PlanId } from "../lib/plans";
import { publicUser, USER_COLS, type UserRow } from "../lib/session";
import * as v from "../lib/validate";
import type { Ctx, RouteDef } from "../api/context";
import { param, requireAdmin } from "../api/context";
import { getConsents, getProfile, getUser } from "../api/userdata";
import { mapTicket, ticketMessages, type TicketRow } from "../api/support";

const PAGE_SIZE = 25;

async function listUsers(c: Ctx): Promise<Response> {
  requireAdmin(c);
  const sp = c.url.searchParams;
  const page = v.intParam(sp.get("page"), 1, 1, 10_000);
  const where: string[] = [];
  const binds: unknown[] = [];
  const q = (sp.get("q") ?? "").trim().slice(0, 100);
  if (q) {
    if (v.UUID_RE.test(q)) {
      where.push("u.id = ?");
      binds.push(q);
    } else {
      where.push("(u.email LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')");
      const like = `%${likeEscape(q.toLowerCase())}%`;
      binds.push(like, like);
    }
  }
  const plan = sp.get("plan");
  if (plan) {
    where.push("u.plan = ?");
    binds.push(v.oneOf(plan, "plan", PLAN_IDS));
  }
  const status = sp.get("status");
  if (status) {
    where.push("u.status = ?");
    binds.push(v.oneOf(status, "status", ["active", "suspended", "deleted"] as const));
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows, total] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT ${USER_COLS} FROM users u ${w} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`).bind(...binds, PAGE_SIZE, (page - 1) * PAGE_SIZE),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users u ${w}`).bind(...binds),
  ]);
  return json({
    items: ((rows?.results ?? []) as unknown as UserRow[]).map(publicUser),
    total: Number((total?.results?.[0] as { n?: number } | undefined)?.n ?? 0),
    page,
    pageSize: PAGE_SIZE,
  });
}

async function loadUser(c: Ctx): Promise<UserRow> {
  const id = v.uuid(param(c, "id"));
  const u = await getUser(c.env, id);
  if (!u) throw notFound();
  return u;
}

async function userDetail(c: Ctx): Promise<Response> {
  requireAdmin(c);
  const u = await loadUser(c);
  const id = u.id;
  const db = c.env.DB;
  const [sessions, watchlist, tracked, alerts, tickets, events, notes, payments] = await db.batch([
    db.prepare("SELECT id, kind, user_agent, created_at, last_used_at, expires_at, revoked_at FROM sessions WHERE user_id = ? ORDER BY last_used_at DESC LIMIT 50").bind(id),
    db.prepare("SELECT symbol, added_at FROM watchlist WHERE user_id = ? ORDER BY added_at LIMIT 200").bind(id),
    db.prepare("SELECT signal_id, symbol, added_at FROM tracked WHERE user_id = ? ORDER BY added_at LIMIT 200").bind(id),
    db.prepare("SELECT id, symbol, kind, threshold, one_shot, active, created_at, last_triggered_at FROM alerts WHERE user_id = ? ORDER BY created_at DESC LIMIT 500").bind(id),
    db.prepare("SELECT id, user_id, email, category, subject, body, status, created_at, updated_at FROM support_tickets WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50").bind(id),
    db.prepare("SELECT id, name, props, path, created_at, country, device, source FROM events WHERE user_id = ? ORDER BY created_at DESC LIMIT 200").bind(id),
    db.prepare("SELECT id, body, actor, created_at FROM admin_notes WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").bind(id),
    db.prepare("SELECT provider, provider_ref, amount_minor, currency, plan, status, created_at FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").bind(id),
  ]);
  const r = (x: D1Result | undefined) => (x?.results ?? []) as Record<string, unknown>[];
  const [profile, consents] = await Promise.all([getProfile(c.env, id), getConsents(c.env, id)]);
  const ticketRows = r(tickets) as unknown as TicketRow[];
  const msgs = await ticketMessages(
    c,
    ticketRows.map((t) => t.id),
  );
  return json({
    user: publicUser(u),
    rawPlan: { plan: u.plan, source: u.plan_source, expiresAt: u.plan_expires_at },
    profile,
    consents: consents.items,
    pendingConsents: consents.pending,
    sessions: r(sessions).map((s) => ({
      id: s.id,
      kind: s.kind,
      userAgent: s.user_agent,
      createdAt: s.created_at,
      lastUsedAt: s.last_used_at,
      expiresAt: s.expires_at,
      revokedAt: s.revoked_at,
    })),
    watchlist: r(watchlist).map((w) => ({ symbol: w.symbol, addedAt: w.added_at })),
    tracked: r(tracked).map((t) => ({ symbol: t.symbol, signalId: String(t.signal_id).startsWith("sym:") ? null : t.signal_id, addedAt: t.added_at })),
    alerts: r(alerts).map((a) => ({
      id: a.id,
      symbol: a.symbol,
      kind: a.kind,
      threshold: a.threshold,
      oneShot: a.one_shot === 1,
      active: a.active === 1,
      createdAt: a.created_at,
      lastTriggeredAt: a.last_triggered_at,
    })),
    tickets: ticketRows.map((t) => ({ ...mapTicket(t), messages: msgs.get(t.id) ?? [] })),
    timeline: r(events).map((e) => ({
      id: e.id,
      name: e.name,
      props: parseJson(e.props, null),
      path: e.path,
      at: e.created_at,
      country: e.country,
      device: e.device,
      source: e.source,
    })),
    notes: r(notes).map((n) => ({ id: n.id, body: n.body, actor: n.actor, createdAt: n.created_at })),
    payments: r(payments),
  });
}

function reason(body: Record<string, unknown>, required = true): string | null {
  if (!required && (body.reason === undefined || body.reason === null || body.reason === "")) return null;
  return v.str(body.reason, "reason", { min: 3, max: 500 });
}

async function suspend(c: Ctx): Promise<Response> {
  const a = requireAdmin(c);
  const u = await loadUser(c);
  const body = await readJsonObject(c.req, 4096);
  const why = reason(body);
  if (u.status === "deleted") throw new HttpError(409, "user_deleted");
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ? AND status <> 'deleted'").bind(u.id),
    c.env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(now, u.id),
    auditStmt(c.env, a.actor, "user.suspend", "user", u.id, { reason: why, previous: u.status }),
  ]);
  return json({ ok: true, user: publicUser({ ...u, status: "suspended" }) });
}

async function unsuspend(c: Ctx): Promise<Response> {
  const a = requireAdmin(c);
  const u = await loadUser(c);
  const body = await readJsonObject(c.req, 4096);
  const why = reason(body, false);
  if (u.status !== "suspended") throw new HttpError(409, "not_suspended");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ? AND status = 'suspended'").bind(u.id),
    auditStmt(c.env, a.actor, "user.unsuspend", "user", u.id, { reason: why }),
  ]);
  return json({ ok: true, user: publicUser({ ...u, status: "active" }) });
}

async function setPlan(c: Ctx): Promise<Response> {
  const a = requireAdmin(c);
  const u = await loadUser(c);
  const body = await readJsonObject(c.req, 4096);
  const plan = v.oneOf(body.plan, "plan", PLAN_IDS) as PlanId;
  const why = reason(body);
  if (u.status === "deleted") throw new HttpError(409, "user_deleted");
  let expiresAt: string | null = null;
  if (plan !== "free" && body.expiresAt !== undefined && body.expiresAt !== null) {
    expiresAt = v.isoDate(body.expiresAt, "expiresAt");
    if (Date.parse(expiresAt) <= Date.now()) throw v.invalid("expiresAt", "must be in the future");
  }
  const source = plan === "free" ? "default" : "admin_grant";
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET plan = ?, plan_source = ?, plan_expires_at = ? WHERE id = ?").bind(plan, source, expiresAt, u.id),
    auditStmt(c.env, a.actor, "user.plan_set", "user", u.id, { plan, expiresAt, reason: why, previous: { plan: u.plan, expiresAt: u.plan_expires_at, source: u.plan_source } }),
  ]);
  return json({ ok: true, user: publicUser({ ...u, plan, plan_source: source, plan_expires_at: expiresAt }) });
}

async function addNote(c: Ctx): Promise<Response> {
  const a = requireAdmin(c);
  const u = await loadUser(c);
  const body = await readJsonObject(c.req, 8192);
  const text = v.str(body.body, "body", { min: 1, max: 4000, multiline: true });
  const id = newId();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO admin_notes (id, user_id, body, actor, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, u.id, text, a.actor, nowIso()),
    auditStmt(c.env, a.actor, "user.note_add", "user", u.id, { noteId: id }),
  ]);
  return json({ ok: true, id }, {}, 201);
}

async function revokeSessions(c: Ctx): Promise<Response> {
  const a = requireAdmin(c);
  const u = await loadUser(c);
  const [res] = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(nowIso(), u.id),
    auditStmt(c.env, a.actor, "user.revoke_sessions", "user", u.id),
  ]);
  return json({ ok: true, revoked: Number(res?.meta?.changes ?? 0) });
}

/** GET /api/admin/events?name=&userId=&since=&page= — live activity feed. */
async function eventsFeed(c: Ctx): Promise<Response> {
  requireAdmin(c);
  const sp = c.url.searchParams;
  const page = v.intParam(sp.get("page"), 1, 1, 200);
  const limit = v.intParam(sp.get("limit"), 50, 1, 100);
  const where: string[] = [];
  const binds: unknown[] = [];
  const name = sp.get("name");
  if (name) {
    where.push("e.name = ?");
    binds.push(v.str(name, "name", { max: 40, pattern: /^[a-z_]+$/ }));
  }
  const userId = sp.get("userId");
  if (userId) {
    where.push("e.user_id = ?");
    binds.push(v.uuid(userId, "userId"));
  }
  const since = sp.get("since");
  if (since) {
    where.push("e.created_at >= ?");
    binds.push(v.isoDate(since, "since"));
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await all<Record<string, unknown>>(
    c.env,
    `SELECT e.id, e.user_id, e.anon_id, e.name, e.props, e.path, e.created_at, e.country, e.device, e.source
     FROM events e ${w} ORDER BY e.created_at DESC LIMIT ? OFFSET ?`,
    ...binds,
    limit,
    (page - 1) * limit,
  );
  return json({
    items: rows.map((e) => ({
      id: e.id,
      userId: e.user_id,
      anonId: e.anon_id,
      name: e.name,
      props: parseJson(e.props, null),
      path: e.path,
      at: e.created_at,
      country: e.country,
      device: e.device,
      source: e.source,
    })),
    page,
    limit,
    hasMore: rows.length === limit,
  });
}

export const adminUserRoutes: RouteDef[] = [
  { method: "GET", path: "/api/admin/users", auth: "admin", handler: listUsers },
  { method: "GET", path: "/api/admin/users/:id", auth: "admin", handler: userDetail },
  { method: "POST", path: "/api/admin/users/:id/suspend", auth: "admin", handler: suspend },
  { method: "POST", path: "/api/admin/users/:id/unsuspend", auth: "admin", handler: unsuspend },
  { method: "POST", path: "/api/admin/users/:id/plan", auth: "admin", handler: setPlan },
  { method: "POST", path: "/api/admin/users/:id/notes", auth: "admin", handler: addNote },
  { method: "POST", path: "/api/admin/users/:id/revoke-sessions", auth: "admin", handler: revokeSessions },
  { method: "GET", path: "/api/admin/events", auth: "admin", handler: eventsFeed },
];
