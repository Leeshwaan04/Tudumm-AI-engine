// Crypto + PAXG gold proxy from THIS machine's egress (Binance/Bybit refuse some Cloudflare egress).
// - full job (klines, depth, perp funding/OI, fear & greed): the Worker's own cryptoJob, unchanged,
//   run here against an in-memory stand-in for D1, then POSTed to /api/internal/ingest as rows;
// - fast quotes in between: one 24h-ticker call (Binance, Bybit per-symbol fallback).
import type { MarketDb, Row, SqlStmt } from "../../worker/src/market/store.ts";
import type { QuoteRow, SnapshotRow } from "../../worker/src/market/types.ts";
import { BINANCE_SET, cryptoJob } from "../../worker/src/market/jobs.ts";
import { Health, tryFetch } from "../../worker/src/data/http.ts";
import { fetchTickers } from "../../worker/src/data/binance.ts";
import type { Ticker24h } from "../../worker/src/data/binance.ts";
import { fetchBybitSpotTicker } from "../../worker/src/data/bybit.ts";
import { roundTo } from "../../worker/src/engine/util.ts";

export const CRYPTO_SYMBOLS = BINANCE_SET.map((i) => i.symbol);
const H4 = 14400;

/**
 * cryptoJob issues exactly two reads: 4H candle counts per symbol, then the previous perp/F&G snapshots.
 * We answer them from memory: after the first full upload the Worker already has 250 bars, so we report
 * that and the job only sends the last few bars; previous snapshots carry the OI samples forward.
 */
class MemDb implements MarketDb {
  barsUploaded = false;
  prev = new Map<string, { json: unknown; asOf: string }>();
  async read(stmts: SqlStmt[]): Promise<Row[][]> {
    if (stmts.length !== 2 || !/FROM candles/i.test(stmts[0]?.sql ?? "") || !/FROM snapshots/i.test(stmts[1]?.sql ?? "")) {
      throw new Error("MemDb: cryptoJob's reads changed; update runner/live/crypto.ts");
    }
    const counts = this.barsUploaded ? BINANCE_SET.map((i) => ({ symbol: i.symbol, n: 250 })) : [];
    const snaps = [...this.prev.entries()].map(([key, v]) => ({ key, json: JSON.stringify(v.json), as_of: v.asOf }));
    return [counts, snaps];
  }
  async write(): Promise<void> {
    /* rows go to the Worker via ingest instead */
  }
}

export class CryptoFeed {
  private db = new MemDb();
  /** Open time of the newest COMPLETED 4H bar we've asked the Worker to evaluate. */
  lastEvalBarT = 0;

  /** Full refresh. Returns rows for ingest + which symbols have a newly completed 4H bar to evaluate. */
  async fullJob(nowMs: number) {
    const health = new Health();
    const out = await cryptoJob(this.db, health, new Date(nowMs));
    const rows = out.rows ?? { quotes: [], candles: [], snapshots: [] };
    for (const s of rows.snapshots) if (s.key.startsWith("deriv:") || s.key === "ctx:CRYPTO") this.db.prev.set(s.key, { json: s.json, asOf: s.asOf });
    const completed = Math.floor(nowMs / 1000 / H4) * H4 - H4; // open time of the last completed 4H bar
    const evaluate = rows.candles.length && completed > this.lastEvalBarT ? CRYPTO_SYMBOLS : [];
    return { rows, health: health.entries(), evaluate, completed, firstUpload: !this.db.barsUploaded };
  }

  markUploaded(evaluatedBarT: number | null): void {
    this.db.barsUploaded = true;
    if (evaluatedBarT !== null) this.lastEvalBarT = evaluatedBarT;
  }

  /** Fast price refresh for the lifecycle (one Binance call; Bybit per missing symbol). */
  async quotes(nowMs: number): Promise<{ quotes: QuoteRow[]; health: { source: "binance" | "bybit"; ok: boolean; error: string | null }[] }> {
    const health = new Health();
    const nowIso = new Date(nowMs).toISOString();
    const syms = BINANCE_SET.map((i) => i.dataSymbol);
    const list: { t: Ticker24h; venue: "binance" | "bybit" }[] = ((await tryFetch(health, "binance", () => fetchTickers(syms))) ?? []).map((t) => ({ t, venue: "binance" as const }));
    for (const i of BINANCE_SET) {
      if (list.some((x) => x.t.symbol === i.dataSymbol)) continue;
      const t = await tryFetch(health, "bybit", () => fetchBybitSpotTicker(i.dataSymbol));
      if (t) list.push({ t, venue: "bybit" });
    }
    const quotes: QuoteRow[] = [];
    for (const i of BINANCE_SET) {
      const x = list.find((y) => y.t.symbol === i.dataSymbol);
      if (!x || !(x.t.last > 0)) continue;
      const t = x.t;
      quotes.push({ symbol: i.symbol, price: t.last, prevClose: t.open > 0 ? t.open : null, changePct: roundTo(t.changePct, 3), dayOpen: t.open, dayHigh: t.high, dayLow: t.low, volume: t.volume, bid: t.bid, ask: t.ask, bidSize: t.bidQty, askSize: t.askQty, asOf: nowIso, source: x.venue });
    }
    return { quotes, health: health.entries().filter((h): h is { source: "binance" | "bybit"; ok: boolean; error: string | null } => h.source === "binance" || h.source === "bybit") };
  }
}

export type { SnapshotRow };
