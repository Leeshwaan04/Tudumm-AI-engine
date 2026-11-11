// Option analytics, ledger hash chain and adapter parsing on saved fixtures. Run: npm run test:market
import "../../runner/lib/register.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const fj = (n: string) => JSON.parse(fx(n)) as unknown;

const O = await import("../src/engine/options.ts");
const L = await import("../src/engine/ledger.ts");
const B = await import("../src/data/binance.ts");
const C = await import("../src/data/cboe.ts");
const N = await import("../src/data/nse.ts");
const F = await import("../src/data/frankfurter.ts");
const G = await import("../src/data/feargreed.ts");
const S = await import("../src/data/sec.ts");
const SN = await import("../src/market/snapshots.ts");
const { inline } = await import("../../runner/lib/sink.ts");
const { pickMonthly } = await import("../../runner/jobs/us.ts");

const legs = (rows: [number, number, number][]) =>
  rows.flatMap(([k, c, p]) => [
    { strike: k, type: "C" as const, oi: c, doi: null, volume: 0, iv: null, ltp: null },
    { strike: k, type: "P" as const, oi: p, doi: null, volume: 0, iv: null, ltp: null },
  ]);

test("options: PCR, max pain, walls on a tiny chain", () => {
  const rows = O.toRows(legs([[90, 10, 30], [100, 20, 20], [110, 30, 10]]));
  assert.equal(O.pcrOI(rows), 1);
  assert.equal(O.maxPain(rows), 100); // payouts: 90 => 400, 100 => 200, 110 => 400
  const r2 = O.toRows(legs([[90, 10, 90], [100, 20, 20], [110, 30, 10]]));
  assert.equal(O.pcrOI(r2), 2);
  assert.equal(O.maxPain(r2), 100);
  assert.deepEqual(O.oiWalls(r2, 101), { callWall: 110, putWall: 90 });
  assert.equal(O.ladder(O.toRows(legs(Array.from({ length: 50 }, (_, i) => [i * 10, 1, 1] as [number, number, number]))), 250, 15).length, 31);
});

test("options: Black-Scholes implied vol round-trips; build-up classes", () => {
  const p = O.bsPrice(100, 105, 30 / 365, 0.065, 0.22, true);
  assert.ok(Math.abs((O.impliedVol(p, 100, 105, 30 / 365, 0.065, true) as number) - 22) < 0.05);
  const q = O.bsPrice(25000, 24500, 8 / 365, 0.065, 0.13, false);
  assert.ok(Math.abs((O.impliedVol(q, 25000, 24500, 8 / 365, 0.065, false) as number) - 13) < 0.05);
  assert.equal(O.impliedVol(0.0001, 100, 50, 0.1, 0.065, true), null, "below intrinsic => null");
  assert.equal(O.classifyBuildUp(1, 2), "long_buildup");
  assert.equal(O.classifyBuildUp(-1, 2), "short_buildup");
  assert.equal(O.classifyBuildUp(1, -2), "short_covering");
  assert.equal(O.classifyBuildUp(-1, -2), "long_unwinding");
  assert.equal(O.classifyBuildUp(0.05, 3), "flat");
  assert.equal(O.thirdFriday(2026, 10), "2026-11-20");
  assert.equal(pickMonthly(["2026-11-11", "2026-11-13", "2026-11-20", "2026-12-18"], "2026-11-10"), "2026-11-20");
});

test("ledger v2: canonical string, independent sha256, chain round-trip and tamper detection", async () => {
  const e1 = { type: "issue" as const, signalId: "SIG-NIFTY-20261110T1015", symbol: "NIFTY", direction: "LONG" as const, entryLow: 25900, entryHigh: 25960.5, stop: 25760, target1: 26180, target2: 26350, exit: null, outcome: null, r: null, at: "2026-11-10T10:15:00.000Z" };
  const a = await L.appendEntry({ seq: 0, hash: L.GENESIS_HASH }, e1);
  const canon = `["${"0".repeat(64)}",1,"issue","SIG-NIFTY-20261110T1015","NIFTY","LONG",25900,25960.5,25760,26180,26350,null,null,null,"2026-11-10T10:15:00.000Z"]`;
  assert.equal(L.canonicalV2(L.GENESIS_HASH, a), canon);
  assert.equal(a.hash, createHash("sha256").update(canon).digest("hex"));
  const b = await L.appendEntry(a, { ...e1, type: "close", exit: 26350, outcome: "target", r: 2.5, at: "2026-11-12T10:00:00.000Z" });
  const c = await L.appendEntry(b, { ...e1, signalId: "SIG-TCS-20261112T1000", symbol: "TCS", direction: "SHORT", at: "2026-11-12T10:00:00.000Z" });
  assert.equal(c.seq, 3);
  assert.deepEqual(await L.verifyChain([a, b, c]), { ok: true, brokenAt: null });
  assert.deepEqual(await L.verifyChain([a, { ...b, stop: 25700 }, c]), { ok: false, brokenAt: 2 });
  assert.deepEqual(await L.verifyChain([a, c]), { ok: false, brokenAt: 3 });
});

