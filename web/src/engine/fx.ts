import type { Currency } from "./types";
import type { Tick } from "./live";
import { getInstrument } from "./universe";

/**
 * Cross rates from the live FX instruments (ECB daily reference rates; USDT treated as USD).
 * NaN when the pair isn't in the live universe: callers must say so instead of guessing.
 */
function px(ticks: Record<string, Tick> | undefined, symbol: string): number {
  const p = ticks?.[symbol]?.price || getInstrument(symbol)?.price;
  return p && p > 0 ? p : NaN;
}

export function usdPer(cur: Currency, ticks?: Record<string, Tick>): number {
  switch (cur) {
    case "USD":
    case "USDT":
      return 1;
    case "EUR":
      return px(ticks, "EURUSD");
    case "INR":
      return 1 / px(ticks, "USDINR");
    case "JPY":
      return 1 / px(ticks, "USDJPY");
  }
}

export function convert(amount: number, from: Currency, to: Currency, ticks?: Record<string, Tick>): number {
  if (from === to) return amount;
  return (amount * usdPer(from, ticks)) / usdPer(to, ticks);
}

/** Human description of the rate used, e.g. "at the latest reference rate USDINR 88.62". */
export function rateNote(from: Currency, to: Currency, ticks?: Record<string, Tick>): string | null {
  if (from === to) return null;
  const f = from === "USDT" ? "USD" : from;
  const t = to === "USDT" ? "USD" : to;
  if (f === t) return "USDT treated as USD 1:1";
  const pair = (sym: string) => `${sym} ${px(ticks, sym).toFixed(sym === "EURUSD" ? 4 : 2)}`;
  const used = new Set<string>();
  for (const c of [f, t]) {
    if (c === "INR") used.add(pair("USDINR"));
    if (c === "EUR") used.add(pair("EURUSD"));
    if (c === "JPY") used.add(pair("USDJPY"));
  }
  return `at the latest reference rate ${[...used].join(" · ")}`;
}
