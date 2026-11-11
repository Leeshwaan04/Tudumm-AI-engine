// One function per API route the web app uses. Grouped by area.
import { api } from "./client";
import type {
  Alert,
  AppConfig,
  AuthStartResult,
  AuthVerifyResult,
  BillingState,
  Consent,
  ListView,
  Me,
  Notification,
  ServerProfile,
  SessionRow,
  Ticket,
  User,
} from "./types";

const enc = encodeURIComponent;

export const configApi = {
  get: () => api<AppConfig>("/api/v1/config"),
};

export const authApi = {
  start: (email: string, turnstileToken?: string) =>
    api<AuthStartResult>("/api/v1/auth/start", { body: turnstileToken ? { email, turnstileToken } : { email } }),
  verify: (email: string, code: string) => api<AuthVerifyResult>("/api/v1/auth/verify", { body: { email, code } }),
  logout: () => api<{ ok: boolean }>("/api/v1/auth/logout", { body: {} }),
  logoutAll: () => api<{ ok: boolean; revoked: number }>("/api/v1/auth/logout-all", { body: {} }),
  googleStartUrl: (next: string) => `/api/v1/auth/google/start?next=${enc(next)}`,
};

export const meApi = {
  get: (quietAuth = false) => api<Me>("/api/v1/me", { quietAuth }),
  patch: (patch: { displayName?: string | null; marketingOptIn?: boolean }) => api<{ user: User }>("/api/v1/me", { method: "PATCH", body: patch }),
  sessions: () => api<{ items: SessionRow[] }>("/api/v1/me/sessions"),
  revokeSession: (id: string) => api<{ ok: boolean }>(`/api/v1/me/sessions/${enc(id)}`, { method: "DELETE" }),
  /** Returns the JSON export as a Blob + suggested filename (the route is a download). */
  async exportData(): Promise<{ blob: Blob; filename: string }> {
    const res = await fetch("/api/v1/me/export", { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) {
      // Re-run through api() for the uniform error mapping.
      await api("/api/v1/me/export");
    }
    const cd = res.headers.get("content-disposition") ?? "";
    const m = /filename="([^"]+)"/.exec(cd);
    return { blob: await res.blob(), filename: m?.[1] ?? "tudumm-export.json" };
  },
  deleteAccount: () => api<{ ok: boolean; deleted: boolean }>("/api/v1/me", { method: "DELETE", body: { confirm: "DELETE" } }),
};

export const profileApi = {
  get: () => api<{ profile: ServerProfile | null }>("/api/v1/profile"),
  put: (p: Partial<Omit<ServerProfile, "updatedAt">>) => api<{ profile: ServerProfile }>("/api/v1/profile", { method: "PUT", body: p }),
};

export const watchlistApi = {
  get: () => api<ListView>("/api/v1/watchlist"),
  put: (symbols: string[]) => api<ListView>("/api/v1/watchlist", { method: "PUT", body: { symbols } }),
};

export const trackedApi = {
  get: () => api<ListView>("/api/v1/tracked"),
  put: (items: { symbol: string; signalId: string | null }[]) => api<ListView>("/api/v1/tracked", { method: "PUT", body: { items } }),
};

export const syncApi = {
  run: (body: { profile?: unknown; watchlist?: string[]; tracked?: unknown[] }) =>
    api<{ profile: ServerProfile | null; watchlist: ListView; tracked: ListView; merged: { profile: boolean; watchlistAdded: number; trackedAdded: number } }>(
      "/api/v1/sync",
      { body },
    ),
};

export const consentApi = {
  accept: (kind: Consent["kind"], version: string) =>
    api<{ consents: Consent[]; pendingConsents: { kind: string; version: string }[] }>("/api/v1/consents", { body: { kind, version } }),
  withdraw: (kind: Consent["kind"]) =>
    api<{ consents: Consent[]; pendingConsents: { kind: string; version: string }[] }>(`/api/v1/consents/${enc(kind)}`, { method: "DELETE" }),
};

export const alertsApi = {
  list: () => api<{ items: Alert[]; limit: number }>("/api/v1/alerts"),
  create: (a: { symbol: string; kind: Alert["kind"]; threshold?: number; oneShot?: boolean }) => api<{ alert: Alert }>("/api/v1/alerts", { body: a }),
  patch: (id: string, patch: { active?: boolean; threshold?: number }) => api<{ alert: Alert }>(`/api/v1/alerts/${enc(id)}`, { method: "PATCH", body: patch }),
  remove: (id: string) => api<{ ok: boolean }>(`/api/v1/alerts/${enc(id)}`, { method: "DELETE" }),
};

export const notificationsApi = {
  list: (unreadOnly = false, limit = 20) =>
    api<{ items: Notification[]; unread: number; nextBefore: string | null }>(`/api/v1/notifications?limit=${limit}${unreadOnly ? "&unread=1" : ""}`),
  markRead: (ids: string[]) => api<{ ok: boolean; unread: number }>("/api/v1/notifications/read", { body: { ids } }),
  markAll: () => api<{ ok: boolean; unread: number }>("/api/v1/notifications/read", { body: { all: true } }),
};

export const supportApi = {
  create: (t: { category: string; subject: string; body: string; email?: string; turnstileToken?: string }) =>
    api<{ ticket: { id: string; status: string; category: string; subject: string; createdAt: string } }>("/api/v1/support", { body: t }),
  mine: () => api<{ items: Ticket[] }>("/api/v1/support"),
  reply: (id: string, body: string) => api<{ ok: boolean }>(`/api/v1/support/${enc(id)}/reply`, { body: { body } }),
};

export const billingApi = {
  get: () => api<BillingState>("/api/v1/billing"),
  checkout: (plan: "pro" | "elite", provider: "razorpay" | "stripe") =>
    api<{ provider: string; url?: string; orderId?: string; amount?: number; currency?: string; keyId?: string; plan: string }>("/api/v1/billing/checkout", {
      body: { plan, provider },
    }),
};

export const extLinkApi = {
  approve: (userCode: string) => api<{ ok: boolean; approved: boolean }>("/api/v1/ext/link/approve", { body: { userCode } }),
};