test("adapters: Binance spot/futures + Bybit + Fear & Greed fixtures", () => {
  const k = B.parseKlines(fj("binance-klines.json"));
  assert.equal(k.length, 3);
  assert.equal(k[0]?.t, 1794297600);
  assert.ok((k[0]?.tb ?? 0) > 0);
  const t = B.parseTicker(fj("binance-ticker.json"));
  assert.equal(t.symbol, "BTCUSDT");
  assert.ok(t.last > 0 && t.open > 0);
  const d = B.parseDepth(fj("binance-depth.json"));
  assert.equal(d.bids.length, 20);
  assert.ok((d.bids[0]?.[0] ?? 0) < (d.asks[0]?.[0] ?? 0));
  assert.ok(SN.buildDepthSnapshot("BTCUSDT", "Binance", d.bids, d.asks, "2026-11-10T00:00:00Z") !== null);
  const p = B.parsePremiumIndex(fj("binance-premium.json"));
  assert.ok(Math.abs(p.fundingRate - 0.00005518) < 1e-12);
  const oi = B.parseOiHist(fj("binance-oihist.json"));
  assert.ok(oi.length > 1 && (oi[0]?.t ?? 0) < (oi[1]?.t ?? 0));
  const by = B.parseBybitTicker(fj("bybit-ticker.json"));
  assert.equal(by.fundingIntervalHours, 8);
  assert.ok(by.openInterest > 0);
  const g = G.parseFng(fj("fng.json"));
  assert.equal(g[0]?.value, 32);
  assert.equal(SN.oiChangeFromSamples([[0, 100], [43200, 105], [86400, 110]], 86400).pct, 10);
});

test("adapters: Cboe quote, history and option chain fixtures", () => {
  const q = C.parseQuote(fj("cboe-quote-spy.json"));
  assert.equal(q.price, 746.47);
  assert.equal(q.asOf, "2026-11-10T17:07:23Z");
  assert.equal(q.lastTradeEt, "2026-11-10T11:52:21");
  const h = C.parseHistory(fj("cboe-history-spy.json"));
  assert.equal(h.length, 6);
  assert.ok((h[0]?.t ?? 0) < (h[5]?.t ?? 0));
  assert.deepEqual(C.parseOsi("USO261120C00140000"), { root: "USO", expiry: "2026-11-20", type: "C", strike: 140 });
  const ch = C.parseOptions(fj("cboe-options-uso.json"));
  const legsN = ch.byExpiry.get("2026-11-20") ?? [];
  assert.equal(legsN.length, 24);
  const snap = SN.buildChainSnapshot({ symbol: "CL", underlying: "USO", spot: ch.underlying.price, expiry: "2026-11-20", dte: 10, tradeDate: "2026-11-10", legs: legsN, convention: "us", source: "cboe", asOf: ch.underlying.asOf, lotSize: 100, prev: null, decimals: 2 });
  assert.ok(snap.rows.length > 0 && snap.pcr !== null && snap.maxPain !== null);
  assert.ok(snap.rows.every((r) => r.callDOI === null), "no ΔOI without a previous snapshot");
});

test("adapters: NSE CM, index close and F&O fixtures (BS IV from settlement)", () => {
  const cm = N.parseCm(fx("nse-cm.csv"), new Set(["RELIANCE", "SBIN"]));
  const rel = cm.find((r) => r.symbol === "RELIANCE");
  assert.equal(rel?.candle.c, 1324.4);
  assert.equal(rel?.date, "2026-11-09");
  const idx = N.parseIndexClose(fx("nse-index.csv"), new Set(["Nifty 50", "Nifty Bank", "India VIX"]));
  assert.equal(idx.length, 3, "duplicate Nifty 50 row is ignored");
  const n50 = idx.find((r) => r.name === "Nifty 50");
  assert.equal(n50?.pe, 20.48);
  assert.equal(n50?.candle.c, 25044.65);
  assert.equal(idx.find((r) => r.name === "India VIX")?.candle.v, 0);
  const fo = N.parseFo(fx("nse-fo.csv"), new Set(["NIFTY"])).get("NIFTY");
  assert.ok(fo);
  assert.equal(fo.expiry, "2026-11-17", "same-day expiry is skipped");
  assert.equal(fo.dte, 8);
  assert.ok(fo.legs.length > 10);
  assert.ok(fo.futures && ["long_buildup", "short_buildup", "short_covering", "long_unwinding", "flat"].includes(fo.futures.class));
  const atm = fo.legs.filter((l) => Math.abs(l.strike - fo.spot) <= 100 && l.iv !== null);
  assert.ok(atm.length > 0 && atm.every((l) => (l.iv as number) > 3 && (l.iv as number) < 80), "ATM IVs are sane");
  assert.deepEqual(N.parseCsv('a,"b,c",d\n1,"x""y",2\n'), [["a", "b,c", "d"], ["1", 'x"y', "2"]]);
});

test("adapters: ECB/Frankfurter and SEC companyfacts fixtures", () => {
  const s = F.parseSeries(fj("frankfurter-series.json"));
  assert.ok(s.length > 20);
  assert.equal(s[0]?.EURUSD, Number((1 / 0.88511).toFixed(5)));
  assert.equal(F.parseLatest(fj("frankfurter-latest.json")).USDINR, 93.93);
  const f = S.parseCompanyFacts(fj("sec-aapl-trim.json"), "0000320193");
  assert.equal(f.basis, "TTM");
  assert.equal(f.periodEnd, "2026-09-26");
  assert.equal(f.revenueTtm, 478834000000);
  assert.ok(f.revenueGrowthPct !== null && f.netMarginPct !== null && f.epsTtm !== null);
  assert.equal(f.currency, "USD");
});

test("runner: SQL literal inlining escapes quotes and rejects non-finite numbers", () => {
  assert.equal(inline({ sql: "INSERT INTO t VALUES (?, ?, ?)", params: ["O'Neil", 1.5, null] }), "INSERT INTO t VALUES ('O''Neil', 1.5, NULL)");
  assert.equal(inline({ sql: "SELECT '?' , ?", params: [2] }), "SELECT '?' , 2");
  assert.throws(() => inline({ sql: "SELECT ?", params: [Infinity] }));
});
