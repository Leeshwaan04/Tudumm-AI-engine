// India via 5paisa: map Tudumm symbols to 5paisa scrip codes, backfill daily history, and turn
// MarketFeedV3 ticks into quotes + today's forming daily bar.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INSTRUMENTS } from "../../worker/src/market/instruments.ts";
import type { CandleRow, QuoteRow, SnapshotRow } from "../../worker/src/market/types.ts";
import type { VixHistorySnapshot } from "../../worker/src/market/snapshots.ts";
import { roundTo } from "../../worker/src/engine/util.ts";
import type { FivePaisa, FpScrip, FpTick } from "./fivepaisa.ts";
import { parseNetDate } from "./fivepaisa.ts";

export const IN_DEFS = INSTRUMENTS.filter((i) => i.market === "IN");
export const VIX = "INDIAVIX";

/** Index names as they can appear in the scrip master (Name / FullName / SymbolRoot / ScripData). */
const INDEX_NAMES: Record<string, string[]> = {
  NIFTY: ["NIFTY", "NIFTY 50", "NIFTY50", "NIFTY_EQ", "NIFTY 50_EQ"],
  BANKNIFTY: ["BANKNIFTY", "NIFTY BANK", "BANK NIFTY", "BANKNIFTY_EQ", "NIFTY BANK_EQ"],
  [VIX]: ["INDIAVIX", "INDIA VIX", "INDIAVIX_EQ", "INDIA VIX_EQ"],
};
/** Last-resort index codes widely used with 5paisa's feed. Only used when name matching fails, and logged. */
const INDEX_FALLBACK: Record<string, number> = { NIFTY: 999920000, BANKNIFTY: 999920005 };

export function istYmd(ms: number): string {
  return new Date(ms + 330 * 60000).toISOString().slice(0, 10);
}
/** Daily candle key used everywhere in Tudumm: 00:00 UTC of the IST trading date. */
export function dayT(ymd: string): number {
  return Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / 1000;
}

/* ---------------- scrip master ---------------- */

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export interface ScripRow {
  exch: string;
  exchType: string;
  code: number;
  names: string[]; // upper-cased Name, FullName, SymbolRoot, ScripData
  series: string;
  scripType: string;
}

export function parseScripMaster(csv: string): ScripRow[] {
  const rows = parseCsv(csv);
  const head = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
  const col = (n: string) => head.indexOf(n.toLowerCase());
  const iEx = col("Exch");
  const iTy = col("ExchType");
  const iCode = col("ScripCode") >= 0 ? col("ScripCode") : col("Scripcode");
  if (iEx < 0 || iTy < 0 || iCode < 0) throw new Error(`scrip master: unexpected header (${head.slice(0, 8).join(",")})`);
  const nameCols = ["Name", "FullName", "SymbolRoot", "ScripData"].map(col).filter((k) => k >= 0);
  const iSeries = col("Series");
  const iType = col("ScripType");
  const out: ScripRow[] = [];
  for (const r of rows) {
    const code = Number(r[iCode]);
    if (!Number.isFinite(code) || code <= 0) continue;
    out.push({
      exch: String(r[iEx] ?? "").trim(),
      exchType: String(r[iTy] ?? "").trim().toUpperCase(),
      code,
      names: nameCols.map((k) => String(r[k] ?? "").trim().toUpperCase()).filter(Boolean),
      series: iSeries >= 0 ? String(r[iSeries] ?? "").trim().toUpperCase() : "",
      scripType: iType >= 0 ? String(r[iType] ?? "").trim().toUpperCase() : "",
    });
  }
  return out;
}

