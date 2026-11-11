import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowRight, Check, Copy, Menu, Puzzle, ShieldCheck, X } from "lucide-react";
import { LogoMark, Wordmark } from "../components/Logo";
import { SignalCard } from "../components/SignalCard";
import { DirectionPill } from "../components/signal";
import { EquityCurve } from "../components/charts";
import { SessionChip, Toaster, toast } from "../components/ui";
import { useDocumentTitle, useReducedMotion } from "../components/hooks";
import { DataProvider, useData } from "../components/DataProvider";
import { EngineTag, FreshnessBadge, LegalLinks, LiveUnavailable, fmtAsOf, sitOutLabel } from "../components/badges";
import { instruments, instrumentsIn, sitOutInstruments, tradeInstruments, useDataset, MARKET_LABEL, MARKET_ORDER, LAYER_ORDER, LAYER_LABEL } from "../engine/universe";
import type { Instrument } from "../engine/types";
import { isTrade } from "../engine/types";
import { useTick, useStatuses } from "../engine/live";
import { openSignIn, useSession } from "../api/session";
import { useCaps, usePlans } from "../api/config";
import { billingApi } from "../api/endpoints";
import { errorText } from "../api/client";
import { track } from "../api/events";
import { marketApi, type CandlesRes, type LedgerEntryV2 } from "../api/market";
import { useApi } from "../api/useApi";
import type { PlanDef } from "../api/types";
import type { CurvePoint } from "../engine/ledger";
import { fmtPrice, fmtSignedPct, fmtPct, MINUS } from "../engine/format";
import { MARKET_SESSION } from "../engine/sessions";
import { PERSONAS, updateProfile, type Persona } from "../engine/profile";
import { LAYER_QUESTION, layerTone } from "../engine/evidence";

/*
 * Every number on this page comes from the live API: the universe (via DataProvider), the live
 * ledger and real candles. There is no demo or simulated data; when the API can't answer, the
 * sections say so instead of showing made-up numbers.
 */
const BETA_DISCLAIMER = "Tudumm is in beta. Signals are probabilistic and not investment advice. Trading involves risk of loss.";
const LIVE_BETA = "Live beta on free data: crypto (real-time), US (15-min delayed), India (end of day), FX (daily reference).";
/** Fewer closed calls than this are too few to judge. */
const JUDGE_MIN = 30;

/** Open calls by confidence (up to 3); when nothing is open, real sit-outs that have a price. */
function useShowcase(): { picks: Instrument[]; trades: boolean } {
  const ds = useDataset();
  return useMemo(() => {
    const trades = [...tradeInstruments].sort((a, b) => (isTrade(b.signal) ? b.signal.confidence : 0) - (isTrade(a.signal) ? a.signal.confidence : 0));
    if (trades.length) return { picks: trades.slice(0, 3), trades: true };
    return { picks: sitOutInstruments.slice(0, 3), trades: false };
    // ds: recompute when a live poll swaps the universe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ds]);
}

/** Stats over the live ledger's close entries (computed in the browser, never typed in). */
function useLiveLedger() {
  const q = useApi<LedgerEntryV2[]>("landing:ledger", () => marketApi.ledgerAll(), { refreshMs: 300_000, staleMs: 60_000 });
  const stats = useMemo(() => {
    const all = q.data ?? [];
    const closes = all.filter((e) => e.type === "close" && typeof e.r === "number" && Number.isFinite(e.r));
    const rs = closes.map((e) => e.r as number);
    const n = rs.length;
    const wins = rs.filter((r) => r > 0).length;
    const total = rs.reduce((a, b) => a + b, 0);
    let cum = 0;
    let peak = 0;
    const curve: CurvePoint[] = closes.map((e) => {
      cum += e.r as number;
      peak = Math.max(peak, cum);
      return { t: Date.parse(e.at), cum, dd: cum - peak, id: e.signalId, r: e.r as number };
    });
    const closed = new Set(closes.map((e) => e.signalId));
    const open = all.filter((e) => e.type === "issue" && !closed.has(e.signalId)).length;
    return { entries: all.length, n, wins, total, avg: n ? total / n : 0, winRate: n ? wins / n : 0, curve, open, startedAt: all.length ? all[0].at : null };
  }, [q.data]);
  return { ...stats, loaded: !!q.data, error: !!q.error && !q.data };
}

const signedR = (v: number, d = 2) => `${v > 0 ? "+" : v < 0 ? MINUS : ""}${Math.abs(v).toFixed(d)}R`;

function trackRecordLine(l: ReturnType<typeof useLiveLedger>): string {
  if (l.error) return "The live ledger couldn’t be loaded right now.";
  if (!l.loaded) return "Loading the live ledger…";
  const since = l.startedAt ? fmtAsOf(l.startedAt, { date: true }) : null;
  if (!since) return "The live track record starts with engine v0’s first call — none is on the ledger yet.";
  if (l.n < JUDGE_MIN) return `Live track record started ${since} · ${l.n} closed ${l.n === 1 ? "call" : "calls"} — too few to judge yet.`;
  return `Live track record since ${since} · ${l.n} closed calls.`;
}

export default function Landing() {
  useDocumentTitle("Tudumm · Every market. One verdict.");
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash) {
      window.scrollTo(0, 0);
      return;
    }
    const t = window.setTimeout(() => document.getElementById(hash.slice(1))?.scrollIntoView({ block: "start" }), 60);
    return () => window.clearTimeout(t);
  }, [hash]);
  return (
    <DataProvider>
      <div className="landing">
        <LandingNav />
        <main>
          <Hero />
          <Ticker />
          <FiveLayers />
          <Anatomy />
          <SitOuts />
          <ProofSection />
          <MarketsCovered />
          <Personas />
          <ExtensionSection />
          <Pricing />
        </main>
        <LandingFooter />
        <Toaster />
      </div>
    </DataProvider>
  );
}

