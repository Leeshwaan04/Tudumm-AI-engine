// Response builders for /derivatives, /fundamentals, /context, /depth, /candles (shapes in README-market.md).
import type { Candle } from "../engine/types";
import { percentileRank, roundTo } from "../engine/util";
import type { InstrumentDef } from "./types";
import { naReasons } from "./instruments";
import type { MarketDb } from "./store";
import { parseJson, readCandlesStmt, readSnapshotsStmt, stmt } from "./store";
import type { ChainSnapshot, DepthSnapshot, FngSnapshot, IndexFundSnapshot, PerpSnapshot, UsdSnapshot, VixHistorySnapshot } from "./snapshots";
import { benchmarkTrend, buildDepthSnapshot } from "./snapshots";
import type { SecFundamentals } from "../data/sec";
import { peOf } from "./inputs";
import { BINANCE_TF, fetchDepth, fetchKlines } from "../data/binance";
import { bybitVenueLabel, fetchBybitDepth, fetchBybitKlines } from "../data/bybit";

async function snaps(db: MarketDb, keys: string[]) {
  const [rows] = await db.read([readSnapshotsStmt(keys)]);
  return new Map((rows ?? []).map((r) => [String(r.key), { json: parseJson<unknown>(r.json, null), asOf: String(r.as_of), source: String(r.source) }]));
}

async function quotes(db: MarketDb, syms: string[]) {
  const [rows] = await db.read([stmt(`SELECT * FROM quotes WHERE symbol IN (SELECT value FROM json_each(?))`, JSON.stringify(syms))]);
  return new Map((rows ?? []).map((r) => [String(r.symbol), r]));
}

/* ---------------- derivatives ---------------- */
export async function derivativesView(db: MarketDb, i: InstrumentDef) {
  if (i.derivKind === "none") {
    return { available: false, kind: i.assetClass === "fx" || i.assetClass === "commodity" ? "futures" : "none", symbol: i.symbol, reason: naReasons(i).derivatives ?? "No free derivatives feed for this instrument." };
  }
  const s = (await snaps(db, [`deriv:${i.symbol}`])).get(`deriv:${i.symbol}`);
  if (!s || !s.json) {
    const who = i.source === "nse-archives" ? "the NSE end-of-day runner job" : i.source === "cboe" ? "the US daily runner job" : "the 15-minute crypto job";
    return { available: false, kind: i.derivKind, symbol: i.symbol, reason: `No snapshot yet: waiting for ${who}.` };
  }
  if (i.derivKind === "perp") {
    const p = s.json as PerpSnapshot;
    return {
      available: true,
      kind: "perp",
      symbol: i.symbol,
      venue: p.venue,
      markPrice: p.markPrice,
      indexPrice: p.indexPrice,
      premiumPct: p.premiumPct,
      funding: { rate: p.fundingRate, ratePct: p.fundingPct, intervalHours: p.fundingIntervalHours, annualizedPct: p.fundingAnnualizedPct, nextFundingTime: p.nextFundingTime },
      openInterest: p.openInterest,
      priceChange24hPct: p.priceChange24hPct,
      buildUp: p.buildUp,
      longShortRatio: null,
      liquidations: null,
      notes: p.notes,
      asOf: p.asOf,
      source: p.source,
    };
  }
  const c = s.json as ChainSnapshot;
  return {
    available: true,
    kind: "option_chain",
    symbol: i.symbol,
    underlying: c.underlying,
    spot: c.spot,
    expiry: c.expiry,
    dte: c.dte,
    tradeDate: c.tradeDate,
    rows: c.rows,
    atm: c.atm,
    step: c.step,
    pcr: c.pcr,
    pcrVolume: c.pcrVolume,
    maxPain: c.maxPain,
    ivAtm: c.ivAtm,
    ivRank: c.ivRank,
    skew: c.skew,
    callWall: c.callWall,
    putWall: c.putWall,
    buildUp: c.buildUp,
    futures: c.futures,
    lotSize: c.lotSize,
    lotNote: c.lotNote,
    notes: c.notes,
    convention: c.convention,
    asOf: c.asOf,
    source: c.source,
    freshness: "eod",
    proxyNote: i.proxyNote,
  };
}

/* ---------------- fundamentals ---------------- */
type Metric = { key: string; label: string; value: number | null; unit: string };

