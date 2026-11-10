import type { Currency, Instrument } from "./types";

const cache = new Map<string, Intl.NumberFormat>();
function nf(locale: string, min: number, max: number): Intl.NumberFormat {
  const key = `${locale}|${min}|${max}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, { minimumFractionDigits: min, maximumFractionDigits: max });
    cache.set(key, f);
  }
  return f;
}

export const MINUS = "−";

export function localeFor(currency: Currency): string {
  return currency === "INR" ? "en-IN" : "en-US";
}

/** Plain grouped number in the currency's locale, signed with a true minus. */
export function fmtNum(v: number, decimals: number, currency: Currency = "USD"): string {
  const s = nf(localeFor(currency), decimals, decimals).format(Math.abs(v));
  return v < 0 ? MINUS + s : s;
}

export const CURRENCY_PREFIX: Record<Currency, string> = {
  INR: "₹",
  USD: "$",
  EUR: "€",
  JPY: "¥",
  USDT: "",
};

export function withCurrency(body: string, currency: Currency, negative = false): string {
  const sign = negative ? MINUS : "";
  if (currency === "USDT") return `${sign}${body} USDT`;
  return `${sign}${CURRENCY_PREFIX[currency]}${body}`;
}

/** Money amount (position sizer, risk) in a currency. */
export function fmtMoney(v: number, currency: Currency, decimals?: number): string {
  const d = decimals ?? (Math.abs(v) >= 1000 || v === 0 || currency === "JPY" ? 0 : 2);
  const body = nf(localeFor(currency), d, d).format(Math.abs(v));
  return withCurrency(body, currency, v < 0);
}

/** Indices and FX rates are quoted without a currency symbol. */
export function quotesWithCurrency(inst: Instrument): boolean {
  return inst.assetClass !== "index" && inst.assetClass !== "fx";
}

/** Live price with full instrument precision (and currency where meaningful). */
export function fmtPrice(inst: Instrument, v: number, opts: { currency?: boolean } = {}): string {
  const body = nf(localeFor(inst.currency), inst.decimals, inst.decimals).format(Math.abs(v));
  const useCur = opts.currency ?? quotesWithCurrency(inst);
  if (!useCur) return v < 0 ? MINUS + body : body;
  return withCurrency(body, inst.currency, v < 0);
}

/** Trade levels: integral values drop trailing zeros for decimals <= 2 (25,900 / 674.50). */
export function fmtLevel(inst: Instrument, v: number): string {
  const integral = Math.abs(v - Math.round(v)) < 1e-9;
  const d = integral && inst.decimals <= 2 ? 0 : inst.decimals;
  return nf(localeFor(inst.currency), d, d).format(v);
}

export function fmtSignedPct(v: number, dp = 2): string {
  const s = Math.abs(v).toFixed(dp);
  if (Number(s) === 0) return `${(0).toFixed(dp)}%`;
  return `${v > 0 ? "+" : MINUS}${s}%`;
}

export function fmtPct(v: number, dp = 1): string {
  return `${v < 0 ? MINUS : ""}${Math.abs(v).toFixed(dp)}%`;
}

export function fmtR(v: number, dp = 2): string {
  const s = Math.abs(v).toFixed(dp);
  if (Number(s) === 0) return `${(0).toFixed(dp)}R`;
  return `${v > 0 ? "+" : MINUS}${s}R`;
}

export function fmtSigned(v: number, dp = 2): string {
  const s = Math.abs(v).toFixed(dp);
  if (Number(s) === 0) return (0).toFixed(dp);
  return `${v > 0 ? "+" : MINUS}${s}`;
}

export function fmtAgo(minutes: number): string {
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  const h = Math.floor(minutes / 60);
  if (h < 24) {
    const m = Math.floor(minutes % 60);
    return m && h < 6 ? `${h}h ${m}m ago` : `${h}h ago`;
  }
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function fmtCountdown(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function shortHash(h: string, n = 6): string {
  return h.slice(0, n);
}

/** Compact magnitude: 1.2K, 3.4M, 1.1B. */
export function fmtCompact(v: number, dp = 1): string {
  const a = Math.abs(v);
  const sign = v < 0 ? MINUS : "";
  if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(dp)}B`;
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(dp)}M`;
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(dp)}K`;
  return `${sign}${a.toFixed(0)}`;
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit", timeZone: "UTC" });
}
