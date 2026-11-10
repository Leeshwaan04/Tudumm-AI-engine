import type { Instrument, LayerId } from "./types";
import { isTrade } from "./types";
import type { PriceIndicators } from "./indicators";
import type { OrderBook, Print, VolumeProfile, FuturesProxy } from "./orderflow";
import { dirSign } from "./orderflow";
import type { OptionChain, CryptoDerivs, Positioning, BuildUp } from "./derivatives";
import type { Fundamentals } from "./fundamentals";
import type { Headline, MacroEvent } from "./context";
import { fmtLevel, fmtCompact, MINUS } from "./format";

export function layerTone(v: number | null): { label: string; cls: string } {
  if (v === null) return { label: "Not applicable", cls: "na" };
  if (v >= 50) return { label: "Strongly agrees", cls: "agree" };
  if (v >= 15) return { label: "Agrees", cls: "agree" };
  if (v > -15) return { label: "Neutral", cls: "neutral" };
  return { label: "Disagrees", cls: "disagree" };
}

const sgn = (v: number, d = 1) => `${v >= 0 ? "+" : MINUS}${Math.abs(v).toFixed(d)}`;
function callWord(inst: Instrument): string {
  const s = inst.signal;
  return isTrade(s) ? (s.direction === "LONG" ? "the long" : "the short") : "either side";
}

export function priceBullets(inst: Instrument, ind: PriceIndicators, tf: string): string[] {
  const out: string[] = [];
  const d = dirSign(inst);
  const bull = ind.ema20 > ind.ema50 && ind.ema50 > ind.ema200;
  const bear = ind.ema20 < ind.ema50 && ind.ema50 < ind.ema200;
  if (bull) out.push(`Bullish EMA stack on the ${tf} chart (20 > 50 > 200)${d > 0 ? ": trend supports the long" : d < 0 ? ": the short is counter-trend on this frame" : ""}.`);
  else if (bear) out.push(`Bearish EMA stack on the ${tf} chart (20 < 50 < 200)${d < 0 ? ": trend supports the short" : d > 0 ? ": the long is counter-trend on this frame" : ""}.`);
  else out.push(`EMAs are tangled on the ${tf} chart: no clean trend stack, so structure carries more weight.`);
  const r = ind.rsi;
  const rsiRead = r >= 70 ? "overbought; expect chop before continuation" : r >= 55 ? "strong momentum without being stretched" : r > 45 ? "neutral momentum" : r > 30 ? "weak momentum" : "oversold; bounces are likely";
  out.push(`RSI 14 at ${r.toFixed(0)}: ${rsiRead}.`);
  out.push(
    `Supertrend is ${ind.supertrend.dir > 0 ? "bullish" : "bearish"} (flipped ${ind.supertrend.flippedBarsAgo} bars ago) with ATR 14 at ${fmtLevel(inst, Number(ind.atr.toFixed(inst.decimals)))}.`,
  );
  const above = ind.price >= ind.vwap;
  const lvl = above ? ind.levels.supports[0] : ind.levels.resistances[0];
  out.push(
    `Price is ${above ? "above" : "below"} VWAP (${fmtLevel(inst, Number(ind.vwap.toFixed(inst.decimals)))})${lvl !== undefined ? `; nearest ${above ? "support" : "resistance"} ${fmtLevel(inst, Number(lvl.toFixed(inst.decimals)))}` : ""}.`,
  );
  return out;
}

export function flowBullets(inst: Instrument, book: OrderBook | null, vp: VolumeProfile, prints: Print[], fx: FuturesProxy | null, price: number): string[] {
  if (fx) {
    return [
      "Spot FX trades over the counter: there is no consolidated order book or tape to read.",
      `Tudumm uses ${fx.contract} (${fx.venue}) instead: volume is ${fx.volumeVsAvg.toFixed(2)}× its 20-day average.`,
      `Futures open interest ${fx.oiChg >= 0 ? "rose" : "fell"} ${fmtCompact(Math.abs(fx.oiChg))} contracts today. ${fx.note}`,
    ];
  }
  const out: string[] = [];
  if (book) {
    const pct = book.bidShare * 100;
    out.push(`Resting depth is ${pct.toFixed(0)}% bids / ${(100 - pct).toFixed(0)}% asks across 10 levels: ${pct > 55 ? "buyers are stacking" : pct < 45 ? "sellers are stacking" : "balanced"}.`);
  }
  out.push(
    `Price ${price >= vp.poc ? "holds above" : "trades below"} the volume POC at ${fmtLevel(inst, Number(vp.poc.toFixed(inst.decimals)))}; value area ${fmtLevel(inst, Number(vp.val.toFixed(inst.decimals)))}–${fmtLevel(inst, Number(vp.vah.toFixed(inst.decimals)))}.`,
  );
  const buys = prints.filter((p) => p.side === "buy").length;
  out.push(`${buys} of the last ${prints.length} large prints were buyer-initiated${dirSign(inst) !== 0 ? `, ${(buys >= 3) === dirSign(inst) > 0 ? "in favour of" : "leaning against"} ${callWord(inst)}` : ""}.`);
  return out;
}

