// Zerodha Kite Connect order integration — owner's OWN account, manual confirmation of every order.
//
//   admin (owner session)   /api/admin/broker/*            status, login, intents, confirm/cancel,
//                                                          read proxies, limits, kill switch, disconnect
//   public (Kite -> us)     GET  /api/v1/broker/kite/callback   login redirect (state nonce, single-use)
//                           POST /api/v1/broker/kite/postback   checksum-verified order updates
//   relay (Bearer)          POST /api/internal/relay/claim|result
//
// Flow: ticket -> intent (pending_confirm, 2 min, confirm token) -> confirm (queued, 2 min) ->
// relay claims (claimed) -> relay places at Kite from the registered static IP -> result
// (placed|failed) -> postbacks (kite_status, rejected). Nothing is ever retried automatically.
//
// Secrets: the Kite access token is encrypted at rest (kite.ts) and only leaves the Worker to call
// Kite or in the relay's Bearer-authenticated claim response. It never appears in browser
// responses, logs or audit rows. Confirm tokens and state nonces are stored only as hashes.
import type { Env } from "../env";
import type { Ctx, RouteDef } from "../api/context";
import { param, requireAdmin } from "../api/context";
import { audit, auditStmt } from "../lib/audit";
import { constantTimeEqual, hashSecret, randomToken, safeEqualHashed, sha256Hex } from "../lib/crypto";
import { all, changes, first, isoIn, newId, nowIso, parseJson } from "../lib/db";
import { json } from "../lib/edge";
import { clearHostCookie, clientIp, HttpError, hostCookie, notFound, parseCookies, readJsonObject, readTextBounded, siteOrigin } from "../lib/http";
import { logError } from "../lib/log";
import { enforce, hit } from "../lib/ratelimit";
import * as v from "../lib/validate";
import {
  describeTicket,
  enforceLimits,
  intentTag,
  kitePayload,
  parseLimitsUpdate,
  parseTicket,
  TAG_RE,
  ticketFromPayload,
  withServerPrice,
  type Limits,
  type OrderTicket,
} from "./guardrails";
import {
  cleanKiteMessage,
  exchangeRequestToken,
  invalidateAccessToken,
  istDayStartIso,
  KiteError,
  kiteCall,
  kiteConfigured,
  loginUrl,
  nextKiteExpiry,
  openToken,
  postbackChecksum,
  sealToken,
  relayConfigured,
  tokenAad,
} from "./kite";

const STATE_COOKIE = "__Host-tdm_k";
const STATE_TTL_MS = 10 * 60_000;
const CONFIRM_TTL_MS = 2 * 60_000;
const QUEUE_TTL_MS = 2 * 60_000;
const CLAIM_STALE_MS = 5 * 60_000;
const RELAY_ONLINE_MS = 60_000;
const STATE_RE = /^[A-Za-z0-9_-]{43}$/;
const REQUEST_TOKEN_RE = /^[A-Za-z0-9]{6,64}$/;
const ORDER_ID_RE = /^[A-Za-z0-9]{1,32}$/;
const NO_RESULT_ERROR = "relay_no_result: the relay claimed this order but never reported back. It MAY have been placed — check the Kite order book.";

const NOT_CONFIGURED = {
  hint: "Owner: set KITE_API_KEY and KITE_API_SECRET (npx wrangler secret put ...). See relay/README.md.",
};

/* ======================= shared state helpers ======================= */

interface LimitsRow {
  trading_enabled: number;
  max_order_value_inr: number;
  max_qty: number;
  daily_order_cap: number;
  allowed_exchanges: string;
  allowed_products: string;
  updated_at: string;
  updated_by: string;
}

interface LoadedLimits extends Limits {
  updatedAt: string | null;
  updatedBy: string | null;
}

