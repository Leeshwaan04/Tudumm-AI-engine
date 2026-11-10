import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Info } from "lucide-react";
import type { Instrument, LayerId } from "../engine/types";
import { getInstrument, LAYER_LABEL } from "../engine/seed";
import { useTick } from "../engine/live";
import { asTimeframe, genCandles } from "../engine/candles";
import { priceIndicators } from "../engine/indicators";
import { fxFuturesProxy, hasOrderBook, largePrints, orderBook, volumeProfile } from "../engine/orderflow";
import {
  BUILDUP_EXPLAIN,
  buildUp,
  cryptoDerivs,
  derivKind,
  futuresOIChange,
  optionChain,
  positioning,
  type BuildUp,
} from "../engine/derivatives";
import { fundamentals } from "../engine/fundamentals";
import { calendar, correlations, headlines } from "../engine/context";
import {
  LAYER_QUESTION,
  chainBullets,
  contextBullets,
  cryptoBullets,
  flowBullets,
  fundBullets,
  layerTone,
  positioningBullets,
  priceBullets,
} from "../engine/evidence";
import { fmtCompact, fmtLevel, fmtNum, fmtPct, fmtSigned, MINUS } from "../engine/format";

const dp = (inst: Instrument, v: number) => fmtLevel(inst, Number(v.toFixed(inst.decimals)));

export function LayerEvidence({ inst, layer }: { inst: Instrument; layer: LayerId }) {
  const score = inst.signal.layers[layer];
  const tone = layerTone(score);
  return (
    <div className="ev">
      <header className="ev__head">
        <div>
          <p className="eyebrow">{LAYER_LABEL[layer]}</p>
          <p className="ev__q serif">{LAYER_QUESTION[layer]}</p>
        </div>
        <div className={`ev__score ev__score--${tone.cls}`}>
          <span className="ev__score-num mono">
            {score === null ? "N/A" : score > 0 ? `+${score}` : score < 0 ? `${MINUS}${Math.abs(score)}` : "0"}
          </span>
          <span className="ev__score-lab">{tone.label}</span>
          {score !== null && (
            <span className="ev__score-bar" aria-hidden="true">
              <i style={{ left: score >= 0 ? "50%" : `${50 + score / 2}%`, width: `${Math.abs(score) / 2}%` }} />
            </span>
          )}
        </div>
      </header>
      {layer === "price" && <PriceLayer inst={inst} />}
      {layer === "flow" && <FlowLayer inst={inst} />}
      {layer === "derivatives" && <DerivLayer inst={inst} />}
      {layer === "fundamentals" && <FundLayer inst={inst} />}
      {layer === "context" && <ContextLayer inst={inst} />}
    </div>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="ev__bullets">
      {items.map((b, i) => (
        <li key={i}>{b}</li>
      ))}
    </ul>
  );
}

