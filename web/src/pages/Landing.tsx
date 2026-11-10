import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowRight, Check, Copy, Menu, Puzzle, ShieldCheck, X } from "lucide-react";
import { LogoMark, Wordmark } from "../components/Logo";
import { SignalCard } from "../components/SignalCard";
import { DirectionPill } from "../components/signal";
import { EquityCurve, Sparkline } from "../components/charts";
import { DISCLAIMER, SessionChip, Toaster, toast } from "../components/ui";
import { useDocumentTitle, useReducedMotion } from "../components/hooks";
import { getInstrument, instruments, instrumentsIn, MARKET_LABEL, MARKET_ORDER, sitOutInstruments, ledger, LAYER_ORDER, LAYER_LABEL } from "../engine/seed";
import type { Instrument, LayerId, TradeSignal } from "../engine/types";
import { useTick, useStatuses } from "../engine/live";
import { fmtPrice, fmtSignedPct, fmtPct, MINUS } from "../engine/format";
import { computeStats, equityCurve } from "../engine/ledger";
import { MARKET_SESSION } from "../engine/sessions";
import { PERSONAS, updateProfile, type Persona } from "../engine/profile";
import { orderBook } from "../engine/orderflow";
import { optionChain } from "../engine/derivatives";
import { fundamentals } from "../engine/fundamentals";
import { headlines } from "../engine/context";
import { LAYER_QUESTION } from "../engine/evidence";
import { genCandles } from "../engine/candles";

const HERO_CYCLE = ["NIFTY", "BTCUSDT", "NVDA"];

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
          <Link to="/app" className="btn btn--primary lnav__cta-m">
            Open the terminal
          </Link>
        </nav>
        <div className="lnav__right">
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

/* ---------------- hero ---------------- */
function Hero() {
  const stats = useMemo(() => computeStats(ledger), []);
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const reduced = useReducedMotion();
  useEffect(() => {
    if (paused) return;
    const t = window.setInterval(() => setIdx((i) => (i + 1) % HERO_CYCLE.length), reduced ? 9000 : 6000);
    return () => window.clearInterval(t);
  }, [paused, reduced]);
  const inst = getInstrument(HERO_CYCLE[idx])!;
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
              <dt>Calls on the ledger</dt>
              <dd>{stats.count}</dd>
            </div>
            <div>
              <dt>Win rate</dt>
              <dd>{fmtPct(stats.winRate * 100, 1)}</dd>
            </div>
            <div>
              <dt>Expectancy</dt>
              <dd className="c-brand">
                {stats.expectancy >= 0 ? "+" : MINUS}
                {Math.abs(stats.expectancy).toFixed(2)}R
              </dd>
            </div>
          </dl>
          <p className="hero__fine">Simulated demo ledger, computed live from every closed call. Probability, not promise.</p>
        </div>
        <div className="hero__stage" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
          <div className="hero__spot" aria-hidden="true" />
          <div className="hero__tabs" role="tablist" aria-label="Live signal shown">
            {HERO_CYCLE.map((s, i) => (
              <button key={s} type="button" role="tab" aria-selected={i === idx} className="hero__tab mono" onClick={() => setIdx(i)}>
                {s}
                <i className={i === idx && !paused && !reduced ? "is-run" : ""} key={`${s}-${idx}`} />
              </button>
            ))}
          </div>
          <SignalCard key={inst.symbol} inst={inst} revealDelay={60} variant="hero" />
          <p className="hero__caption mono">
            Live demo signal · {paused ? "paused" : "next reveal in a few seconds"} · hover to hold
          </p>
        </div>
      </div>
    </section>
  );
}

