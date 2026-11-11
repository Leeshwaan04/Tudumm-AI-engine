// Admin: feature flags, announcements, audit log, dev outbox, compliance.
import { audit, auditStmt } from "../lib/audit";
import { json } from "../lib/edge";
import { all, first, newId, nowIso, parseJson } from "../lib/db";
import { FLAG_DEFAULTS, loadFlags } from "../lib/flags";
import { HttpError, notFound, readJsonObject } from "../lib/http";
import * as v from "../lib/validate";
import { devCodesActive } from "../api/config";
import type { Ctx, RouteDef } from "../api/context";
import { param, requireAdmin } from "../api/context";

/* ---------------- flags ---------------- */

const FLAG_KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;

async function listFlags(c: Ctx): Promise<Response> {
  requireAdmin(c);
  const flags = await loadFlags(c.env);
  for (const [k, def] of Object.entries(FLAG_DEFAULTS)) {
    if (!flags[k]) flags[k] = { key: k, enabled: def, value: null, updatedAt: "", updatedBy: "default" };
  }
  return json({ items: Object.values(flags).sort((a, b) => a.key.localeCompare(b.key)) });
}

async function getFlag(c: Ctx): Promise<Response> {
  requireAdmin(c);
  const key = v.str(param(c, "key"), "key", { max: 40, pattern: FLAG_KEY_RE });
  const flags = await loadFlags(c.env);
  const f = flags[key];
  if (!f && !(key in FLAG_DEFAULTS)) throw notFound();
  return json({ flag: f ?? { key, enabled: FLAG_DEFAULTS[key], value: null, updatedAt: null, updatedBy: "default" } });
}

