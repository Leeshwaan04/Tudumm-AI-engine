// Request context + route definition types shared by api/* and admin/*.
import type { Env } from "../env";
import { HttpError } from "../lib/http";
import type { AdminInfo, SessionInfo, UserRow } from "../lib/session";

export interface Ctx {
  req: Request;
  env: Env;
  exec: ExecutionContext;
  url: URL;
  params: Record<string, string>;
  /** Set for auth "user" (always) and "optional" (when a valid session exists). */
  user: UserRow | null;
  session: SessionInfo | null;
  via: "cookie" | "bearer" | null;
  admin: AdminInfo | null;
  /** Set-Cookie values appended to the response. */
  cookies: string[];
  ipHash: () => Promise<string>;
}

export type Handler = (c: Ctx) => Promise<Response>;

export interface RouteDef {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string; // e.g. "/api/v1/alerts/:id"
  /** none: public; optional: session if present; user: session required; admin: admin cookie required. */
  auth: "none" | "optional" | "user" | "admin";
  /**
   * CSRF policy for state-changing methods:
   *   default    same-origin Origin header required (Bearer-token requests are exempt)
   *   extension  additionally allow chrome-extension:// origins (anonymous device-flow calls)
   *   none       signature-verified server-to-server webhooks only
   */
  csrf?: "default" | "extension" | "none";
  /** Allow (non-credentialed) CORS for chrome-extension:// origins. */
  cors?: boolean;
  /** Skip the generic per-user write limiter (route has its own). */
  noWriteLimit?: boolean;
  /** Web session cookie only — extension Bearer tokens are refused (account-level actions). */
  cookieOnly?: boolean;
  handler: Handler;
}

export function requireUser(c: Ctx): UserRow {
  if (!c.user) throw new HttpError(401, "auth_required");
  return c.user;
}

export function requireAdmin(c: Ctx): AdminInfo {
  if (!c.admin) throw new HttpError(401, "admin_auth_required");
  return c.admin;
}

export function param(c: Ctx, name: string): string {
  const v = c.params[name];
  if (v === undefined) throw new HttpError(404, "not_found");
  return v;
}