/** Resolve NSE cash scrip codes for the India universe + India VIX. `overrides` wins (FIVEPAISA_SCRIPS). */
export function resolveScrips(rows: ScripRow[], overrides: Record<string, number>): { map: Map<string, FpScrip>; notes: string[] } {
  const map = new Map<string, FpScrip>();
  const notes: string[] = [];
  const nseCash = rows.filter((r) => r.exch === "N" && r.exchType === "C");
  const want = [...IN_DEFS.map((i) => ({ symbol: i.symbol, data: i.dataSymbol.toUpperCase(), index: i.assetClass === "index" })), { symbol: VIX, data: VIX, index: true }];
  for (const w of want) {
    const o = overrides[w.symbol];
    if (o) {
      map.set(w.symbol, { exch: "N", exchType: "C", code: o });
      notes.push(`${w.symbol}=${o} (override)`);
      continue;
    }
    let hit: ScripRow | undefined;
    if (w.index) {
      const names = INDEX_NAMES[w.symbol] ?? [w.data];
      hit = nseCash.find((r) => r.names.some((n) => names.includes(n)) && r.code >= 999_000_000) ?? nseCash.find((r) => r.names.some((n) => names.includes(n)) && r.series !== "EQ");
    } else {
      hit = nseCash.find((r) => r.names.includes(`${w.data}_EQ`)) ?? nseCash.find((r) => r.names.includes(w.data) && (r.series === "EQ" || r.series === ""));
    }
    if (hit) {
      map.set(w.symbol, { exch: "N", exchType: "C", code: hit.code });
      notes.push(`${w.symbol}=${hit.code}`);
    } else if (INDEX_FALLBACK[w.symbol]) {
      map.set(w.symbol, { exch: "N", exchType: "C", code: INDEX_FALLBACK[w.symbol] as number });
      notes.push(`${w.symbol}=${INDEX_FALLBACK[w.symbol]} (fallback code: not found by name; verify or set FIVEPAISA_SCRIPS)`);
    } else notes.push(`${w.symbol}: NOT FOUND (set FIVEPAISA_SCRIPS=${w.symbol}=<code>)`);
  }
  return { map, notes };
}

/** Scrip master for NSE cash, cached per IST day under runner/.cache/5paisa/. */
export async function loadScrips(fp: FivePaisa, cacheDir: string, overrides: Record<string, number>, nowMs: number) {
  const dir = join(cacheDir, "5paisa");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `scrips-nse_eq-${istYmd(nowMs)}.csv`);
  let csv: string;
  if (existsSync(file)) csv = readFileSync(file, "utf8");
  else {
    csv = await fp.scripMasterCsv("nse_eq");
    writeFileSync(file, csv);
  }
  let res = resolveScrips(parseScripMaster(csv), overrides);
  // NSE indices may live only in the full master; try it once if any index is unresolved
  if ([...IN_DEFS.filter((i) => i.assetClass === "index").map((i) => i.symbol), VIX].some((s) => !res.map.has(s) || res.notes.some((n) => n.startsWith(`${s}=`) && n.includes("fallback")))) {
    const allFile = join(dir, `scrips-all-${istYmd(nowMs)}.csv`);
    try {
      let all: string;
      if (existsSync(allFile)) all = readFileSync(allFile, "utf8");
      else {
        all = await fp.scripMasterCsv("all");
        writeFileSync(allFile, all);
      }
      res = resolveScrips(parseScripMaster(csv + "\n" + all.split(/\r?\n/).slice(1).join("\n")), overrides);
    } catch {
      /* keep the nse_eq result */
    }
  }
  return res;
}

/* ---------------- history ---------------- */

export async function backfillDaily(fp: FivePaisa, scrips: Map<string, FpScrip>, nowMs: number, days: number) {
  const to = istYmd(nowMs);
  const from = istYmd(nowMs - days * 86400000);
  const candles: CandleRow[] = [];
  const vixHist: [string, number][] = [];
  const errors: string[] = [];
  const lastTwo = new Map<string, { prev: number | null; last: number; ymd: string }>();
  for (const [symbol, s] of scrips) {
    try {
      const rows = await fp.historical(s, "1d", from, to);
      const closes: { ymd: string; c: number }[] = [];
      for (const [ts, o, h, l, c, v] of rows) {
        const ymd = ts.slice(0, 10);
        if (!(o > 0 && h > 0 && l > 0 && c > 0 && h >= l)) continue;
        closes.push({ ymd, c });
        if (symbol === VIX) vixHist.push([ymd, c]);
        else candles.push({ symbol, tf: "1D", t: dayT(ymd), o, h, l, c, v: Number.isFinite(v) && v >= 0 ? v : 0 });
      }
      const last = closes[closes.length - 1];
      if (last) lastTwo.set(symbol, { prev: closes.length > 1 ? (closes[closes.length - 2] as { c: number }).c : null, last: last.c, ymd: last.ymd });
    } catch (e) {
      errors.push(`${symbol}: ${e instanceof Error ? e.message : "failed"}`);
    }
    await new Promise((r) => setTimeout(r, 250)); // be polite: sequential with a small gap
  }
  return { candles, vixHist, lastTwo, errors };
}

