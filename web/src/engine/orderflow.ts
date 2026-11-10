import { rng } from "./prng";
import type { Instrument } from "./types";
import { isTrade } from "./types";
import type { Candle } from "./candles";

/** Signed direction of the call: +1 LONG, -1 SHORT, 0 sit-out. */
export function dirSign(inst: Instrument): 1 | -1 | 0 {
  const s = inst.signal;
  if (!isTrade(s)) return 0;
  return s.direction === "LONG" ? 1 : -1;
}

/** Layer score in [-1, 1] toward the call (null -> 0). */
export function score(inst: Instrument, layer: keyof Instrument["signal"]["layers"]): number {
  const v = inst.signal.layers[layer];
  return v === null ? 0 : v / 100;
}

const BOOK_TICK: Record<string, number> = {
  NIFTY: 0.05,
  BANKNIFTY: 0.05,
  BTCUSDT: 0.1,
  XAUUSD: 0.1,
  ASML: 0.1,
};
export function bookTick(inst: Instrument): number {
  if (BOOK_TICK[inst.symbol]) return BOOK_TICK[inst.symbol];
  if (inst.market === "IN") return 0.05;
  return 0.01;
}

export function hasOrderBook(inst: Instrument): boolean {
  return inst.assetClass !== "fx";
}

export interface BookLevel {
  price: number;
  size: number;
}
export interface OrderBook {
  bids: BookLevel[];
  asks: BookLevel[];
  bidShare: number;
  spread: number;
  unit: string;
  venue: string;
}

const UNIT: Record<string, string> = {
  index: "lots",
  equity: "shares",
  etf: "shares",
  crypto: "coins",
  commodity: "contracts",
  fx: "contracts",
};
const BASE_SIZE: Record<string, number> = { index: 420, equity: 2600, etf: 1800, crypto: 6, commodity: 38, fx: 40 };

export function bookVenue(inst: Instrument): string {
  if (inst.symbol === "XAUUSD") return "COMEX GC futures (spot gold is OTC)";
  if (inst.assetClass === "index") return `${inst.exchange} index futures`;
  if (inst.assetClass === "crypto") return `${inst.exchange} spot`;
  return inst.exchange;
}

/** 10-level L2 book. `seq` changes the flicker; the overall shape is deterministic. */
export function orderBook(inst: Instrument, price: number, seq: number): OrderBook {
  const shape = rng(`${inst.symbol}:book`);
  const flick = rng(`${inst.symbol}:book:${seq}`);
  const tick = bookTick(inst);
  const sign = dirSign(inst);
  const s = score(inst, "flow");
  const bidShare = sign === 0 ? 0.5 + s * 0.08 : 0.5 + sign * s * 0.22;
  const base = BASE_SIZE[inst.assetClass] ?? 100;
  const bestBid = Math.floor(price / tick) * tick;
  const bestAsk = bestBid + tick;
  const wallBid = 3 + Math.floor(shape.next() * 5);
  const wallAsk = 3 + Math.floor(shape.next() * 5);
  const bids: BookLevel[] = [];
  const asks: BookLevel[] = [];
  const dec = Math.max(inst.decimals, tick < 0.1 ? 2 : 1);
  const round = (v: number) => Number(v.toFixed(dec));
  for (let i = 0; i < 10; i++) {
    const shapeB = 0.55 + shape.next() * 0.9 + i * 0.06;
    const shapeA = 0.55 + shape.next() * 0.9 + i * 0.06;
    let b = base * shapeB * (2 * bidShare) * (0.85 + flick.next() * 0.3);
    let a = base * shapeA * (2 * (1 - bidShare)) * (0.85 + flick.next() * 0.3);
    if (i === wallBid && sign >= 0) b *= 2.2;
    if (i === wallAsk && sign <= 0) a *= 2.2;
    const r = inst.assetClass === "crypto" ? (v: number) => Math.round(v * 100) / 100 : (v: number) => Math.max(1, Math.round(v));
    bids.push({ price: round(bestBid - i * tick), size: r(b) });
    asks.push({ price: round(bestAsk + i * tick), size: r(a) });
  }
  const bt = bids.reduce((x, l) => x + l.size, 0);
  const at = asks.reduce((x, l) => x + l.size, 0);
  return { bids, asks, bidShare: bt / (bt + at), spread: tick, unit: UNIT[inst.assetClass] ?? "units", venue: bookVenue(inst) };
}