async function loadLimits(env: Env): Promise<LoadedLimits> {
  const r = await first<LimitsRow>(env, "SELECT trading_enabled, max_order_value_inr, max_qty, daily_order_cap, allowed_exchanges, allowed_products, updated_at, updated_by FROM broker_limits WHERE id = 1");
  if (!r) {
    // The migration seeds the row; fail safe (trading off) if it is somehow missing.
    return { tradingEnabled: false, maxOrderValueInr: 25000, maxQty: 100, dailyOrderCap: 10, allowedExchanges: ["NSE", "BSE"], allowedProducts: ["CNC", "MIS"], updatedAt: null, updatedBy: null };
  }
  return {
    tradingEnabled: r.trading_enabled === 1,
    maxOrderValueInr: Number(r.max_order_value_inr),
    maxQty: Number(r.max_qty),
    dailyOrderCap: Number(r.daily_order_cap),
    allowedExchanges: parseJson<string[]>(r.allowed_exchanges, []),
    allowedProducts: parseJson<string[]>(r.allowed_products, []),
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

function publicLimits(l: LoadedLimits) {
  return {
    tradingEnabled: l.tradingEnabled,
    maxOrderValueInr: l.maxOrderValueInr,
    maxQty: l.maxQty,
    dailyOrderCap: l.dailyOrderCap,
    allowedExchanges: l.allowedExchanges,
    allowedProducts: l.allowedProducts,
    updatedAt: l.updatedAt,
    updatedBy: l.updatedBy,
  };
}

interface SessionRow {
  id: string;
  kite_user_id: string;
  token_ct: string;
  token_iv: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
}

const SESSION_COLS = "id, kite_user_id, token_ct, token_iv, created_by, created_at, expires_at, last_used_at";

function revokeSessionStmt(env: Env, id: string, reason: string, at = nowIso()): D1PreparedStatement {
  return env.DB.prepare("UPDATE broker_sessions SET revoked_at = ?, revoke_reason = ?, token_ct = '', token_iv = '' WHERE id = ? AND revoked_at IS NULL").bind(at, reason, id);
}

/** Active (not revoked) session. Expired ones are revoked + wiped on sight. */
async function activeSession(env: Env): Promise<SessionRow | null> {
  const s = await first<SessionRow>(env, `SELECT ${SESSION_COLS} FROM broker_sessions WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`);
  if (!s) return null;
  if (Date.parse(s.expires_at) <= Date.now() || !s.token_ct) {
    await env.DB.batch([
      revokeSessionStmt(env, s.id, "expired"),
      notifyStmt(env, "session", "Kite session expired", "Kite access tokens end at 06:00 IST every day. Connect Kite again to trade.", s.id, `session-expired:${s.id}`),
    ]);
    return null;
  }
  return s;
}

/** Active session plus its decrypted access token, or null. A ciphertext that won't open is revoked. */
async function liveAccess(env: Env): Promise<{ session: SessionRow; token: string } | null> {
  const s = await activeSession(env);
  if (!s) return null;
  const token = await openToken(env, s.token_ct, s.token_iv, tokenAad(s.id, s.kite_user_id));
  if (!token) {
    await env.DB.batch([
      revokeSessionStmt(env, s.id, "decrypt_failed"),
      auditStmt(env, "system:broker", "broker.session.decrypt_failed", "broker_session", s.id),
    ]);
    return null;
  }
  return { session: s, token };
}

function notifyStmt(env: Env, kind: "order" | "session" | "relay", title: string, body: string | null, refId: string | null, dedupeKey: string | null = null): D1PreparedStatement {
  return env.DB.prepare("INSERT OR IGNORE INTO broker_notifications (id, kind, title, body, ref_id, created_at, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(
    newId(),
    kind,
    title.slice(0, 160),
    body ? body.slice(0, 600) : null,
    refId,
    nowIso(),
    dedupeKey,
  );
}

/** Audit row written only if `whereSql` holds after the preceding statements of the same batch. */
function auditWhereStmt(env: Env, actor: string, action: string, targetType: string, targetId: string, detail: Record<string, unknown> | null, whereSql: string, ...binds: unknown[]): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO audit_log (id, actor, action, target_type, target_id, detail, created_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${whereSql}`).bind(
    newId(),
    actor.slice(0, 80),
    action,
    targetType,
    targetId,
    detail ? JSON.stringify(detail).slice(0, 4000) : null,
    nowIso(),
    ...binds,
  );
}

function notifyWhereStmt(env: Env, title: string, body: string | null, refId: string, whereSql: string, ...binds: unknown[]): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO broker_notifications (id, kind, title, body, ref_id, created_at) SELECT ?, 'order', ?, ?, ?, ? WHERE ${whereSql}`).bind(
    newId(),
    title.slice(0, 160),
    body ? body.slice(0, 600) : null,
    refId,
    nowIso(),
    ...binds,
  );
}

interface IntentRow {
  id: string;
  created_by: string;
  admin_session_id: string;
  signal_id: string | null;
  payload: string;
  est_price: number | null;
  est_value_inr: number;
  value_basis: string;
  status: string;
  confirm_token_hash: string | null;
  tag: string;
  kite_order_id: string | null;
  kite_status: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  confirmed_at: string | null;
  claimed_at: string | null;
  completed_at: string | null;
}

const INTENT_COLS =
  "id, created_by, admin_session_id, signal_id, payload, est_price, est_value_inr, value_basis, status, confirm_token_hash, tag, kite_order_id, kite_status, error, created_at, updated_at, expires_at, confirmed_at, claimed_at, completed_at";

/** Browser-facing intent (no hashes, no session ids). */
function mapIntent(r: IntentRow) {
  return {
    id: r.id,
    status: r.status,
    signalId: r.signal_id,
    order: parseJson<Record<string, string>>(r.payload, {}),
    estPrice: r.est_price,
    estValueInr: r.est_value_inr,
    valueBasis: r.value_basis,
    tag: r.tag,
    kiteOrderId: r.kite_order_id,
    kiteStatus: r.kite_status,
    error: r.error,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    expiresAt: r.expires_at,
    confirmedAt: r.confirmed_at,
    claimedAt: r.claimed_at,
    completedAt: r.completed_at,
  };
}

function getIntent(env: Env, id: string): Promise<IntentRow | null> {
  return first<IntentRow>(env, `SELECT ${INTENT_COLS} FROM order_intents WHERE id = ?`, id);
}

function payloadLine(payload: string): string {
  const p = parseJson<Record<string, string>>(payload, {});
  return `${p.transaction_type ?? "?"} ${p.quantity ?? "?"} ${p.exchange ?? "?"}:${p.tradingsymbol ?? "?"} ${p.order_type ?? ""}`.trim();
}

/** Lazy housekeeping: expire stale intents, fail claims the relay never reported. */
async function sweep(env: Env): Promise<void> {
  const now = nowIso();
  const staleBefore = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
  const res = await env.DB.batch([
    env.DB.prepare(
      `UPDATE order_intents SET status = 'expired', confirm_token_hash = NULL, updated_at = ?1, completed_at = ?1
       WHERE status IN ('pending_confirm', 'queued') AND expires_at <= ?1 RETURNING id, confirmed_at, payload`,
    ).bind(now),
    env.DB.prepare(
      `UPDATE order_intents SET status = 'failed', error = ?2, updated_at = ?1, completed_at = ?1
       WHERE status = 'claimed' AND claimed_at <= ?3 RETURNING id, payload`,
    ).bind(now, NO_RESULT_ERROR, staleBefore),
  ]);
  const expired = (res[0]?.results ?? []) as { id: string; confirmed_at: string | null; payload: string }[];
  const stale = (res[1]?.results ?? []) as { id: string; payload: string }[];
  const follow: D1PreparedStatement[] = [];
  for (const r of expired) {
    if (!r.confirmed_at) continue; // an unconfirmed ticket timing out is expected, not news
    follow.push(notifyStmt(env, "order", `Order expired unplaced: ${payloadLine(r.payload)}`, "The relay didn't pick it up within 2 minutes (offline?). Nothing was sent to Kite.", r.id, `expired:${r.id}`));
  }
  for (const r of stale) {
    follow.push(notifyStmt(env, "order", `Order outcome unknown: ${payloadLine(r.payload)}`, NO_RESULT_ERROR, r.id, `stale:${r.id}`));
    follow.push(auditStmt(env, "system:broker", "broker.order.no_result", "order_intent", r.id));
  }
  if (follow.length) await env.DB.batch(follow);
}

async function confirmedToday(env: Env): Promise<number> {
  const r = await first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM order_intents WHERE confirmed_at >= ?", istDayStartIso(Date.now()));
  return Number(r?.n ?? 0);
}

function requireKite(env: Env): void {
  if (!kiteConfigured(env)) throw new HttpError(503, "broker_not_configured", NOT_CONFIGURED);
}

function redirect(location: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer", ...extraHeaders } });
}

/* ======================= admin: status ======================= */

interface RelayRow {
  ip: string;
  version: string | null;
  first_seen_at: string;
  last_seen_at: string;
  prev_ip: string | null;
  ip_changed_at: string | null;
}

async function status(c: Ctx): Promise<Response> {
  requireAdmin(c);
  const env = c.env;
  const configured = kiteConfigured(env);
  await sweep(env);
  const [limits, session, relay, today, unread, last] = await Promise.all([
    loadLimits(env),
    configured ? activeSession(env) : Promise.resolve(null),
    first<RelayRow>(env, "SELECT ip, version, first_seen_at, last_seen_at, prev_ip, ip_changed_at FROM relay_heartbeats WHERE id = 'relay'"),
    confirmedToday(env),
    first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM broker_notifications WHERE read_at IS NULL"),
    first<{ kite_user_id: string; revoked_at: string; revoke_reason: string | null }>(
      env,
      "SELECT kite_user_id, revoked_at, revoke_reason FROM broker_sessions WHERE revoked_at IS NOT NULL ORDER BY revoked_at DESC LIMIT 1",
    ),
  ]);
  const now = Date.now();
  const online = !!relay && now - Date.parse(relay.last_seen_at) < RELAY_ONLINE_MS;
  const origin = siteOrigin(env, c.req);
  return json({
    configured,
    relayConfigured: relayConfigured(env),
    connected: !!session,
    kiteUserId: session?.kite_user_id ?? null,
    connectedAt: session?.created_at ?? null,
    expiresAt: session?.expires_at ?? null,
    lastDisconnect: !session && last ? { kiteUserId: last.kite_user_id, at: last.revoked_at, reason: last.revoke_reason } : null,
    tradingEnabled: limits.tradingEnabled,
    limits: publicLimits(limits),
    today: { confirmed: today, cap: limits.dailyOrderCap, remaining: Math.max(0, limits.dailyOrderCap - today), dayStartedAt: istDayStartIso(now) },
    relay: {
      online,
      ip: relay?.ip ?? null,
      version: relay?.version ?? null,
      lastSeenAt: relay?.last_seen_at ?? null,
      firstSeenAt: relay?.first_seen_at ?? null,
      prevIp: relay?.prev_ip ?? null,
      ipChangedAt: relay?.ip_changed_at ?? null,
    },
    staticIpHint: relay?.ip
      ? `Register this relay IP (${relay.ip}) as the primary static IP of your app in the Kite developer console. Kite rejects API orders from any other IP.`
      : "Register this relay IP in the Kite developer console. No relay has checked in yet: start relay/kite-relay.mjs on your static-IP host and its public IP will show here.",
    setup: { redirectUrl: `${origin}/api/v1/broker/kite/callback`, postbackUrl: `${origin}/api/v1/broker/kite/postback` },
    unreadNotifications: Number(unread?.n ?? 0),
  });
}

/* ======================= admin: Kite login ======================= */

async function kiteLogin(c: Ctx): Promise<Response> {
  const a = requireAdmin(c);
  requireKite(c.env);
  await enforce(c.env, `broker_login:${a.sessionId}`, 10, 600);
  const state = randomToken();
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO broker_login_states (id, state_hash, admin_session_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").bind(
      newId(),
      await hashSecret(c.env, "broker_state", state),
      a.sessionId,
      new Date(now).toISOString(),
      isoIn(STATE_TTL_MS, now),
    ),
    c.env.DB.prepare("DELETE FROM broker_login_states WHERE created_at < ?").bind(new Date(now - 86_400_000).toISOString()),
    auditStmt(c.env, a.actor, "broker.login.start", "broker_session", null),
  ]);
  // Lax cookie: the callback is a cross-site top-level GET (Kite -> us) where the Strict admin
  // cookie is not sent; this binds the callback to the browser that started the login.
  c.cookies.push(hostCookie(STATE_COOKIE, state, { maxAge: STATE_TTL_MS / 1000, sameSite: "Lax" }));
  return redirect(loginUrl(c.env.KITE_API_KEY as string, state));
}

