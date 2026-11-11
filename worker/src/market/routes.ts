// Public market API (/api/v1/market/*, all GET) + POST /api/internal/ingest. Return null when unmatched.
import type { Env } from "../env";
import { json } from "../lib/edge";
import { resolveSymbol, SOURCES } from "./instruments";
import { d1Db, stmt } from "./store";
import type { MarketDb } from "./store";
import { buildUniverse, ledgerOut, publicSignal } from "./universe";
import { candlesView, contextView, depthView, derivativesView, fundamentalsView } from "./views";
import { engineHealth } from "./admin";
import { handleIngest } from "./ingest";
import type { SignalRow } from "./service";
import { parseJson } from "./store";

const TFS = new Set(["15m", "1H", "4H", "1D", "1W"]);

function bad(detail: string): Response {
  return json({ error: "bad_request", detail }, {}, 400);
}

function intParam(v: string | null, def: number, min: number, max: number): number | null {
  if (v === null || v === "") return def;
  if (!/^\d{1,7}$/.test(v)) return null;
  const n = Number(v);
  return n < min || n > max ? null : n;
}

/** Serve from the Workers Cache API when possible (a no-op where the cache isn't available). */
async function cached(request: Request, ctx: ExecutionContext, maxAge: number, build: () => Promise<unknown>): Promise<Response> {
  const cache = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
  const key = new Request(new URL(request.url).toString(), { method: "GET" });
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return new Response(hit.body, hit);
    } catch {
      /* ignore */
    }
  }
  const body = await build();
  const res = json(body, { "Cache-Control": `public, max-age=${maxAge}` });
  if (cache) {
    try {
      ctx.waitUntil(cache.put(key, res.clone()));
    } catch {
      /* ignore */
    }
  }
  return res;
}