export async function fundamentalsView(db: MarketDb, i: InstrumentDef) {
  const na = (reason: string) => ({ available: false, symbol: i.symbol, kind: "na", reason, metrics: [] as Metric[], asOf: null, source: null });
  if (i.cik) {
    const s = (await snaps(db, [`fund:${i.symbol}`])).get(`fund:${i.symbol}`);
    if (!s || !s.json) return na("No SEC snapshot yet: waiting for the weekly runner refresh (us-daily).");
    const f = s.json as SecFundamentals;
    const qs = await quotes(db, [i.symbol, "EURUSD"]);
    const q = qs.get(i.symbol);
    const price = q ? Number(q.price) : 0;
    const fxq = qs.get("EURUSD");
    const pe = peOf(f, price, { snapshots: new Map(), quotes: new Map(fxq ? [["EURUSD", { price: Number(fxq.price), prevClose: null, asOf: String(fxq.as_of) }]] : []), bars: new Map() });
    const cur = f.currency;
    const metrics: Metric[] = [
      { key: "revenueTtm", label: `Revenue (${f.basis})`, value: f.revenueTtm, unit: cur },
      { key: "revenueGrowthPct", label: "Revenue growth (YoY)", value: f.revenueGrowthPct, unit: "%" },
      { key: "netIncomeTtm", label: `Net income (${f.basis})`, value: f.netIncomeTtm, unit: cur },
      { key: "netMarginPct", label: "Net margin", value: f.netMarginPct, unit: "%" },
      { key: "epsTtm", label: `Diluted EPS (${f.basis})`, value: f.epsTtm, unit: cur },
      { key: "epsGrowthPct", label: "EPS growth (YoY)", value: f.epsGrowthPct, unit: "%" },
      { key: "pe", label: "P/E (live price / EPS)", value: pe, unit: "x" },
      { key: "sharesOutstanding", label: "Shares outstanding", value: f.sharesOutstanding, unit: "shares" },
      { key: "marketCap", label: "Market cap (price × shares)", value: f.sharesOutstanding && price ? Math.round(f.sharesOutstanding * price) : null, unit: "USD" },
      { key: "debtToEquity", label: "Long-term debt / equity", value: f.debtToEquity, unit: "x" },
    ];
    return { available: true, symbol: i.symbol, kind: "equity", metrics, basis: f.basis, periodEnd: f.periodEnd, filed: f.filed, form: f.form, currency: cur, entity: f.entity, asOf: s.asOf, source: "sec-edgar", note: cur !== "USD" ? `${f.entity} reports in ${cur}; P/E converts EPS with the ECB EURUSD rate.` : null };
  }
  if (i.market === "IN" && i.assetClass === "index") {
    const s = (await snaps(db, [`fund:${i.symbol}`])).get(`fund:${i.symbol}`);
    if (!s || !s.json) return na("No NSE index snapshot yet: waiting for the NSE end-of-day runner job.");
    const f = s.json as IndexFundSnapshot;
    const pctl = f.pe !== null && f.peHistory.length >= 60 ? percentileRank(f.peHistory.map((x) => x[1]), f.pe) : null;
    return {
      available: true,
      symbol: i.symbol,
      kind: "index",
      metrics: [
        { key: "pe", label: "P/E", value: f.pe, unit: "x" },
        { key: "pb", label: "P/B", value: f.pb, unit: "x" },
        { key: "divYield", label: "Dividend yield", value: f.divYield, unit: "%" },
        { key: "pePercentile1y", label: "P/E percentile (past year)", value: pctl, unit: "pctl" },
      ] as Metric[],
      basis: "index",
      periodEnd: f.date,
      asOf: s.asOf,
      source: "nse-archives",
    };
  }
  return na(naReasons(i).fundamentals ?? "No free fundamentals source for this instrument.");
}

/* ---------------- context ---------------- */
type Item = { kind: "sentiment" | "macro"; label: string; value: number | string; note: string };

