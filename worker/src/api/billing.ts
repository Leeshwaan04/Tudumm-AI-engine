// Billing — capability-gated. Without provider keys every route reports itself unavailable (503)
// and plans can still be granted by an admin. With keys:
//   POST /api/v1/billing/checkout {plan, provider}  -> Razorpay order or Stripe Checkout session
//   POST /api/v1/billing/webhook/razorpay           -> X-Razorpay-Signature HMAC-SHA256(body)
//   POST /api/v1/billing/webhook/stripe             -> Stripe-Signature t=..,v1=HMAC(t.body), 5-min tolerance
// The webhook (never the browser) is the source of truth for the plan change.
import type { Env } from "../env";
import { auditStmt } from "../lib/audit";
import { constantTimeEqual, hmacHex } from "../lib/crypto";
import { json } from "../lib/edge";
import { first, newId, nowIso } from "../lib/db";
import { HttpError, readJsonObject, readTextBounded } from "../lib/http";
import { logError } from "../lib/log";
import { enforce } from "../lib/ratelimit";
import { effectivePlan, PLAN_BY_ID, PLAN_PERIOD_MS, PLANS, type PlanId } from "../lib/plans";
import * as v from "../lib/validate";
import { razorpayConfigured, stripeConfigured } from "./config";
import type { Ctx, RouteDef } from "./context";
import { requireUser } from "./context";

const PAID: readonly PlanId[] = ["pro", "elite"];

async function getBilling(c: Ctx): Promise<Response> {
  const providers: string[] = [];
  if (razorpayConfigured(c.env)) providers.push("razorpay");
  if (stripeConfigured(c.env)) providers.push("stripe");
  const current = c.user
    ? { plan: effectivePlan(c.user.plan, c.user.plan_expires_at), expiresAt: c.user.plan_expires_at, source: c.user.plan_source }
    : null;
  if (!providers.length) {
    return json({
      enabled: false,
      reason: "Payments aren't switched on yet. Paid plans can be granted by the Tudumm team during UAT.",
      providers: [],
      current,
    });
  }
  return json({
    enabled: true,
    providers,
    razorpayKeyId: razorpayConfigured(c.env) ? c.env.RAZORPAY_KEY_ID : null,
    plans: PLANS.filter((p) => p.id !== "free").map((p) => ({ id: p.id, name: p.name, priceUsdCents: p.priceUsdCents, priceInrPaise: p.priceInrPaise })),
    current,
  });
}

async function checkout(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const body = await readJsonObject(c.req, 2048);
  const plan = v.oneOf(body.plan, "plan", PAID);
  const provider = v.oneOf(body.provider, "provider", ["razorpay", "stripe"] as const);
  if (provider === "razorpay" && !razorpayConfigured(c.env)) throw new HttpError(503, "billing_unavailable", { provider });
  if (provider === "stripe" && !stripeConfigured(c.env)) throw new HttpError(503, "billing_unavailable", { provider });
  await enforce(c.env, `checkout:${user.id}`, 10, 3600);
  const p = PLAN_BY_ID[plan];

  if (provider === "razorpay") {
    const res = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${c.env.RAZORPAY_KEY_ID}:${c.env.RAZORPAY_KEY_SECRET}`)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ amount: p.priceInrPaise, currency: "INR", receipt: newId().slice(0, 36), notes: { userId: user.id, plan } }),
      signal: AbortSignal.timeout(8000),
    }).catch((err) => {
      logError("billing.razorpay.order", err);
      return null;
    });
    if (!res || !res.ok) throw new HttpError(502, "billing_provider_error", { provider });
    const order = (await res.json()) as { id?: string; amount?: number; currency?: string };
    if (!order.id) throw new HttpError(502, "billing_provider_error", { provider });
    return json({ provider, orderId: order.id, amount: order.amount, currency: order.currency, keyId: c.env.RAZORPAY_KEY_ID, plan, notes: { userId: user.id, plan } });
  }

  const origin = c.url.origin;
  const form = new URLSearchParams({
    mode: "payment",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(p.priceUsdCents),
    "line_items[0][price_data][product_data][name]": `Tudumm ${p.name} (30 days)`,
    "line_items[0][quantity]": "1",
    success_url: `${origin}/app/profile?billing=success`,
    cancel_url: `${origin}/app/profile?billing=cancelled`,
    client_reference_id: user.id,
    "metadata[userId]": user.id,
    "metadata[plan]": plan,
  });
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}`, "content-type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(8000),
  }).catch((err) => {
    logError("billing.stripe.session", err);
    return null;
  });
  if (!res || !res.ok) throw new HttpError(502, "billing_provider_error", { provider });
  const session = (await res.json()) as { id?: string; url?: string };
  if (!session.url) throw new HttpError(502, "billing_provider_error", { provider });
  return json({ provider, sessionId: session.id, url: session.url, plan });
}