export function vixSnapshot(hist: [string, number][], asOf: string): SnapshotRow {
  const sorted = [...new Map(hist).entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-260);
  const json: VixHistorySnapshot = { label: "India VIX", history: sorted, asOf };
  return { key: "ctx:IN", json, asOf, source: "5paisa" };
}

/* ---------------- live state from ticks ---------------- */

export class IndiaBook {
  bySymbol = new Map<string, FpScrip>();
  byToken = new Map<number, string>();
  quotes = new Map<string, QuoteRow>();
  bars = new Map<string, CandleRow>();
  lastTickMs = new Map<string, number>();
  dirty = new Set<string>();
  vixHist: [string, number][] = [];

  setScrips(m: Map<string, FpScrip>): void {
    this.bySymbol = m;
    this.byToken = new Map([...m.entries()].map(([sym, s]) => [s.code, sym]));
  }

  apply(t: FpTick, nowMs: number): void {
    const sym = t.Token !== undefined ? this.byToken.get(t.Token) : undefined;
    if (!sym) return;
    const last = Number(t.LastRate);
    if (!(last > 0)) return;
    const pc = Number(t.PClose) > 0 ? Number(t.PClose) : null;
    const tickMs = parseNetDate(t.TickDt);
    // stamp with our clock (the push time is what staleness means to users); ignore stale replays
    const asOfMs = tickMs && Math.abs(nowMs - tickMs) < 6 * 3600_000 ? Math.min(nowMs, Math.max(tickMs, nowMs - 5000)) : nowMs;
    const pos = (x: unknown) => (Number(x) > 0 ? Number(x) : null);
    const q: QuoteRow = {
      symbol: sym,
      price: last,
      prevClose: pc,
      changePct: pc ? roundTo(((last - pc) / pc) * 100, 3) : Number.isFinite(t.ChgPcnt) ? roundTo(Number(t.ChgPcnt), 3) : null,
      dayOpen: pos(t.OpenRate),
      dayHigh: pos(t.High),
      dayLow: pos(t.Low),
      volume: Number(t.TotalQty) >= 0 ? Number(t.TotalQty) : null,
      bid: pos(t.BidRate),
      ask: pos(t.OffRate),
      bidSize: Number(t.BidQty) >= 0 ? Number(t.BidQty) : null,
      askSize: Number(t.OffQty) >= 0 ? Number(t.OffQty) : null,
      asOf: new Date(asOfMs).toISOString(),
      source: "5paisa",
    };
    this.quotes.set(sym, q);
    this.lastTickMs.set(sym, nowMs);
    this.dirty.add(sym);
    if (sym === VIX) return;
    // today's forming daily bar (the engine only evaluates completed bars; the lifecycle uses its
    // high/low so a stop or target touched intraday resolves even between pushes)
    const o = pos(t.OpenRate);
    const h = Math.max(pos(t.High) ?? last, last);
    const l = Math.min(pos(t.Low) ?? last, last);
    if (o) this.bars.set(sym, { symbol: sym, tf: "1D", t: dayT(istYmd(nowMs)), o, h: Math.max(h, o), l: Math.min(l, o), c: last, v: Number(t.TotalQty) >= 0 ? Number(t.TotalQty) : 0 });
  }

  /** Symbols without a websocket tick for `quietMs` (candidates for the REST fallback). */
  quiet(nowMs: number, quietMs: number): string[] {
    return [...this.bySymbol.keys()].filter((s) => nowMs - (this.lastTickMs.get(s) ?? 0) > quietMs);
  }

  takeQuotes(all: boolean, nowIso: string): QuoteRow[] {
    const syms = all ? [...this.quotes.keys()] : [...this.dirty];
    this.dirty.clear();
    // a heartbeat re-push keeps asOf honest: the value is unchanged but was confirmed now
    return syms.map((s) => this.quotes.get(s)).filter((q): q is QuoteRow => !!q).map((q) => (all ? { ...q, asOf: nowIso } : q));
  }
}
