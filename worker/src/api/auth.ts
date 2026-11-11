// Auth: email OTP (start/verify), logout, logout-all, Google OAuth (code + PKCE + state cookie).
import { json } from "../lib/edge";
import { constantTimeEqual, hashSecret, randomDigits, randomToken, safeEqualHashed, sha256B64url, b64url, b64urlDecodeToString } from "../lib/crypto";
import { first, isoIn, newId, nowIso } from "../lib/db";
import { emailConfigured, maskEmail, sendEmail } from "../lib/email";
import {
  clearHostCookie,
  hostCookie,
  HttpError,
  OAUTH_COOKIE,
  parseCookies,
  readJsonObject,
  SESSION_COOKIE,
  userAgent,
} from "../lib/http";
import { logError } from "../lib/log";
import { enforce } from "../lib/ratelimit";
import { createSession, publicUser, sessionCookie } from "../lib/session";
import { requireTurnstile } from "../lib/turnstile";
import * as v from "../lib/validate";
import { devCodesActive, googleConfigured, turnstileConfigured } from "./config";
import type { Ctx, RouteDef } from "./context";
import { requireUser } from "./context";
import { findOrCreateUser, getProfile, serverEventStmt } from "./userdata";

const OTP_TTL_MS = 10 * 60_000;
const OTP_MAX_ATTEMPTS = 5;

async function authStart(c: Ctx): Promise<Response> {
  const body = await readJsonObject(c.req, 8192);
  const email = v.email(body.email);
  const ipH = await c.ipHash();
  const emailH = await hashSecret(c.env, "email", email);

  await enforce(c.env, `auth_start:ip:${ipH}`, 20, 3600);
  if (turnstileConfigured(c.env)) await requireTurnstile(c.env, c.req, body.turnstileToken);
  await enforce(c.env, `auth_start:email:${emailH}`, 5, 900);

  const delivery: "email" | "dev" | null = emailConfigured(c.env) ? "email" : devCodesActive(c.env) ? "dev" : null;
  if (!delivery) throw new HttpError(503, "email_unavailable", { message: "Sign-in by email isn't available right now." });

  // Note: no users-table lookup here — the response is identical for new and existing emails.
  const code = randomDigits(6);
  const id = newId();
  const now = nowIso();
  const expiresAt = isoIn(OTP_TTL_MS);
  const stmts = [
    // Only the newest code for an email is valid.
    c.env.DB.prepare("UPDATE otp_codes SET consumed_at = ? WHERE email_hash = ? AND consumed_at IS NULL").bind(now, emailH),
    c.env.DB.prepare(
      "INSERT INTO otp_codes (id, email_hash, code_hash, purpose, delivery, attempts, created_at, expires_at, ip_hash) VALUES (?, ?, ?, 'login', ?, 0, ?, ?, ?)",
    ).bind(id, emailH, await hashSecret(c.env, "otp", `${email}:${code}`), delivery, now, expiresAt, ipH),
  ];
  if (delivery === "dev") {
    stmts.push(
      c.env.DB.prepare("INSERT INTO dev_outbox (id, otp_id, email_masked, code, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").bind(
        newId(),
        id,
        maskEmail(email),
        code,
        now,
        expiresAt,
      ),
    );
  }
  await c.env.DB.batch(stmts);

  if (delivery === "email") {
    const ok = await sendEmail(c.env, {
      to: email,
      subject: `${code} is your Tudumm sign-in code`,
      text: `Your Tudumm sign-in code is ${code}\n\nIt expires in 10 minutes and works once. If you didn't ask for it, you can ignore this email.\n\nTudumm never asks for this code by phone or chat.`,
    });
    if (!ok) {
      await c.env.DB.prepare("UPDATE otp_codes SET consumed_at = ? WHERE id = ?").bind(nowIso(), id).run();
      throw new HttpError(502, "email_send_failed", { message: "We couldn't send the email. Try again in a minute." });
    }
    return json({ sent: true, expiresIn: OTP_TTL_MS / 1000 });
  }
  return json({
    sent: false,
    devMode: true,
    devCode: code,
    expiresIn: OTP_TTL_MS / 1000,
    notice: "Email delivery isn't configured yet — UAT mode shows your code on screen.",
  });
}

