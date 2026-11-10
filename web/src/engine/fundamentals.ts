import type { Instrument } from "./types";

/** All values are SIMULATED for the prototype. */
export interface EquityFundamentals {
  kind: "equity";
  sector: string;
  pe: number;
  sectorPe: number;
  pb: number;
  evEbitda: number;
  revGrowth: number;
  epsGrowth: number;
  roe: number;
  debtEquity: number;
  opMargin: number;
  netMargin: number;
  divYield: number;
  holders: { label: string; pct: number; chg: number }[];
  earningsInDays: number;
  earningsNote: string;
}
export interface IndexFundamentals {
  kind: "index";
  pe: number;
  pe5yAvg: number;
  pb: number;
  divYield: number;
  advancers: number;
  decliners: number;
  constituents: number;
  above50dma: number;
  above200dma: number;
  note: string;
}
export interface FxFundamentals {
  kind: "fx";
  base: { ccy: string; bank: string; rate: number; cpi: number };
  quote: { ccy: string; bank: string; rate: number; cpi: number };
  spread2y: number;
  spreadTrend: string;
  note: string;
}
export interface CommodityFundamentals {
  kind: "commodity";
  rows: { label: string; value: string; read: "supportive" | "pressure" | "neutral" }[];
  balance: string;
  note: string;
}
export interface NotApplicable {
  kind: "na";
  reason: string;
  instead: string;
}
export type Fundamentals = EquityFundamentals | IndexFundamentals | FxFundamentals | CommodityFundamentals | NotApplicable;

const IN_HOLDERS = (p: number, f: number, d: number, pc: number, fc: number, dc: number) => [
  { label: "Promoter", pct: p, chg: pc },
  { label: "FII", pct: f, chg: fc },
  { label: "DII", pct: d, chg: dc },
  { label: "Retail & others", pct: Math.round((100 - p - f - d) * 10) / 10, chg: Math.round((-pc - fc - dc) * 10) / 10 },
];
const GLOBAL_HOLDERS = (inst: number, ins: number, ic: number, nc: number) => [
  { label: "Institutions", pct: inst, chg: ic },
  { label: "Insiders", pct: ins, chg: nc },
  { label: "Retail & others", pct: Math.round((100 - inst - ins) * 10) / 10, chg: Math.round((-ic - nc) * 10) / 10 },
];

