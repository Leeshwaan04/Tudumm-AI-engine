// Edge helpers shared by every route: security headers, JSON responses, optional UAT gate.
// (Ported from the v0.1 deploy/worker/index.js.) Backend-core agent may extend, not break.
import type { Env } from "../env";

const CSP = [
  "default-src 'self'",
  // Cloudflare Web Analytics (cookieless RUM, auto-injected on the tudumm.in zone)
  "script-src 'self' https://static.cloudflareinsights.com https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // live crypto ticks/candles stream straight from Binance's public market-data endpoints
  "connect-src 'self' https://cloudflareinsights.com https://data-api.binance.vision wss://data-stream.binance.vision",
  "frame-src 'self' https://challenges.cloudflare.com",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": CSP,
};

export function secure(response: Response, pathname: string): Response {
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!res.headers.has(k)) res.headers.set(k, v);
  }
  if (pathname.startsWith("/assets/") && res.status === 200) {
    res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  }
  if (pathname.startsWith("/downloads/") && res.status === 200) {
    res.headers.set("Content-Disposition", "attachment");
  }
  if (pathname.startsWith("/api/") && !res.headers.has("Cache-Control")) {
    res.headers.set("Cache-Control", "no-store");
  }
  return res;
}

export function json(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

/** Constant-time string equality (hash both, then timingSafeEqual). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  return crypto.subtle.timingSafeEqual(x, y);
}

const GATED = [/^\/app(\/|$)/, /^\/admin(\/|$)/, /^\/extension(\/|$)/, /^\/downloads(\/|$)/];

/** Optional Basic-auth gate (UAT_PASSWORD secret). Returns a 401 response, or null to continue. */
export async function uatGate(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (!env.UAT_PASSWORD || !GATED.some((re) => re.test(pathname))) return null;
  const header = request.headers.get("Authorization") ?? "";
  if (header.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6).trim());
      const i = decoded.indexOf(":");
      if (i !== -1 && (await safeEqual(decoded.slice(i + 1), env.UAT_PASSWORD))) return null;
    } catch {
      /* fall through */
    }
  }
  return new Response("Tudumm prototype: access is limited to invited testers.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Tudumm UAT", charset="UTF-8"',
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}
