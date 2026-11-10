import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, ChevronRight, Copy, FlaskConical, RotateCcw, ShieldAlert, ShieldCheck } from "lucide-react";
import { EquityCurve } from "../../components/charts";
import { EmptyState, toast } from "../../components/ui";
import { useDocumentTitle, useReducedMotion } from "../../components/hooks";
import { getInstrument, ledger as LEDGER, MARKET_ORDER, MARKET_SHORT, seed, STYLE_LABEL } from "../../engine/seed";
import type { LedgerEntry, MarketId, Outcome, Style } from "../../engine/types";
import { breakdown, computeStats, equityCurve, hasWebCrypto, monthlyGrid, verifyChain, type VerifyResult } from "../../engine/ledger";
import { fmtLevel, MINUS, shortHash } from "../../engine/format";

const GENESIS = seed.meta.ledgerGenesisPrevHash;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const OUTCOME_LABEL: Record<Outcome, string> = { target: "Target", trailed: "Trailed", expired: "Expired", stopped: "Stopped" };
const PAGE = 20;

const signedR = (v: number, d = 2) => `${v > 0 ? "+" : v < 0 ? MINUS : ""}${Math.abs(v).toFixed(d)}R`;
function fmtL(e: LedgerEntry, v: number) {
  const inst = getInstrument(e.symbol);
  return inst ? fmtLevel(inst, v) : String(v);
}

type CellState = "idle" | "ok" | "bad" | "skip";

