// RFC 6238 TOTP (HMAC-SHA1, 30 s step, 6 digits): the code an authenticator app shows for the
// base32 secret 5paisa gives you when you enable TOTP. Used for the daily headless 5paisa login.
import { createHmac } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(input: string): Buffer {
  const s = input.toUpperCase().replace(/[\s=-]/g, "");
  if (!s.length) throw new Error("TOTP secret is empty");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error("TOTP secret is not valid base32");
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totp(secret: string, nowMs = Date.now(), stepSec = 30, digits = 6): string {
  const key = base32Decode(secret);
  const counter = Math.floor(nowMs / 1000 / stepSec);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", key).update(msg).digest();
  const off = (h[h.length - 1] as number) & 0x0f;
  const code = (h.readUInt32BE(off) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, "0");
}

/** Seconds left in the current TOTP window (log in early in a fresh window to avoid an edge expiry). */
export function totpSecondsLeft(nowMs = Date.now(), stepSec = 30): number {
  return stepSec - (Math.floor(nowMs / 1000) % stepSec);
}
