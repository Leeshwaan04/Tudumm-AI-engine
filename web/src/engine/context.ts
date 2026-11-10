import { rng } from "./prng";
import type { Instrument, MarketId } from "./types";
import { getInstrument } from "./seed";

/** All headlines are SIMULATED and labelled as such in the UI. */
export type Sentiment = "bullish" | "bearish" | "neutral";
export interface Headline {
  minsAgo: number;
  text: string;
  sentiment: Sentiment;
  source: string;
}

const H: Record<string, [string, Sentiment][]> = {
  NIFTY: [
    ["Index put writers add heavily at 25,800 as weekly expiry nears", "bullish"],
    ["FIIs turn net buyers in cash market for a third straight session", "bullish"],
  ],
  BANKNIFTY: [
    ["Bank index stuck in a 800-point range ahead of RBI policy", "neutral"],
    ["Implied volatility slides as traders sell straddles before the policy", "neutral"],
  ],
  RELIANCE: [
    ["Reliance futures see long build-up; delivery volumes at 20-day high", "bullish"],
    ["Retail and telecom units guide to steady margin expansion", "bullish"],
  ],
  HDFCBANK: [
    ["HDFC Bank deposit growth outpaces loans for a second quarter", "bullish"],
    ["Stock pulls back to its 50-day average on profit-taking", "neutral"],
  ],
  TCS: [
    ["TCS management cautious on near-term deal conversions", "bearish"],
    ["US clients delay discretionary tech spending, channel checks say", "bearish"],
  ],
  INFY: [
    ["Infosys reports Q2 in two days; options price a 5% move", "neutral"],
    ["Analysts split on guidance revision ahead of results", "neutral"],
  ],
  ICICIBANK: [
    ["ICICI Bank prints a fresh high on rising delivery volumes", "bullish"],
    ["Brokerages lift targets after asset-quality beat", "bullish"],
  ],
  SBIN: [
    ["PSU bank index leads the open; SBI bids stack at range highs", "bullish"],
    ["Government stake-sale chatter resurfaces, no confirmation", "neutral"],
  ],
  SPY: [
    ["Dealers sit long gamma above 680, damping index swings", "bullish"],
    ["Equal-weight S&P outperforms for a fourth week as breadth widens", "bullish"],
  ],
  NVDA: [
    ["NVIDIA data-center revenue beats; guide raised above consensus", "bullish"],
    ["Block trades absorbed on every dip this week, tape shows", "bullish"],
  ],
  AAPL: [
    ["Apple drifts in a tight range as volatility hits a 3-month low", "neutral"],
    ["Mixed early reads on holiday-quarter handset demand", "neutral"],
  ],
  TSLA: [
    ["Tesla rejected at 440 as put volume spikes", "bearish"],
    ["Dark-pool prints skew to the sell side for a second day", "bearish"],
  ],
  MSFT: [
    ["Azure growth re-accelerates; operating margin holds above 45%", "bullish"],
    ["Microsoft expands buyback authorisation", "bullish"],
  ],
  ASML: [
    ["ASML order backlog steady; China share normalises", "bullish"],
    ["Chip-equipment peers retest breakout levels on light volume", "neutral"],
  ],
  BTCUSDT: [
    ["Spot bitcoin ETFs log a third straight day of inflows", "bullish"],
    ["Perp funding resets to neutral after a weekend leverage flush", "bullish"],
  ],
  ETHUSDT: [
    ["Ether open interest jumps 6% into resistance; funding runs hot", "bearish"],
    ["Late longs crowd above 3,850, liquidation maps show", "bearish"],
  ],
  SOLUSDT: [
    ["Solana outperforms bitcoin for a ninth session", "bullish"],
    ["SOL breaks a three-week range on rising spot volume", "bullish"],
  ],
  EURUSD: [
    ["US–euro area 2-year spread narrows for a third week", "bullish"],
    ["CME euro futures: speculators extend net long", "bullish"],
  ],
  USDINR: [
    ["RBI seen selling dollars near 88.80 to cap the rupee's slide", "neutral"],
    ["Rupee volatility falls to a multi-month low", "neutral"],
  ],
  USDJPY: [
    ["Japan's finance ministry repeats warning on 'rapid' yen moves", "bearish"],
    ["Swaps lift odds of a December BoJ hike", "bearish"],
  ],
  XAUUSD: [
    ["Central banks added gold for a sixth straight month", "bullish"],
    ["Real yields ease after soft US data; bullion extends gains", "bullish"],
  ],
  CL: [
    ["EIA: US crude stocks build for a third straight week", "bearish"],
    ["OPEC+ confirms output additions from December", "bearish"],
  ],
};

const MARKET_WIRE: Record<MarketId, [string, Sentiment]> = {
  IN: ["Indian equities steady; India VIX near 12", "neutral"],
  US: ["US futures flat ahead of CPI; Treasury yields edge lower", "neutral"],
  EU: ["European bourses mixed as ECB speakers stay cautious", "neutral"],
  CRYPTO: ["Total crypto market cap holds above $3.6T", "neutral"],
  FX: ["Dollar index slips for a second day", "neutral"],
  CMDTY: ["Commodity index mixed: metals firm, energy soft", "neutral"],
};