async function authVerify(c: Ctx): Promise<Response> {
  const body = await readJsonObject(c.req, 4096);
  const email = v.email(body.email);
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, "invalid_code");
  const ipH = await c.ipHash();
  await enforce(c.env, `auth_verify:ip:${ipH}`, 30, 900);

  const emailH = await hashSecret(c.env, "email", email);
  const row = await first<{ id: string; code_hash: string; expires_at: string; delivery: "email" | "dev" }>(
    c.env,
    "SELECT id, code_hash, expires_at, delivery FROM otp_codes WHERE email_hash = ? AND purpose = 'login' AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1",
    emailH,
  );
  if (!row) throw new HttpError(400, "invalid_code");
  if (Date.parse(row.expires_at) <= Date.now()) {
    await c.env.DB.prepare("UPDATE otp_codes SET consumed_at = ? WHERE id = ?").bind(nowIso(), row.id).run();
    throw new HttpError(400, "code_expired");
  }
  const bump = await first<{ attempts: number }>(
    c.env,
    "UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ? AND attempts < ? AND consumed_at IS NULL RETURNING attempts",
    row.id,
    OTP_MAX_ATTEMPTS,
  );
  if (!bump) throw new HttpError(400, "invalid_code", { attemptsLeft: 0 });

  const expected = await hashSecret(c.env, "otp", `${email}:${code}`);
  if (!constantTimeEqual(expected, row.code_hash)) {
    const left = Math.max(0, OTP_MAX_ATTEMPTS - bump.attempts);
    if (left === 0) await c.env.DB.prepare("UPDATE otp_codes SET consumed_at = ? WHERE id = ?").bind(nowIso(), row.id).run();
    throw new HttpError(400, "invalid_code", { attemptsLeft: left });
  }
  // Single use, race-safe.
  const claimed = await first(c.env, "UPDATE otp_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL RETURNING id", nowIso(), row.id);
  if (!claimed) throw new HttpError(400, "invalid_code");

  const viaEmail = row.delivery === "email";
  const { user, isNew } = await findOrCreateUser(c.env, c.req, email, viaEmail);
  const session = await createSession(c.env, user.id, "web", userAgent(c.req));
  c.cookies.push(sessionCookie(session.token));
  await serverEventStmt(c.env, c.req, user.id, "login", { method: viaEmail ? "email" : "dev_code", isNew }).run();
  return json({ user: publicUser(user), profile: await getProfile(c.env, user.id), isNew });
}

async function logout(c: Ctx): Promise<Response> {
  if (c.session && c.user) {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL").bind(nowIso(), c.session.id, c.user.id),
      serverEventStmt(c.env, c.req, c.user.id, "logout", null, c.via === "bearer" ? "extension" : "web"),
    ]);
  }
  c.cookies.push(clearHostCookie(SESSION_COOKIE));
  return json({ ok: true });
}

async function logoutAll(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const res = await c.env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(nowIso(), user.id).run();
  c.cookies.push(clearHostCookie(SESSION_COOKIE));
  return json({ ok: true, revoked: Number(res.meta?.changes ?? 0) });
}

/* ---------------- Google OAuth (only when GOOGLE_CLIENT_ID/SECRET are set) ---------------- */

const NEXT_RE = /^\/(?!\/)[A-Za-z0-9/_\-.?=&%]{0,200}$/;

function redirect(location: string, cookies: string[] = []): Response {
  const h = new Headers({ location, "cache-control": "no-store" });
  for (const ck of cookies) h.append("set-cookie", ck);
  return new Response(null, { status: 302, headers: h });
}

function redirectUri(c: Ctx): string {
  return `${c.url.origin}/api/v1/auth/google/callback`;
}

