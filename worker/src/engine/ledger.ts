// Live ledger hash chain v2 (pure; uses the Web Crypto global available in Workers, Node and browsers).
//
//   hash = sha256hex(JSON.stringify([prevHash, seq, type, signalId, symbol, direction,
//                                    entryLow, entryHigh, stop, target1, target2,
//                                    exit|null, outcome|null, r|null, at]))
//   genesis prevHash = 64 zeros; seq starts at 1; numbers are JSON numbers already rounded to the
//   instrument's decimals (integers stay integers), so the browser reproduces the exact same string.

export const GENESIS_HASH = "0".repeat(64);

export interface LedgerFields {
  seq: number;
  type: "issue" | "close";
  signalId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  entryLow: number;
  entryHigh: number;
  stop: number;
  target1: number;
  target2: number;
  exit: number | null;
  outcome: string | null;
  r: number | null;
  at: string; // ISO
}

export interface LedgerEntry extends LedgerFields {
  prevHash: string;
  hash: string;
}

export function canonicalV2(prevHash: string, e: LedgerFields): string {
  return JSON.stringify([
    prevHash,
    e.seq,
    e.type,
    e.signalId,
    e.symbol,
    e.direction,
    e.entryLow,
    e.entryHigh,
    e.stop,
    e.target1,
    e.target2,
    e.exit ?? null,
    e.outcome ?? null,
    e.r ?? null,
    e.at,
  ]);
}

export async function sha256hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += (b[i] as number).toString(16).padStart(2, "0");
  return s;
}

export async function hashEntry(prevHash: string, e: LedgerFields): Promise<string> {
  return sha256hex(canonicalV2(prevHash, e));
}

export async function appendEntry(head: { seq: number; hash: string }, e: Omit<LedgerFields, "seq">): Promise<LedgerEntry> {
  const fields: LedgerFields = { ...e, seq: head.seq + 1 };
  const hash = await hashEntry(head.hash, fields);
  return { ...fields, prevHash: head.hash, hash };
}

/** Verify a contiguous chain (oldest first). `startPrevHash` lets you verify a page that isn't from genesis. */
export async function verifyChain(entries: readonly LedgerEntry[], startPrevHash = GENESIS_HASH): Promise<{ ok: boolean; brokenAt: number | null }> {
  let prev = startPrevHash;
  for (const e of entries) {
    if (e.prevHash !== prev) return { ok: false, brokenAt: e.seq };
    const h = await hashEntry(prev, e);
    if (h !== e.hash) return { ok: false, brokenAt: e.seq };
    prev = e.hash;
  }
  return { ok: true, brokenAt: null };
}