export interface VolumeProfile {
  bins: { lo: number; hi: number; vol: number }[];
  poc: number;
  vah: number;
  val: number;
}
export function volumeProfile(candles: Candle[], nBins = 22): VolumeProfile {
  const slice = candles.slice(-120);
  const lo = Math.min(...slice.map((c) => c.low));
  const hi = Math.max(...slice.map((c) => c.high));
  const w = (hi - lo) / nBins || 1;
  const bins = Array.from({ length: nBins }, (_, i) => ({ lo: lo + i * w, hi: lo + (i + 1) * w, vol: 0 }));
  for (const c of slice) {
    const a = Math.max(0, Math.floor((c.low - lo) / w));
    const b = Math.min(nBins - 1, Math.floor((c.high - lo) / w));
    const share = c.volume / (b - a + 1);
    for (let i = a; i <= b; i++) bins[i].vol += share;
  }
  let pocI = 0;
  bins.forEach((b, i) => {
    if (b.vol > bins[pocI].vol) pocI = i;
  });
  const total = bins.reduce((x, b) => x + b.vol, 0);
  let inVA = bins[pocI].vol;
  let l = pocI;
  let h = pocI;
  while (inVA < total * 0.7 && (l > 0 || h < nBins - 1)) {
    const down = l > 0 ? bins[l - 1].vol : -1;
    const up = h < nBins - 1 ? bins[h + 1].vol : -1;
    if (up >= down) inVA += bins[++h].vol;
    else inVA += bins[--l].vol;
  }
  return { bins, poc: (bins[pocI].lo + bins[pocI].hi) / 2, vah: bins[h].hi, val: bins[l].lo };
}

export interface Print {
  minsAgo: number;
  side: "buy" | "sell";
  size: number;
  price: number;
  note: string;
}
export function largePrints(inst: Instrument, price: number): Print[] {
  const r = rng(`${inst.symbol}:prints`);
  const sign = dirSign(inst);
  const s = score(inst, "flow");
  const base = (BASE_SIZE[inst.assetClass] ?? 100) * 14;
  const notes =
    inst.market === "US"
      ? ["Dark-pool block", "Lit sweep", "Block cross", "Lit sweep", "Dark-pool block"]
      : inst.assetClass === "crypto"
        ? ["Spot whale", "Taker sweep", "Spot whale", "OTC desk print", "Taker sweep"]
        : inst.market === "IN"
          ? ["Block deal window", "Bulk print", "Futures sweep", "Bulk print", "Futures sweep"]
          : ["Block", "Sweep", "Block", "Sweep", "Block"];
  const out: Print[] = [];
  let mins = 2 + r.int(0, 4);
  for (let i = 0; i < 5; i++) {
    const favour = r.next() < 0.5 + Math.abs(s) * 0.4;
    const side: "buy" | "sell" =
      sign === 0 ? (r.next() < 0.5 ? "buy" : "sell") : (favour ? sign > 0 : sign < 0) ? "buy" : "sell";
    const sz = base * (0.6 + r.next() * 1.8);
    out.push({
      minsAgo: mins,
      side,
      size: inst.assetClass === "crypto" ? Math.round(sz * 10) / 10 : Math.round(sz / 10) * 10,
      price: price * (1 + (r.next() - 0.5) * 0.002),
      note: notes[i],
    });
    mins += 3 + r.int(0, 9);
  }
  return out;
}

/** For OTC spot FX: CME/NSE futures volume & positioning used instead of an order book. */
export interface FuturesProxy {
  contract: string;
  venue: string;
  volume: number;
  volumeVsAvg: number;
  oi: number;
  oiChg: number;
  note: string;
}
export function fxFuturesProxy(inst: Instrument): FuturesProxy {
  const r = rng(`${inst.symbol}:fxproxy`);
  const s = score(inst, "derivatives");
  if (inst.symbol === "EURUSD")
    return { contract: "6E · Euro FX futures", venue: "CME Group", volume: 214_800, volumeVsAvg: 1.18, oi: 712_400, oiChg: 18_400, note: "Volume running 18% above its 20-day average as positioning shifts net long." };
  if (inst.symbol === "USDJPY")
    return { contract: "6J · Japanese yen futures (inverse quote)", venue: "CME Group", volume: 168_200, volumeVsAvg: 1.32, oi: 248_900, oiChg: 9_600, note: "Rising yen-futures OI with price means new yen longs, i.e. new USDJPY shorts." };
  return {
    contract: "USDINR futures (near month)",
    venue: "NSE currency derivatives",
    volume: Math.round(2_100_000 * (0.9 + r.next() * 0.2)),
    volumeVsAvg: 0.86 + s * 0.1,
    oi: 2_860_000,
    oiChg: -42_000,
    note: "Volume below average and OI drifting lower: a managed range keeps speculators away.",
  };
}
