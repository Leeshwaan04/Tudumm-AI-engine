// us-daily: Cboe daily history (last 400 bars), option-chain summaries (nearest monthly expiry,
// ±15 strikes), VIX history, and SEC fundamentals (weekly). Then engine v0 for the US set.
import type { Ctx } from "../main.ts";
import { emptyBatch } from "../lib/sink.ts";
import { fetchJsonUrl, pool } from "../lib/net.ts";
import { CBOE, parseHistory, parseOptions } from "../../worker/src/data/cboe.ts";
import { parseCompanyFacts, SEC_FACTS } from "../../worker/src/data/sec.ts";
import { INSTRUMENTS } from "../../worker/src/market/instruments.ts";
import { buildChainSnapshot } from "../../worker/src/market/snapshots.ts";
import type { ChainSnapshot, VixHistorySnapshot } from "../../worker/src/market/snapshots.ts";
import { thirdFriday } from "../../worker/src/engine/options.ts";

const US = INSTRUMENTS.filter((i) => i.source === "cboe");

/** Monthly expiry = 3rd Friday (or the Thursday before when Friday is a holiday). Nearest with DTE >= 2. */
export function pickMonthly(expiries: string[], today: string): string | null {
  const ok = (e: string) => (Date.parse(e) - Date.parse(today)) / 86400000 >= 2;
  const monthly = expiries.filter((e) => {
    const d = new Date(`${e}T00:00:00Z`);
    const tf = thirdFriday(d.getUTCFullYear(), d.getUTCMonth());
    const thu = new Date(Date.parse(tf) - 86400000).toISOString().slice(0, 10);
    return e === tf || e === thu;
  });
  return monthly.sort().find(ok) ?? expiries.sort().find(ok) ?? null;
}

