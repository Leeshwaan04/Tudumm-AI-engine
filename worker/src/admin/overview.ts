// GET /api/admin/overview?days=30 — KPIs, top instruments, funnel, weekly retention.
// All SQL aggregates in ONE D1 batch, every scan bounded by the `days` window (max 90).
import { json } from "../lib/edge";
import { intParam } from "../lib/validate";
import type { Ctx, RouteDef } from "../api/context";
import { requireAdmin } from "../api/context";

type R = Record<string, unknown>;

async function overview(c: Ctx): Promise<Response> {
  requireAdmin(c);
  const days = intParam(c.url.searchParams.get("days"), 30, 1, 90);
  const now = Date.now();
  const iso = (ms: number) => new Date(now - ms).toISOString();
  const since = iso(days * 86_400_000);
  const d1 = iso(86_400_000);
  const d7 = iso(7 * 86_400_000);
  const d30 = iso(30 * 86_400_000);
  const nowS = new Date(now).toISOString();
  const db = c.env.DB;
  const active = `(SELECT user_id AS uid FROM events WHERE created_at >= ?1 AND user_id IS NOT NULL
                   UNION SELECT user_id FROM sessions WHERE last_used_at >= ?1)`;
  const guests = "SELECT COUNT(DISTINCT anon_id) AS n FROM events WHERE created_at >= ?1 AND user_id IS NULL AND anon_id IS NOT NULL";
  const effPlan = "CASE WHEN plan <> 'free' AND (plan_expires_at IS NULL OR plan_expires_at > ?1) THEN plan ELSE 'free' END";

  const res = await db.batch([
    /* 0 */ db.prepare("SELECT COUNT(*) AS n FROM users WHERE status <> 'deleted'"),
    /* 1 */ db.prepare("SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM users WHERE created_at >= ?1 GROUP BY day ORDER BY day").bind(since),
    /* 2 */ db.prepare(`SELECT COUNT(*) AS n FROM ${active}`).bind(d1),
    /* 3 */ db.prepare(`SELECT COUNT(*) AS n FROM ${active}`).bind(d7),
    /* 4 */ db.prepare(`SELECT COUNT(*) AS n FROM ${active}`).bind(d30),
    /* 5 */ db.prepare(guests).bind(d1),
    /* 6 */ db.prepare(guests).bind(d7),
    /* 7 */ db.prepare(guests).bind(d30),
    /* 8 */ db.prepare("SELECT COUNT(*) AS n FROM profiles p JOIN users u ON u.id = p.user_id WHERE p.onboarded = 1 AND u.status <> 'deleted'"),
    /* 9 */ db.prepare(`SELECT ${effPlan} AS plan, COUNT(*) AS n FROM users WHERE status <> 'deleted' GROUP BY 1`).bind(nowS),
    /* 10 */ db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE active = 1"),
    /* 11 */ db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS users FROM tracked"),
    /* 12 */ db
      .prepare("SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE kind = 'extension' AND revoked_at IS NULL AND expires_at > ?1")
      .bind(nowS),
    /* 13 */ db.prepare("SELECT COUNT(*) AS n FROM support_tickets WHERE status IN ('open', 'pending')"),
    /* 14 */ db
      .prepare(
        `SELECT json_extract(props, '$.symbol') AS symbol, COUNT(*) AS views, COUNT(DISTINCT COALESCE(user_id, anon_id)) AS viewers
         FROM events WHERE name = 'instrument_view' AND created_at >= ?1 AND json_valid(props) AND json_extract(props, '$.symbol') IS NOT NULL
         GROUP BY 1 ORDER BY views DESC LIMIT 10`,
      )
      .bind(since),
    /* 15 */ db
      .prepare(
        `SELECT
           (SELECT COUNT(DISTINCT COALESCE(user_id, anon_id)) FROM events WHERE name = 'signup_start' AND created_at >= ?1) AS signup_start,
           (SELECT COUNT(DISTINCT user_id) FROM events WHERE name = 'login' AND created_at >= ?1 AND user_id IS NOT NULL) AS login,
           (SELECT COUNT(DISTINCT user_id) FROM events WHERE name = 'onboarding_complete' AND created_at >= ?1 AND user_id IS NOT NULL) AS onboarding_complete,
           (SELECT COUNT(*) FROM (SELECT user_id FROM tracked WHERE added_at >= ?1
                                  UNION SELECT user_id FROM events WHERE name = 'track_toggle' AND created_at >= ?1 AND user_id IS NOT NULL)) AS first_track`,
      )
      .bind(since),
    /* 16 */ db
      .prepare(
        // cohort = Monday of the signup week; week index = whole weeks between signup and activity.
        `SELECT date(u.created_at, '-' || ((CAST(strftime('%w', u.created_at) AS INTEGER) + 6) % 7) || ' days') AS cohort,
                CAST((julianday(e.created_at) - julianday(u.created_at)) / 7 AS INTEGER) AS week,
                COUNT(DISTINCT e.user_id) AS users
         FROM users u JOIN events e ON e.user_id = u.id AND e.created_at >= u.created_at
         WHERE u.created_at >= ?1 AND e.created_at >= ?1
         GROUP BY cohort, week ORDER BY cohort, week LIMIT 500`,
      )
      .bind(since),
    /* 17 */ db
      .prepare(
        `SELECT date(created_at, '-' || ((CAST(strftime('%w', created_at) AS INTEGER) + 6) % 7) || ' days') AS cohort, COUNT(*) AS size
         FROM users WHERE created_at >= ?1 GROUP BY cohort ORDER BY cohort`,
      )
      .bind(since),
    /* 18 */ db.prepare("SELECT COUNT(*) AS n FROM users WHERE created_at >= ?1").bind(since),
  ]);
  const rows = (i: number) => (res[i]?.results ?? []) as R[];
  const n = (i: number, k = "n") => Number(rows(i)[0]?.[k] ?? 0);

  const totalUsers = n(0);
  const planMix: Record<string, number> = { free: 0, pro: 0, elite: 0 };
  for (const r of rows(9)) planMix[String(r.plan)] = Number(r.n);
  const paid = (planMix.pro ?? 0) + (planMix.elite ?? 0);

  const sizes = new Map(rows(17).map((r) => [String(r.cohort), Number(r.size)]));
  const cohorts = new Map<string, number[]>();
  for (const r of rows(16)) {
    const k = String(r.cohort);
    const arr = cohorts.get(k) ?? [];
    arr[Number(r.week)] = Number(r.users);
    cohorts.set(k, arr);
  }
  const retention = [...sizes.entries()].map(([cohort, size]) => {
    const weeks = cohorts.get(cohort) ?? [];
    const len = Math.max(1, weeks.length);
    return { cohort, size, weeks: Array.from({ length: len }, (_, i) => weeks[i] ?? 0) };
  });

  const f = rows(15)[0] ?? {};
  return json({
    days,
    since,
    kpis: {
      totalUsers,
      newUsers: n(18),
      newUsersPerDay: rows(1).map((r) => ({ day: r.day, n: Number(r.n) })),
      dau: { users: n(2), guests: n(5) },
      wau: { users: n(3), guests: n(6) },
      mau: { users: n(4), guests: n(7) },
      onboardingCompletionRate: totalUsers ? n(8) / totalUsers : 0,
      paidShare: totalUsers ? paid / totalUsers : 0,
      planMix,
      activeAlerts: n(10),
      trackedSignals: n(11),
      trackingUsers: n(11, "users"),
      extensionLinkedUsers: n(12),
      openTickets: n(13),
    },
    topInstruments: rows(14).map((r) => ({ symbol: r.symbol, views: Number(r.views), viewers: Number(r.viewers) })),
    funnel: [
      { step: "signup_start", actors: Number(f.signup_start ?? 0) },
      { step: "login", actors: Number(f.login ?? 0) },
      { step: "onboarding_complete", actors: Number(f.onboarding_complete ?? 0) },
      { step: "first_track", actors: Number(f.first_track ?? 0) },
    ],
    retention,
    notes: "DAU/WAU/MAU = distinct signed-in users with an event or session use in the window; guests = distinct anonIds without an account.",
  });
}

export const adminOverviewRoutes: RouteDef[] = [{ method: "GET", path: "/api/admin/overview", auth: "admin", handler: overview }];
