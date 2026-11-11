// Small numeric helpers (pure).

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Round to `d` decimals, returning a JSON-friendly number (integers stay integers; -0 => 0). */
export function roundTo(v: number, d: number): number {
  if (!Number.isFinite(v)) return v;
  const f = 10 ** d;
  const r = Math.round(v * f) / f;
  return r === 0 ? 0 : Number(r.toFixed(d));
}

export function last<T>(xs: readonly T[]): T | undefined {
  return xs[xs.length - 1];
}

export function lastNonNull<T>(xs: readonly (T | null)[]): T | null {
  for (let i = xs.length - 1; i >= 0; i--) {
    const v = xs[i];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

export function mean(xs: readonly number[]): number {
  if (!xs.length) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? (a[m] as number) : ((a[m - 1] as number) + (a[m] as number)) / 2;
}

/** Percentile rank (0..100) of `v` within `xs`. */
export function percentileRank(xs: readonly number[], v: number): number | null {
  if (xs.length < 2) return null;
  let below = 0;
  let equal = 0;
  for (const x of xs) {
    if (x < v) below++;
    else if (x === v) equal++;
  }
  return Math.round(((below + 0.5 * equal) / xs.length) * 100);
}

/** "25,044.65" style formatting with the instrument's decimals (en-US grouping; stable across runtimes). */
export function fmt(v: number, d: number): string {
  const neg = v < 0;
  const fixed = Math.abs(v).toFixed(d);
  const [int, frac] = fixed.split(".");
  const grouped = (int ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + grouped + (frac ? "." + frac : "");
}

export function pct(v: number, d = 1): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`;
}

export function isoFromSec(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

export function secFromIso(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

/** Decimals to show for a price level (instrument decimals, but never fewer than needed for tiny prices). */
export function levelDecimals(price: number, decimals: number): number {
  if (price > 0 && price < 1) return Math.max(decimals, 4);
  return decimals;
}
