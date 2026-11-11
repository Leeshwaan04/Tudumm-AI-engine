// Market data source: the universe from the Tudumm API with a 60 s cache.
// There is no fallback data set: when the API can't be reached (and there's no
// real data younger than 5 minutes to show, marked stale), the result is an
// explicit "offline" state and the surfaces say "Can't reach Tudumm — retrying".
//
// Pure ES module (fetch, storage and time are injected), so the same code runs
// in the background service worker, in preview pages and in Node tests.
//
// Universe shape (GET /api/v1/market/universe): meta, markets, layers,
// instruments[] (price, prevClose, changePct, source, freshness, asOf, stale,
// hasData, proxyNote, signal{engine:"v0", calibrated:false}), ledger[] (v2).

import { apiOrigin } from "./engine.js";

export const UNIVERSE_TTL_MS = 60_000;
/** A live universe that can't be refreshed is still shown (marked stale) for this long. */
export const STALE_LIVE_MAX_MS = 5 * 60_000;
/** After a failed fetch, don't hammer the API: serve the fallback for this long. */
export const FAIL_BACKOFF_MS = 20_000;
/** Offline: retry after 15 s, backing off to 60 s. */
export const OFFLINE_RETRY_MS = [15_000, 30_000, 60_000];
const MAX_BYTES = 3 * 1024 * 1024;
/** A universe with fewer priced instruments than this isn't usable: the surfaces say so instead. */
export const MIN_PRICED = 3;
const SYMBOL_RE = /^[A-Z0-9]{1,15}$/;
const MARKET_RE = /^[A-Z]{2,8}$/;

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const str = (v, max = 200) => (typeof v === "string" ? v.slice(0, max) : null);

/** Human text for a fallback reason code. */
export function reasonText(code, origin) {
  const host = (() => {
    try {
      return new URL(origin).host;
    } catch {
      return "the Tudumm API";
    }
  })();
  switch (code) {
    case "not-deployed":
      return `The live API isn't available at ${host} yet.`;
    case "network":
      return `Couldn't reach ${host}.`;
    case "timeout":
      return `${host} didn't answer in time.`;
    case "empty":
      return `${host} returned no instruments.`;
    case "too-few":
      return `Only a few instruments have live prices at ${host} right now.`;
    case "bad-data":
      return `The live data from ${host} didn't look right, so it isn't shown.`;
    case "too-big":
      return `The live data from ${host} was unexpectedly large.`;
    case "invalid-url":
      return "The web app URL in Options isn't a valid https address.";
    case "background":
      return "The extension's background didn't answer.";
    default:
      if (/^http-\d{3}$/.test(code || "")) return `${host} answered ${code.slice(5)}.`;
      return `Market data is unavailable (${host}).`;
  }
}

/**
 * Checks and copies a universe from the network. Returns { ok, universe, reason, withData }.
 * Untrusted input: only known fields are kept, numbers must be finite, strings are capped.
 * The UI renders everything as text, so this is about correctness, not escaping.
 */
export function sanitizeUniverse(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.instruments)) return { ok: false, reason: "bad-data" };
  // Only real data: the API marks its universe simulated:false.
  if (!raw.meta || raw.meta.simulated !== false) return { ok: false, reason: "bad-data" };
  const instruments = [];
  for (const r of raw.instruments.slice(0, 400)) {
    if (!r || typeof r !== "object" || typeof r.symbol !== "string" || !SYMBOL_RE.test(r.symbol)) continue;
    if (instruments.some((i) => i.symbol === r.symbol)) continue;
    const decimals = Number.isInteger(r.decimals) && r.decimals >= 0 && r.decimals <= 8 ? r.decimals : 2;
    const aliases = [...new Set((Array.isArray(r.aliases) ? r.aliases : []).filter((a) => typeof a === "string" && a.length <= 40))].slice(0, 30);
    const price = finite(r.price) && r.price > 0 ? r.price : null;
    instruments.push({
      symbol: r.symbol,
      name: str(r.name, 80) || r.symbol,
      exchange: str(r.exchange, 40) || "",
      market: typeof r.market === "string" && MARKET_RE.test(r.market) ? r.market : "OTHER",
      assetClass: str(r.assetClass, 16) || "equity",
      currency: typeof r.currency === "string" && /^[A-Z]{3,4}$/.test(r.currency) ? r.currency : "USD",
      decimals,
      price,
      prevClose: finite(r.prevClose) && r.prevClose > 0 ? r.prevClose : null,
      changePct: finite(r.changePct) ? r.changePct : null,
      aliases,
      source: str(r.source, 32),
      dataSymbol: typeof r.dataSymbol === "string" && SYMBOL_RE.test(r.dataSymbol) ? r.dataSymbol : null,
      freshness: str(r.freshness, 24),
      asOf: typeof r.asOf === "string" && Number.isFinite(Date.parse(r.asOf)) ? r.asOf : null,
      stale: r.stale === true,
      hasData: r.hasData === false ? false : price != null,
      proxyNote: str(r.proxyNote, 400),
      ohlc: r.ohlc !== false,
      live: true,
      engine: str(r.engine, 8) || "v0",
      calibrated: r.calibrated === true,
      signal: r.signal && typeof r.signal === "object" ? r.signal : null,
    });
  }
  const withData = instruments.filter((i) => i.price != null).length;
  if (!instruments.length) return { ok: false, reason: "empty", withData };
  if (withData < MIN_PRICED) return { ok: false, reason: "too-few", withData };
  const markets = Array.isArray(raw.markets) ? raw.markets.filter((m) => m && typeof m.id === "string" && MARKET_RE.test(m.id)).map((m) => ({ id: m.id, label: str(m.label, 40) || m.id })) : [];
  const layers = Array.isArray(raw.layers) ? raw.layers.filter((l) => l && typeof l.id === "string").map((l) => ({ id: str(l.id, 24), label: str(l.label, 40) || l.id, short: str(l.short, 12) || l.id })) : [];
  const ledger = Array.isArray(raw.ledger)
    ? raw.ledger
        .slice(-500)
        .filter((e) => e && typeof e === "object" && typeof e.hash === "string" && /^[0-9a-f]{64}$/.test(e.hash))
        .map((e) => ({ seq: e.seq, type: e.type === "close" ? "close" : "issue", signalId: str(e.signalId, 64), symbol: str(e.symbol, 15), direction: str(e.direction, 5), r: finite(e.r) ? e.r : null, outcome: str(e.outcome, 16), at: str(e.at, 40), hash: e.hash, prevHash: str(e.prevHash, 64) }))
    : [];
  const meta = {
    simulated: false,
    live: true,
    engine: str(raw.meta.engine, 8) || "v0",
    calibrated: raw.meta.calibrated === true,
    note: str(raw.meta.note, 400),
    generatedAt: str(raw.meta.generatedAt, 40),
    ledgerVersion: raw.meta.ledgerVersion,
  };
  return { ok: true, universe: { meta, markets, layers, instruments, ledger }, withData };
}

