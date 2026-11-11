// nse-eod: NSE CM bhavcopy + index closes (daily candles, India VIX, index P/E) for N trading days,
// and the latest F&O bhavcopy (option-chain summaries + futures OI build-up). Then engine v0 for India.
import type { Ctx } from "../main.ts";
import { emptyBatch } from "../lib/sink.ts";
import { cacheGet, cachePut, fetchBuf, HttpStatus, pool } from "../lib/net.ts";
import { unzipFirst } from "../lib/unzip.ts";
import { cmUrl, foUrl, indexUrl, parseCm, parseFo, parseIndexClose } from "../../worker/src/data/nse.ts";
import type { CmRow, FoSummary, IndexRow } from "../../worker/src/data/nse.ts";
import { INSTRUMENTS } from "../../worker/src/market/instruments.ts";
import { buildChainSnapshot } from "../../worker/src/market/snapshots.ts";
import type { ChainSnapshot, IndexFundSnapshot, VixHistorySnapshot } from "../../worker/src/market/snapshots.ts";
import { roundTo } from "../../worker/src/engine/util.ts";

const IN = INSTRUMENTS.filter((i) => i.market === "IN");
const STOCKS = new Set(IN.filter((i) => i.assetClass === "equity").map((i) => i.dataSymbol));
const INDEX_NAMES = new Set(["Nifty 50", "Nifty Bank", "India VIX"]);
const BY_INDEX: Record<string, string> = { "Nifty 50": "NIFTY", "Nifty Bank": "BANKNIFTY" };
const FO = new Set(IN.map((i) => i.foSymbol).filter((x): x is string => !!x));

type Day = { ymd: string; cm: CmRow[] | null; idx: IndexRow[] | null; blocked: boolean };

function istToday(now: Date): string {
  const t = new Date(now.getTime() + 330 * 60000);
  return t.toISOString().slice(0, 10).replace(/-/g, "");
}

function prevWeekdays(endYmd: string, n: number): string[] {
  const out: string[] = [];
  let t = Date.UTC(+endYmd.slice(0, 4), +endYmd.slice(4, 6) - 1, +endYmd.slice(6, 8));
  while (out.length < n) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10).replace(/-/g, ""));
    t -= 86400000;
  }
  return out;
}

const dmy = (ymd: string) => `${ymd.slice(6, 8)}${ymd.slice(4, 6)}${ymd.slice(0, 4)}`;
const ageDays = (ymd: string, now: Date) => (now.getTime() - Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8))) / 86400000;

async function getDay(ymd: string, now: Date): Promise<Day> {
  const key = `nse/day-${ymd}.json`;
  const hit = cacheGet<{ cm: CmRow[] | null; idx: IndexRow[] | null }>(key);
  if (hit) return { ymd, ...hit, blocked: false };
  let blocked = false;
  let cm: CmRow[] | null = null;
  let idx: IndexRow[] | null = null;
  try {
    const z = unzipFirst(await fetchBuf(cmUrl(ymd)), (n) => n.endsWith(".csv"));
    if (z) cm = parseCm(z.data.toString("utf8"), STOCKS);
  } catch (e) {
    if (e instanceof HttpStatus && e.status === 403) blocked = true;
    else if (!(e instanceof HttpStatus)) throw e;
  }
  if (cm) {
    try {
      idx = parseIndexClose((await fetchBuf(indexUrl(dmy(ymd)))).toString("utf8"), INDEX_NAMES);
    } catch (e) {
      if (!(e instanceof HttpStatus)) throw e;
    }
  }
  // cache hits and settled holidays (404s older than 4 days); never cache today's not-yet-published file
  if ((cm && idx) || (!cm && !blocked && ageDays(ymd, now) > 4)) cachePut(key, { cm, idx });
  return { ymd, cm, idx, blocked };
}