async function kiteCallback(c: Ctx): Promise<Response> {
  const env = c.env;
  const clear = { "set-cookie": clearHostCookie(STATE_COOKIE, "Lax") };
  const ipTag = (await c.ipHash()).slice(0, 12);
  const fail = async (code: string, detail: Record<string, unknown> = {}): Promise<Response> => {
    await audit(env, "anonymous", "broker.connect.failure", "broker_session", null, { reason: code, ip: ipTag, ...detail });
    return redirect(`/admin/broker?error=${encodeURIComponent(code)}`, clear);
  };
  if (!kiteConfigured(env)) return redirect("/admin/broker?error=not_configured", clear);
  const rl = await hit(env, `broker_cb:${await c.ipHash()}`, 20, 600);
  if (!rl.ok) return redirect("/admin/broker?error=rate_limited", clear);

  const sp = c.url.searchParams;
  if (sp.get("status") !== "success") return fail("login_cancelled");
  const requestToken = sp.get("request_token") ?? "";
  if (!REQUEST_TOKEN_RE.test(requestToken)) return fail("bad_request_token");
  const state = sp.get("state") ?? "";
  if (!STATE_RE.test(state)) return fail("bad_state");
  const cookieState = parseCookies(c.req.headers.get("cookie"))[STATE_COOKIE] ?? "";
  if (!constantTimeEqual(cookieState, state)) return fail("state_mismatch");

  const now = nowIso();
  const st = await first<{ admin_session_id: string }>(
    env,
    "UPDATE broker_login_states SET consumed_at = ?1 WHERE state_hash = ?2 AND consumed_at IS NULL AND expires_at > ?1 RETURNING admin_session_id",
    now,
    await hashSecret(env, "broker_state", state),
  );
  if (!st) return fail("state_invalid");
  const adm = await first<{ id: string }>(env, "SELECT id FROM admin_sessions WHERE id = ? AND revoked_at IS NULL AND expires_at > ?", st.admin_session_id, now);
  if (!adm) return fail("admin_session_ended");

  let tok: { userId: string; accessToken: string };
  try {
    tok = await exchangeRequestToken(env, requestToken);
  } catch (err) {
    if (!(err instanceof KiteError)) logError("broker.callback", err);
    return fail("token_exchange_failed", { errorType: err instanceof KiteError ? err.errorType : "internal" });
  }

  const id = newId();
  const sealed = await sealToken(env, tok.accessToken, tokenAad(id, tok.userId));
  const expiresAt = nextKiteExpiry(Date.now());
  const actor = `admin:${st.admin_session_id.slice(0, 8)}`;
  const at = nowIso();
  await env.DB.batch([
    env.DB.prepare("UPDATE broker_sessions SET revoked_at = ?, revoke_reason = 'reconnect', token_ct = '', token_iv = '' WHERE revoked_at IS NULL").bind(at),
    env.DB.prepare("INSERT INTO broker_sessions (id, kite_user_id, token_ct, token_iv, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(
      id,
      tok.userId,
      sealed.ct,
      sealed.iv,
      actor,
      at,
      expiresAt,
    ),
    auditStmt(env, actor, "broker.connect", "broker_session", id, { kiteUserId: tok.userId, expiresAt }),
    notifyStmt(env, "session", `Kite connected (${tok.userId})`, `The session is valid until 06:00 IST (${expiresAt}).`, id),
  ]);
  return redirect("/admin/broker?connected=1", clear);
}

/* ======================= admin: order intents ======================= */

/**
 * A live price the server verified, for MARKET / SL-M value checks: Tudumm's own 5paisa quote (NSE
 * cash symbols in the universe, < 2 min old), else Kite's LTP (needs a Kite app with quote access;
 * Personal apps may not have it). null when neither is available — withServerPrice then refuses.
 */
