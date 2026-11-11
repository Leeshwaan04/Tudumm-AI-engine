// Zerodha Kite Connect v3 client for the Worker (login, token exchange, read APIs) plus the pure
// helpers the broker routes and tests share: checksums, access-token vault, IST time maths.
//
// Order PLACEMENT never happens here: since 1 Apr 2026 Kite only accepts orders from a static IP
// registered in the developer console, and Workers have no static egress. Orders go through the
// relay (relay/kite-relay.mjs). Read APIs (orders book, positions, holdings, margins) work from any IP.
//
// Secrets: the access token is AES-256-GCM encrypted at rest with a key derived (HKDF-SHA-256)
// from KITE_API_SECRET. It is only ever decrypted to call Kite or to hand it to the
// Bearer-authenticated relay, and never returned to a browser route or written to logs/audit.
import type { Env } from "../env";
import { b64url, sha256Hex } from "../lib/crypto";

const enc = new TextEncoder();

export const KITE_API = "https://api.kite.trade";
export const KITE_LOGIN_URL = "https://kite.zerodha.com/connect/login";
const LOCAL_BASE = /^http:\/\/127\.0\.0\.1:\d{2,5}$/;

/** Kite REST base URL. The override exists for the integration tests only (loopback + development). */
export function kiteBase(env: Pick<Env, "APP_ENV" | "KITE_API_BASE">): string {
  if (env.APP_ENV === "development" && env.KITE_API_BASE && LOCAL_BASE.test(env.KITE_API_BASE)) return env.KITE_API_BASE;
  return KITE_API;
}

export function kiteConfigured(env: Pick<Env, "KITE_API_KEY" | "KITE_API_SECRET">): boolean {
  return !!(env.KITE_API_KEY && env.KITE_API_SECRET);
}

/** RELAY_TOKEN must be long enough to be a real secret; a short value counts as unset. */
export function relayConfigured(env: Pick<Env, "RELAY_TOKEN">): boolean {
  return typeof env.RELAY_TOKEN === "string" && env.RELAY_TOKEN.length >= 32;
}

/* ---------------- checksums ---------------- */

/** POST /session/token checksum: SHA-256(api_key + request_token + api_secret), hex. */
export function sessionChecksum(apiKey: string, requestToken: string, apiSecret: string): Promise<string> {
  return sha256Hex(apiKey + requestToken + apiSecret);
}

/** Postback checksum: SHA-256(order_id + order_timestamp + api_secret), hex. */
export function postbackChecksum(orderId: string, orderTimestamp: string, apiSecret: string): Promise<string> {
  return sha256Hex(orderId + orderTimestamp + apiSecret);
}

/* ---------------- login URL ---------------- */

export function loginUrl(apiKey: string, state: string): string {
  const u = new URL(KITE_LOGIN_URL);
  u.searchParams.set("v", "3");
  u.searchParams.set("api_key", apiKey);
  // Kite URL-decodes redirect_params and appends them to the registered redirect URL.
  u.searchParams.set("redirect_params", `state=${state}`);
  return u.toString();
}

/* ---------------- time (IST = UTC+05:30, no DST) ---------------- */

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

/**
 * Kite access tokens expire at 06:00 IST "the next day". We use the first 06:00 IST strictly after
 * `nowMs` (a login at 02:00 IST expires 4 hours later, a login at 09:00 IST the next morning).
 */
export function nextKiteExpiry(nowMs: number): string {
  const istNow = nowMs + IST_OFFSET_MS;
  const istMidnight = Math.floor(istNow / DAY_MS) * DAY_MS;
  let expiryIst = istMidnight + 6 * 3_600_000;
  if (expiryIst <= istNow) expiryIst += DAY_MS;
  return new Date(expiryIst - IST_OFFSET_MS).toISOString();
}

/** Start of the current IST calendar day as a UTC ISO string (for the daily order cap). */
export function istDayStartIso(nowMs: number): string {
  const istMidnight = Math.floor((nowMs + IST_OFFSET_MS) / DAY_MS) * DAY_MS;
  return new Date(istMidnight - IST_OFFSET_MS).toISOString();
}

/* ---------------- access-token vault (HKDF -> AES-256-GCM) ---------------- */

const HKDF_SALT = enc.encode("tudumm/broker/v1");
const HKDF_INFO = enc.encode("kite-access-token");

async function vaultKey(apiSecret: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", enc.encode(apiSecret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: HKDF_INFO }, ikm, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Additional authenticated data: a ciphertext only decrypts for the row it was written for. */
export function tokenAad(sessionId: string, kiteUserId: string): string {
  return `kite:${sessionId}:${kiteUserId}`;
}

export async function encryptToken(apiSecret: string, token: string, aad: string): Promise<{ ct: string; iv: string }> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await vaultKey(apiSecret);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, enc.encode(token));
  return { ct: b64url(new Uint8Array(ct)), iv: b64url(iv) };
}

/**
 * Key material for the stored access token. BROKER_VAULT_KEY (>= 32 chars) when set, so a leaked
 * KITE_API_SECRET alone can't open stored tokens; KITE_API_SECRET otherwise. Opening tries both, so
 * a token sealed before the vault key was set still opens until it expires (06:00 IST).
 */
