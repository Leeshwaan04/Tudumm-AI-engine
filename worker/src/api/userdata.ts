// Shared user-data helpers: profile mapping/validation, user creation, server-side events.
import type { Env } from "../env";
import { all, first, newId, nowIso, parseJson } from "../lib/db";
import { clientCountry, clientDevice, HttpError } from "../lib/http";
import { isFlagOn } from "../lib/flags";
import { USER_COLS, type UserRow } from "../lib/session";
import { invalid } from "../lib/validate";
import { REQUIRED_CONSENTS } from "../lib/plans";

export const PERSONAS = ["intraday", "swing", "options", "investor"] as const;
export type Persona = (typeof PERSONAS)[number];
export const MARKETS = ["IN", "US", "EU", "CRYPTO", "FX", "CMDTY"] as const;
export const CURRENCIES = ["INR", "USD", "EUR", "USDT", "JPY"] as const;

export interface Profile {
  persona: Persona;
  markets: string[];
  capital: number;
  currency: (typeof CURRENCIES)[number];
  riskPct: number;
  onboarded: boolean;
  updatedAt: string | null;
}

export const DEFAULT_PROFILE: Omit<Profile, "updatedAt"> = {
  persona: "swing",
  markets: [...MARKETS],
  capital: 500000,
  currency: "INR",
  riskPct: 1,
  onboarded: false,
};

interface ProfileRow {
  persona: Persona;
  markets: string;
  capital: number;
  currency: Profile["currency"];
  risk_pct: number;
  onboarded: number;
  updated_at: string;
}

export function mapProfile(r: ProfileRow | null): Profile | null {
  if (!r) return null;
  return {
    persona: r.persona,
    markets: parseJson<string[]>(r.markets, []),
    capital: r.capital,
    currency: r.currency,
    riskPct: r.risk_pct,
    onboarded: r.onboarded === 1,
    updatedAt: r.updated_at,
  };
}

export async function getProfile(env: Env, userId: string): Promise<Profile | null> {
  return mapProfile(
    await first<ProfileRow>(env, "SELECT persona, markets, capital, currency, risk_pct, onboarded, updated_at FROM profiles WHERE user_id = ?", userId),
  );
}

/** "scalper" is the v0.1 web app's id for the intraday persona; accept it as an alias. */
function normPersona(v: unknown): unknown {
  return v === "scalper" ? "intraday" : v;
}

/**
 * Validate a profile patch. strict=true (PUT): bad values => 400. strict=false (guest sync):
 * bad values are dropped/clamped so a stale localStorage blob never blocks login.
 */
export function validateProfilePatch(input: unknown, strict: boolean): Partial<Omit<Profile, "updatedAt">> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    if (strict) throw invalid("profile", "must be an object");
    return {};
  }
  const o = input as Record<string, unknown>;
  const out: Partial<Omit<Profile, "updatedAt">> = {};
  const fail = (field: string, msg: string) => {
    if (strict) throw invalid(field, msg);
  };
  if (o.persona !== undefined) {
    const p = normPersona(o.persona);
    if ((PERSONAS as readonly unknown[]).includes(p)) out.persona = p as Persona;
    else fail("persona", `must be one of: ${PERSONAS.join(", ")}`);
  }
  if (o.markets !== undefined) {
    if (Array.isArray(o.markets) && o.markets.length <= 12) {
      const m = [...new Set(o.markets.filter((x): x is string => typeof x === "string" && (MARKETS as readonly string[]).includes(x)))];
      if (m.length && (!strict || m.length === o.markets.length)) out.markets = m;
      else fail("markets", `must be a non-empty array of: ${MARKETS.join(", ")}`);
    } else fail("markets", "must be an array");
  }
  if (o.capital !== undefined) {
    if (typeof o.capital === "number" && Number.isFinite(o.capital) && o.capital > 0 && o.capital <= 1e12) out.capital = o.capital;
    else fail("capital", "must be a number > 0 and <= 1e12");
  }
  if (o.currency !== undefined) {
    if ((CURRENCIES as readonly unknown[]).includes(o.currency)) out.currency = o.currency as Profile["currency"];
    else fail("currency", `must be one of: ${CURRENCIES.join(", ")}`);
  }
  if (o.riskPct !== undefined) {
    if (typeof o.riskPct === "number" && Number.isFinite(o.riskPct) && o.riskPct >= 0.1 && o.riskPct <= 5) out.riskPct = o.riskPct;
    else if (!strict && typeof o.riskPct === "number" && Number.isFinite(o.riskPct) && o.riskPct > 0) out.riskPct = Math.min(5, Math.max(0.1, o.riskPct));
    else fail("riskPct", "must be between 0.1 and 5");
  }
  if (o.onboarded !== undefined) {
    if (typeof o.onboarded === "boolean") out.onboarded = o.onboarded;
    else fail("onboarded", "must be true or false");
  }
  return out;
}

