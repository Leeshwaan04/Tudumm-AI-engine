// NSE end-of-day archives (UDiFF CM/F&O bhavcopy + index closes). PURE parsers; the downloads and
// unzip run in the Node runner (files are 0.2-1.3 MB zipped). Live NSE JSON APIs are NOT used.
import type { Candle } from "../engine/types";
import type { OptionLeg } from "../engine/options";
import { classifyBuildUp, impliedVol } from "../engine/options";
import type { BuildUpClass } from "../engine/types";

export const NSE_ARCHIVES = "https://nsearchives.nseindia.com";
export const cmUrl = (ymd: string) => `${NSE_ARCHIVES}/content/cm/BhavCopy_NSE_CM_0_0_0_${ymd}_F_0000.csv.zip`;
export const foUrl = (ymd: string) => `${NSE_ARCHIVES}/content/fo/BhavCopy_NSE_FO_0_0_0_${ymd}_F_0000.csv.zip`;
/** ddmmyyyy */
export const indexUrl = (dmy: string) => `${NSE_ARCHIVES}/content/indices/ind_close_all_${dmy}.csv`;

export const RISK_FREE_IN = 0.065;

/** Minimal RFC-4180 CSV parser (quoted fields, "" escapes). Returns rows of strings. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || (row[0] ?? "") !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** CSV text -> array of objects keyed by the (trimmed) header. */
export function csvObjects(text: string): Record<string, string>[] {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  const head = (rows[0] ?? []).map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const o: Record<string, string> = {};
    head.forEach((h, i) => (o[h] = (r[i] ?? "").trim()));
    return o;
  });
}

const n = (s: string | undefined): number => {
  if (s === undefined || s === "" || s === "-") return NaN;
  const v = Number(s);
  return Number.isFinite(v) ? v : NaN;
};

