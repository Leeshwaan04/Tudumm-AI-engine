import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowUp } from "lucide-react";
import { regimeLabel } from "../../components/SignalCard";
import { SessionChip } from "../../components/ui";
import { useDocumentTitle } from "../../components/hooks";
import { instruments, instrumentsIn, MARKET_LABEL, MARKET_ORDER, MARKET_SHORT } from "../../engine/universe";
import type { Instrument, LiveStatus } from "../../engine/types";
import { isTrade } from "../../engine/types";
import { useAllTicks, useStatuses, type Tick } from "../../engine/live";
import { MARKET_SESSION } from "../../engine/sessions";
import { fmtPrice, fmtSignedPct } from "../../engine/format";
import { marketRegime } from "./Signals";
import { useDataset } from "../../engine/universe";
import { useData } from "../../components/DataProvider";
import { EngineTag, FreshnessBadge, LiveUnavailable } from "../../components/badges";

type View = "heatmap" | "table";
type SortKey = "symbol" | "market" | "chg" | "conf";

function chgOf(inst: Instrument, ticks: Record<string, Tick>) {
  const p = ticks[inst.symbol]?.price ?? inst.price;
  return ((p - inst.prevClose) / inst.prevClose) * 100;
}
function heatBg(chg: number): string {
  const a = Math.min(1, Math.abs(chg) / 2.2);
  return chg >= 0 ? `rgba(61, 214, 140, ${0.06 + a * 0.42})` : `rgba(255, 92, 77, ${0.06 + a * 0.42})`;
}

export default function Markets() {
  useDocumentTitle("Markets · Tudumm");
  useDataset();
  const data = useData();
  const [view, setView] = useState<View>("heatmap");
  const ticks = useAllTicks();
  const statuses = useStatuses();
  return (
    <div className="mkp">
      <header className="phead">
        <div>
          <p className="eyebrow phead__eyebrow">
            Markets · live beta <EngineTag />
          </p>
          <h1 className="phead__title serif">
            {instruments.length} instruments, <em>six markets.</em>
          </h1>
          <p className="phead__note">Every price shows whether it is real-time or delayed.</p>
        </div>
        <div className="mkp__tools">
          <div className="seg" role="group" aria-label="View">
            <button type="button" aria-pressed={view === "heatmap"} onClick={() => setView("heatmap")}>
              Heatmap
            </button>
            <button type="button" aria-pressed={view === "table"} onClick={() => setView("table")}>
              Table
            </button>
          </div>
          <div className="heat-legend mono" aria-label="Colour scale: change versus previous close">
            <span>{"−2%"}</span>
            <i />
            <span>+2%</span>
          </div>
        </div>
      </header>
      {data.phase !== "ready" ? (
        <LiveUnavailable />
      ) : view === "heatmap" ? (
        <Heatmap ticks={ticks} statuses={statuses} />
      ) : (
        <MarketTable ticks={ticks} statuses={statuses} />
      )}
    </div>
  );
}

function SignalBadge({ inst, status }: { inst: Instrument; status: LiveStatus }) {
  const s = inst.signal;
  if (status === "sit_out" || !isTrade(s)) return <span className="sbadge sbadge--sit mono">SITTING OUT</span>;
  return (
    <span className={`sbadge mono sbadge--${s.direction === "LONG" ? "long" : "short"}`}>
      {s.direction === "LONG" ? "▲" : "▼"} {s.direction} <b>{Math.round(s.confidence * 100)}%</b>
    </span>
  );
}

