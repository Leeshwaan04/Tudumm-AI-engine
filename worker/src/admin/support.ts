// Admin support desk: list, view, reply (notifies the user), status changes. All audited.
import { auditStmt } from "../lib/audit";
import { json } from "../lib/edge";
import { all, first, newId, nowIso } from "../lib/db";
import { sendEmail } from "../lib/email";
import { notFound, readJsonObject } from "../lib/http";
import * as v from "../lib/validate";
import type { Ctx, RouteDef } from "../api/context";
import { param, requireAdmin } from "../api/context";
import { mapTicket, TICKET_CATEGORIES, TICKET_STATUSES, ticketMessages, type TicketRow } from "../api/support";

const COLS = "id, user_id, email, category, subject, body, status, created_at, updated_at";

async function list(c: Ctx): Promise<Response> {
  requireAdmin(c);
  const sp = c.url.searchParams;
  const page = v.intParam(sp.get("page"), 1, 1, 1000);
  const limit = 50;
  const where: string[] = [];
  const binds: unknown[] = [];
  const status = sp.get("status");
  if (status) {
    where.push("status = ?");
    binds.push(v.oneOf(status, "status", TICKET_STATUSES));
  }
  const category = sp.get("category");
  if (category) {
    where.push("category = ?");
    binds.push(v.oneOf(category, "category", TICKET_CATEGORIES));
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await all<TicketRow>(c.env, `SELECT ${COLS} FROM support_tickets ${w} ORDER BY updated_at DESC LIMIT ? OFFSET ?`, ...binds, limit, (page - 1) * limit);
  return json({ items: rows.map(mapTicket), page, hasMore: rows.length === limit });
}

async function load(c: Ctx): Promise<TicketRow> {
  const id = v.uuid(param(c, "id"));
  const t = await first<TicketRow>(c.env, `SELECT ${COLS} FROM support_tickets WHERE id = ?`, id);
  if (!t) throw notFound();
  return t;
}

async function detail(c: Ctx): Promise<Response> {
  requireAdmin(c);
  const t = await load(c);
  const msgs = await ticketMessages(c, [t.id]);
  return json({ ticket: { ...mapTicket(t), messages: msgs.get(t.id) ?? [] } });
}

async function reply(c: Ctx): Promise<Response> {
  const a = requireAdmin(c);
  const t = await load(c);
  const body = await readJsonObject(c.req, 16 * 1024);
  const text = v.str(body.body, "body", { min: 1, max: 5000, multiline: true });
  const status = body.status === undefined ? "pending" : v.oneOf(body.status, "status", TICKET_STATUSES);
  const now = nowIso();
  const stmts = [
    c.env.DB.prepare("INSERT INTO ticket_messages (id, ticket_id, author, body, created_at) VALUES (?, ?, 'admin', ?, ?)").bind(newId(), t.id, text, now),
    c.env.DB.prepare("UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?").bind(status, now, t.id),
    auditStmt(c.env, a.actor, "support.reply", "ticket", t.id, { status, length: text.length }),
  ];
  if (t.user_id) {
    stmts.push(
      c.env.DB.prepare(
        "INSERT OR IGNORE INTO notifications (id, user_id, kind, title, body, link, created_at, dedupe_key) VALUES (?, ?, 'support_reply', ?, ?, '/app/profile#support', ?, NULL)",
      ).bind(newId(), t.user_id, `Reply on: ${t.subject.slice(0, 80)}`, text.slice(0, 280), now),
    );
  }
  await c.env.DB.batch(stmts);
  // Email copy when a provider exists (ticket email is what the requester gave us / their account email).
  const emailed = await sendEmail(c.env, {
    to: t.email,
    subject: `Re: ${t.subject.slice(0, 120)} [Tudumm support]`,
    text: `${text}\n\n— Tudumm support\n\nReply from your Tudumm profile (Support) to continue this conversation.`,
  });
  return json({ ok: true, status, emailed }, {}, 201);
}

async function setStatus(c: Ctx): Promise<Response> {
  const a = requireAdmin(c);
  const t = await load(c);
  const body = await readJsonObject(c.req, 2048);
  const status = v.oneOf(body.status, "status", TICKET_STATUSES);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?").bind(status, nowIso(), t.id),
    auditStmt(c.env, a.actor, "support.status", "ticket", t.id, { from: t.status, to: status }),
  ]);
  return json({ ok: true, status });
}

export const adminSupportRoutes: RouteDef[] = [
  { method: "GET", path: "/api/admin/support", auth: "admin", handler: list },
  { method: "GET", path: "/api/admin/support/:id", auth: "admin", handler: detail },
  { method: "POST", path: "/api/admin/support/:id/reply", auth: "admin", handler: reply },
  { method: "POST", path: "/api/admin/support/:id/status", auth: "admin", handler: setStatus },
];