async function serverPrice(env: Env, t: OrderTicket): Promise<number | null> {
  if (t.order_type !== "MARKET" && t.order_type !== "SL-M") return null;
  if (t.exchange === "NSE") {
    const q = await first<{ price: number; as_of: string; source: string }>(env, "SELECT price, as_of, source FROM quotes WHERE symbol = ?", t.tradingsymbol);
    if (q && q.source === "5paisa" && Date.now() - Date.parse(q.as_of) < 120_000 && Number(q.price) > 0) return Number(q.price);
  }
  const acc = await liveAccess(env);
  if (!acc) return null;
  const inst = `${t.exchange}:${t.tradingsymbol}`;
  try {
    const r = await kiteCall<Record<string, { last_price?: number }>>(env, { method: "GET", path: "/quote/ltp", query: { i: inst }, accessToken: acc.token, timeoutMs: 5000 });
    const lp = Number(r?.[inst]?.last_price);
    return Number.isFinite(lp) && lp > 0 ? lp : null;
  } catch {
    return null;
  }
}

async function createOrder(c: Ctx): Promise<Response> {
  const a = requireAdmin(c);
  requireKite(c.env);
  await enforce(c.env, `broker_order:${a.sessionId}`, 30, 60);
  const body = await readJsonObject(c.req, 4096);
  const parsed = parseTicket(body);
  await sweep(c.env);
  const [limits, session, today] = await Promise.all([loadLimits(c.env), activeSession(c.env), confirmedToday(c.env)]);
  const t = withServerPrice(parsed, await serverPrice(c.env, parsed));
  const val = enforceLimits(t, limits, { connected: !!session, confirmedToday: today });

  const id = newId();
  const tag = intentTag(id);
  const confirmToken = randomToken();
  const payload = kitePayload(t, tag);
  const now = Date.now();
  const at = new Date(now).toISOString();
  const expiresAt = isoIn(CONFIRM_TTL_MS, now);
  const line = describeTicket(t);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO order_intents (id, created_by, admin_session_id, signal_id, payload, est_price, est_value_inr, value_basis, status, confirm_token_hash, tag, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_confirm', ?, ?, ?, ?, ?)`,
    ).bind(id, a.actor, a.sessionId, t.signalId, JSON.stringify(payload), t.estPrice, val.value, val.basis, await hashSecret(c.env, "broker_confirm", confirmToken), tag, at, at, expiresAt),
    auditStmt(c.env, a.actor, "broker.order.create", "order_intent", id, { order: line, value: val.value, basis: val.basis, signalId: t.signalId }),
  ]);
  const row = await getIntent(c.env, id);
  return json(
    {
      intent: row ? mapIntent(row) : null,
      confirmToken,
      expiresAt,
      summary: {
        text: line,
        value: val.value,
        basis: val.basis,
        bufferPct: val.basis === "est_price_buffered" ? 2 : 0,
        limits: {
          maxOrderValueInr: limits.maxOrderValueInr,
          maxQty: limits.maxQty,
          dailyOrderCap: limits.dailyOrderCap,
          confirmedToday: today,
          remainingAfter: Math.max(0, limits.dailyOrderCap - today - 1),
        },
        kiteUserId: session?.kite_user_id ?? null,
      },
    },
    {},
    201,
  );
}

