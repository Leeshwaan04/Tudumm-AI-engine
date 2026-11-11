// Worker-side fetch jobs (light: small JSON only). Heavy sources (NSE zips, Cboe history/chains,
// SEC companyfacts) are the runner's job. Each job returns writes + in-memory data for the engine.
import type { Candle } from "../engine/types";
import { roundTo } from "../engine/util";
import type { CandleRow, QuoteRow, SnapshotRow } from "./types";
import { BY_SYMBOL, INSTRUMENTS } from "./instruments";
import type { MarketDb, SqlStmt } from "./store";
import { jsonList, parseJson, readSnapshotsStmt, stmt, upsertCandles, upsertQuotes, upsertSnapshots, pruneCandles } from "./store";
import type { Health } from "../data/http";
import { tryFetch } from "../data/http";
import { fetchBybit, fetchDepth, fetchKlines, fetchOiHist, fetchPremiumIndex, fetchTickers } from "../data/binance";
import { fetchFng } from "../data/feargreed";
import { fetchQuote } from "../data/cboe";
import type { FxPoint } from "../data/frankfurter";
import { dayT, fetchFxSeries } from "../data/frankfurter";
import type { FngSnapshot, PerpSnapshot } from "./snapshots";
import { buildDepthSnapshot, buildUpOf, oiChangeFromSamples } from "./snapshots";

export interface JobOutput {
  writes: SqlStmt[];
  memBars: Record<string, Candle[]>;
  memSnapshots: Record<string, { json: unknown; asOf: string }>;
  memQuotes: Record<string, { price: number; prevClose: number | null; asOf: string }>;
  prices: Record<string, number>;
  symbols: string[]; // instruments refreshed
}

const empty = (): JobOutput => ({ writes: [], memBars: {}, memSnapshots: {}, memQuotes: {}, prices: {}, symbols: [] });

export const BINANCE_SET = INSTRUMENTS.filter((i) => i.source === "binance");
export const CBOE_SET = INSTRUMENTS.filter((i) => i.source === "cboe");
export const FX_SET = INSTRUMENTS.filter((i) => i.source === "ecb-frankfurter");

