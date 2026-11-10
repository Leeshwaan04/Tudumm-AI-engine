import type { MarketId } from "./types";

export type SessionKey = "NSE" | "NYSE" | "EURONEXT" | "CRYPTO" | "FX" | "CME";
export type SessionState = "open" | "closed" | "pre" | "break";

export interface SessionInfo {
  key: SessionKey;
  label: string;
  tz: string;
  tzLabel: string;
  state: SessionState;
  open: boolean;
  time: string;
  /** Short human status, e.g. "Open", "Closed", "Pre-open", "24/7". */
  status: string;
  hours: string;
}

const DEFS: Record<SessionKey, { label: string; tz: string; tzLabel: string; hours: string }> = {
  NSE: { label: "NSE", tz: "Asia/Kolkata", tzLabel: "IST", hours: "Mon–Fri 09:15–15:30 IST" },
  NYSE: { label: "NYSE", tz: "America/New_York", tzLabel: "ET", hours: "Mon–Fri 09:30–16:00 ET" },
  EURONEXT: { label: "Euronext", tz: "Europe/Amsterdam", tzLabel: "CET", hours: "Mon–Fri 09:00–17:30 CET" },
  CRYPTO: { label: "Crypto", tz: "UTC", tzLabel: "UTC", hours: "24/7" },
  FX: { label: "FX", tz: "America/New_York", tzLabel: "ET", hours: "24/5 · Sun 17:00 – Fri 17:00 ET" },
  CME: { label: "CME Globex", tz: "America/New_York", tzLabel: "ET", hours: "Sun–Fri 18:00–17:00 ET" },
};

export const MARKET_SESSION: Record<MarketId, SessionKey> = {
  IN: "NSE",
  US: "NYSE",
  EU: "EURONEXT",
  CRYPTO: "CRYPTO",
  FX: "FX",
  CMDTY: "CME",
};

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsIn(tz: string, at: number) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    fmtCache.set(tz, f);
  }
  const parts = f.formatToParts(new Date(at));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const h = Number(get("hour")) % 24;
  const m = Number(get("minute"));
  return { wd, h, m, mins: h * 60 + m, time: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}` };
}

export function session(key: SessionKey, at: number = Date.now()): SessionInfo {
  const d = DEFS[key];
  const p = partsIn(d.tz, at);
  const weekday = p.wd >= 1 && p.wd <= 5;
  let state: SessionState = "closed";
  switch (key) {
    case "NSE":
      if (weekday && p.mins >= 555 && p.mins < 930) state = "open";
      else if (weekday && p.mins >= 540 && p.mins < 555) state = "pre";
      break;
    case "NYSE":
      if (weekday && p.mins >= 570 && p.mins < 960) state = "open";
      else if (weekday && p.mins >= 240 && p.mins < 570) state = "pre";
      break;
    case "EURONEXT":
      if (weekday && p.mins >= 540 && p.mins < 1050) state = "open";
      break;
    case "CRYPTO":
      state = "open";
      break;
    case "FX": {
      const closedWeekend = p.wd === 6 || (p.wd === 5 && p.mins >= 1020) || (p.wd === 0 && p.mins < 1020);
      state = closedWeekend ? "closed" : "open";
      break;
    }
    case "CME": {
      const weekend = p.wd === 6 || (p.wd === 5 && p.mins >= 1020) || (p.wd === 0 && p.mins < 1080);
      if (weekend) state = "closed";
      else if (p.mins >= 1020 && p.mins < 1080) state = "break";
      else state = "open";
      break;
    }
  }
  const status =
    key === "CRYPTO"
      ? "24/7"
      : state === "open"
        ? "Open"
        : state === "pre"
          ? key === "NSE"
            ? "Pre-open"
            : "Pre-market"
          : state === "break"
            ? "Daily break"
            : "Closed";
  return { key, ...d, state, open: state === "open", time: p.time, status };
}

export function marketSession(m: MarketId, at?: number): SessionInfo {
  return session(MARKET_SESSION[m], at);
}