export function upsertProfileStmt(env: Env, userId: string, p: Omit<Profile, "updatedAt">): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO profiles (user_id, persona, markets, capital, currency, risk_pct, onboarded, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT (user_id) DO UPDATE SET persona = ?2, markets = ?3, capital = ?4, currency = ?5, risk_pct = ?6, onboarded = ?7, updated_at = ?8`,
  ).bind(userId, p.persona, JSON.stringify(p.markets), p.capital, p.currency, p.riskPct, p.onboarded ? 1 : 0, nowIso());
}

export async function getUser(env: Env, id: string): Promise<UserRow | null> {
  return first<UserRow>(env, `SELECT ${USER_COLS} FROM users u WHERE u.id = ?`, id);
}

/**
 * Find a user by email or create one. A dev-code login can never upgrade email_verified; an
 * email/Google login sets it to 1. Throws 403 for suspended accounts or closed signups.
 */
export async function findOrCreateUser(
  env: Env,
  request: Request,
  email: string,
  verified: boolean,
): Promise<{ user: UserRow; isNew: boolean }> {
  const existing = await first<UserRow>(env, `SELECT ${USER_COLS} FROM users u WHERE u.email = ?`, email);
  if (existing) {
    if (existing.status === "suspended") throw new HttpError(403, "account_suspended");
    if (existing.status === "deleted") throw new HttpError(403, "account_unavailable");
    // UAT dev codes prove nothing about mailbox ownership, so they can never open an account
    // whose email was verified by real delivery (email OTP or Google).
    if (!verified && existing.email_verified === 1) throw new HttpError(403, "email_verification_required");
    if (verified && existing.email_verified !== 1) {
      await env.DB.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").bind(existing.id).run();
      existing.email_verified = 1;
    }
    return { user: existing, isNew: false };
  }
  if (!(await isFlagOn(env, "signups"))) throw new HttpError(403, "signups_closed");
  const id = newId();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (id, email, email_verified, status, plan, plan_source, created_at, last_seen_at, country) VALUES (?, ?, ?, 'active', 'free', 'default', ?, ?, ?)",
  )
    .bind(id, email, verified ? 1 : 0, nowIso(), nowIso(), clientCountry(request))
    .run();
  const created = await first<UserRow>(env, `SELECT ${USER_COLS} FROM users u WHERE u.email = ?`, email);
  if (!created) throw new HttpError(500, "user_create_failed");
  return { user: created, isNew: created.id === id };
}

/** Server-side activity event (login/logout/extension_link) — same table as client events. */
export function serverEventStmt(
  env: Env,
  request: Request,
  userId: string | null,
  name: string,
  props: Record<string, unknown> | null,
  source: "web" | "extension" = "web",
): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT INTO events (id, user_id, anon_id, name, props, path, created_at, country, device, source) VALUES (?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?)",
  ).bind(newId(), userId, name, props ? JSON.stringify(props) : null, nowIso(), clientCountry(request), clientDevice(request), source);
}

export interface ConsentView {
  kind: string;
  version: string;
  acceptedAt: string;
  withdrawnAt: string | null;
}

export async function getConsents(env: Env, userId: string): Promise<{ items: ConsentView[]; pending: { kind: string; version: string }[] }> {
  const rows = await all<{ kind: string; version: string; accepted_at: string; withdrawn_at: string | null }>(
    env,
    "SELECT kind, version, accepted_at, withdrawn_at FROM consents WHERE user_id = ? ORDER BY accepted_at DESC LIMIT 200",
    userId,
  );
  const items = rows.map((r) => ({ kind: r.kind, version: r.version, acceptedAt: r.accepted_at, withdrawnAt: r.withdrawn_at }));
  const pending = REQUIRED_CONSENTS.filter((req) => !items.some((i) => i.kind === req.kind && i.version === req.version && !i.withdrawnAt));
  return { items, pending };
}
