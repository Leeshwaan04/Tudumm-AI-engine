// Shapes returned by the Tudumm Worker (worker/src/api/*). Where the spec and the code differ,
// these follow the code.

export interface Capabilities {
  emailDelivery: boolean;
  devCodes: boolean;
  googleSignIn: boolean;
  turnstile: boolean;
  payments: boolean;
  paymentProviders?: ("razorpay" | "stripe")[];
  adminConfigured: boolean;
  liveData: boolean;
  extensionLinking: boolean;
  signups?: boolean;
}

export interface Announcement {
  id: string;
  level: "info" | "warning" | "critical";
  message: string;
  link: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
}

export interface PlanDef {
  id: "free" | "pro" | "elite";
  name: string;
  priceUsdCents: number;
  priceInrPaise: number;
  features: string[];
  limits?: { alerts: number };
}

export interface AppConfig {
  appEnv: string;
  capabilities: Capabilities;
  turnstileSiteKey: string | null;
  flags: Record<string, boolean>;
  announcements: Announcement[];
  plans: PlanDef[];
  legal: { termsVersion: string; riskVersion: string; privacyVersion: string };
  engine?: { version: string; calibrated: boolean };
}

export interface User {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  status: "active" | "suspended" | "deleted";
  plan: "free" | "pro" | "elite";
  planSource: string;
  planExpiresAt: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  country: string | null;
  marketingOptIn: boolean;
}

export interface ServerProfile {
  persona: "intraday" | "swing" | "options" | "investor";
  markets: string[];
  capital: number;
  currency: "INR" | "USD" | "EUR" | "USDT" | "JPY";
  riskPct: number;
  onboarded: boolean;
  updatedAt: string | null;
}

export interface Consent {
  kind: "terms" | "risk_disclosure" | "privacy" | "marketing";
  version: string;
  acceptedAt: string;
  withdrawnAt: string | null;
}

export interface PlanInfo {
  id: "free" | "pro" | "elite";
  name: string;
  features: string[];
  limits: { alerts: number };
  expiresAt: string | null;
  source: string;
}

export interface Me {
  user: User;
  profile: ServerProfile | null;
  consents: Consent[];
  pendingConsents: { kind: string; version: string }[];
  plan: PlanInfo;
  counts: { watchlist: number; tracked: number; alerts: number; unread: number };
  session?: { id?: string; kind?: string; expiresAt?: string };
}

export interface AuthStartResult {
  sent: boolean;
  devMode?: boolean;
  devCode?: string;
  expiresIn: number;
  notice?: string;
}

export interface AuthVerifyResult {
  user: User;
  profile: ServerProfile | null;
  isNew: boolean;
}

export interface SessionRow {
  id: string;
  kind: "web" | "extension";
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  current: boolean;
}

export interface ListView {
  symbols: string[];
  items: { symbol: string; addedAt?: string; signalId?: string | null }[];
}

export interface Alert {
  id: string;
  symbol: string;
  kind: "price_above" | "price_below" | "new_signal" | "signal_update";
  threshold: number | null;
  oneShot: boolean;
  active: boolean;
  createdAt: string;
  lastTriggeredAt: string | null;
}

export interface Notification {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface TicketMessage {
  author: "user" | "admin";
  body: string;
  createdAt: string;
}

export interface Ticket {
  id: string;
  email: string;
  category: string;
  subject: string;
  body: string;
  status: "open" | "pending" | "resolved" | "closed";
  createdAt: string;
  updatedAt: string;
  messages: TicketMessage[];
}

export interface BillingState {
  enabled: boolean;
  reason?: string;
  providers: string[];
  razorpayKeyId?: string | null;
  current: { plan: string; expiresAt: string | null; source: string } | null;
}