export function headlines(inst: Instrument): Headline[] {
  const r = rng(`${inst.symbol}:news`);
  const own = H[inst.symbol] ?? [];
  const items: Headline[] = own.map(([text, sentiment], i) => ({
    minsAgo: 6 + i * (18 + r.int(0, 40)),
    text,
    sentiment,
    source: "Simulated wire",
  }));
  const [t, s] = MARKET_WIRE[inst.market];
  items.push({ minsAgo: 95 + r.int(0, 60), text: t, sentiment: s, source: "Simulated wire" });
  return items;
}

export interface MacroEvent {
  inDays: number;
  time: string;
  name: string;
  impact: "High" | "Medium";
}
const CAL: Record<MarketId, MacroEvent[]> = {
  IN: [
    { inDays: 1, time: "15:30 IST", name: "Weekly index options expiry", impact: "Medium" },
    { inDays: 2, time: "10:00 IST", name: "RBI monetary policy decision", impact: "High" },
    { inDays: 2, time: "17:30 IST", name: "India CPI inflation (Oct)", impact: "High" },
  ],
  US: [
    { inDays: 1, time: "08:30 ET", name: "US CPI (Oct)", impact: "High" },
    { inDays: 3, time: "08:30 ET", name: "Retail sales", impact: "Medium" },
    { inDays: 8, time: "14:00 ET", name: "FOMC minutes", impact: "High" },
  ],
  EU: [
    { inDays: 1, time: "11:00 CET", name: "Euro area ZEW sentiment", impact: "Medium" },
    { inDays: 4, time: "10:00 CET", name: "Euro area flash PMIs", impact: "Medium" },
    { inDays: 9, time: "14:15 CET", name: "ECB rate decision", impact: "High" },
  ],
  CRYPTO: [
    { inDays: 0, time: "Daily", name: "Spot ETF flow print", impact: "Medium" },
    { inDays: 1, time: "08:30 ET", name: "US CPI (risk-asset driver)", impact: "High" },
    { inDays: 17, time: "08:00 UTC", name: "Monthly options expiry", impact: "High" },
  ],
  FX: [
    { inDays: 1, time: "08:30 ET", name: "US CPI (Oct)", impact: "High" },
    { inDays: 2, time: "10:00 IST", name: "RBI policy (INR)", impact: "High" },
    { inDays: 9, time: "14:15 CET", name: "ECB rate decision (EUR)", impact: "High" },
  ],
  CMDTY: [
    { inDays: 1, time: "10:30 ET", name: "EIA crude inventories", impact: "High" },
    { inDays: 1, time: "08:30 ET", name: "US CPI (gold driver)", impact: "High" },
    { inDays: 20, time: "—", name: "OPEC+ ministerial meeting", impact: "High" },
  ],
};
export function calendar(inst: Instrument): MacroEvent[] {
  const base = [...CAL[inst.market]];
  if (inst.symbol === "USDJPY") base.splice(1, 1, { inDays: 5, time: "Tokyo", name: "BoJ policy meeting", impact: "High" });
  if (inst.symbol === "INFY") base.unshift({ inDays: 2, time: "After close", name: "Infosys Q2 results", impact: "High" });
  return base;
}

/** Cross-asset correlation chips (60-day, simulated). */
const PEERS: Record<string, [string, number][]> = {
  IN: [["NIFTY", 0.72], ["BANKNIFTY", 0.64], ["USDINR", -0.38], ["SPY", 0.27]],
  US: [["SPY", 0.78], ["NVDA", 0.52], ["EURUSD", 0.12], ["XAUUSD", -0.08]],
  EU: [["SPY", 0.61], ["NVDA", 0.58], ["EURUSD", 0.21], ["NIFTY", 0.18]],
  CRYPTO: [["BTCUSDT", 0.84], ["NVDA", 0.41], ["SPY", 0.36], ["XAUUSD", 0.09]],
  FX: [["EURUSD", -0.55], ["XAUUSD", -0.42], ["SPY", -0.18], ["USDJPY", 0.48]],
  CMDTY: [["XAUUSD", 0.2], ["EURUSD", 0.31], ["SPY", 0.24], ["USDINR", 0.19]],
};
export function correlations(inst: Instrument): { symbol: string; corr: number }[] {
  const r = rng(`${inst.symbol}:corr`);
  const out: { symbol: string; corr: number }[] = [];
  for (const [sym, base] of PEERS[inst.market]) {
    if (sym === inst.symbol || !getInstrument(sym)) continue;
    let c = base + (r.next() - 0.5) * 0.12;
    if (inst.symbol === "XAUUSD" && sym === "EURUSD") c = 0.46;
    if (inst.symbol === "CL" && sym === "XAUUSD") c = 0.14;
    if (inst.symbol === "USDJPY" && sym === "EURUSD") c = -0.51;
    out.push({ symbol: sym, corr: Math.max(-0.95, Math.min(0.95, c)) });
  }
  if (out.length < 4) {
    const extra = inst.market === "IN" ? "XAUUSD" : inst.market === "CRYPTO" ? "ETHUSDT" : "NIFTY";
    if (extra !== inst.symbol) out.push({ symbol: extra, corr: Math.round((r.next() - 0.3) * 50) / 100 });
  }
  return out.slice(0, 4);
}
