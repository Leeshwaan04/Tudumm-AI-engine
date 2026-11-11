// v0.2 live data: universe source + explicit offline state (no demo / seed
// fallback), live engine honesty rules, Binance tick stream.
// Run: node extension/tests/live-data.test.mjs
import { readFileSync } from "node:fs";
import { check, done, section } from "./harness.mjs";
import * as Engine from "../lib/engine.js";
import { createEngine, freshnessText, proxyText, asOfText, binanceStreamPair, safeWebUrl, webUrlProblem, apiOrigin, mergeSettings, DEFAULT_SETTINGS } from "../lib/engine.js";
import { sanitizeUniverse, fetchUniverse, createUniverseSource, reasonText, UNIVERSE_TTL_MS, FAIL_BACKOFF_MS } from "../lib/datasource.js";
import { binancePairs, streamUrl, parseMiniTicker, backoffDelay, createTickStream, BACKOFF_MAX_MS } from "../lib/ticks.js";

const raw = JSON.parse(readFileSync(new URL("./fixtures/universe-live.json", import.meta.url), "utf8"));
const json = (body, status = 200, type = "application/json; charset=utf-8") => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": type } });

section("settings & URLs");
check("default webUrl is https://tudumm.in", DEFAULT_SETTINGS.webUrl === "https://tudumm.in");
check("no data-mode setting (live only); a stored legacy dataMode is dropped", !("dataMode" in DEFAULT_SETTINGS) && !("dataMode" in mergeSettings(null)) && !("dataMode" in mergeSettings({ dataMode: "demo" })));
check("https accepted", safeWebUrl("https://tudumm.in/") === "https://tudumm.in");
check("http rejected for a public host", safeWebUrl("http://tudumm.in") === null && /https/.test(webUrlProblem("http://tudumm.in")));
check("http allowed for localhost / 127.0.0.1", safeWebUrl("http://localhost:5180") === "http://localhost:5180" && safeWebUrl("http://127.0.0.1:8789") === "http://127.0.0.1:8789");
check("javascript:/data:/file: rejected", [`javascript:alert(1)`, "data:text/html,x", "file:///etc/passwd"].every((u) => safeWebUrl(u) === null));
check("credentials in URL rejected", safeWebUrl("https://a:b@tudumm.in") === null);
check("apiOrigin strips the path", apiOrigin("https://tudumm.in/app") === "https://tudumm.in");

section("universe sanitize");
const good = sanitizeUniverse(raw);
check("recorded universe accepted", good.ok && good.universe.instruments.length === 22, good.reason);
check("withData counts priced instruments", good.withData === raw.instruments.filter((i) => i.price != null).length);
check("simulated universe refused", sanitizeUniverse({ ...raw, meta: { ...raw.meta, simulated: true } }).reason === "bad-data");
check("missing instruments refused", sanitizeUniverse({ meta: { simulated: false } }).reason === "bad-data");
const few = { ...raw, instruments: raw.instruments.map((i, n) => ({ ...i, price: n < 2 ? i.price || 1 : null })) };
check("fewer than 3 priced → too-few", sanitizeUniverse(few).reason === "too-few" && /Only a few instruments/.test(reasonText("too-few", "https://tudumm.in")));
const hostile = { ...raw, instruments: [...raw.instruments, { symbol: "<img src=x>", price: 1 }, { symbol: "OK1", price: Infinity }, null] };
const hs = sanitizeUniverse(hostile);
check("bad symbols dropped", hs.ok && !hs.universe.instruments.some((i) => /</.test(i.symbol)));
check("non-finite price → null", hs.universe.instruments.find((i) => i.symbol === "OK1").price === null);
check("ledger keeps only hashed entries", sanitizeUniverse({ ...raw, ledger: [{ hash: "nope" }, ...raw.ledger] }).universe.ledger.length === raw.ledger.length);

section("universe fetch");
const okFetch = async () => json(raw);
check("fetch ok", (await fetchUniverse("https://tudumm.in", { fetchImpl: okFetch })).ok);
check("200 HTML (API not deployed) → not-deployed", (await fetchUniverse("https://tudumm.in", { fetchImpl: async () => json("<!doctype html>", 200, "text/html") })).reason === "not-deployed");
check("404 → not-deployed", (await fetchUniverse("https://tudumm.in", { fetchImpl: async () => json({ error: "not_found" }, 404) })).reason === "not-deployed");
check("500 → http-500", (await fetchUniverse("https://tudumm.in", { fetchImpl: async () => json({}, 500) })).reason === "http-500");
check("network error → network", (await fetchUniverse("https://tudumm.in", { fetchImpl: async () => { throw new TypeError("fail"); } })).reason === "network");
check("bad JSON → bad-data", (await fetchUniverse("https://tudumm.in", { fetchImpl: async () => json("{nope", 200) })).reason === "bad-data");
let seenInit = null;
await fetchUniverse("https://tudumm.in", { fetchImpl: async (u, init) => ((seenInit = { u, init }), json(raw)) });
check("GET /api/v1/market/universe without credentials", seenInit.u === "https://tudumm.in/api/v1/market/universe" && seenInit.init.credentials === "omit" && !seenInit.init.headers.authorization);
check("reason text names the host", /tudumm\.in/.test(reasonText("network", "https://tudumm.in")));

