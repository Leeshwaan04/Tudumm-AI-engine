// Cloudflare Turnstile verification (enabled only when TURNSTILE_SITE_KEY + TURNSTILE_SECRET exist).
// Fails CLOSED: a missing/invalid token is a 400, and an unreachable siteverify is a 503 — never a pass.
import type { Env } from "../env";
import { clientIp, HttpError } from "./http";
import { logError } from "./log";

export type TurnstileResult = "ok" | "missing" | "failed" | "unavailable";

export async function verifyTurnstile(env: Env, request: Request, token: unknown): Promise<TurnstileResult> {
  if (!env.TURNSTILE_SECRET) return "ok";
  if (typeof token !== "string" || !token.trim()) return "missing";
  if (token.length > 2048) return "failed";
  try {
    const body = new FormData();
    body.append("secret", env.TURNSTILE_SECRET);
    body.append("response", token);
    const ip = clientIp(request);
    if (ip !== "unknown") body.append("remoteip", ip);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      logError("turnstile", new Error(`siteverify status ${res.status}`));
      return "unavailable";
    }
    const out = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    if (out.success === true) return "ok";
    // internal-error from Cloudflare is a provider problem, not a bad token.
    if ((out["error-codes"] ?? []).includes("internal-error")) return "unavailable";
    return "failed";
  } catch (err) {
    logError("turnstile", err);
    return "unavailable";
  }
}

/** Throws the right HttpError unless the token verifies. */
export async function requireTurnstile(env: Env, request: Request, token: unknown): Promise<void> {
  const r = await verifyTurnstile(env, request, token);
  if (r === "ok") return;
  if (r === "missing") throw new HttpError(400, "turnstile_required", { message: "Complete the human check and try again." });
  if (r === "failed") throw new HttpError(400, "turnstile_failed", { message: "The human check didn't pass. Try again." });
  throw new HttpError(503, "turnstile_unavailable", { message: "The human check is temporarily unavailable. Try again shortly." });
}