async function putFlag(c: Ctx): Promise<Response> {
  const a = requireAdmin(c);
  const key = v.str(param(c, "key"), "key", { max: 40, pattern: FLAG_KEY_RE });
  const body = await readJsonObject(c.req, 8192);
  const enabled = v.bool(body.enabled, "enabled");
  let value: string | null = null;
  if (body.value !== undefined && body.value !== null) {
    value = JSON.stringify(body.value);
    if (value.length > 4000) throw v.invalid("value", "must be at most 4000 bytes of JSON");
  }
  const before = await first<{ enabled: number; value: string | null }>(c.env, "SELECT enabled, value FROM feature_flags WHERE key = ?", key);
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO feature_flags (key, enabled, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (key) DO UPDATE SET enabled = ?2, value = ?3, updated_at = ?4, updated_by = ?5`,
    ).bind(key, enabled ? 1 : 0, value, now, a.actor),
    auditStmt(c.env, a.actor, "flag.set", "flag", key, {
      before: before ? { enabled: before.enabled === 1, value: parseJson(before.value, null) } : null,
      after: { enabled, value: parseJson(value, null) },
    }),
  ]);
  return json({ flag: { key, enabled, value: parseJson(value, null), updatedAt: now, updatedBy: a.actor } });
}

/* ---------------- announcements ---------------- */

const LEVELS = ["info", "warning", "critical"] as const;

function mapAnn(r: Record<string, unknown>) {
  return {
    id: r.id,
    level: r.level,
    message: r.message,
    link: r.link,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    active: r.active === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function listAnnouncements(c: Ctx): Promise<Response> {
  requireAdmin(c);
  const rows = await all<Record<string, unknown>>(
    c.env,
    "SELECT id, level, message, link, starts_at, ends_at, active, created_at, updated_at FROM announcements ORDER BY created_at DESC LIMIT ?",
    100,
  );
  return json({ items: rows.map(mapAnn) });
}

function annFields(body: Record<string, unknown>, partial: boolean) {
  const out: Record<string, unknown> = {};
  if (!partial || body.level !== undefined) out.level = v.oneOf(body.level, "level", LEVELS);
  if (!partial || body.message !== undefined) out.message = v.str(body.message, "message", { min: 3, max: 500 });
  if (body.link !== undefined) out.link = v.safeLink(body.link, "link");
  if (body.startsAt !== undefined) out.starts_at = body.startsAt === null ? null : v.isoDate(body.startsAt, "startsAt");
  if (body.endsAt !== undefined) out.ends_at = body.endsAt === null ? null : v.isoDate(body.endsAt, "endsAt");
  if (body.active !== undefined) out.active = v.bool(body.active, "active") ? 1 : 0;
  return out;
}

async function createAnnouncement(c: Ctx): Promise<Response> {
  const a = requireAdmin(c);
  const body = await readJsonObject(c.req, 8192);
  const f = annFields(body, false);
  const id = newId();
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO announcements (id, level, message, link, starts_at, ends_at, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, f.level, f.message, f.link ?? null, f.starts_at ?? null, f.ends_at ?? null, f.active ?? 1, now, now),
    auditStmt(c.env, a.actor, "announcement.create", "announcement", id, { level: f.level, message: f.message, link: f.link ?? null }),
  ]);
  const row = await first<Record<string, unknown>>(c.env, "SELECT * FROM announcements WHERE id = ?", id);
  return json({ announcement: row ? mapAnn(row) : null }, {}, 201);
}

async function patchAnnouncement(c: Ctx): Promise<Response> {
  const a = requireAdmin(c);
  const id = v.uuid(param(c, "id"));
  const body = await readJsonObject(c.req, 8192);
  const f = annFields(body, true);
  const cols = Object.keys(f);
  if (!cols.length) throw v.invalid("body", "nothing to update");
  const exists = await first(c.env, "SELECT id FROM announcements WHERE id = ?", id);
  if (!exists) throw notFound();
  // Column names come from the fixed whitelist in annFields(), values are bound.
  const sets = cols.map((k) => `${k} = ?`).join(", ");
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE announcements SET ${sets}, updated_at = ? WHERE id = ?`).bind(...cols.map((k) => f[k]), nowIso(), id),
    auditStmt(c.env, a.actor, "announcement.update", "announcement", id, f),
  ]);
  const row = await first<Record<string, unknown>>(c.env, "SELECT * FROM announcements WHERE id = ?", id);
  return json({ announcement: row ? mapAnn(row) : null });
}

/* ---------------- audit log (read-only; no update/delete route exists) ---------------- */