export function chainBullets(inst: Instrument, ch: OptionChain, bu: BuildUp, oiChg: number, spot: number): string[] {
  const pcrRead = ch.pcr > 1.15 ? "put-heavy: writers are defending the downside" : ch.pcr < 0.8 ? "call-heavy: writers are capping the upside" : "balanced";
  const dist = ((ch.maxPain - spot) / spot) * 100;
  return [
    `PCR ${ch.pcr.toFixed(2)}: ${pcrRead}.`,
    `Largest put OI at ${fmtLevel(inst, ch.putWall)} and largest call OI at ${fmtLevel(inst, ch.callWall)}: the market's implied floor and ceiling.`,
    `Max pain ${fmtLevel(inst, ch.maxPain)} (${sgn(dist, 2)}% from spot) for the ${ch.expiryLabel} expiry; IV rank ${ch.ivRank}.`,
    `Futures: ${bu.toLowerCase()} (${sgn(oiChg)}% OI today).`,
  ];
}

export function cryptoBullets(c: CryptoDerivs, inst: Instrument): string[] {
  const above = c.liqClusters.filter((l) => l.side === "shorts").reduce((a, l) => a + l.usd, 0);
  const below = c.liqClusters.filter((l) => l.side === "longs").reduce((a, l) => a + l.usd, 0);
  return [
    `Perp funding ${sgn(c.funding, 4)}% per 8h: ${c.fundingNote.toLowerCase()}.`,
    `Perp open interest $${fmtCompact(c.perpOI)} (${sgn(c.oiChg24h)}% in 24h); long/short ratio ${c.longShort.toFixed(2)}.`,
    `Liquidation clusters: $${fmtCompact(above)} of shorts above vs $${fmtCompact(below)} of longs below${dirSign(inst) > 0 ? ": squeeze fuel sits overhead" : dirSign(inst) < 0 ? ": the flush risk is below" : ""}.`,
  ];
}

export function positioningBullets(p: Positioning): string[] {
  const lead = p.groups[0];
  return [
    `${p.contract}: open interest ${fmtCompact(p.oi)} (${sgn(p.oiChgPct)}% w/w).`,
    `${lead.name} net ${lead.net >= 0 ? "long" : "short"} ${fmtCompact(Math.abs(lead.net))}, ${lead.wow >= 0 ? "adding" : "cutting"} ${fmtCompact(Math.abs(lead.wow))} this week.`,
    p.note,
  ];
}

export function fundBullets(f: Fundamentals, inst: Instrument): string[] {
  switch (f.kind) {
    case "na":
      return [f.reason, f.instead];
    case "equity": {
      const prem = ((f.pe - f.sectorPe) / f.sectorPe) * 100;
      const out = [
        `P/E ${f.pe.toFixed(1)} vs sector ${f.sectorPe.toFixed(1)} (${prem >= 0 ? "premium" : "discount"} ${Math.abs(prem).toFixed(0)}%).`,
        `Revenue ${sgn(f.revGrowth)}% and EPS ${sgn(f.epsGrowth)}% YoY; ROE ${f.roe.toFixed(1)}%.`,
      ];
      const h = f.holders[inst.market === "IN" ? 1 : 0];
      out.push(`${h.label} hold ${h.pct.toFixed(1)}% (${sgn(h.chg)} pp last quarter).`);
      out.push(f.earningsInDays <= 5 ? `Earnings in ${f.earningsInDays} days: a binary event.` : `Next earnings in ${f.earningsInDays} days; no event risk inside this trade's horizon.`);
      return out;
    }
    case "index":
      return [
        `Index P/E ${f.pe.toFixed(1)} vs a 5-year average of ${f.pe5yAvg.toFixed(1)}.`,
        `Breadth: ${f.advancers} advancing / ${f.decliners} declining of ${f.constituents}.`,
        `${f.above50dma}% of members above their 50-day average, ${f.above200dma}% above the 200-day.`,
        f.note,
      ];
    case "fx":
      return [
        `${f.base.bank} ${f.base.rate.toFixed(2)}% vs ${f.quote.bank} ${f.quote.rate.toFixed(2)}%: rate differential ${sgn(f.base.rate - f.quote.rate, 2)} pp.`,
        `2-year yield spread ${sgn(f.spread2y, 2)} pp; ${f.spreadTrend.toLowerCase()}.`,
        `Inflation: ${f.base.ccy} ${f.base.cpi.toFixed(1)}% vs ${f.quote.ccy} ${f.quote.cpi.toFixed(1)}%.`,
        f.note,
      ];
    case "commodity":
      return [f.balance + ".", ...f.rows.slice(0, 2).map((r) => `${r.label}: ${r.value}.`), f.note];
  }
}

export function contextBullets(_inst: Instrument, news: Headline[], cal: MacroEvent[], corr: { symbol: string; corr: number }[]): string[] {
  const bull = news.filter((n) => n.sentiment === "bullish").length;
  const bear = news.filter((n) => n.sentiment === "bearish").length;
  const next = cal.find((e) => e.impact === "High");
  const top = [...corr].sort((a, b) => Math.abs(b.corr) - Math.abs(a.corr))[0];
  return [
    `Simulated news flow: ${bull} bullish, ${bear} bearish, ${news.length - bull - bear} neutral in the last few hours.`,
    next ? `Next high-impact event: ${next.name} ${next.inDays === 0 ? "today" : `in ${next.inDays} day${next.inDays > 1 ? "s" : ""}`}.` : "No high-impact events inside the trade's horizon.",
    top ? `Strongest cross-asset link: ${top.symbol} (${top.corr >= 0 ? "+" : MINUS}${Math.abs(top.corr).toFixed(2)}, 60-day).` : "",
  ].filter(Boolean);
}

export const LAYER_QUESTION: Record<LayerId, string> = {
  price: "What is the chart saying?",
  flow: "Who is actually buying and selling?",
  derivatives: "How are options and futures traders positioned?",
  fundamentals: "Is the underlying worth more or less?",
  context: "What could move it from outside?",
};