async function googleStart(c: Ctx): Promise<Response> {
  if (!googleConfigured(c.env)) throw new HttpError(503, "google_unavailable");
  await enforce(c.env, `google_start:ip:${await c.ipHash()}`, 30, 3600);
  const nextParam = c.url.searchParams.get("next");
  const next = nextParam && NEXT_RE.test(nextParam) ? nextParam : "/app";
  const state = randomToken(16);
  const verifier = randomToken(32);
  const challenge = await sha256B64url(verifier);
  const q = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID as string,
    redirect_uri: redirectUri(c),
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  const cookieVal = `${state}.${verifier}.${b64url(new TextEncoder().encode(next))}`;
  return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`, [hostCookie(OAUTH_COOKIE, cookieVal, { maxAge: 600, sameSite: "Lax" })]);
}

async function googleCallback(c: Ctx): Promise<Response> {
  if (!googleConfigured(c.env)) throw new HttpError(503, "google_unavailable");
  const clear = clearHostCookie(OAUTH_COOKIE);
  const fail = (code: string) => redirect(`/app?auth_error=${code}`, [clear]);
  const raw = parseCookies(c.req.headers.get("cookie"))[OAUTH_COOKIE] ?? "";
  const [state, verifier, nextB64] = raw.split(".");
  const qState = c.url.searchParams.get("state") ?? "";
  const code = c.url.searchParams.get("code") ?? "";
  if (c.url.searchParams.get("error")) return fail("google_denied");
  if (!state || !verifier || !qState || !(await safeEqualHashed(state, qState))) return fail("google_state");
  if (!code || code.length > 2048) return fail("google_code");
  let next = "/app";
  try {
    const n = b64urlDecodeToString(nextB64 ?? "");
    if (NEXT_RE.test(n)) next = n;
  } catch {
    /* keep default */
  }

  let idToken: string | undefined;
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: c.env.GOOGLE_CLIENT_ID as string,
        client_secret: c.env.GOOGLE_CLIENT_SECRET as string,
        redirect_uri: redirectUri(c),
        grant_type: "authorization_code",
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return fail("google_exchange");
    idToken = ((await res.json()) as { id_token?: string }).id_token;
  } catch (err) {
    logError("google.exchange", err);
    return fail("google_exchange");
  }
  // The id_token came straight from Google's token endpoint over TLS (OIDC core 3.1.3.7), so its
  // claims are trusted after checking iss/aud/exp; we still require a verified email.
  let claims: { iss?: string; aud?: string; exp?: number; email?: string; email_verified?: boolean | string; name?: string };
  try {
    claims = JSON.parse(b64urlDecodeToString((idToken ?? "").split(".")[1] ?? ""));
  } catch {
    return fail("google_token");
  }
  const issOk = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  const verified = claims.email_verified === true || claims.email_verified === "true";
  if (!issOk || claims.aud !== c.env.GOOGLE_CLIENT_ID || !claims.exp || claims.exp * 1000 < Date.now() || !verified) return fail("google_token");
  let email: string;
  try {
    email = v.email(claims.email);
  } catch {
    return fail("google_email");
  }
  try {
    const { user, isNew } = await findOrCreateUser(c.env, c.req, email, true);
    if (isNew && typeof claims.name === "string" && claims.name.trim()) {
      await c.env.DB.prepare("UPDATE users SET display_name = ? WHERE id = ? AND display_name IS NULL")
        .bind(claims.name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60), user.id)
        .run();
    }
    const session = await createSession(c.env, user.id, "web", userAgent(c.req));
    await serverEventStmt(c.env, c.req, user.id, "login", { method: "google", isNew }).run();
    return redirect(next, [clear, sessionCookie(session.token)]);
  } catch (err) {
    if (err instanceof HttpError) return fail(err.code);
    throw err;
  }
}

export const authRoutes: RouteDef[] = [
  { method: "POST", path: "/api/v1/auth/start", auth: "none", handler: authStart },
  { method: "POST", path: "/api/v1/auth/verify", auth: "none", handler: authVerify },
  { method: "POST", path: "/api/v1/auth/logout", auth: "optional", cors: true, handler: logout },
  { method: "POST", path: "/api/v1/auth/logout-all", auth: "user", cors: true, handler: logoutAll },
  { method: "GET", path: "/api/v1/auth/google/start", auth: "none", handler: googleStart },
  { method: "GET", path: "/api/v1/auth/google/callback", auth: "none", handler: googleCallback },
];