export async function contextView(db: MarketDb, i: InstrumentDef) {
  const items: Item[] = [];
  let asOf: string | null = null;
  const touch = (a: string) => (asOf = !asOf || a > asOf ? a : asOf);
  if (i.assetClass === "crypto") {
    const s = (await snaps(db, ["ctx:CRYPTO"])).get("ctx:CRYPTO");
    const f = s?.json as FngSnapshot | null;
    const p0 = f?.points[0];
    if (f && p0) {
      const avg7 = Math.round(f.points.slice(0, 7).reduce((a, p) => a + p.value, 0) / Math.min(7, f.points.length));
      items.push({ kind: "sentiment", label: "Crypto Fear & Greed (alternative.me)", value: p0.value, note: `${p0.label}${f.points[1] ? ` · yesterday ${f.points[1].value}` : ""} · 7-day avg ${avg7}` });
      touch(f.asOf);
    }
  }
  const vix = async (quoteKey: string, histKey: string, label: string) => {
    const [qs, ss] = await Promise.all([quotes(db, [quoteKey]), snaps(db, [histKey])]);
    const q = qs.get(quoteKey);
    if (!q) return;
    const h = ss.get(histKey)?.json as VixHistorySnapshot | null;
    const px = Number(q.price);
    const pctl = h && h.history.length >= 60 ? percentileRank(h.history.map((x) => x[1]), px) : null;
    const chg = q.change_pct !== null ? Number(q.change_pct) : null;
    items.push({ kind: "sentiment", label, value: px, note: `${chg !== null ? `${chg >= 0 ? "+" : ""}${roundTo(chg, 1)}% on the day` : "level"}${pctl !== null ? ` · ${pctl}th percentile of the past year` : ""}` });
    touch(String(q.as_of));
  };
  if (i.source === "cboe" && i.symbol !== "CL") await vix("^VIX", "ctx:US", "VIX (Cboe, delayed)");
  if (i.market === "IN") await vix("INDIAVIX", "ctx:IN", "India VIX (NSE, EOD)");
  if (i.benchmark) {
    const [rows] = await db.read([readCandlesStmt([i.benchmark], "1D", 260)]);
    const bars: Candle[] = (rows ?? []).map((r) => ({ t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) }));
    const bt = benchmarkTrend(i.benchmark, bars);
    if (bt) {
      const word = bt.aboveEma200 && bt.ema50Rising ? "uptrend" : !bt.aboveEma200 && !bt.ema50Rising ? "downtrend" : "mixed";
      items.push({ kind: "macro", label: `${i.benchmark} trend`, value: word, note: `${bt.aboveEma200 ? "Above" : "Below"} its 200-day EMA; 50-day EMA ${bt.ema50Rising ? "rising" : "falling"}.` });
    }
  }
  if (i.symbol === "XAUUSD") {
    const u = (await snaps(db, ["ctx:USD"])).get("ctx:USD")?.json as UsdSnapshot | null;
    if (u) {
      items.push({ kind: "macro", label: "US dollar vs euro, 20 sessions (ECB)", value: `${u.eurusdChange20dPct >= 0 ? "+" : ""}${u.eurusdChange20dPct}% EURUSD`, note: u.eurusdChange20dPct >= 0 ? "A weaker dollar has historically supported gold." : "A stronger dollar is a headwind for gold." });
      touch(u.asOf);
    }
  }
  if (!items.length) return { available: false, symbol: i.symbol, items, reason: naReasons(i).context ?? "No context data has been ingested for this instrument yet.", asOf: null };
  return { available: true, symbol: i.symbol, items, asOf, reason: null };
}

/* ---------------- depth ---------------- */
export async function depthView(db: MarketDb, i: InstrumentDef) {
  if (i.flowMode === "book") {
    try {
      const d = await fetchDepth(i.dataSymbol, 100);
      const s = buildDepthSnapshot(i.symbol, "Binance", d.bids, d.asks, new Date().toISOString());
      if (s) return { available: true, ...s, source: "binance", live: true };
    } catch {
      try {
        const d = await fetchBybitDepth(i.dataSymbol, 100);
        const s = buildDepthSnapshot(i.symbol, bybitVenueLabel(i.dataSymbol), d.bids, d.asks, new Date().toISOString());
        if (s) return { available: true, ...s, source: "bybit", live: true };
      } catch {
        /* fall back to the last stored snapshot */
      }
    }
    const s = (await snaps(db, [`depth:${i.symbol}`])).get(`depth:${i.symbol}`);
    if (s?.json) return { available: true, ...(s.json as DepthSnapshot), source: "binance", live: false };
    return { available: false, symbol: i.symbol, reason: "Binance order book is unreachable right now.", topOfBook: null };
  }
  const reason =
    i.market === "IN"
      ? "NSE order book isn't available on free data — connect your broker (coming soon)."
      : i.assetClass === "fx"
        ? "Spot FX is OTC: there's no central order book, and ECB reference rates are one fix per day."
        : "Cboe's free delayed feed has top-of-book only (best bid/ask and size), not a depth ladder.";
  const q = (await quotes(db, [i.symbol])).get(i.symbol);
  const top = q && q.bid !== null && q.ask !== null ? { bid: Number(q.bid), ask: Number(q.ask), bidSize: q.bid_size === null ? null : Number(q.bid_size), askSize: q.ask_size === null ? null : Number(q.ask_size), asOf: String(q.as_of) } : null;
  return { available: false, symbol: i.symbol, reason, topOfBook: i.source === "cboe" ? top : null };
}