export default function Proof() {
  useDocumentTitle("Proof · Tudumm");
  const stats = useMemo(() => computeStats(LEDGER), []);
  const curve = useMemo(() => equityCurve(LEDGER), []);
  const grid = useMemo(() => monthlyGrid(LEDGER), []);

  // working copy for the tamper test (in memory only)
  const [entries, setEntries] = useState<LedgerEntry[]>(LEDGER);
  const [tampered, setTampered] = useState<{ id: string; from: number; to: number } | null>(null);
  const [cells, setCells] = useState<CellState[]>(() => LEDGER.map(() => "idle"));
  const [running, setRunning] = useState(false);
  const [cursor, setCursor] = useState<{ id: string; hash: string } | null>(null);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const cancel = useRef({ cancelled: false });
  const reduced = useReducedMotion();

  useEffect(() => () => void (cancel.current.cancelled = true), []);

  const runVerify = async () => {
    cancel.current.cancelled = true;
    const token = { cancelled: false };
    cancel.current = token;
    setRunning(true);
    setResult(null);
    const next: CellState[] = entries.map(() => "idle");
    setCells(next);
    let lastPaint = 0;
    const res = await verifyChain(entries, GENESIS, {
      paceMs: reduced ? 0 : 14,
      batch: 4,
      signal: token,
      onStep: (s) => {
        next[s.index] = s.ok ? "ok" : "bad";
        const now = performance.now();
        if (!s.ok || now - lastPaint > 30) {
          lastPaint = now;
          setCells([...next]);
          setCursor({ id: s.id, hash: s.computed });
        }
      },
    });
    if (token.cancelled) return;
    if (!res.ok && res.breakAt) for (let i = res.breakAt.index + 1; i < next.length; i++) next[i] = "skip";
    setCells([...next]);
    setResult(res);
    setRunning(false);
  };

  const applyTamper = (id: string, exit: number) => {
    const base = LEDGER.find((e) => e.id === id);
    if (!base) return;
    setEntries(LEDGER.map((e) => (e.id === id ? { ...e, exit } : e)));
    setTampered({ id, from: base.exit, to: exit });
    setResult(null);
    setCells(LEDGER.map(() => "idle"));
    toast(`${id} exit edited in memory: ${fmtL(base, base.exit)} → ${fmtL(base, exit)}. Now verify the chain.`);
  };
  const resetTamper = () => {
    cancel.current.cancelled = true;
    setRunning(false);
    setEntries(LEDGER);
    setTampered(null);
    setResult(null);
    setCells(LEDGER.map(() => "idle"));
    setCursor(null);
  };

  const kpis: [string, string, string?][] = [
    ["Closed calls", String(stats.count)],
    ["Win rate", `${(stats.winRate * 100).toFixed(1)}%`],
    ["Avg win", signedR(stats.avgWin), "c-long"],
    ["Avg loss", signedR(stats.avgLoss), "c-short"],
    ["Expectancy / call", signedR(stats.expectancy), "c-brand"],
    ["Profit factor", stats.profitFactor.toFixed(2)],
    ["Total", signedR(stats.totalR, 1)],
    ["Max drawdown", signedR(stats.maxDrawdown, 1), "c-short"],
  ];

  return (
    <div className="proof">
      <header className="phead">
        <div>
          <p className="eyebrow">Proof · track record</p>
          <h1 className="phead__title serif">
            Every call, <em>on the record.</em>
          </h1>
        </div>
        <div className="proof__intro">
          <p className="phead__note">
            This demo ledger is simulated. In production, each call is hashed at the moment it’s issued and the chain head is published so
            anyone can audit it.
          </p>
          <div className="proof__chips">
            <span className="chip chip--brand">Simulated demo ledger</span>
            <span className="chip">SHA-256 · hash-chained</span>
            <span className="chip chip--hash">
              head {shortHash(LEDGER[LEDGER.length - 1].hash, 10)}…
            </span>
          </div>
        </div>
      </header>

      <dl className="pkpis mono">
        {kpis.map(([k, v, cls]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className={cls}>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="proof__fine">All figures are computed in your browser from the {LEDGER.length} ledger entries below. Win = R above zero.</p>

      <ChainPanel
        entries={entries}
        cells={cells}
        running={running}
        cursor={cursor}
        result={result}
        tampered={tampered}
        onVerify={runVerify}
        onTamper={applyTamper}
        onReset={resetTamper}
      />

      <section className="panel proof__chart">
        <header className="panel__head">
          <span className="eyebrow">Cumulative R and drawdown</span>
          <span className="mono t3 proof__meta">
            {curve.length} closed calls · {new Date(curve[0].t).toLocaleDateString("en-GB", { month: "short", year: "numeric" })} →{" "}
            {new Date(curve[curve.length - 1].t).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}
          </span>
        </header>
        <div className="panel__body">
          <EquityCurve points={curve} height={280} drawdown ddHeight={110} />
        </div>
      </section>

      <div className="proof__two">
        <MonthlyHeatmap grid={grid} />
        <Breakdowns />
      </div>

      <LedgerTable entries={entries} cells={cells} tamperedId={tampered?.id ?? null} onPickTamper={(id) => {
          setPick(id);
          document.getElementById("tamper")?.scrollIntoView({ behavior: "smooth", block: "center" });
        }}
      />
    </div>
  );
}

/* tamper pick is shared between table and panel via a tiny module-level store */
const pickListeners = new Set<(id: string) => void>();
function setPick(id: string) {
  pickListeners.forEach((l) => l(id));
}
function usePick(initial: string): [string, (id: string) => void] {
  const [v, setV] = useState(initial);
  useEffect(() => {
    const l = (id: string) => setV(id);
    pickListeners.add(l);
    return () => {
      pickListeners.delete(l);
    };
  }, []);
  return [v, setV];
}

/* ---------------- chain panel ---------------- */
function ChainPanel({
  entries,
  cells,
  running,
  cursor,
  result,
  tampered,
  onVerify,
  onTamper,
  onReset,
}: {
  entries: LedgerEntry[];
  cells: CellState[];
  running: boolean;
  cursor: { id: string; hash: string } | null;
  result: VerifyResult | null;
  tampered: { id: string; from: number; to: number } | null;
  onVerify: () => void;
  onTamper: (id: string, exit: number) => void;
  onReset: () => void;
}) {
  const [pick, setPickLocal] = usePick("T00157");
  const base = LEDGER.find((e) => e.id === pick) ?? LEDGER[156];
  const [exitStr, setExitStr] = useState("");
  useEffect(() => {
    const bumped = base.exit * 1.012;
    const inst = getInstrument(base.symbol);
    const d = inst?.decimals ?? 2;
    setExitStr(bumped.toFixed(d));
  }, [base]);
  const exit = Number(exitStr);
  const exitOk = Number.isFinite(exit) && exit > 0 && exit !== base.exit;
  const done = cells.filter((c) => c === "ok").length;
  const head = entries[entries.length - 1].hash;

  return (
    <section className="panel chain" aria-label="Chain verification">
      <div className="chain__main">
        <div className="chain__head">
          <div>
            <p className="eyebrow">Verify the chain</p>
            <h2 className="chain__title serif">
              Recompute all {entries.length} hashes <em>in your browser.</em>
            </h2>
            <p className="chain__copy">
              Each entry’s hash is SHA-256 of its previous hash plus its id, times, symbol, direction, entry, stop, target, exit and R. Edit
              any one of those and every hash after it stops matching.
            </p>
          </div>
          <div className="chain__acts">
            <button type="button" className="btn btn--primary" onClick={onVerify} disabled={running}>
              <ShieldCheck size={15} aria-hidden="true" /> {running ? "Verifying…" : result ? "Verify again" : "Verify chain"}
            </button>
          </div>
        </div>

        <div className="tape" role="img" aria-label={`Verification progress: ${done} of ${entries.length} entries verified`}>
          {cells.map((c, i) => (
            <i key={i} className={`tape__c is-${c} ${tampered && entries[i].id === tampered.id ? "is-edited" : ""}`} title={entries[i].id} />
          ))}
        </div>

        <div className={`chain__status mono ${result ? (result.ok ? "is-ok" : "is-bad") : ""}`} aria-live="polite">
          {running && cursor && (
            <>
              <span className="chain__spin" aria-hidden="true" /> {done}/{entries.length} · {cursor.id} · {shortHash(cursor.hash, 16)}…
            </>
          )}
          {!running && !result && (
            <>
              {tampered ? (
                <span className="c-short">
                  {tampered.id} was edited in memory. Run the verification to see where the chain breaks.
                </span>
              ) : (
                <span className="t2">Not verified yet in this session. Hash engine: {hasWebCrypto ? "Web Crypto (SHA-256)" : "JS fallback (SHA-256)"}.</span>
              )}
            </>
          )}
          {result?.ok && (
            <>
              <ShieldCheck size={16} aria-hidden="true" />
              <b>Chain intact</b> · {result.verified}/{result.total} · head {shortHash(result.head, 6)}… · {result.engine} · {result.ms.toFixed(0)} ms
            </>
          )}
          {result && !result.ok && result.breakAt && (
            <>
              <ShieldAlert size={16} aria-hidden="true" />
              <b>Chain broken at {result.breakAt.id}</b> · row {result.breakAt.index + 1} of {result.total} · {result.verified} verified before it ·
              stored {shortHash(result.breakAt.stored, 8)}… ≠ recomputed {shortHash(result.breakAt.computed, 8)}…
            </>
          )}
        </div>
        <div className="chain__head-hash mono">
          <span className="t3">Published head (from seed)</span>
          <span className="chain__hash">{head}</span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() =>
              navigator.clipboard?.writeText(head).then(
                () => toast("Chain head copied"),
                () => toast("Copy blocked by the browser"),
              ) ?? toast("Copy isn’t available here")
            }
          >
            <Copy size={13} aria-hidden="true" /> Copy
          </button>
        </div>
      </div>

      <div className="chain__tamper" id="tamper">
        <p className="eyebrow">
          <FlaskConical size={12} aria-hidden="true" /> Tamper test
        </p>
        <p className="chain__copy">Change one closed trade’s exit price in memory, then verify. The break lands on exactly that row.</p>
        <label className="field">
          <span>Ledger entry</span>
          <select className="select mono" value={pick} onChange={(e) => setPickLocal(e.target.value)} disabled={running}>
            {LEDGER.map((e) => (
              <option key={e.id} value={e.id}>
                {e.id} · {e.symbol} · {e.direction} · {OUTCOME_LABEL[e.outcome]}
              </option>
            ))}
          </select>
        </label>
        <dl className="chain__row mono">
          <div>
            <dt>Entry</dt>
            <dd>{fmtL(base, base.entry)}</dd>
          </div>
          <div>
            <dt>Stop</dt>
            <dd>{fmtL(base, base.stop)}</dd>
          </div>
          <div>
            <dt>Exit (stored)</dt>
            <dd>{fmtL(base, base.exit)}</dd>
          </div>
          <div>
            <dt>R</dt>
            <dd className={base.r >= 0 ? "c-long" : "c-short"}>{signedR(base.r)}</dd>
          </div>
        </dl>
        <label className="field">
          <span>New exit price</span>
          <input className="input mono" inputMode="decimal" value={exitStr} onChange={(e) => setExitStr(e.target.value)} disabled={running} aria-invalid={!exitOk} />
        </label>
        <div className="chain__tacts">
          <button type="button" className="btn btn--danger" disabled={!exitOk || running} onClick={() => onTamper(base.id, exit)}>
            <FlaskConical size={14} aria-hidden="true" /> Apply tamper
          </button>
          <button type="button" className="btn" disabled={!tampered && !result} onClick={onReset}>
            <RotateCcw size={14} aria-hidden="true" /> Reset
          </button>
        </div>
        {tampered && (
          <p className="chain__note">
            <b className="mono">{tampered.id}</b> exit {fmtL(base, tampered.from)} → <span className="c-short mono">{fmtL(base, tampered.to)}</span>. Nothing
            is saved; Reset restores the original ledger.
          </p>
        )}
        {!exitOk && exitStr !== "" && <p className="chain__warn">Enter a positive price that differs from the stored exit.</p>}
      </div>
    </section>
  );
}

/* ---------------- monthly heatmap ---------------- */
function MonthlyHeatmap({ grid }: { grid: ReturnType<typeof monthlyGrid> }) {
  const max = Math.max(...[...grid.cells.values()].map((c) => Math.abs(c.r)), 1);
  const last = LEDGER.reduce((m, e) => Math.max(m, Date.parse(e.closedAt)), 0);
  const lastD = new Date(last);
  return (
    <section className="panel heat" aria-label="Monthly R heatmap">
      <header className="panel__head">
        <span className="eyebrow">Monthly R</span>
        <span className="mono t3 proof__meta">sum of R per month (closed date, UTC)</span>
      </header>
      <div className="panel__body scroll-x">
        <table className="heat__t mono">
          <thead>
            <tr>
              <th />
              {MONTHS.map((m) => (
                <th key={m}>{m}</th>
              ))}
              <th className="heat__yr">Year</th>
            </tr>
          </thead>
          <tbody>
            {grid.years.map((y) => {
              const total = MONTHS.reduce((a, _, m) => a + (grid.cells.get(`${y}-${m}`)?.r ?? 0), 0);
              return (
                <tr key={y}>
                  <th>{y}</th>
                  {MONTHS.map((_, m) => {
                    const c = grid.cells.get(`${y}-${m}`);
                    const future = y > lastD.getUTCFullYear() || (y === lastD.getUTCFullYear() && m > lastD.getUTCMonth());
                    if (!c)
                      return (
                        <td key={m} className={`heat__c ${future ? "is-future hatch" : "is-empty"}`} title={future ? "Not yet" : "No closed calls"}>
                          {future ? "" : "0"}
                        </td>
                      );
                    const a = Math.min(1, Math.abs(c.r) / max);
                    const bg = c.r >= 0 ? `rgba(61, 214, 140, ${0.08 + a * 0.5})` : `rgba(255, 92, 77, ${0.08 + a * 0.5})`;
                    return (
                      <td key={m} className="heat__c" style={{ background: bg }} title={`${MONTHS[m]} ${y}: ${signedR(c.r, 1)} over ${c.n} calls`}>
                        {c.r > 0 ? "+" : c.r < 0 ? MINUS : ""}
                        {Math.abs(c.r).toFixed(1)}
                      </td>
                    );
                  })}
                  <td className={`heat__yr ${total >= 0 ? "c-long" : "c-short"}`}>{signedR(total, 1)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="proof__fine">Hatched cells are months that haven’t happened yet. Partial month: {MONTHS[lastD.getUTCMonth()]} {lastD.getUTCFullYear()}.</p>
      </div>
    </section>
  );
}

/* ---------------- breakdowns ---------------- */
type BKey = "market" | "style" | "strategy";
function Breakdowns() {
  const [k, setK] = useState<BKey>("market");
  const rows = useMemo(
    () =>
      breakdown(LEDGER, (e) => (k === "market" ? e.market : k === "style" ? e.style : e.strategy)).map((r) => ({
        ...r,
        label: k === "market" ? MARKET_SHORT[r.key as MarketId] : k === "style" ? STYLE_LABEL[r.key as Style] : r.key,
      })),
    [k],
  );
  return (
    <section className="panel brk" aria-label="Breakdowns">
      <header className="panel__head">
        <span className="eyebrow">Breakdown</span>
        <div className="seg" role="group" aria-label="Group by">
          {(["market", "style", "strategy"] as BKey[]).map((x) => (
            <button key={x} type="button" aria-pressed={k === x} onClick={() => setK(x)}>
              {x}
            </button>
          ))}
        </div>
      </header>
      <div className="scroll-x brk__scroll">
        <table className="dtable mono">
          <thead>
            <tr>
              <th>{k}</th>
              <th className="r">Calls</th>
              <th className="r">Win rate</th>
              <th className="r">Avg win</th>
              <th className="r">Avg loss</th>
              <th className="r">Expectancy</th>
              <th className="r">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="brk__key">{r.label}</td>
                <td className="r">{r.count}</td>
                <td className="r">{(r.winRate * 100).toFixed(1)}%</td>
                <td className="r c-long">{signedR(r.avgWin)}</td>
                <td className="r c-short">{signedR(r.avgLoss)}</td>
                <td className={`r ${r.expectancy >= 0 ? "c-brand" : "c-short"}`}>{signedR(r.expectancy)}</td>
                <td className="r">{signedR(r.totalR, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ---------------- ledger table ---------------- */
function LedgerTable({
  entries,
  cells,
  tamperedId,
  onPickTamper,
}: {
  entries: LedgerEntry[];
  cells: CellState[];
  tamperedId: string | null;
  onPickTamper: (id: string) => void;
}) {
  const [market, setMarket] = useState<"all" | MarketId>("all");
  const [outcome, setOutcome] = useState<"all" | Outcome>("all");
  const [page, setPage] = useState(0);
  const idx = useMemo(() => new Map(entries.map((e, i) => [e.id, i])), [entries]);
  const rows = useMemo(
    () => [...entries].reverse().filter((e) => (market === "all" || e.market === market) && (outcome === "all" || e.outcome === outcome)),
    [entries, market, outcome],
  );
  useEffect(() => setPage(0), [market, outcome]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const slice = rows.slice(page * PAGE, page * PAGE + PAGE);
  return (
    <section className="panel ledger" aria-label="Ledger">
      <header className="panel__head ledger__head">
        <div>
          <span className="eyebrow">Ledger</span>
          <span className="mono t3 proof__meta"> newest first</span>
        </div>
        <div className="ledger__filters">
          <label className="filters__sel">
            <span className="eyebrow">Market</span>
            <select className="select" value={market} onChange={(e) => setMarket(e.target.value as "all" | MarketId)}>
              <option value="all">All</option>
              {MARKET_ORDER.map((m) => (
                <option key={m} value={m}>
                  {MARKET_SHORT[m]}
                </option>
              ))}
            </select>
          </label>
          <label className="filters__sel">
            <span className="eyebrow">Outcome</span>
            <select className="select" value={outcome} onChange={(e) => setOutcome(e.target.value as "all" | Outcome)}>
              <option value="all">All</option>
              {(Object.keys(OUTCOME_LABEL) as Outcome[]).map((o) => (
                <option key={o} value={o}>
                  {OUTCOME_LABEL[o]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>
      {rows.length === 0 ? (
        <div className="panel__body">
          <EmptyState
            title="No calls match."
            action={
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setMarket("all");
                  setOutcome("all");
                }}
              >
                Clear filters
              </button>
            }
          >
            Try another market or outcome.
          </EmptyState>
        </div>
      ) : (
        <>
          <div className="scroll-x">
            <table className="dtable mono ledger__t">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Issued</th>
                  <th>Symbol</th>
                  <th>Dir</th>
                  <th className="r">Entry</th>
                  <th className="r">Stop</th>
                  <th className="r">Target</th>
                  <th className="r">Exit</th>
                  <th>Outcome</th>
                  <th className="r">R</th>
                  <th>Hash</th>
                  <th>Check</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {slice.map((e) => {
                  const c = cells[idx.get(e.id) ?? 0];
                  const edited = e.id === tamperedId;
                  return (
                    <tr key={e.id} className={edited ? "is-edited" : c === "bad" ? "is-bad" : ""}>
                      <td>{e.id}</td>
                      <td className="t2">{new Date(e.issuedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit", timeZone: "UTC" })}</td>
                      <td>
                        <Link to={`/app/i/${e.symbol}`} className="ledger__sym">
                          {e.symbol}
                        </Link>
                      </td>
                      <td className={e.direction === "LONG" ? "c-long" : "c-short"}>
                        {e.direction === "LONG" ? "▲" : "▼"} {e.direction}
                      </td>
                      <td className="r">{fmtL(e, e.entry)}</td>
                      <td className="r t2">{fmtL(e, e.stop)}</td>
                      <td className="r t2">{fmtL(e, e.target)}</td>
                      <td className={`r ${edited ? "c-short" : ""}`}>
                        {fmtL(e, e.exit)}
                        {edited && <span className="ledger__edited">edited</span>}
                      </td>
                      <td>
                        <span className={`oc oc--${e.outcome}`}>{OUTCOME_LABEL[e.outcome]}</span>
                      </td>
                      <td className={`r ${e.r > 0 ? "c-long" : e.r < 0 ? "c-short" : ""}`}>{signedR(e.r)}</td>
                      <td className="t3" title={e.hash}>
                        {shortHash(e.hash, 8)}
                      </td>
                      <td>
                        {c === "ok" ? <span className="c-long">✓</span> : c === "bad" ? <span className="c-short">✗ break</span> : c === "skip" ? <span className="t3">–</span> : <span className="t3">·</span>}
                      </td>
                      <td>
                        <button type="button" className="btn btn--ghost btn--sm" onClick={() => onPickTamper(e.id)} title={`Use ${e.id} in the tamper test`}>
                          Tamper
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <footer className="ledger__pager mono">
            <span className="t3">
              {page * PAGE + 1}–{Math.min(rows.length, page * PAGE + PAGE)} of {rows.length}
            </span>
            <div className="ledger__pbtns">
              <button type="button" className="btn btn--sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
                <ChevronLeft size={14} />
              </button>
              <span>
                {page + 1} / {pages}
              </span>
              <button type="button" className="btn btn--sm" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
                <ChevronRight size={14} />
              </button>
            </div>
          </footer>
        </>
      )}
    </section>
  );
}
