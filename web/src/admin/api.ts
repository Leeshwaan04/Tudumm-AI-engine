// Self-contained fetch helper for the admin portal. Same-origin cookies only (the admin
// session is an HttpOnly __Host- cookie); nothing is ever cached in localStorage.

export class ApiError extends Error {
  status: number;
  code: string;
  hint: string | null;
  field: string | null;
  retryAfter: number | null;
  body: Record<string, unknown> | null;
  constructor(status: number, code: string, body: Record<string, unknown> | null, retryAfter: number | null) {
    super(code);
    this.status = status;
    this.code = code;
    this.body = body;
    this.hint = typeof body?.hint === "string" ? body.hint : null;
    this.field = typeof body?.field === "string" ? body.field : null;
    this.retryAfter = retryAfter;
  }
  get offline(): boolean {
    return this.status === 0;
  }
}

/** Human sentence for an API error. Uses the server's own message when it sent one. */
export function describeError(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : "Something went wrong.";
  const msg = typeof e.body?.message === "string" ? e.body.message : null;
  if (e.offline) return "Can't reach the API. Check that the Worker is running, then retry.";
  switch (e.code) {
    case "admin_not_configured":
      return "Admin isn't configured yet. Owner: run scripts/set-secrets.sh.";
    case "admin_auth_required":
      return "Your admin session has ended. Sign in again.";
    case "invalid_credentials":
      return "That password isn't right.";
    case "rate_limited":
      return `Slow down — try again in ${e.retryAfter ? fmtWait(e.retryAfter) : "a minute"}.`;
    case "invalid_input":
      return `${e.field ? `${e.field}: ` : ""}${msg ?? "Invalid input."}`;
    case "bad_origin":
      return "The API refused this request's origin (cross-site requests are blocked).";
    case "engine_error":
      return msg ?? "The engine call failed; see the audit log.";
    case "dev_codes_off":
      return msg ?? "Dev codes are off.";
    case "not_found":
      return "Not found.";
    case "internal_error":
      return "The API hit an internal error (500). Nothing was changed on our side of the request.";
    default:
      return msg ?? `${e.code.replace(/_/g, " ")} (HTTP ${e.status})`;
  }
}

function fmtWait(s: number): string {
  if (s < 90) return `${Math.max(1, Math.round(s))}s`;
  return `${Math.round(s / 60)} min`;
}

type Listener = (e: ApiError) => void;
const authListeners = new Set<Listener>();
/** Layout subscribes so any 401 anywhere sends the operator back to the login screen. */
export function onAuthLost(l: Listener): () => void {
  authListeners.add(l);
  return () => authListeners.delete(l);
}

export async function api<T>(path: string, init: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  let body: string | undefined;
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body ?? {});
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body, credentials: "same-origin", cache: "no-store", signal: init.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "network_error", null, null);
  }
  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
    const code = typeof obj?.error === "string" ? obj.error : `http_${res.status}`;
    const ra = Number(res.headers.get("retry-after") ?? obj?.retryAfter ?? NaN);
    const e = new ApiError(res.status, code, obj, Number.isFinite(ra) ? ra : null);
    if (res.status === 401 && path.startsWith("/api/admin/") && path !== "/api/admin/login") authListeners.forEach((l) => l(e));
    throw e;
  }
  if (data === null && text) throw new ApiError(res.status, "bad_json", null, null);
  return data as T;
}

/** Build a query string, skipping empty values. */
export function qs(params: Record<string, string | number | null | undefined | false>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "" || v === false) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