/* ---------------- price & structure ---------------- */
function PriceLayer({ inst }: { inst: Instrument }) {
  const s = inst.signal;
  const tf = asTimeframe("timeframe" in s ? (s as { timeframe?: string }).timeframe : "1D");
  const ind = useMemo(() => {
    const c = genCandles(inst, tf, inst.price);
    return priceIndicators(c, tf === "15m" ? 26 : tf === "1H" ? 7 : 20);
  }, [inst, tf]);
  const stack = ind.ema20 > ind.ema50 && ind.ema50 > ind.ema200 ? "Bullish" : ind.ema20 < ind.ema50 && ind.ema50 < ind.ema200 ? "Bearish" : "Mixed";
  const f2 = (v: number) => fmtSigned(v, inst.decimals > 2 ? inst.decimals : 2);
  const rows: [string, string, string, string][] = [
    ["RSI 14", ind.rsi.toFixed(1), ind.rsi >= 70 ? "Overbought" : ind.rsi >= 55 ? "Strong" : ind.rsi > 45 ? "Neutral" : ind.rsi > 30 ? "Weak" : "Oversold", ind.rsi >= 50 ? "up" : "down"],
    ["MACD 12/26", f2(ind.macd.macd), ind.macd.hist >= 0 ? "Above signal" : "Below signal", ind.macd.hist >= 0 ? "up" : "down"],
    ["MACD hist.", f2(ind.macd.hist), ind.macd.hist >= 0 ? "Expanding up" : "Expanding down", ind.macd.hist >= 0 ? "up" : "down"],
    ["EMA 20", dp(inst, ind.ema20), ind.price >= ind.ema20 ? "Price above" : "Price below", ind.price >= ind.ema20 ? "up" : "down"],
    ["EMA 50", dp(inst, ind.ema50), ind.ema20 >= ind.ema50 ? "20 above 50" : "20 below 50", ind.ema20 >= ind.ema50 ? "up" : "down"],
    ["EMA 200", dp(inst, ind.ema200), `${stack} stack`, stack === "Bullish" ? "up" : stack === "Bearish" ? "down" : "flat"],
    ["ATR 14", dp(inst, ind.atr), `${fmtPct((ind.atr / ind.price) * 100, 2)} of price`, "flat"],
    ["Supertrend 10/3", dp(inst, ind.supertrend.value), `${ind.supertrend.dir > 0 ? "Bullish" : "Bearish"} · ${ind.supertrend.flippedBarsAgo} bars`, ind.supertrend.dir > 0 ? "up" : "down"],
    [`VWAP (${ind.vwapBars} bars)`, dp(inst, ind.vwap), ind.price >= ind.vwap ? "Price above" : "Price below", ind.price >= ind.vwap ? "up" : "down"],
  ];
  return (
    <>
      <Bullets items={priceBullets(inst, ind, tf)} />
      <div className="ev__cols">
        <div className="ev__block">
          <p className="eyebrow">Indicators · {tf}</p>
          <table className="dtable ev__table">
            <tbody>
              {rows.map(([k, v, read, d]) => (
                <tr key={k}>
                  <td className="t2">{k}</td>
                  <td className="mono r">{v}</td>
                  <td className={`r ev__read ev__read--${d}`}>
                    <span aria-hidden="true">{d === "up" ? "▲" : d === "down" ? "▼" : "•"}</span> {read}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="ev__block">
          <p className="eyebrow">Key levels</p>
          <ul className="levels-list mono">
            {ind.levels.resistances.length === 0 && (
              <li className="is-res is-none">
                <span>Resistance</span>
                <b>none above</b>
                <span className="t3">fresh high</span>
              </li>
            )}
            {[...ind.levels.resistances].reverse().map((l) => (
              <li key={`r${l}`} className="is-res">
                <span>Resistance</span>
                <b>{dp(inst, l)}</b>
                <span className="t3">{fmtSigned(((l - ind.price) / ind.price) * 100)}%</span>
              </li>
            ))}
            <li className="is-now">
              <span>Price</span>
              <b>{dp(inst, ind.price)}</b>
              <span className="t3">ref.</span>
            </li>
            {ind.levels.supports.length === 0 && (
              <li className="is-sup is-none">
                <span>Support</span>
                <b>none below</b>
                <span className="t3">fresh low</span>
              </li>
            )}
            {ind.levels.supports.map((l) => (
              <li key={`s${l}`} className="is-sup">
                <span>Support</span>
                <b>{dp(inst, l)}</b>
                <span className="t3">{fmtSigned(((l - ind.price) / ind.price) * 100)}%</span>
              </li>
            ))}
          </ul>
          <p className="ev__fine">Swing pivots from the generated {tf} history.</p>
        </div>
      </div>
    </>
  );
}

/* ---------------- order flow ---------------- */
function FlowLayer({ inst }: { inst: Instrument }) {
  const t = useTick(inst.symbol);
  const vp = useMemo(() => volumeProfile(genCandles(inst, "1H", inst.price)), [inst]);
  const prints = useMemo(() => largePrints(inst, inst.price), [inst]);
  if (!hasOrderBook(inst)) {
    const fx = fxFuturesProxy(inst);
    const pos = positioning(inst);
    return (
      <>
        <div className="na-box hatch-soft">
          <Info size={16} aria-hidden="true" />
          <div>
            <p className="na-box__title">No order book for spot FX</p>
            <p>
              Spot {inst.symbol} trades over the counter across hundreds of dealers, so there is no single book, tape or volume
              profile to read. Tudumm reads the exchange-traded futures instead.
            </p>
          </div>
        </div>
        <Bullets items={flowBullets(inst, null, vp, prints, fx, t.price)} />
        <div className="ev__cols">
          <div className="ev__block">
            <p className="eyebrow">{fx.contract}</p>
            <dl className="stat-grid mono">
              <div>
                <dt>Volume today</dt>
                <dd>{fmtCompact(fx.volume)}</dd>
              </div>
              <div>
                <dt>vs 20-day avg</dt>
                <dd className={fx.volumeVsAvg >= 1 ? "c-long" : "t2"}>{fx.volumeVsAvg.toFixed(2)}×</dd>
              </div>
              <div>
                <dt>Open interest</dt>
                <dd>{fmtCompact(fx.oi)}</dd>
              </div>
              <div>
                <dt>OI change</dt>
                <dd className={fx.oiChg >= 0 ? "c-long" : "c-short"}>
                  {fx.oiChg >= 0 ? "+" : MINUS}
                  {fmtCompact(Math.abs(fx.oiChg))}
                </dd>
              </div>
            </dl>
            <p className="ev__fine">{fx.venue} · simulated</p>
          </div>
          <PositioningBlock inst={inst} pos={pos} />
        </div>
      </>
    );
  }
  const book = orderBook(inst, t.price, t.seq);
  const maxSize = Math.max(...book.bids.map((b) => b.size), ...book.asks.map((a) => a.size));
  const vpMax = Math.max(...vp.bins.map((b) => b.vol));
  const bidPct = book.bidShare * 100;
  const sizeFmt = (v: number) => (inst.assetClass === "crypto" ? v.toFixed(2) : fmtCompact(v, v >= 1e4 ? 1 : 1));
  return (
    <>
      <Bullets items={flowBullets(inst, book, vp, prints, null, t.price)} />
      <div className="ev__cols">
        <div className="ev__block">
          <p className="eyebrow">
            L2 depth · 10 levels · {book.venue}
          </p>
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
                {book.bids.map((b, i) => {
                  const a = book.asks[i];
                  return (
                    <tr key={i}>
                      <td className="depth__sz depth__sz--bid r">
                        <i style={{ width: `${(b.size / maxSize) * 100}%` }} />
                        <span>{sizeFmt(b.size)}</span>
                      </td>
                      <td className="r c-long">{fmtNum(b.price, Math.max(2, inst.decimals), inst.currency)}</td>
                      <td className="c-short">{fmtNum(a.price, Math.max(2, inst.decimals), inst.currency)}</td>
                      <td className="depth__sz depth__sz--ask">
                        <i style={{ width: `${(a.size / maxSize) * 100}%` }} />
                        <span>{sizeFmt(a.size)}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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
          <p className="ev__fine">Sizes in {book.unit}. Depth flickers with each simulated tick.</p>
        </div>
        <div className="ev__block">
          <p className="eyebrow">Volume profile · 1H · 120 bars</p>
          <div className="vp" role="img" aria-label={`Volume profile: POC ${dp(inst, vp.poc)}, value area ${dp(inst, vp.val)} to ${dp(inst, vp.vah)}`}>
            {[...vp.bins].reverse().map((b, i) => {
              const inVA = b.hi > vp.val && b.lo < vp.vah;
              const isPoc = vp.poc >= b.lo && vp.poc <= b.hi;
              const hasPx = t.price >= b.lo && t.price < b.hi;
              return (
                <div key={i} className={`vp__row ${inVA ? "is-va" : ""} ${isPoc ? "is-poc" : ""}`}>
                  <span className="vp__px mono">{dp(inst, (b.lo + b.hi) / 2)}</span>
                  <span className="vp__bar">
                    <i style={{ width: `${(b.vol / vpMax) * 100}%` }} />
                  </span>
                  <span className="vp__tag mono">{isPoc ? "POC" : hasPx ? "◀ now" : ""}</span>
                </div>
              );
            })}
          </div>
          <dl className="stat-grid stat-grid--3 mono">
            <div>
              <dt>VAH</dt>
              <dd>{dp(inst, vp.vah)}</dd>
            </div>
            <div>
              <dt>POC</dt>
              <dd className="c-brand">{dp(inst, vp.poc)}</dd>
            </div>
            <div>
              <dt>VAL</dt>
              <dd>{dp(inst, vp.val)}</dd>
            </div>
          </dl>
        </div>
      </div>
      <div className="ev__block">
        <p className="eyebrow">Large prints</p>
        <div className="scroll-x">
          <table className="dtable mono">
            <thead>
              <tr>
                <th>Time</th>
                <th>Side</th>
                <th className="r">Size</th>
                <th className="r">Price</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              {prints.map((p, i) => (
                <tr key={i}>
                  <td className="t2">{p.minsAgo}m ago</td>
                  <td className={p.side === "buy" ? "c-long" : "c-short"}>
                    {p.side === "buy" ? "▲ Buy" : "▼ Sell"}
                  </td>
                  <td className="r">{inst.assetClass === "crypto" ? p.size.toFixed(1) : fmtCompact(p.size)}</td>
                  <td className="r">{dp(inst, p.price)}</td>
                  <td className="t2">{p.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* ---------------- derivatives ---------------- */
function DerivLayer({ inst }: { inst: Instrument }) {
  const t = useTick(inst.symbol);
  const kind = derivKind(inst);
  const chain = useMemo(() => (kind === "chain" ? optionChain(inst, inst.price) : null), [inst, kind]);
  if (kind === "crypto") return <CryptoDerivBlock inst={inst} price={t.price} />;
  if (kind === "futures") {
    const pos = positioning(inst);
    return (
      <>
        <Bullets items={positioningBullets(pos)} />
        <div className="ev__cols">
          <PositioningBlock inst={inst} pos={pos} />
          <BuildUpBlock inst={inst} price={t.price} />
        </div>
      </>
    );
  }
  const ch = chain!;
  const bu = buildUp(inst, t.price);
  const oiChg = futuresOIChange(inst, t.price);
  const maxOI = Math.max(...ch.rows.map((r) => Math.max(r.callOI, r.putOI)));
  const ltp = (v: number) => fmtNum(v, v >= 100 ? 1 : 2, inst.currency);
  return (
    <>
      <Bullets items={chainBullets(inst, ch, bu, oiChg, t.price)} />
      <dl className="stat-grid stat-grid--4 mono ev__stats">
        <div>
          <dt>PCR (OI)</dt>
          <dd className={ch.pcr > 1.15 ? "c-long" : ch.pcr < 0.8 ? "c-short" : ""}>{ch.pcr.toFixed(2)}</dd>
        </div>
        <div>
          <dt>Max pain</dt>
          <dd>{fmtLevel(inst, ch.maxPain)}</dd>
        </div>
        <div>
          <dt>IV rank</dt>
          <dd className={ch.ivRank > 70 ? "c-short" : ""}>{ch.ivRank}</dd>
        </div>
        <div>
          <dt>ATM IV</dt>
          <dd>{ch.atmIV.toFixed(1)}%</dd>
        </div>
      </dl>
      <div className="ev__block">
        <p className="eyebrow">
          Option chain · expiry {ch.expiryLabel} ({ch.dte}d) · strikes every {fmtLevel(inst, ch.step)}
        </p>
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
              {ch.rows.map((r) => {
                const atm = r.strike === ch.atm;
                const itmCall = r.strike < t.price;
                return (
                  <tr key={r.strike} className={atm ? "is-atm" : ""}>
                    <td className={`ochain__oi ochain__oi--call r ${itmCall ? "is-itm" : ""}`}>
                      <i style={{ width: `${(r.callOI / maxOI) * 100}%` }} />
                      <span>{fmtCompact(r.callOI)}</span>
                    </td>
                    <td className={`r ${r.callChg >= 0 ? "c-long" : "c-short"}`}>
                      {r.callChg >= 0 ? "+" : MINUS}
                      {fmtCompact(Math.abs(r.callChg))}
                    </td>
                    <td className="r t2">{r.callIV.toFixed(1)}</td>
                    <td className="r">{ltp(r.callLTP)}</td>
                    <td className="ochain__k">
                      {fmtLevel(inst, r.strike)}
                      {atm && <span className="ochain__atm">ATM</span>}
                    </td>
                    <td>{ltp(r.putLTP)}</td>
                    <td className="t2">{r.putIV.toFixed(1)}</td>
                    <td className={r.putChg >= 0 ? "c-long" : "c-short"}>
                      {r.putChg >= 0 ? "+" : MINUS}
                      {fmtCompact(Math.abs(r.putChg))}
                    </td>
                    <td className={`ochain__oi ochain__oi--put ${!itmCall && r.strike > t.price ? "is-itm" : ""}`}>
                      <i style={{ width: `${(r.putOI / maxOI) * 100}%` }} />
                      <span>{fmtCompact(r.putOI)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="ev__fine">{ch.lotNote} Premiums are model prices (Black-Scholes on the shown IV). Simulated.</p>
      </div>
      <BuildUpBlock inst={inst} price={t.price} />
    </>
  );
}

function BuildUpBlock({ inst, price }: { inst: Instrument; price: number }) {
  const bu = buildUp(inst, price);
  const oi = futuresOIChange(inst, price);
  const all: BuildUp[] = ["Long build-up", "Short build-up", "Short covering", "Long unwinding"];
  return (
    <div className="ev__block">
      <p className="eyebrow">OI build-up · futures</p>
      <p className="bu__now">
        <b className="serif">{bu}</b>{" "}
        <span className="mono t2">
          price {price >= inst.prevClose ? "▲" : "▼"} · OI {oi >= 0 ? "▲" : "▼"} {fmtSigned(oi, 1)}%
        </span>
      </p>
      <ul className="bu">
        {all.map((k) => (
          <li key={k} className={k === bu ? "is-on" : ""}>
            <b>{k}</b>
            <span>{BUILDUP_EXPLAIN[k]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CryptoDerivBlock({ inst, price }: { inst: Instrument; price: number }) {
  const c = useMemo(() => cryptoDerivs(inst, inst.price), [inst]);
  const maxLiq = Math.max(...c.liqClusters.map((l) => l.usd));
  return (
    <>
      <Bullets items={cryptoBullets(c, inst)} />
      <dl className="stat-grid stat-grid--4 mono ev__stats">
        <div>
          <dt>Funding / 8h</dt>
          <dd className={c.funding > 0.02 ? "c-short" : ""}>{fmtSigned(c.funding, 4)}%</dd>
        </div>
        <div>
          <dt>Perp OI</dt>
          <dd>${fmtCompact(c.perpOI)}</dd>
        </div>
        <div>
          <dt>OI 24h</dt>
          <dd className={c.oiChg24h >= 0 ? "c-long" : "c-short"}>{fmtSigned(c.oiChg24h, 1)}%</dd>
        </div>
        <div>
          <dt>Long / short</dt>
          <dd>{c.longShort.toFixed(2)}</dd>
        </div>
      </dl>
      <div className="ev__cols">
        <div className="ev__block">
          <p className="eyebrow">Liquidation clusters</p>
          <ul className="liq mono">
            {c.liqClusters.map((l, i) => {
              const above = l.price > price;
              return (
                <li key={i} className={above ? "is-up" : "is-down"}>
                  <span>{dp(inst, l.price)}</span>
                  <span className="liq__bar">
                    <i style={{ width: `${(l.usd / maxLiq) * 100}%` }} />
                  </span>
                  <span className="t2">
                    ${fmtCompact(l.usd)} {l.side}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="ev__fine">Estimated liquidation notional by price (simulated heatmap buckets).</p>
        </div>
        <div className="ev__block">
          <p className="eyebrow">Basis & funding</p>
          <dl className="stat-grid mono">
            <div>
              <dt>Annualised basis</dt>
              <dd>{c.basis.toFixed(1)}%</dd>
            </div>
            <div>
              <dt>Funding read</dt>
              <dd className="t2" style={{ fontFamily: "var(--font-ui)" }}>
                {c.fundingNote}
              </dd>
            </div>
          </dl>
          <p className="ev__fine">Crypto has no listed option chain in this prototype; perps carry the positioning signal.</p>
        </div>
      </div>
    </>
  );
}

function PositioningBlock({ inst, pos }: { inst: Instrument; pos: ReturnType<typeof positioning> }) {
  const max = Math.max(...pos.groups.map((g) => Math.abs(g.net)));
  return (
    <div className="ev__block">
      <p className="eyebrow">COT-style positioning</p>
      <ul className="cot mono">
        {pos.groups.map((g) => (
          <li key={g.name}>
            <span className="cot__name">{g.name}</span>
            <span className="cot__bar">
              <i
                className={g.net >= 0 ? "is-long" : "is-short"}
                style={g.net >= 0 ? { left: "50%", width: `${(g.net / max) * 50}%` } : { right: "50%", width: `${(-g.net / max) * 50}%` }}
              />
            </span>
            <span className={g.net >= 0 ? "c-long" : "c-short"}>
              {g.net >= 0 ? "+" : MINUS}
              {fmtCompact(Math.abs(g.net))}
            </span>
            <span className="t3">
              w/w {g.wow >= 0 ? "+" : MINUS}
              {fmtCompact(Math.abs(g.wow))}
            </span>
          </li>
        ))}
      </ul>
      <p className="ev__fine">
        {pos.contract} · OI {fmtCompact(pos.oi)} {pos.unit} ({fmtSigned(pos.oiChgPct, 1)}% w/w) · {pos.venue}
        {inst.assetClass === "fx" ? "" : ""}
      </p>
    </div>
  );
}

/* ---------------- fundamentals ---------------- */
function FundLayer({ inst }: { inst: Instrument }) {
  const f = useMemo(() => fundamentals(inst), [inst]);
  if (f.kind === "na") {
    return (
      <div className="na-state hatch">
        <p className="na-state__tag mono">N/A</p>
        <p className="na-state__title serif">Not applicable.</p>
        <p>{f.reason}</p>
        <p className="t2">{f.instead}</p>
      </div>
    );
  }
  return (
    <>
      <Bullets items={fundBullets(f, inst)} />
      {f.kind === "equity" && (
        <div className="ev__cols">
          <div className="ev__block">
            <p className="eyebrow">Valuation · growth · quality</p>
            <dl className="stat-grid stat-grid--3 mono">
              <div>
                <dt>P/E</dt>
                <dd>{f.pe.toFixed(1)}</dd>
              </div>
              <div>
                <dt>Sector P/E</dt>
                <dd className="t2">{f.sectorPe.toFixed(1)}</dd>
              </div>
              <div>
                <dt>P/B</dt>
                <dd>{f.pb.toFixed(1)}</dd>
              </div>
              <div>
                <dt>EV/EBITDA</dt>
                <dd>{f.evEbitda ? f.evEbitda.toFixed(1) : "n/m (bank)"}</dd>
              </div>
              <div>
                <dt>Revenue YoY</dt>
                <dd className={f.revGrowth >= 0 ? "c-long" : "c-short"}>{fmtSigned(f.revGrowth, 1)}%</dd>
              </div>
              <div>
                <dt>EPS YoY</dt>
                <dd className={f.epsGrowth >= 0 ? "c-long" : "c-short"}>{fmtSigned(f.epsGrowth, 1)}%</dd>
              </div>
              <div>
                <dt>ROE</dt>
                <dd>{f.roe.toFixed(1)}%</dd>
              </div>
              <div>
                <dt>Debt / equity</dt>
                <dd>{f.debtEquity ? f.debtEquity.toFixed(2) : "n/m (bank)"}</dd>
              </div>
              <div>
                <dt>{f.opMargin ? "Op. / net margin" : "Net margin"}</dt>
                <dd>{f.opMargin ? `${f.opMargin.toFixed(1)} / ${f.netMargin.toFixed(1)}%` : `${f.netMargin.toFixed(1)}%`}</dd>
              </div>
            </dl>
          </div>
          <div className="ev__block">
            <p className="eyebrow">Shareholding</p>
            <ul className="holders mono">
              {f.holders.map((h) => (
                <li key={h.label}>
                  <span className="holders__lab">{h.label}</span>
                  <span className="holders__bar">
                    <i style={{ width: `${h.pct}%` }} />
                  </span>
                  <span>{h.pct.toFixed(1)}%</span>
                  <span className={h.chg > 0 ? "c-long" : h.chg < 0 ? "c-short" : "t3"}>{fmtSigned(h.chg, 1)}</span>
                </li>
              ))}
            </ul>
            <p className={`earn ${f.earningsInDays <= 5 ? "is-soon" : ""}`}>
              <span className="eyebrow">Next earnings</span>
              <b className="mono">in {f.earningsInDays} days</b>
              <span className="t2">{f.earningsNote}</span>
            </p>
            <p className="ev__fine">{f.sector} · quarter-on-quarter change in pp · simulated.</p>
          </div>
        </div>
      )}
      {f.kind === "index" && (
        <div className="ev__cols">
          <div className="ev__block">
            <p className="eyebrow">Valuation</p>
            <dl className="stat-grid mono">
              <div>
                <dt>Index P/E</dt>
                <dd>{f.pe.toFixed(1)}</dd>
              </div>
              <div>
                <dt>5-year avg</dt>
                <dd className="t2">{f.pe5yAvg.toFixed(1)}</dd>
              </div>
              <div>
                <dt>P/B</dt>
                <dd>{f.pb.toFixed(1)}</dd>
              </div>
              <div>
                <dt>Dividend yield</dt>
                <dd>{f.divYield.toFixed(1)}%</dd>
              </div>
            </dl>
          </div>
          <div className="ev__block">
            <p className="eyebrow">Breadth</p>
            <div className="breadth">
              <div className="breadth__bar">
                <i className="breadth__adv" style={{ width: `${(f.advancers / f.constituents) * 100}%` }} />
              </div>
              <p className="mono breadth__lab">
                <span className="c-long">▲ {f.advancers} advancing</span>
                <span className="c-short">▼ {f.decliners} declining</span>
              </p>
            </div>
            <dl className="stat-grid mono">
              <div>
                <dt>Above 50-DMA</dt>
                <dd>{f.above50dma}%</dd>
              </div>
              <div>
                <dt>Above 200-DMA</dt>
                <dd>{f.above200dma}%</dd>
              </div>
            </dl>
          </div>
        </div>
      )}
      {f.kind === "fx" && (
        <div className="ev__block">
          <p className="eyebrow">Rates & inflation</p>
          <div className="scroll-x">
            <table className="dtable mono">
              <thead>
                <tr>
                  <th>Currency</th>
                  <th>Central bank</th>
                  <th className="r">Policy rate</th>
                  <th className="r">CPI YoY</th>
                  <th className="r">Real rate</th>
                </tr>
              </thead>
              <tbody>
                {[f.base, f.quote].map((c) => (
                  <tr key={c.ccy}>
                    <td>{c.ccy}</td>
                    <td className="t2">{c.bank}</td>
                    <td className="r">{c.rate.toFixed(2)}%</td>
                    <td className="r">{c.cpi.toFixed(1)}%</td>
                    <td className="r">{fmtSigned(c.rate - c.cpi, 2)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="ev__fine">
            Rate differential {fmtSigned(f.base.rate - f.quote.rate, 2)} pp · 2y spread {fmtSigned(f.spread2y, 2)} pp · {f.spreadTrend}. Simulated.
          </p>
        </div>
      )}
      {f.kind === "commodity" && (
        <div className="ev__block">
          <p className="eyebrow">Inventories · supply & demand</p>
          <table className="dtable">
            <tbody>
              {f.rows.map((r) => (
                <tr key={r.label}>
                  <td className="t2">{r.label}</td>
                  <td className="mono r">{r.value}</td>
                  <td className="r">
                    <span className={`read read--${r.read}`}>{r.read}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="ev__fine">“Supportive” and “pressure” are relative to price. Simulated.</p>
        </div>
      )}
    </>
  );
}

/* ---------------- context ---------------- */
function ContextLayer({ inst }: { inst: Instrument }) {
  const news = useMemo(() => headlines(inst), [inst]);
  const cal = useMemo(() => calendar(inst), [inst]);
  const corr = useMemo(() => correlations(inst), [inst]);
  return (
    <>
      <Bullets items={contextBullets(inst, news, cal, corr)} />
      <div className="ev__cols">
        <div className="ev__block">
          <p className="eyebrow">
            Headlines <span className="chip chip--hash">simulated</span>
          </p>
          <ul className="news">
            {news.map((n, i) => (
              <li key={i}>
                <span className={`sent sent--${n.sentiment}`}>
                  {n.sentiment === "bullish" ? "▲" : n.sentiment === "bearish" ? "▼" : "•"} {n.sentiment}
                </span>
                <p>{n.text}</p>
                <span className="mono t3">
                  {n.source} · {n.minsAgo < 60 ? `${n.minsAgo}m` : `${Math.floor(n.minsAgo / 60)}h`} ago
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="ev__block">
          <p className="eyebrow">Macro calendar</p>
          <table className="dtable">
            <tbody>
              {cal.map((e) => (
                <tr key={e.name}>
                  <td className="mono t2">{e.inDays === 0 ? "Today" : `+${e.inDays}d`}</td>
                  <td>{e.name}</td>
                  <td className="r">
                    <span className={`read ${e.impact === "High" ? "read--pressure" : "read--neutral"}`}>{e.impact}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="eyebrow" style={{ marginTop: 16 }}>
            Cross-asset correlation · 60d
          </p>
          <div className="corr">
            {corr.map((c) => {
              const peer = getInstrument(c.symbol);
              return (
                <Link key={c.symbol} to={`/app/i/${c.symbol}`} className="corr__chip mono" title={peer?.name}>
                  {c.symbol}
                  <b className={c.corr >= 0 ? "c-long" : "c-short"}>
                    {c.corr >= 0 ? "+" : MINUS}
                    {Math.abs(c.corr).toFixed(2)}
                  </b>
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
