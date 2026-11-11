// Plans, legal document versions and plan resolution. Prices mirror the landing page (USD);
// INR prices are placeholders until the owner confirms local pricing.

export type PlanId = "free" | "pro" | "elite";
export const PLAN_IDS: readonly PlanId[] = ["free", "pro", "elite"];

export interface Plan {
  id: PlanId;
  name: string;
  priceUsdCents: number; // per month
  priceInrPaise: number; // per month
  features: string[];
  limits: { alerts: number };
}

export const PLANS: Plan[] = [
  {
    id: "free",
    name: "Free",
    priceUsdCents: 0,
    priceInrPaise: 0,
    features: ["Every sit-out, with the reason", "3 live calls a day, one market", "The public ledger and chain check", "Extension chip on supported sites"],
    limits: { alerts: 50 },
  },
  {
    id: "pro",
    name: "Pro",
    priceUsdCents: 2400,
    priceInrPaise: 199900,
    features: ["All live calls across all six markets", "Full five-layer evidence and position sizer", "Extension side panel and watchlist", "Signal and price alerts"],
    limits: { alerts: 500 },
  },
  {
    id: "elite",
    name: "Elite",
    priceUsdCents: 6900,
    priceInrPaise: 549900,
    features: ["Everything in Pro", "Raw layer scores and history export", "API and webhooks (at launch)", "Early access to new instruments"],
    limits: { alerts: 500 },
  },
];

export const PLAN_BY_ID: Record<PlanId, Plan> = Object.fromEntries(PLANS.map((p) => [p.id, p])) as Record<PlanId, Plan>;

/** Paid plans last this long per successful payment. */
export const PLAN_PERIOD_MS = 30 * 86_400_000;

export const LEGAL = {
  termsVersion: "2026-11-10",
  riskVersion: "2026-11-10",
  privacyVersion: "2026-11-10",
} as const;

export const CONSENT_KINDS = ["terms", "risk_disclosure", "privacy", "marketing"] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];

/** Consents a user must hold at the CURRENT version to use the terminal. */
export const REQUIRED_CONSENTS: { kind: ConsentKind; version: string }[] = [
  { kind: "terms", version: LEGAL.termsVersion },
  { kind: "risk_disclosure", version: LEGAL.riskVersion },
  { kind: "privacy", version: LEGAL.privacyVersion },
];

/** The plan a user actually has right now (an expired paid plan falls back to free). */
export function effectivePlan(plan: unknown, expiresAt: unknown, now = Date.now()): PlanId {
  const p = PLAN_IDS.includes(plan as PlanId) ? (plan as PlanId) : "free";
  if (p === "free") return "free";
  if (typeof expiresAt === "string" && expiresAt && Date.parse(expiresAt) <= now) return "free";
  return p;
}
