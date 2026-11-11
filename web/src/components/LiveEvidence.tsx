// Live (engine v0) evidence per layer. Every number on this screen comes from the market API;
// when a source has nothing for an instrument we show the API's own reason — never a generated value.
import type { ReactNode } from "react";
import { Info } from "lucide-react";
import type { Instrument, LayerId } from "../engine/types";
import { isTrade } from "../engine/types";
import { marketApi, type ContextRes, type DepthRes, type DerivativesRes, type FundamentalsRes } from "../api/market";
import { useApi } from "../api/useApi";
import { errorText } from "../api/client";
import { useTick } from "../engine/live";
import { fmtCompact, fmtLevel, fmtNum, MINUS } from "../engine/format";
import { NAState, SourceLine, fmtAsOf } from "./badges";

const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const signed = (v: number, dp = 2) => `${v > 0 ? "+" : v < 0 ? MINUS : ""}${Math.abs(v).toFixed(dp)}`;
const isBookable = (inst: Instrument) => inst.assetClass === "crypto" || inst.symbol === "XAUUSD";

export function LiveLayer({ inst, layer }: { inst: Instrument; layer: LayerId }) {
  const s = inst.signal;
  const score = s.layers[layer];
  const detail = s.layerDetail?.[layer];
  const note = s.layerNotes?.[layer];
  return (
    <>
      {score === null ? (
        <NAState title="Engine v0 skipped this layer" reason={note ?? "No data for this layer on the free sources Tudumm uses."} />
      ) : (
        <div className="ev-engine">
          <p className="eyebrow">Engine v0 reading</p>
          <p className="ev-engine__txt">{detail ?? "Scored by engine v0; no explanation was stored for this layer."}</p>
          {note && <p className="ev__fine">{note}</p>}
        </div>
      )}
      {layer === "price" && <PriceLive inst={inst} />}
      {layer === "flow" && <FlowLive inst={inst} />}
      {layer === "derivatives" && <DerivLive inst={inst} />}
      {layer === "fundamentals" && <FundLive inst={inst} />}
      {layer === "context" && <ContextLive inst={inst} />}
    </>
  );
}

function Loading({ what }: { what: string }) {
  return (
    <p className="ev-loading mono t3" role="status">
      Loading {what}…
    </p>
  );
}

function Failed({ err, retry }: { err: unknown; retry: () => void }) {
  return (
    <NAState title="Couldn't load this data" reason={errorText(err)}>
      <button type="button" className="btn btn--sm" onClick={retry}>
        Retry
      </button>
    </NAState>
  );
}

function Block({ title, children, foot }: { title: ReactNode; children: ReactNode; foot?: ReactNode }) {
  return (
    <div className="ev__block">
      <p className="eyebrow">{title}</p>
      {children}
      {foot}
    </div>
  );
}

/* ---------------- price & structure ---------------- */
function PriceLive({ inst }: { inst: Instrument }) {
  const s = inst.signal;
  const t = useTick(inst.symbol);
  const tf = isTrade(s) ? s.timeframe : (s as { timeframe?: string }).timeframe;
  return (
    <div className="ev__block">
      <p className="eyebrow">What the engine checks</p>
      <ul className="ev__bullets">
        <li>EMA 20 / 50 / 200 stack and the 50-EMA slope, distance from the 50-EMA in ATRs.</li>
        <li>RSI(14), MACD histogram, Supertrend(10, 3) and a 20-bar Donchian breakout.</li>
        <li>
          Evaluated on completed {tf ?? "daily"} bars. Last price {fmtLevel(inst, t.price)}
          {inst.asOf ? ` (as of ${fmtAsOf(inst.asOf, { date: true })})` : ""}.
        </li>
      </ul>
      <SourceLine source={inst.source} asOf={inst.asOf} extra="chart above uses the same bars" />
    </div>
  );
}

