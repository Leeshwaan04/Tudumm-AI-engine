// Response shapes of /api/admin/* as implemented in worker/src/admin/*.ts (read-only contract).

export interface Capabilities {
  emailDelivery: boolean;
  devCodes: boolean;
  googleSignIn: boolean;
  turnstile: boolean;
  payments: boolean;
  paymentProviders?: string[];
  adminConfigured: boolean;
  liveData: boolean;
  extensionLinking: boolean;
  signups?: boolean;
}

export interface AdminMe {
  ok: boolean;
  actor: string;
  sessionId: string;
  expiresAt: string;
  capabilities: Capabilities;
}

export interface PublicConfig {
  appEnv: string;
  capabilities: Capabilities;
}

export interface Overview {
  days: number;
  since: string;
  kpis: {
    totalUsers: number;
    newUsers: number;
    newUsersPerDay: { day: string; n: number }[];
    dau: { users: number; guests: number };
    wau: { users: number; guests: number };
    mau: { users: number; guests: number };
    onboardingCompletionRate: number;
    paidShare: number;
    planMix: Record<string, number>;
    activeAlerts: number;
    trackedSignals: number;
    trackingUsers: number;
    extensionLinkedUsers: number;
    openTickets: number;
  };
  topInstruments: { symbol: string; views: number; viewers: number }[];
  funnel: { step: string; actors: number }[];
  retention: { cohort: string; size: number; weeks: number[] }[];
  notes?: string;
}

export type UserStatus = "active" | "suspended" | "deleted";
export type PlanId = "free" | "pro" | "elite";

export interface AdminUser {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  status: UserStatus;
  plan: PlanId;
  planSource: string;
  planExpiresAt: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  country: string | null;
  marketingOptIn: boolean;
}

export interface UsersPage {
  items: AdminUser[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TicketMessage {
  author: string;
  body: string;
  createdAt: string;
}

export interface Ticket {
  id: string;
  userId: string | null;
  email: string;
  category: string;
  subject: string;
  body: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  messages?: TicketMessage[];
}

export interface EventItem {
  id: string;
  userId?: string | null;
  anonId?: string | null;
  name: string;
  props: unknown;
  path: string | null;
  at: string;
  country: string | null;
  device: string | null;
  source: string | null;
}

export interface UserDetail {
  user: AdminUser;
  rawPlan: { plan: string; source: string; expiresAt: string | null };
  profile: {
    persona: string;
    markets: string[];
    capital: number;
    currency: string;
    riskPct: number;
    onboarded: boolean;
    updatedAt: string | null;
  } | null;
  consents: { kind: string; version: string; acceptedAt: string; withdrawnAt: string | null }[];
  pendingConsents: { kind: string; version: string }[];
  sessions: { id: string; kind: string; userAgent: string | null; createdAt: string; lastUsedAt: string | null; expiresAt: string; revokedAt: string | null }[];
  watchlist: { symbol: string; addedAt: string }[];
  tracked: { symbol: string; signalId: string | null; addedAt: string }[];
  alerts: { id: string; symbol: string; kind: string; threshold: number | null; oneShot: boolean; active: boolean; createdAt: string; lastTriggeredAt: string | null }[];
  tickets: Ticket[];
  timeline: EventItem[];
  notes: { id: string; body: string; actor: string; createdAt: string }[];
  payments: Record<string, unknown>[];
}

export interface AuditItem {
  id: string;
  actor: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: unknown;
  at: string;
}

export interface AuditPage {
  items: AuditItem[];
  page: number;
  hasMore: boolean;
}

export interface EventsPage {
  items: EventItem[];
  page: number;
  limit: number;
  hasMore: boolean;
}

export interface FlagRow {
  key: string;
  enabled: boolean;
  value: unknown;
  updatedAt: string | null;
  updatedBy: string;
}

export interface Announcement {
  id: string;
  level: "info" | "warning" | "critical";
  message: string;
  link: string | null;
  startsAt: string | null;
  endsAt: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string | null;
}

export interface Compliance {
  consents: { kind: string; version: string; total: number; active: number; withdrawn: number }[];
  dataRequests: {
    pending: { id: string; user_id: string | null; kind: string; status: string; created_at: string }[];
    last30Days: { kind: string; n: number }[];
  };
  grievances: {
    olderThan7Days: number;
    olderThan21Days: number;
    items: { id: string; user_id: string | null; email: string; subject: string; status: string; created_at: string; overdue21: boolean }[];
  };
  notes?: string;
}

export interface DevOutboxItem {
  email: string;
  code: string;
  createdAt: string;
  expiresAt: string;
  state: "valid" | "expired" | "used_or_replaced" | string;
  attempts: number;
}

/* ---- engine (worker/src/market/types.ts) ---- */
export type SignalStatus = "pending" | "active" | "t1_hit" | "sit_out" | "closed" | "held" | "invalidated";

export interface SourceHealth {
  source: string;
  ok: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  staleSeconds: number | null;
  freshness: "realtime" | "delayed-15m" | "eod" | "daily-ref" | string;
  /** Optional extension some engines may add. */
  stale?: boolean;
}

export interface EngineHealth {
  sources: SourceHealth[];
  lastRunAt: string | null;
  liveSignals: number;
  ledgerEntries: number;
}

export interface AdminSignalRow {
  id: string;
  symbol: string;
  market: string;
  status: SignalStatus;
  direction: "LONG" | "SHORT" | null;
  strategy: string | null;
  confidence: number | null;
  issuedAt: string;
  updatedAt: string;
  held: boolean;
}

export interface StrategyRow {
  strategy: string;
  market: string;
  enabled: boolean;
  signals: number;
  closed: number;
  winRate: number | null;
  avgR: number | null;
}

export interface LedgerHead {
  count: number;
  headSeq: number;
  headHash: string;
  asOf: string | null;
}