export async function usDaily(ctx: Ctx): Promise<void> {
  const b = emptyBatch();
  const today = ctx.now.toISOString().slice(0, 10);
  const prev = await ctx.snapshots<unknown>([...US.map((i) => `deriv:${i.symbol}`), ...US.filter((i) => i.cik).map((i) => `fund:${i.symbol}`)]);
  let cboeOk = 0;
  let cboeErr: string | null = null;
  await pool(
    US,
    2,
    async (i) => {
      try {
        const bars = parseHistory(await fetchJsonUrl(`${CBOE}/charts/historical/${i.dataSymbol}.json`), 400);
        for (const c of bars) b.candles.push({ symbol: i.symbol, tf: "1D", t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
        const chain = parseOptions(await fetchJsonUrl(`${CBOE}/options/${i.dataSymbol}.json`, {}, 120000));
        const u = chain.underlying;
        b.quotes.push({ symbol: i.symbol, price: u.price, prevClose: u.prevClose, changePct: u.changePct, dayOpen: u.open, dayHigh: u.high, dayLow: u.low, volume: u.volume, bid: u.bid, ask: u.ask, bidSize: u.bidSize, askSize: u.askSize, asOf: u.asOf, source: "cboe" });
        const exp = pickMonthly([...chain.byExpiry.keys()], today);
        if (exp) {
          const legs = chain.byExpiry.get(exp) ?? [];
          const snap = buildChainSnapshot({
            symbol: i.symbol,
            underlying: i.dataSymbol,
            spot: u.price,
            expiry: exp,
            dte: Math.round((Date.parse(exp) - Date.parse(today)) / 86400000),
            tradeDate: u.asOf.slice(0, 10),
            legs,
            convention: "us",
            source: "cboe",
            asOf: u.asOf,
            lotSize: 100,
            futures: null,
            prev: (prev.get(`deriv:${i.symbol}`)?.json as ChainSnapshot | undefined) ?? null,
            decimals: i.decimals,
          });
          b.snapshots.push({ key: `deriv:${i.symbol}`, json: snap, asOf: snap.asOf, source: "cboe" });
          console.log(`  ${i.symbol.padEnd(5)} ${bars.length} bars to ${new Date((bars[bars.length - 1]?.t ?? 0) * 1000).toISOString().slice(0, 10)}; ${i.dataSymbol} ${u.price}; chain ${exp} ${legs.length} legs, PCR ${snap.pcr}, max pain ${snap.maxPain}, ATM IV ${snap.ivAtm}%`);
        }
        cboeOk++;
      } catch (e) {
        cboeErr = `${i.dataSymbol}: ${e instanceof Error ? e.message : e}`;
        console.warn(`  ! ${cboeErr}`);
      }
    },
    300,
  );
  // VIX history (context layer)
  try {
    const v = parseHistory(await fetchJsonUrl(`${CBOE}/charts/historical/_VIX.json`), 260);
    const last = v[v.length - 1];
    const hist: [string, number][] = v.map((c) => [new Date(c.t * 1000).toISOString().slice(0, 10), c.c]);
    const vq = await fetchJsonUrl<unknown>(`${CBOE}/quotes/_VIX.json`).catch(() => null);
    const live = vq ? (vq as { data?: { current_price?: number; prev_day_close?: number; price_change_percent?: number } }).data : null;
    if (last) {
      const at = new Date().toISOString();
      b.snapshots.push({ key: "ctx:US", json: { label: "VIX", history: hist, asOf: at } satisfies VixHistorySnapshot, asOf: at, source: "cboe" });
      b.quotes.push({ symbol: "^VIX", price: live?.current_price ?? last.c, prevClose: live?.prev_day_close ?? null, changePct: live?.price_change_percent ?? null, asOf: at, source: "cboe" });
    }
  } catch (e) {
    console.warn(`  ! VIX history: ${e instanceof Error ? e.message : e}`);
  }
  b.health.push({ source: "cboe", ok: cboeOk > 0, error: cboeOk > 0 ? null : cboeErr });

  // SEC fundamentals, refreshed weekly (or --force-sec)
  const ua = process.env.SEC_USER_AGENT || "Tudumm Research admin@tudumm.in";
  let secOk = 0;
  let secErr: string | null = null;
  for (const i of US.filter((x) => x.cik)) {
    const old = prev.get(`fund:${i.symbol}`);
    if (!ctx.a.forceSec && old && (ctx.now.getTime() - Date.parse(old.asOf)) / 86400000 < 6) continue;
    try {
      const raw = await fetchJsonUrl<unknown>(SEC_FACTS(i.cik as string), { "user-agent": ua, accept: "application/json" }, 90000);
      const f = parseCompanyFacts(raw, i.cik as string);
      const at = new Date().toISOString();
      b.snapshots.push({ key: `fund:${i.symbol}`, json: { ...f, asOf: at }, asOf: at, source: "sec-edgar" });
      console.log(`  SEC ${i.symbol}: ${f.basis} to ${f.periodEnd} rev ${f.revenueTtm ? (f.revenueTtm / 1e9).toFixed(1) + "B" : "n/a"} ${f.currency} (${f.revenueGrowthPct ?? "n/a"}%), margin ${f.netMarginPct ?? "n/a"}%, EPS ${f.epsTtm ?? "n/a"}`);
      secOk++;
      await new Promise((r) => setTimeout(r, 200)); // SEC fair access: well under 10 req/s
    } catch (e) {
      secErr = `${i.symbol}: ${e instanceof Error ? e.message : e}`;
      console.warn(`  ! SEC ${secErr}`);
    }
  }
  if (secOk || secErr) b.health.push({ source: "sec-edgar", ok: secOk > 0, error: secOk > 0 ? null : secErr });
  if (!cboeOk) {
    await ctx.commit("us-daily", b, []);
    throw new Error(`Cboe delayed data unreachable: ${cboeErr}`);
  }
  await ctx.commit("us-daily", b, US.map((i) => i.symbol));
}
