// Support tickets. POST works signed-out (email required, rate-limited, Turnstile when enabled).
import { json } from "../lib/edge";
import { all, first, newId, nowIso } from "../lib/db";
import { hashSecret } from "../lib/crypto";
import { HttpError, notFound, readJsonObject } from "../lib/http";
import { enforce } from "../lib/ratelimit";
import { requireTurnstile } from "../lib/turnstile";
import * as v from "../lib/validate";
import { turnstileConfigured } from "./config";
import type { Ctx, RouteDef } from "./context";
import { param, requireUser } from "./context";

export const TICKET_CATEGORIES = ["bug", "billing", "signal", "account", "grievance", "other"] as const;
export const TICKET_STATUSES = ["open", "pending", "resolved", "closed"] as const;

export interface TicketRow {
  id: string;
  user_id: string | null;
  email: string;
  category: string;
  subject: string;
  body: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export function mapTicket(t: TicketRow) {
  return {
    id: t.id,
    userId: t.user_id,
    email: t.email,
    category: t.category,
    subject: t.subject,
    body: t.body,
    status: t.status,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

export async function ticketMessages(c: Ctx, ids: string[]) {
  if (!ids.length) return new Map<string, { author: string; body: string; createdAt: string }[]>();
  const rows = await all<{ ticket_id: string; author: string; body: string; created_at: string }>(
    c.env,
    "SELECT ticket_id, author, body, created_at FROM ticket_messages WHERE ticket_id IN (SELECT value FROM json_each(?)) ORDER BY created_at LIMIT 2000",
    JSON.stringify(ids),
  );
  const map = new Map<string, { author: string; body: string; createdAt: string }[]>();
  for (const r of rows) {
    const list = map.get(r.ticket_id) ?? [];
    list.push({ author: r.author, body: r.body, createdAt: r.created_at });
    map.set(r.ticket_id, list);
  }
  return map;
}

async function createTicket(c: Ctx): Promise<Response> {
  const body = await readJsonObject(c.req, 16 * 1024);
  const category = v.oneOf(body.category, "category", TICKET_CATEGORIES);
  const subject = v.str(body.subject, "subject", { min: 3, max: 140 });
  const text = v.str(body.body, "body", { min: 10, max: 5000, multiline: true });
  const ipH = await c.ipHash();
  let email: string;
  if (c.user) {
    email = c.user.email;
    await enforce(c.env, `support:user:${c.user.id}`, 10, 3600);
  } else {
    email = v.email(body.email);
    await enforce(c.env, `support:ip:${ipH}`, 5, 3600);
    await enforce(c.env, `support:email:${await hashSecret(c.env, "email", email)}`, 3, 3600);
    if (turnstileConfigured(c.env)) await requireTurnstile(c.env, c.req, body.turnstileToken);
  }
  const id = newId();
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO support_tickets (id, user_id, email, category, subject, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)",
    ).bind(id, c.user?.id ?? null, email, category, subject, text, now, now),
    c.env.DB.prepare("INSERT INTO ticket_messages (id, ticket_id, author, body, created_at) VALUES (?, ?, 'user', ?, ?)").bind(newId(), id, text, now),
  ]);
  // Signed-out callers get only the id back (no echo of what's stored under that email).
  return json({ ticket: { id, status: "open", category, subject, createdAt: now } }, {}, 201);
}

async function listMyTickets(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const rows = await all<TicketRow>(
    c.env,
    "SELECT id, user_id, email, category, subject, body, status, created_at, updated_at FROM support_tickets WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100",
    user.id,
  );
  const msgs = await ticketMessages(
    c,
    rows.map((r) => r.id),
  );
  return json({ items: rows.map((r) => ({ ...mapTicket(r), messages: msgs.get(r.id) ?? [] })) });
}

async function replyMyTicket(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const id = v.uuid(param(c, "id"));
  const body = await readJsonObject(c.req, 16 * 1024);
  const text = v.str(body.body, "body", { min: 1, max: 5000, multiline: true });
  const t = await first<{ status: string }>(c.env, "SELECT status FROM support_tickets WHERE id = ? AND user_id = ?", id, user.id);
  if (!t) throw notFound();
  if (t.status === "closed") throw new HttpError(409, "ticket_closed");
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO ticket_messages (id, ticket_id, author, body, created_at) VALUES (?, ?, 'user', ?, ?)").bind(newId(), id, text, now),
    c.env.DB.prepare("UPDATE support_tickets SET status = 'open', updated_at = ? WHERE id = ? AND user_id = ?").bind(now, id, user.id),
  ]);
  return json({ ok: true }, {}, 201);
}

export const supportRoutes: RouteDef[] = [
  { method: "POST", path: "/api/v1/support", auth: "optional", noWriteLimit: true, handler: createTicket },
  { method: "GET", path: "/api/v1/support", auth: "user", handler: listMyTickets },
  { method: "POST", path: "/api/v1/support/:id/reply", auth: "user", handler: replyMyTicket },
];