function Heatmap({ ticks, statuses }: { ticks: Record<string, Tick>; statuses: Record<string, LiveStatus> }) {
  const data = useData();
  return (
    <div className="hmap">
      {MARKET_ORDER.map((m) => {
        const list = instrumentsIn(m);
        const waiting = data.unavailable.filter((u) => u.market === m);
        if (!list.length) {
          if (!waiting.length) return null;
          return (
            <section key={m} className="hmap__mkt hmap__mkt--narrow" aria-label={MARKET_LABEL[m]}>
              <header className="hmap__head">
                <h2 className="serif">{MARKET_LABEL[m]}</h2>
                <span className="hmap__reg serif">No data yet</span>
                <SessionChip k={MARKET_SESSION[m]} />
              </header>
              <p className="hmap__na">
                {waiting.map((w) => w.symbol).join(", ")}: {waiting[0].reason}
              </p>
            </section>
          );
        }
        const liveN = list.filter((i) => ["active", "pending", "t1_hit"].includes(statuses[i.symbol])).length;
        return (
          <section key={m} className={`hmap__mkt hmap__mkt--${list.length > 4 ? "wide" : "narrow"}`} aria-label={MARKET_LABEL[m]}>
            <header className="hmap__head">
              <h2 className="serif">{MARKET_LABEL[m]}</h2>
              <span className="hmap__reg serif">{regimeLabel(marketRegime(m))}</span>
              <span className="mono t3 hmap__n">
                {liveN} live · {list.filter((i) => statuses[i.symbol] === "sit_out").length} out
              </span>
              <SessionChip k={MARKET_SESSION[m]} />
            </header>
            <div className="hmap__tiles">
              {list.map((inst) => {
                const chg = chgOf(inst, ticks);
                const t = ticks[inst.symbol];
                return (
                  <Link key={inst.symbol} to={`/app/i/${inst.symbol}`} className="tile" style={{ background: heatBg(chg) }}>
                    <span className="tile__top">
                      <b className="mono">{inst.symbol}</b>
                      <span className={`mono tile__chg ${chg >= 0 ? "c-long" : "c-short"}`}>
                        {chg >= 0 ? "▲" : "▼"} {fmtSignedPct(chg)}
                      </span>
                    </span>
                    <span className="tile__name">{inst.name}</span>
                    <span className="tile__px mono">
                      {fmtPrice(inst, t?.price ?? inst.price)} <FreshnessBadge inst={inst} compact />
                    </span>
                    <SignalBadge inst={inst} status={statuses[inst.symbol]} />
                  </Link>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function MarketTable({ ticks, statuses }: { ticks: Record<string, Tick>; statuses: Record<string, LiveStatus> }) {
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: "market", dir: 1 });
  const rows = useMemo(() => {
    const conf = (i: Instrument) => (isTrade(i.signal) && statuses[i.symbol] !== "sit_out" ? i.signal.confidence : -1);
    const val = (i: Instrument): number | string =>
      sort.k === "symbol" ? i.symbol : sort.k === "market" ? MARKET_ORDER.indexOf(i.market) : sort.k === "chg" ? chgOf(i, ticks) : conf(i);
    return [...instruments].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      const c = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return c * sort.dir;
    });
  }, [sort, ticks, statuses]);
  const th = (k: SortKey, label: string, right = false) => (
    <th className={right ? "r" : ""} aria-sort={sort.k === k ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button type="button" className="th-sort" onClick={() => setSort((s) => ({ k, dir: s.k === k ? ((-s.dir) as 1 | -1) : k === "symbol" || k === "market" ? 1 : -1 }))}>
        {label}
        {sort.k === k && (sort.dir === 1 ? <ArrowUp size={11} aria-hidden="true" /> : <ArrowDown size={11} aria-hidden="true" />)}
      </button>
    </th>
  );
  return (
    <div className="panel">
      <div className="scroll-x">
        <table className="dtable mono mtable">
          <thead>
            <tr>
              {th("symbol", "Symbol")}
              {th("market", "Market")}
              <th className="r">Price</th>
              {th("chg", "Chg %", true)}
              <th>Signal</th>
              {th("conf", "Confidence", true)}
              <th>Regime</th>
              <th>Data</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((inst) => {
              const chg = chgOf(inst, ticks);
              const st = statuses[inst.symbol];
              const s = inst.signal;
              const px = ticks[inst.symbol]?.price ?? inst.price;
              return (
                <tr key={inst.symbol}>
                  <td>
                    <Link to={`/app/i/${inst.symbol}`} className="mtable__sym">
                      <b>{inst.symbol}</b> <span className="t3">{inst.name}</span>
                    </Link>
                  </td>
                  <td className="t2">{MARKET_SHORT[inst.market]}</td>
                  <td className="r">{fmtPrice(inst, px)}</td>
                  <td className={`r ${chg >= 0 ? "c-long" : "c-short"}`}>
                    {chg >= 0 ? "▲" : "▼"} {fmtSignedPct(chg)}
                  </td>
                  <td>
                    <SignalBadge inst={inst} status={st} />
                  </td>
                  <td className="r">{isTrade(s) && st !== "sit_out" ? `${Math.round(s.confidence * 100)}%` : <span className="t3">—</span>}</td>
                  <td className="t2" style={{ fontFamily: "var(--font-ui)" }}>
                    {regimeLabel(s.regime)}
                  </td>
                  <td className="t2" style={{ fontFamily: "var(--font-ui)" }}>
                    <FreshnessBadge inst={inst} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