async function confirmOrder(c: Ctx): Promise<Response> {
  const a = requireAdmin(c);
  requireKite(c.env);
  const id = v.uuid(param(c, "id"));
  await enforce(c.env, `broker_confirm:${a.sessionId}`, 30, 60);
  const body = await readJsonObject(c.req, 1024);
  const token = typeof body.confirmToken === "string" ? body.confirmToken : "";
  if (!STATE_RE.test(token)) throw v.invalid("confirmToken", "must be the confirmToken returned when the order was created");
  await sweep(c.env);
  const row = await getIntent(c.env, id);
  if (!row) throw notFound();
  if (row.status === "expired") throw new HttpError(410, "intent_expired", { message: "This ticket expired (2 minutes). Create it again." });
  if (row.status !== "pending_confirm") throw new HttpError(409, "intent_not_pending", { status: row.status });
  if (row.admin_session_id !== a.sessionId) throw new HttpError(403, "confirm_session_mismatch", { message: "Confirm from the admin session that created the ticket." });
  const h = await hashSecret(c.env, "broker_confirm", token);
  if (!row.confirm_token_hash || !constantTimeEqual(h, row.confirm_token_hash)) {
    await audit(c.env, a.actor, "broker.order.confirm_mismatch", "order_intent", id);
    throw new HttpError(403, "confirm_token_invalid", { message: "The confirmation token doesn't match this ticket." });
  }

  // Guardrails again, with the limits and session as they are NOW.
  const [limits, session, today] = await Promise.all([loadLimits(c.env), activeSession(c.env), confirmedToday(c.env)]);
  const stored = ticketFromPayload(parseJson<Record<string, string>>(row.payload, {}), row.est_price, row.signal_id);
  const t = withServerPrice(stored, await serverPrice(c.env, stored));
  const val = enforceLimits(t, limits, { connected: !!session, confirmedToday: today });

  const now = nowIso();
  const queueExpires = isoIn(QUEUE_TTL_MS);
  const res = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE order_intents SET status = 'queued', confirm_token_hash = NULL, confirmed_at = ?1, expires_at = ?2, updated_at = ?1
       WHERE id = ?3 AND status = 'pending_confirm' AND confirm_token_hash = ?4 AND admin_session_id = ?5 AND expires_at > ?1
         AND (SELECT trading_enabled FROM broker_limits WHERE id = 1) = 1
         AND (SELECT COUNT(*) FROM order_intents WHERE confirmed_at >= ?6) < ?7`,
    ).bind(now, queueExpires, id, h, a.sessionId, istDayStartIso(Date.now()), limits.dailyOrderCap),
    auditWhereStmt(c.env, a.actor, "broker.order.confirm", "order_intent", id, { order: describeTicket(t), value: val.value }, "EXISTS (SELECT 1 FROM order_intents WHERE id = ? AND status = 'queued' AND confirmed_at = ?)", id, now),
  ]);
  if (changes(res[0] as D1Result) === 0) {
    const again = await getIntent(c.env, id);
    if (again && again.status !== "pending_confirm") throw new HttpError(409, "intent_not_pending", { status: again.status });
    throw new HttpError(409, "state_changed", { message: "Limits or the kill switch changed while confirming. Review the ticket again." });
  }
  const done = await getIntent(c.env, id);
  return json({ intent: done ? mapIntent(done) : null });
}

async function cancelOrder(c: Ctx): Promise<Response> {
  const a = requireAdmin(c);
  const id = v.uuid(param(c, "id"));
  const now = nowIso();
  const res = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE order_intents SET status = 'cancelled', confirm_token_hash = NULL, updated_at = ?1, completed_at = ?1 WHERE id = ?2 AND status IN ('pending_confirm', 'queued')",
    ).bind(now, id),
    auditWhereStmt(c.env, a.actor, "broker.order.cancel", "order_intent", id, null, "EXISTS (SELECT 1 FROM order_intents WHERE id = ? AND status = 'cancelled' AND completed_at = ?)", id, now),
  ]);
  if (changes(res[0] as D1Result) === 0) {
    const row = await getIntent(c.env, id);
    if (!row) throw notFound();
    throw new HttpError(409, "intent_not_cancellable", { status: row.status, message: "Only tickets that the relay hasn't claimed yet can be cancelled here." });
  }
  const row = await getIntent(c.env, id);
  return json({ intent: row ? mapIntent(row) : null });
}

async function listOrders(c: Ctx): Promise<Response> {
  requireAdmin(c);
  await sweep(c.env);
  const limit = v.intParam(c.url.searchParams.get("limit"), 50, 1, 200);
  const rows = await all<IntentRow>(c.env, `SELECT ${INTENT_COLS} FROM order_intents ORDER BY created_at DESC LIMIT ?`, limit);
  return json({ items: rows.map(mapIntent) });
}

/* ======================= admin: limits, kill switch, disconnect ======================= */

async function putLimits(c: Ctx): Promise<Response> {
  const a = requireAdmin(c);
  const body = await readJsonObject(c.req, 2048);
  const cur = await loadLimits(c.env);
  const next = parseLimitsUpdate(body, cur);
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE broker_limits SET max_order_value_inr = ?, max_qty = ?, daily_order_cap = ?, allowed_exchanges = ?, allowed_products = ?, updated_at = ?, updated_by = ? WHERE id = 1",
    ).bind(next.maxOrderValueInr, next.maxQty, next.dailyOrderCap, JSON.stringify(next.allowedExchanges), JSON.stringify(next.allowedProducts), now, a.actor),
    auditStmt(c.env, a.actor, "broker.limits.update", "broker_limits", "1", {
      before: { maxOrderValueInr: cur.maxOrderValueInr, maxQty: cur.maxQty, dailyOrderCap: cur.dailyOrderCap, allowedExchanges: cur.allowedExchanges, allowedProducts: cur.allowedProducts },
      after: next,
    }),
  ]);
  return json({ limits: publicLimits(await loadLimits(c.env)) });
}

async function setTrading(c: Ctx): Promise<Response> {
  const a = requireAdmin(c);
  const body = await readJsonObject(c.req, 1024);
  const enabled = v.bool(body.enabled, "enabled");
  if (enabled) {
    if (body.confirm !== "ENABLE") throw new HttpError(400, "confirmation_required", { field: "confirm", message: 'Send confirm:"ENABLE" to switch live trading on.' });
    requireKite(c.env);
  }
  const now = nowIso();
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare("UPDATE broker_limits SET trading_enabled = ?, updated_at = ?, updated_by = ? WHERE id = 1").bind(enabled ? 1 : 0, now, a.actor),
  ];
  if (!enabled) {
    // Kill switch: nothing that hasn't reached the relay may still go out.
    stmts.push(
      c.env.DB.prepare(
        "UPDATE order_intents SET status = 'cancelled', confirm_token_hash = NULL, error = 'kill_switch', updated_at = ?1, completed_at = ?1 WHERE status IN ('pending_confirm', 'queued')",
      ).bind(now),
    );
  }
  stmts.push(auditStmt(c.env, a.actor, enabled ? "broker.trading.enable" : "broker.trading.disable", "broker_limits", "1"));
  const res = await c.env.DB.batch(stmts);
  const cancelled = enabled ? 0 : changes(res[1] as D1Result);
  return json({ tradingEnabled: enabled, cancelled, limits: publicLimits(await loadLimits(c.env)) });
}

async function disconnect(c: Ctx): Promise<Response> {
  const a = requireAdmin(c);
  await enforce(c.env, `broker_disconnect:${a.sessionId}`, 10, 600);
  const s = await first<SessionRow>(c.env, `SELECT ${SESSION_COLS} FROM broker_sessions WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`);
  if (!s) return json({ ok: true, wasConnected: false, kiteInvalidated: false });
  let kiteInvalidated = false;
  if (kiteConfigured(c.env) && Date.parse(s.expires_at) > Date.now()) {
    const token = await openToken(c.env, s.token_ct, s.token_iv, tokenAad(s.id, s.kite_user_id));
    if (token) {
      try {
        await invalidateAccessToken(c.env, token);
        kiteInvalidated = true;
      } catch (err) {
        // A token Kite already considers invalid is as good as invalidated.
        kiteInvalidated = err instanceof KiteError && err.tokenProblem;
        if (!(err instanceof KiteError)) logError("broker.disconnect", err);
      }
    }
  }
  const now = nowIso();
  await c.env.DB.batch([
    revokeSessionStmt(c.env, s.id, "disconnect", now),
    c.env.DB.prepare(
      "UPDATE order_intents SET status = 'cancelled', confirm_token_hash = NULL, error = 'disconnected', updated_at = ?1, completed_at = ?1 WHERE status IN ('pending_confirm', 'queued')",
    ).bind(now),
    auditStmt(c.env, a.actor, "broker.disconnect", "broker_session", s.id, { kiteUserId: s.kite_user_id, kiteInvalidated }),
    notifyStmt(c.env, "session", "Kite disconnected", kiteInvalidated ? "The access token was invalidated at Kite and wiped here." : "The access token was wiped here.", s.id),
  ]);
  return json({ ok: true, wasConnected: true, kiteInvalidated });
}

/* ======================= admin: Kite read proxies (any IP is fine for reads) ======================= */

type Scalar = string | number | boolean | null;

function pick(row: unknown, fields: readonly string[]): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  if (!row || typeof row !== "object") return out;
  const r = row as Record<string, unknown>;
  for (const f of fields) {
    const x = r[f];
    if (typeof x === "string") out[f] = x.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200);
    else if (typeof x === "number" && Number.isFinite(x)) out[f] = x;
    else if (typeof x === "boolean" || x === null) out[f] = x;
  }
  return out;
}

function numbers(o: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!o || typeof o !== "object") return out;
  for (const [k, x] of Object.entries(o as Record<string, unknown>)) {
    if (/^[a-z0-9_]{1,40}$/.test(k) && typeof x === "number" && Number.isFinite(x)) out[k] = x;
  }
  return out;
}

const ORDER_FIELDS = [
  "order_id", "exchange_order_id", "status", "status_message", "variety", "exchange", "tradingsymbol", "transaction_type", "order_type",
  "product", "validity", "quantity", "filled_quantity", "pending_quantity", "cancelled_quantity", "price", "trigger_price", "average_price",
  "order_timestamp", "exchange_timestamp", "tag",
] as const;
const POSITION_FIELDS = [
  "tradingsymbol", "exchange", "product", "quantity", "overnight_quantity", "average_price", "last_price", "close_price", "pnl", "m2m",
  "unrealised", "realised", "buy_quantity", "buy_price", "buy_value", "sell_quantity", "sell_price", "sell_value", "value", "multiplier",
] as const;
const HOLDING_FIELDS = [
  "tradingsymbol", "exchange", "isin", "product", "quantity", "t1_quantity", "used_quantity", "collateral_quantity", "average_price",
  "last_price", "close_price", "pnl", "day_change", "day_change_percentage",
] as const;

const READS: Record<string, { path: string; map: (d: unknown) => unknown }> = {
  orders: { path: "/orders", map: (d) => ({ items: Array.isArray(d) ? d.slice(-500).map((o) => pick(o, ORDER_FIELDS)).reverse() : [] }) },
  positions: {
    path: "/portfolio/positions",
    map: (d) => {
      const o = (d && typeof d === "object" ? d : {}) as { net?: unknown; day?: unknown };
      return {
        net: Array.isArray(o.net) ? o.net.slice(0, 500).map((p) => pick(p, POSITION_FIELDS)) : [],
        day: Array.isArray(o.day) ? o.day.slice(0, 500).map((p) => pick(p, POSITION_FIELDS)) : [],
      };
    },
  },
  holdings: { path: "/portfolio/holdings", map: (d) => ({ items: Array.isArray(d) ? d.slice(0, 1000).map((h) => pick(h, HOLDING_FIELDS)) : [] }) },
  margins: {
    path: "/user/margins",
    map: (d) => {
      const o = (d && typeof d === "object" ? d : {}) as Record<string, unknown>;
      const seg = (s: unknown) => {
        if (!s || typeof s !== "object") return null;
        const x = s as Record<string, unknown>;
        return { enabled: x.enabled === true, net: typeof x.net === "number" ? x.net : null, available: numbers(x.available), utilised: numbers(x.utilised) };
      };
      return { equity: seg(o.equity), commodity: seg(o.commodity) };
    },
  },
};

/** Map a Kite failure on a read. TokenException => the session is dead: revoke + wipe + notify. */
async function kiteReadFailure(env: Env, err: unknown, session: SessionRow): Promise<never> {
  if (!(err instanceof KiteError)) throw err;
  if (err.tokenProblem) {
    await env.DB.batch([
      revokeSessionStmt(env, session.id, "token_exception"),
      auditStmt(env, "system:kite", "broker.session.token_exception", "broker_session", session.id),
      notifyStmt(env, "session", "Kite session ended", "Kite rejected the access token (expired, logged out or revoked). Connect Kite again.", session.id, `token-exc:${session.id}`),
    ]);
    throw new HttpError(409, "broker_disconnected", { message: "Kite rejected the session (expired or revoked). Connect Kite again." });
  }
  if (err.status === 429) throw new HttpError(429, "kite_rate_limited", { retryAfter: 1 }, { "retry-after": "1" });
  throw new HttpError(502, "kite_error", { errorType: err.errorType, message: cleanKiteMessage(err.message) });
}

function readProxy(kind: keyof typeof READS) {
  return async (c: Ctx): Promise<Response> => {
    const a = requireAdmin(c);
    requireKite(c.env);
    await enforce(c.env, `broker_read:${a.sessionId}`, 60, 60);
    const acc = await liveAccess(c.env);
    if (!acc) throw new HttpError(409, "broker_not_connected", { message: "Kite isn't connected, or today's session has expired." });
    const spec = READS[kind] as { path: string; map: (d: unknown) => unknown };
    let data: unknown;
    try {
      data = await kiteCall(c.env, { method: "GET", path: spec.path, accessToken: acc.token });
    } catch (err) {
      return kiteReadFailure(c.env, err, acc.session);
    }
    c.exec.waitUntil(c.env.DB.prepare("UPDATE broker_sessions SET last_used_at = ? WHERE id = ?").bind(nowIso(), acc.session.id).run().catch(() => undefined));
    return json({ ...(spec.map(data) as Record<string, unknown>), asOf: nowIso() });
  };
}

/* ======================= admin: notifications ======================= */

async function listNotifications(c: Ctx): Promise<Response> {
  requireAdmin(c);
  const unreadOnly = c.url.searchParams.get("unread") === "1";
  const limit = v.intParam(c.url.searchParams.get("limit"), 30, 1, 100);
  const [rows, unread] = await Promise.all([
    all<{ id: string; kind: string; title: string; body: string | null; ref_id: string | null; created_at: string; read_at: string | null }>(
      c.env,
      `SELECT id, kind, title, body, ref_id, created_at, read_at FROM broker_notifications ${unreadOnly ? "WHERE read_at IS NULL" : ""} ORDER BY created_at DESC LIMIT ?`,
      limit,
    ),
    first<{ n: number }>(c.env, "SELECT COUNT(*) AS n FROM broker_notifications WHERE read_at IS NULL"),
  ]);
  return json({
    items: rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, refId: r.ref_id, createdAt: r.created_at, readAt: r.read_at })),
    unread: Number(unread?.n ?? 0),
  });
}

async function readNotifications(c: Ctx): Promise<Response> {
  requireAdmin(c);
  const body = await readJsonObject(c.req, 8192);
  const now = nowIso();
  let marked = 0;
  if (body.all === true) {
    marked = changes(await c.env.DB.prepare("UPDATE broker_notifications SET read_at = ? WHERE read_at IS NULL").bind(now).run());
  } else {
    const ids = v.stringArray(body.ids, "ids", 100).map((x, i) => v.uuid(x, `ids[${i}]`));
    if (ids.length) {
      marked = changes(
        await c.env.DB.prepare("UPDATE broker_notifications SET read_at = ? WHERE read_at IS NULL AND id IN (SELECT value FROM json_each(?))").bind(now, JSON.stringify(ids)).run(),
      );
    }
  }
  const unread = await first<{ n: number }>(c.env, "SELECT COUNT(*) AS n FROM broker_notifications WHERE read_at IS NULL");
  return json({ ok: true, marked, unread: Number(unread?.n ?? 0) });
}

/* ======================= public: Kite postback ======================= */

const POSTBACK_FIELDS = [
  "order_id", "exchange_order_id", "parent_order_id", "status", "status_message", "tradingsymbol", "exchange", "order_type", "transaction_type",
  "validity", "variety", "product", "quantity", "filled_quantity", "unfilled_quantity", "pending_quantity", "cancelled_quantity", "price",
  "trigger_price", "average_price", "order_timestamp", "exchange_timestamp", "exchange_update_timestamp", "tag", "user_id", "placed_by", "app_id",
] as const;

async function postback(c: Ctx): Promise<Response> {
  const env = c.env;
  if (!kiteConfigured(env)) return json({ error: "broker_not_configured" }, {}, 503);
  const ipH = await c.ipHash();
  await enforce(env, `broker_postback:${ipH}`, 300, 60);
  const text = await readTextBounded(c.req, 16 * 1024);
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid_json");
  }
  const orderId = typeof body.order_id === "string" ? body.order_id : "";
  const orderTs = typeof body.order_timestamp === "string" ? body.order_timestamp : "";
  const checksum = typeof body.checksum === "string" ? body.checksum.toLowerCase() : "";
  if (!ORDER_ID_RE.test(orderId) || !orderTs || orderTs.length > 40 || !/^[0-9a-f]{64}$/.test(checksum)) throw new HttpError(400, "invalid_postback");
  const expected = await postbackChecksum(orderId, orderTs, env.KITE_API_SECRET as string);
  if (!constantTimeEqual(expected, checksum)) {
    await audit(env, "anonymous", "broker.postback.bad_checksum", "kite_order", orderId, { ip: ipH.slice(0, 12) });
    throw new HttpError(401, "invalid_checksum");
  }

  const p = pick(body, POSTBACK_FIELDS);
  const kiteStatus = typeof p.status === "string" ? p.status.toUpperCase().slice(0, 40) : null;
  const tag = typeof p.tag === "string" && TAG_RE.test(p.tag) ? p.tag : null;
  const dedupe = await sha256Hex(
    [orderId, kiteStatus, p.filled_quantity, p.pending_quantity, p.cancelled_quantity, p.average_price, p.exchange_update_timestamp, p.price, p.trigger_price, p.quantity]
      .map((x) => String(x ?? ""))
      .join("|"),
  );
  const intent = await first<{ id: string; status: string }>(
    env,
    "SELECT id, status FROM order_intents WHERE kite_order_id = ?1 OR (?2 IS NOT NULL AND tag = ?2) ORDER BY (kite_order_id = ?1) DESC LIMIT 1",
    orderId,
    tag,
  );
  const now = nowIso();
  const ins = await env.DB.prepare("INSERT OR IGNORE INTO order_updates (id, dedupe_key, kite_order_id, intent_id, status, payload, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(newId(), dedupe, orderId, intent?.id ?? null, kiteStatus, JSON.stringify(p), now)
    .run();
  if (changes(ins) === 0) return json({ ok: true, duplicate: true });

  const line = `${p.transaction_type ?? ""} ${p.quantity ?? ""} ${p.exchange ?? ""}:${p.tradingsymbol ?? ""}`.trim();
  const message = typeof p.status_message === "string" ? p.status_message : null;
  const stmts: D1PreparedStatement[] = [];
  if (intent) {
    // REJECTED => rejected. A claimed/failed intent with a postback WAS placed (relay result lost or timed out).
    stmts.push(
      env.DB.prepare(
        `UPDATE order_intents SET kite_status = ?1, kite_order_id = COALESCE(kite_order_id, ?2), updated_at = ?3,
           status = CASE WHEN ?1 = 'REJECTED' THEN 'rejected' WHEN status IN ('claimed', 'failed') THEN 'placed' ELSE status END,
           error = CASE WHEN ?1 = 'REJECTED' THEN ?4 WHEN status = 'failed' THEN NULL ELSE error END,
           completed_at = COALESCE(completed_at, ?3)
         WHERE id = ?5 AND status IN ('claimed', 'placed', 'failed', 'rejected')`,
      ).bind(kiteStatus, orderId, now, message ? `Kite: ${message.slice(0, 280)}` : "Kite: rejected", intent.id),
    );
  }
  stmts.push(
    notifyStmt(env, "order", `${kiteStatus ?? "UPDATE"}: ${line}`, message, intent?.id ?? orderId, `postback:${dedupe}`),
    auditStmt(env, "system:kite", "broker.postback", intent ? "order_intent" : "kite_order", intent?.id ?? orderId, { orderId, status: kiteStatus, symbol: p.tradingsymbol ?? null }),
  );
  await env.DB.batch(stmts);
  return json({ ok: true });
}

/* ======================= relay (Bearer RELAY_TOKEN) ======================= */

async function relayAuth(c: Ctx): Promise<void> {
  if (!relayConfigured(c.env)) {
    throw new HttpError(503, "relay_not_configured", { hint: "Owner: set RELAY_TOKEN (>= 32 chars) with npx wrangler secret put RELAY_TOKEN." });
  }
  const ipH = await c.ipHash();
  await enforce(c.env, `relay_ip:${ipH}`, 240, 60);
  const m = /^Bearer\s+(\S{1,512})$/.exec((c.req.headers.get("authorization") ?? "").trim());
  const ok = !!m && (await safeEqualHashed(m[1] as string, c.env.RELAY_TOKEN as string));
  if (!ok) {
    const r = await hit(c.env, `relay_fail:${ipH}`, 20, 600);
    if (!r.ok) throw new HttpError(429, "rate_limited", { retryAfter: r.retryAfter }, { "retry-after": String(Math.max(1, r.retryAfter)) });
    await audit(c.env, "anonymous", "relay.auth_failure", "relay", null, { ip: ipH.slice(0, 12) });
    throw new HttpError(401, "unauthorized");
  }
}

function relayIp(req: Request): string {
  const ip = clientIp(req);
  return /^[0-9A-Fa-f:.]{2,45}$/.test(ip) ? ip : "unknown";
}

async function relayClaim(c: Ctx): Promise<Response> {
  await relayAuth(c);
  const env = c.env;
  await enforce(env, "relay:claim", 120, 60);
  const body = await readJsonObject(c.req, 1024);
  const version = v.optStr(body.version, "version", { max: 40, pattern: /^[A-Za-z0-9._+-]+$/ }) ?? null;
  const ip = relayIp(c.req);
  const now = nowIso();
  const hb = await first<{ ip_changed_at: string | null; prev_ip: string | null }>(
    env,
    `INSERT INTO relay_heartbeats (id, ip, version, first_seen_at, last_seen_at) VALUES ('relay', ?1, ?2, ?3, ?3)
     ON CONFLICT (id) DO UPDATE SET
       prev_ip = CASE WHEN relay_heartbeats.ip <> excluded.ip THEN relay_heartbeats.ip ELSE relay_heartbeats.prev_ip END,
       ip_changed_at = CASE WHEN relay_heartbeats.ip <> excluded.ip THEN excluded.last_seen_at ELSE relay_heartbeats.ip_changed_at END,
       ip = excluded.ip, version = excluded.version, last_seen_at = excluded.last_seen_at
     RETURNING ip_changed_at, prev_ip`,
    ip,
    version,
    now,
  );
  if (hb?.ip_changed_at === now) {
    await env.DB.batch([
      notifyStmt(env, "relay", "Relay IP changed", `The relay now reaches Tudumm from ${ip} (was ${hb.prev_ip ?? "?"}). Kite will reject orders until this IP is registered in the developer console.`, null, `relay-ip:${ip}:${now}`),
      auditStmt(env, "system:relay", "relay.ip_changed", "relay", "relay", { ip, prevIp: hb.prev_ip }),
    ]);
  }

  await sweep(env);
  if (!kiteConfigured(env)) return json({ idle: true, reason: "kite_not_configured", relayIp: ip });
  const limits = await loadLimits(env);
  if (!limits.tradingEnabled) return json({ idle: true, reason: "trading_disabled", relayIp: ip });
  // Cheap check first so idle polls don't decrypt the token.
  const queued = await first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM order_intents WHERE status = 'queued' AND expires_at > ?", now);
  if (!queued?.n) return json({ idle: true, reason: "no_orders", relayIp: ip });
  const acc = await liveAccess(env);
  if (!acc) return json({ idle: true, reason: "not_connected", relayIp: ip });

  const at = nowIso();
  const claimed = await first<{ id: string; payload: string; tag: string }>(
    env,
    `UPDATE order_intents SET status = 'claimed', claimed_at = ?1, updated_at = ?1
     WHERE id = (SELECT id FROM order_intents WHERE status = 'queued' AND expires_at > ?1 ORDER BY confirmed_at ASC LIMIT 1)
       AND status = 'queued' AND (SELECT trading_enabled FROM broker_limits WHERE id = 1) = 1
     RETURNING id, payload, tag`,
    at,
  );
  if (!claimed) return json({ idle: true, reason: "no_orders", relayIp: ip });
  await env.DB.batch([
    auditStmt(env, "system:relay", "broker.order.claim", "order_intent", claimed.id, { ip }),
    env.DB.prepare("UPDATE broker_sessions SET last_used_at = ? WHERE id = ?").bind(at, acc.session.id),
  ]);
  return json({
    idle: false,
    intent: { id: claimed.id, tag: claimed.tag, variety: "regular", params: parseJson<Record<string, string>>(claimed.payload, {}) },
    apiKey: env.KITE_API_KEY,
    accessToken: acc.token,
    relayIp: ip,
  });
}

async function relayResult(c: Ctx): Promise<Response> {
  await relayAuth(c);
  const env = c.env;
  await enforce(env, "relay:result", 120, 60);
  const body = await readJsonObject(c.req, 4096);
  const intentId = v.uuid(body.intentId, "intentId");
  const ok = v.bool(body.ok, "ok");
  const orderId = ok ? v.str(body.orderId, "orderId", { max: 32, pattern: ORDER_ID_RE }) : null;
  const error = ok ? null : (v.optStr(body.error, "error", { max: 500 }) ?? "relay reported a failure without details");

  const row = await getIntent(env, intentId);
  if (!row) throw notFound();
  if (ok && row.status === "placed" && row.kite_order_id === orderId) return json({ ok: true, status: row.status, idempotent: true });
  const reopenable = ok && row.status === "failed" && row.kite_order_id === null; // swept as "no result", then the result arrived
  if (row.status !== "claimed" && !reopenable) throw new HttpError(409, "intent_not_claimed", { status: row.status });

  const now = nowIso();
  const next = ok ? "placed" : "failed";
  const line = payloadLine(row.payload);
  const cond = "EXISTS (SELECT 1 FROM order_intents WHERE id = ? AND status = ? AND completed_at = ?)";
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE order_intents SET status = ?1, kite_order_id = COALESCE(kite_order_id, ?2), error = ?3, completed_at = ?4, updated_at = ?4
       WHERE id = ?5 AND (status = 'claimed' OR (status = 'failed' AND kite_order_id IS NULL AND ?1 = 'placed'))`,
    ).bind(next, orderId, error, now, intentId),
    auditWhereStmt(env, "system:relay", ok ? "broker.order.placed" : "broker.order.failed", "order_intent", intentId, ok ? { orderId } : { error: error?.slice(0, 300) }, cond, intentId, next, now),
    notifyWhereStmt(env, ok ? `Order placed: ${line}` : `Order failed: ${line}`, ok ? `Kite order ${orderId}` : error, intentId, cond, intentId, next, now),
  ]);
  const done = await getIntent(env, intentId);
  if (!done || done.status !== next) throw new HttpError(409, "intent_not_claimed", { status: done?.status ?? "unknown" });
  return json({ ok: true, status: done.status });
}