/** Record the payment idempotently and extend the plan. Returns false when it was a duplicate. */
async function applyPayment(
  env: Env,
  p: { provider: "razorpay" | "stripe"; ref: string; userId: string; plan: PlanId; amountMinor: number; currency: string; raw: Record<string, unknown> },
): Promise<boolean> {
  const user = await first<{ id: string; plan: string; plan_expires_at: string | null; status: string }>(
    env,
    "SELECT id, plan, plan_expires_at, status FROM users WHERE id = ?",
    p.userId,
  );
  const ins = await env.DB.prepare(
    "INSERT OR IGNORE INTO payments (id, user_id, provider, provider_ref, amount_minor, currency, plan, status, created_at, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(newId(), user ? p.userId : null, p.provider, p.ref, p.amountMinor, p.currency, p.plan, user ? "captured" : "orphaned", nowIso(), JSON.stringify(p.raw).slice(0, 4000))
    .run();
  if (!Number(ins.meta?.changes ?? 0)) return false; // replayed webhook
  if (!user || user.status === "deleted") return true;
  // Extend from the current expiry when the same plan is still running.
  const base =
    user.plan === p.plan && user.plan_expires_at && Date.parse(user.plan_expires_at) > Date.now() ? Date.parse(user.plan_expires_at) : Date.now();
  const expires = new Date(base + PLAN_PERIOD_MS).toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET plan = ?, plan_source = 'billing', plan_expires_at = ? WHERE id = ?").bind(p.plan, expires, p.userId),
    auditStmt(env, `system:billing:${p.provider}`, "billing.plan_set", "user", p.userId, { plan: p.plan, expiresAt: expires, ref: p.ref }),
  ]);
  return true;
}

async function razorpayWebhook(c: Ctx): Promise<Response> {
  if (!razorpayConfigured(c.env)) throw new HttpError(503, "billing_unavailable", { provider: "razorpay" });
  const raw = await readTextBounded(c.req, 256 * 1024);
  const sig = c.req.headers.get("x-razorpay-signature") ?? "";
  const expected = await hmacHex(c.env.RAZORPAY_WEBHOOK_SECRET as string, raw);
  if (!sig || !constantTimeEqual(sig.toLowerCase(), expected)) throw new HttpError(401, "bad_signature");
  let evt: { event?: string; payload?: { payment?: { entity?: Record<string, unknown> }; order?: { entity?: Record<string, unknown> } } };
  try {
    evt = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "invalid_json");
  }
  if (evt.event !== "order.paid" && evt.event !== "payment.captured") return json({ ok: true, ignored: evt.event ?? null });
  const pay = evt.payload?.payment?.entity ?? {};
  const order = evt.payload?.order?.entity ?? {};
  // Razorpay sends notes as {} or [] — prefer the order's notes (set server-side at checkout).
  const pick = (n: unknown) => (n && typeof n === "object" && !Array.isArray(n) ? (n as Record<string, unknown>) : null);
  const notes = (pick(order.notes)?.plan ? pick(order.notes) : pick(pay.notes)) ?? {};
  const plan = notes.plan as PlanId;
  const userId = typeof notes.userId === "string" ? notes.userId : "";
  const amount = Number(pay.amount ?? order.amount_paid ?? 0);
  const currency = String(pay.currency ?? order.currency ?? "");
  const ref = String(pay.id ?? order.id ?? "");
  if (!PAID.includes(plan) || !v.UUID_RE.test(userId) || !ref) return json({ ok: true, ignored: "unrecognised_notes" });
  if (currency !== "INR" || amount < PLAN_BY_ID[plan].priceInrPaise) return json({ ok: true, ignored: "amount_mismatch" });
  const applied = await applyPayment(c.env, {
    provider: "razorpay",
    ref,
    userId,
    plan,
    amountMinor: amount,
    currency,
    raw: { event: evt.event, paymentId: pay.id ?? null, orderId: pay.order_id ?? order.id ?? null, method: pay.method ?? null },
  });
  return json({ ok: true, applied });
}

