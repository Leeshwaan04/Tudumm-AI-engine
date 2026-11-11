// Tudumm live feed: India realtime from 5paisa + crypto from this machine's egress -> Worker ingest.
// Calls (signals) then refresh in near-realtime: every quote push steps open calls' lifecycle
// (entry fill, stop, T1, T2) on the Worker; completed bars trigger a fresh evaluation.
//
// Orders are NOT placed from here, ever. Kite orders go through relay/kite-relay.mjs after the owner
// confirms them in /admin/broker.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { QuoteRow } from "../../worker/src/market/types.ts";
import { nseSessionOpen } from "../../worker/src/market/instruments.ts";
import { FivePaisa, FpError, FpFeed } from "./fivepaisa.ts";
import type { FpConfig } from "./fivepaisa.ts";
import { IN_DEFS, IndiaBook, VIX, backfillDaily, dayT, istYmd, loadScrips, vixSnapshot } from "./india.ts";
import { CRYPTO_SYMBOLS, CryptoFeed } from "./crypto.ts";
import { Ingest } from "./push.ts";
import type { IngestBody, IngestResult } from "./push.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const IN_SYMBOLS = IN_DEFS.map((i) => i.symbol);
/** Public subscription key shipped in 5paisa's official py5paisa SDK (const.py JWT_HEADERS). */
const SDK_SUBSCRIPTION_KEY = "c89fab8d895a426d9e00db380b433027";

/* ---------------- config ---------------- */

interface Cfg {
  ingestUrl: string;
  token: string;
  fp: FpConfig | null;
  scripOverrides: Record<string, number>;
  india: boolean;
  crypto: boolean;
  pushMsIn: number;
  pushMsCrypto: number;
  cryptoJobMs: number;
  once: boolean;
  dryRun: boolean;
}

function num(v: string | undefined, def: number, min: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : def;
}