const EQUITIES: Record<string, Omit<EquityFundamentals, "kind">> = {
  RELIANCE: { sector: "Energy & telecom", pe: 24.8, sectorPe: 19.6, pb: 2.3, evEbitda: 11.9, revGrowth: 7.4, epsGrowth: 11.2, roe: 9.8, debtEquity: 0.41, opMargin: 17.6, netMargin: 8.1, divYield: 0.4, holders: IN_HOLDERS(50.1, 19.2, 18.4, 0, 0.6, 0.3), earningsInDays: 74, earningsNote: "Q3 FY27 results" },
  HDFCBANK: { sector: "Private banks", pe: 18.9, sectorPe: 16.2, pb: 2.6, evEbitda: 0, revGrowth: 14.8, epsGrowth: 16.5, roe: 14.6, debtEquity: 0, opMargin: 0, netMargin: 22.4, divYield: 1.1, holders: IN_HOLDERS(0, 48.3, 33.9, 0, 0.9, -0.2), earningsInDays: 68, earningsNote: "Q3 FY27 results" },
  TCS: { sector: "IT services", pe: 23.1, sectorPe: 25.4, pb: 11.8, evEbitda: 16.4, revGrowth: 2.1, epsGrowth: 3.4, roe: 49.2, debtEquity: 0.08, opMargin: 24.3, netMargin: 19.1, divYield: 2.0, holders: IN_HOLDERS(71.8, 11.6, 11.9, 0, -0.7, 0.4), earningsInDays: 61, earningsNote: "Q3 FY27 results" },
  INFY: { sector: "IT services", pe: 24.6, sectorPe: 25.4, pb: 7.4, evEbitda: 15.8, revGrowth: 4.6, epsGrowth: 6.1, roe: 30.1, debtEquity: 0.09, opMargin: 21.0, netMargin: 17.2, divYield: 2.6, holders: IN_HOLDERS(14.4, 32.8, 37.1, 0, -0.4, 0.6), earningsInDays: 2, earningsNote: "Q2 results: binary event" },
  ICICIBANK: { sector: "Private banks", pe: 19.7, sectorPe: 16.2, pb: 3.2, evEbitda: 0, revGrowth: 13.9, epsGrowth: 15.1, roe: 17.4, debtEquity: 0, opMargin: 0, netMargin: 25.8, divYield: 0.8, holders: IN_HOLDERS(0, 45.6, 44.8, 0, 0.5, 0.7), earningsInDays: 71, earningsNote: "Q3 FY27 results" },
  SBIN: { sector: "PSU banks", pe: 9.6, sectorPe: 8.1, pb: 1.5, evEbitda: 0, revGrowth: 10.2, epsGrowth: 12.7, roe: 17.9, debtEquity: 0, opMargin: 0, netMargin: 15.3, divYield: 1.8, holders: IN_HOLDERS(57.4, 9.8, 24.6, 0, 0.4, 0.3), earningsInDays: 80, earningsNote: "Q3 FY27 results" },
  NVDA: { sector: "Semiconductors", pe: 41.2, sectorPe: 29.8, pb: 38.5, evEbitda: 33.6, revGrowth: 61.8, epsGrowth: 58.4, roe: 92.3, debtEquity: 0.11, opMargin: 61.9, netMargin: 54.7, divYield: 0.02, holders: GLOBAL_HOLDERS(67.4, 4.1, 1.2, -0.1), earningsInDays: 98, earningsNote: "Q4 FY27 results" },
  AAPL: { sector: "Consumer hardware", pe: 33.4, sectorPe: 24.9, pb: 51.2, evEbitda: 25.1, revGrowth: 6.3, epsGrowth: 9.1, roe: 151.0, debtEquity: 1.47, opMargin: 31.8, netMargin: 26.4, divYield: 0.4, holders: GLOBAL_HOLDERS(62.8, 0.1, 0.1, 0), earningsInDays: 79, earningsNote: "Q1 FY27 results" },
  TSLA: { sector: "Autos & energy", pe: 168.3, sectorPe: 18.4, pb: 15.7, evEbitda: 86.2, revGrowth: -2.7, epsGrowth: -31.5, roe: 9.2, debtEquity: 0.17, opMargin: 5.8, netMargin: 6.0, divYield: 0, holders: GLOBAL_HOLDERS(48.2, 12.9, -0.6, 0), earningsInDays: 77, earningsNote: "Q4 results" },
  MSFT: { sector: "Software & cloud", pe: 35.2, sectorPe: 31.0, pb: 10.8, evEbitda: 23.9, revGrowth: 16.4, epsGrowth: 18.2, roe: 33.4, debtEquity: 0.18, opMargin: 45.6, netMargin: 36.1, divYield: 0.7, holders: GLOBAL_HOLDERS(73.1, 1.4, 0.4, 0), earningsInDays: 85, earningsNote: "Q2 FY27 results" },
  ASML: { sector: "Semiconductor equipment", pe: 31.6, sectorPe: 27.2, pb: 15.9, evEbitda: 24.4, revGrowth: 12.9, epsGrowth: 15.6, roe: 49.8, debtEquity: 0.27, opMargin: 34.9, netMargin: 28.7, divYield: 0.9, holders: GLOBAL_HOLDERS(54.6, 0.1, 0.3, 0), earningsInDays: 64, earningsNote: "Q4 results" },
};

