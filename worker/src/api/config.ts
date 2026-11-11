// GET /api/v1/config (capabilities, public flags, announcements, plans, legal) and /health.
import type { Env } from "../env";
import { json } from "../lib/edge";
import { emailConfigured } from "../lib/email";
import { flagOn, loadFlags, PUBLIC_FLAGS, type FlagRow } from "../lib/flags";
import { nowIso } from "../lib/db";
import { LEGAL, PLANS } from "../lib/plans";
import type { Ctx, RouteDef } from "./context";

export interface Capabilities {
  emailDelivery: boolean;
  devCodes: boolean;
  googleSignIn: boolean;
  turnstile: boolean;
  payments: boolean;
  paymentProviders: ("razorpay" | "stripe")[];
  adminConfigured: boolean;
  liveData: boolean;
  extensionLinking: boolean;
  signups: boolean;
}

export function razorpayConfigured(env: Env): boolean {
  return !!(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET && env.RAZORPAY_WEBHOOK_SECRET);
}

export function stripeConfigured(env: Env): boolean {
  return !!(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
}

export function turnstileConfigured(env: Env): boolean {
  return !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET);
}

export function googleConfigured(env: Env): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

/** Dev codes are only ever used when there is NO email provider. */
export function devCodesActive(env: Env): boolean {
  return !emailConfigured(env) && env.AUTH_DEV_CODES === "on";
}

export function capabilities(env: Env, flags: Record<string, FlagRow>): Capabilities {
  const providers: ("razorpay" | "stripe")[] = [];
  if (razorpayConfigured(env)) providers.push("razorpay");
  if (stripeConfigured(env)) providers.push("stripe");
  return {
    emailDelivery: emailConfigured(env),
    devCodes: devCodesActive(env),
    googleSignIn: googleConfigured(env),
    turnstile: turnstileConfigured(env),
    payments: providers.length > 0,
    paymentProviders: providers,
    adminConfigured: !!env.ADMIN_PASSWORD,
    liveData: flagOn(flags, "live_data"),
    extensionLinking: flagOn(flags, "extension_linking"),
    signups: flagOn(flags, "signups"),
  };
}

async function getConfig(c: Ctx): Promise<Response> {
  const now = nowIso();
  const [flags, ann] = await Promise.all([
    loadFlags(c.env),
    c.env.DB.prepare(
      `SELECT id, level, message, link, starts_at, ends_at FROM announcements
       WHERE active = 1 AND (starts_at IS NULL OR starts_at <= ?1) AND (ends_at IS NULL OR ends_at > ?1)
       ORDER BY CASE level WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC LIMIT 5`,
    )
      .bind(now)
      .all<{ id: string; level: string; message: string; link: string | null; starts_at: string | null; ends_at: string | null }>(),
  ]);
  const publicFlags: Record<string, boolean> = {};
  for (const k of PUBLIC_FLAGS) publicFlags[k] = flagOn(flags, k);
  return json(
    {
      appEnv: c.env.APP_ENV ?? "production",
      capabilities: capabilities(c.env, flags),
      turnstileSiteKey: turnstileConfigured(c.env) ? (c.env.TURNSTILE_SITE_KEY as string) : null,
      flags: publicFlags,
      announcements: (ann.results ?? []).map((a) => ({ id: a.id, level: a.level, message: a.message, link: a.link, startsAt: a.starts_at, endsAt: a.ends_at })),
      plans: PLANS.map((p) => ({ id: p.id, name: p.name, priceUsdCents: p.priceUsdCents, priceInrPaise: p.priceInrPaise, features: p.features, limits: p.limits })),
      legal: { ...LEGAL },
      engine: { version: "v0", calibrated: false },
    },
    { "cache-control": "public, max-age=30" },
  );
}

async function health(c: Ctx): Promise<Response> {
  let db: "ok" | "error" = "ok";
  try {
    await c.env.DB.prepare("SELECT 1 AS ok").first();
  } catch {
    db = "error";
  }
  return json({ ok: db === "ok", db, time: nowIso() }, {}, db === "ok" ? 200 : 503);
}

export const configRoutes: RouteDef[] = [
  { method: "GET", path: "/api/v1/config", auth: "none", cors: true, handler: getConfig },
  { method: "GET", path: "/api/v1/health", auth: "none", cors: true, handler: health },
];