/* ---------------- order flow ---------------- */
function FlowLive({ inst }: { inst: Instrument }) {
  const bookable = isBookable(inst);
  const q = useApi<DepthRes>(`mkt:depth:${inst.symbol}`, () => marketApi.depth(inst.symbol), { refreshMs: bookable ? 15_000 : 0, staleMs: 5_000 });
  if (q.error && !q.data) return <Failed err={q.error} retry={() => void q.reload()} />;
  if (!q.data) return <Loading what="the order book" />;
  const d = q.data;
  if (!d.available) {
    const tob = (d as DepthRes & { topOfBook?: { bid: number | null; ask: number | null; bidSize: number | null; askSize: number | null; asOf: string | null } | null }).topOfBook;
    return (
      <>
        <NAState title="No depth ladder for this instrument" reason={d.reason} />
        {tob && (n(tob.bid) !== null || n(tob.ask) !== null) && (
          <Block title="Top of book · delayed" foot={<SourceLine source="cboe" asOf={tob.asOf} />}>
            <dl className="stat-grid stat-grid--4 mono">
              <div>
                <dt>Bid</dt>
                <dd className="c-long">{n(tob.bid) !== null ? fmtLevel(inst, tob.bid as number) : "—"}</dd>
              </div>
              <div>
                <dt>Bid size</dt>
                <dd>{n(tob.bidSize) !== null ? fmtCompact(tob.bidSize as number) : "—"}</dd>
              </div>
              <div>
                <dt>Ask</dt>
                <dd className="c-short">{n(tob.ask) !== null ? fmtLevel(inst, tob.ask as number) : "—"}</dd>
              </div>
              <div>
                <dt>Ask size</dt>
                <dd>{n(tob.askSize) !== null ? fmtCompact(tob.askSize as number) : "—"}</dd>
              </div>
            </dl>
          </Block>
        )}
      </>
    );
  }
  const rows = Math.min(12, d.bids.length, d.asks.length);
  const maxSize = Math.max(1e-12, ...d.bids.slice(0, rows).map((b) => b[1]), ...d.asks.slice(0, rows).map((a) => a[1]));
  const imb = n(d.imbalance);
  const bidPct = imb === null ? null : ((imb + 1) / 2) * 100;
  const dp = Math.max(2, inst.decimals);
  const sz = (v: number) => (v >= 1000 ? fmtCompact(v) : v.toFixed(v >= 10 ? 2 : 4));
  return (
    <div className="ev__cols">
      <Block
        title={`Order book · top ${rows} levels · ${d.venue ?? "Binance"}${inst.symbol === "XAUUSD" ? " · PAXG proxy" : ""}`}
        foot={<SourceLine source={d.source ?? "binance"} asOf={d.asOf} extra="refreshes every 15 s" />}
      >
        <div className="scroll-x">
          <table className="depth mono">
            <thead>
              <tr>
                <th className="r">Bid size</th>
                <th className="r">Bid</th>
                <th>Ask</th>
                <th>Ask size</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: rows }, (_, i) => {
                const b = d.bids[i];
                const a = d.asks[i];
                return (
                  <tr key={i}>
                    <td className="depth__sz depth__sz--bid r">
                      <i style={{ width: `${(b[1] / maxSize) * 100}%` }} />
                      <span>{sz(b[1])}</span>
                    </td>
                    <td className="r c-long">{fmtNum(b[0], dp, inst.currency)}</td>
                    <td className="c-short">{fmtNum(a[0], dp, inst.currency)}</td>
                    <td className="depth__sz depth__sz--ask">
                      <i style={{ width: `${(a[1] / maxSize) * 100}%` }} />
                      <span>{sz(a[1])}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Block>
      <Block title="Book pressure within ±1% of mid">
        {bidPct !== null && (
          <div className="imb" aria-label={`Bid/ask imbalance: ${bidPct.toFixed(0)}% bids`}>
            <div className="imb__labels mono">
              <span className="c-long">Bids {bidPct.toFixed(0)}%</span>
              <span className="eyebrow">Imbalance</span>
              <span className="c-short">{(100 - bidPct).toFixed(0)}% Asks</span>
            </div>
            <div className="imb__bar">
              <i className="imb__bid" style={{ width: `${bidPct}%` }} />
              <i className="imb__mid" />
            </div>
          </div>
        )}
        <dl className="stat-grid mono">
          <div>
            <dt>Mid</dt>
            <dd>{n(d.mid) !== null ? fmtNum(d.mid as number, dp, inst.currency) : "—"}</dd>
          </div>
          <div>
            <dt>Spread</dt>
            <dd>{n(d.spreadBps) !== null ? `${(d.spreadBps as number).toFixed(1)} bps` : "—"}</dd>
          </div>
          <div>
            <dt>Imbalance</dt>
            <dd className={imb !== null ? (imb > 0.1 ? "c-long" : imb < -0.1 ? "c-short" : "") : ""}>{imb !== null ? signed(imb, 2) : "—"}</dd>
          </div>
          <div>
            <dt>Bid / ask qty</dt>
            <dd>{n(d.bidAskRatio) !== null ? `${(d.bidAskRatio as number).toFixed(2)}×` : "—"}</dd>
          </div>
        </dl>
        <p className="ev__fine">Imbalance = (bid − ask) / (bid + ask) quantity within ±1% of mid. A thin book can flip in seconds; engine v0 also weighs taker-buy share and volume.</p>
      </Block>
    </div>
  );
}

/* ---------------- derivatives ---------------- */
function DerivLive({ inst }: { inst: Instrument }) {
  const q = useApi<DerivativesRes>(`mkt:deriv:${inst.symbol}`, () => marketApi.derivatives(inst.symbol), { refreshMs: 60_000, staleMs: 30_000 });
  const t = useTick(inst.symbol);
  if (q.error && !q.data) return <Failed err={q.error} retry={() => void q.reload()} />;
  if (!q.data) return <Loading what="derivatives" />;
  const d = q.data;
  if (!d.available) return <NAState title="No derivatives data" reason={d.reason} />;
  if (d.kind === "perp") return <PerpLive inst={inst} d={d} />;
  const rows = d.rows ?? [];
  const maxOI = Math.max(1, ...rows.map((r) => Math.max(r.callOI ?? 0, r.putOI ?? 0)));
  const ltp = (v: number | null) => (v === null ? "—" : fmtNum(v, v >= 100 ? 1 : 2, inst.currency));
  const oi = (v: number | null) => (v === null ? "—" : fmtCompact(v));
  const doi = (v: number | null) => (v === null ? <span className="t3">—</span> : <span className={v >= 0 ? "c-long" : "c-short"}>{`${v >= 0 ? "+" : MINUS}${fmtCompact(Math.abs(v))}`}</span>);
  const iv = (v: number | null) => (v === null ? "—" : v.toFixed(1));
  const spot = n(d.spot) ?? t.price;
  const pcr = n(d.pcr);
  const bu = d.buildUp;
  const ext = d as DerivativesRes & { pcrVolume?: number | null; skew?: number | null; lotSize?: number | null; tradeDate?: string | null; convention?: string };
  return (
    <>
      <dl className="stat-grid stat-grid--4 mono ev__stats">
        <div>
          <dt>PCR (OI)</dt>
          <dd>{pcr !== null ? pcr.toFixed(2) : "—"}</dd>
        </div>
        <div>
          <dt>Max pain</dt>
          <dd>{n(d.maxPain) !== null ? fmtLevel(inst, d.maxPain as number) : "—"}</dd>
        </div>
        <div>
          <dt>ATM IV</dt>
          <dd>{n(d.ivAtm) !== null ? `${(d.ivAtm as number).toFixed(1)}%` : "—"}</dd>
        </div>
        <div>
          <dt>IV rank</dt>
          <dd title={n(d.ivRank) === null ? "Needs at least 20 daily snapshots" : undefined}>{n(d.ivRank) !== null ? Math.round(d.ivRank as number) : "building"}</dd>
        </div>
        <div>
          <dt>PCR (volume)</dt>
          <dd>{n(ext.pcrVolume) !== null ? (ext.pcrVolume as number).toFixed(2) : "—"}</dd>
        </div>
        <div>
          <dt>Put skew</dt>
          <dd>{n(ext.skew) !== null ? `${signed(ext.skew as number, 1)} pts` : "—"}</dd>
        </div>
        <div>
          <dt>Call wall</dt>
          <dd className="c-short">{n(d.callWall) !== null ? fmtLevel(inst, d.callWall as number) : "—"}</dd>
        </div>
        <div>
          <dt>Put wall</dt>
          <dd className="c-long">{n(d.putWall) !== null ? fmtLevel(inst, d.putWall as number) : "—"}</dd>
        </div>
      </dl>
      {pcr !== null && (
        <p className="ev__fine">
          {ext.convention === "india"
            ? "India convention: PCR is read from the option writers' side, so a high PCR (heavy put writing) is read as support."
            : "US convention: a high PCR means more puts outstanding (hedging or bearish positioning)."}
        </p>
      )}
      <Block
        title={
          <>
            Option chain · expiry {d.expiry ?? "—"}
            {n(d.dte) !== null ? ` (${d.dte}d)` : ""}
            {n(d.step) !== null ? ` · strikes every ${fmtLevel(inst, d.step as number)}` : ""}
          </>
        }
        foot={<SourceLine source={d.source} asOf={d.asOf} extra={ext.tradeDate ? `trade date ${ext.tradeDate}` : undefined} />}
      >
        {rows.length === 0 ? (
          <p className="t2">No strikes in the stored snapshot.</p>
        ) : (
          <div className="scroll-x ochain-wrap">
            <table className="ochain mono">
              <thead>
                <tr>
                  <th className="r">Call OI</th>
                  <th className="r">ΔOI</th>
                  <th className="r">IV</th>
                  <th className="r">LTP</th>
                  <th className="ochain__k">Strike</th>
                  <th>LTP</th>
                  <th>IV</th>
                  <th>ΔOI</th>
                  <th>Put OI</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const atm = r.strike === d.atm;
                  const itmCall = r.strike < spot;
                  return (
                    <tr key={r.strike} className={atm ? "is-atm" : ""}>
                      <td className={`ochain__oi ochain__oi--call r ${itmCall ? "is-itm" : ""}`}>
                        <i style={{ width: `${((r.callOI ?? 0) / maxOI) * 100}%` }} />
                        <span>{oi(r.callOI)}</span>
                      </td>
                      <td className="r">{doi(r.callDOI)}</td>
                      <td className="r t2">{iv(r.callIV)}</td>
                      <td className="r">{ltp(r.callLTP)}</td>
                      <td className="ochain__k">
                        {fmtLevel(inst, r.strike)}
                        {atm && <span className="ochain__atm">ATM</span>}
                      </td>
                      <td>{ltp(r.putLTP)}</td>
                      <td className="t2">{iv(r.putIV)}</td>
                      <td>{doi(r.putDOI)}</td>
                      <td className={`ochain__oi ochain__oi--put ${r.strike > spot ? "is-itm" : ""}`}>
                        <i style={{ width: `${((r.putOI ?? 0) / maxOI) * 100}%` }} />
                        <span>{oi(r.putOI)}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {(d.lotNote || d.notes?.length) && (
          <p className="ev__fine">
            {[d.lotNote, ...(d.notes ?? [])].filter(Boolean).join(" ")} {d.source === "nse-archives" ? "IV is Black-Scholes implied from the settlement price." : ""}
          </p>
        )}
      </Block>
      {bu && <BuildUp bu={bu} />}
    </>
  );
}

function BuildUp({ bu }: { bu: NonNullable<DerivativesRes["buildUp"]> }) {
  const cls = /long_buildup|short_covering/.test(bu.class) ? "c-long" : /short_buildup|long_unwinding/.test(bu.class) ? "c-short" : "";
  return (
    <Block title="Open-interest build-up">
      <p className={`ev-bu ${cls}`}>
        <b>{bu.label ?? bu.class.replace(/_/g, " ")}</b>
        <span className="mono t2">
          {" "}
          price {n(bu.priceChangePct) !== null ? `${signed(bu.priceChangePct as number)}%` : "—"} · OI {n(bu.oiChangePct) !== null ? `${signed(bu.oiChangePct as number)}%` : "—"}
        </span>
      </p>
      {bu.explanation && <p className="t2">{bu.explanation}</p>}
      {bu.basis && <p className="ev__fine">Basis: {bu.basis}</p>}
    </Block>
  );
}

interface PerpRaw {
  markPrice?: number | null;
  indexPrice?: number | null;
  premiumPct?: number | null;
  funding?: { rate?: number | null; ratePct?: number | null; intervalHours?: number | null; annualizedPct?: number | null; nextFundingTime?: string | null } | null;
  openInterest?: { contracts?: number | null; usd?: number | null; change24hPct?: number | null; window?: string | null } | null;
  priceChange24hPct?: number | null;
}

function PerpLive({ inst, d }: { inst: Instrument; d: DerivativesRes }) {
  const p = d as unknown as PerpRaw;
  const f = p.funding && typeof p.funding === "object" ? p.funding : null;
  const oi = p.openInterest && typeof p.openInterest === "object" ? p.openInterest : null;
  const fr = n(f?.ratePct);
  return (
    <>
      <Block title={`${d.venue ?? "Perpetual futures"}`} foot={<SourceLine source={d.source} asOf={d.asOf} />}>
        <dl className="stat-grid stat-grid--4 mono">
          <div>
            <dt>Mark</dt>
            <dd>{n(p.markPrice) !== null ? fmtLevel(inst, p.markPrice as number) : "—"}</dd>
          </div>
          <div>
            <dt>Index</dt>
            <dd>{n(p.indexPrice) !== null ? fmtLevel(inst, p.indexPrice as number) : "—"}</dd>
          </div>
          <div>
            <dt>Premium</dt>
            <dd>{n(p.premiumPct) !== null ? `${signed(p.premiumPct as number, 3)}%` : "—"}</dd>
          </div>
          <div>
            <dt>24h price</dt>
            <dd className={(n(p.priceChange24hPct) ?? 0) >= 0 ? "c-long" : "c-short"}>{n(p.priceChange24hPct) !== null ? `${signed(p.priceChange24hPct as number)}%` : "—"}</dd>
          </div>
          <div>
            <dt>Funding / {f?.intervalHours ?? 8}h</dt>
            <dd className={fr !== null ? (fr > 0 ? "c-short" : "c-long") : ""} title="Positive funding: longs pay shorts">
              {fr !== null ? `${signed(fr, 4)}%` : "—"}
            </dd>
          </div>
          <div>
            <dt>Annualised</dt>
            <dd>{n(f?.annualizedPct) !== null ? `${signed(f?.annualizedPct as number, 1)}%` : "—"}</dd>
          </div>
          <div>
            <dt>Open interest</dt>
            <dd>{n(oi?.usd) !== null ? `$${fmtCompact(oi?.usd as number)}` : n(oi?.contracts) !== null ? fmtCompact(oi?.contracts as number) : "—"}</dd>
          </div>
          <div>
            <dt>OI {oi?.window ?? "24h"}</dt>
            <dd className={(n(oi?.change24hPct) ?? 0) >= 0 ? "c-long" : "c-short"}>{n(oi?.change24hPct) !== null ? `${signed(oi?.change24hPct as number)}%` : "—"}</dd>
          </div>
        </dl>
        {f?.nextFundingTime && <p className="ev__fine">Next funding {fmtAsOf(f.nextFundingTime, { date: true })}. Positive funding means longs pay shorts; engine v0 reads crowded funding as a contrarian signal.</p>}
        {d.notes?.length ? <p className="ev__fine">{d.notes.join(" ")}</p> : null}
      </Block>
      {d.buildUp && <BuildUp bu={d.buildUp} />}
    </>
  );
}

/* ---------------- fundamentals ---------------- */
function fmtMetric(v: number | string | null, unit: string | null | undefined, currency: string): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  switch (unit) {
    case "USD":
    case "INR":
      return `${unit === "INR" ? "₹" : currency === "USD" || unit === "USD" ? "$" : ""}${Math.abs(v) >= 1e4 ? fmtCompact(v, 2) : v.toFixed(2)}`;
    case "%":
      return `${v.toFixed(1)}%`;
    case "x":
      return `${v.toFixed(v >= 100 ? 0 : 1)}×`;
    case "pctl":
      return `${Math.round(v)}th pctl`;
    case "shares":
      return fmtCompact(v, 2);
    default:
      return Math.abs(v) >= 1e4 ? fmtCompact(v, 2) : String(Math.round(v * 100) / 100);
  }
}

function FundLive({ inst }: { inst: Instrument }) {
  const q = useApi<FundamentalsRes>(`mkt:fund:${inst.symbol}`, () => marketApi.fundamentals(inst.symbol), { staleMs: 120_000 });
  if (q.error && !q.data) return <Failed err={q.error} retry={() => void q.reload()} />;
  if (!q.data) return <Loading what="fundamentals" />;
  const d = q.data as FundamentalsRes & { kind?: string; basis?: string; periodEnd?: string; filed?: string; form?: string; entity?: string; currency?: string; note?: string | null };
  if (!d.available || !d.metrics?.length) return <NAState title="No fundamentals" reason={d.reason ?? "No free licensed source covers this instrument yet."} />;
  return (
    <Block
      title={
        <>
          {d.kind === "index" ? "Index valuation" : `${d.entity ?? inst.name} · ${d.basis ?? "TTM"}`}
          {d.form ? ` · ${d.form}` : ""}
          {d.periodEnd ? ` · period to ${d.periodEnd}` : ""}
        </>
      }
      foot={<SourceLine source={d.source} asOf={d.asOf} extra={d.filed ? `filed ${d.filed}` : undefined} />}
    >
      <dl className="stat-grid mono fund-grid">
        {d.metrics.map((m) => (
          <div key={m.key}>
            <dt>{m.label}</dt>
            <dd className={typeof m.value === "number" && /Growth|growth/.test(m.label) ? (m.value >= 0 ? "c-long" : "c-short") : ""}>{fmtMetric(m.value, m.unit, d.currency ?? "USD")}</dd>
          </div>
        ))}
      </dl>
      {d.note && <p className="ev__fine">{d.note}</p>}
    </Block>
  );
}

/* ---------------- context ---------------- */
function ContextLive({ inst }: { inst: Instrument }) {
  const q = useApi<ContextRes>(`mkt:ctx:${inst.symbol}`, () => marketApi.context(inst.symbol), { staleMs: 120_000 });
  if (q.error && !q.data) return <Failed err={q.error} retry={() => void q.reload()} />;
  if (!q.data) return <Loading what="context" />;
  const d = q.data;
  if (!d.available || !d.items?.length) return <NAState title="No context reading" reason={d.reason ?? "No free source covers this instrument's context yet."} />;
  return (
    <Block title="Context & sentiment" foot={<SourceLine source={d.source} asOf={d.asOf} />}>
      <ul className="ctx-list">
        {d.items.map((it, i) => (
          <li key={i}>
            <span className="ctx-list__lab">{it.label}</span>
            <span className="ctx-list__val mono">{typeof it.value === "number" ? (Number.isInteger(it.value) ? it.value : it.value.toFixed(2)) : (it.value ?? "—")}</span>
            {it.note && <span className="ctx-list__note">{it.note}</span>}
          </li>
        ))}
      </ul>
      {inst.assetClass === "crypto" && (
        <p className="ev__fine">
          <Info size={11} aria-hidden="true" /> Engine v0 reads Fear &amp; Greed contrarian: extreme fear leans long, extreme greed leans short.
        </p>
      )}
    </Block>
  );
}
