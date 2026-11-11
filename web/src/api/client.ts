import { useSyncExternalStore } from "react";

/**
 * Typed fetch wrapper for the Tudumm API.
 * - same-origin credentials (the session is an HttpOnly cookie; no tokens in JS storage)
 * - JSON bodies with content-type: application/json on writes (the API's CSRF policy needs it)
 * - one error type (ApiError) with the API's machine code + a human message
 * - a tiny network-state store that drives the offline banner
 */

export class ApiError extends Error {
  status: number;
  code: string;
  data: Record<string, unknown>;
  retryAfter: number | null;
  constructor(status: number, code: string, message: string, data: Record<string, unknown> = {}, retryAfter: number | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
    this.retryAfter = retryAfter;
  }
  /** The API (or the dev proxy) could not be reached at all. */
  get unreachable(): boolean {
    return this.status === 0 || this.code === "api_unreachable";
  }
}

/* ---------------- network state (offline banner) ---------------- */
type NetState = { offline: boolean; since: number | null };
let net: NetState = { offline: false, since: null };
const netListeners = new Set<() => void>();
function setNet(next: NetState) {
  if (next.offline === net.offline) return;
  net = next;
  netListeners.forEach((l) => l());
}
export function markOnline() {
  setNet({ offline: false, since: null });
}
function markOffline() {
  setNet({ offline: true, since: Date.now() });
}
export function useNetState(): NetState {
  return useSyncExternalStore(
    (l) => {
      netListeners.add(l);
      return () => netListeners.delete(l);
    },
    () => net,
  );
}
if (typeof window !== "undefined") {
  window.addEventListener("offline", markOffline);
  window.addEventListener("online", () => void ping());
}
/** Cheap reachability check used by the offline banner's retry loop. */
export async function ping(): Promise<boolean> {
  try {
    const r = await fetch("/api/v1/health", { credentials: "same-origin", cache: "no-store" });
    if (r.status < 500 || r.status === 503) {
      markOnline();
      return true;
    }
  } catch {
    /* still offline */
  }
  return false;
}

/* ---------------- auth/suspension signals (the session store listens) ---------------- */
type AuthSignal = "unauthorized" | "suspended";
const authListeners = new Set<(s: AuthSignal) => void>();
export function onAuthSignal(l: (s: AuthSignal) => void) {
  authListeners.add(l);
  return () => authListeners.delete(l);
}

export interface ApiOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** Don't broadcast 401s (used by the boot-time /me probe). */
  quietAuth?: boolean;
  keepalive?: boolean;
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = { accept: "application/json" };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body, credentials: "same-origin", signal: opts.signal, keepalive: opts.keepalive, cache: "no-store" });
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") throw err;
    markOffline();
    throw new ApiError(0, "network", "You're offline or Tudumm can't be reached. Retrying…");
  }
  const ct = res.headers.get("content-type") ?? "";
  const isJson = ct.includes("application/json");
  let data: unknown = null;
  if (isJson) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  }
  if (res.ok) {
    markOnline();
    return (isJson ? data : await res.text().catch(() => "")) as T;
  }
  // The Vite dev proxy answers 500/502/504 with a non-JSON body when the Worker isn't running.
  if (!isJson && res.status >= 500) throw new ApiError(res.status, "api_unreachable", "The Tudumm API isn't reachable right now.");
  markOnline();
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const code = typeof d.error === "string" ? d.error : `http_${res.status}`;
  const retryAfter = Number(res.headers.get("retry-after") ?? d.retryAfter ?? NaN);
  const err = new ApiError(res.status, code, humanMessage(res.status, code, d), d, Number.isFinite(retryAfter) ? retryAfter : null);
  if (res.status === 401 && !opts.quietAuth && (code === "auth_required" || code === "invalid_token")) authListeners.forEach((l) => l("unauthorized"));
  if (res.status === 403 && code === "account_suspended") authListeners.forEach((l) => l("suspended"));
  throw err;
}

const CODE_MESSAGES: Record<string, string> = {
  rate_limited: "Slow down — try again in a minute.",
  account_suspended: "This account is suspended. Contact support if you think that's a mistake.",
  account_unavailable: "That account has been closed.",
  email_verification_required: "This email was verified by a real email code before. UAT on-screen codes can't open it.",
  signups_closed: "New sign-ups are paused right now. Try again later.",
  email_unavailable: "Email sign-in isn't available right now.",
  email_send_failed: "We couldn't send the email. Try again in a minute.",
  invalid_code: "That code isn't right.",
  code_expired: "That code has expired. Ask for a new one.",
  turnstile_required: "Complete the human check and try again.",
  turnstile_failed: "The human check didn't pass. Try again.",
  turnstile_unavailable: "The human check is temporarily unavailable. Try again shortly.",
  auth_required: "Sign in to do that.",
  invalid_token: "Your session ended. Sign in again.",
  bad_origin: "This request was refused for safety (cross-origin).",
  alert_limit_reached: "You've reached the alert limit for your plan.",
  limit_reached: "That list is full.",
  ticket_closed: "That ticket is closed. Open a new one instead.",
  code_not_found: "That code is wrong, expired or already used. Start again from the extension.",
  extension_linking_disabled: "Extension linking is switched off right now.",
  billing_unavailable: "Billing isn't live yet.",
  cookie_session_required: "Do this from the Tudumm website.",
  payload_too_large: "That's too long.",
};

function humanMessage(status: number, code: string, d: Record<string, unknown>): string {
  if (status === 429) return CODE_MESSAGES.rate_limited;
  if (code === "invalid_input") {
    const field = typeof d.field === "string" ? d.field : "input";
    const msg = typeof d.message === "string" ? d.message : "is invalid";
    return `${field.charAt(0).toUpperCase()}${field.slice(1)} ${msg}.`;
  }
  if (code === "invalid_code" && typeof d.attemptsLeft === "number") {
    return d.attemptsLeft > 0 ? `That code isn't right. ${d.attemptsLeft} ${d.attemptsLeft === 1 ? "try" : "tries"} left.` : "Too many wrong tries. Ask for a new code.";
  }
  if (CODE_MESSAGES[code]) return CODE_MESSAGES[code];
  if (typeof d.message === "string" && d.message) return d.message;
  if (status === 503) return "That feature isn't available right now.";
  if (status >= 500) return "Something went wrong on our side. Try again.";
  if (status === 404) return "Not found.";
  return "That didn't work. Try again.";
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "Something went wrong. Try again.";
}
