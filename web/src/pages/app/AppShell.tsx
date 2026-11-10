import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Activity, ArrowUpRight, Globe2, Search, ShieldCheck, Star, UserRound } from "lucide-react";
import { LogoMark, Wordmark } from "../../components/Logo";
import { CommandPalette } from "../../components/CommandPalette";
import { Onboarding } from "../../components/Onboarding";
import { DemoBadge, Disclaimer, SessionChip, Toaster } from "../../components/ui";
import { PERSONA_BY_ID, useProfile, useStore, watchlistStore } from "../../engine/profile";
import { getInstrument } from "../../engine/seed";
import { useTick } from "../../engine/live";
import { fmtPrice, fmtSignedPct } from "../../engine/format";

const NAV = [
  { to: "/app", label: "Signals", icon: Activity, end: true },
  { to: "/app/markets", label: "Markets", icon: Globe2, end: false },
  { to: "/app/proof", label: "Proof", icon: ShieldCheck, end: false },
  { to: "/app/profile", label: "Profile", icon: UserRound, end: false },
];

export function AppShell() {
  const profile = useProfile();
  const [cmdOpen, setCmdOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const fromPersona = (location.state as { fromPersona?: boolean } | null)?.fromPersona === true;
  const showOnboarding = !profile.onboarded;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <div className="shell">
      <aside className="side" aria-label="Terminal navigation">
        <Link to="/" className="side__brand" aria-label="Tudumm home">
          <span className="side__word">
            <Wordmark height={26} />
          </span>
          <span className="side__mark">
            <LogoMark size={26} />
          </span>
        </Link>
        <nav className="side__nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className="side__item" title={n.label}>
              <n.icon size={17} aria-hidden="true" />
              <span>{n.label}</span>
            </NavLink>
          ))}
        </nav>
        <Watchlist />
        <div className="side__foot">
          <Link to="/" className="side__item side__item--quiet" title="Back to tudumm.com">
            <ArrowUpRight size={16} aria-hidden="true" />
            <span>Back to site</span>
          </Link>
          <p className="side__ver mono">v0.1 · prototype</p>
        </div>
      </aside>

      <div className="shell__main">
        <header className="top">
          <Link to="/" className="top__mark" aria-label="Tudumm home">
            <LogoMark size={24} />
          </Link>
          <button type="button" className="top__search" onClick={() => setCmdOpen(true)} aria-label="Search instruments">
            <Search size={15} aria-hidden="true" />
            <span className="top__search-text">Search symbols, names, aliases…</span>
            <kbd className="kbd">{isMac ? "⌘K" : "Ctrl K"}</kbd>
          </button>
          <div className="top__clocks" aria-label="Market sessions">
            <SessionChip k="NSE" />
            <SessionChip k="NYSE" />
            <SessionChip k="CRYPTO" />
          </div>
          <div className="top__right">
            <DemoBadge />
            <button type="button" className="persona-chip" onClick={() => navigate("/app/profile")} title="Edit your profile">
              <span className="persona-chip__dot" aria-hidden="true" />
              {PERSONA_BY_ID[profile.persona].short}
            </button>
          </div>
        </header>

        <main className="page" id="main">
          <Outlet context={{ openSearch: () => setCmdOpen(true) }} />
        </main>

        <footer className="app-foot">
          <Disclaimer />
          <p className="disclaimer">
            Charts by{" "}
            <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer" className="u-link">
              TradingView Lightweight Charts™
            </a>
            . Probability, not promise.
          </p>
        </footer>
      </div>

      <nav className="tabbar" aria-label="Terminal navigation">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className="tabbar__item">
            <n.icon size={19} aria-hidden="true" />
            <span>{n.label}</span>
          </NavLink>
        ))}
      </nav>

      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} />
      {showOnboarding && <Onboarding initialStep={fromPersona ? 1 : 0} onDone={() => undefined} />}
      <Toaster />
    </div>
  );
}

function Watchlist() {
  const list = useStore(watchlistStore);
  return (
    <section className="side__watch" aria-label="Watchlist">
      <p className="side__label eyebrow">
        <Star size={12} aria-hidden="true" /> <span>Watchlist</span>
      </p>
      {list.length === 0 ? (
        <p className="side__hint">Star an instrument on its page to pin it here.</p>
      ) : (
        <ul>
          {list.map((sym) => (
            <WatchItem key={sym} symbol={sym} />
          ))}
        </ul>
      )}
    </section>
  );
}

function WatchItem({ symbol }: { symbol: string }) {
  const inst = getInstrument(symbol);
  const t = useTick(symbol);
  if (!inst) return null;
  const chg = ((t.price - inst.prevClose) / inst.prevClose) * 100;
  return (
    <li>
      <NavLink to={`/app/i/${symbol}`} className="witem" title={`${inst.name} · ${fmtPrice(inst, t.price)}`}>
        <span className="witem__sym mono">{symbol}</span>
        <span className="witem__px mono">{fmtPrice(inst, t.price, { currency: false })}</span>
        <span className={`witem__chg mono ${chg >= 0 ? "c-long" : "c-short"}`}>
          {chg >= 0 ? "▲" : "▼"} {fmtSignedPct(chg)}
        </span>
      </NavLink>
    </li>
  );
}
