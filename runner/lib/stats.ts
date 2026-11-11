// Small, dependency-free statistics helpers for the backtest (pure).

export function mean(xs: readonly number[]): number {
  if (!xs.length) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (n - 1). */
export function sd(xs: readonly number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (xs.length - 1));
}

/** Seeded PRNG so bootstrap intervals are reproducible run to run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Linear-interpolated quantile of a SORTED array. */
export function quantileSorted(a: ArrayLike<number>, p: number): number {
  if (!a.length) return NaN;
  const h = (a.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return (a[lo] as number) + ((a[hi] as number) - (a[lo] as number)) * (h - lo);
}

function lnGamma(z: number): number {
  // Lanczos approximation (g = 7, n = 9)
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  let x = c[0] as number;
  for (let i = 1; i < 9; i++) x += (c[i] as number) / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Continued fraction for the incomplete beta (Numerical Recipes betacf). */
function betacf(a: number, b: number, x: number): number {
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-14) break;
  }
  return h;
}

/** Regularised incomplete beta I_x(a, b). */
export function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Student-t CDF P(T <= t) with nu degrees of freedom. */
export function tCdf(t: number, nu: number): number {
  const tail = 0.5 * betai(nu / 2, 0.5, nu / (nu + t * t));
  return t >= 0 ? 1 - tail : tail;
}

export function tQuantile(p: number, nu: number): number {
  let lo = -1e4;
  let hi = 1e4;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, nu) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface TTest {
  n: number;
  mean: number;
  sd: number;
  se: number;
  t: number;
  /** two-sided p-value for H0: mean = 0 */
  p: number;
  lo: number;
  hi: number;
}

/** One-sample t-test of the mean against 0 with a (1 - alpha) CI. */
export function tTest(xs: readonly number[], alpha = 0.05): TTest {
  const n = xs.length;
  const m = mean(xs);
  const s = sd(xs);
  if (n < 2 || !(s > 0)) return { n, mean: m, sd: s, se: NaN, t: NaN, p: NaN, lo: NaN, hi: NaN };
  const se = s / Math.sqrt(n);
  const t = m / se;
  const q = tQuantile(1 - alpha / 2, n - 1);
  return { n, mean: m, sd: s, se, t, p: 2 * (1 - tCdf(Math.abs(t), n - 1)), lo: m - q * se, hi: m + q * se };
}

export interface BootCI {
  lo: number;
  hi: number;
  /** share of resampled means <= 0 (a one-sided bootstrap p-value for "mean > 0") */
  pLeq0: number;
}

/** Percentile bootstrap CI for the mean (iid resampling of trades). */
export function bootstrapMean(xs: readonly number[], iters: number, rng: () => number, alpha = 0.05): BootCI {
  const n = xs.length;
  if (n < 2) return { lo: NaN, hi: NaN, pLeq0: NaN };
  const ms = new Float64Array(iters);
  let leq = 0;
  for (let k = 0; k < iters; k++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += xs[Math.floor(rng() * n)] as number;
    const m = s / n;
    ms[k] = m;
    if (m <= 0) leq++;
  }
  ms.sort();
  return { lo: quantileSorted(ms, alpha / 2), hi: quantileSorted(ms, 1 - alpha / 2), pLeq0: leq / iters };
}

/**
 * Cluster bootstrap for the pooled mean: resample whole clusters (e.g. issue months) with replacement.
 * Trades in one month share the same market regime, so iid resampling understates the uncertainty.
 */
export function clusterBootstrapMean(groups: readonly (readonly number[])[], iters: number, rng: () => number, alpha = 0.05): BootCI {
  const g = groups.filter((x) => x.length);
  if (g.length < 2) return { lo: NaN, hi: NaN, pLeq0: NaN };
  const ms: number[] = [];
  let leq = 0;
  for (let k = 0; k < iters; k++) {
    let s = 0;
    let n = 0;
    for (let i = 0; i < g.length; i++) {
      const grp = g[Math.floor(rng() * g.length)] as readonly number[];
      for (const x of grp) s += x;
      n += grp.length;
    }
    const m = s / n;
    ms.push(m);
    if (m <= 0) leq++;
  }
  ms.sort((a, b) => a - b);
  return { lo: quantileSorted(ms, alpha / 2), hi: quantileSorted(ms, 1 - alpha / 2), pLeq0: leq / iters };
}

function ranks(xs: readonly number[]): number[] {
  const idx = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && (idx[j + 1] as readonly [number, number])[0] === (idx[i] as readonly [number, number])[0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[(idx[k] as readonly [number, number])[1]] = avg;
    i = j + 1;
  }
  return r;
}

export function pearson(x: readonly number[], y: readonly number[]): number {
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < x.length; i++) {
    const a = (x[i] as number) - mx;
    const b = (y[i] as number) - my;
    sxy += a * b;
    sxx += a * a;
    syy += b * b;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}

/** Spearman rank correlation with a t-approximation two-sided p-value. */
export function spearman(x: readonly number[], y: readonly number[]): { rho: number; p: number; n: number } {
  const n = x.length;
  if (n < 4) return { rho: NaN, p: NaN, n };
  const rho = pearson(ranks(x), ranks(y));
  if (!Number.isFinite(rho)) return { rho, p: NaN, n };
  if (Math.abs(rho) >= 1) return { rho, p: 0, n };
  const t = rho * Math.sqrt((n - 2) / (1 - rho * rho));
  return { rho, p: 2 * (1 - tCdf(Math.abs(t), n - 2)), n };
}