/* ---------------- candles ---------------- */
export async function candlesView(db: MarketDb, i: InstrumentDef, tf: string, limit: number) {
  if (i.source === "binance") {
    try {
      const bars = await fetchKlines(i.dataSymbol, BINANCE_TF[tf] ?? "4h", limit);
      return { symbol: i.symbol, tf, requestedTf: tf, ohlc: true, bars: bars.map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v })), source: "binance", freshness: i.freshness, asOf: new Date().toISOString(), note: null };
    } catch {
      try {
        const bars = await fetchBybitKlines(i.dataSymbol, tf, limit);
        return { symbol: i.symbol, tf, requestedTf: tf, ohlc: true, bars: bars.map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v })), source: "bybit", freshness: i.freshness, asOf: new Date().toISOString(), note: `Served by ${bybitVenueLabel(i.dataSymbol)}: Binance is unreachable from this server.` };
      } catch {
        /* fall back to stored bars */
      }
      if (tf !== "4H") return { symbol: i.symbol, tf, requestedTf: tf, ohlc: true, bars: [], source: "binance", freshness: i.freshness, asOf: null, note: "Binance is unreachable right now." };
      const [rows] = await db.read([readCandlesStmt([i.symbol], "4H", limit)]);
      return { symbol: i.symbol, tf, requestedTf: tf, ohlc: true, bars: (rows ?? []).map(rowBar), source: "binance", freshness: i.freshness, asOf: null, note: "Served from the last stored 4H bars (Binance unreachable)." };
    }
  }
  const weekly = tf === "1W";
  const [rows] = await db.read([readCandlesStmt([i.symbol], "1D", weekly ? Math.min(400, limit * 5) : limit)]);
  let bars = (rows ?? []).map(rowBar);
  let note: string | null = null;
  let served = "1D";
  if (weekly) {
    bars = toWeekly(bars).slice(-limit);
    served = "1W";
    note = "Weekly bars aggregated from daily bars (weeks start Monday).";
  } else if (tf !== "1D") note = `Intraday ${tf} bars aren't available on free ${i.freshness === "eod" ? "end-of-day" : i.freshness === "daily-ref" ? "reference-rate" : "delayed"} data; showing daily bars.`;
  if (!i.ohlc) note = (note ? note + " " : "") + "ECB reference rates are close-only (o = h = l = c): draw a line.";
  return { symbol: i.symbol, tf: served, requestedTf: tf, ohlc: i.ohlc, bars, source: i.source, freshness: i.freshness, asOf: bars.length ? new Date((bars[bars.length - 1]?.t ?? 0) * 1000).toISOString() : null, note };
}

const rowBar = (r: Record<string, unknown>) => ({ t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) });

export function toWeekly(bars: { t: number; o: number; h: number; l: number; c: number; v: number }[]) {
  const out: { t: number; o: number; h: number; l: number; c: number; v: number }[] = [];
  for (const b of bars) {
    const day = Math.floor(b.t / 86400);
    const monday = (day - ((new Date(b.t * 1000).getUTCDay() + 6) % 7)) * 86400;
    const w = out[out.length - 1];
    if (w && w.t === monday) {
      w.h = Math.max(w.h, b.h);
      w.l = Math.min(w.l, b.l);
      w.c = b.c;
      w.v += b.v;
    } else out.push({ t: monday, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
  }
  return out;
}