async function auditList(c: Ctx): Promise<Response> {
  requireAdmin(c);
  const sp = c.url.searchParams;
  const page = v.intParam(sp.get("page"), 1, 1, 1000);
  const limit = 50;
  const where: string[] = [];
  const binds: unknown[] = [];
  const action = sp.get("action");
  if (action) {
    where.push("action = ?");
    binds.push(v.str(action, "action", { max: 80, pattern: /^[a-z0-9_.]+$/ }));
  }
  const targetId = sp.get("targetId");
  if (targetId) {
    where.push("target_id = ?");
    binds.push(v.str(targetId, "targetId", { max: 80 }));
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await all<Record<string, unknown>>(
    c.env,
    `SELECT id, actor, action, target_type, target_id, detail, created_at FROM audit_log ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ...binds,
    limit,
    (page - 1) * limit,
  );
  return json({
    items: rows.map((r) => ({
      id: r.id,
      actor: r.actor,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      detail: parseJson(r.detail, null),
      at: r.created_at,
    })),
    page,
    hasMore: rows.length === limit,
  });
}

/* ---------------- dev outbox (UAT only) ---------------- */

async function devOutbox(c: Ctx): Promise<Response> {
  const a = requireAdmin(c);
  if (!devCodesActive(c.env)) throw new HttpError(404, "dev_codes_off", { message: "Dev codes are off (email delivery is configured or AUTH_DEV_CODES isn't 'on')." });
  const rows = await all<{ email_masked: string; code: string; created_at: string; expires_at: string; consumed_at: string | null; attempts: number | null }>(
    c.env,
    `SELECT d.email_masked, d.code, d.created_at, d.expires_at, o.consumed_at, o.attempts
     FROM dev_outbox d LEFT JOIN otp_codes o ON o.id = d.otp_id ORDER BY d.created_at DESC LIMIT 50`,
  );
  await audit(c.env, a.actor, "dev_outbox.view", "dev_outbox", null, { count: rows.length });
  const now = Date.now();
  return json({
    items: rows.map((r) => ({
      email: r.email_masked,
      code: r.code,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      state: r.consumed_at ? "used_or_replaced" : Date.parse(r.expires_at) <= now ? "expired" : "valid",
      attempts: r.attempts ?? 0,
    })),
  });
}

/* ---------------- compliance ---------------- */

async function compliance(c: Ctx): Promise<Response> {
  requireAdmin(c);
  const now = Date.now();
  const d7 = new Date(now - 7 * 86_400_000).toISOString();
  const d21 = new Date(now - 21 * 86_400_000).toISOString();
  const db = c.env.DB;
  const [consents, pending, recent, g7, g21] = await db.batch([
    db.prepare(
      `SELECT kind, version, COUNT(*) AS total, SUM(CASE WHEN withdrawn_at IS NULL THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN withdrawn_at IS NOT NULL THEN 1 ELSE 0 END) AS withdrawn
       FROM consents GROUP BY kind, version ORDER BY kind, version DESC`,
    ),
    db.prepare("SELECT id, user_id, kind, status, created_at FROM data_requests WHERE status = 'pending' ORDER BY created_at LIMIT 100"),
    db.prepare("SELECT kind, COUNT(*) AS n FROM data_requests WHERE created_at >= ? GROUP BY kind").bind(new Date(now - 30 * 86_400_000).toISOString()),
    db
      .prepare(
        "SELECT id, user_id, email, subject, status, created_at FROM support_tickets WHERE category = 'grievance' AND status IN ('open', 'pending') AND created_at < ? ORDER BY created_at LIMIT 100",
      )
      .bind(d7),
    db
      .prepare("SELECT COUNT(*) AS n FROM support_tickets WHERE category = 'grievance' AND status IN ('open', 'pending') AND created_at < ?")
      .bind(d21),
  ]);
  const rows = (r: D1Result | undefined) => (r?.results ?? []) as Record<string, unknown>[];
  const g7rows = rows(g7);
  return json({
    consents: rows(consents),
    dataRequests: { pending: rows(pending), last30Days: rows(recent) },
    grievances: {
      olderThan7Days: g7rows.length,
      olderThan21Days: Number(rows(g21)[0]?.n ?? 0),
      items: g7rows.map((t) => ({ ...t, overdue21: String(t.created_at) < d21 })),
    },
    notes: "Grievance SLA reference: acknowledge within 7 days and resolve within 21 days (owner to confirm against the applicable rules).",
  });
}

export const adminContentRoutes: RouteDef[] = [
  { method: "GET", path: "/api/admin/flags", auth: "admin", handler: listFlags },
  { method: "GET", path: "/api/admin/flags/:key", auth: "admin", handler: getFlag },
  { method: "PUT", path: "/api/admin/flags/:key", auth: "admin", handler: putFlag },
  { method: "GET", path: "/api/admin/announcements", auth: "admin", handler: listAnnouncements },
  { method: "POST", path: "/api/admin/announcements", auth: "admin", handler: createAnnouncement },
  { method: "PATCH", path: "/api/admin/announcements/:id", auth: "admin", handler: patchAnnouncement },
  { method: "GET", path: "/api/admin/audit", auth: "admin", handler: auditList },
  { method: "GET", path: "/api/admin/dev-outbox", auth: "admin", handler: devOutbox },
  { method: "GET", path: "/api/admin/compliance", auth: "admin", handler: compliance },
];
