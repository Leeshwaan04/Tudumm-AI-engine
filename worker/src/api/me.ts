// /me, sessions, export, delete, profile, watchlist, tracked, sync, consents.
// Every query is scoped by the authenticated user's id (no IDOR).
import { json } from "../lib/edge";
import { all, first, newId, nowIso } from "../lib/db";
import { clearHostCookie, HttpError, notFound, readJsonObject, SESSION_COOKIE } from "../lib/http";
import { CONSENT_KINDS, LEGAL, type ConsentKind } from "../lib/plans";
import { enforce } from "../lib/ratelimit";
import { planInfo, publicUser } from "../lib/session";
import * as v from "../lib/validate";
import type { Ctx, RouteDef } from "./context";
import { param, requireUser } from "./context";
import { DEFAULT_PROFILE, getConsents, getProfile, upsertProfileStmt, validateProfilePatch } from "./userdata";

const LIST_MAX = 200;

/* ---------------- me ---------------- */

async function counts(c: Ctx, userId: string) {
  const r = await first<{ watchlist: number; tracked: number; alerts: number; unread: number }>(
    c.env,
    `SELECT (SELECT COUNT(*) FROM watchlist WHERE user_id = ?1) AS watchlist,
            (SELECT COUNT(*) FROM tracked WHERE user_id = ?1) AS tracked,
            (SELECT COUNT(*) FROM alerts WHERE user_id = ?1 AND active = 1) AS alerts,
            (SELECT COUNT(*) FROM notifications WHERE user_id = ?1 AND read_at IS NULL) AS unread`,
    userId,
  );
  return { watchlist: r?.watchlist ?? 0, tracked: r?.tracked ?? 0, alerts: r?.alerts ?? 0, unread: r?.unread ?? 0 };
}

async function getMe(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const [profile, consents, cnt] = await Promise.all([getProfile(c.env, user.id), getConsents(c.env, user.id), counts(c, user.id)]);
  return json({
    user: publicUser(user),
    profile,
    consents: consents.items,
    pendingConsents: consents.pending,
    plan: planInfo(user),
    counts: cnt,
    session: { id: c.session?.id, kind: c.session?.kind, expiresAt: c.session?.expiresAt },
  });
}

async function patchMe(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const body = await readJsonObject(c.req, 4096);
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.displayName !== undefined) {
    const dn = body.displayName === null || body.displayName === "" ? null : v.str(body.displayName, "displayName", { min: 1, max: 60 });
    sets.push("display_name = ?");
    binds.push(dn);
  }
  let marketing: boolean | undefined;
  if (body.marketingOptIn !== undefined) {
    marketing = v.bool(body.marketingOptIn, "marketingOptIn");
    sets.push("marketing_opt_in = ?");
    binds.push(marketing ? 1 : 0);
  }
  if (!sets.length) throw v.invalid("body", "nothing to update (displayName, marketingOptIn)");
  const stmts = [c.env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, user.id)];
  if (marketing !== undefined) stmts.push(...(await consentStmts(c, user.id, "marketing", LEGAL.privacyVersion, marketing)));
  await c.env.DB.batch(stmts);
  const fresh = await first<Record<string, unknown>>(c.env, "SELECT display_name, marketing_opt_in FROM users WHERE id = ?", user.id);
  return json({ user: publicUser({ ...user, display_name: (fresh?.display_name as string | null) ?? null, marketing_opt_in: Number(fresh?.marketing_opt_in ?? 0) }) });
}

/* ---------------- sessions ---------------- */

async function listSessions(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const rows = await all<{ id: string; kind: string; user_agent: string | null; created_at: string; last_used_at: string; expires_at: string }>(
    c.env,
    "SELECT id, kind, user_agent, created_at, last_used_at, expires_at FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_used_at DESC LIMIT 100",
    user.id,
    nowIso(),
  );
  return json({
    items: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      userAgent: r.user_agent,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      expiresAt: r.expires_at,
      current: r.id === c.session?.id,
    })),
  });
}

