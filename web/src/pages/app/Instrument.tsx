import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Bookmark, BookmarkCheck, ChevronRight, Star } from "lucide-react";
import { LayerEvidence } from "../../components/Evidence";
import { SignalCard, regimeLabel } from "../../components/SignalCard";
import { ConfluenceMeter, DirectionPill, LevelsRow, LivePrice, StatusPill, TradeMap } from "../../components/signal";
import { SessionChip, toast } from "../../components/ui";
import { useCountUp, useDocumentTitle } from "../../components/hooks";
import { LAYER_LABEL, LAYER_ORDER, MARKET_LABEL, agreement, entryMid, getInstrument, instrumentsIn, rAt, riskPerUnit } from "../../engine/universe";
import type { Currency, Instrument as Inst, LayerId, TradeSignal } from "../../engine/types";
import { isTrade } from "../../engine/types";
import { MARKET_SESSION } from "../../engine/sessions";
import { useAllTicks, useLiveStatus, useTick } from "../../engine/live";
import { CURRENCIES, trackingStore, toggleIn, useProfile, useStore, watchlistStore, type Persona, type ProfileCurrency } from "../../engine/profile";
import { convert, rateNote } from "../../engine/fx";
import { fmtMoney, fmtPrice, fmtR, fmtSignedPct, MINUS } from "../../engine/format";
import { layerTone } from "../../engine/evidence";
import { useDataset } from "../../engine/universe";
import { useData } from "../../components/DataProvider";
import { EngineTag, FreshnessBadge, LiveUnavailable, NAState, SourceLine, fmtAsOf, sitOutLabel } from "../../components/badges";
import { AlertsPanel } from "../../components/AlertsPanel";
import { LiveChart, TF_SECONDS } from "../../components/LiveChart";
import { marketApi, type CandlesRes } from "../../api/market";
import { useApi } from "../../api/useApi";
import { track } from "../../api/events";

const PERSONA_TAB: Record<Persona, LayerId> = { scalper: "flow", swing: "price", options: "derivatives", investor: "fundamentals" };

export default function Instrument() {
  const { symbol } = useParams();
  useDataset();
  const data = useData();
  const inst = getInstrument(symbol);
  useDocumentTitle(inst ? `${inst.symbol} · Tudumm` : "Unknown symbol · Tudumm");
  if (!inst && data.phase !== "ready") return <LiveUnavailable />;
  if (!inst) {
    const u = data.unavailable.find((x) => x.symbol === symbol?.toUpperCase());
    return (
      <div className="inst-na">
        <NAState title={u ? `No live data for ${u.symbol} yet` : `“${symbol}” isn’t in Tudumm’s live universe.`} reason={u ? u.reason : "Use search (⌘K / Ctrl K) to find a covered instrument by symbol, name or alias."}>
          <div className="inst-na__act">
            <Link to="/app/markets" className="btn btn--sm">
              Browse all markets
            </Link>
          </div>
        </NAState>
      </div>
    );
  }
  return <InstrumentView key={inst.symbol} inst={inst} />;
}

