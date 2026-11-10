import type { LedgerEntry } from "./types";

/* ---------- canonical string (identical to scripts/verify-ledger.mjs) ---------- */
export function canonical(prevHash: string, e: LedgerEntry): string {
  return JSON.stringify([prevHash, e.id, e.issuedAt, e.symbol, e.direction, e.entry, e.stop, e.target, e.exit, e.closedAt, e.r]);
}

/* ---------- SHA-256: Web Crypto, with a pure-JS fallback for non-secure contexts ---------- */
const enc = new TextEncoder();
export const hasWebCrypto = typeof crypto !== "undefined" && !!crypto.subtle && typeof crypto.subtle.digest === "function";

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);
function sha256js(data: Uint8Array): string {
  const l = data.length;
  const withPad = ((l + 9 + 63) >> 6) << 6;
  const m = new Uint8Array(withPad);
  m.set(data);
  m[l] = 0x80;
  const bits = l * 8;
  const dv = new DataView(m.buffer);
  dv.setUint32(withPad - 4, bits >>> 0);
  dv.setUint32(withPad - 8, Math.floor(bits / 2 ** 32));
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < withPad; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
  return toHex(out);
}

export async function sha256Hex(s: string): Promise<string> {
  const data = enc.encode(s);
  if (hasWebCrypto) {
    try {
      return toHex(await crypto.subtle.digest("SHA-256", data));
    } catch {
      /* fall through */
    }
  }
  return sha256js(data);
}

export interface VerifyStep {
  index: number;
  id: string;
  ok: boolean;
  computed: string;
  stored: string;
  reason?: "hash" | "link";
}
export interface VerifyResult {
  ok: boolean;
  verified: number;
  total: number;
  head: string;
  breakAt?: VerifyStep;
  engine: "Web Crypto" | "JS fallback";
  ms: number;
}

/**
 * Recomputes the chain. `onStep` fires for every entry; `pace` (ms per batch) lets the UI
 * animate row by row. Stops at the first broken link.
 */
export async function verifyChain(
  entries: LedgerEntry[],
  genesis: string,
  opts: { onStep?: (s: VerifyStep) => void; paceMs?: number; batch?: number; signal?: { cancelled: boolean } } = {},
): Promise<VerifyResult> {
  const t0 = performance.now();
  let prev = genesis;
  const batch = opts.batch ?? 4;
  for (let i = 0; i < entries.length; i++) {
    if (opts.signal?.cancelled) break;
    const e = entries[i];
    const computed = await sha256Hex(canonical(prev, e));
    const linkOk = e.prevHash === prev;
    const ok = linkOk && computed === e.hash;
    const step: VerifyStep = { index: i, id: e.id, ok, computed, stored: e.hash, reason: ok ? undefined : linkOk ? "hash" : "link" };
    opts.onStep?.(step);
    if (!ok) {
      return {
        ok: false,
        verified: i,
        total: entries.length,
        head: prev,
        breakAt: step,
        engine: hasWebCrypto ? "Web Crypto" : "JS fallback",
        ms: performance.now() - t0,
      };
    }
    prev = computed;
    if (opts.paceMs && i % batch === batch - 1) await new Promise((r) => setTimeout(r, opts.paceMs));
  }
  return {
    ok: true,
    verified: entries.length,
    total: entries.length,
    head: prev,
    engine: hasWebCrypto ? "Web Crypto" : "JS fallback",
    ms: performance.now() - t0,
  };
}

/* ---------- stats (always computed from the ledger) ---------- */
export interface Stats {
  count: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  expectancy: number;
  profitFactor: number;
  totalR: number;
  maxDrawdown: number;
  best: number;
  worst: number;
}

export function computeStats(entries: LedgerEntry[]): Stats {
  let wins = 0;
  let losses = 0;
  let sumWin = 0;
  let sumLoss = 0;
  let total = 0;
  let best = -Infinity;
  let worst = Infinity;
  for (const e of entries) {
    total += e.r;
    if (e.r > 0) {
      wins++;
      sumWin += e.r;
    } else {
      losses++;
      sumLoss += e.r;
    }
    best = Math.max(best, e.r);
    worst = Math.min(worst, e.r);
  }
  const count = entries.length;
  const curve = equityCurve(entries);
  const maxDrawdown = curve.reduce((m, p) => Math.min(m, p.dd), 0);
  return {
    count,
    wins,
    losses,
    winRate: count ? wins / count : 0,
    avgWin: wins ? sumWin / wins : 0,
    avgLoss: losses ? sumLoss / losses : 0,
    expectancy: count ? total / count : 0,
    profitFactor: sumLoss !== 0 ? sumWin / Math.abs(sumLoss) : sumWin > 0 ? Infinity : 0,
    totalR: total,
    maxDrawdown,
    best: count ? best : 0,
    worst: count ? worst : 0,
  };
}

export interface CurvePoint {
  t: number;
  cum: number;
  dd: number;
  id: string;
  r: number;
}
export function equityCurve(entries: LedgerEntry[]): CurvePoint[] {
  const sorted = [...entries].sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt));
  let cum = 0;
  let peak = 0;
  return sorted.map((e) => {
    cum += e.r;
    peak = Math.max(peak, cum);
    return { t: Date.parse(e.closedAt), cum, dd: cum - peak, id: e.id, r: e.r };
  });
}

export interface MonthCell {
  year: number;
  month: number;
  r: number;
  n: number;
}
export function monthlyGrid(entries: LedgerEntry[]): { years: number[]; cells: Map<string, MonthCell> } {
  const cells = new Map<string, MonthCell>();
  const years = new Set<number>();
  for (const e of entries) {
    const d = new Date(e.closedAt);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    years.add(y);
    const k = `${y}-${m}`;
    const c = cells.get(k) ?? { year: y, month: m, r: 0, n: 0 };
    c.r += e.r;
    c.n++;
    cells.set(k, c);
  }
  return { years: [...years].sort(), cells };
}

export interface BreakdownRow {
  key: string;
  count: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  expectancy: number;
  totalR: number;
}
export function breakdown(entries: LedgerEntry[], key: (e: LedgerEntry) => string): BreakdownRow[] {
  const groups = new Map<string, LedgerEntry[]>();
  for (const e of entries) {
    const k = key(e);
    const g = groups.get(k);
    if (g) g.push(e);
    else groups.set(k, [e]);
  }
  return [...groups.entries()]
    .map(([k, list]) => {
      const s = computeStats(list);
      return { key: k, count: s.count, winRate: s.winRate, avgWin: s.avgWin, avgLoss: s.avgLoss, expectancy: s.expectancy, totalR: s.totalR };
    })
    .sort((a, b) => b.count - a.count);
}