function loadCfg(argv: string[]): Cfg {
  const e = process.env;
  const base = (e.TUDUMM_URL ?? "https://tudumm.in").replace(/\/+$/, "");
  let token = e.INGEST_TOKEN ?? "";
  const tokenFile = join(homedir(), ".config", "tudumm", "ingest-token");
  if (!token && existsSync(tokenFile)) token = readFileSync(tokenFile, "utf8").trim();
  const need = ["FIVEPAISA_APP_KEY", "FIVEPAISA_ENCRYPTION_KEY", "FIVEPAISA_USER_ID", "FIVEPAISA_CLIENT_CODE", "FIVEPAISA_PIN", "FIVEPAISA_TOTP_SECRET"];
  const have = need.filter((k) => (e[k] ?? "").trim());
  if (have.length && have.length < need.length) throw new Error(`5paisa config incomplete: missing ${need.filter((k) => !have.includes(k)).join(", ")} (see runner/live.env.example)`);
  const fp: FpConfig | null = have.length
    ? {
        appKey: (e.FIVEPAISA_APP_KEY as string).trim(),
        encryptionKey: (e.FIVEPAISA_ENCRYPTION_KEY as string).trim(),
        userId: (e.FIVEPAISA_USER_ID as string).trim(),
        clientCode: (e.FIVEPAISA_CLIENT_CODE as string).trim(),
        pin: (e.FIVEPAISA_PIN as string).trim(),
        totpSecret: (e.FIVEPAISA_TOTP_SECRET as string).trim(),
        subscriptionKey: e.FIVEPAISA_SUBSCRIPTION_KEY === "none" ? null : (e.FIVEPAISA_SUBSCRIPTION_KEY ?? "").trim() || SDK_SUBSCRIPTION_KEY,
      }
    : null;
  const scripOverrides: Record<string, number> = {};
  for (const part of (e.FIVEPAISA_SCRIPS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [k, v] = part.split("=");
    if (k && Number(v) > 0) scripOverrides[k.trim().toUpperCase()] = Number(v);
  }
  const has = (f: string) => argv.includes(f);
  return {
    ingestUrl: `${base}/api/internal/ingest`,
    token,
    fp,
    scripOverrides,
    india: !!fp && !has("--no-india") && e.LIVE_INDIA !== "off",
    crypto: !has("--no-crypto") && e.LIVE_CRYPTO !== "off",
    pushMsIn: num(e.PUSH_MS_IN, 5_000, 2_000),
    pushMsCrypto: num(e.PUSH_MS_CRYPTO, 15_000, 5_000),
    cryptoJobMs: num(e.CRYPTO_JOB_MS, 300_000, 60_000),
    once: has("--once"),
    dryRun: has("--dry-run"),
  };
}

/* ---------------- logging ---------------- */

function stamp(): string {
  return new Date(Date.now() + 330 * 60000).toISOString().slice(11, 19) + " IST";
}
const log = (scope: string, msg: string) => console.log(`${stamp()} [${scope}] ${msg}`);
const warn = (scope: string, msg: string) => console.warn(`${stamp()} [${scope}] ⚠ ${msg}`);

function istParts(ms: number) {
  const d = new Date(ms + 330 * 60000);
  return { ymd: d.toISOString().slice(0, 10), dow: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

function reportEngine(scope: string, r: IngestResult | null): void {
  const e = r?.engine;
  if (!e) return;
  if (e.issued?.length) log(scope, `★ new call(s): ${e.issued.join(", ")}`);
  for (const t of e.transitions ?? []) log(scope, `• ${t.symbol}: ${t.type}${t.outcome ? ` (${t.outcome})` : ""}`);
}

/* ---------------- main ---------------- */

export async function main(argv: string[]): Promise<number> {
  const cfg = loadCfg(argv);
  if (!cfg.token && !cfg.dryRun) {
    console.error("✖ INGEST_TOKEN is not set and ~/.config/tudumm/ingest-token doesn't exist. Run scripts/set-secrets.sh, or put INGEST_TOKEN in runner/live.env.");
    return 2;
  }
  if (!cfg.india && !cfg.crypto) {
    console.error("✖ nothing to do: India needs FIVEPAISA_* in runner/live.env (see runner/live.env.example); crypto is disabled.");
    return 2;
  }
  const ingest = new Ingest(cfg.ingestUrl, cfg.token);
  const send = async (b: IngestBody): Promise<IngestResult | null> => {
    if (cfg.dryRun) {
      log("dry-run", `${b.job}: ${b.quotes?.length ?? 0} quotes, ${b.candles?.length ?? 0} candles, ${b.snapshots?.length ?? 0} snapshots, engine ${b.runEngine?.join(",") || "-"}, lifecycle ${b.lifecycle ? "yes" : "no"}`);
      return null;
    }
    return ingest.send(b);
  };
  log("live", `ingest → ${cfg.ingestUrl}${cfg.dryRun ? " (dry-run: nothing is sent)" : ""}`);
  log("live", `India (5paisa): ${cfg.india ? `on, push every ${cfg.pushMsIn / 1000}s in session` : cfg.fp ? "off" : "off — add FIVEPAISA_* to runner/live.env"}; crypto: ${cfg.crypto ? `on, quotes every ${cfg.pushMsCrypto / 1000}s` : "off"}`);

  const timers: ReturnType<typeof setInterval>[] = [];
  let feed: FpFeed | null = null;
  const shutdown = (code: number) => {
    for (const t of timers) clearInterval(t);
    feed?.stop();
    log("live", "stopped");
    process.exit(code);
  };
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  /* ---------- crypto ---------- */
  const cf = new CryptoFeed();
  let cryptoBusy = false;
  const cryptoFull = async () => {
    if (cryptoBusy) return;
    cryptoBusy = true;
    try {
      const now = Date.now();
      const j = await cf.fullJob(now);
      const bad = j.health.filter((h) => !h.ok);
      if (!j.rows.quotes.length && !j.rows.candles.length) {
        warn("crypto", `no data from Binance or Bybit (${bad.map((h) => `${h.source}: ${h.error}`).join("; ") || "unknown"})`);
        await send({ job: "live-crypto", health: j.health });
        return;
      }
      const r = cfg.dryRun
        ? await send({ job: "live-crypto", candles: j.rows.candles, quotes: j.rows.quotes, snapshots: j.rows.snapshots, health: j.health, runEngine: j.evaluate, lifecycle: true })
        : await ingest.sendChunked("live-crypto", j.rows.candles, { quotes: j.rows.quotes, snapshots: j.rows.snapshots, health: j.health, runEngine: j.evaluate, lifecycle: true });
      cf.markUploaded(j.evaluate.length ? j.completed : null);
      log("crypto", `full refresh: ${j.rows.quotes.length} quotes, ${j.rows.candles.length} bars${j.firstUpload ? " (initial history)" : ""}, ${j.rows.snapshots.length} snapshots${j.evaluate.length ? `; evaluated ${j.evaluate.join(",")}` : ""}${bad.length ? `; degraded: ${bad.map((h) => h.source).join(",")}` : ""}`);
      reportEngine("crypto", r);
    } catch (e) {
      warn("crypto", e instanceof Error ? e.message : "full refresh failed");
    } finally {
      cryptoBusy = false;
    }
  };
  const cryptoQuotes = async () => {
    if (cryptoBusy) return;
    try {
      const q = await cf.quotes(Date.now());
      if (!q.quotes.length) return;
      reportEngine("crypto", await send({ job: "live-crypto", quotes: q.quotes, health: q.health, lifecycle: true }));
    } catch (e) {
      warn("crypto", e instanceof Error ? e.message : "quote push failed");
    }
  };

  /* ---------- India ---------- */
  const fp = cfg.fp ? new FivePaisa(cfg.fp) : null;
  const book = new IndiaBook();
  const ist = {
    loginDay: "",
    historyDays: 0, // 0 until the first full backfill succeeds
    evalDay: "",
    closeDay: "",
    refusals: 0,
    nextLoginAt: 0,
    lastMsgAt: 0,
    feedOpen: false,
    lastHeartbeat: 0,
    lastBars: 0,
    lastHealth: 0,
    healthOk: null as boolean | null,
    busy: false,
  };
  const indiaHealth = async (ok: boolean, error: string | null, force = false) => {
    if (!force && ist.healthOk === ok && Date.now() - ist.lastHealth < 300_000) return;
    ist.healthOk = ok;
    ist.lastHealth = Date.now();
    try {
      await send({ job: "live-india", health: [{ source: "5paisa", ok, error }] });
    } catch {
      /* best effort */
    }
  };

  const indiaLogin = async (now: number): Promise<boolean> => {
    if (!fp) return false;
    try {
      await fp.login();
      ist.loginDay = istParts(now).ymd;
      ist.refusals = 0;
      book.bars.clear(); // yesterday's forming bars are final in D1 already
      log("india", `5paisa login ok (client ${fp.clientCode.replace(/.(?=.{3})/g, "•")})`);
      const { map, notes } = await loadScrips(fp, join(ROOT, "runner", ".cache"), cfg.scripOverrides, now);
      book.setScrips(map);
      log("india", `scrips: ${notes.join(", ")}`);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "login failed";
      // repeated wrong-PIN/TOTP attempts can lock a broker account: stop after two refusals
      if (e instanceof FpError && /refused/.test(msg)) ist.refusals++;
      ist.nextLoginAt = now + Math.min(15 * 60_000, 60_000 * 2 ** Math.min(ist.refusals + 1, 4));
      warn("india", msg);
      await indiaHealth(false, msg.slice(0, 180), true);
      if (ist.refusals >= 2) warn("india", "5paisa refused the login twice; India is paused so the account isn't locked. Fix runner/live.env and restart.");
      return false;
    }
  };

  const indiaBackfill = async (now: number, evaluate: boolean) => {
    if (!fp) return;
    const days = ist.historyDays ? 10 : 600;
    const b = await backfillDaily(fp, book.bySymbol, now, days);
    for (const err of b.errors) warn("india", `history ${err}`);
    if (!b.candles.length && b.errors.length) {
      await indiaHealth(false, `history: ${b.errors[0]?.slice(0, 160)}`, true);
      return;
    }
    if (b.vixHist.length) book.vixHist = ist.historyDays ? [...book.vixHist, ...b.vixHist] : b.vixHist;
    const session = nseSessionOpen(now);
    const quotes: QuoteRow[] = [];
    for (const [sym, x] of b.lastTwo) {
      if (session && book.quotes.has(sym)) continue; // the stream is fresher
      // outside the session the last daily close is the price; stamp it at that day's 15:30 IST close
      const today = x.ymd === istYmd(now);
      const asOf = today && session ? new Date(now).toISOString() : `${x.ymd}T10:00:00.000Z`;
      quotes.push({ symbol: sym, price: x.last, prevClose: x.prev, changePct: x.prev ? Math.round(((x.last - x.prev) / x.prev) * 100000) / 1000 : null, asOf, source: "5paisa" });
    }
    const snaps = book.vixHist.length ? [vixSnapshot(book.vixHist, new Date(now).toISOString())] : [];
    const runEngine = evaluate ? IN_SYMBOLS : [];
    const r = cfg.dryRun
      ? await send({ job: "live-india", candles: b.candles, quotes, snapshots: snaps, runEngine, lifecycle: true })
      : await ingest.sendChunked("live-india", b.candles, { quotes, snapshots: snaps, health: [{ source: "5paisa", ok: true, error: null }], runEngine, lifecycle: true });
    ist.historyDays = Math.max(ist.historyDays, days);
    log("india", `history: ${b.candles.length} daily bars over ${days} days, ${quotes.length} quotes${snaps.length ? ", India VIX history" : ""}${runEngine.length ? "; engine evaluated India" : ""}`);
    reportEngine("india", r);
  };

  const startFeed = () => {
    if (!fp || feed || !book.bySymbol.size) return;
    feed = new FpFeed(fp, [...book.bySymbol.values()], {
      onTicks: (ticks) => {
        ist.lastMsgAt = Date.now();
        for (const t of ticks) book.apply(t, Date.now());
      },
      onState: (s, detail) => {
        ist.feedOpen = s === "open";
        if (s === "open") ist.lastMsgAt = Date.now();
        (s === "open" ? log : warn)("india", `feed ${s}: ${detail}`);
      },
    });
    feed.start();
  };
  const stopFeed = () => {
    if (!feed) return;
    feed.stop();
    feed = null;
    ist.feedOpen = false;
    log("india", "feed stopped (session over)");
  };

  /** Session push: changed quotes every tick, all quotes as a heartbeat each minute (only while the
   *  stream is demonstrably alive), today's forming bars each minute; always step open calls. */
  const indiaPush = async () => {
    if (!fp || ist.busy || !book.bySymbol.size) return;
    const now = Date.now();
    if (!nseSessionOpen(now) && !book.dirty.size) return;
    ist.busy = true;
    try {
      const alive = ist.feedOpen && now - ist.lastMsgAt < 45_000;
      const heartbeat = alive && now - ist.lastHeartbeat > 60_000;
      const quotes = book.takeQuotes(heartbeat, new Date(now).toISOString());
      const barsDue = now - ist.lastBars > 60_000 && book.bars.size > 0;
      const candles = barsDue ? [...book.bars.values()] : [];
      if (!quotes.length && !candles.length) return;
      const r = await send({ job: "live-india", quotes, candles, lifecycle: true });
      if (heartbeat) ist.lastHeartbeat = now;
      if (barsDue) ist.lastBars = now;
      reportEngine("india", r);
      await indiaHealth(true, null);
    } catch (e) {
      warn("india", e instanceof Error ? e.message : "push failed");
    } finally {
      ist.busy = false;
    }
  };

  /** REST fallback for scrips the websocket hasn't ticked recently (also covers indices if the feed omits them). */
  const indiaRest = async () => {
    if (!fp || !fp.accessToken || !nseSessionOpen(Date.now())) return;
    const quiet = book.quiet(Date.now(), 20_000);
    if (!quiet.length) return;
    try {
      const ticks = await fp.marketFeed(quiet.map((s) => book.bySymbol.get(s)).filter((x): x is NonNullable<typeof x> => !!x));
      for (const t of ticks) book.apply(t, Date.now());
    } catch (e) {
      warn("india", `REST fallback: ${e instanceof Error ? e.message : "failed"}`);
      await indiaHealth(false, `REST fallback failed; feed ${ist.feedOpen ? "open" : "down"}`);
    }
  };

  /** Daily rhythm (IST, weekdays): 08:45 login + top-up history · 09:00–15:35 stream · 16:01 evaluate. */
  const indiaClock = async () => {
    if (!fp || ist.refusals >= 2) return;
    const now = Date.now();
    const p = istParts(now);
    const weekday = p.dow >= 1 && p.dow <= 5;
    if (ist.loginDay !== p.ymd && now >= ist.nextLoginAt && (ist.loginDay === "" || (weekday && p.min >= 8 * 60 + 45 && p.min < 16 * 60 + 30))) {
      stopFeed();
      if (await indiaLogin(now)) await indiaBackfill(now, !ist.historyDays);
      return;
    }
    if (!fp.accessToken) return;
    const inWindow = weekday && p.min >= 9 * 60 && p.min < 15 * 60 + 35;
    if (inWindow) startFeed();
    else if (feed) {
      stopFeed();
      await indiaPush(); // flush the last ticks
    }
    // after the close: push the final daily bars once, then evaluate on the completed bar (closeOffset 16:00 IST)
    if (weekday && p.min >= 15 * 60 + 36 && ist.closeDay !== p.ymd && book.bars.size) {
      ist.closeDay = p.ymd;
      const vix = book.quotes.get(VIX);
      if (vix) book.vixHist = [...book.vixHist.filter(([d]) => d !== p.ymd), [p.ymd, vix.price]];
      try {
        await send({ job: "live-india", candles: [...book.bars.values()].filter((c) => c.t === dayT(p.ymd)), snapshots: book.vixHist.length ? [vixSnapshot(book.vixHist, new Date(now).toISOString())] : [], lifecycle: true });
        log("india", "session closed: final daily bars pushed");
      } catch (e) {
        warn("india", e instanceof Error ? e.message : "close push failed");
      }
    }
    if (weekday && p.min >= 16 * 60 + 1 && ist.evalDay !== p.ymd && ist.closeDay === p.ymd) {
      ist.evalDay = p.ymd;
      try {
        const r = await send({ job: "live-india", runEngine: IN_SYMBOLS, lifecycle: true });
        log("india", `daily bar completed: engine evaluated ${IN_SYMBOLS.length} instruments`);
        reportEngine("india", r);
      } catch (e) {
        warn("india", e instanceof Error ? e.message : "evaluation failed");
      }
    }
  };

  /* ---------- start ---------- */
  if (cfg.crypto) await cryptoFull();
  if (cfg.india) {
    await indiaClock();
    if (cfg.once && fp?.accessToken) {
      await indiaRest();
      await indiaPush();
    }
  }
  if (cfg.once) {
    log("live", "--once: done");
    return 0;
  }
  if (cfg.crypto) {
    timers.push(setInterval(cryptoQuotes, cfg.pushMsCrypto));
    timers.push(setInterval(cryptoFull, cfg.cryptoJobMs));
    // and right after every 4H boundary (+40 s) so a completed bar is evaluated promptly
    timers.push(
      setInterval(() => {
        const s = Math.floor(Date.now() / 1000) % 14400;
        if (s >= 40 && s < 70) void cryptoFull();
      }, 30_000),
    );
  }
  if (cfg.india) {
    timers.push(setInterval(indiaClock, 20_000));
    timers.push(setInterval(indiaPush, cfg.pushMsIn));
    timers.push(setInterval(indiaRest, 10_000));
  }
  log("live", `running (${[cfg.india ? "India" : null, cfg.crypto ? `crypto ${CRYPTO_SYMBOLS.join("/")}` : null].filter(Boolean).join(" + ")}). Ctrl-C to stop.`);
  return await new Promise<number>(() => {
    /* run until a signal */
  });
}
