// Hand-rolled router for /api/* (everything except /api/v1/market/* and /api/internal/ingest*).
// Order of checks for every request:
//   1. route match (404 / 405), CORS preflight for chrome-extension:// origins on cors routes
//   2. CSRF: state-changing methods need content-type: application/json AND an allowed Origin
//      (same origin / SITE_URL), unless authenticated by an extension Bearer token; webhooks are
//      exempt (HMAC-verified instead). Admin routes also reject cross-site GETs (Sec-Fetch-Site).
//   3. auth: user (cookie or Bearer) / optional / admin (cookie + ADMIN_PASSWORD configured)
//   4. generic write rate limit per user / admin session
//   5. handler; HttpError -> JSON error, anything else -> 500 without details
// Must keep this export signature (index.ts).
import type { Env } from "../env";
import { json } from "../lib/edge";
import { errorResponse, HttpError, ipHash, isAllowedWebOrigin, isExtensionOrigin, requireJsonContentType } from "../lib/http";
import { logError } from "../lib/log";
import { enforce, prune } from "../lib/ratelimit";
import { bearerToken, resolveAdmin, resolveUser } from "../lib/session";
import { ADMIN_NOT_CONFIGURED, adminAuthRoutes } from "../admin/auth";
import { adminContentRoutes } from "../admin/content";
import { adminEngineRoutes } from "../admin/engine";
import { adminOverviewRoutes } from "../admin/overview";
import { adminSupportRoutes } from "../admin/support";
import { adminUserRoutes } from "../admin/users";
import { brokerRoutes } from "../broker/routes";
import { alertRoutes } from "./alerts";
import { authRoutes } from "./auth";
import { billingRoutes } from "./billing";
import { configRoutes } from "./config";
import type { Ctx, RouteDef } from "./context";
import { eventRoutes } from "./events";
import { extRoutes } from "./ext";
import { meRoutes } from "./me";
import { supportRoutes } from "./support";

interface Compiled extends RouteDef {
  re: RegExp;
  keys: string[];
}

function compile(r: RouteDef): Compiled {
  const keys: string[] = [];
  const src = r.path
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) {
        keys.push(seg.slice(1));
        return "([^/]{1,128})";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { ...r, re: new RegExp(`^${src}$`), keys };
}

const ROUTES: Compiled[] = [
  ...configRoutes,
  ...authRoutes,
  ...meRoutes,
  ...alertRoutes,
  ...supportRoutes,
  ...eventRoutes,
  ...billingRoutes,
  ...extRoutes,
  ...adminAuthRoutes,
  ...adminOverviewRoutes,
  ...adminUserRoutes,
  ...adminContentRoutes,
  ...adminSupportRoutes,
  ...adminEngineRoutes,
  ...brokerRoutes, // Zerodha Kite (owner-only admin routes, Kite callback/postback, relay Bearer routes)
].map(compile);

