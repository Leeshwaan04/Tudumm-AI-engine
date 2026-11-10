// Tudumm prototype — Cloudflare Worker in front of the static site (Workers static assets).
// - Serves /__tudumm/ext-status so the landing page links the hosted extension preview.
// - Optional UAT gate: when the UAT_PASSWORD secret is set, /app, /extension and /downloads
//   require HTTP Basic auth (any username + that password). The landing page stays public.
//   Enable:  npx wrangler secret put UAT_PASSWORD     Disable: npx wrangler secret delete UAT_PASSWORD
// - Adds security headers to every response.

const GATED = [/^\/app(\/|$)/, /^\/extension(\/|$)/, /^\/downloads(\/|$)/];

const SECURITY_HEADERS = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; "),
};

function secure(response, pathname) {
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  if (pathname.startsWith("/assets/") && res.status === 200) {
    res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  }
  if (pathname.startsWith("/downloads/") && res.status === 200) {
    res.headers.set("Content-Disposition", "attachment");
  }
  return res;
}

async function sha256(text) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

async function passwordOk(header, expected) {
  if (!header || !header.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return false;
  }
  const i = decoded.indexOf(":");
  if (i === -1) return false;
  const [a, b] = await Promise.all([sha256(decoded.slice(i + 1)), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/__tudumm/ext-status") {
      const body = JSON.stringify({ preview: true, path: "/extension/preview.html" });
      return secure(
        new Response(body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }),
        pathname,
      );
    }

    if (env.UAT_PASSWORD && GATED.some((re) => re.test(pathname))) {
      if (!(await passwordOk(request.headers.get("Authorization"), env.UAT_PASSWORD))) {
        return secure(
          new Response("Tudumm prototype: access is limited to invited testers.", {
            status: 401,
            headers: {
              "WWW-Authenticate": 'Basic realm="Tudumm UAT", charset="UTF-8"',
              "cache-control": "no-store",
              "content-type": "text/plain; charset=utf-8",
            },
          }),
          pathname,
        );
      }
    }

    return secure(await env.ASSETS.fetch(request), pathname);
  },
};