/* ======================= route table ======================= */

export const brokerRoutes: RouteDef[] = [
  // owner (admin session); router adds CSRF (same-origin) + Sec-Fetch-Site checks + admin write limit
  { method: "GET", path: "/api/admin/broker/status", auth: "admin", handler: status },
  { method: "GET", path: "/api/admin/broker/kite/login", auth: "admin", handler: kiteLogin },
  { method: "GET", path: "/api/admin/broker/orders", auth: "admin", handler: listOrders },
  { method: "POST", path: "/api/admin/broker/orders", auth: "admin", handler: createOrder },
  { method: "POST", path: "/api/admin/broker/orders/:id/confirm", auth: "admin", handler: confirmOrder },
  { method: "POST", path: "/api/admin/broker/orders/:id/cancel", auth: "admin", handler: cancelOrder },
  { method: "GET", path: "/api/admin/broker/kite/orders", auth: "admin", handler: readProxy("orders") },
  { method: "GET", path: "/api/admin/broker/kite/positions", auth: "admin", handler: readProxy("positions") },
  { method: "GET", path: "/api/admin/broker/kite/holdings", auth: "admin", handler: readProxy("holdings") },
  { method: "GET", path: "/api/admin/broker/kite/margins", auth: "admin", handler: readProxy("margins") },
  { method: "PUT", path: "/api/admin/broker/limits", auth: "admin", handler: putLimits },
  { method: "POST", path: "/api/admin/broker/trading", auth: "admin", handler: setTrading },
  { method: "POST", path: "/api/admin/broker/disconnect", auth: "admin", handler: disconnect },
  { method: "GET", path: "/api/admin/broker/notifications", auth: "admin", handler: listNotifications },
  { method: "POST", path: "/api/admin/broker/notifications/read", auth: "admin", handler: readNotifications },
  // public: Kite's cross-site redirect (the Strict admin cookie isn't sent) + checksum-verified postbacks
  { method: "GET", path: "/api/v1/broker/kite/callback", auth: "none", handler: kiteCallback },
  { method: "POST", path: "/api/v1/broker/kite/postback", auth: "none", csrf: "none", noWriteLimit: true, handler: postback },
  // relay: Bearer RELAY_TOKEN only (no browser origin involved); index.ts sends /api/internal/* except ingest* here
  { method: "POST", path: "/api/internal/relay/claim", auth: "none", csrf: "none", noWriteLimit: true, handler: relayClaim },
  { method: "POST", path: "/api/internal/relay/result", auth: "none", csrf: "none", noWriteLimit: true, handler: relayResult },
];
