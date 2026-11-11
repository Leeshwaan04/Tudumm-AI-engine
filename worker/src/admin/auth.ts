// Admin auth: single owner password (ADMIN_PASSWORD secret). Disabled (503) when unset.
import { audit } from "../lib/audit";
import { json } from "../lib/edge";
import { safeEqualHashed } from "../lib/crypto";
import { nowIso } from "../lib/db";
import { ADMIN_COOKIE, clearHostCookie, HttpError, readJsonObject, userAgent } from "../lib/http";
import { hit } from "../lib/ratelimit";
import { adminCookie, createAdminSession } from "../lib/session";
import { capabilities } from "../api/config";
import { loadFlags } from "../lib/flags";
import type { Ctx, RouteDef } from "../api/context";
import { requireAdmin } from "../api/context";

export const ADMIN_NOT_CONFIGURED = { error: "admin_not_configured", hint: "Owner: run scripts/set-secrets.sh" };

async function login(c: Ctx): Promise<Response> {
  if (!c.env.ADMIN_PASSWORD) return json(ADMIN_NOT_CONFIGURED, {}, 503);
  const body = await readJsonObject(c.req, 2048);
  const ipH = await c.ipHash();
  const ipTag = ipH.slice(0, 12);
  const rl = await hit(c.env, `admin_login:ip:${ipH}`, 5, 900);
  if (!rl.ok) {
    await audit(c.env, "anonymous", "admin.login.rate_limited", "admin_session", null, { ip: ipTag });
    throw new HttpError(429, "rate_limited", { retryAfter: rl.retryAfter }, { "retry-after": String(Math.max(1, rl.retryAfter)) });
  }
  const pw = typeof body.password === "string" ? body.password : "";
  const ok = pw.length > 0 && pw.length <= 512 && (await safeEqualHashed(pw, c.env.ADMIN_PASSWORD));
  if (!ok) {
    await audit(c.env, "anonymous", "admin.login.failure", "admin_session", null, { ip: ipTag });
    throw new HttpError(401, "invalid_credentials");
  }
  const s = await createAdminSession(c.env, ipH, userAgent(c.req));
  await audit(c.env, `admin:${s.id.slice(0, 8)}`, "admin.login.success", "admin_session", s.id, { ip: ipTag });
  c.cookies.push(adminCookie(s.token));
  return json({ ok: true, expiresAt: s.expiresAt });
}

async function logout(c: Ctx): Promise<Response> {
  const a = requireAdmin(c);
  await c.env.DB.prepare("UPDATE admin_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(nowIso(), a.sessionId).run();
  await audit(c.env, a.actor, "admin.logout", "admin_session", a.sessionId);
  c.cookies.push(clearHostCookie(ADMIN_COOKIE, "Strict"));
  return json({ ok: true });
}

async function me(c: Ctx): Promise<Response> {
  const a = requireAdmin(c);
  const flags = await loadFlags(c.env);
  return json({ ok: true, actor: a.actor, sessionId: a.sessionId, expiresAt: a.expiresAt, capabilities: capabilities(c.env, flags) });
}

export const adminAuthRoutes: RouteDef[] = [
  // login is auth:"none" but still same-origin + JSON (router CSRF policy)
  { method: "POST", path: "/api/admin/login", auth: "none", noWriteLimit: true, handler: login },
  { method: "POST", path: "/api/admin/logout", auth: "admin", handler: logout },
  { method: "GET", path: "/api/admin/me", auth: "admin", handler: me },
];
