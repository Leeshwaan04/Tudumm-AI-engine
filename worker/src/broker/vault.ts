// Credential vault for broker connections: AES-256-GCM, a fresh 96-bit IV per record, key derived
// with HKDF-SHA-256. Additional data binds each ciphertext to (broker, connection id, account id),
// so a ciphertext copied to another row does not open.
//
// Key material, by key id stored in broker_connections.creds_kid:
//   "v1"                 BROKER_VAULT_KEY (dedicated secret, preferred; required for phase-2 user keys)
//   "<broker>:app"       the adapter's fallback secret (Kite: KITE_API_SECRET) — lets the owner-only
//                        Kite integration run with just its two Kite secrets, as phase 1 specifies.
// Rotating either secret makes old ciphertexts unreadable => those connections read as disconnected
// (Kite tokens expire daily anyway). Plaintext never leaves the Worker except to the broker itself
// or to the Bearer-authenticated relay inside a placement request.
import type { Env } from "../env";
import { b64url } from "../lib/crypto";
import type { BrokerAdapter } from "./types";

const enc = new TextEncoder();
const SALT = enc.encode("tudumm/broker/v1");

function b64urlToBytes(str: string): Uint8Array {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function material(env: Env, adapter: BrokerAdapter, kid: string): string | null {
  if (kid === "v1") return env.BROKER_VAULT_KEY && env.BROKER_VAULT_KEY.length >= 32 ? env.BROKER_VAULT_KEY : null;
  if (kid === `${adapter.id}:app`) return adapter.vaultFallbackSecret?.(env) ?? null;
  return null;
}

/** Key id to use for NEW ciphertexts, or null when no key material is available. */
export function currentKid(env: Env, adapter: BrokerAdapter): string | null {
  if (env.BROKER_VAULT_KEY && env.BROKER_VAULT_KEY.length >= 32) return "v1";
  return adapter.vaultFallbackSecret?.(env) ? `${adapter.id}:app` : null;
}

async function key(secret: string, brokerId: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: SALT, info: enc.encode(`broker-creds:${brokerId}`) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function credsAad(brokerId: string, connectionId: string, accountId: string): string {
  return `${brokerId}:${connectionId}:${accountId}`;
}

export async function seal(env: Env, adapter: BrokerAdapter, plaintext: string, aad: string): Promise<{ ct: string; iv: string; kid: string }> {
  const kid = currentKid(env, adapter);
  const secret = kid ? material(env, adapter, kid) : null;
  if (!kid || !secret) throw new Error("vault: no key material");
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, await key(secret, adapter.id), enc.encode(plaintext));
  return { ct: b64url(new Uint8Array(ct)), iv: b64url(iv), kid };
}

/** null when the record is wiped, the key is gone/rotated, or the ciphertext was tampered with. */
export async function open(env: Env, adapter: BrokerAdapter, ct: string, iv: string, kid: string, aad: string): Promise<string | null> {
  if (!ct || !iv) return null;
  const secret = material(env, adapter, kid);
  if (!secret) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64urlToBytes(iv), additionalData: enc.encode(aad) }, await key(secret, adapter.id), b64urlToBytes(ct));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}
