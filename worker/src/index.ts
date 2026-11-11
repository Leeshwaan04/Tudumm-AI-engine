// Tudumm Worker entry. OWNED BY THE ORCHESTRATOR — keep the dispatch contract stable:
//   /api/v1/market/*        -> market/routes.ts  handleMarket()   (data + engine agent)
//   /api/internal/ingest*   -> market/routes.ts  handleMarket()   (data + engine agent)
//   /api/*                  -> api/router.ts     handleApi()      (backend-core agent)
//   everything else         -> static assets (SPA), with security headers + optional UAT gate
//   scheduled (cron)        -> cron.ts           runScheduled()   (data + engine agent)
import type { Env } from "./env";
import { handleApi } from "./api/router";
import { handleMarket } from "./market/routes";
import { runScheduled } from "./cron";
import { secure, uatGate, json } from "./lib/edge";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // Canonical origin: https://tudumm.in (http -> https, www -> apex). Keeps __Host- cookies
    // on one host. workers.dev and localhost are left alone.
    if (url.hostname === "tudumm.in" || url.hostname === "www.tudumm.in") {
      if (url.protocol === "http:" || url.hostname === "www.tudumm.in") {
        url.protocol = "https:";
        url.hostname = "tudumm.in";
        return secure(Response.redirect(url.toString(), 301), pathname);
      }
    }

    if (pathname === "/__tudumm/ext-status") {
      return secure(json({ preview: true, path: "/extension/preview.html" }, { "cache-control": "no-store" }), pathname);
    }

    if (pathname.startsWith("/api/v1/market/") || pathname.startsWith("/api/internal/ingest")) {
      const res = await handleMarket(request, env, ctx);
      return secure(res ?? json({ error: "not_found" }, {}, 404), pathname);
    }

    if (pathname.startsWith("/api/")) {
      return secure(await handleApi(request, env, ctx), pathname);
    }

    const blocked = await uatGate(request, env, pathname);
    if (blocked) return secure(blocked, pathname);

    return secure(await env.ASSETS.fetch(request), pathname);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(event, env, ctx));
  },
} satisfies ExportedHandler<Env>;