/* ---------------- ticker ---------------- */
function Ticker() {
  const items = instruments;
  return (
    <div className="ticker" aria-label="Live demo prices across markets">
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
  const chg = ((t.price - inst.prevClose) / inst.prevClose) * 100;
  return (
    <Link to={`/app/i/${inst.symbol}`} className="ticker__item mono" tabIndex={-1}>
      <b>{inst.symbol}</b>
      <span>{fmtPrice(inst, t.price, { currency: false })}</span>
      <span className={chg >= 0 ? "c-long" : "c-short"}>
        {chg >= 0 ? "▲" : "▼"} {fmtSignedPct(chg)}
      </span>
    </Link>
  );
}

/* ---------------- five layers ---------------- */
function FiveLayers() {
  const rel = getInstrument("RELIANCE")!;
  const s = rel.signal as TradeSignal;
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
            Shown live on {rel.name}.
          </p>
        </header>
        <ol className="layers">
          {LAYER_ORDER.map((l, i) => (
            <li key={l} className="layer">
              <span className="layer__n mono">0{i + 1}</span>
              <h3 className="layer__name">{LAYER_LABEL[l]}</h3>
              <p className="layer__q serif">{LAYER_QUESTION[l]}</p>
              <div className="layer__viz">
                <LayerViz layer={l} inst={rel} />
              </div>
              <p className="layer__score mono">
                {rel.symbol} <b>{(s.layers[l] ?? 0) > 0 ? "+" : ""}{s.layers[l]}</b> <span>agrees</span>
              </p>
            </li>
          ))}
        </ol>
        <div className="verdict-row">
          <span className="eyebrow">Verdict</span>
          <span className="mono verdict-row__sym">{rel.symbol}</span>
          <DirectionPill direction={s.direction} size="lg" />
          <span className="mono verdict-row__conf">{Math.round(s.confidence * 100)}%</span>
          <span className="t2 verdict-row__why serif">{s.thesis}</span>
          <Link to="/app/i/RELIANCE" className="btn verdict-row__cta">
            See the full call <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}

function LayerViz({ layer, inst }: { layer: LayerId; inst: Instrument }) {
  const t = useTick(inst.symbol);
  if (layer === "price") return <Sparkline values={t.history} width={180} height={56} color="var(--long)" label={`${inst.symbol} live price`} />;
  if (layer === "flow") {
    const b = orderBook(inst, t.price, t.seq);
    const max = Math.max(...b.bids.slice(0, 6).map((x) => x.size), ...b.asks.slice(0, 6).map((x) => x.size));
    return (
      <div className="mini-depth" aria-label={`Order book ${Math.round(b.bidShare * 100)}% bids`}>
        {b.bids.slice(0, 6).map((x, i) => (
          <div key={i} className="mini-depth__row">
            <i className="is-bid" style={{ width: `${(x.size / max) * 100}%` }} />
            <i className="is-ask" style={{ width: `${(b.asks[i].size / max) * 100}%` }} />
          </div>
        ))}
        <p className="mono">
          <span className="c-long">{Math.round(b.bidShare * 100)}% bids</span>
        </p>
      </div>
    );
  }
  if (layer === "derivatives") return <MiniOI />;
  if (layer === "fundamentals") {
    const f = fundamentals(inst);
    if (f.kind !== "equity") return null;
    return (
      <table className="mini-fund mono">
        <tbody>
          <tr>
            <td>P/E</td>
            <td>{f.pe.toFixed(1)}</td>
          </tr>
          <tr>
            <td>ROE</td>
            <td>{f.roe.toFixed(1)}%</td>
          </tr>
          <tr>
            <td>Rev YoY</td>
            <td className="c-long">+{f.revGrowth.toFixed(1)}%</td>
          </tr>
        </tbody>
      </table>
    );
  }
  const h = headlines(inst)[0];
  return (
    <div className="mini-news">
      <span className={`sent sent--${h.sentiment}`}>▲ {h.sentiment}</span>
      <p>{h.text}</p>
      <span className="mono t3">simulated wire</span>
    </div>
  );
}

function MiniOI() {
  const nifty = getInstrument("NIFTY")!;
  const ch = useMemo(() => optionChain(nifty, nifty.price), [nifty]);
  const rows = ch.rows.slice(3, 10);
  const max = Math.max(...rows.map((r) => Math.max(r.callOI, r.putOI)));
  return (
    <div className="mini-oi" aria-label={`NIFTY option OI around ATM, PCR ${ch.pcr.toFixed(2)}`}>
      {rows.map((r) => (
        <div key={r.strike} className={`mini-oi__row ${r.strike === ch.atm ? "is-atm" : ""}`}>
          <i className="is-call" style={{ width: `${(r.callOI / max) * 100}%` }} />
          <span className="mono">{r.strike.toLocaleString("en-IN")}</span>
          <i className="is-put" style={{ width: `${(r.putOI / max) * 100}%` }} />
        </div>
      ))}
      <p className="mono">
        NIFTY PCR <b>{ch.pcr.toFixed(2)}</b>
      </p>
    </div>
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
  const inst = getInstrument("NIFTY")!;
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
  }, [measure]);

  return (
    <section className="lsec lsec--anatomy" id="anatomy">
      <div className="lsec__in">
        <header className="lsec__head lsec__head--center">
          <p className="eyebrow">02 · Anatomy of a signal</p>
          <h2 className="lsec__title serif">
            Everything you need to act. <em>Nothing you don’t.</em>
          </h2>
        </header>
        <div className="anat" ref={wrap}>
          <div className="anat__col anat__col--l">
            {CALLOUTS.filter((c) => c.side === "l").map((c) => (
              <Callout key={c.key} c={c} n={CALLOUTS.indexOf(c) + 1} top={geo?.pts[c.key]?.top} refCb={(el) => (calloutRefs.current[c.key] = el)} />
            ))}
          </div>
          <div className="anat__card" ref={cardBox}>
            <SignalCard inst={inst} variant="anatomy" linkTo="/app/i/NIFTY" />
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
  const statuses = useStatuses();
  const n = Object.values(statuses).filter((s) => s === "sit_out").length;
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
            <p className="mono t3 lsec__count">
              Right now: {n} of {instruments.length} instruments sitting out.
            </p>
          </div>
        </header>
        <div className="sit-grid">
          {sitOutInstruments.map((i, k) => (
            <SignalCard key={i.symbol} inst={i} revealDelay={k * 120} />
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------- proof ---------------- */
function ProofSection() {
  const stats = useMemo(() => computeStats(ledger), []);
  const curve = useMemo(() => equityCurve(ledger), []);
  const kpis: [string, string, string?][] = [
    ["Closed calls", String(stats.count)],
    ["Win rate", fmtPct(stats.winRate * 100, 1)],
    ["Avg win", `+${stats.avgWin.toFixed(2)}R`, "c-long"],
    ["Avg loss", `${MINUS}${Math.abs(stats.avgLoss).toFixed(2)}R`, "c-short"],
    ["Expectancy", `${stats.expectancy >= 0 ? "+" : MINUS}${Math.abs(stats.expectancy).toFixed(2)}R`, "c-brand"],
    ["Profit factor", stats.profitFactor.toFixed(2)],
    ["Max drawdown", `${MINUS}${Math.abs(stats.maxDrawdown).toFixed(1)}R`, "c-short"],
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
            <span className="chip chip--brand">Simulated demo ledger</span>
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
            <p className="eyebrow">Cumulative R · Jan 2025 → Nov 2026</p>
            <EquityCurve points={curve} height={260} />
          </div>
          <div className="proof-band__foot">
            <p className="t2">
              Stats are computed from the ledger on page load, not typed in. R = profit or loss in multiples of the risk taken.
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
            return (
              <article key={m} className="mkt">
                <header>
                  <h3 className="mkt__name serif">{MARKET_LABEL[m]}</h3>
                  <span className="mkt__n mono">{list.length} instruments</span>
                </header>
                <SessionChip k={MARKET_SESSION[m]} />
                <p className="mkt__syms mono">
                  {list.map((i) => (
                    <Link key={i.symbol} to={`/app/i/${i.symbol}`}>
                      {i.symbol}
                    </Link>
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
  const rel = getInstrument("RELIANCE")!;
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
          <BrowserMock inst={rel} />
          <div className="ext__popup" aria-label="Extension popup preview">
            <div className="ext__popup-head">
              <LogoMark size={18} />
              <span className="serif">tudumm</span>
              <span className="demo-badge">DEMO</span>
            </div>
            <p className="eyebrow ext__popup-lab">On this page</p>
            <SignalCard inst={rel} linkTo="/app/i/RELIANCE" />
          </div>
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
            <a className="btn install__preview" href={preview} target="_blank" rel="noreferrer">
              <Puzzle size={15} aria-hidden="true" /> Open the extension preview (no install)
            </a>
          )}
        </div>
      </div>
    </section>
  );
}

function BrowserMock({ inst }: { inst: Instrument }) {
  const candles = useMemo(() => genCandles(inst, "1D", inst.price, 64).slice(-56), [inst]);
  const s = inst.signal as TradeSignal;
  const t = useTick(inst.symbol);
  const lo = Math.min(...candles.map((c) => c.low), s.stop);
  const hi = Math.max(...candles.map((c) => c.high), s.target2);
  const W = 560;
  const H = 230;
  const y = (v: number) => 10 + (1 - (v - lo) / (hi - lo)) * (H - 20);
  const bw = W / candles.length;
  return (
    <figure className="bmock" aria-label="Browser showing a chart page with the Tudumm chip">
      <div className="bmock__bar">
        <span className="bmock__dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="bmock__url mono">tradingview.com/chart/?symbol=NSE%3ARELIANCE</span>
        <span className="bmock__ext" aria-hidden="true">
          <LogoMark size={16} tile />
        </span>
      </div>
      <div className="bmock__page">
        <div className="bmock__sym mono">
          <b>RELIANCE</b> NSE · 1D · <span>{fmtPrice(inst, t.price, { currency: false })}</span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} className="bmock__chart" preserveAspectRatio="none" aria-hidden="true">
          {candles.map((c, i) => {
            const up = c.close >= c.open;
            const x = i * bw + bw / 2;
            return (
              <g key={i} stroke={up ? "#3DD68C" : "#FF5C4D"} fill={up ? "#3DD68C" : "#FF5C4D"} opacity="0.85">
                <line x1={x} x2={x} y1={y(c.high)} y2={y(c.low)} strokeWidth="1" />
                <rect x={x - bw * 0.3} width={bw * 0.6} y={y(Math.max(c.open, c.close))} height={Math.max(1, Math.abs(y(c.open) - y(c.close)))} />
              </g>
            );
          })}
          <line x1="0" x2={W} y1={y(s.stop)} y2={y(s.stop)} stroke="#FF5C4D" strokeDasharray="4 4" opacity="0.6" />
          <line x1="0" x2={W} y1={y(s.target2)} y2={y(s.target2)} stroke="#3DD68C" strokeDasharray="4 4" opacity="0.6" />
        </svg>
        <div className="xchip" role="img" aria-label={`Tudumm chip: ${inst.symbol} ${s.direction} ${Math.round(s.confidence * 100)}%`}>
          <LogoMark size={16} />
          <b className="mono">{inst.symbol}</b>
          <span className={`mono ${s.direction === "LONG" ? "c-long" : "c-short"}`}>
            {s.direction === "LONG" ? "▲" : "▼"} {s.direction} {Math.round(s.confidence * 100)}%
          </span>
        </div>
      </div>
    </figure>
  );
}

/* ---------------- pricing ---------------- */
const PLANS = [
  {
    name: "Free",
    price: "$0",
    per: "forever",
    lead: "Watch the engine work.",
    items: ["Every sit-out, with the reason", "3 live calls a day, one market", "The public ledger and chain check", "Extension chip on supported sites"],
  },
  {
    name: "Pro",
    price: "$24",
    per: "per month",
    lead: "Every call, every market.",
    items: ["All live calls across all six markets", "Full five-layer evidence and position sizer", "Extension side panel and watchlist", "Reveal alerts (at launch)"],
    featured: true,
  },
  {
    name: "Elite",
    price: "$69",
    per: "per month",
    lead: "For desks and systematic traders.",
    items: ["Everything in Pro", "Raw layer scores and history export", "API and webhooks (at launch)", "Early access to new instruments"],
  },
];
function Pricing() {
  return (
    <section className="lsec" id="pricing">
      <div className="lsec__in">
        <header className="lsec__head">
          <p className="eyebrow">08 · Pricing</p>
          <h2 className="lsec__title serif">
            Pay for edge, <em>not for hope.</em>
          </h2>
          <p className="lsec__lede">Prices in USD. Local pricing (₹, €) at launch.</p>
        </header>
        <div className="plans">
          {PLANS.map((p) => (
            <article key={p.name} className={`plan ${p.featured ? "is-featured" : ""}`}>
              <header>
                <h3 className="plan__name mono">{p.name}</h3>
                {p.featured && <span className="chip chip--brand">Most traders</span>}
              </header>
              <p className="plan__price">
                <span className="serif">{p.price}</span> <span className="t3">{p.per}</span>
              </p>
              <p className="plan__lead serif">{p.lead}</p>
              <ul className="plan__list">
                {p.items.map((it) => (
                  <li key={it}>
                    <Check size={14} aria-hidden="true" /> {it}
                  </li>
                ))}
              </ul>
              <Link to="/app" className={`btn ${p.featured ? "btn--primary" : ""} plan__cta`}>
                Try the terminal
              </Link>
            </article>
          ))}
        </div>
        <p className="plans__note mono t3">Billing isn’t live in the prototype. Every plan opens the same demo terminal.</p>
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
        </nav>
        <div className="lfoot__legal">
          <p className="disclaimer">{DISCLAIMER}</p>
          <p className="disclaimer">At launch, Tudumm will register where required (e.g., as a SEBI Research Analyst in India).</p>
          <p className="disclaimer">
            Charts by{" "}
            <a className="u-link" href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
              TradingView Lightweight Charts™
            </a>
            . © 2026 Tudumm · prototype v0.1
          </p>
        </div>
      </div>
    </footer>
  );
}
