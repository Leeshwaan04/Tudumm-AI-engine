import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Check, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import { SignalCard, regimeLabel } from "../../components/SignalCard";
import { EmptyState, SessionDot, Switch } from "../../components/ui";
import { useDocumentTitle } from "../../components/hooks";
import { instruments, MARKET_ORDER, MARKET_SHORT, STYLE_LABEL, getInstrument, instrumentsIn, riskPerUnit, useDataset } from "../../engine/universe";
import { useData } from "../../components/DataProvider";
import { EngineTag, LiveUnavailable, NAState, fmtAsOf, sitOutLabel } from "../../components/badges";
import { marketApi } from "../../api/market";
import { useApi } from "../../api/useApi";
import { track } from "../../api/events";
import type { Instrument, LiveStatus, MarketId, Regime, Style } from "../../engine/types";
import { isTrade } from "../../engine/types";
import { issuedAtMs, useNow, useStatuses, useTick } from "../../engine/live";
import { marketSession } from "../../engine/sessions";
import { PERSONA_BY_ID, trackingStore, toggleIn, useProfile, useStore, watchlistStore } from "../../engine/profile";
import { fmtMoney, fmtPrice, fmtSignedPct } from "../../engine/format";

type Sort = "confidence" | "newest" | "rr";
type DirF = "all" | "LONG" | "SHORT";
type StatusF = "all" | "active" | "pending" | "t1_hit";

const STYLES: Style[] = ["intraday", "swing", "positional", "investing"];