/** GET {origin}/api/v1/market/universe → { ok, universe?, reason? }. Never throws. */
export async function fetchUniverse(origin, { fetchImpl = globalThis.fetch, timeoutMs = 7000, path = "/api/v1/market/universe" } = {}) {
  if (!origin) return { ok: false, reason: "invalid-url" };
  let res;
  try {
    const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
    res = await fetchImpl(`${origin}${path}`, { method: "GET", credentials: "omit", cache: "no-store", headers: { accept: "application/json" }, signal });
  } catch (err) {
    return { ok: false, reason: err && (err.name === "TimeoutError" || err.name === "AbortError") ? "timeout" : "network" };
  }
  const type = (res.headers && res.headers.get && res.headers.get("content-type")) || "";
  if (res.status === 404 || (res.ok && !/json/i.test(type))) return { ok: false, reason: "not-deployed" };
  if (!res.ok) return { ok: false, reason: `http-${res.status}` };
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_BYTES) return { ok: false, reason: "too-big" };
  let raw;
  try {
    const body = await res.text();
    if (body.length > MAX_BYTES) return { ok: false, reason: "too-big" };
    raw = JSON.parse(body);
  } catch {
    return { ok: false, reason: "bad-data" };
  }
  return sanitizeUniverse(raw);
}

/**
 * The cached source every surface reads through.
 *   get({ force }) → { mode: "live", universe, fetchedAt, origin, stale, reason, reasonText }
 *                  | { mode: "offline", origin, reason, reasonText, retryInMs }
 */
export function createUniverseSource({ fetchImpl = globalThis.fetch, getSettings, now = () => Date.now(), cache = null, apiOriginFor = apiOrigin, ttlMs = UNIVERSE_TTL_MS, path }) {
  let mem = null; // last live payload
  let failUntil = 0;
  let failReason = null;
  let failOrigin = null;
  let failures = 0;
  let inflight = null;

  function offline(reason, origin) {
    const retryInMs = OFFLINE_RETRY_MS[Math.min(Math.max(failures - 1, 0), OFFLINE_RETRY_MS.length - 1)];
    return { mode: "offline", universe: null, fetchedAt: now(), origin: origin || null, reason, reasonText: reasonText(reason, origin), retryInMs, stale: false };
  }

  async function readCache(origin) {
    if (mem && mem.origin === origin) return mem;
    if (!cache) return null;
    try {
      const hit = await cache.get();
      if (hit && hit.mode === "live" && hit.origin === origin && hit.universe) {
        mem = hit;
        return hit;
      }
    } catch {
      /* cache unavailable */
    }
    return null;
  }

  async function refresh(origin) {
    const r = await fetchUniverse(origin, { fetchImpl, ...(path ? { path } : {}) });
    if (r.ok) {
      const payload = { mode: "live", universe: r.universe, fetchedAt: now(), origin, reason: null, reasonText: null, stale: false };
      mem = payload;
      failUntil = 0;
      failReason = null;
      failures = 0;
      if (cache) {
        try {
          await cache.set(payload);
        } catch {
          /* quota or unavailable: memory only */
        }
      }
      return payload;
    }
    failures++;
    failUntil = now() + FAIL_BACKOFF_MS;
    failReason = r.reason;
    failOrigin = origin;
    return null;
  }

  async function get({ force = false } = {}) {
    const settings = await getSettings();
    const origin = apiOriginFor(settings.webUrl);
    if (!origin) return offline("invalid-url", null);
    const cached = await readCache(origin);
    const age = cached ? now() - cached.fetchedAt : Infinity;
    if (cached && age < ttlMs && !force) return cached;
    const failing = failOrigin === origin && now() < failUntil && !force;
    if (!failing) {
      if (!inflight) inflight = refresh(origin).finally(() => (inflight = null));
      const fresh = await inflight;
      if (fresh) return fresh;
    }
    const reason = failReason || "network";
    // Real data from a few minutes ago is still shown, clearly marked stale.
    if (cached && age < STALE_LIVE_MAX_MS) return { ...cached, stale: true, reason, reasonText: reasonText(reason, origin) };
    return offline(reason, origin);
  }

  return {
    get,
    /** Forget the cached payload (e.g. the web URL changed). */
    invalidate() {
      mem = null;
      failUntil = 0;
      failReason = null;
      failures = 0;
      if (cache && cache.clear) Promise.resolve(cache.clear()).catch(() => {});
    },
  };
}