/* ---------------- crypto + PAXG (every 15 min) ---------------- */
export async function cryptoJob(db: MarketDb, health: Health, now: Date): Promise<JobOutput> {
  const out = empty();
  const nowIso = now.toISOString();
  const nowSec = Math.floor(now.getTime() / 1000);
  const syms = BINANCE_SET.map((i) => i.dataSymbol);
  const perpDefs = BINANCE_SET.filter((i) => i.derivKind === "perp");
  const [counts, prevSnaps] = await db.read([
    stmt(`SELECT symbol, COUNT(*) AS n FROM candles WHERE tf = '4H' AND symbol IN (SELECT value FROM json_each(?)) GROUP BY symbol`, jsonList(BINANCE_SET.map((i) => i.symbol))),
    readSnapshotsStmt([...perpDefs.map((i) => `deriv:${i.symbol}`), "ctx:CRYPTO"]),
  ]);
  const have = new Map((counts ?? []).map((r) => [String(r.symbol), Number(r.n)]));
  const prev = new Map((prevSnaps ?? []).map((r) => [String(r.key), { json: parseJson<unknown>(r.json, null), asOf: String(r.as_of) }]));

  const fngPrev = prev.get("ctx:CRYPTO");
  const fngDue = !fngPrev || nowSec - Math.floor(Date.parse(fngPrev.asOf) / 1000) > 3 * 3600;
  const [tickers, klines, depths, perps, fng] = await Promise.all([
    tryFetch(health, "binance", () => fetchTickers(syms)),
    Promise.all(BINANCE_SET.map((i) => tryFetch(health, "binance", () => fetchKlines(i.dataSymbol, "4h", 250)))),
    Promise.all(BINANCE_SET.map((i) => tryFetch(health, "binance", () => fetchDepth(i.dataSymbol, 100)))),
    Promise.all(
      perpDefs.map(async (i) => {
        const [pi, oih] = await Promise.all([
          tryFetch(health, "binance-futures", () => fetchPremiumIndex(i.dataSymbol)),
          tryFetch(health, "binance-futures", () => fetchOiHist(i.dataSymbol)),
        ]);
        const by = pi ? null : await tryFetch(health, "bybit", () => fetchBybit(i.dataSymbol));
        return { i, pi, oih, by };
      }),
    ),
    fngDue ? tryFetch(health, "alternative-me", () => fetchFng()) : Promise.resolve(null),
  ]);

  const quotes: QuoteRow[] = [];
  const candles: CandleRow[] = [];
  const snaps: SnapshotRow[] = [];
  const tick = new Map((tickers ?? []).map((t) => [t.symbol, t]));
  BINANCE_SET.forEach((i, k) => {
    const t = tick.get(i.dataSymbol);
    const bars = klines[k];
    if (t) {
      const q: QuoteRow = { symbol: i.symbol, price: t.last, prevClose: t.open > 0 ? t.open : null, changePct: roundTo(t.changePct, 3), dayOpen: t.open, dayHigh: t.high, dayLow: t.low, volume: t.volume, bid: t.bid, ask: t.ask, bidSize: t.bidQty, askSize: t.askQty, asOf: nowIso, source: "binance" };
      quotes.push(q);
      out.memQuotes[i.symbol] = { price: t.last, prevClose: q.prevClose, asOf: nowIso };
      out.prices[i.symbol] = t.last;
    }
    if (bars && bars.length) {
      out.memBars[i.symbol] = bars;
      const keep = (have.get(i.symbol) ?? 0) < 200 ? bars : bars.slice(-3);
      for (const b of keep) candles.push({ symbol: i.symbol, tf: "4H", t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    }
    const d = depths[k];
    if (d) {
      const ds = buildDepthSnapshot(i.symbol, "Binance", d.bids, d.asks, nowIso);
      if (ds) {
        snaps.push({ key: `depth:${i.symbol}`, json: ds, asOf: nowIso, source: "binance" });
        out.memSnapshots[`depth:${i.symbol}`] = { json: ds, asOf: nowIso };
      }
    }
    if (t || bars) out.symbols.push(i.symbol);
  });

  for (const { i, pi, oih, by } of perps) {
    const old = prev.get(`deriv:${i.symbol}`)?.json as PerpSnapshot | null | undefined;
    const t = tick.get(i.dataSymbol);
    const priceChg = t ? t.changePct : by ? by.price24hPcnt * 100 : null;
    let s: PerpSnapshot | null = null;
    if (pi) {
      const first = oih?.[0];
      const last = oih?.[oih.length - 1];
      const oiChg = first && last && first.oi > 0 ? roundTo(((last.oi - first.oi) / first.oi) * 100, 2) : null;
      const samples: [number, number][] = [...(old?.oiSamples ?? []), ...(last ? [[Math.floor(last.t / 1000), last.oi] as [number, number]] : [])].slice(-100);
      s = perpSnap(i.symbol, "Binance USDⓈ-M perpetual", "binance-futures", nowIso, {
        mark: pi.markPrice, index: pi.indexPrice, funding: pi.fundingRate, interval: 8, next: pi.nextFundingTime,
        oi: last?.oi ?? null, oiUsd: last?.oiUsd ?? null, oiChg, window: oih && oih.length > 1 ? `${Math.round(((last?.t ?? 0) - (first?.t ?? 0)) / 3600000)}h` : null, priceChg, samples,
      });
    } else if (by) {
      const samples: [number, number][] = [...(old?.oiSamples ?? []), [nowSec, by.openInterest] as [number, number]].slice(-100);
      const ch = oiChangeFromSamples(samples, nowSec);
      s = perpSnap(i.symbol, "Bybit linear perpetual (fallback)", "bybit", nowIso, {
        mark: by.markPrice, index: by.indexPrice, funding: by.fundingRate, interval: by.fundingIntervalHours, next: by.nextFundingTime,
        oi: by.openInterest, oiUsd: by.openInterestValue, oiChg: ch.pct, window: ch.window, priceChg, samples,
      });
      s.notes.push("Binance futures was unreachable from this region; Bybit is the fallback. OI change comes from Tudumm's own 15-minute samples.");
    }
    if (s) {
      snaps.push({ key: `deriv:${i.symbol}`, json: s, asOf: nowIso, source: s.source });
      out.memSnapshots[`deriv:${i.symbol}`] = { json: s, asOf: nowIso };
    }
  }
  if (fng && fng.length) {
    const f: FngSnapshot = { points: fng.slice(0, 30), asOf: nowIso };
    snaps.push({ key: "ctx:CRYPTO", json: f, asOf: nowIso, source: "alternative-me" });
    out.memSnapshots["ctx:CRYPTO"] = { json: f, asOf: nowIso };
  }
  out.writes.push(...upsertQuotes(quotes, nowIso), ...upsertCandles(candles), ...upsertSnapshots(snaps, nowIso));
  if (candles.length > 20) out.writes.push(...pruneCandles(BINANCE_SET.map((i) => ({ symbol: i.symbol, tf: "4H" })), 400));
  return out;
}

function perpSnap(
  symbol: string,
  venue: string,
  source: "binance-futures" | "bybit",
  asOf: string,
  x: { mark: number; index: number; funding: number; interval: number; next: number; oi: number | null; oiUsd: number | null; oiChg: number | null; window: string | null; priceChg: number | null; samples: [number, number][] },
): PerpSnapshot {
  const fin = (v: number) => (Number.isFinite(v) && v > 0 ? v : null);
  const mark = fin(x.mark);
  const index = fin(x.index);
  return {
    kind: "perp",
    symbol,
    venue,
    markPrice: mark,
    indexPrice: index,
    premiumPct: mark && index ? roundTo(((mark - index) / index) * 100, 4) : null,
    fundingRate: Number.isFinite(x.funding) ? x.funding : null,
    fundingPct: Number.isFinite(x.funding) ? roundTo(x.funding * 100, 5) : null,
    fundingIntervalHours: x.interval,
    fundingAnnualizedPct: Number.isFinite(x.funding) ? roundTo(x.funding * 100 * (24 / x.interval) * 365, 2) : null,
    nextFundingTime: Number.isFinite(x.next) && x.next > 0 ? new Date(x.next).toISOString() : null,
    openInterest: { contracts: x.oi, usd: x.oiUsd !== null && Number.isFinite(x.oiUsd) ? Math.round(x.oiUsd) : null, change24hPct: x.oiChg, window: x.window },
    priceChange24hPct: x.priceChg === null ? null : roundTo(x.priceChg, 2),
    buildUp: x.oiChg !== null && x.priceChg !== null ? buildUpOf(x.priceChg, x.oiChg, `perp OI over ${x.window ?? "24h"} vs 24h spot price change`) : null,
    oiSamples: x.samples,
    longShortRatio: null,
    liquidations: null,
    notes: ["Long/short ratio and liquidation maps are not on the free feeds Tudumm uses."],
    source,
    asOf,
  };
}

/* ---------------- US delayed quotes (every 15 min in US hours) ---------------- */
export function usSessionOpen(now: Date): boolean {
  const dow = now.getUTCDay();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return dow >= 1 && dow <= 5 && mins >= 13 * 60 + 15 && mins <= 21 * 60 + 30;
}

export async function usQuotesJob(health: Health, now: Date): Promise<JobOutput> {
  const out = empty();
  const nowIso = now.toISOString();
  const list = [...CBOE_SET.map((i) => ({ sym: i.symbol, data: i.dataSymbol })), { sym: "^VIX", data: "_VIX" }];
  const qs = await Promise.all(list.map((x) => tryFetch(health, "cboe", () => fetchQuote(x.data))));
  const quotes: QuoteRow[] = [];
  const candles: CandleRow[] = [];
  list.forEach((x, k) => {
    const q = qs[k];
    if (!q) return;
    quotes.push({ symbol: x.sym, price: q.price, prevClose: q.prevClose, changePct: q.changePct, dayOpen: q.open, dayHigh: q.high, dayLow: q.low, volume: q.volume, bid: q.bid, ask: q.ask, bidSize: q.bidSize, askSize: q.askSize, asOf: q.asOf, source: "cboe" });
    if (x.sym === "^VIX") return;
    out.memQuotes[x.sym] = { price: q.price, prevClose: q.prevClose, asOf: q.asOf };
    out.prices[x.sym] = q.price;
    out.symbols.push(x.sym);
    // today's daily bar from the delayed quote (session date from Cboe's ET last-trade time)
    const date = q.lastTradeEt?.slice(0, 10);
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date) && q.open && q.high && q.low && (q.volume ?? 0) > 0) {
      candles.push({ symbol: x.sym, tf: "1D", t: dayT(date), o: q.open, h: Math.max(q.high, q.price), l: Math.min(q.low, q.price), c: q.price, v: q.volume ?? 0 });
    }
  });
  out.writes.push(...upsertQuotes(quotes, nowIso), ...upsertCandles(candles));
  return out;
}