export function Signals() {
  useDocumentTitle("Signals · Tudumm");
  const ds = useDataset();
  const data = useData();
  const profile = useProfile();
  const statuses = useStatuses();
  const defaults = useMemo(
    () => ({ markets: profile.markets, styles: PERSONA_BY_ID[profile.persona].styles }),
    [profile.markets, profile.persona],
  );
  const [markets, setMarkets] = useState<MarketId[]>(defaults.markets);
  const [styles, setStyles] = useState<Style[]>(defaults.styles);
  const [dir, setDir] = useState<DirF>("all");
  const [status, setStatus] = useState<StatusF>("all");
  const [sort, setSort] = useState<Sort>("confidence");
  const [showSit, setShowSit] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // profile edits (onboarding, persona chips) reset the defaults
  useEffect(() => {
    setMarkets(defaults.markets);
    setStyles(defaults.styles);
  }, [defaults]);

  // filter_change (debounced; skip the initial render)
  const firstFilter = useRef(true);
  useEffect(() => {
    if (firstFilter.current) {
      firstFilter.current = false;
      return;
    }
    const t = window.setTimeout(
      () => track("filter_change", { markets: markets.join(","), styles: styles.join(","), dir, status, sort, showSit, live: true }),
      800,
    );
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markets, styles, dir, status, sort, showSit]);

  const resetFilters = () => {
    setMarkets(defaults.markets);
    setStyles(defaults.styles);
    setDir("all");
    setStatus("all");
    setSort("confidence");
    setShowSit(true);
  };
  const isDefault =
    dir === "all" &&
    status === "all" &&
    sort === "confidence" &&
    showSit &&
    markets.length === defaults.markets.length &&
    markets.every((m) => defaults.markets.includes(m)) &&
    styles.length === defaults.styles.length &&
    styles.every((s) => defaults.styles.includes(s));

  const list = useMemo(() => {
    const out = instruments.filter((inst) => {
      if (!markets.includes(inst.market)) return false;
      const st = statuses[inst.symbol];
      const s = inst.signal;
      if (st === "sit_out" || !isTrade(s)) return showSit && status === "all";
      if (styles.length && !styles.includes(s.style)) return false;
      if (dir !== "all" && s.direction !== dir) return false;
      if (status !== "all" && st !== status) return false;
      return true;
    });
    const conf = (i: Instrument) => (isTrade(i.signal) ? i.signal.confidence : -1);
    const rr = (i: Instrument) => (isTrade(i.signal) ? i.signal.rr2 : -1);
    out.sort((a, b) => {
      const sa = statuses[a.symbol] === "sit_out" ? 1 : 0;
      const sb = statuses[b.symbol] === "sit_out" ? 1 : 0;
      if (sort !== "newest" && sa !== sb) return sa - sb;
      if (sort === "confidence") return conf(b) - conf(a);
      if (sort === "rr") return rr(b) - rr(a);
      return issuedAtMs(b) - issuedAtMs(a);
    });
    return out;
    // ds: re-run when a live poll swaps the dataset
  }, [markets, styles, dir, status, sort, showSit, statuses, ds]);

  const toggleMarket = (m: MarketId) => setMarkets((l) => (l.includes(m) ? l.filter((x) => x !== m) : [...l, m]));
  const toggleStyle = (s: Style) => setStyles((l) => (l.includes(s) ? l.filter((x) => x !== s) : [...l, s]));
  const live_ = instruments.filter((i) => ["active", "pending", "t1_hit"].includes(statuses[i.symbol])).length;

  if (data.phase !== "ready") {
    return (
      <div className="feed">
        <div className="feed__main">
          <header className="phead">
            <div>
              <p className="eyebrow phead__eyebrow">
                Signals · live beta <EngineTag />
              </p>
            </div>
          </header>
          <LiveUnavailable />
        </div>
      </div>
    );
  }

  return (
    <div className="feed">
      <div className="feed__main">
        <header className="phead">
          <div>
            <p className="eyebrow phead__eyebrow">
              Signals · live beta <EngineTag />
            </p>
            <h1 className="phead__title serif">
              {live_} live calls, <em>{instruments.filter((i) => statuses[i.symbol] === "sit_out").length} sitting out</em>
            </h1>
          </div>
          <p className="phead__note">
            Real prices from free public sources; calls from engine v0, a transparent rule set whose confidence isn't calibrated yet. Every call has an
            entry, a stop, two targets and the condition that cancels it.
          </p>
        </header>

        <RegimeStrip
          statuses={statuses}
          selected={markets}
          onPick={(m) => setMarkets((l) => (l.length === 1 && l[0] === m ? [...MARKET_ORDER] : [m]))}
        />

        <WatchStrip />

        <button
          type="button"
          className="btn filters__toggle"
          aria-expanded={filtersOpen}
          aria-controls="feed-filters"
          onClick={() => setFiltersOpen((o) => !o)}
        >
          <SlidersHorizontal size={14} aria-hidden="true" />
          Filters{!isDefault ? " · customised" : ""}
          <span className="mono t3">{filtersOpen ? "hide" : "show"}</span>
        </button>
        <div className={`filters ${filtersOpen ? "is-open" : ""}`} role="group" aria-label="Filters" id="feed-filters">
          <div className="filters__row">
            <span className="filters__lab eyebrow">Market</span>
            <div className="filters__chips">
              {MARKET_ORDER.map((m) => (
                <button key={m} type="button" className="fchip" aria-pressed={markets.includes(m)} onClick={() => toggleMarket(m)}>
                  {MARKET_SHORT[m]} <span className="count">{instrumentsIn(m).length}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="filters__row">
            <span className="filters__lab eyebrow">Style</span>
            <div className="filters__chips">
              {STYLES.map((s) => (
                <button key={s} type="button" className="fchip" aria-pressed={styles.includes(s)} onClick={() => toggleStyle(s)}>
                  {STYLE_LABEL[s]}
                </button>
              ))}
              {styles.length === 0 && <span className="filters__hint">All styles</span>}
            </div>
          </div>
          <div className="filters__row filters__row--tools">
            <label className="filters__sel">
              <span className="eyebrow">Direction</span>
              <select className="select" value={dir} onChange={(e) => setDir(e.target.value as DirF)}>
                <option value="all">All</option>
                <option value="LONG">▲ Long</option>
                <option value="SHORT">▼ Short</option>
              </select>
            </label>
            <label className="filters__sel">
              <span className="eyebrow">Status</span>
              <select className="select" value={status} onChange={(e) => setStatus(e.target.value as StatusF)}>
                <option value="all">All</option>
                <option value="active">Active</option>
                <option value="pending">Entry pending</option>
                <option value="t1_hit">T1 hit</option>
              </select>
            </label>
            <label className="filters__sel">
              <span className="eyebrow">Sort</span>
              <select className="select" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                <option value="confidence">Confidence</option>
                <option value="newest">Newest</option>
                <option value="rr">R:R (to T2)</option>
              </select>
            </label>
            <Switch checked={showSit} onChange={setShowSit}>
              Show sit-outs
            </Switch>
            <button type="button" className="btn btn--ghost btn--sm filters__reset" onClick={resetFilters} disabled={isDefault}>
              <RotateCcw size={13} aria-hidden="true" /> Profile defaults
            </button>
          </div>
        </div>

        <p className="feed__count mono" aria-live="polite">
          {list.length} of {instruments.length} instruments
        </p>

        {list.length === 0 ? (
          <EmptyState
            title="Nothing matches these filters."
            action={
              <button type="button" className="btn" onClick={resetFilters}>
                <RotateCcw size={14} aria-hidden="true" /> Reset to profile defaults
              </button>
            }
          >
            {markets.length === 0
              ? "Select at least one market."
              : "Tudumm only issues calls when the layers line up, so narrow filters can come up empty."}
          </EmptyState>
        ) : (
          <div className="feed__grid">
            {list.map((inst, i) => (
              <SignalCard key={inst.symbol} inst={inst} revealDelay={i < 9 ? 120 + i * 110 : 0} trackable />
            ))}
          </div>
        )}
      </div>

      <aside className="rail" aria-label="Engine status, sit-outs and your risk">
        <EngineCadence />
        <AwaitingData />
        <SitOutList />
        <YourRisk />
      </aside>
    </div>
  );
}

/* ---------- regime strip ---------- */
export function marketRegime(m: MarketId): Regime | "mixed" {
  const insts = instrumentsIn(m);
  if (!insts.length) return "unknown";
  const counts = new Map<Regime, number>();
  for (const i of insts) counts.set(i.signal.regime, (counts.get(i.signal.regime) ?? 0) + 1);
  const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return n > insts.length / 2 ? top : "mixed";
}

function RegimeStrip({
  statuses,
  selected,
  onPick,
}: {
  statuses: Record<string, LiveStatus>;
  selected: MarketId[];
  onPick: (m: MarketId) => void;
}) {
  const now = useNow(30_000);
  return (
    <div className="regimes" role="list" aria-label="Market regimes">
      {MARKET_ORDER.map((m) => {
        const insts = instrumentsIn(m);
        const liveN = insts.filter((i) => ["active", "pending", "t1_hit"].includes(statuses[i.symbol])).length;
        const sit = insts.filter((i) => statuses[i.symbol] === "sit_out").length;
        const ses = marketSession(m, now);
        const on = selected.includes(m);
        return (
          <button
            key={m}
            role="listitem"
            type="button"
            className={`regime ${on ? "is-on" : ""}`}
            onClick={() => onPick(m)}
            title={`${ses.label} ${ses.status}. Click to show only ${MARKET_SHORT[m]}; click again for all markets.`}
          >
            <span className="regime__top">
              <b>{MARKET_SHORT[m]}</b>
              <span className="regime__ses">
                <SessionDot state={ses.state} /> {ses.status}
              </span>
            </span>
            <span className="regime__reg">{insts.length ? regimeLabel(marketRegime(m)) : "No data yet"}</span>
            <span className="regime__n mono">
              {insts.length ? `${liveN} live · ${sit} sitting out` : "awaiting source"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ---------- watchlist strip ---------- */
function WatchStrip() {
  const list = useStore(watchlistStore);
  if (!list.length) return null;
  return (
    <div className="wstrip" aria-label="Your watchlist">
      <span className="eyebrow">Watchlist</span>
      {list.map((s) => (
        <WatchPill key={s} symbol={s} />
      ))}
    </div>
  );
}
function WatchPill({ symbol }: { symbol: string }) {
  const inst = getInstrument(symbol);
  const t = useTick(symbol);
  if (!inst) {
    return (
      <Link to={`/app/i/${symbol}`} className="wpill" title="No live price for this instrument yet">
        <b className="mono">{symbol}</b>
        <span className="mono t3">no data</span>
      </Link>
    );
  }
  const chg = ((t.price - inst.prevClose) / inst.prevClose) * 100;
  return (
    <Link to={`/app/i/${symbol}`} className="wpill">
      <b className="mono">{symbol}</b>
      <span className="mono">{fmtPrice(inst, t.price, { currency: false })}</span>
      <span className={`mono ${chg >= 0 ? "c-long" : "c-short"}`}>
        {chg >= 0 ? "▲" : "▼"} {fmtSignedPct(chg)}
      </span>
    </Link>
  );
}

/* ---------- right rail ---------- */
function SitOutList() {
  const sits = instruments.filter((i) => i.signal.status === "sit_out");
  return (
    <section className="panel rpanel">
      <header className="panel__head">
        <span className="eyebrow">Sitting out</span>
        <span className="mono t3 rpanel__meta">{sits.length}</span>
      </header>
      <ul className="sitlist">
        {sits.map((i) => (
          <li key={i.symbol}>
            <Link to={`/app/i/${i.symbol}`} className="sitlist__item">
              <span className="sitlist__top">
                <b className="mono">{i.symbol}</b>
                <span className="chip">{sitOutLabel(i.signal.sitOutReason) ?? regimeLabel(i.signal.regime)}</span>
              </span>
              <span className="sitlist__why">{i.signal.thesis}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function YourRisk() {
  const profile = useProfile();
  const tracked = useStore(trackingStore);
  const statuses = useStatuses();
  const perTrade = (profile.capital * profile.riskPct) / 100;
  const items = tracked
    .map((s) => getInstrument(s))
    .filter((i): i is Instrument => !!i && isTrade(i.signal))
    .map((i) => ({ inst: i, status: statuses[i.symbol] }));
  const open = items.filter((x) => x.status === "active");
  const be = items.filter((x) => x.status === "t1_hit");
  const pend = items.filter((x) => x.status === "pending");
  const total = perTrade * open.length;
  const pctOfCap = (total / profile.capital) * 100;
  return (
    <section className="panel rpanel">
      <header className="panel__head">
        <span className="eyebrow">Your risk</span>
        <Link to="/app/profile" className="u-link rpanel__meta">
          Edit
        </Link>
      </header>
      <div className="panel__body risk">
        <dl className="risk__grid mono">
          <div>
            <dt>Capital</dt>
            <dd>{fmtMoney(profile.capital, profile.currency)}</dd>
          </div>
          <div>
            <dt>Risk / trade</dt>
            <dd>
              {profile.riskPct}% · {fmtMoney(perTrade, profile.currency)}
            </dd>
          </div>
          <div>
            <dt>Tracking (active)</dt>
            <dd>{open.length}</dd>
          </div>
        </dl>
        <div className="risk__total">
          <span className="eyebrow">Total open risk</span>
          <span className="risk__num mono">{fmtMoney(total, profile.currency)}</span>
          <span className="risk__bar" aria-hidden="true">
            <i style={{ width: `${Math.min(100, pctOfCap * 10)}%` }} className={pctOfCap > 6 ? "is-hot" : ""} />
          </span>
          <span className="t3 risk__pct mono">
            {pctOfCap.toFixed(2)}% of capital{pctOfCap > 6 ? " · heavy: consider fewer concurrent trades" : ""}
          </span>
        </div>
        {items.length === 0 ? (
          <p className="risk__hint">
            Press <b>Track</b> on any active card to add its risk here. Capital × risk % × tracked active signals.
          </p>
        ) : (
          <ul className="rlist">
            {items.map(({ inst, status }) => (
              <li key={inst.symbol}>
                <Link to={`/app/i/${inst.symbol}`} className="rlist__link mono">
                  {inst.symbol}
                </Link>
                <span className="t3">
                  {status === "active"
                    ? fmtMoney(perTrade, profile.currency)
                    : status === "t1_hit"
                      ? "0 · stop at breakeven"
                      : "not filled yet"}
                </span>
                <button
                  type="button"
                  className="btn btn--ghost btn--icon btn--sm"
                  aria-label={`Stop tracking ${inst.symbol}`}
                  onClick={() => toggleIn(trackingStore, inst.symbol)}
                >
                  <X size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {(be.length > 0 || pend.length > 0) && (
          <p className="risk__hint">
            {be.length > 0 && (
              <>
                <Check size={12} aria-hidden="true" /> {be.length} at breakeven adds no risk.{" "}
              </>
            )}
            {pend.length > 0 && (
              <>
                {pend.length} pending would add {fmtMoney(perTrade * pend.length, profile.currency)} if filled.
              </>
            )}
          </p>
        )}
        <p className="risk__fine t3">
          Per-trade risk sized from stop distance ({items[0] ? `e.g. ${items[0].inst.symbol} risks ${riskPerUnit(items[0].inst.signal as never).toFixed(2)} per unit` : "see any instrument's sizer"}).
        </p>
      </div>
    </section>
  );
}

/* ---------- engine cadence ---------- */
function EngineCadence() {
  const now = useNow(30_000);
  const h = useApi("market:health", () => marketApi.health(), { refreshMs: 60_000, staleMs: 30_000 });
  const statuses = useStatuses();
  const last = h.data?.lastRunAt ? Date.parse(h.data.lastRunAt) : NaN;
  const mins = Number.isFinite(last) ? Math.max(0, Math.round((now - last) / 60_000)) : null;
  const liveN = instruments.filter((i) => ["active", "pending", "t1_hit"].includes(statuses[i.symbol])).length;
  const bad = (h.data?.sources ?? []).filter((x) => !x.ok);
  return (
    <section className="panel rpanel">
      <header className="panel__head">
        <span className="eyebrow">Engine v0</span>
        <span className="mono t3 rpanel__meta">{liveN} open</span>
      </header>
      <div className="panel__body cadence">
        {h.error && !h.data ? (
          <NAState title="Engine status unavailable" reason="The market health endpoint didn't answer. Prices and calls above are from the last universe refresh." />
        ) : (
          <>
            <p className="cadence__main">
              Engine runs every 15 min
              <span className="mono t2"> · {mins === null ? (h.data ? "no run yet" : "checking…") : `last run ${mins === 0 ? "just now" : `${mins} min ago`}`}</span>
            </p>
            <p className="cadence__sub t2">
              Crypto and the gold proxy are evaluated on each completed 4-hour bar; US, India and FX on each completed daily bar. New calls appear here with a reveal, never on a schedule.
            </p>
            {h.data?.ledgerEntries !== undefined && (
              <p className="cadence__meta mono t3">
                {h.data.ledgerEntries} ledger entries ·{" "}
                <Link to="/app/proof" className="u-link">
                  verify the chain
                </Link>
              </p>
            )}
            {bad.length > 0 && (
              <p className="cadence__warn mono">
                {bad.length} source{bad.length === 1 ? "" : "s"} not reporting: {bad.map((b) => b.source).join(", ")}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function AwaitingData() {
  const d = useData();
  if (!d.unavailable.length) return null;
  return (
    <section className="panel rpanel">
      <header className="panel__head">
        <span className="eyebrow">Awaiting data</span>
        <span className="mono t3 rpanel__meta">{d.unavailable.length}</span>
      </header>
      <ul className="sitlist">
        {d.unavailable.map((u) => (
          <li key={u.symbol}>
            <div className="sitlist__item">
              <span className="sitlist__top">
                <b className="mono">{u.symbol}</b>
                <span className="chip">{MARKET_SHORT[u.market as MarketId] ?? u.market}</span>
              </span>
              <span className="sitlist__why">{u.reason}</span>
            </div>
          </li>
        ))}
      </ul>
      {d.lastPollAt && <p className="src-line mono rpanel__foot">checked {fmtAsOf(new Date(d.lastPollAt).toISOString())}</p>}
    </section>
  );
}
