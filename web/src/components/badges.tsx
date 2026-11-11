import { Link } from "react-router-dom";
import { AlertTriangle, RefreshCw, WifiOff } from "lucide-react";
import type { Instrument } from "../engine/types";
import { useData } from "./DataProvider";
import { useNetState, ping } from "../api/client";
import { useEffect, useState } from "react";
import { useNow } from "../engine/live";

/* ---------------- freshness ---------------- */
const VENUE: Record<string, string> = {
  binance: "BINANCE",
  "binance-futures": "BINANCE",
  bybit: "BYBIT",
  cboe: "CBOE",
  "nse-archives": "NSE",
  "ecb-frankfurter": "ECB",
  "sec-edgar": "SEC",
  "alternative-me": "ALTERNATIVE.ME",
};

export interface FreshInfo {
  label: string;
  short: string;
  tone: "rt" | "delayed" | "eod" | "ref";
  proxy: string | null;
  title: string;
}

export function fmtAsOf(iso: string | null | undefined, opts: { date?: boolean } = {}): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  const today = new Date().toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (today && !opts.date) return hm;
  return `${d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })} ${hm}`;
}

const PROXY_SHORT: Record<string, string> = {
  XAUUSD: "PAXG PROXY FOR GOLD",
  CL: "USO ETF PROXY FOR WTI",
  ASML: "ASML ADR (NASDAQ)",
};

export function freshness(inst: Instrument): FreshInfo | null {
  if (!inst.freshness && !inst.source) return null;
  const venue = (inst.source && VENUE[inst.source]) || null;
  let label: string;
  let short: string;
  let tone: FreshInfo["tone"];
  switch (inst.freshness) {
    case "realtime":
      label = `REAL-TIME · ${venue ?? "BINANCE"}`;
      short = "RT";
      tone = "rt";
      break;
    case "delayed-15m":
      label = `DELAYED 15M · ${venue ?? "CBOE"}`;
      short = "15M";
      tone = "delayed";
      break;
    case "eod":
      label = `END OF DAY · ${venue ?? "NSE"}`;
      short = "EOD";
      tone = "eod";
      break;
    case "daily-ref":
      label = `DAILY REF · ${venue ?? "ECB"}`;
      short = "REF";
      tone = "ref";
      break;
    default:
      label = venue ? `SOURCE · ${venue}` : "LIVE SOURCE";
      short = "SRC";
      tone = "delayed";
  }
  const proxy = PROXY_SHORT[inst.symbol] ?? (inst.proxyNote ? "PROXY" : null);
  const asOf = inst.asOf ? ` · price as of ${fmtAsOf(inst.asOf, { date: inst.freshness === "eod" || inst.freshness === "daily-ref" })}` : "";
  const title = `${label}${asOf}${inst.proxyNote ? `. ${inst.proxyNote}` : ""}`;
  return { label, short, tone, proxy, title };
}

/** Full freshness badge, e.g. `DELAYED 15M · CBOE` (+ proxy chip). */
export function FreshnessBadge({ inst, compact = false, showProxy = true }: { inst: Instrument; compact?: boolean; showProxy?: boolean }) {
  const f = freshness(inst);
  if (!f) return null;
  return (
    <span className="fresh-wrap">
      <span className={`fresh fresh--${f.tone} ${compact ? "fresh--compact" : ""}`} title={f.title} aria-label={f.title}>
        <i aria-hidden="true" />
        {compact ? f.short : f.label}
      </span>
      {showProxy && f.proxy && !compact && (
        <span className="fresh fresh--proxy" title={inst.proxyNote ?? f.proxy}>
          {f.proxy}
        </span>
      )}
    </span>
  );
}

/* ---------------- engine v0 tag ---------------- */
export const ENGINE_EXPLAINER =
  "Live calls come from engine v0: transparent rules (trend, momentum, order book, options and sentiment checks) on free public data. Its confidence number is a rule-based score that hasn't been calibrated against outcomes yet, so read it as a ranking, not a probability. Every call and its result goes on the public ledger.";

export function EngineTag({ className = "" }: { className?: string }) {
  return (
    <span className={`engine-tag ${className}`} tabIndex={0} role="note" aria-label={`Engine v0, uncalibrated. ${ENGINE_EXPLAINER}`} data-tip={ENGINE_EXPLAINER}>
      ENGINE V0 · UNCALIBRATED
    </span>
  );
}

/* ---------------- disclaimer ---------------- */
export const BETA_DISCLAIMER = "Tudumm is in beta. Signals are probabilistic and not investment advice. Trading involves risk of loss.";
export const LIVE_DISCLAIMER =
  "Live beta on free data: crypto real-time, US delayed 15 minutes, India end of day, FX daily reference rates. Signals come from engine v0 (rule-based, uncalibrated) and are probabilities, not promises.";

export function Disclaimer({ className = "" }: { className?: string }) {
  return <p className={`disclaimer ${className}`}>{LIVE_DISCLAIMER}</p>;
}