section("universe source (cache + offline)");
{
  let t = 1_000_000;
  let calls = 0;
  let mode = "ok";
  const settings = { webUrl: "https://tudumm.in", dataMode: "live" };
  const src = createUniverseSource({
    fetchImpl: async () => {
      calls++;
      if (mode === "down") throw new TypeError("down");
      return json(raw);
    },
    getSettings: async () => mergeSettings(settings),
    now: () => t,
  });
  const a = await src.get();
  check("live by default", a.mode === "live" && calls === 1);
  t += UNIVERSE_TTL_MS - 1000;
  await src.get();
  check("cached for 60 s", calls === 1);
  t += 2000;
  await src.get();
  check("refetched after 60 s", calls === 2);
  mode = "down";
  t += UNIVERSE_TTL_MS + 1;
  const s = await src.get();
  check("API down within 5 min → last live data marked stale", s.mode === "live" && s.stale === true && s.reason === "network");
  t += 6 * 60_000;
  const d = await src.get({ force: true });
  check("API down for longer → offline with reason, never fallback data", d.mode === "offline" && d.reason === "network" && d.universe === null && /Couldn't reach/.test(d.reasonText) && d.retryInMs > 0);
  const c = calls;
  await src.get();
  check("failures back off (no hammering)", calls === c);
  t += FAIL_BACKOFF_MS + 1;
  mode = "ok";
  check("recovers to live after backoff", (await src.get()).mode === "live");
  settings.dataMode = "demo"; // a stored v0.2-draft setting: there is no demo mode
  const chosen = await src.get();
  check("legacy dataMode:'demo' is ignored → still live", chosen.mode === "live" && chosen.universe && chosen.universe.meta.simulated === false);
  delete settings.dataMode;
  settings.webUrl = "http://evil.example";
  const bad = await src.get();
  check("invalid web URL → offline invalid-url (no data)", bad.mode === "offline" && bad.reason === "invalid-url" && bad.universe === null);
}

section("live engine honesty");
const live = createEngine(good.universe, { live: true });
const btc = live.get("BTCUSDT");
check("engine is live", live.live === true);
const p1 = live.priceAt("BTCUSDT", Date.now());
const p2 = live.priceAt("BTCUSDT", Date.now() + 3_600_000);
check("Live never random-walks (price is constant without ticks)", p1 === p2 && p1 === btc.price);
const noPrice = live.instruments.find((i) => i.price == null);
if (noPrice) {
  const sn = live.snapshot(noPrice.symbol);
  check("no price → '—', hasPrice false, no fake as-of", sn.priceText === "—" && sn.hasPrice === false && (sn.asOfText === null || typeof sn.asOfText === "string"));
}
const snap = live.snapshot("BTCUSDT");
check("freshness badge text", snap.freshnessText === freshnessText(btc) && /^REAL-TIME · /.test(snap.freshnessText), snap.freshnessText);
check("engine tag on live signals", snap.engineText === "ENGINE V0 · UNCALIBRATED");
check("no queued drumroll in live", live.instruments.every((i) => live.signalState(i.symbol).status !== "queued"));
const nextPx = btc.price + 10;
check("tick: newer price applies", live.setQuote("BTCUSDT", { price: nextPx, at: Date.now() + 1000, source: "binance" }) === true && live.quote("BTCUSDT").price === nextPx);
check("tick: older price ignored", live.setQuote("BTCUSDT", { price: 1, at: Date.now() - 86_400_000 }) === false);
check("tick relabels the source (BINANCE)", /BINANCE$/.test(live.snapshot("BTCUSDT").freshnessText));
check("tick bumps the tick counter", live.quote("BTCUSDT").tick >= 1);
check("as-of null for missing time (no 1 Jan 1970)", asOfText(null) === null && asOfText(0) === null && asOfText("nope") === null);
check("gold labelled as a proxy", proxyText({ symbol: "XAUUSD", source: "binance" }) === "PAXG PROXY FOR GOLD" && proxyText({ symbol: "XAUUSD", source: "bybit" }) === "XAUT PROXY FOR GOLD" && proxyText({ symbol: "CL" }) === "USO ETF PROXY FOR WTI");
const ls = live.ledgerStats();
check("live ledger: closes only, too few to judge under 30", ls.live && ls.count === raw.ledger.filter((e) => e.type === "close" && e.r != null).length && ls.tooFew === true);
check("no demo engine: no simulation or seed loader exported", !("loadSeed" in Engine) && !("mulberry32" in Engine) && !("hashString" in Engine) && createEngine({ instruments: [] }).live === true);
const broken = createEngine({ ...good.universe, instruments: [{ ...good.universe.instruments[14], signal: { ...raw.instruments[14].signal, status: "active", direction: "LONG", entryLow: 10, entryHigh: 11, stop: 20, target1: 30, target2: 40 } }] }, { live: true });
check("inconsistent levels become an honest sit-out", broken.instruments[0].signal.status === "sit_out");
const unknown = createEngine({ ...good.universe, instruments: [{ ...good.universe.instruments[0], signal: { status: "held" } }] }, { live: true });
check("unknown status → sitting out", unknown.instruments[0].signal.status === "sit_out");
check("live sizing without an FX rate explains instead of guessing", (() => {
  const e = createEngine({ ...good.universe, instruments: good.universe.instruments.filter((i) => i.symbol !== "USDINR") }, { live: true });
  const open = e.instruments.find((i) => ["active", "pending", "t1_hit"].includes(i.signal.status) && i.currency !== "INR");
  if (!open) return true;
  const r = e.sizePosition(open.symbol, { capital: 500000, currency: "INR", riskPct: 1 });
  return r && typeof r.unavailable === "string";
})());

section("binance ticks");
const liveInsts = live.instruments;
const pairs = binancePairs(liveInsts);
check("crypto + PAXG streamed", pairs.some((p) => p.pair === "BTCUSDT") && pairs.some((p) => p.symbol === "XAUUSD" && p.pair === "PAXGUSDT"));
check("Bybit-served crypto still streams from Binance", binanceStreamPair({ live: true, symbol: "ETHUSDT", source: "bybit", assetClass: "crypto", freshness: "realtime" }) === "ETHUSDT");
check("non-crypto never streamed", binanceStreamPair({ live: true, symbol: "AAPL", source: "cboe", assetClass: "equity", freshness: "delayed-15m" }) === null);
check("instruments not marked live are never streamed", binanceStreamPair({ live: false, symbol: "BTCUSDT", source: "binance", assetClass: "crypto", freshness: "realtime" }) === null && binancePairs([{ live: false, symbol: "BTCUSDT", source: "binance", assetClass: "crypto", freshness: "realtime" }]).length === 0);
check("stream URL", streamUrl([{ pair: "BTCUSDT" }, { pair: "PAXGUSDT" }]) === "wss://data-stream.binance.vision/stream?streams=btcusdt@miniTicker/paxgusdt@miniTicker");
const frame = JSON.stringify({ stream: "btcusdt@miniTicker", data: { e: "24hrMiniTicker", E: 1700000000000, s: "BTCUSDT", c: "73850.10" } });
const t1 = parseMiniTicker(frame);
check("miniTicker parsed", t1 && t1.pair === "BTCUSDT" && t1.price === 73850.1 && t1.at === 1700000000000);
check("junk frames ignored", parseMiniTicker("x".repeat(5000)) === null && parseMiniTicker('{"data":{"e":"trade"}}') === null && parseMiniTicker('{"data":{"e":"24hrMiniTicker","s":"X","c":"-1"}}') === null);
check("backoff grows and caps at 30 s", backoffDelay(0, () => 0.5) === 1000 && backoffDelay(3, () => 0.5) === 8000 && backoffDelay(20, () => 1) <= BACKOFF_MAX_MS * 1.25);
{
  const sockets = [];
  class FakeWS {
    constructor(url) {
      this.url = url;
      sockets.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  const timers = [];
  const fakeTimers = { setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length), clearTimeout: () => {} };
  const doc = { visibilityState: "visible", listeners: {}, addEventListener(t, f) { this.listeners[t] = f; }, removeEventListener() {} };
  const ticks = [];
  const statuses = [];
  const s = createTickStream({ pairs: [{ symbol: "XAUUSD", pair: "PAXGUSDT" }], onTick: (sym, price) => ticks.push([sym, price]), onStatus: (x) => statuses.push(x), WebSocketImpl: FakeWS, doc, timers: fakeTimers, rnd: () => 0.5 });
  check("stream starts", s.start() === true && sockets.length === 1 && /paxgusdt@miniTicker/.test(sockets[0].url));
  sockets[0].onopen();
  sockets[0].onmessage({ data: JSON.stringify({ data: { e: "24hrMiniTicker", E: 1, s: "PAXGUSDT", c: "4050.5" } }) });
  check("tick mapped to our symbol", ticks.length === 1 && ticks[0][0] === "XAUUSD" && ticks[0][1] === 4050.5 && s.status === "live");
  sockets[0].onclose();
  check("reconnect scheduled with backoff", s.status === "retrying" && timers.some((x) => x.ms === 1000));
  timers.find((x) => x.ms === 1000).fn();
  check("reconnected", sockets.length === 2);
  doc.visibilityState = "hidden";
  doc.listeners.visibilitychange();
  check("closed while the page is hidden", s.status === "paused" && sockets[1].closed === true);
  doc.visibilityState = "visible";
  doc.listeners.visibilitychange();
  check("reopens when visible", sockets.length === 3);
  s.stop();
  check("stop closes", s.status === "off" && sockets[2].closed === true);
}

await done(import.meta.url);