export async function handleMarket(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "/api/internal/ingest") return handleIngest(request, env, ctx);
  if (!path.startsWith("/api/v1/market/")) return null;
  const route = path.slice("/api/v1/market/".length);
  const known = ["universe", "candles", "depth", "derivatives", "fundamentals", "context", "ledger", "ledger/head", "sources", "health", "signal"];
  if (!known.includes(route)) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method_not_allowed" }, { Allow: "GET" }, 405);
  const db: MarketDb = d1Db(env.DB);
  const p = url.searchParams;
  try {
    switch (route) {
      case "universe":
        return cached(request, ctx, 30, () => buildUniverse(db));
      case "sources":
        return cached(request, ctx, 60, async () => {
          const h = await engineHealth(env);
          const by = new Map(h.sources.map((s) => [s.source, s]));
          const [rows] = await db.read([stmt(`SELECT source, last_run_at FROM source_health`)]);
          const runAt = new Map((rows ?? []).map((r) => [String(r.source), r.last_run_at === null ? null : String(r.last_run_at)]));
          return {
            sources: SOURCES.map((s) => {
              const x = by.get(s.id);
              return { ...s, health: { ok: x?.ok ?? false, lastSuccessAt: x?.lastSuccessAt ?? null, lastError: x?.lastError ?? null, lastRunAt: runAt.get(s.id) ?? null, staleSeconds: x?.staleSeconds ?? null } };
            }),
            note: "Free sources for build and UAT. Several are personal/non-commercial or need a data licence before a paid launch (see commercialUse/license).",
          };
        });
      case "health":
        return cached(request, ctx, 30, async () => {
          const h = await engineHealth(env);
          const [rows] = await db.read([stmt(`SELECT key, as_of FROM snapshots WHERE key IN ('meta:runner:nse-eod', 'meta:runner:us-daily', 'meta:runner:fx-backfill')`)]);
          const r = new Map((rows ?? []).map((x) => [String(x.key), String(x.as_of)]));
          return {
            ok: h.sources.some((s) => s.ok),
            engine: "v0",
            calibrated: false,
            lastRunAt: h.lastRunAt,
            liveSignals: h.liveSignals,
            ledgerEntries: h.ledgerEntries,
            sources: h.sources.map((s) => ({ source: s.source, ok: s.ok, staleSeconds: s.staleSeconds, freshness: s.freshness })),
            runner: { nseEod: r.get("meta:runner:nse-eod") ?? null, usDaily: r.get("meta:runner:us-daily") ?? null, fx: r.get("meta:runner:fx-backfill") ?? null },
          };
        });
      case "ledger/head":
        return cached(request, ctx, 15, async () => {
          const [rows] = await db.read([stmt(`SELECT COUNT(*) AS n, MAX(seq) AS s FROM live_ledger`)]);
          const n = Number(rows?.[0]?.n ?? 0);
          const [h] = await db.read([stmt(`SELECT hash, at FROM live_ledger ORDER BY seq DESC LIMIT 1`)]);
          return { count: n, headSeq: n ? Number(rows?.[0]?.s) : 0, headHash: h?.[0] ? String(h[0].hash) : "0".repeat(64), asOf: h?.[0] ? String(h[0].at) : null };
        });
      case "ledger": {
        const cursor = intParam(p.get("cursor"), 0, 0, 1e9);
        const limit = intParam(p.get("limit"), 100, 1, 500);
        if (cursor === null || limit === null) return bad("cursor must be an integer >= 0; limit 1..500");
        return cached(request, ctx, 30, async () => {
          const [rows, cnt, head] = await db.read([
            stmt(`SELECT * FROM live_ledger WHERE seq > ? ORDER BY seq LIMIT ?`, cursor, limit + 1),
            stmt(`SELECT COUNT(*) AS n FROM live_ledger`),
            stmt(`SELECT hash FROM live_ledger ORDER BY seq DESC LIMIT 1`),
          ]);
          const entries = (rows ?? []).slice(0, limit).map(ledgerOut);
          const more = (rows ?? []).length > limit;
          return { entries, nextCursor: more && entries.length ? (entries[entries.length - 1]?.seq ?? null) : null, count: Number(cnt?.[0]?.n ?? 0), headHash: head?.[0] ? String(head[0].hash) : "0".repeat(64) };
        });
      }
      case "signal": {
        const id = p.get("id") ?? "";
        if (!/^SIG-[A-Z0-9]{1,16}-\d{8}T\d{4}$/.test(id)) return bad("id must look like SIG-SYMBOL-YYYYMMDDTHHMM");
        const [rows, evs] = await db.read([
          stmt(`SELECT * FROM live_signals WHERE id = ? AND published = 1 AND held = 0`, id),
          stmt(`SELECT type, at, detail FROM signal_events WHERE signal_id = ? AND type NOT IN ('held', 'released') ORDER BY id`, id),
        ]);
        const row = rows?.[0] as unknown as SignalRow | undefined;
        if (!row) return json({ error: "not_found" }, {}, 404);
        return json({ signal: publicSignal(row, Date.now()), events: (evs ?? []).map((e) => ({ type: e.type, at: e.at, detail: parseJson(e.detail, null) })) }, { "Cache-Control": "public, max-age=15" });
      }
    }
    // symbol routes
    const inst = resolveSymbol(p.get("symbol"));
    if (!p.get("symbol")) return bad("symbol is required");
    if (!inst) return json({ error: "unknown_symbol" }, {}, 404);
    switch (route) {
      case "candles": {
        const tf = p.get("tf") ?? inst.tf;
        if (!TFS.has(tf)) return bad("tf must be one of 15m, 1H, 4H, 1D, 1W");
        const limit = intParam(p.get("limit"), 300, 1, 1000);
        if (limit === null) return bad("limit must be 1..1000");
        return cached(request, ctx, inst.source === "binance" ? 30 : 300, () => candlesView(db, inst, tf, limit));
      }
      case "depth":
        return cached(request, ctx, 5, () => depthView(db, inst));
      case "derivatives":
        return cached(request, ctx, 60, () => derivativesView(db, inst));
      case "fundamentals":
        return cached(request, ctx, 300, () => fundamentalsView(db, inst));
      case "context":
        return cached(request, ctx, 300, () => contextView(db, inst));
    }
    return null;
  } catch (e) {
    console.error("market route error", route, e instanceof Error ? e.message : "error");
    return json({ error: "market_unavailable", detail: "The market store isn't ready (has 0002_market.sql been applied?)." }, {}, 503);
  }
}