/* ---------------- banners ---------------- */
export function DataBanner() {
  const d = useData();
  if (d.phase === "ready" && d.stale) {
    return (
      <div className="banner banner--info" role="status">
        <RefreshCw size={15} aria-hidden="true" />
        <p>
          <b>Live prices are lagging.</b>{" "}
          <span className="t2">The last refresh failed; showing data from {d.lastPollAt ? fmtAsOf(new Date(d.lastPollAt).toISOString()) : "earlier"}. Retrying automatically.</span>
        </p>
        <button type="button" className="btn btn--sm" onClick={d.retry}>
          <RefreshCw size={13} aria-hidden="true" /> Retry now
        </button>
      </div>
    );
  }
  return null;
}

/** Full-width state for screens that need market data when none is available. */
export function LiveUnavailable({ compact = false }: { compact?: boolean }) {
  const d = useData();
  const now = useNow(1000);
  if (d.phase === "loading") {
    return (
      <div className={`live-na ${compact ? "live-na--compact" : ""}`} role="status" aria-live="polite">
        <span className="live-na__beats" aria-hidden="true">
          <i />
          <i />
        </span>
        <p className="live-na__title">Loading live market data…</p>
      </div>
    );
  }
  const secs = d.nextRetryAt ? Math.max(0, Math.ceil((d.nextRetryAt - now) / 1000)) : null;
  return (
    <div className={`live-na ${compact ? "live-na--compact" : ""}`} role="status" aria-live="polite">
      <AlertTriangle size={compact ? 16 : 20} aria-hidden="true" />
      <p className="live-na__title">Live data temporarily unavailable — retrying</p>
      {d.reason && <p className="live-na__why">{d.reason}</p>}
      {!compact && <p className="live-na__fine">Tudumm never fills gaps with made-up or cached numbers. Prices and calls appear here as soon as the market API answers.</p>}
      <p className="live-na__meta mono">
        {secs !== null ? `next attempt in ${secs}s` : "retrying"}
        {d.unavailable.length ? ` · ${d.unavailable.length} instruments waiting on their source` : ""}
      </p>
      <button type="button" className="btn btn--sm" onClick={d.retry}>
        <RefreshCw size={13} aria-hidden="true" /> Retry now
      </button>
    </div>
  );
}

export function OfflineBanner() {
  const net = useNetState();
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!net.offline) return;
    const delay = Math.min(30_000, 3000 * 2 ** Math.min(tries, 4));
    const t = window.setTimeout(async () => {
      const ok = await ping();
      if (!ok) setTries((n) => n + 1);
    }, delay);
    return () => window.clearTimeout(t);
  }, [net.offline, tries]);
  useEffect(() => {
    if (!net.offline) setTries(0);
  }, [net.offline]);
  if (!net.offline) return null;
  return (
    <div className="banner banner--critical" role="alert">
      <WifiOff size={15} aria-hidden="true" />
      <p>
        <b>You're offline or Tudumm can't be reached.</b> <span className="t2">Retrying automatically…</span>
      </p>
      <button type="button" className="btn btn--sm" onClick={() => void ping()}>
        <RefreshCw size={13} aria-hidden="true" /> Retry now
      </button>
    </div>
  );
}

/** Honest "not available" state for a widget, with the API's reason. */
export function NAState({ title, reason, children }: { title: string; reason?: string | null; children?: React.ReactNode }) {
  return (
    <div className="na-box hatch-soft">
      <AlertTriangle size={16} aria-hidden="true" />
      <div>
        <p className="na-box__title">{title}</p>
        {reason && <p>{reason}</p>}
        {children}
      </div>
    </div>
  );
}

/** `source · as of hh:mm` footnote every live widget carries. */
export function SourceLine({ source, asOf, extra }: { source?: string | null; asOf?: string | null; extra?: string }) {
  if (!source && !asOf) return null;
  const s = source ? (VENUE[source] ?? source).toString() : null;
  return (
    <p className="src-line mono">
      {s && <span>{s.toLowerCase() === s ? s : s}</span>}
      {s && asOf && " · "}
      {asOf && <span>as of {fmtAsOf(asOf)}</span>}
      {extra && <span> · {extra}</span>}
    </p>
  );
}

export function LegalLinks() {
  return (
    <>
      <Link to="/terms">Terms</Link>
      <Link to="/privacy">Privacy</Link>
      <Link to="/risk">Risk disclosure</Link>
      <Link to="/app/support">Support</Link>
    </>
  );
}

/* ---------------- engine v0 sit-out reasons ---------------- */
const SIT_OUT_LABEL: Record<string, string> = {
  no_trend: "No clear trend",
  momentum_conflict: "Momentum conflicts",
  insufficient_agreement: "Too few layers agree",
  stale_data: "Data is stale",
  insufficient_history: "Not enough history",
  event_risk: "Event risk",
  strategy_disabled: "Strategy paused",
  cooldown: "Cooling down after a close",
  no_data: "No data yet",
  under_review: "New call under review",
  closed: "Last call just closed",
};
export function sitOutLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return SIT_OUT_LABEL[reason] ?? reason.replace(/_/g, " ");
}
