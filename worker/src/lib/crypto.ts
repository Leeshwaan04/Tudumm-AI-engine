// Crypto helpers (Web Crypto only, so they also run under Node for unit tests).
// Secrets we issue (session tokens, OTPs, device tokens) are stored ONLY as hashes:
//   HMAC-SHA-256(SESSION_PEPPER, purpose + ":" + value)  when SESSION_PEPPER is set
//   SHA-256(purpose + ":" + value)                         otherwise
// `purpose` domain-separates the hashes so a hash from one table is useless in another.
import type { Env } from "../env";

const enc = new TextEncoder();

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] as number).toString(16).padStart(2, "0");
  return out;
}

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] as number);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecodeToString(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** 256-bit URL-safe random token. */
export function randomToken(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

/** Uniform random integer in [0, max) using rejection sampling (no modulo bias). */
export function randomInt(max: number): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const v = buf[0] as number;
    if (v < limit) return v % max;
  }
}

/** n-digit numeric code, e.g. an OTP. */
export function randomDigits(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += String(randomInt(10));
  return s;
}

/** Unambiguous alphabet: no 0/O, 1/I/L. */
export const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function randomUserCode(len = 8): string {
  let s = "";
  for (let i = 0; i < len; i++) s += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return s;
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

export async function sha256B64url(text: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text))));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await hmacKey(secret);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/** Hash a secret/identifier for storage. See the header comment. */
export async function hashSecret(env: Pick<Env, "SESSION_PEPPER">, purpose: string, value: string): Promise<string> {
  const msg = `${purpose}:${value}`;
  return env.SESSION_PEPPER ? hmacHex(env.SESSION_PEPPER, msg) : sha256Hex(msg);
}

/** Constant-time comparison of two strings (portable: no Workers-only APIs). */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Constant-time compare via hashing both sides first (length-independent). */
export async function safeEqualHashed(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  return constantTimeEqual(x, y);
}
