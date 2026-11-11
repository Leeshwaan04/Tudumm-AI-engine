// Small pure helpers shared by broker adapters and routes (unit-tested in worker/test/broker.test.ts).

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

/** First 06:00 IST strictly after nowMs (Indian brokers' daily token expiry), as UTC ISO. */
export function next0600Ist(nowMs: number): string {
  const istNow = nowMs + IST_OFFSET_MS;
  let expiryIst = Math.floor(istNow / DAY_MS) * DAY_MS + 6 * 3_600_000;
  if (expiryIst <= istNow) expiryIst += DAY_MS;
  return new Date(expiryIst - IST_OFFSET_MS).toISOString();
}

/** Start of the current IST calendar day as UTC ISO (the daily order cap resets here). */
export function istDayStartIso(nowMs: number): string {
  const istMidnight = Math.floor((nowMs + IST_OFFSET_MS) / DAY_MS) * DAY_MS;
  return new Date(istMidnight - IST_OFFSET_MS).toISOString();
}

const CTRL = /[\u0000-\u001f\u007f]/g;

/** Text from a third party, control chars removed and capped. */
export function cleanText(m: unknown, max = 200): string {
  return typeof m === "string" ? m.replace(CTRL, " ").trim().slice(0, max) : "";
}

export type Scalar = string | number | boolean | null;

/** Copy only the listed scalar fields (strings cleaned + capped). */
export function pick(row: unknown, fields: readonly string[]): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  if (!row || typeof row !== "object") return out;
  const r = row as Record<string, unknown>;
  for (const f of fields) {
    const x = r[f];
    if (typeof x === "string") out[f] = x.replace(CTRL, " ").slice(0, 200);
    else if (typeof x === "number" && Number.isFinite(x)) out[f] = x;
    else if (typeof x === "boolean" || x === null) out[f] = x;
  }
  return out;
}

/** Numeric leaves of a flat object (snake_case keys only). */
export function numbers(o: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!o || typeof o !== "object") return out;
  for (const [k, x] of Object.entries(o as Record<string, unknown>)) {
    if (/^[a-z0-9_]{1,40}$/.test(k) && typeof x === "number" && Number.isFinite(x)) out[k] = x;
  }
  return out;
}

export function n(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

export function nOrNull(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

export function s(x: unknown, max = 200): string {
  return typeof x === "string" ? x.replace(CTRL, " ").slice(0, max) : "";
}

export function sOrNull(x: unknown, max = 200): string | null {
  return typeof x === "string" && x ? x.replace(CTRL, " ").slice(0, max) : null;
}
