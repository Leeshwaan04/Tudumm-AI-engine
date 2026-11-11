// HTTP plumbing for the API: typed errors, bounded JSON body reading, cookies, client facts.
import type { Env } from "../env";
import { json } from "./edge";
import { hashSecret } from "./crypto";

export class HttpError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown> | undefined;
  headers: Record<string, string> | undefined;
  constructor(status: number, code: string, extra?: Record<string, unknown>, headers?: Record<string, string>) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
    this.headers = headers;
  }
}

export function errorResponse(status: number, code: string, extra?: Record<string, unknown>, headers?: Record<string, string>): Response {
  return json({ error: code, ...(extra ?? {}) }, headers ?? {}, status);
}

export const bad = (code: string, extra?: Record<string, unknown>) => new HttpError(400, code, extra);
export const notFound = (code = "not_found") => new HttpError(404, code);

/** Request body cap (bytes). Requests above it get 413 without being buffered beyond the cap. */
export const DEFAULT_BODY_LIMIT = 32 * 1024;

function isJsonContentType(ct: string | null): boolean {
  if (!ct) return false;
  const base = ct.split(";")[0]?.trim().toLowerCase();
  return base === "application/json";
}

export function requireJsonContentType(request: Request): void {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    throw new HttpError(415, "unsupported_media_type", { message: "Send content-type: application/json" });
  }
}

/** Read the raw body as text with a hard cap (works with or without Content-Length). */
export async function readTextBounded(request: Request, limit: number): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, "payload_too_large", { limit });
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > limit) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new HttpError(413, "payload_too_large", { limit });
      }
      chunks.push(value);
    }
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Parse a JSON object body. Empty body => {}. Arrays/primitives are rejected. */
export async function readJsonObject(request: Request, limit = DEFAULT_BODY_LIMIT): Promise<Record<string, unknown>> {
  requireJsonContentType(request);
  const text = await readTextBounded(request, limit);
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw bad("invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw bad("invalid_json", { message: "Body must be a JSON object" });
  return parsed as Record<string, unknown>;
}

/* ---------------- cookies ---------------- */

export const SESSION_COOKIE = "__Host-tdm_s";
export const ADMIN_COOKIE = "__Host-tdm_a";
export const OAUTH_COOKIE = "__Host-tdm_g";

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in out)) out[k] = v;
  }
  return out;
}

/** `__Host-` cookies: Secure, Path=/, no Domain. Always HttpOnly. */
export function hostCookie(name: string, value: string, opts: { maxAge: number; sameSite: "Lax" | "Strict" }): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=${opts.sameSite}; Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`;
}

export function clearHostCookie(name: string, sameSite: "Lax" | "Strict" = "Lax"): string {
  return `${name}=; Path=/; Secure; HttpOnly; SameSite=${sameSite}; Max-Age=0`;
}

/* ---------------- client facts (never store raw IPs) ---------------- */

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

export async function ipHash(env: Env, request: Request): Promise<string> {
  return hashSecret(env, "ip", clientIp(request));
}

export function clientCountry(request: Request): string | null {
  const cf = (request as Request & { cf?: { country?: unknown } }).cf;
  const c = typeof cf?.country === "string" ? cf.country.toUpperCase() : null;
  return c && /^[A-Z0-9]{2}$/.test(c) ? c : null;
}

export function clientDevice(request: Request): "mobile" | "desktop" {
  const ua = request.headers.get("user-agent") ?? "";
  return /Mobi|Android|iPhone|iPad|iPod|Opera Mini|IEMobile/i.test(ua) ? "mobile" : "desktop";
}

export function userAgent(request: Request): string | null {
  const ua = request.headers.get("user-agent");
  return ua ? ua.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200) : null;
}

/* ---------------- origins ---------------- */

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

export function isExtensionOrigin(origin: string | null): origin is string {
  return !!origin && EXTENSION_ORIGIN.test(origin);
}

/** Origins allowed to make cookie-authenticated / anonymous state-changing requests. */
export function isAllowedWebOrigin(origin: string | null, request: Request, env: Env): boolean {
  if (!origin || origin === "null") return false;
  const self = new URL(request.url).origin;
  if (origin === self) return true;
  if (env.SITE_URL) {
    try {
      if (origin === new URL(env.SITE_URL).origin) return true;
    } catch {
      /* misconfigured SITE_URL: ignore */
    }
  }
  // Local frontend dev (Vite on another port) only when explicitly running as development.
  if (env.APP_ENV === "development" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin)) return true;
  return false;
}

export function siteOrigin(env: Env, request: Request): string {
  if (env.SITE_URL) {
    try {
      return new URL(env.SITE_URL).origin;
    } catch {
      /* fall through */
    }
  }
  return new URL(request.url).origin;
}