/* ---------------- ECB FX (daily, light) ---------------- */
export function fxRows(points: FxPoint[], asOf: string): { candles: CandleRow[]; quotes: QuoteRow[]; usd: SnapshotRow | null } {
  const candles: CandleRow[] = [];
  for (const p of points) {
    for (const s of ["EURUSD", "USDINR", "USDJPY"] as const) {
      const v = p[s];
      candles.push({ symbol: s, tf: "1D", t: dayT(p.date), o: v, h: v, l: v, c: v, v: 0 });
    }
  }
  const quotes: QuoteRow[] = [];
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  if (last) {
    const at = `${last.date}T15:00:00.000Z`; // ECB fix ~16:00 CET
    for (const s of ["EURUSD", "USDINR", "USDJPY"] as const) {
      const pc = prev ? prev[s] : null;
      quotes.push({ symbol: s, price: last[s], prevClose: pc, changePct: pc ? roundTo(((last[s] - pc) / pc) * 100, 3) : null, asOf: at, source: "ecb-frankfurter" });
    }
  }
  let usd: SnapshotRow | null = null;
  const p20 = points[points.length - 21];
  if (last && p20) {
    const ch = roundTo(((last.EURUSD - p20.EURUSD) / p20.EURUSD) * 100, 2);
    usd = { key: "ctx:USD", json: { eurusdChange20dPct: ch, asOf }, asOf, source: "ecb-frankfurter" };
  }
  return { candles, quotes, usd };
}