export const ymdToT = (ymd: string): number => Math.floor(Date.parse(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00Z`) / 1000);
export const isoDateToT = (d: string): number => Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000);

export interface CmRow {
  symbol: string;
  date: string; // YYYY-MM-DD
  candle: Candle;
  prevClose: number | null;
}

/** CM bhavcopy -> rows for the wanted symbols (EQ series only). */
export function parseCm(text: string, want: ReadonlySet<string>): CmRow[] {
  const out: CmRow[] = [];
  for (const r of csvObjects(text)) {
    const sym = r.TckrSymb ?? "";
    if (!want.has(sym) || r.SctySrs !== "EQ") continue;
    const date = r.TradDt ?? "";
    const c: Candle = { t: isoDateToT(date), o: n(r.OpnPric), h: n(r.HghPric), l: n(r.LwPric), c: n(r.ClsPric), v: n(r.TtlTradgVol) || 0 };
    if (![c.t, c.o, c.h, c.l, c.c].every((x) => Number.isFinite(x) && x > 0)) continue;
    const pc = n(r.PrvsClsgPric);
    out.push({ symbol: sym, date, candle: c, prevClose: pc > 0 ? pc : null });
  }
  return out;
}

export interface IndexRow {
  name: string;
  date: string; // YYYY-MM-DD
  candle: Candle;
  pe: number | null;
  pb: number | null;
  divYield: number | null;
  changePct: number | null;
}

/** ind_close_all CSV -> rows for the wanted index names (e.g. "Nifty 50", "Nifty Bank", "India VIX"). */
export function parseIndexClose(text: string, want: ReadonlySet<string>): IndexRow[] {
  const seen = new Set<string>();
  const out: IndexRow[] = [];
  for (const r of csvObjects(text)) {
    const name = r["Index Name"] ?? "";
    if (!want.has(name) || seen.has(name)) continue;
    const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(r["Index Date"] ?? "");
    if (!m) continue;
    const date = `${m[3]}-${m[2]}-${m[1]}`;
    const close = n(r["Closing Index Value"]);
    const c: Candle = {
      t: isoDateToT(date),
      o: n(r["Open Index Value"]) || close,
      h: n(r["High Index Value"]) || close,
      l: n(r["Low Index Value"]) || close,
      c: close,
      v: n(r.Volume) || 0,
    };
    if (!(c.c > 0)) continue;
    seen.add(name);
    const pe = n(r["P/E"]);
    const pb = n(r["P/B"]);
    const dy = n(r["Div Yield"]);
    const ch = n(r["Change(%)"]);
    out.push({ name, date, candle: c, pe: pe > 0 ? pe : null, pb: pb > 0 ? pb : null, divYield: dy >= 0 ? dy : null, changePct: Number.isFinite(ch) ? ch : null });
  }
  return out;
}

export interface FuturesSummary {
  nearExpiry: string;
  close: number;
  prevClose: number;
  oi: number; // all expiries
  oiChange: number;
  priceChangePct: number;
  oiChangePct: number;
  class: BuildUpClass;
  lotSize: number | null;
}

export interface FoSummary {
  underlying: string;
  tradeDate: string;
  spot: number;
  expiry: string;
  dte: number;
  legs: OptionLeg[]; // nearest expiry (> trade date), all strikes
  futures: FuturesSummary | null;
  lotSize: number | null;
}

/**
 * F&O bhavcopy -> per-underlying summary: nearest expiry strictly after the trade date, every strike
 * with OI, change in OI, settlement-price implied vol (Black-Scholes, r = 6.5%, q = 0), plus futures
 * OI build-up (OI summed over all expiries; price change of the near-month contract).
 */
export function parseFo(text: string, want: ReadonlySet<string>): Map<string, FoSummary> {
  type Opt = { exp: string; strike: number; type: "C" | "P"; oi: number; doi: number; vol: number; settle: number; close: number; spot: number; lot: number };
  type Fut = { exp: string; close: number; prev: number; oi: number; doi: number; lot: number; spot: number };
  const opts = new Map<string, Opt[]>();
  const futs = new Map<string, Fut[]>();
  let tradeDate = "";
  for (const r of csvObjects(text)) {
    const u = r.TckrSymb ?? "";
    if (!want.has(u)) continue;
    const tp = r.FinInstrmTp ?? "";
    tradeDate ||= r.TradDt ?? "";
    if (tp === "IDO" || tp === "STO") {
      const ot = r.OptnTp === "CE" ? "C" : r.OptnTp === "PE" ? "P" : null;
      if (!ot) continue;
      const o: Opt = {
        exp: r.XpryDt ?? "",
        strike: n(r.StrkPric),
        type: ot,
        oi: n(r.OpnIntrst) || 0,
        doi: n(r.ChngInOpnIntrst) || 0,
        vol: n(r.TtlTradgVol) || 0,
        settle: n(r.SttlmPric),
        close: n(r.ClsPric),
        spot: n(r.UndrlygPric),
        lot: n(r.NewBrdLotQty),
      };
      if (!(o.strike > 0) || !o.exp) continue;
      let a = opts.get(u);
      if (!a) opts.set(u, (a = []));
      a.push(o);
    } else if (tp === "IDF" || tp === "STF") {
      const f: Fut = { exp: r.XpryDt ?? "", close: n(r.ClsPric), prev: n(r.PrvsClsgPric), oi: n(r.OpnIntrst) || 0, doi: n(r.ChngInOpnIntrst) || 0, lot: n(r.NewBrdLotQty), spot: n(r.UndrlygPric) };
      if (!f.exp || !(f.close > 0)) continue;
      let a = futs.get(u);
      if (!a) futs.set(u, (a = []));
      a.push(f);
    }
  }
  const out = new Map<string, FoSummary>();
  for (const u of want) {
    const os = opts.get(u) ?? [];
    const fs = (futs.get(u) ?? []).sort((a, b) => a.exp.localeCompare(b.exp));
    const expiries = [...new Set(os.map((o) => o.exp))].filter((e) => e > tradeDate).sort();
    const expiry = expiries[0];
    let futures: FuturesSummary | null = null;
    const near = fs.find((f) => f.exp > tradeDate) ?? fs[0];
    if (near && near.prev > 0) {
      const oi = fs.reduce((a, f) => a + f.oi, 0);
      const doi = fs.reduce((a, f) => a + f.doi, 0);
      const prevOi = oi - doi;
      const pc = ((near.close - near.prev) / near.prev) * 100;
      const oc = prevOi > 0 ? (doi / prevOi) * 100 : 0;
      futures = {
        nearExpiry: near.exp,
        close: near.close,
        prevClose: near.prev,
        oi,
        oiChange: doi,
        priceChangePct: Math.round(pc * 100) / 100,
        oiChangePct: Math.round(oc * 100) / 100,
        class: classifyBuildUp(pc, oc),
        lotSize: near.lot > 0 ? near.lot : null,
      };
    }
    if (!expiry && !futures) continue;
    const legsRaw = expiry ? os.filter((o) => o.exp === expiry) : [];
    const spot = legsRaw.find((o) => o.spot > 0)?.spot ?? near?.spot ?? NaN;
    const dte = expiry ? Math.max(0, Math.round((isoDateToT(expiry) - isoDateToT(tradeDate)) / 86400)) : 0;
    const t = dte / 365;
    const legs: OptionLeg[] = legsRaw.map((o) => {
      const px = o.settle > 0 ? o.settle : o.close;
      return {
        strike: o.strike,
        type: o.type,
        oi: o.oi,
        doi: o.doi,
        volume: o.vol,
        iv: spot > 0 && t > 0 ? impliedVol(px, spot, o.strike, t, RISK_FREE_IN, o.type === "C") : null,
        ltp: o.close > 0 ? o.close : px > 0 ? px : null,
      };
    });
    out.set(u, { underlying: u, tradeDate, spot, expiry: expiry ?? "", dte, legs, futures, lotSize: legsRaw[0]?.lot && legsRaw[0].lot > 0 ? legsRaw[0].lot : (futures?.lotSize ?? null) });
  }
  return out;
}