async function revokeSession(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const id = v.uuid(param(c, "id"));
  const res = await c.env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL").bind(nowIso(), id, user.id).run();
  if (!Number(res.meta?.changes ?? 0)) throw notFound();
  if (id === c.session?.id && c.via === "cookie") c.cookies.push(clearHostCookie(SESSION_COOKIE));
  return json({ ok: true });
}

/* ---------------- export / delete (DPDP / GDPR) ---------------- */

async function exportMe(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  await enforce(c.env, `export:${user.id}`, 5, 86_400);
  const uid = user.id;
  const q = (sql: string, limit = 1000) => c.env.DB.prepare(`${sql} LIMIT ${limit}`).bind(uid);
  const [profile, consents, sessions, watchlist, tracked, alerts, notifications, events, tickets, messages, requests, payments] = await c.env.DB.batch([
    q("SELECT persona, markets, capital, currency, risk_pct, onboarded, updated_at FROM profiles WHERE user_id = ?", 1),
    q("SELECT kind, version, accepted_at, withdrawn_at FROM consents WHERE user_id = ? ORDER BY accepted_at"),
    q("SELECT id, kind, user_agent, created_at, last_used_at, expires_at, revoked_at FROM sessions WHERE user_id = ? ORDER BY created_at"),
    q("SELECT symbol, added_at FROM watchlist WHERE user_id = ? ORDER BY added_at"),
    q("SELECT signal_id, symbol, added_at FROM tracked WHERE user_id = ? ORDER BY added_at"),
    q("SELECT id, symbol, kind, threshold, one_shot, active, created_at, last_triggered_at FROM alerts WHERE user_id = ? ORDER BY created_at"),
    q("SELECT id, kind, title, body, link, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC"),
    q("SELECT name, props, path, created_at, country, device, source FROM events WHERE user_id = ? ORDER BY created_at DESC", 5000),
    q("SELECT id, email, category, subject, body, status, created_at, updated_at FROM support_tickets WHERE user_id = ? ORDER BY created_at"),
    q(
      "SELECT m.ticket_id, m.author, m.body, m.created_at FROM ticket_messages m JOIN support_tickets t ON t.id = m.ticket_id WHERE t.user_id = ? ORDER BY m.created_at",
      5000,
    ),
    q("SELECT kind, status, created_at, completed_at FROM data_requests WHERE user_id = ? ORDER BY created_at"),
    q("SELECT provider, provider_ref, amount_minor, currency, plan, status, created_at FROM payments WHERE user_id = ? ORDER BY created_at"),
  ]);
  const now = nowIso();
  await c.env.DB.prepare("INSERT INTO data_requests (id, user_id, kind, status, created_at, completed_at) VALUES (?, ?, 'export', 'completed', ?, ?)")
    .bind(newId(), uid, now, now)
    .run();
  const rows = (r: D1Result | undefined) => (r?.results ?? []) as Record<string, unknown>[];
  const doc = {
    exportedAt: now,
    format: "tudumm-export/1",
    note: "Everything Tudumm stores about your account. Session tokens and codes are stored only as one-way hashes and are not included.",
    user: publicUser(user),
    profile: rows(profile)[0] ?? null,
    consents: rows(consents),
    sessions: rows(sessions),
    watchlist: rows(watchlist),
    tracked: rows(tracked),
    alerts: rows(alerts),
    notifications: rows(notifications),
    events: rows(events),
    supportTickets: rows(tickets),
    supportMessages: rows(messages),
    dataRequests: rows(requests),
    payments: rows(payments),
  };
  return new Response(JSON.stringify(doc, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="tudumm-export-${now.slice(0, 10)}.json"`,
    },
  });
}

async function deleteMe(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const body = await readJsonObject(c.req, 1024);
  if (body.confirm !== "DELETE") throw v.invalid("confirm", 'send {"confirm":"DELETE"} to delete your account');
  const uid = user.id;
  const now = nowIso();
  const tomb = `deleted+${uid}@invalid`;
  const db = c.env.DB;
  await db.batch([
    db.prepare("UPDATE users SET status = 'deleted', email = ?, email_verified = 0, display_name = NULL, marketing_opt_in = 0, country = NULL WHERE id = ?").bind(tomb, uid),
    db.prepare("DELETE FROM profiles WHERE user_id = ?").bind(uid),
    db.prepare("DELETE FROM watchlist WHERE user_id = ?").bind(uid),
    db.prepare("DELETE FROM tracked WHERE user_id = ?").bind(uid),
    db.prepare("DELETE FROM alerts WHERE user_id = ?").bind(uid),
    db.prepare("DELETE FROM notifications WHERE user_id = ?").bind(uid),
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(uid),
    db.prepare("DELETE FROM ext_link_codes WHERE user_id = ?").bind(uid),
    // Activity is kept for aggregate analytics but de-linked from the person.
    db.prepare("UPDATE events SET user_id = NULL, anon_id = NULL WHERE user_id = ?").bind(uid),
    // Support history is kept (grievance-redressal records) but de-linked and the email removed.
    db.prepare("UPDATE support_tickets SET user_id = NULL, email = ? WHERE user_id = ?").bind(tomb, uid),
    db.prepare("INSERT INTO data_requests (id, user_id, kind, status, created_at, completed_at) VALUES (?, ?, 'delete', 'completed', ?, ?)").bind(newId(), uid, now, now),
    db.prepare("INSERT INTO audit_log (id, actor, action, target_type, target_id, detail, created_at) VALUES (?, ?, 'user.self_delete', 'user', ?, NULL, ?)").bind(
      newId(),
      `user:${uid}`,
      uid,
      now,
    ),
  ]);
  c.cookies.push(clearHostCookie(SESSION_COOKIE));
  return json({ ok: true, deleted: true });
}

/* ---------------- profile ---------------- */

async function getProfileRoute(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  return json({ profile: await getProfile(c.env, user.id), defaults: DEFAULT_PROFILE });
}

async function putProfile(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const body = await readJsonObject(c.req, 4096);
  const input = body.profile !== undefined ? body.profile : body;
  const patch = validateProfilePatch(input, true);
  const current = await getProfile(c.env, user.id);
  const base = current ?? { ...DEFAULT_PROFILE, updatedAt: null };
  const merged = {
    persona: patch.persona ?? base.persona,
    markets: patch.markets ?? base.markets,
    capital: patch.capital ?? base.capital,
    currency: patch.currency ?? base.currency,
    riskPct: patch.riskPct ?? base.riskPct,
    onboarded: patch.onboarded ?? base.onboarded,
  };
  await upsertProfileStmt(c.env, user.id, merged).run();
  return json({ profile: await getProfile(c.env, user.id) });
}

/* ---------------- watchlist ---------------- */

async function watchlistView(c: Ctx, userId: string) {
  const rows = await all<{ symbol: string; added_at: string }>(
    c.env,
    "SELECT symbol, added_at FROM watchlist WHERE user_id = ? ORDER BY added_at, symbol LIMIT 500",
    userId,
  );
  return { symbols: rows.map((r) => r.symbol), items: rows.map((r) => ({ symbol: r.symbol, addedAt: r.added_at })) };
}

function parseSymbols(input: unknown, field: string): string[] {
  const arr = v.stringArray(input, field, LIST_MAX);
  return [...new Set(arr.map((s, i) => v.symbol(s, `${field}[${i}]`)))];
}

async function getWatchlist(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  return json(await watchlistView(c, user.id));
}

async function putWatchlist(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const body = await readJsonObject(c.req, 16 * 1024);
  const symbols = parseSymbols(body.symbols, "symbols");
  const list = orderedJson(symbols.map((s) => ({ s })), Date.now());
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM watchlist WHERE user_id = ?1 AND symbol NOT IN (SELECT json_extract(value, '$.s') FROM json_each(?2))").bind(user.id, list),
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO watchlist (user_id, symbol, added_at) SELECT ?1, json_extract(value, '$.s'), json_extract(value, '$.t') FROM json_each(?2)",
    ).bind(user.id, list),
  ]);
  return json(await watchlistView(c, user.id));
}

async function addWatch(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const sym = v.symbol(decodeURIComponent(param(c, "symbol")));
  const cnt = await first<{ n: number }>(c.env, "SELECT COUNT(*) AS n FROM watchlist WHERE user_id = ?", user.id);
  if ((cnt?.n ?? 0) >= LIST_MAX) throw new HttpError(409, "limit_reached", { limit: LIST_MAX });
  await c.env.DB.prepare("INSERT OR IGNORE INTO watchlist (user_id, symbol, added_at) VALUES (?, ?, ?)").bind(user.id, sym, nowIso()).run();
  return json(await watchlistView(c, user.id));
}

async function delWatch(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const sym = v.symbol(decodeURIComponent(param(c, "symbol")));
  await c.env.DB.prepare("DELETE FROM watchlist WHERE user_id = ? AND symbol = ?").bind(user.id, sym).run();
  return json(await watchlistView(c, user.id));
}

/* ---------------- tracked ---------------- */
// Row key: signal id, or "sym:<SYMBOL>" for symbol-level tracking (what v0.1 localStorage holds).

interface TrackItem {
  symbol: string;
  signalId: string | null;
}

function trackKey(t: TrackItem): string {
  return t.signalId ?? `sym:${t.symbol}`;
}

async function trackedView(c: Ctx, userId: string) {
  const rows = await all<{ signal_id: string; symbol: string; added_at: string }>(
    c.env,
    "SELECT signal_id, symbol, added_at FROM tracked WHERE user_id = ? ORDER BY added_at, symbol LIMIT 500",
    userId,
  );
  return {
    symbols: [...new Set(rows.map((r) => r.symbol))],
    items: rows.map((r) => ({ symbol: r.symbol, signalId: r.signal_id.startsWith("sym:") ? null : r.signal_id, addedAt: r.added_at })),
  };
}

/** Accepts ["BTCUSDT", ...] or [{symbol, signalId?}, ...]. */
function parseTrackItems(input: unknown, field: string): TrackItem[] {
  const arr = v.stringArray(input, field, LIST_MAX);
  const out = new Map<string, TrackItem>();
  arr.forEach((x, i) => {
    let item: TrackItem;
    if (typeof x === "string") item = { symbol: v.symbol(x, `${field}[${i}]`), signalId: null };
    else if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      item = {
        symbol: v.symbol(o.symbol, `${field}[${i}].symbol`),
        signalId: o.signalId === undefined || o.signalId === null ? null : v.signalId(o.signalId, `${field}[${i}].signalId`),
      };
    } else throw v.invalid(`${field}[${i}]`, "must be a symbol or {symbol, signalId}");
    out.set(trackKey(item), item);
  });
  return [...out.values()];
}

/** JSON array for json_each(), with strictly increasing added_at so list order is preserved. */
function orderedJson<T extends object>(rows: T[], startMs: number): string {
  return JSON.stringify(rows.map((r, i) => ({ ...r, t: new Date(startMs + i).toISOString() })));
}

function trackJson(items: TrackItem[], startMs: number): string {
  return orderedJson(items.map((t) => ({ k: trackKey(t), s: t.symbol })), startMs);
}

async function getTracked(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  return json(await trackedView(c, user.id));
}

async function putTracked(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const body = await readJsonObject(c.req, 24 * 1024);
  const items = parseTrackItems(body.items ?? body.symbols, body.items !== undefined ? "items" : "symbols");
  const list = trackJson(items, Date.now());
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM tracked WHERE user_id = ?1 AND signal_id NOT IN (SELECT json_extract(value, '$.k') FROM json_each(?2))").bind(user.id, list),
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO tracked (user_id, signal_id, symbol, added_at) SELECT ?1, json_extract(value, '$.k'), json_extract(value, '$.s'), json_extract(value, '$.t') FROM json_each(?2)",
    ).bind(user.id, list),
  ]);
  return json(await trackedView(c, user.id));
}

async function addTracked(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const sym = v.symbol(decodeURIComponent(param(c, "symbol")));
  const body = await readJsonObject(c.req, 1024);
  const sid = body.signalId === undefined || body.signalId === null ? null : v.signalId(body.signalId);
  const cnt = await first<{ n: number }>(c.env, "SELECT COUNT(*) AS n FROM tracked WHERE user_id = ?", user.id);
  if ((cnt?.n ?? 0) >= LIST_MAX) throw new HttpError(409, "limit_reached", { limit: LIST_MAX });
  await c.env.DB.prepare("INSERT OR IGNORE INTO tracked (user_id, signal_id, symbol, added_at) VALUES (?, ?, ?, ?)")
    .bind(user.id, trackKey({ symbol: sym, signalId: sid }), sym, nowIso())
    .run();
  return json(await trackedView(c, user.id));
}

async function delTracked(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const sym = v.symbol(decodeURIComponent(param(c, "symbol")));
  const sidParam = c.url.searchParams.get("signalId");
  if (sidParam) {
    await c.env.DB.prepare("DELETE FROM tracked WHERE user_id = ? AND symbol = ? AND signal_id = ?").bind(user.id, sym, v.signalId(sidParam)).run();
  } else {
    await c.env.DB.prepare("DELETE FROM tracked WHERE user_id = ? AND symbol = ?").bind(user.id, sym).run();
  }
  return json(await trackedView(c, user.id));
}

/* ---------------- sync (guest localStorage -> account, once after login) ---------------- */

async function sync(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const body = await readJsonObject(c.req, 32 * 1024);
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  const before = await first<{ w: number; t: number }>(
    c.env,
    "SELECT (SELECT COUNT(*) FROM watchlist WHERE user_id = ?1) AS w, (SELECT COUNT(*) FROM tracked WHERE user_id = ?1) AS t",
    user.id,
  );
  const haveW = before?.w ?? 0;
  const haveT = before?.t ?? 0;
  let profileMerged = false;

  if (body.watchlist !== undefined) {
    // Lenient: invalid symbols are skipped and the list is capped, so stale guest data never blocks login.
    const arr = Array.isArray(body.watchlist) ? body.watchlist.slice(0, LIST_MAX) : [];
    const syms = [...new Set(arr.filter((s): s is string => typeof s === "string").map((s) => s.trim().toUpperCase()).filter((s) => v.SYMBOL_RE.test(s)))];
    const room = Math.max(0, LIST_MAX - haveW);
    if (syms.length && room) {
      stmts.push(
        c.env.DB.prepare(
          `INSERT OR IGNORE INTO watchlist (user_id, symbol, added_at)
           SELECT ?1, json_extract(value, '$.s'), json_extract(value, '$.t') FROM json_each(?2)
           WHERE json_extract(value, '$.s') NOT IN (SELECT symbol FROM watchlist WHERE user_id = ?1) LIMIT ?3`,
        ).bind(user.id, orderedJson(syms.map((s) => ({ s })), now), room),
      );
    }
  }
  if (body.tracked !== undefined) {
    let items: TrackItem[] = [];
    try {
      items = parseTrackItems(Array.isArray(body.tracked) ? body.tracked.slice(0, LIST_MAX) : [], "tracked");
    } catch {
      items = [];
    }
    const room = Math.max(0, LIST_MAX - haveT);
    if (items.length && room) {
      stmts.push(
        c.env.DB.prepare(
          `INSERT OR IGNORE INTO tracked (user_id, signal_id, symbol, added_at)
           SELECT ?1, json_extract(value, '$.k'), json_extract(value, '$.s'), json_extract(value, '$.t') FROM json_each(?2)
           WHERE json_extract(value, '$.k') NOT IN (SELECT signal_id FROM tracked WHERE user_id = ?1) LIMIT ?3`,
        ).bind(user.id, trackJson(items, now), room),
      );
    }
  }
  if (body.profile !== undefined && body.profile !== null) {
    // The server wins unless it has no profile yet.
    const existing = await getProfile(c.env, user.id);
    if (!existing) {
      const patch = validateProfilePatch(body.profile, false);
      if (Object.keys(patch).length) {
        stmts.push(upsertProfileStmt(c.env, user.id, { ...DEFAULT_PROFILE, ...patch }));
        profileMerged = true;
      }
    }
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  const [watchlist, tracked, profile] = await Promise.all([watchlistView(c, user.id), trackedView(c, user.id), getProfile(c.env, user.id)]);
  return json({
    profile,
    watchlist,
    tracked,
    merged: { profile: profileMerged, watchlistAdded: watchlist.items.length - haveW, trackedAdded: tracked.items.length - haveT },
  });
}

/* ---------------- consents ---------------- */

async function consentStmts(c: Ctx, userId: string, kind: ConsentKind, version: string, accept: boolean): Promise<D1PreparedStatement[]> {
  const now = nowIso();
  if (!accept) {
    return [c.env.DB.prepare("UPDATE consents SET withdrawn_at = ? WHERE user_id = ? AND kind = ? AND withdrawn_at IS NULL").bind(now, userId, kind)];
  }
  return [
    c.env.DB.prepare(
      `INSERT INTO consents (id, user_id, kind, version, accepted_at, ip_hash)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
       WHERE NOT EXISTS (SELECT 1 FROM consents WHERE user_id = ?2 AND kind = ?3 AND version = ?4 AND withdrawn_at IS NULL)`,
    ).bind(newId(), userId, kind, version, now, await c.ipHash()),
  ];
}

async function postConsent(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const body = await readJsonObject(c.req, 1024);
  const kind = v.oneOf(body.kind, "kind", CONSENT_KINDS);
  const version = v.str(body.version, "version", { min: 1, max: 32, pattern: /^[A-Za-z0-9._-]+$/ });
  const stmts = await consentStmts(c, user.id, kind, version, true);
  if (kind === "marketing") stmts.push(c.env.DB.prepare("UPDATE users SET marketing_opt_in = 1 WHERE id = ?").bind(user.id));
  await c.env.DB.batch(stmts);
  const consents = await getConsents(c.env, user.id);
  return json({ consents: consents.items, pendingConsents: consents.pending }, {}, 201);
}

async function deleteConsent(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const kind = v.oneOf(param(c, "kind"), "kind", CONSENT_KINDS);
  const stmts = await consentStmts(c, user.id, kind, "", false);
  if (kind === "marketing") stmts.push(c.env.DB.prepare("UPDATE users SET marketing_opt_in = 0 WHERE id = ?").bind(user.id));
  await c.env.DB.batch(stmts);
  const consents = await getConsents(c.env, user.id);
  return json({ consents: consents.items, pendingConsents: consents.pending });
}

export const meRoutes: RouteDef[] = [
  { method: "GET", path: "/api/v1/me", auth: "user", cors: true, handler: getMe },
  { method: "PATCH", path: "/api/v1/me", auth: "user", cors: true, handler: patchMe },
  { method: "DELETE", path: "/api/v1/me", auth: "user", cookieOnly: true, handler: deleteMe },
  { method: "GET", path: "/api/v1/me/sessions", auth: "user", cors: true, handler: listSessions },
  { method: "DELETE", path: "/api/v1/me/sessions/:id", auth: "user", cors: true, handler: revokeSession },
  { method: "GET", path: "/api/v1/me/export", auth: "user", cookieOnly: true, handler: exportMe },
  { method: "GET", path: "/api/v1/profile", auth: "user", cors: true, handler: getProfileRoute },
  { method: "PUT", path: "/api/v1/profile", auth: "user", cors: true, handler: putProfile },
  { method: "GET", path: "/api/v1/watchlist", auth: "user", cors: true, handler: getWatchlist },
  { method: "PUT", path: "/api/v1/watchlist", auth: "user", cors: true, handler: putWatchlist },
  { method: "POST", path: "/api/v1/watchlist/:symbol", auth: "user", cors: true, handler: addWatch },
  { method: "DELETE", path: "/api/v1/watchlist/:symbol", auth: "user", cors: true, handler: delWatch },
  { method: "GET", path: "/api/v1/tracked", auth: "user", cors: true, handler: getTracked },
  { method: "PUT", path: "/api/v1/tracked", auth: "user", cors: true, handler: putTracked },
  { method: "POST", path: "/api/v1/tracked/:symbol", auth: "user", cors: true, handler: addTracked },
  { method: "DELETE", path: "/api/v1/tracked/:symbol", auth: "user", cors: true, handler: delTracked },
  { method: "POST", path: "/api/v1/sync", auth: "user", handler: sync },
  { method: "POST", path: "/api/v1/consents", auth: "user", handler: postConsent },
  { method: "DELETE", path: "/api/v1/consents/:kind", auth: "user", handler: deleteConsent },
];