export async function fxJob(db: MarketDb, health: Health, now: Date): Promise<JobOutput> {
  const out = empty();
  const nowIso = now.toISOString();
  const end = nowIso.slice(0, 10);
  const start = new Date(now.getTime() - 420 * 86400000).toISOString().slice(0, 10);
  const [cnt] = await db.read([stmt(`SELECT symbol, COUNT(*) AS n, MAX(t) AS mt FROM candles WHERE tf = '1D' AND symbol IN ('EURUSD', 'USDINR', 'USDJPY') GROUP BY symbol`)]);
  const minCount = Math.min(...["EURUSD", "USDINR", "USDJPY"].map((s) => Number((cnt ?? []).find((r) => r.symbol === s)?.n ?? 0)));
  const maxT = Math.min(...["EURUSD", "USDINR", "USDJPY"].map((s) => Number((cnt ?? []).find((r) => r.symbol === s)?.mt ?? 0)));
  const pts = await tryFetch(health, "ecb-frankfurter", () => fetchFxSeries(start, end));
  if (!pts || !pts.length) return out;
  const { candles, quotes, usd } = fxRows(pts, nowIso);
  const keep = minCount < 200 ? candles : candles.filter((c) => c.t > maxT - 5 * 86400);
  out.writes.push(...upsertCandles(keep), ...upsertQuotes(quotes, nowIso), ...(usd ? upsertSnapshots([usd], nowIso) : []));
  if (keep.length > 20) out.writes.push(...pruneCandles(FX_SET.map((i) => ({ symbol: i.symbol, tf: "1D" })), 400));
  for (const q of quotes) {
    out.memQuotes[q.symbol] = { price: q.price, prevClose: q.prevClose, asOf: q.asOf };
    out.prices[q.symbol] = q.price;
    out.symbols.push(q.symbol);
  }
  if (usd) out.memSnapshots["ctx:USD"] = { json: usd.json, asOf: usd.asOf };
  return out;
}

/** Daily instruments whose newest COMPLETED bar hasn't been evaluated yet (bounded per run). */
export async function dueDailyEvaluations(db: MarketDb, now: Date, max: number): Promise<string[]> {
  const nowSec = Math.floor(now.getTime() / 1000);
  const [latest, state] = await db.read([
    stmt(`SELECT symbol, MAX(t) AS mt FROM candles WHERE tf = '1D' GROUP BY symbol`),
    stmt(`SELECT symbol, last_bar_t FROM engine_state`),
  ]);
  const evaluated = new Map((state ?? []).map((r) => [String(r.symbol), r.last_bar_t === null ? null : Number(r.last_bar_t)]));
  const due: { s: string; t: number }[] = [];
  for (const r of latest ?? []) {
    const i = BY_SYMBOL.get(String(r.symbol));
    if (!i || i.tf !== "1D") continue;
    // the newest completed bar (today's US bar isn't final until after the close)
    let t = Number(r.mt);
    if (t + i.closeOffsetSec > nowSec) t -= 86400;
    const last = evaluated.get(i.symbol);
    if (last === undefined || last === null || t > last) due.push({ s: i.symbol, t });
  }
  // benchmarks first so their trend is current, then the oldest pending
  due.sort((a, b) => (a.s === "SPY" || a.s === "NIFTY" ? -1 : 0) - (b.s === "SPY" || b.s === "NIFTY" ? -1 : 0) || a.t - b.t);
  return due.slice(0, max).map((d) => d.s);
}