/** Exposed for docs/tests: every route as "METHOD path". */
export function routeTable(): string[] {
  return ROUTES.map((r) => `${r.method} ${r.path} [${r.auth}${r.cors ? ",cors" : ""}${r.csrf === "none" ? ",webhook" : ""}]`);
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const CORS_ALLOW_HEADERS = "authorization, content-type";

function corsHeaders(origin: string, methods: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": methods,
    "access-control-allow-headers": CORS_ALLOW_HEADERS,
    "access-control-expose-headers": "retry-after, content-disposition",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

export async function handleApi(request: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  let path = url.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  const method = request.method.toUpperCase();
  const origin = request.headers.get("origin");
  const extOrigin = isExtensionOrigin(origin) ? origin : null;

  const matches = ROUTES.filter((r) => r.re.test(path));
  if (!matches.length) return errorResponse(404, "not_found");

  if (method === "OPTIONS") {
    const wanted = (request.headers.get("access-control-request-method") ?? "").toUpperCase();
    const corsRoutes = matches.filter((r) => r.cors);
    if (extOrigin && corsRoutes.some((r) => r.method === wanted)) {
      return new Response(null, { status: 204, headers: corsHeaders(extOrigin, corsRoutes.map((r) => r.method).join(", ")) });
    }
    return errorResponse(403, "cors_not_allowed");
  }

  const route = matches.find((r) => r.method === method);
  if (!route) return errorResponse(405, "method_not_allowed", undefined, { allow: [...new Set(matches.map((r) => r.method))].join(", ") });

  const m = route.re.exec(path);
  const params: Record<string, string> = {};
  route.keys.forEach((k, i) => {
    params[k] = m?.[i + 1] ?? "";
  });

  let memoIp: Promise<string> | null = null;
  const c: Ctx = {
    req: request,
    env,
    exec,
    url,
    params,
    user: null,
    session: null,
    via: null,
    admin: null,
    cookies: [],
    ipHash: () => (memoIp ??= ipHash(env, request)),
  };
  const corsOrigin = route.cors && extOrigin ? extOrigin : null;

  let res: Response;
  try {
    res = await dispatch(c, route, method, origin, extOrigin);
  } catch (err) {
    if (err instanceof HttpError) {
      res = errorResponse(err.status, err.code, err.extra, err.headers);
    } else {
      logError("api", err, { route: `${route.method} ${route.path}` });
      res = errorResponse(500, "internal_error");
    }
  }

  if (Math.random() < 0.02) exec.waitUntil(prune(env).catch((e) => logError("prune", e)));

  if (!c.cookies.length && !corsOrigin) return res;
  const out = new Response(res.body, res);
  for (const ck of c.cookies) out.headers.append("set-cookie", ck);
  if (corsOrigin) {
    // Non-credentialed CORS only: no Access-Control-Allow-Credentials, ever.
    out.headers.set("access-control-allow-origin", corsOrigin);
    out.headers.set("access-control-expose-headers", "retry-after, content-disposition");
    out.headers.append("vary", "Origin");
  }
  return out;
}

async function dispatch(c: Ctx, route: Compiled, method: string, origin: string | null, extOrigin: string | null): Promise<Response> {
  const { env, req } = c;
  const isAdmin = route.auth === "admin" || route.path.startsWith("/api/admin/");
  const bearer = bearerToken(req);
  const hasBearer = bearer !== null;

  if (isAdmin && !env.ADMIN_PASSWORD) return json(ADMIN_NOT_CONFIGURED, {}, 503);

  /* ---- CSRF / origin policy ---- */
  if (route.csrf !== "none") {
    const fetchSite = req.headers.get("sec-fetch-site");
    if (MUTATING.has(method)) {
      if (method !== "DELETE" || Number(req.headers.get("content-length") ?? "0") > 0) requireJsonContentType(req);
      const bearerAuth = hasBearer && !isAdmin && (route.auth === "user" || route.auth === "optional") && !route.cookieOnly;
      const originOk =
        isAllowedWebOrigin(origin, req, env) || (route.csrf === "extension" && !!extOrigin) || (bearerAuth && (!origin || !!extOrigin || isAllowedWebOrigin(origin, req, env)));
      if (!originOk) throw new HttpError(403, "bad_origin", { message: "Cross-origin request refused" });
      if (fetchSite === "cross-site" && !bearerAuth && !(route.csrf === "extension" && extOrigin)) throw new HttpError(403, "bad_origin");
    } else if (isAdmin) {
      if (origin && !isAllowedWebOrigin(origin, req, env)) throw new HttpError(403, "bad_origin");
      if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") throw new HttpError(403, "bad_origin");
    }
  }

  /* ---- auth ---- */
  if (route.auth === "admin") {
    c.admin = await resolveAdmin(env, req);
    if (!c.admin) throw new HttpError(401, "admin_auth_required");
    if (MUTATING.has(method)) await enforce(env, `admin_write:${c.admin.sessionId}`, 300, 60);
  } else if (route.auth === "user" || route.auth === "optional") {
    if (bearer === "invalid") throw new HttpError(401, "invalid_token");
    if (hasBearer && route.cookieOnly) throw new HttpError(403, "cookie_session_required", { message: "Do this from the Tudumm website." });
    const r = await resolveUser(env, req);
    if (r && r.user.status === "suspended") {
      if (route.auth === "user") throw new HttpError(403, "account_suspended");
    } else if (r) {
      c.user = r.user;
      c.session = r.session;
      c.via = r.via;
      if (r.refreshCookie) c.cookies.push(r.refreshCookie);
    }
    if (route.auth === "user" && !c.user) throw new HttpError(401, hasBearer ? "invalid_token" : "auth_required");
    if (c.user && MUTATING.has(method) && !route.noWriteLimit) await enforce(env, `write:${c.user.id}`, 120, 60);
  }

  return route.handler(c);
}
