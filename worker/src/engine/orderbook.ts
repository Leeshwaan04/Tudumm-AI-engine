// Order-book analytics (pure).

export interface BookImbalance {
  mid: number;
  spread: number;
  spreadBps: number;
  bidQty: number; // base-asset quantity within the band
  askQty: number;
  bidNotional: number;
  askNotional: number;
  ratio: number | null; // bidQty / askQty
  imbalance: number; // (bid - ask) / (bid + ask), -1..1
  bandPct: number;
}

/** Imbalance of resting size within ±bandPct of mid. bids/asks are [price, qty], best first. */
export function bookImbalance(bids: readonly [number, number][], asks: readonly [number, number][], bandPct = 1): BookImbalance | null {
  const bb = bids[0];
  const ba = asks[0];
  if (!bb || !ba || !(bb[0] > 0) || !(ba[0] > 0)) return null;
  const mid = (bb[0] + ba[0]) / 2;
  const lo = mid * (1 - bandPct / 100);
  const hi = mid * (1 + bandPct / 100);
  let bq = 0;
  let aq = 0;
  let bn = 0;
  let an = 0;
  for (const [p, q] of bids) {
    if (p < lo) break;
    bq += q;
    bn += p * q;
  }
  for (const [p, q] of asks) {
    if (p > hi) break;
    aq += q;
    an += p * q;
  }
  const tot = bq + aq;
  return {
    mid,
    spread: ba[0] - bb[0],
    spreadBps: ((ba[0] - bb[0]) / mid) * 10000,
    bidQty: bq,
    askQty: aq,
    bidNotional: bn,
    askNotional: an,
    ratio: aq > 0 ? bq / aq : null,
    imbalance: tot > 0 ? (bq - aq) / tot : 0,
    bandPct,
  };
}
