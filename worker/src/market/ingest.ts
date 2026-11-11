// POST /api/internal/ingest — the runner's (or GitHub Actions') path into D1 without wrangler.
// Bearer INGEST_TOKEN (503 when unset), strict validation, bounded sizes, then optional engine run.
import type { Env } from "../env";
import { json, safeEqual } from "../lib/edge";
import { BY_SYMBOL, SOURCES } from "./instruments";
import type { CandleRow, CandleTf, QuoteRow, SnapshotRow, SourceId } from "./types";
import { d1Db, healthStmts, pruneCandles, upsertCandles, upsertQuotes, upsertSnapshots } from "./store";
import { readFlag, runCycle } from "./service";
import { dispatchOutbox, dispatchPrices } from "./outbox";

const TFS = new Set<CandleTf>(["15m", "1H", "4H", "1D", "1W"]);
const SRC = new Set<string>(SOURCES.map((s) => s.id));
const AUX = new Set(["^VIX", "INDIAVIX"]);
const KEY_RE = /^(deriv|depth|fund|ctx):[A-Z^]{2,16}$|^meta:runner:[a-z-]{2,20}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const fin = (x: unknown, pos = false) => typeof x === "number" && Number.isFinite(x) && (!pos || x > 0);
const finOrNull = (x: unknown) => x === null || x === undefined || fin(x);

class Invalid extends Error {}
const need = (ok: boolean, what: string) => {
  if (!ok) throw new Invalid(what);
};

export async function handleIngest(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, { Allow: "POST" }, 405);
  if (!env.INGEST_TOKEN) return json({ error: "ingest_not_configured", hint: "Owner: run scripts/set-secrets.sh to set INGEST_TOKEN." }, {}, 503);
  const auth = request.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ") || !(await safeEqual(auth.slice(7).trim(), env.INGEST_TOKEN))) return json({ error: "unauthorized" }, {}, 401);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return json({ error: "unsupported_media_type" }, {}, 415);
  const len = Number(request.headers.get("content-length") ?? "0");
  if (len > 1_048_576) return json({ error: "payload_too_large" }, {}, 413);
  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > 1_048_576) return json({ error: "payload_too_large" }, {}, 413);
    body = JSON.parse(text) as Record<string, unknown>;
    need(!!body && typeof body === "object" && !Array.isArray(body), "body must be an object");
  } catch (e) {
    return json({ error: "bad_request", detail: e instanceof Invalid ? e.message : "invalid JSON" }, {}, 400);
  }
  const now = new Date();
  const nowIso = now.toISOString();
  let candles: CandleRow[] = [];
  let quotes: QuoteRow[] = [];
  let snaps: SnapshotRow[] = [];
  let health: { source: SourceId; ok: boolean; error: string | null }[] = [];
  let runEngine: string[] = [];
  try {
    const job = body.job;
    need(typeof job === "string" && /^[a-z-]{2,20}$/.test(job), "job must be a short lowercase name");
    const arr = (k: string, max: number) => {
      const v = body[k];
      if (v === undefined) return [] as unknown[];
      need(Array.isArray(v) && v.length <= max, `${k} must be an array of at most ${max}`);
      return v as unknown[];
    };
    candles = arr("candles", 2000).map((x) => {
      const c = x as CandleRow;
      need(!!BY_SYMBOL.get(c?.symbol) && TFS.has(c.tf) && Number.isInteger(c.t) && c.t > 946684800 && c.t < 4102444800, "candle symbol/tf/t invalid");
      need(fin(c.o, true) && fin(c.h, true) && fin(c.l, true) && fin(c.c, true) && fin(c.v) && c.v >= 0 && c.h >= c.l, "candle prices invalid");
      return { symbol: c.symbol, tf: c.tf, t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v };
    });
    quotes = arr("quotes", 50).map((x) => {
      const q = x as QuoteRow;
      need((!!BY_SYMBOL.get(q?.symbol) || AUX.has(q?.symbol)) && fin(q.price, true) && typeof q.asOf === "string" && ISO_RE.test(q.asOf) && SRC.has(q.source), "quote invalid");
      for (const k of ["prevClose", "changePct", "dayOpen", "dayHigh", "dayLow", "volume", "bid", "ask", "bidSize", "askSize"] as const) need(finOrNull(q[k]), `quote ${k} invalid`);
      return q;
    });
    snaps = arr("snapshots", 50).map((x) => {
      const s = x as SnapshotRow;
      need(typeof s?.key === "string" && KEY_RE.test(s.key) && typeof s.asOf === "string" && ISO_RE.test(s.asOf) && (SRC.has(s.source) || s.source === ("runner" as SourceId)), "snapshot key/asOf/source invalid");
      need(s.json !== undefined && JSON.stringify(s.json).length <= 262_144, "snapshot json too large");
      return s;
    });
    health = arr("health", 20).map((x) => {
      const h = x as { source: SourceId; ok: boolean; error?: string };
      need(SRC.has(h?.source) && typeof h.ok === "boolean", "health invalid");
      return { source: h.source, ok: h.ok, error: typeof h.error === "string" ? h.error.slice(0, 200) : null };
    });
    runEngine = arr("runEngine", 30).map((s) => {
      need(typeof s === "string" && BY_SYMBOL.has(s), "runEngine symbol unknown");
      return s as string;
    });
  } catch (e) {
    return json({ error: "bad_request", detail: e instanceof Invalid ? e.message : "invalid body" }, {}, 400);
  }
  const db = d1Db(env.DB);
  const pairs = [...new Map(candles.map((c) => [`${c.symbol}|${c.tf}`, { symbol: c.symbol, tf: c.tf }])).values()];
  await db.write([
    ...upsertCandles(candles),
    ...(candles.length ? pruneCandles(pairs, 400) : []),
    ...upsertQuotes(quotes, nowIso),
    ...upsertSnapshots(snaps, nowIso),
    ...healthStmts(health, nowIso),
  ]);
  let engine: unknown = null;
  if (runEngine.length) {
    const requireApproval = await readFlag(db, "require_signal_approval", false);
    engine = await runCycle(db, { now, runBy: "ingest", evaluate: runEngine, requireApproval });
    await dispatchOutbox(env, db);
    await dispatchPrices(env, db);
  }
  return json({ ok: true, wrote: { candles: candles.length, quotes: quotes.length, snapshots: snaps.length, health: health.length }, engine });
}
