import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { Bookmark, BookmarkCheck, Lock } from "lucide-react";
import type { Instrument, LiveStatus, TradeSignal } from "../engine/types";
import { isTrade } from "../engine/types";
import { rAt } from "../engine/seed";
import { fmtAgo, fmtCountdown, fmtR, fmtSignedPct } from "../engine/format";
import { issuedAtMs, secondsToReveal, useLiveStatus, useNow, useTick } from "../engine/live";
import { trackingStore, toggleIn, useStore } from "../engine/profile";
import { ConfluenceMeter, DirectionPill, LevelsRow, LivePrice, StatusPill, TradeMap, distanceToZone } from "./signal";
import { useCountUp, useReducedMotion } from "./hooks";

const REGIME_LABEL: Record<string, string> = {
  "trending-up": "Trending up",
  "trending-down": "Trending down",
  range: "Range",
  "high-vol": "High volatility",
  mixed: "Mixed",
};
export function regimeLabel(r: string) {
  return REGIME_LABEL[r] ?? r;
}

export interface SignalCardProps {
  inst: Instrument;
  /** Run the Reveal on mount after this delay (ms). null = render settled. */
  revealDelay?: number | null;
  trackable?: boolean;
  /** Card links to the instrument page; null disables the link. */
  linkTo?: string | null;
  variant?: "default" | "hero" | "anatomy";
  /** Override the shown status (used by the landing hero's "Revealing…" beat). */
  statusOverride?: LiveStatus;
  className?: string;
}

export function SignalCard({
  inst,
  revealDelay = null,
  trackable = false,
  linkTo,
  variant = "default",
  statusOverride,
  className = "",
}: SignalCardProps) {
  const s = inst.signal;
  const liveStatus = useLiveStatus(inst.symbol);
  const status = statusOverride ?? liveStatus;
  const reduced = useReducedMotion();
  const [revealKey, setRevealKey] = useState<string | null>(revealDelay !== null ? "mount" : null);
  const prevStatus = useRef(liveStatus);

  // queued -> revealed: run the Reveal
  useEffect(() => {
    if (prevStatus.current === "queued" && liveStatus !== "queued") setRevealKey(`reveal-${Date.now()}`);
    prevStatus.current = liveStatus;
  }, [liveStatus]);

  const delay = revealKey === "mount" ? (revealDelay ?? 0) : 0;
  const href = linkTo === undefined ? `/app/i/${inst.symbol}` : linkTo;
  // the animation class is removed on a timer, so the card always settles to its final state
  // even where CSS animations / rAF are throttled
  const [animating, setAnimating] = useState(revealKey !== null);
  useEffect(() => {
    if (revealKey === null) return;
    setAnimating(true);
    const t = window.setTimeout(() => setAnimating(false), delay + 1500);
    return () => window.clearTimeout(t);
  }, [revealKey, delay]);
  const revealing = animating && revealKey !== null && !reduced;
  const style = { "--reveal-delay": `${delay}ms` } as CSSProperties;

  const tone = status === "sit_out" ? "sitout" : status === "queued" ? "queued" : isTrade(s) ? s.direction.toLowerCase() : "sitout";

  return (
    <article
      key={revealKey ?? "static"}
      className={`sc sc--${tone} sc--${variant} ${revealing ? "is-revealing" : ""} ${className}`}
      style={style}
      aria-label={`${inst.symbol} signal`}
    >
      <span className="sc__sweep" aria-hidden="true" />
      <CardHeader inst={inst} href={href} status={status} />
      {status === "queued" && isTrade(s) ? (
        <SealedBody inst={inst} />
      ) : status === "sit_out" || !isTrade(s) ? (
        <SitOutBody inst={inst} />
      ) : (
        <TradeBody inst={inst} s={s} status={status} revealKey={revealKey} delay={delay} trackable={trackable} />
      )}
    </article>
  );
}

function CardHeader({ inst, href, status }: { inst: Instrument; href: string | null; status: LiveStatus }) {
  const s = inst.signal;
  const now = useNow(15_000);
  const mins = (now - issuedAtMs(inst)) / 60_000;
  const symbol = <span className="sc__sym mono">{inst.symbol}</span>;
  return (
    <header className="sc__head">
      <div className="sc__title">
        {href ? (
          <Link to={href} className="sc__link" aria-label={`Open ${inst.symbol} deep-dive`}>
            {symbol}
          </Link>
        ) : (
          symbol
        )}
        <span className="sc__name">{inst.name}</span>
        <span className="chip chip--hash sc__id" title="Ledger id: this call is hashed into the public ledger" data-anchor="ledger">
          #{s.id}
        </span>
      </div>
      <div className="sc__meta">
        <span className="chip">{inst.exchange}</span>
        {isTrade(s) && <span className="chip">{s.timeframe}</span>}
        {isTrade(s) && <span className="chip">{s.style}</span>}
        <span className="sc__ago mono">{status === "queued" ? "queued" : `issued ${fmtAgo(Math.max(0, mins))}`}</span>
      </div>
    </header>
  );
}