const INDICES: Record<string, Omit<IndexFundamentals, "kind">> = {
  NIFTY: { pe: 22.4, pe5yAvg: 21.8, pb: 3.6, divYield: 1.3, advancers: 34, decliners: 16, constituents: 50, above50dma: 64, above200dma: 72, note: "Breadth confirms the move: two of three constituents are rising." },
  BANKNIFTY: { pe: 15.8, pe5yAvg: 17.1, pb: 2.4, divYield: 0.9, advancers: 6, decliners: 6, constituents: 12, above50dma: 50, above200dma: 67, note: "Split breadth, half the banks up and half down, fits the range." },
  SPY: { pe: 22.1, pe5yAvg: 19.6, pb: 4.9, divYield: 1.2, advancers: 318, decliners: 185, constituents: 503, above50dma: 61, above200dma: 66, note: "Forward P/E (S&P 500). Breadth is improving under the surface, not just mega-caps." },
};

export function fundamentals(inst: Instrument): Fundamentals {
  if (inst.assetClass === "crypto")
    return { kind: "na", reason: "Crypto assets have no earnings, balance sheet or cash flows to value.", instead: "Not applicable. Tudumm will use on-chain flows here: exchange net flows, stablecoin supply and long-term holder behaviour." };
  if (EQUITIES[inst.symbol]) return { kind: "equity", ...EQUITIES[inst.symbol] };
  if (INDICES[inst.symbol]) return { kind: "index", ...INDICES[inst.symbol] };
  switch (inst.symbol) {
    case "EURUSD":
      return { kind: "fx", base: { ccy: "EUR", bank: "ECB", rate: 2.0, cpi: 2.1 }, quote: { ccy: "USD", bank: "Fed", rate: 3.75, cpi: 2.9 }, spread2y: -1.42, spreadTrend: "Narrowed 31 bp in 3 weeks", note: "A shrinking US rate advantage removes the dollar's carry support." };
    case "USDINR":
      return { kind: "fx", base: { ccy: "USD", bank: "Fed", rate: 3.75, cpi: 2.9 }, quote: { ccy: "INR", bank: "RBI", rate: 5.5, cpi: 2.6 }, spread2y: -1.86, spreadTrend: "Stable for 6 weeks", note: "Rate differential is steady; the RBI, not macro, sets the range." };
    case "USDJPY":
      return { kind: "fx", base: { ccy: "USD", bank: "Fed", rate: 3.75, cpi: 2.9 }, quote: { ccy: "JPY", bank: "BoJ", rate: 0.75, cpi: 2.8 }, spread2y: 2.71, spreadTrend: "Narrowed 22 bp as BoJ hike odds rise", note: "Wide carry still favours USD, but the gap is closing from the Japan side." };
    case "XAUUSD":
      return {
        kind: "commodity",
        rows: [
          { label: "Central-bank purchases (Q3)", value: "+218 t", read: "supportive" },
          { label: "Gold ETF holdings, 4 weeks", value: "+18.6 t", read: "supportive" },
          { label: "US 10y real yield", value: "1.58%, falling", read: "supportive" },
          { label: "Mine supply YoY", value: "+1.2%", read: "neutral" },
          { label: "Jewellery demand YoY", value: "−9%", read: "pressure" },
        ],
        balance: "Investment demand outweighs softer jewellery buying",
        note: "Price-insensitive central-bank buying is the floor under this trend.",
      };
    default:
      return {
        kind: "commodity",
        rows: [
          { label: "EIA crude inventories, 3 weeks", value: "+2.1 · +3.4 · +1.8 M bbl", read: "pressure" },
          { label: "OPEC+ output change (Dec)", value: "+137 kb/d", read: "pressure" },
          { label: "US production", value: "13.6 M b/d, record", read: "pressure" },
          { label: "M1–M6 spread", value: "$0.42, flattening", read: "pressure" },
          { label: "Refinery utilisation", value: "89.4%", read: "neutral" },
        ],
        balance: "Supply is outrunning demand into Q1",
        note: "Three straight inventory builds with more OPEC+ barrels: the glut narrative has data behind it.",
      };
  }
}