/* ---------------- nav ---------------- */
function LandingNav() {
  const [open, setOpen] = useState(false);
  const links = [
    ["#layers", "Product"],
    ["#proof", "Proof"],
    ["#extension", "Extension"],
    ["#pricing", "Pricing"],
  ];
  return (
    <header className="lnav">
      <div className="lnav__in">
        <Link to="/" className="lnav__brand" aria-label="Tudumm home">
          <Wordmark height={28} />
        </Link>
        <nav className={`lnav__links ${open ? "is-open" : ""}`} aria-label="Primary">
          {links.map(([href, label]) => (
            <a key={href} href={href} onClick={() => setOpen(false)}>
              {label}
            </a>
          ))}
          <AuthLink mobile onNavigate={() => setOpen(false)} />
          <Link to="/app" className="btn btn--primary lnav__cta-m">
            Open the terminal
          </Link>
        </nav>
        <div className="lnav__right">
          <AuthLink />
          <Link to="/app" className="btn btn--primary lnav__cta">
            Open the terminal <ArrowRight size={15} aria-hidden="true" />
          </Link>
          <button type="button" className="btn btn--icon lnav__menu" aria-expanded={open} aria-label={open ? "Close menu" : "Open menu"} onClick={() => setOpen((o) => !o)}>
            {open ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
      </div>
    </header>
  );
}

/** Sign in (signed out, when any sign-in method is configured) or the account link (signed in). */
function AuthLink({ mobile = false, onNavigate }: { mobile?: boolean; onNavigate?: () => void }) {
  const session = useSession();
  const caps = useCaps();
  const canSignIn = caps.emailDelivery || caps.devCodes || caps.googleSignIn;
  if (session.status === "signed_in" && session.me) {
    const email = session.me.user.email ?? "";
    const initial = (session.me.user.displayName || email || "?").trim().charAt(0).toUpperCase();
    return (
      <Link to="/app/account" className={`lnav__acct ${mobile ? "lnav__auth-m" : "lnav__auth"}`} onClick={onNavigate} title={email ? `Signed in as ${email}` : "Your account"}>
        <span className="lnav__avatar mono" aria-hidden="true">
          {initial}
        </span>
        Account
      </Link>
    );
  }
  if (session.status !== "signed_out" || !canSignIn) return null;
  return (
    <button
      type="button"
      className={`btn btn--ghost ${mobile ? "lnav__auth-m" : "lnav__auth"}`}
      onClick={() => {
        onNavigate?.();
        openSignIn();
      }}
    >
      Sign in
    </button>
  );
}

/* ---------------- hero ---------------- */
function Hero() {
  const ledger = useLiveLedger();
  const data = useData();
  const { picks, trades } = useShowcase();
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const reduced = useReducedMotion();
  useEffect(() => {
    if (paused || picks.length < 2) return;
    const t = window.setInterval(() => setIdx((i) => (i + 1) % picks.length), reduced ? 9000 : 6000);
    return () => window.clearInterval(t);
  }, [paused, reduced, picks.length]);
  const inst = picks.length ? picks[idx % picks.length] : null;
  const few = ledger.n < JUDGE_MIN;
  return (
    <section className="hero">
      <div className="hero__bg" aria-hidden="true" />
      <div className="hero__in">
        <div className="hero__copy">
          <p className="eyebrow hero__eyebrow">
            <span className="hero__dot" aria-hidden="true" /> AI market intelligence · every market
          </p>
          <h1 className="hero__title serif">
            Every market.
            <br />
            <em>One verdict.</em>
            <span className="hero__title-2">Every call on the record.</span>
          </h1>
          <p className="hero__sub">
            Tudumm reads price, order flow, options, fundamentals and sentiment together, then tells you what to do, where you’d be
            wrong, and how much to risk.
          </p>
          <p className="hero__beta">
            <span className="hero__beta-tag mono">
              <i aria-hidden="true" /> LIVE · BETA
            </span>
            <span>{LIVE_BETA}</span>
          </p>
          <div className="hero__ctas">
            <Link to="/app" className="btn btn--primary btn--lg">
              Open the terminal <ArrowRight size={16} aria-hidden="true" />
            </Link>
            <a href="#extension" className="btn btn--lg btn--outline">
              <Puzzle size={16} aria-hidden="true" /> Add to Chrome
            </a>
          </div>
          <dl className="hero__proof mono">
            <div>
              <dt>Live closed calls</dt>
              <dd>{ledger.loaded ? ledger.n : "—"}</dd>
            </div>
            <div>
              <dt>Win rate</dt>
              <dd>{ledger.n ? fmtPct(ledger.winRate * 100, 1) : "—"}</dd>
            </div>
            <div>
              <dt>Avg R / call</dt>
              <dd className={ledger.n ? "c-brand" : "t3"}>{ledger.n ? signedR(ledger.avg) : "—"}</dd>
            </div>
          </dl>
          <p className="hero__fine">
            {trackRecordLine(ledger)}
            {ledger.loaded && few && ledger.n > 0 ? " Shown for transparency, not as evidence of an edge. " : " "}
            <Link to="/app/proof" className="u-link">
              Verify the ledger yourself
            </Link>
            . Probability, not promise.
          </p>
        </div>
        <div className="hero__stage" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
          <div className="hero__spot" aria-hidden="true" />
          {data.phase !== "ready" || !inst ? (
            <LiveUnavailable compact />
          ) : (
            <>
              {picks.length > 1 && (
                <div className="hero__tabs" role="tablist" aria-label="Live signal shown">
                  {picks.map((p, i) => (
                    <button key={p.symbol} type="button" role="tab" aria-selected={p.symbol === inst.symbol} className="hero__tab mono" onClick={() => setIdx(i)}>
                      {p.symbol}
                      <i className={p.symbol === inst.symbol && !paused && !reduced ? "is-run" : ""} key={`${p.symbol}-${idx}`} />
                    </button>
                  ))}
                </div>
              )}
              <SignalCard key={inst.symbol} inst={inst} revealDelay={60} variant="hero" />
              <p className="hero__caption mono">
                {trades ? "Live call · engine v0" : "Live sit-out · no call is open right now"}
                {picks.length > 1 ? ` · ${paused ? "paused" : "cycling"} · hover to hold` : ""}
              </p>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/* ---------------- ticker ---------------- */
function Ticker() {
  useDataset();
  const items = instruments;
  if (!items.length) return null;
  return (
    <div className="ticker" aria-label="Live prices across markets">
      <span className="ticker__lab mono" aria-hidden="true">
        LIVE
      </span>
      <div className="ticker__track">
        {[0, 1].map((k) => (
          <div className="ticker__set" key={k} aria-hidden={k === 1}>
            {items.map((i) => (
              <TickerItem key={`${k}-${i.symbol}`} inst={i} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
function TickerItem({ inst }: { inst: Instrument }) {
  const t = useTick(inst.symbol);
  const chg = inst.prevClose ? ((t.price - inst.prevClose) / inst.prevClose) * 100 : 0;
  return (
    <Link to={`/app/i/${inst.symbol}`} className="ticker__item mono" tabIndex={-1}>
      <b>{inst.symbol}</b>
      <span>{fmtPrice(inst, t.price, { currency: false })}</span>
      <span className={chg >= 0 ? "c-long" : "c-short"}>
        {chg >= 0 ? "▲" : "▼"} {fmtSignedPct(chg)}
      </span>
      <FreshnessBadge inst={inst} compact showProxy={false} />
    </Link>
  );
}

/* ---------------- five layers ---------------- */
function FiveLayers() {
  const data = useData();
  const { picks } = useShowcase();
  const rel = picks[0] ?? null;
  return (
    <section className="lsec" id="layers">
      <div className="lsec__in">
        <header className="lsec__head">
          <p className="eyebrow">01 · The engine</p>
          <h2 className="lsec__title serif">
            Five layers. <em>One verdict.</em>
          </h2>
          <p className="lsec__lede">
            Most tools show you one layer and leave the rest to you. Tudumm reads all five at once and only speaks when they line up.
            {rel ? ` Shown live on ${rel.name}.` : ""}
          </p>
        </header>
        {!rel ? (
          data.phase === "ready" ? null : <LiveUnavailable compact />
        ) : (
          <>
            <ol className="layers">
              {LAYER_ORDER.map((l, i) => {
                const v = rel.signal.layers[l];
                const tone = layerTone(v);
                const detail = rel.signal.layerDetail?.[l] ?? rel.signal.layerNotes?.[l] ?? (v === null ? "No data for this layer on this instrument yet." : null);
                return (
                  <li key={l} className="layer">
                    <span className="layer__n mono">0{i + 1}</span>
                    <h3 className="layer__name">{LAYER_LABEL[l]}</h3>
                    <p className="layer__q serif">{LAYER_QUESTION[l]}</p>
                    <div className="layer__viz">{detail && <p className="t2">{detail}</p>}</div>
                    <p className="layer__score mono">
                      {rel.symbol} <b>{v === null ? "N/A" : `${v > 0 ? "+" : v < 0 ? MINUS : ""}${Math.abs(v)}`}</b> <span>{tone.label.toLowerCase()}</span>
                    </p>
                  </li>
                );
              })}
            </ol>
            <div className="verdict-row">
              <span className="eyebrow">Verdict</span>
              <span className="mono verdict-row__sym">{rel.symbol}</span>
              {isTrade(rel.signal) ? (
                <>
                  <DirectionPill direction={rel.signal.direction} size="lg" />
                  <span className="mono verdict-row__conf">{Math.round(rel.signal.confidence * 100)}%</span>
                </>
              ) : (
                <span className="mono verdict-row__conf">{sitOutLabel(rel.signal.sitOutReason) ?? "Sitting out"}</span>
              )}
              <span className="t2 verdict-row__why serif">{rel.signal.thesis}</span>
              <Link to={`/app/i/${rel.symbol}`} className="btn verdict-row__cta">
                See the full call <ArrowRight size={14} aria-hidden="true" />
              </Link>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/* ---------------- anatomy ---------------- */
const CALLOUTS: { key: string; anchor: string; side: "l" | "r"; title: string; text: string }[] = [
  { key: "direction", anchor: "direction", side: "l", title: "Direction, in words", text: "▲ LONG or ▼ SHORT, never colour alone." },
  { key: "stop", anchor: "stop", side: "l", title: "Stop-loss · −1R", text: "Where the idea is wrong, stated before where it pays." },
  { key: "entry", anchor: "lv-entry", side: "l", title: "Entry zone", text: "A band, not a tick. Pending until price trades inside it." },
  { key: "why", anchor: "why", side: "l", title: "The why", text: "One or two plain-language lines from the analyst layer." },
  { key: "confidence", anchor: "confidence", side: "r", title: "Confidence", text: "Estimated probability of reaching T1 before the stop." },
  { key: "targets", anchor: "t2", side: "r", title: "Targets · T1 / T2", text: "In R multiples. At T1 the stop moves to breakeven." },
  { key: "confluence", anchor: "confluence", side: "r", title: "Confluence", text: "How many of five layers agree. Hatched = not applicable." },
  { key: "invalidation", anchor: "invalidation", side: "r", title: "Invalidated if", text: "The condition that cancels the call, even before the stop." },
];

function Anatomy() {
  const { picks, trades } = useShowcase();
  const inst = picks[0] ?? null;
  const wrap = useRef<HTMLDivElement>(null);
  const cardBox = useRef<HTMLDivElement>(null);
  const calloutRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [geo, setGeo] = useState<{
    w: number;
    h: number;
    pts: Record<string, { ax: number; ay: number; top: number; cx: number }>;
  } | null>(null);

  const measure = useCallback(() => {
    const root = wrap.current;
    const card = cardBox.current;
    if (!root || !card) return;
    const rb = root.getBoundingClientRect();
    const cb = card.getBoundingClientRect();
    const desktop = window.innerWidth >= 1100;
    const pts: Record<string, { ax: number; ay: number; top: number; cx: number }> = {};
    for (const side of ["l", "r"] as const) {
      const list = CALLOUTS.filter((c) => c.side === side)
        .map((c) => {
          const el = card.querySelector<HTMLElement>(`[data-anchor="${c.anchor}"]`);
          const b = el?.getBoundingClientRect();
          if (!b) return null;
          const narrow = b.width < 12;
          const ax = narrow ? b.left + b.width / 2 - rb.left : side === "l" ? b.left - rb.left : b.right - rb.left;
          const ay = b.top + Math.min(b.height / 2, 14) - rb.top;
          return { c, ax, ay };
        })
        .filter(Boolean) as { c: (typeof CALLOUTS)[number]; ax: number; ay: number }[];
      list.sort((a, b) => a.ay - b.ay);
      let floor = 0;
      for (const it of list) {
        const h = calloutRefs.current[it.c.key]?.offsetHeight ?? 60;
        const top = Math.max(it.ay - 18, floor);
        floor = top + h + 14;
        const cx = side === "l" ? cb.left - rb.left - 28 : cb.right - rb.left + 28;
        pts[it.c.key] = { ax: it.ax, ay: it.ay, top: desktop ? top : 0, cx };
      }
    }
    setGeo({ w: rb.width, h: rb.height, pts });
  }, []);
  const sym = inst?.symbol;

  useLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(() => measure());
    if (wrap.current) ro.observe(wrap.current);
    document.fonts?.ready.then(() => measure()).catch(() => undefined);
    const t = window.setTimeout(measure, 1800);
    return () => {
      ro.disconnect();
      window.clearTimeout(t);
    };
  }, [measure, sym]);

  return (
    <section className="lsec lsec--anatomy" id="anatomy">
      <div className="lsec__in">
        <header className="lsec__head lsec__head--center">
          <p className="eyebrow">02 · Anatomy of a signal</p>
          <h2 className="lsec__title serif">
            Everything you need to act. <em>Nothing you don’t.</em>
          </h2>
          {inst && !trades && <p className="lsec__lede">No call is open right now, so the card below is a live sit-out; the numbered parts appear on every open call.</p>}
        </header>
        {inst && (
        <div className="anat" ref={wrap}>
          <div className="anat__col anat__col--l">
            {CALLOUTS.filter((c) => c.side === "l").map((c) => (
              <Callout key={c.key} c={c} n={CALLOUTS.indexOf(c) + 1} top={geo?.pts[c.key]?.top} refCb={(el) => (calloutRefs.current[c.key] = el)} />
            ))}
          </div>
          <div className="anat__card" ref={cardBox}>
            <SignalCard inst={inst} variant="anatomy" linkTo={`/app/i/${inst.symbol}`} />
            {geo &&
              CALLOUTS.map((c) => {
                const p = geo.pts[c.key];
                if (!p) return null;
                const cb = cardBox.current?.getBoundingClientRect();
                const rb = wrap.current?.getBoundingClientRect();
                if (!cb || !rb) return null;
                return (
                  <span key={c.key} className="anat__marker mono" style={{ left: p.ax - (cb.left - rb.left), top: p.ay - (cb.top - rb.top) }} aria-hidden="true">
                    {CALLOUTS.indexOf(c) + 1}
                  </span>
                );
              })}
          </div>
          <div className="anat__col anat__col--r">
            {CALLOUTS.filter((c) => c.side === "r").map((c) => (
              <Callout key={c.key} c={c} n={CALLOUTS.indexOf(c) + 1} top={geo?.pts[c.key]?.top} refCb={(el) => (calloutRefs.current[c.key] = el)} />
            ))}
          </div>
          {geo && (
            <svg className="anat__lines" width={geo.w} height={geo.h} aria-hidden="true">
              {CALLOUTS.map((c) => {
                const p = geo.pts[c.key];
                if (!p) return null;
                const y0 = p.top + 18;
                const mid = c.side === "l" ? p.cx + 14 : p.cx - 14;
                return (
                  <g key={c.key}>
                    <polyline points={`${p.cx},${y0} ${mid},${y0} ${mid},${p.ay} ${p.ax},${p.ay}`} fill="none" stroke="rgba(245,184,65,0.55)" strokeWidth="1" />
                    <circle cx={p.ax} cy={p.ay} r="3" fill="#F5B841" />
                  </g>
                );
              })}
            </svg>
          )}
        </div>
        )}
      </div>
    </section>
  );
}

function Callout({
  c,
  n,
  top,
  refCb,
}: {
  c: (typeof CALLOUTS)[number];
  n: number;
  top?: number;
  refCb: (el: HTMLDivElement | null) => void;
}) {
  return (
    <div className="callout" ref={refCb} style={top !== undefined ? { top } : undefined}>
      <span className="callout__n mono">{String(n).padStart(2, "0")}</span>
      <p className="callout__t">{c.title}</p>
      <p className="callout__d">{c.text}</p>
    </div>
  );
}

/* ---------------- sit-outs ---------------- */
function SitOuts() {
  useDataset();
  const statuses = useStatuses();
  const n = Object.values(statuses).filter((s) => s === "sit_out").length;
  const shown = sitOutInstruments.slice(0, 6);
  return (
    <section className="lsec lsec--no" id="sit-out">
      <div className="lsec__in">
        <header className="lsec__head lsec__head--split">
          <div>
            <p className="eyebrow">03 · Restraint</p>
            <h2 className="lsec__title lsec__title--xl serif">
              We say <em>no.</em>
            </h2>
          </div>
          <div>
            <p className="lsec__lede">
              Most of the time the best trade is no trade. Tudumm tells you when to sit out, and why.
            </p>
            {instruments.length > 0 && (
              <p className="mono t3 lsec__count">
                Right now: {n} of {instruments.length} instruments sitting out.
                {sitOutInstruments.length > shown.length && (
                  <>
                    {" "}
                    <Link to="/app" className="u-link">
                      See them all
                    </Link>
                  </>
                )}
              </p>
            )}
          </div>
        </header>
        <div className="sit-grid">
          {shown.map((i, k) => (
            <SignalCard key={i.symbol} inst={i} revealDelay={k * 120} />
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------- proof ---------------- */
function ProofSection() {
  const l = useLiveLedger();
  const kpis: [string, string, string?][] = [
    ["Closed calls", l.loaded ? String(l.n) : "—"],
    ["Open calls", l.loaded ? String(l.open) : "—"],
    ["Win rate", l.n ? fmtPct(l.winRate * 100, 1) : "—"],
    ["Avg R / call", l.n ? signedR(l.avg) : "—", l.n ? (l.avg >= 0 ? "c-long" : "c-short") : "t3"],
    ["Total R", l.n ? signedR(l.total, 1) : "—", l.n ? (l.total >= 0 ? "c-long" : "c-short") : "t3"],
    ["Ledger entries", l.loaded ? String(l.entries) : "—"],
  ];
  return (
    <section className="lsec" id="proof">
      <div className="lsec__in">
        <header className="lsec__head lsec__head--split">
          <div>
            <p className="eyebrow">04 · Proof</p>
            <h2 className="lsec__title serif">
              Proof, <em>not promises.</em>
            </h2>
          </div>
          <div>
            <p className="lsec__lede">
              Every call is hashed onto a chained ledger when it’s issued, and its result is recorded when it closes, wins and losses
              alike. Change one number and the chain breaks at that row. You can check it in your browser.
            </p>
            <span className="chip chip--brand">Live ledger · engine v0</span>
          </div>
        </header>
        <div className="proof-band">
          <dl className="kpis mono">
            {kpis.map(([k, v, cls]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd className={cls}>{v}</dd>
              </div>
            ))}
          </dl>
          <div className="proof-band__chart">
            <p className="eyebrow">Live cumulative R · closed calls</p>
            {l.curve.length >= 2 ? <EquityCurve points={l.curve} height={260} /> : <p className="t2">{trackRecordLine(l)}</p>}
          </div>
          <div className="proof-band__foot">
            <p className="t2">
              {l.curve.length >= 2 ? `${trackRecordLine(l)} ` : ""}Stats are computed in your browser from the live ledger, not typed in. R = profit
              or loss in multiples of the risk taken.
            </p>
            <Link to="/app/proof" className="btn btn--primary">
              <ShieldCheck size={15} aria-hidden="true" /> Verify the chain yourself
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------------- markets ---------------- */
function MarketsCovered() {
  useDataset();
  const data = useData();
  return (
    <section className="lsec" id="markets">
      <div className="lsec__in">
        <header className="lsec__head">
          <p className="eyebrow">05 · Coverage</p>
          <h2 className="lsec__title serif">
            Any instrument. <em>Any market.</em>
          </h2>
          <p className="lsec__lede">Session status below is computed from the real clock in each exchange’s time zone.</p>
        </header>
        <div className="mkts">
          {MARKET_ORDER.map((m) => {
            const list = instrumentsIn(m);
            const waiting = data.unavailable.filter((u) => u.market === m);
            return (
              <article key={m} className="mkt">
                <header>
                  <h3 className="mkt__name serif">{MARKET_LABEL[m]}</h3>
                  <span className="mkt__n mono">{list.length ? `${list.length} live` : data.phase === "ready" ? "no data yet" : "—"}</span>
                </header>
                <SessionChip k={MARKET_SESSION[m]} />
                <p className="mkt__syms mono">
                  {list.map((i) => (
                    <Link key={i.symbol} to={`/app/i/${i.symbol}`}>
                      {i.symbol}
                    </Link>
                  ))}
                  {waiting.map((w) => (
                    <span key={w.symbol} className="t3" title={w.reason}>
                      {w.symbol}
                    </span>
                  ))}
                </p>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ---------------- personas ---------------- */
function Personas() {
  const navigate = useNavigate();
  const pick = (p: Persona) => {
    updateProfile({ persona: p });
    navigate("/app", { state: { fromPersona: true } });
    toast(`Feed tuned for ${PERSONAS.find((x) => x.id === p)!.label.toLowerCase()}s`);
  };
  return (
    <section className="lsec" id="personas">
      <div className="lsec__in">
        <header className="lsec__head">
          <p className="eyebrow">06 · Your style</p>
          <h2 className="lsec__title serif">
            Built for how <em>you</em> trade.
          </h2>
          <p className="lsec__lede">Pick one and the terminal opens with your filters, horizon and lead evidence already set.</p>
        </header>
        <div className="personas">
          {PERSONAS.map((p, i) => (
            <button key={p.id} type="button" className="persona" onClick={() => pick(p.id)}>
              <span className="persona__n mono">0{i + 1}</span>
              <span className="persona__t serif">{p.label}</span>
              <span className="persona__d">{p.blurb}</span>
              <span className="persona__go mono">
                Open my terminal <ArrowRight size={13} aria-hidden="true" />
              </span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------- extension ---------------- */
function ExtensionSection() {
  const { picks } = useShowcase();
  const rel = picks[0] ?? null;
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/__tudumm/ext-status", { cache: "no-store" })
      .then((r) => (r.ok && (r.headers.get("content-type") ?? "").includes("json") ? r.json() : null))
      .then((j: { preview?: boolean; path?: string } | null) => {
        if (alive && j?.preview && j.path) setPreview(j.path);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const copy = (text: string) => {
    const done = () => toast(`Copied ${text}`);
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => toast("Copy blocked: select the text instead"));
    else toast("Copy isn’t available here: select the text instead");
  };
  return (
    <section className="lsec lsec--ext" id="extension">
      <div className="lsec__in">
        <header className="lsec__head lsec__head--split">
          <div>
            <p className="eyebrow">07 · Chrome extension</p>
            <h2 className="lsec__title serif">
              The verdict, <em>on the chart you already use.</em>
            </h2>
          </div>
          <p className="lsec__lede">
            TradingView, Yahoo Finance, Google Finance, Kite, NSE and Binance: Tudumm spots the symbol and pins the call to the corner of
            the page. One click opens the full card in a side panel.
          </p>
        </header>
        <div className="ext">
          {rel ? (
            <>
              <BrowserMock inst={rel} />
              <div className="ext__popup" aria-label="Extension popup preview">
                <div className="ext__popup-head">
                  <LogoMark size={18} />
                  <span className="serif">tudumm</span>
                  <EngineTag />
                </div>
                <p className="eyebrow ext__popup-lab">On this page</p>
                <SignalCard inst={rel} linkTo={`/app/i/${rel.symbol}`} />
              </div>
            </>
          ) : (
            <LiveUnavailable compact />
          )}
        </div>
        <div className="install">
          <div className="install__head">
            <h3 className="serif">Install the developer build</h3>
            <p className="t2">The Chrome Web Store listing doesn’t exist yet. Load the prototype straight from this repo in under a minute.</p>
          </div>
          <ol className="install__steps">
            <li>
              <span className="mono install__n">1</span>
              <div>
                Open <code className="mono">chrome://extensions</code> in Chrome (paste it into the address bar).
                <button type="button" className="btn btn--sm install__copy" onClick={() => copy("chrome://extensions")}>
                  <Copy size={13} aria-hidden="true" /> Copy
                </button>
              </div>
            </li>
            <li>
              <span className="mono install__n">2</span>
              <div>
                Switch on <b>Developer mode</b> (top-right toggle).
              </div>
            </li>
            <li>
              <span className="mono install__n">3</span>
              <div>
                Click <b>Load unpacked</b>.
              </div>
            </li>
            <li>
              <span className="mono install__n">4</span>
              <div>
                Select the <code className="mono">Tudumm-AI-engine/extension</code> folder. Pin the two-beat icon, then open any supported
                chart page.
                <button type="button" className="btn btn--sm install__copy" onClick={() => copy("Tudumm-AI-engine/extension")}>
                  <Copy size={13} aria-hidden="true" /> Copy path
                </button>
              </div>
            </li>
          </ol>
          {preview && (
            <a className="btn install__preview" href={preview} target="_blank" rel="noreferrer" onClick={() => track("extension_preview", { from: "landing" })}>
              <Puzzle size={15} aria-hidden="true" /> Open the extension preview (no install)
            </a>
          )}
        </div>
      </div>
    </section>
  );
}

function BrowserMock({ inst }: { inst: Instrument }) {
  const q = useApi<CandlesRes>(`landing:candles:${inst.symbol}:1D`, () => marketApi.candles(inst.symbol, "1D", 56), { staleMs: 300_000 });
  const bars = (q.data?.bars ?? []).slice(-56);
  const s = inst.signal;
  const trade = isTrade(s) ? s : null;
  const t = useTick(inst.symbol);
  const lo = Math.min(...bars.map((c) => c.l), ...(trade ? [trade.stop, trade.target2] : []));
  const hi = Math.max(...bars.map((c) => c.h), ...(trade ? [trade.stop, trade.target2] : []));
  const W = 560;
  const H = 230;
  const y = (v: number) => 10 + (1 - (v - lo) / (hi - lo || 1)) * (H - 20);
  const bw = W / Math.max(1, bars.length);
  const exch = (inst.exchange || inst.market).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return (
    <figure className="bmock" aria-label="Preview of the Tudumm chip on a chart site">
      <div className="bmock__bar">
        <span className="bmock__dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="bmock__url mono">tradingview.com/chart/?symbol={exch}%3A{inst.symbol}</span>
        <span className="bmock__ext" aria-hidden="true">
          <LogoMark size={16} tile />
        </span>
      </div>
      <div className="bmock__page">
        <div className="bmock__sym mono">
          <b>{inst.symbol}</b> {inst.exchange} · 1D · <span>{fmtPrice(inst, t.price, { currency: false })}</span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} className="bmock__chart" preserveAspectRatio="none" aria-hidden="true">
          {bars.map((c, i) => {
            const up = c.c >= c.o;
            const x = i * bw + bw / 2;
            return (
              <g key={c.t} stroke={up ? "#3DD68C" : "#FF5C4D"} fill={up ? "#3DD68C" : "#FF5C4D"} opacity="0.85">
                <line x1={x} x2={x} y1={y(c.h)} y2={y(c.l)} strokeWidth="1" />
                <rect x={x - bw * 0.3} width={bw * 0.6} y={y(Math.max(c.o, c.c))} height={Math.max(1, Math.abs(y(c.o) - y(c.c)))} />
              </g>
            );
          })}
          {trade && bars.length > 0 && (
            <>
              <line x1="0" x2={W} y1={y(trade.stop)} y2={y(trade.stop)} stroke="#FF5C4D" strokeDasharray="4 4" opacity="0.6" />
              <line x1="0" x2={W} y1={y(trade.target2)} y2={y(trade.target2)} stroke="#3DD68C" strokeDasharray="4 4" opacity="0.6" />
            </>
          )}
        </svg>
        <div className="xchip" role="img" aria-label={`Tudumm chip: ${inst.symbol} ${trade ? `${trade.direction} ${Math.round(trade.confidence * 100)}%` : "sitting out"}`}>
          <LogoMark size={16} />
          <b className="mono">{inst.symbol}</b>
          {trade ? (
            <span className={`mono ${trade.direction === "LONG" ? "c-long" : "c-short"}`}>
              {trade.direction === "LONG" ? "▲" : "▼"} {trade.direction} {Math.round(trade.confidence * 100)}%
            </span>
          ) : (
            <span className="mono c-neutral">SITTING OUT</span>
          )}
        </div>
      </div>
      <figcaption className="mono t3">
        Preview of the chip on a chart site · {bars.length ? `${bars.length} real daily bars${q.data?.source ? ` · ${q.data.source}` : ""}` : q.error ? "chart data unavailable" : "loading bars…"}
      </figcaption>
    </figure>
  );
}

/* ---------------- pricing ---------------- */
const PLAN_LEAD: Record<PlanDef["id"], string> = {
  free: "Watch the engine work.",
  pro: "Every call, every market.",
  elite: "For desks and systematic traders.",
};
function fmtUsd(cents: number): string {
  const v = cents / 100;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}
function fmtInr(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

type GateNote = { plan: PlanDef["id"]; kind: "early" | "error"; text?: string };

function Pricing() {
  const plans = usePlans();
  const caps = useCaps();
  const session = useSession();
  const ref = useRef<HTMLElement>(null);
  const [note, setNote] = useState<GateNote | null>(null);
  const [busy, setBusy] = useState<PlanDef["id"] | null>(null);
  const signedIn = session.status === "signed_in" && !!session.me;
  const current = signedIn ? (session.me?.plan?.id ?? session.me?.user.plan ?? "free") : null;
  const canSignIn = caps.emailDelivery || caps.devCodes || caps.googleSignIn;

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    let seen = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (seen || !entries.some((e) => e.isIntersecting)) return;
        seen = true;
        track("plan_view", { from: "landing" });
        io.disconnect();
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const upgrade = async (plan: "pro" | "elite") => {
    track("upgrade_click", { plan, signedIn });
    setNote(null);
    if (!signedIn) {
      if (canSignIn) openSignIn("Sign in to upgrade your plan");
      else setNote({ plan, kind: "early" });
      return;
    }
    setBusy(plan);
    try {
      const b = await billingApi.get();
      if (b.enabled && b.providers.includes("stripe")) {
        const r = await billingApi.checkout(plan, "stripe");
        if (r.url) {
          window.location.href = r.url;
          return;
        }
      }
      // Billing off, or Razorpay-only (its checkout script isn't allowed by the CSP yet).
      setNote({ plan, kind: "early" });
    } catch (err) {
      setNote({ plan, kind: "error", text: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="lsec" id="pricing" ref={ref}>
      <div className="lsec__in">
        <header className="lsec__head">
          <p className="eyebrow">08 · Pricing</p>
          <h2 className="lsec__title serif">
            Pay for edge, <em>not for hope.</em>
          </h2>
          <p className="lsec__lede">Prices in USD, with rupee pricing for India. Every account starts on Free.</p>
        </header>
        <div className="plans">
          {plans.map((p) => {
            const featured = p.id === "pro";
            const isCurrent = current === p.id;
            const gate = note?.plan === p.id ? note : null;
            return (
              <article key={p.id} className={`plan ${featured ? "is-featured" : ""}`}>
                <header>
                  <h3 className="plan__name mono">{p.name}</h3>
                  {isCurrent ? <span className="chip">Your plan</span> : featured ? <span className="chip chip--brand">Most traders</span> : null}
                </header>
                <p className="plan__price">
                  <span className="serif">{fmtUsd(p.priceUsdCents)}</span> <span className="t3">{p.priceUsdCents ? "per month" : "forever"}</span>
                  {p.priceInrPaise > 0 && <span className="plan__inr mono">{fmtInr(p.priceInrPaise)} / month in India</span>}
                </p>
                <p className="plan__lead serif">{PLAN_LEAD[p.id] ?? ""}</p>
                <ul className="plan__list">
                  {p.features.map((it) => (
                    <li key={it}>
                      <Check size={14} aria-hidden="true" /> {it}
                    </li>
                  ))}
                </ul>
                <div className="plan__foot">
                  {p.id === "free" ? (
                    <Link to="/app" className="btn plan__cta">
                      Open the terminal
                    </Link>
                  ) : isCurrent ? (
                    <Link to="/app/account" className="btn plan__cta">
                      Manage in Account
                    </Link>
                  ) : (
                    <button
                      type="button"
                      className={`btn ${featured ? "btn--primary" : ""} plan__cta`}
                      disabled={busy !== null}
                      onClick={() => void upgrade(p.id as "pro" | "elite")}
                    >
                      {busy === p.id ? "Checking billing…" : `Upgrade to ${p.name}`}
                    </button>
                  )}
                  <div className="plan__gate-slot" aria-live="polite">
                    {gate?.kind === "early" && (
                      <p className="plan__gate">
                        Billing isn’t live yet — you’re on the free plan;{" "}
                        <Link to="/app/support" className="u-link">
                          ask us for early access
                        </Link>
                        .
                      </p>
                    )}
                    {gate?.kind === "error" && <p className="plan__gate plan__gate--err">{gate.text}</p>}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
        <p className="plans__note mono t3">
          {caps.payments ? "Payments are processed by our billing provider; your plan changes when the payment is confirmed." : "Billing isn’t live yet during the beta. Upgrading asks for early access instead of charging you."}
        </p>
      </div>
    </section>
  );
}

/* ---------------- footer ---------------- */
function LandingFooter() {
  return (
    <footer className="lfoot">
      <div className="lfoot__in">
        <div className="lfoot__brand">
          <Wordmark height={34} />
          <p className="serif lfoot__vision">The world’s most trusted decision engine for traders and investors.</p>
        </div>
        <nav className="lfoot__nav" aria-label="Footer">
          <div>
            <p className="eyebrow">Terminal</p>
            <Link to="/app">Signals</Link>
            <Link to="/app/markets">Markets</Link>
            <Link to="/app/proof">Proof & ledger</Link>
            <Link to="/app/profile">Profile</Link>
          </div>
          <div>
            <p className="eyebrow">On this page</p>
            <a href="#layers">Five layers</a>
            <a href="#sit-out">Sit-outs</a>
            <a href="#extension">Extension</a>
            <a href="#pricing">Pricing</a>
          </div>
          <div>
            <p className="eyebrow">Legal & help</p>
            <LegalLinks />
          </div>
        </nav>
        <div className="lfoot__legal">
          <p className="disclaimer">{BETA_DISCLAIMER}</p>
          <p className="disclaimer">
            {LIVE_BETA} Engine v0 is rule-based and uncalibrated.
          </p>
          <p className="disclaimer">At launch, Tudumm will register where required (e.g., as a SEBI Research Analyst in India).</p>
          <p className="disclaimer">
            Charts by{" "}
            <a className="u-link" href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
              TradingView Lightweight Charts™
            </a>
            . © 2026 Tudumm · beta v0.2
          </p>
        </div>
      </div>
    </footer>
  );
}
