// Input validation primitives. Each throws HttpError(400, "invalid_input", { field, message }).
import { HttpError } from "./http";

export function invalid(field: string, message: string): HttpError {
  return new HttpError(400, "invalid_input", { field, message });
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function str(
  v: unknown,
  field: string,
  opts: { min?: number; max: number; pattern?: RegExp; multiline?: boolean } = { max: 200 },
): string {
  if (typeof v !== "string") throw invalid(field, "must be a string");
  let s = v.replace(CONTROL, "");
  if (!opts.multiline) s = s.replace(/[\r\n\t]+/g, " ");
  s = s.trim();
  if (s.length < (opts.min ?? 1)) throw invalid(field, `must be at least ${opts.min ?? 1} characters`);
  if (s.length > opts.max) throw invalid(field, `must be at most ${opts.max} characters`);
  if (opts.pattern && !opts.pattern.test(s)) throw invalid(field, "has an invalid format");
  return s;
}

export function optStr(v: unknown, field: string, opts: { min?: number; max: number; pattern?: RegExp; multiline?: boolean }): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return str(v, field, opts);
}

export function oneOf<T extends string>(v: unknown, field: string, values: readonly T[]): T {
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) throw invalid(field, `must be one of: ${values.join(", ")}`);
  return v as T;
}

export function num(v: unknown, field: string, opts: { min?: number; max?: number; gt?: number; integer?: boolean } = {}): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw invalid(field, "must be a finite number");
  if (opts.integer && !Number.isInteger(v)) throw invalid(field, "must be an integer");
  if (opts.gt !== undefined && !(v > opts.gt)) throw invalid(field, `must be greater than ${opts.gt}`);
  if (opts.min !== undefined && v < opts.min) throw invalid(field, `must be at least ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) throw invalid(field, `must be at most ${opts.max}`);
  return v;
}

export function bool(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") throw invalid(field, "must be true or false");
  return v;
}

const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function email(v: unknown, field = "email"): string {
  if (typeof v !== "string") throw invalid(field, "must be an email address");
  const e = v.trim().toLowerCase();
  if (e.length > 254 || !EMAIL.test(e) || e.endsWith("@invalid")) throw invalid(field, "must be a valid email address");
  return e;
}

/** Instrument symbol: canonical uppercase (BTCUSDT, NIFTY, RELIANCE, EURUSD...). */
export const SYMBOL_RE = /^[A-Z0-9][A-Z0-9._:-]{0,23}$/;

export function symbol(v: unknown, field = "symbol"): string {
  if (typeof v !== "string") throw invalid(field, "must be a symbol string");
  const s = v.trim().toUpperCase();
  if (!SYMBOL_RE.test(s)) throw invalid(field, "must be 1-24 chars of A-Z 0-9 . _ : -");
  return s;
}

export const SIGNAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

export function signalId(v: unknown, field = "signalId"): string {
  if (typeof v !== "string" || !SIGNAL_ID_RE.test(v) || v.startsWith("sym:")) throw invalid(field, "must be a signal id");
  return v;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function uuid(v: unknown, field = "id"): string {
  if (typeof v !== "string" || !UUID_RE.test(v)) throw invalid(field, "must be an id");
  return v;
}

export function isoDate(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length > 40) throw invalid(field, "must be an ISO date");
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw invalid(field, "must be an ISO date");
  return new Date(t).toISOString();
}

/** A link we render in the UI: same-site relative path or https URL. Never javascript:/data:. */
export function safeLink(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  const s = str(v, field, { max: 500 });
  if (s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\")) return s;
  try {
    const u = new URL(s);
    if (u.protocol === "https:") return u.toString();
  } catch {
    /* fall through */
  }
  throw invalid(field, "must be a relative path (/...) or an https:// URL");
}

export function intParam(v: string | null, def: number, min: number, max: number): number {
  if (v === null || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function stringArray(v: unknown, field: string, maxItems: number): unknown[] {
  if (!Array.isArray(v)) throw invalid(field, "must be an array");
  if (v.length > maxItems) throw invalid(field, `must have at most ${maxItems} items`);
  return v;
}