export function tokenSecrets(env: Pick<Env, "BROKER_VAULT_KEY" | "KITE_API_SECRET">): string[] {
  const out: string[] = [];
  if (env.BROKER_VAULT_KEY && env.BROKER_VAULT_KEY.length >= 32) out.push(env.BROKER_VAULT_KEY);
  if (env.KITE_API_SECRET) out.push(env.KITE_API_SECRET);
  return out;
}

export async function sealToken(env: Pick<Env, "BROKER_VAULT_KEY" | "KITE_API_SECRET">, token: string, aad: string): Promise<{ ct: string; iv: string }> {
  const [secret] = tokenSecrets(env);
  if (!secret) throw new KiteError(503, "NotConfigured", "Kite is not configured");
  return encryptToken(secret, token, aad);
}

export async function openToken(env: Pick<Env, "BROKER_VAULT_KEY" | "KITE_API_SECRET">, ct: string, iv: string, aad: string): Promise<string | null> {
  for (const secret of tokenSecrets(env)) {
    const t = await decryptToken(secret, ct, iv, aad);
    if (t !== null) return t;
  }
  return null;
}

/** Returns null when the ciphertext can't be opened (wiped row, rotated secret, tampering). */
export async function decryptToken(apiSecret: string, ct: string, iv: string, aad: string): Promise<string | null> {
  if (!ct || !iv) return null;
  try {
    const key = await vaultKey(apiSecret);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64urlToBytes(iv), additionalData: enc.encode(aad) }, key, b64urlToBytes(ct));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

/* ---------------- HTTP client ---------------- */

/** A Kite API failure. errorType is Kite's error_type (TokenException, InputException, ...) or ours. */
export class KiteError extends Error {
  status: number;
  errorType: string;
  constructor(status: number, errorType: string, message: string) {
    super(message);
    this.status = status;
    this.errorType = errorType;
  }
  get tokenProblem(): boolean {
    return this.errorType === "TokenException";
  }
}

const SAFE_TEXT = /[\u0000-\u001f\u007f]/g;

/** Kite's own error text, trimmed. Kite messages never echo tokens; we still cap the length. */
export function cleanKiteMessage(m: unknown): string {
  return typeof m === "string" ? m.replace(SAFE_TEXT, " ").trim().slice(0, 200) : "";
}

interface KiteEnvelope {
  status?: unknown;
  data?: unknown;
  error_type?: unknown;
  message?: unknown;
}

async function readKiteJson(res: Response): Promise<KiteEnvelope | null> {
  try {
    const text = await res.text();
    const parsed = text ? (JSON.parse(text) as unknown) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as KiteEnvelope) : null;
  } catch {
    return null;
  }
}

interface KiteCall {
  method: "GET" | "POST" | "DELETE";
  path: string; // "/orders", "/portfolio/positions", ...
  accessToken?: string;
  form?: Record<string, string>;
  query?: Record<string, string>;
  timeoutMs?: number;
}

export async function kiteCall<T = unknown>(env: Env, call: KiteCall): Promise<T> {
  const apiKey = env.KITE_API_KEY;
  if (!apiKey) throw new KiteError(503, "NotConfigured", "Kite is not configured");
  const url = new URL(kiteBase(env) + call.path);
  for (const [k, v] of Object.entries(call.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { "X-Kite-Version": "3", accept: "application/json" };
  if (call.accessToken) headers.authorization = `token ${apiKey}:${call.accessToken}`;
  let body: string | undefined;
  if (call.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(call.form).toString();
  }
  let res: Response;
  try {
    res = await fetch(url.toString(), { method: call.method, headers, body, signal: AbortSignal.timeout(call.timeoutMs ?? 8000) });
  } catch (err) {
    const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new KiteError(504, timeout ? "Timeout" : "NetworkException", timeout ? "Kite did not answer in time" : "Kite is unreachable");
  }
  const data = await readKiteJson(res);
  if (!res.ok || !data || data.status !== "success") {
    const type = typeof data?.error_type === "string" && /^[A-Za-z]{1,40}$/.test(data.error_type) ? data.error_type : res.status === 403 ? "TokenException" : "GeneralException";
    throw new KiteError(res.status || 502, type, cleanKiteMessage(data?.message) || `Kite returned HTTP ${res.status}`);
  }
  return data.data as T;
}

/** POST /session/token: exchange the one-time request_token for an access token. */
export async function exchangeRequestToken(env: Env, requestToken: string): Promise<{ userId: string; accessToken: string }> {
  const apiKey = env.KITE_API_KEY as string;
  const checksum = await sessionChecksum(apiKey, requestToken, env.KITE_API_SECRET as string);
  const d = await kiteCall<{ user_id?: unknown; access_token?: unknown }>(env, {
    method: "POST",
    path: "/session/token",
    form: { api_key: apiKey, request_token: requestToken, checksum },
  });
  const userId = typeof d?.user_id === "string" ? d.user_id.trim().toUpperCase() : "";
  const accessToken = typeof d?.access_token === "string" ? d.access_token : "";
  if (!/^[A-Z0-9]{2,16}$/.test(userId) || !/^[A-Za-z0-9]{8,256}$/.test(accessToken)) {
    throw new KiteError(502, "DataException", "Kite returned an unexpected session payload");
  }
  return { userId, accessToken };
}

/** DELETE /session/token: invalidate the access token at Kite (best effort; caller decides). */
export async function invalidateAccessToken(env: Env, accessToken: string): Promise<void> {
  await kiteCall(env, { method: "DELETE", path: "/session/token", query: { api_key: env.KITE_API_KEY as string, access_token: accessToken } });
}
