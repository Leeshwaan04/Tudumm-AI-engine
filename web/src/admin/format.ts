// Formatting for the operator console. Times show in the operator's local zone with an
// explicit zone label; numbers are tabular mono in the markup.

const nfInt = new Intl.NumberFormat("en-US");
const nfCompact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export const MINUS = "−";

export function int(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return nfInt.format(Math.round(n));
}

export function compact(n: number): string {
  return Math.abs(n) < 10_000 ? nfInt.format(n) : nfCompact.format(n);
}

export function pct(r: number | null | undefined, digits = 1): string {
  if (r === null || r === undefined || !Number.isFinite(r)) return "—";
  return `${(r * 100).toFixed(digits)}%`;
}

export function signed(n: number | null | undefined, digits = 2, suffix = ""): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const s = Math.abs(n).toFixed(digits);
  return `${n > 0 ? "+" : n < 0 ? MINUS : ""}${s}${suffix}`;
}

const zone = (() => {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
})();
export const TZ_LABEL = zone;

const dtf = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const dtfShort = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const tf = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const df = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" });
const dfShort = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short" });

function toDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t) : null;
}

export function dateTime(iso: string | null | undefined): string {
  const d = toDate(iso);
  return d ? dtf.format(d) : "—";
}

export function dateTimeShort(iso: string | null | undefined): string {
  const d = toDate(iso);
  if (!d) return "—";
  return d.getFullYear() === new Date().getFullYear() ? dtfShort.format(d) : dtf.format(d);
}

export function timeOnly(ms: number): string {
  return tf.format(new Date(ms));
}

export function dateOnly(iso: string | null | undefined): string {
  const d = toDate(iso);
  return d ? df.format(d) : "—";
}

/** "2026-11-03" (a UTC calendar day from SQL) → "03 Nov" without zone drift. */
export function dayLabel(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return Number.isFinite(d.getTime()) ? dfShort.format(d) : day;
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  const d = toDate(iso);
  if (!d) return "—";
  const s = Math.round((now - d.getTime()) / 1000);
  // Small negative values are clock skew between the Worker and this browser, not the future.
  if (s < -90) return `in ${dur(-s)}`;
  if (s < 45) return "just now";
  return `${dur(s)} ago`;
}

/** Compact duration: 42s, 7m, 3h 12m, 4d 2h. */
export function dur(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? ` ${h % 24}h` : ""}`;
}

export function ageDays(iso: string | null | undefined, now = Date.now()): number | null {
  const d = toDate(iso);
  return d ? (now - d.getTime()) / 86_400_000 : null;
}

export function shortId(id: string | null | undefined, n = 8): string {
  if (!id) return "—";
  return id.length > n ? id.slice(0, n) : id;
}

/** Compact one-line JSON for props/detail columns. Rendered as text, never HTML. */
export function jsonLine(v: unknown, max = 140): string {
  if (v === null || v === undefined) return "";
  let s: string;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function jsonPretty(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** <input type="date"> value (local) → ISO at the END of that local day. */
export function endOfLocalDayIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d, 23, 59, 59);
  return Number.isFinite(dt.getTime()) ? dt.toISOString() : null;
}

/** <input type="datetime-local"> value → ISO, or null. */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** ISO → <input type="datetime-local"> value in local time. */
export function isoToLocalInput(iso: string | null | undefined): string {
  const d = toDate(iso);
  if (!d) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function todayLocalInput(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