async function getFo(ymd: string): Promise<Map<string, FoSummary> | null> {
  const key = `nse/fo-${ymd}.json`;
  const hit = cacheGet<[string, FoSummary][]>(key);
  if (hit) return new Map(hit);
  try {
    const z = unzipFirst(await fetchBuf(foUrl(ymd), {}, 120000), (n) => n.endsWith(".csv"));
    if (!z) return null;
    const m = parseFo(z.data.toString("utf8"), FO);
    cachePut(key, [...m.entries()]);
    return m;
  } catch (e) {
    if (e instanceof HttpStatus) return null;
    throw e;
  }
}

export async function nseEod(ctx: Ctx): Promise<void> {
  const b = emptyBatch();
  const end = ctx.a.date ?? istToday(ctx.now);
  const want = Math.max(1, ctx.a.backfill || 1);
  // ~250 trading days per 365; ask for enough weekdays to cover NSE holidays, then extend if short
  let cand = prevWeekdays(end, Math.ceil(want * 1.08) + 6);
  const days: Day[] = [];
  const seen = new Set<string>();
  for (let round = 0; round < 3; round++) {
    const todo = cand.filter((d) => !seen.has(d));
    todo.forEach((d) => seen.add(d));
    const got = await pool(todo, ctx.a.concurrency, (d) => getDay(d, ctx.now), 150);
    days.push(...got);
    const ok = days.filter((d) => d.cm && d.cm.length).length;
    if (got.length && got.every((d) => d.blocked)) {
      throw new Error("NSE archives answered HTTP 403 for every file: this IP looks blocked (GitHub-hosted runners are in the US). Run nse-eod from an Indian IP or a self-hosted runner.");
    }
    if (ok >= want) break;
    cand = prevWeekdays(end, cand.length + Math.ceil((want - ok) * 1.5) + 5);
  }
  const good = days.filter((d) => d.cm && d.cm.length).sort((x, y) => x.ymd.localeCompare(y.ymd)).slice(-want);
  if (!good.length) {
    b.health.push({ source: "nse-archives", ok: false, error: "no CM bhavcopy found in the date window" });
    await ctx.commit("nse-eod", b, []);
    throw new Error(`No NSE bhavcopy found up to ${end} (today's file appears after ~19:00 IST).`);
  }
  const latest = good[good.length - 1] as Day;
  console.log(`  NSE days: ${good.length} (${good[0]?.ymd} … ${latest.ymd}); holidays/missing skipped: ${days.length - days.filter((d) => d.cm).length}`);

  // ---- candles + series
  const closes = new Map<string, { date: string; c: number }[]>();
  const vix: [string, number][] = [];
  const pe = new Map<string, [string, number][]>();
  const lastIdx = new Map<string, IndexRow>();
  const push = (sym: string, date: string, c: number) => {
    let a = closes.get(sym);
    if (!a) closes.set(sym, (a = []));
    a.push({ date, c });
  };
  for (const d of good) {
    for (const r of d.cm ?? []) {
      b.candles.push({ symbol: r.symbol, tf: "1D", ...r.candle });
      push(r.symbol, r.date, r.candle.c);
    }
    for (const r of d.idx ?? []) {
      if (r.name === "India VIX") {
        vix.push([r.date, r.candle.c]);
        lastIdx.set("INDIAVIX", r);
        continue;
      }
      const sym = BY_INDEX[r.name];
      if (!sym) continue;
      b.candles.push({ symbol: sym, tf: "1D", ...r.candle });
      push(sym, r.date, r.candle.c);
      lastIdx.set(sym, r);
      if (r.pe !== null) {
        let a = pe.get(sym);
        if (!a) pe.set(sym, (a = []));
        a.push([r.date, r.pe]);
      }
    }
  }
  const asOf = (date: string) => `${date}T10:00:00.000Z`; // 15:30 IST close
  for (const i of IN) {
    const s = closes.get(i.symbol);
    const last = s?.[s.length - 1];
    if (!last) continue;
    const prev = s && s.length > 1 ? (s[s.length - 2] as { c: number }).c : (latest.cm ?? []).find((r) => r.symbol === i.symbol)?.prevClose ?? null;
    b.quotes.push({ symbol: i.symbol, price: last.c, prevClose: prev, changePct: prev ? roundTo(((last.c - prev) / prev) * 100, 3) : null, asOf: asOf(last.date), source: "nse-archives" });
  }
  // ---- India VIX + index fundamentals (merged with previous history)
  const prevSnaps = await ctx.snapshots<unknown>(["ctx:IN", "fund:NIFTY", "fund:BANKNIFTY", ...IN.map((i) => `deriv:${i.symbol}`)]);
  const lv = lastIdx.get("INDIAVIX");
  if (lv) {
    const old = (prevSnaps.get("ctx:IN")?.json as VixHistorySnapshot | undefined)?.history ?? [];
    const hist = mergeHist(old, vix);
    const pc = hist.length > 1 ? (hist[hist.length - 2] as [string, number])[1] : null;
    b.quotes.push({ symbol: "INDIAVIX", price: lv.candle.c, prevClose: pc, changePct: lv.changePct, asOf: asOf(lv.date), source: "nse-archives" });
    b.snapshots.push({ key: "ctx:IN", json: { label: "India VIX", history: hist, asOf: asOf(lv.date) } satisfies VixHistorySnapshot, asOf: asOf(lv.date), source: "nse-archives" });
  }
  for (const sym of ["NIFTY", "BANKNIFTY"]) {
    const r = lastIdx.get(sym);
    if (!r) continue;
    const old = (prevSnaps.get(`fund:${sym}`)?.json as IndexFundSnapshot | undefined)?.peHistory ?? [];
    const f: IndexFundSnapshot = { kind: "index", symbol: sym, date: r.date, pe: r.pe, pb: r.pb, divYield: r.divYield, peHistory: mergeHist(old, pe.get(sym) ?? []), source: "nse-archives", asOf: asOf(r.date) };
    b.snapshots.push({ key: `fund:${sym}`, json: f, asOf: f.asOf, source: "nse-archives" });
  }
  // ---- F&O (latest day only)
  const fo = await getFo(latest.ymd);
  if (fo) {
    for (const i of IN) {
      const s = fo.get(i.foSymbol ?? "");
      if (!s || !(s.spot > 0)) continue;
      const prev = (prevSnaps.get(`deriv:${i.symbol}`)?.json as ChainSnapshot | undefined) ?? null;
      const snap = buildChainSnapshot({
        symbol: i.symbol,
        underlying: s.underlying,
        spot: s.spot,
        expiry: s.expiry,
        dte: s.dte,
        tradeDate: s.tradeDate,
        legs: s.legs,
        convention: "india",
        source: "nse-archives",
        asOf: asOf(s.tradeDate),
        lotSize: s.lotSize,
        futures: s.futures,
        prev,
        decimals: i.decimals,
      });
      b.snapshots.push({ key: `deriv:${i.symbol}`, json: snap, asOf: snap.asOf, source: "nse-archives" });
    }
    const n = IN.filter((i) => fo.has(i.foSymbol ?? "")).length;
    const nifty = fo.get("NIFTY");
    console.log(`  F&O ${latest.ymd}: ${n} underlyings; NIFTY expiry ${nifty?.expiry} (${nifty?.legs.length} legs), futures ${nifty?.futures?.class ?? "n/a"}`);
  } else console.log(`  F&O bhavcopy for ${latest.ymd} unavailable; derivatives snapshots unchanged`);
  b.health.push({ source: "nse-archives", ok: true, error: null });
  await ctx.commit("nse-eod", b, IN.map((i) => i.symbol));
}

function mergeHist(old: [string, number][], add: [string, number][]): [string, number][] {
  const m = new Map<string, number>(old);
  for (const [d, v] of add) m.set(d, v);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-260);
}