function InstrumentView({ inst }: { inst: Inst }) {
  const s = inst.signal;
  const profile = useProfile();
  const status = useLiveStatus(inst.symbol);
  const watch = useStore(watchlistStore);
  const tracked = useStore(trackingStore).includes(inst.symbol);
  const starred = watch.includes(inst.symbol);
  const [tab, setTab] = useState<LayerId>(PERSONA_TAB[profile.persona]);
  const t = useTick(inst.symbol);
  const chg = t.price - inst.prevClose;
  const trade = isTrade(s) && status !== "sit_out";

  useEffect(() => {
    track("instrument_view", { symbol: inst.symbol, market: inst.market, live: !!inst.live });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inst.symbol]);
  useEffect(() => {
    track("signal_view", { symbol: inst.symbol, signalId: s.id, status: s.status, live: !!inst.live });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.id]);

  return (
    <div className="inst">
      <nav className="crumbs mono" aria-label="Breadcrumb">
        <Link to="/app">Signals</Link>
        <ChevronRight size={12} aria-hidden="true" />
        <Link to="/app/markets">{MARKET_LABEL[inst.market]}</Link>
        <ChevronRight size={12} aria-hidden="true" />
        <span aria-current="page">{inst.symbol}</span>
      </nav>

      <header className="ihead">
        <div className="ihead__id">
          <h1 className="ihead__sym mono">{inst.symbol}</h1>
          <p className="ihead__name serif">{inst.name}</p>
          <div className="ihead__chips">
            <span className="chip">{inst.exchange}</span>
            <span className="chip">{inst.assetClass}</span>
            <span className="chip">{regimeLabel(s.regime)}</span>
            <SessionChip k={MARKET_SESSION[inst.market]} />
          </div>
          {inst.live && (
            <div className="ihead__fresh">
              <FreshnessBadge inst={inst} />
              {inst.proxyNote && <p className="ihead__proxy">{inst.proxyNote}</p>}
            </div>
          )}
        </div>
        <div className="ihead__px">
          <LivePrice inst={inst} className="ihead__live" />
          {inst.live && <SourceLine source={inst.source} asOf={t.at ? new Date(t.at).toISOString() : inst.asOf} extra={inst.freshness === "realtime" ? "streaming" : undefined} />}
          <p className={`ihead__chg mono ${chg >= 0 ? "c-long" : "c-short"}`}>
            <span aria-hidden="true">{chg >= 0 ? "▲" : "▼"}</span> {chg >= 0 ? "+" : MINUS}
            {fmtPrice(inst, Math.abs(chg), { currency: false })} ({fmtSignedPct((chg / inst.prevClose) * 100)})
            <span className="t3"> vs prev close {fmtPrice(inst, inst.prevClose, { currency: false })}</span>
          </p>
        </div>
        <div className="ihead__act">
          <button
            type="button"
            className={`btn ${starred ? "btn--on" : ""}`}
            aria-pressed={starred}
            onClick={() => {
              toggleIn(watchlistStore, inst.symbol);
              toast(starred ? `${inst.symbol} removed from watchlist` : `${inst.symbol} added to watchlist`);
            }}
          >
            <Star size={15} aria-hidden="true" fill={starred ? "currentColor" : "none"} />
            {starred ? "Watching" : "Watchlist"}
          </button>
          {trade && (
            <button type="button" className={`btn ${tracked ? "btn--on" : ""}`} aria-pressed={tracked} onClick={() => toggleIn(trackingStore, inst.symbol)}>
              {tracked ? <BookmarkCheck size={15} aria-hidden="true" /> : <Bookmark size={15} aria-hidden="true" />}
              {tracked ? "Tracking risk" : "Track risk"}
            </button>
          )}
        </div>
      </header>

      <div className="inst__cols">
        <div className="inst__left">
        <LiveChartPanel inst={inst} status={status} />
        <section className="panel evidence o-3" aria-label="Evidence by layer">
          <div className="etabs" role="tablist" aria-label="Five layers">
            {LAYER_ORDER.map((l) => {
              const v = s.layers[l];
              const tone = layerTone(v);
              return (
                <button key={l} type="button" role="tab" aria-selected={tab === l} className={`etab etab--${tone.cls}`} onClick={() => setTab(l)}>
                  <span className="etab__lab">{LAYER_LABEL[l]}</span>
                  <span className="etab__score mono">{v === null ? "N/A" : v > 0 ? `+${v}` : v < 0 ? `${MINUS}${Math.abs(v)}` : "0"}</span>
                </button>
              );
            })}
          </div>
          <div className="evidence__body" role="tabpanel">
            <LayerEvidence inst={inst} layer={tab} />
          </div>
        </section>
        </div>
        <div className="inst__right">
          <div className="inst__signal o-2">
          {!trade ? (
            <>
              <SignalCard inst={inst} linkTo={null} />
              {!trade && (
                <div className="panel sizer sizer--off">
                  <p className="eyebrow">Position sizer</p>
                  <p className="t2">No position to size. Tudumm is sitting out {inst.symbol}, and sitting out is a position too.</p>
                </div>
              )}
            </>
          ) : (
            <SignalPanel inst={inst} s={s as TradeSignal} />
          )}
          </div>
          <div className="o-4 inst__side">
            <AlertsPanel inst={inst} />
            <AnalystNote inst={inst} />
            <Related inst={inst} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- signal panel ---------------- */
function SignalPanel({ inst, s }: { inst: Inst; s: TradeSignal }) {
  const status = useLiveStatus(inst.symbol);
  const t = useTick(inst.symbol);
  const conf = useCountUp(Math.round(s.confidence * 100), "mount", 900, 150);
  const r = rAt(s, t.price);
  const filled = status === "active" || status === "t1_hit";
  return (
    <section className="panel spanel" aria-label="Signal">
      <div className="spanel__top">
        <div className="sc__pills">
          <DirectionPill direction={s.direction} size="lg" />
          <StatusPill status={status} />
        </div>
        <div className="sc__conf">
          <span className="sc__conf-num mono spanel__conf">{Math.round(conf)}%</span>
          <span className="sc__conf-lab">confidence</span>
        </div>
      </div>
      <p className="spanel__meta mono">
        <span>{s.strategy}</span> · <span>{s.timeframe}</span> · <span>{s.style}</span> · <span className="t3">#{s.id}</span>
      </p>
      {s.live && (
        <p className="spanel__engine">
          <EngineTag /> <span className="t3">Confidence is a rule-based score, not a measured hit rate.</span>
        </p>
      )}
      <div className="spanel__live">
        <span className="t3">Now</span> <LivePrice inst={inst} />
        <span className={`mono ${filled ? (r >= 0 ? "c-long" : "c-short") : "t2"}`}>{filled ? `${fmtR(r)} open` : "not filled"}</span>
      </div>
      <TradeMap inst={inst} signal={s} status={status} big />
      <LevelsRow inst={inst} s={s} />
      <ConfluenceMeter layers={s.layers} showScores />
      {s.invalidation && (
        <p className="sc__inv">
          <span>Invalidated if:</span> {s.invalidation}
        </p>
      )}
      <PositionSizer inst={inst} s={s} />
    </section>
  );
}

function PositionSizer({ inst, s }: { inst: Inst; s: TradeSignal }) {
  const profile = useProfile();
  const ticks = useAllTicks();
  const [capital, setCapital] = useState(String(profile.capital));
  const [riskPct, setRiskPct] = useState(String(profile.riskPct));
  const [cur, setCur] = useState<ProfileCurrency>(profile.currency);
  useEffect(() => {
    setCapital(String(profile.capital));
    setRiskPct(String(profile.riskPct));
    setCur(profile.currency);
  }, [profile.capital, profile.riskPct, profile.currency]);

  const used = useRef(false);
  useEffect(() => {
    if (used.current) return;
    if (capital === String(profile.capital) && riskPct === String(profile.riskPct) && cur === profile.currency) return;
    used.current = true;
    track("sizer_use", { symbol: inst.symbol });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capital, riskPct, cur]);

  const cap = Number(capital.replace(/[^0-9.]/g, ""));
  const rp = Number(riskPct);
  const valid = cap > 0 && rp > 0 && rp <= 10;
  const instCur: Currency = inst.currency;
  const budgetProfile = valid ? (cap * rp) / 100 : 0;
  const budget = convert(budgetProfile, cur, instCur, ticks);
  const capInst = convert(cap, cur, instCur, ticks);
  const perUnit = riskPerUnit(s);
  const mid = entryMid(s);
  const frac = inst.assetClass === "crypto";
  const rawQty = budget / perUnit;
  const qty = frac ? Math.floor(rawQty * 1000) / 1000 : inst.assetClass === "fx" ? Math.floor(rawQty / 1000) * 1000 : Math.floor(rawQty);
  const notional = qty * mid;
  const maxLoss = qty * perUnit;
  const r1 = qty * Math.abs(s.target1 - mid);
  const r2 = qty * Math.abs(s.target2 - mid);
  const lev = capInst > 0 ? notional / capInst : 0;
  const note = rateNote(cur, instCur, ticks);
  const unit = inst.assetClass === "fx" ? `units of ${inst.symbol.slice(0, 3)}` : inst.assetClass === "index" ? "index units" : frac ? inst.symbol.replace("USDT", "") : inst.assetClass === "commodity" ? (inst.symbol === "XAUUSD" ? "oz" : "bbl") : "shares";

  return (
    <div className="sizer">
      <div className="sizer__head">
        <p className="eyebrow">Position sizer</p>
        <span className="mono t3">risk-based</span>
      </div>
      <div className="sizer__inputs">
        <label className="field">
          <span>Capital</span>
          <div className="input-group">
            <select className="select" value={cur} onChange={(e) => setCur(e.target.value as ProfileCurrency)} aria-label="Capital currency">
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <input className="input mono" inputMode="decimal" value={capital} onChange={(e) => setCapital(e.target.value)} aria-invalid={!(cap > 0)} />
          </div>
        </label>
        <label className="field">
          <span>Risk %</span>
          <input className="input mono" inputMode="decimal" value={riskPct} onChange={(e) => setRiskPct(e.target.value)} aria-invalid={!(rp > 0 && rp <= 10)} />
        </label>
      </div>
      {!valid ? (
        <p className="sizer__warn">Enter capital above zero and a risk between 0 and 10%.</p>
      ) : !Number.isFinite(budget) ? (
        <p className="sizer__warn">
          No live {cur}→{instCur === "USDT" ? "USD" : instCur} rate yet, so Tudumm can’t convert your capital. Set the capital currency to {instCur === "USDT" ? "USD" : instCur} to size this trade.
        </p>
      ) : qty <= 0 ? (
        <p className="sizer__warn">
          Your risk budget ({fmtMoney(budget, instCur)}) is smaller than the risk on one {unit === "shares" ? "share" : "unit"} ({fmtMoney(perUnit, instCur)}). Raise capital or risk %, or skip this trade.
        </p>
      ) : (
        <dl className="sizer__out mono">
          <div className="is-key">
            <dt>Quantity</dt>
            <dd>
              {qty.toLocaleString("en-US", { maximumFractionDigits: 3 })} <span className="t3">{unit}</span>
            </dd>
          </div>
          <div>
            <dt>Notional</dt>
            <dd>{fmtMoney(notional, instCur)}</dd>
          </div>
          <div>
            <dt>Max loss at SL</dt>
            <dd className="c-short">{fmtMoney(-maxLoss, instCur)}</dd>
          </div>
          <div>
            <dt>Reward at T1</dt>
            <dd className="c-long">+{fmtMoney(r1, instCur)}</dd>
          </div>
          <div>
            <dt>Reward at T2</dt>
            <dd className="c-long">+{fmtMoney(r2, instCur)}</dd>
          </div>
          <div>
            <dt>Risk per unit</dt>
            <dd>{fmtMoney(perUnit, instCur, inst.decimals > 2 ? inst.decimals : 2)}</dd>
          </div>
        </dl>
      )}
      <p className="sizer__fine">
        Risk budget {fmtMoney(budgetProfile, cur)}
        {note ? ` ≈ ${fmtMoney(budget, instCur)} ${note}` : ""}. Sized from entry mid {fmtPrice(inst, mid, { currency: false })} to stop.
        {lev > 1 && valid && qty > 0 && ` Notional is ${lev.toFixed(1)}× capital, so this needs margin or leverage.`}
      </p>
      {inst.assetClass === "index" && <p className="sizer__fine sizer__fine--note">Trade via futures/options; lot sizes vary.</p>}
    </div>
  );
}

/* ---------------- analyst note ---------------- */
function AnalystNote({ inst }: { inst: Inst }) {
  const s = inst.signal;
  const a = agreement(s.layers);
  const weakest = useMemo(() => {
    let best: { l: LayerId; v: number } | null = null;
    for (const l of LAYER_ORDER) {
      const v = s.layers[l];
      if (v === null) continue;
      if (!best || v < best.v) best = { l, v };
    }
    return best;
  }, [s]);
  const trade = isTrade(s);
  const tf = (s as { timeframe?: string }).timeframe ?? "1D";
  const mind = s.live
    ? trade
      ? `${weakest ? `${LAYER_LABEL[weakest.l]} is the weakest leg (${weakest.v > 0 ? "+" : ""}${weakest.v}). ` : ""}Engine v0 re-scores on every completed ${tf} bar; a stop or the invalidation above closes the call, and an entry that never fills expires. Every outcome is written to the public ledger.`
      : `${sitOutLabel(s.sitOutReason) ? `Why it's sitting out: ${sitOutLabel(s.sitOutReason)?.toLowerCase()}. ` : ""}${s.candidate ? `It was leaning ${s.candidate === "LONG" ? "▲ LONG" : "▼ SHORT"}. ` : ""}A call needs a clear trend, momentum that agrees, and at least three layers scoring +15 or better on a completed ${tf} bar.`
    : trade
    ? `${weakest ? `${LAYER_LABEL[weakest.l]} is the weakest leg (${weakest.v > 0 ? "+" : ""}${weakest.v}); if it turns against the call, confidence falls below 55% and Tudumm stands aside. ` : ""}If the entry never fills, the call expires and is logged as expired on the ledger.`
    : `At least four of five layers agreeing on one side, with price leaving the ${regimeLabel(s.regime).toLowerCase()} regime on volume. Until then, no call.`;
  return (
    <section className="panel note">
      <p className="eyebrow">The why · analyst note</p>
      <p className="note__body serif">{s.thesis}</p>
      <dl className="note__dl">
        {s.invalidation && (
          <div>
            <dt>Invalidated if</dt>
            <dd>{s.invalidation}</dd>
          </div>
        )}
        <div>
          <dt>What would change our mind</dt>
          <dd>{mind}</dd>
        </div>
        <div>
          <dt>Confluence</dt>
          <dd className="mono">
            {a.agree} of {a.applicable} applicable layers agree{a.na ? ` · ${a.na} not applicable` : ""}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function Related({ inst }: { inst: Inst }) {
  const others = instrumentsIn(inst.market).filter((i) => i.symbol !== inst.symbol);
  return (
    <section className="panel related">
      <header className="panel__head">
        <span className="eyebrow">More in {MARKET_LABEL[inst.market]}</span>
        <Link to="/app/markets" className="u-link mono related__all">
          All markets
        </Link>
      </header>
      {others.length === 0 ? (
        <p className="related__empty">
          {inst.symbol} is the only {MARKET_LABEL[inst.market]} instrument with live data right now. See the{" "}
          <Link className="u-link" to="/app">
            full feed
          </Link>
          .
        </p>
      ) : (
        <ul>
          {others.map((o) => (
            <RelatedRow key={o.symbol} inst={o} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RelatedRow({ inst }: { inst: Inst }) {
  const status = useLiveStatus(inst.symbol);
  const s = inst.signal;
  return (
    <li>
      <Link to={`/app/i/${inst.symbol}`} className="rrow">
        <span className="rrow__sym mono">{inst.symbol}</span>
        <LivePrice inst={inst} className="rrow__px" />
        <span className="rrow__sig">
          {status === "sit_out" || !isTrade(s) ? (
            <span className="mono c-neutral">SITTING OUT</span>
          ) : (
            <>
              <DirectionPill direction={s.direction} size="sm" />
              <span className="mono c-brand">{Math.round(s.confidence * 100)}%</span>
            </>
          )}
        </span>
      </Link>
    </li>
  );
}

/* ---------------- live chart panel ---------------- */
function liveTimeframes(inst: Inst): string[] {
  return inst.source === "binance" || inst.symbol === "XAUUSD" ? ["15m", "1H", "4H", "1D", "1W"] : ["1D", "1W"];
}

function LiveChartPanel({ inst, status }: { inst: Inst; status: ReturnType<typeof useLiveStatus> }) {
  const tfs = liveTimeframes(inst);
  const s = inst.signal;
  const sigTf = (s as { timeframe?: string }).timeframe;
  const [tf, setTf] = useState<string>(sigTf && tfs.includes(sigTf) ? sigTf : tfs.includes("4H") ? "4H" : "1D");
  const [showEma, setShowEma] = useState(true);
  const realtime = inst.freshness === "realtime";
  const q = useApi<CandlesRes>(`mkt:candles:${inst.symbol}:${tf}`, () => marketApi.candles(inst.symbol, tf, 400), {
    refreshMs: realtime ? 60_000 : 300_000,
    staleMs: 20_000,
  });
  const d = q.data;
  const line = d ? d.ohlc === false : inst.ohlc === false;
  const bars = d?.bars ?? [];
  const effTf = (d as (CandlesRes & { requestedTf?: string; note?: string | null }) | undefined)?.tf ?? tf;
  const note = (d as (CandlesRes & { note?: string | null }) | undefined)?.note ?? null;
  return (
    <section className="panel chart-panel o-1" aria-label="Price chart">
      <div className="chart-panel__bar">
        <div className="seg" role="group" aria-label="Timeframe">
          {tfs.map((x) => (
            <button key={x} type="button" aria-pressed={tf === x} onClick={() => setTf(x)}>
              {x}
            </button>
          ))}
        </div>
        <button type="button" className="fchip" aria-pressed={showEma} onClick={() => setShowEma((v) => !v)}>
          EMA 20 / 50
        </button>
        <div className="chart-legend mono" aria-hidden="true">
          {showEma && (
            <>
              <span>
                <i style={{ background: "#7FA7FF" }} /> EMA 20
              </span>
              <span>
                <i style={{ background: "#C9A6FF" }} /> EMA 50
              </span>
            </>
          )}
          {isTrade(s) && status !== "sit_out" && (
            <>
              <span>
                <i className="lg-zone" /> Entry zone
              </span>
              <span>
                <i style={{ background: "var(--short)" }} /> SL
              </span>
              <span>
                <i style={{ background: "var(--long)" }} /> T1 / T2
              </span>
            </>
          )}
        </div>
      </div>
      {q.error && !d ? (
        <div className="chart chart--na">
          <NAState title="Chart data didn't load" reason="The candles endpoint didn't answer. The price above still updates.">
            <button type="button" className="btn btn--sm" onClick={() => void q.reload()}>
              Retry
            </button>
          </NAState>
        </div>
      ) : !d ? (
        <div className="chart chart--loading" role="status">
          <span className="mono t3">Loading {tf} bars…</span>
        </div>
      ) : bars.length === 0 ? (
        <div className="chart chart--na">
          <NAState title="No bars stored yet" reason={note ?? "The ingest job hasn't produced history for this instrument and timeframe yet."} />
        </div>
      ) : (
        <LiveChart inst={inst} bars={bars} line={line} tfSec={TF_SECONDS[effTf] ?? 86400} tickable={realtime && effTf === tf} showEma={showEma} status={status} />
      )}
      <p className="chart-panel__foot">
        {d ? (
          <>
            {bars.length} {effTf} bars · <SourceInline source={d.source} asOf={d.asOf} />
            {line ? " · close-only reference rates, drawn as a line" : ""}
            {realtime && effTf === tf ? " · last bar follows the live stream" : ""}. {note ? `${note} ` : ""}
          </>
        ) : null}
        Chart by{" "}
        <a className="u-link" href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
          TradingView Lightweight Charts™
        </a>
        .
      </p>
    </section>
  );
}

function SourceInline({ source, asOf }: { source?: string; asOf?: string }) {
  const NAMES: Record<string, string> = { binance: "Binance", cboe: "Cboe (delayed)", "nse-archives": "NSE archives (EOD)", "ecb-frankfurter": "ECB reference rates" };
  return (
    <span className="mono">
      {source ? (NAMES[source] ?? source) : "source"}
      {asOf ? ` · as of ${fmtAsOf(asOf, { date: true })}` : ""}
    </span>
  );
}