function TradeBody({
  inst,
  s,
  status,
  revealKey,
  delay,
  trackable,
}: {
  inst: Instrument;
  s: TradeSignal;
  status: LiveStatus;
  revealKey: string | null;
  delay: number;
  trackable: boolean;
}) {
  const conf = useCountUp(Math.round(s.confidence * 100), revealKey, 950, delay + 260);
  const t = useTick(inst.symbol);
  const tracked = useStore(trackingStore).includes(inst.symbol);
  const r = rAt(s, t.price);
  const filled = status === "active" || status === "t1_hit";
  const dz = distanceToZone(s, t.price);
  return (
    <>
      <div className="sc__verdict">
        <div className="sc__pills">
          <DirectionPill direction={s.direction} size="lg" />
          <StatusPill status={status} />
        </div>
        <div className="sc__conf" data-anchor="confidence">
          <span className="sc__conf-num mono">{Math.round(conf)}%</span>
          <span className="sc__conf-lab">confidence</span>
        </div>
      </div>
      <div className="sc__live">
        <LivePrice inst={inst} showChange />
        {filled ? (
          <span className={`sc__ur mono ${r >= 0 ? "c-long" : "c-short"}`} title="Unrealized move in R (multiples of initial risk)">
            {fmtR(r)} <span className="t3">open</span>
          </span>
        ) : (
          <span className="sc__ur mono t2" title="Distance from price to the entry zone">
            {fmtSignedPct(-dz)} <span className="t3">to entry</span>
          </span>
        )}
      </div>
      <TradeMap inst={inst} signal={s} status={status} />
      <LevelsRow inst={inst} s={s} />
      <ConfluenceMeter layers={s.layers} />
      <div className="sc__why">
        <p className="sc__thesis" data-anchor="why">
          {s.thesis}
        </p>
        {s.invalidation && (
          <p className="sc__inv" data-anchor="invalidation">
            <span>Invalidated if:</span> {s.invalidation}
          </p>
        )}
      </div>
      {trackable && (
        <footer className="sc__foot">
          <span className="sc__strategy">{s.strategy}</span>
          <button
            type="button"
            className={`sc__track ${tracked ? "is-on" : ""}`}
            aria-pressed={tracked}
            onClick={() => toggleIn(trackingStore, inst.symbol)}
            title={tracked ? "Stop tracking this signal in Your risk" : "Track this signal in Your risk"}
          >
            {tracked ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}
            {tracked ? "Tracking" : "Track"}
          </button>
        </footer>
      )}
    </>
  );
}

function SitOutBody({ inst }: { inst: Instrument }) {
  const s = inst.signal;
  return (
    <>
      <div className="sc__verdict sc__verdict--sit">
        <h3 className="sc__sit serif">Sitting out</h3>
        <StatusPill status="sit_out" />
      </div>
      <div className="sc__live">
        <LivePrice inst={inst} showChange />
        <span className="chip">{regimeLabel(s.regime)}</span>
      </div>
      <p className="sc__thesis sc__thesis--sit">{s.thesis}</p>
      <ConfluenceMeter layers={s.layers} tone="sitout" />
      <p className="sc__inv">
        <span>No levels.</span> Tudumm re-checks every bar and will issue a call only when the layers line up.
      </p>
    </>
  );
}

function SealedBody({ inst }: { inst: Instrument }) {
  const now = useNow();
  const left = secondsToReveal(inst, now);
  const beat = Math.ceil(left) <= 3;
  return (
    <>
      <div className="sc__verdict">
        <div className="sc__pills">
          <span className="dpill dpill--sealed dpill--lg">
            <Lock size={12} aria-hidden="true" /> SEALED
          </span>
          <StatusPill status="queued" />
        </div>
      </div>
      <div className={`sc__drum ${beat ? "is-final" : ""}`} aria-live="polite">
        <span className="eyebrow">Next reveal in</span>
        <span key={Math.ceil(left)} className="sc__drum-num mono">
          {fmtCountdown(left)}
        </span>
      </div>
      <div className="sc__sealed hatch" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <ConfluenceMeter layers={inst.signal.layers} tone="sealed" />
      <p className="sc__inv">
        <span>Levels sealed</span> until the countdown ends. Then the full call appears at once.
      </p>
    </>
  );
}
