// User sessions (web cookie / extension Bearer) and admin sessions. Tokens are 256-bit random,
// handed to the client once, stored only as hashSecret(purpose, token).
import type { Env } from "../env";
import { hashSecret, randomToken } from "./crypto";
import { first, isoIn, newId, nowIso, run } from "./db";
import { ADMIN_COOKIE, SESSION_COOKIE, hostCookie, parseCookies } from "./http";
import { effectivePlan, PLAN_BY_ID } from "./plans";

export const WEB_SESSION_MS = 30 * 86_400_000;
export const EXT_SESSION_MS = 180 * 86_400_000;
export const ADMIN_SESSION_MS = 8 * 3_600_000;
const SLIDE_THROTTLE_MS = 10 * 60_000;

export interface UserRow {
  id: string;
  email: string;
  email_verified: number;
  display_name: string | null;
  status: "active" | "suspended" | "deleted";
  plan: string;
  plan_source: string;
  plan_expires_at: string | null;
  created_at: string;
  last_seen_at: string | null;
  country: string | null;
  marketing_opt_in: number;
}

export const USER_COLS =
  "u.id, u.email, u.email_verified, u.display_name, u.status, u.plan, u.plan_source, u.plan_expires_at, u.created_at, u.last_seen_at, u.country, u.marketing_opt_in";

export interface SessionInfo {
  id: string;
  kind: "web" | "extension";
  expiresAt: string;
}

/** The user object every API response uses. */
export function publicUser(u: UserRow) {
  const plan = effectivePlan(u.plan, u.plan_expires_at);
  return {
    id: u.id,
    email: u.email,
    emailVerified: u.email_verified === 1,
    displayName: u.display_name,
    status: u.status,
    plan,
    planSource: u.plan_source,
    planExpiresAt: plan === "free" ? null : u.plan_expires_at,
    createdAt: u.created_at,
    lastSeenAt: u.last_seen_at,
    country: u.country,
    marketingOptIn: u.marketing_opt_in === 1,
  };
}

export function planInfo(u: UserRow) {
  const id = effectivePlan(u.plan, u.plan_expires_at);
  const p = PLAN_BY_ID[id];
  return { id, name: p.name, features: p.features, limits: p.limits, expiresAt: id === "free" ? null : u.plan_expires_at, source: u.plan_source };
}

export async function createSession(
  env: Env,
  userId: string,
  kind: "web" | "extension",
  ua: string | null,
): Promise<{ id: string; token: string; expiresAt: string }> {
  const token = randomToken();
  const id = newId();
  const now = nowIso();
  const expiresAt = isoIn(kind === "web" ? WEB_SESSION_MS : EXT_SESSION_MS);
  await run(
    env,
    "INSERT INTO sessions (id, user_id, token_hash, kind, user_agent, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    userId,
    await hashSecret(env, "session", token),
    kind,
    ua,
    now,
    now,
    expiresAt,
  );
  return { id, token, expiresAt };
}

export function sessionCookie(token: string): string {
  return hostCookie(SESSION_COOKIE, token, { maxAge: WEB_SESSION_MS / 1000, sameSite: "Lax" });
}

export interface ResolvedUser {
  user: UserRow;
  session: SessionInfo;
  via: "cookie" | "bearer";
  refreshCookie: string | null;
}

/** Bearer token = 43-char base64url (256-bit). */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function bearerToken(request: Request): string | null | "invalid" {
  const h = request.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  if (!m || !TOKEN_RE.test(m[1] as string)) return "invalid";
  return m[1] as string;
}

/**
 * Resolve the caller's session. Bearer (extension) wins over the cookie; when an Authorization
 * header is present the cookie is ignored. Returns null when there is no valid session.
 */
export async function resolveUser(env: Env, request: Request): Promise<ResolvedUser | null> {
  const bearer = bearerToken(request);
  let token: string | null = null;
  let via: "cookie" | "bearer" = "cookie";
  if (bearer === "invalid") return null;
  if (bearer) {
    token = bearer;
    via = "bearer";
  } else {
    const c = parseCookies(request.headers.get("cookie"))[SESSION_COOKIE];
    if (c && TOKEN_RE.test(c)) token = c;
  }
  if (!token) return null;

  const row = await first<UserRow & { s_id: string; s_kind: "web" | "extension"; s_expires_at: string; s_last_used_at: string }>(
    env,
    `SELECT s.id AS s_id, s.kind AS s_kind, s.expires_at AS s_expires_at, s.last_used_at AS s_last_used_at, ${USER_COLS}
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL`,
    await hashSecret(env, "session", token),
  );
  if (!row) return null;
  const now = Date.now();
  if (Date.parse(row.s_expires_at) <= now) return null;
  // Extension tokens are only valid as Bearer; web tokens only as the cookie.
  if ((via === "bearer") !== (row.s_kind === "extension")) return null;
  if (row.status === "deleted") return null;

  let refreshCookie: string | null = null;
  let expiresAt = row.s_expires_at;
  if (now - Date.parse(row.s_last_used_at) > SLIDE_THROTTLE_MS) {
    const nowStr = new Date(now).toISOString();
    expiresAt = isoIn(row.s_kind === "web" ? WEB_SESSION_MS : EXT_SESSION_MS, now);
    await env.DB.batch([
      env.DB.prepare("UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?").bind(nowStr, expiresAt, row.s_id),
      env.DB.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").bind(nowStr, row.id),
    ]);
    if (via === "cookie") refreshCookie = sessionCookie(token);
  }
  return { user: row, session: { id: row.s_id, kind: row.s_kind, expiresAt }, via, refreshCookie };
}

/* ---------------- admin ---------------- */

export interface AdminInfo {
  sessionId: string;
  actor: string; // "admin:<8 chars of session id>" — used in audit rows
  expiresAt: string;
}

export async function createAdminSession(env: Env, ipHashValue: string, ua: string | null): Promise<{ id: string; token: string; expiresAt: string }> {
  const token = randomToken();
  const id = newId();
  const expiresAt = isoIn(ADMIN_SESSION_MS);
  await run(
    env,
    "INSERT INTO admin_sessions (id, token_hash, created_at, expires_at, ip_hash, user_agent) VALUES (?, ?, ?, ?, ?, ?)",
    id,
    await hashSecret(env, "admin", token),
    nowIso(),
    expiresAt,
    ipHashValue,
    ua,
  );
  return { id, token, expiresAt };
}

export function adminCookie(token: string): string {
  return hostCookie(ADMIN_COOKIE, token, { maxAge: ADMIN_SESSION_MS / 1000, sameSite: "Strict" });
}

export async function resolveAdmin(env: Env, request: Request): Promise<AdminInfo | null> {
  if (!env.ADMIN_PASSWORD) return null;
  const c = parseCookies(request.headers.get("cookie"))[ADMIN_COOKIE];
  if (!c || !TOKEN_RE.test(c)) return null;
  const row = await first<{ id: string; expires_at: string }>(
    env,
    "SELECT id, expires_at FROM admin_sessions WHERE token_hash = ? AND revoked_at IS NULL",
    await hashSecret(env, "admin", c),
  );
  if (!row || Date.parse(row.expires_at) <= Date.now()) return null;
  return { sessionId: row.id, actor: `admin:${row.id.slice(0, 8)}`, expiresAt: row.expires_at };
}