async function stripeWebhook(c: Ctx): Promise<Response> {
  if (!stripeConfigured(c.env)) throw new HttpError(503, "billing_unavailable", { provider: "stripe" });
  const raw = await readTextBounded(c.req, 256 * 1024);
  const header = c.req.headers.get("stripe-signature") ?? "";
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  ) as Record<string, string>;
  const t = Number(parts.t);
  const sigs = header
    .split(",")
    .map((kv) => kv.trim())
    .filter((kv) => kv.startsWith("v1="))
    .map((kv) => kv.slice(3));
  if (!Number.isFinite(t) || !sigs.length || Math.abs(Date.now() / 1000 - t) > 300) throw new HttpError(401, "bad_signature");
  const expected = await hmacHex(c.env.STRIPE_WEBHOOK_SECRET as string, `${parts.t}.${raw}`);
  if (!sigs.some((s) => constantTimeEqual(s, expected))) throw new HttpError(401, "bad_signature");
  let evt: { type?: string; data?: { object?: Record<string, unknown> } };
  try {
    evt = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "invalid_json");
  }
  if (evt.type !== "checkout.session.completed") return json({ ok: true, ignored: evt.type ?? null });
  const s = evt.data?.object ?? {};
  const meta = (s.metadata as Record<string, unknown>) ?? {};
  const plan = meta.plan as PlanId;
  const userId = typeof meta.userId === "string" ? meta.userId : typeof s.client_reference_id === "string" ? s.client_reference_id : "";
  const amount = Number(s.amount_total ?? 0);
  const currency = String(s.currency ?? "").toUpperCase();
  if (s.payment_status !== "paid") return json({ ok: true, ignored: "unpaid" });
  if (!PAID.includes(plan) || !v.UUID_RE.test(userId) || typeof s.id !== "string") return json({ ok: true, ignored: "unrecognised_metadata" });
  if (currency !== "USD" || amount < PLAN_BY_ID[plan].priceUsdCents) return json({ ok: true, ignored: "amount_mismatch" });
  const applied = await applyPayment(c.env, {
    provider: "stripe",
    ref: s.id,
    userId,
    plan,
    amountMinor: amount,
    currency,
    raw: { type: evt.type, sessionId: s.id, paymentIntent: s.payment_intent ?? null },
  });
  return json({ ok: true, applied });
}

export const billingRoutes: RouteDef[] = [
  { method: "GET", path: "/api/v1/billing", auth: "optional", handler: getBilling },
  { method: "POST", path: "/api/v1/billing/checkout", auth: "user", handler: checkout },
  { method: "POST", path: "/api/v1/billing/webhook/razorpay", auth: "none", csrf: "none", noWriteLimit: true, handler: razorpayWebhook },
  { method: "POST", path: "/api/v1/billing/webhook/stripe", auth: "none", csrf: "none", noWriteLimit: true, handler: stripeWebhook },
];
