import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, ChevronRight, Copy, FlaskConical, RefreshCw, RotateCcw, ShieldAlert, ShieldCheck } from "lucide-react";
import { EmptyState, toast } from "../../components/ui";
import { useDocumentTitle } from "../../components/hooks";
import { EngineTag, fmtAsOf } from "../../components/badges";
import { getInstrument } from "../../engine/universe";
import type { Instrument } from "../../engine/types";
import { hasWebCrypto, sha256Hex } from "../../engine/ledger";
import { fmtLevel, MINUS, shortHash } from "../../engine/format";
import { marketApi, type LedgerEntryV2, type LedgerHead } from "../../api/market";
import { track } from "../../api/events";

const signedR = (v: number, d = 2) => `${v > 0 ? "+" : v < 0 ? MINUS : ""}${Math.abs(v).toFixed(d)}R`;

type CellState = "idle" | "ok" | "bad" | "skip";

/** Live ledger only: engine v0's real calls, verified in the browser (no simulated ledger). */
export default function Proof() {
  useDocumentTitle("Proof · Tudumm");
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
            Engine v0’s live calls are hashed onto an append-only chain when they’re published and again when they close. Recompute it yourself below.
          </p>
        </div>
      </header>

      <div className="proof__panel">
        <LiveLedger />
      </div>
    </div>
  );
}

/* =====================================================================
   Live ledger (v2 hash chain, GET /api/v1/market/ledger + /ledger/head)
   ===================================================================== */
const V2_GENESIS = "0".repeat(64);
const JUDGE_MIN = 30;

interface V2Result {
  ok: boolean;
  verified: number;
  total: number;
  headHash: string | null;
  brokenAt: { seq: number; index: number; stored: string; computed: string; prevMismatch: boolean } | null;
  ms: number;
}

/** Exactly the README-market v2 rule: sha256hex(JSON.stringify([prevHash, seq, type, signalId, …, at])). */
function v2Canonical(prev: string, e: LedgerEntryV2): string {
  return JSON.stringify([
    prev,
    e.seq,
    e.type,
    e.signalId,
    e.symbol,
    e.direction,
    e.entryLow,
    e.entryHigh,
    e.stop,
    e.target1,
    e.target2,
    e.exit ?? null,
    e.outcome ?? null,
    e.r ?? null,
    e.at,
  ]);
}

async function verifyV2(entries: LedgerEntryV2[], onStep?: (i: number, ok: boolean) => void): Promise<V2Result> {
  const t0 = performance.now();
  let prev = V2_GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const h = await sha256Hex(v2Canonical(prev, e));
    const prevMismatch = e.prevHash !== prev;
    if (prevMismatch || e.hash !== h) {
      onStep?.(i, false);
      return { ok: false, verified: i, total: entries.length, headHash: null, brokenAt: { seq: e.seq, index: i, stored: e.hash, computed: h, prevMismatch }, ms: performance.now() - t0 };
    }
    onStep?.(i, true);
    prev = h;
  }
  return { ok: true, verified: entries.length, total: entries.length, headHash: entries.length ? prev : V2_GENESIS, brokenAt: null, ms: performance.now() - t0 };
}

function instFor(symbol: string): Instrument | undefined {
  return getInstrument(symbol);
}
function lv(e: LedgerEntryV2, v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const inst = instFor(e.symbol);
  return inst ? fmtLevel(inst, v) : v.toLocaleString("en-US", { maximumFractionDigits: 8 });
}
function fmtAt(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return `${d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit", timeZone: "UTC" })} ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })}`;
}
const OUTCOME_V2: Record<string, string> = { target: "Target", trailed: "Trailed", stopped: "Stopped", expired: "Expired", invalidated: "Invalidated" };

type LivePhase = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready" };

function LiveLedger() {
  const [phase, setPhase] = useState<LivePhase>({ kind: "loading" });
  const [entries, setEntries] = useState<LedgerEntryV2[]>([]);
  const [head, setHead] = useState<LedgerHead | null>(null);
  const [headErr, setHeadErr] = useState(false);
  const [work, setWork] = useState<LedgerEntryV2[]>([]);
  const [cells, setCells] = useState<CellState[]>([]);
  const [result, setResult] = useState<V2Result | null>(null);
  const [running, setRunning] = useState(false);
  const [tampered, setTampered] = useState<{ seq: number; field: "exit" | "stop"; from: number | null; to: number } | null>(null);
  const runToken = useRef(0);

  const verify = useCallback(async (list: LedgerEntryV2[], user: boolean) => {
    const token = ++runToken.current;
    setRunning(true);
    setResult(null);
    const next: CellState[] = list.map(() => "idle");
    setCells(next);
    const res = await verifyV2(list, (i, ok) => {
      next[i] = ok ? "ok" : "bad";
    });
    if (token !== runToken.current) return;
    if (!res.ok && res.brokenAt) for (let i = res.brokenAt.index + 1; i < next.length; i++) next[i] = "skip";
    setCells([...next]);
    setResult(res);
    setRunning(false);
    if (user) track("verify_chain", { ledger: "live", ok: res.ok, n: list.length });
  }, []);

  const load = useCallback(async () => {
    setPhase({ kind: "loading" });
    setTampered(null);
    setResult(null);
    try {
      const [all, h] = await Promise.all([
        marketApi.ledgerAll(),
        marketApi.ledgerHead().catch(() => null),
      ]);
      setEntries(all);
      setWork(all);
      setHead(h);
      setHeadErr(h === null);
      setPhase({ kind: "ready" });
      void verify(all, false);
    } catch (err) {
      const unreachable = (err as { unreachable?: boolean; status?: number })?.unreachable || (err as { status?: number })?.status === 0;
      setPhase({
        kind: "error",
        message: unreachable ? "The Tudumm market API can’t be reached right now, so the live ledger can’t be loaded." : "The live ledger didn’t load. Try again in a moment.",
      });
    }
  }, [verify]);

  useEffect(() => {
    void load();
    return () => {
      runToken.current++;
    };
  }, [load]);

  const closes = useMemo(() => entries.filter((e) => e.type === "close"), [entries]);
  const stats = useMemo(() => {
    const rs = closes.map((e) => (typeof e.r === "number" && Number.isFinite(e.r) ? e.r : 0));
    const n = rs.length;
    const wins = rs.filter((r) => r > 0).length;
    const losses = rs.filter((r) => r < 0).length;
    const total = rs.reduce((a, b) => a + b, 0);
    return { n, wins, losses, flat: n - wins - losses, total, avg: n ? total / n : 0 };
  }, [closes]);
  const openCalls = useMemo(() => {
    const closed = new Set(closes.map((e) => e.signalId));
    return entries.filter((e) => e.type === "issue" && !closed.has(e.signalId)).length;
  }, [entries, closes]);

  if (phase.kind === "loading") {
    return (
      <section className="panel lled__state" aria-busy="true">
        <span className="chain__spin" aria-hidden="true" />
        <p className="t2">Loading the live ledger and recomputing its hashes…</p>
      </section>
    );
  }
  if (phase.kind === "error") {
    return (
      <section className="panel lled__state lled__state--err" role="alert">
        <ShieldAlert size={18} aria-hidden="true" />
        <div>
          <p className="lled__state-title">Live ledger unavailable</p>
          <p className="t2">{phase.message}</p>
        </div>
        <button type="button" className="btn btn--sm" onClick={() => void load()}>
          <RefreshCw size={13} aria-hidden="true" /> Retry
        </button>
      </section>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="lled">
        <LiveTopline head={head} headErr={headErr} />
        <section className="panel">
          <div className="panel__body">
            <EmptyState
              title="The live ledger is empty — no call has been published yet."
              action={
                <button type="button" className="btn" onClick={() => void load()}>
                  <RefreshCw size={14} aria-hidden="true" /> Check again
                </button>
              }
            >
              Calls are written here the moment they become visible, and again when they close. Sitting out writes nothing. Until the first call,
              the chain is just its genesis hash ({shortHash(V2_GENESIS, 8)}…).
            </EmptyState>
          </div>
        </section>
      </div>
    );
  }

  const computedHead = result?.ok ? result.headHash : null;
  const published = head?.headHash ?? null;
  const lastSeq = entries[entries.length - 1].seq;
  const headAhead = head && typeof head.count === "number" && head.count > entries.length;
  const headMatch = computedHead && published ? computedHead === published : null;

  const applyTamper = (seq: number, field: "exit" | "stop", to: number) => {
    const base = entries.find((e) => e.seq === seq);
    if (!base) return;
    const copy = entries.map((e) => (e.seq === seq ? { ...e, [field]: to } : e));
    setWork(copy);
    setTampered({ seq, field, from: base[field], to });
    track("tamper_test", { ledger: "live" });
    toast(`Entry #${seq} ${field} edited in memory. Verifying…`);
    void verify(copy, false);
  };
  const resetTamper = () => {
    setTampered(null);
    setWork(entries);
    void verify(entries, false);
  };

  return (
    <div className="lled">
      <LiveTopline head={head} headErr={headErr} />

      <div className={`judge ${stats.n < JUDGE_MIN ? "is-few" : ""}`} role="note">
        <p className="judge__big serif">
          {stats.n < JUDGE_MIN ? (
            <>
              {stats.n} closed {stats.n === 1 ? "call" : "calls"} — <em>too few to judge.</em>
            </>
          ) : (
            <>
              {stats.n} closed calls <em>on the record.</em>
            </>
          )}
        </p>
        <p className="judge__copy">
          {stats.n < JUDGE_MIN
            ? `Win rates and averages over fewer than ${JUDGE_MIN} closed calls are mostly noise. They’re shown below for transparency, not as evidence of an edge.`
            : "Results are computed in your browser from the close entries below. Past results are a record, not a promise of future results."}
        </p>
      </div>

      <dl className="pkpis lled__kpis mono">
        <div>
          <dt>Closed calls</dt>
          <dd>{stats.n}</dd>
        </div>
        <div>
          <dt>Open (published)</dt>
          <dd>{openCalls}</dd>
        </div>
        <div>
          <dt>Wins / losses</dt>
          <dd>
            <span className="c-long">{stats.wins}</span> / <span className="c-short">{stats.losses}</span>
            {stats.flat ? <span className="t3"> · {stats.flat} flat</span> : null}
          </dd>
        </div>
        <div>
          <dt>Avg R / call</dt>
          <dd className={stats.n ? (stats.avg >= 0 ? "c-long" : "c-short") : "t3"}>{stats.n ? signedR(stats.avg) : "—"}</dd>
        </div>
        <div>
          <dt>Total R</dt>
          <dd className={stats.n ? (stats.total >= 0 ? "c-long" : "c-short") : "t3"}>{stats.n ? signedR(stats.total, 1) : "—"}</dd>
        </div>
      </dl>
      <p className="proof__fine">
        From {entries.length} ledger {entries.length === 1 ? "entry" : "entries"} (seq 1–{lastSeq}). R = result in multiples of the risk taken; an unfilled call that expires
        counts as 0R.
      </p>

      <section className="panel chain" aria-label="Live chain verification">
        <div className="chain__main">
          <div className="chain__head">
            <div>
              <p className="eyebrow">Verify the live chain</p>
              <h2 className="chain__title serif">
                Recompute all {work.length} hashes <em>in your browser.</em>
              </h2>
              <p className="chain__copy">
                Each hash is SHA-256 of the previous hash plus the entry’s seq, type, signal id, symbol, direction, entry zone, stop, both targets,
                exit, outcome, R and time — the v2 rule published in the API docs. Change any field and every hash after it stops matching.
              </p>
            </div>
            <div className="chain__acts">
              <button type="button" className="btn btn--primary" onClick={() => void verify(work, true)} disabled={running}>
                <ShieldCheck size={15} aria-hidden="true" /> {running ? "Verifying…" : "Verify again"}
              </button>
            </div>
          </div>

          <div className="tape lled__tape" role="img" aria-label={`Verification: ${cells.filter((c) => c === "ok").length} of ${work.length} entries verified`}>
            {cells.map((c, i) => (
              <i key={i} className={`tape__c is-${c} ${tampered && work[i]?.seq === tampered.seq ? "is-edited" : ""}`} title={`#${work[i]?.seq}`} />
            ))}
          </div>

          <div className={`chain__status mono ${result ? (result.ok ? "is-ok" : "is-bad") : ""}`} aria-live="polite">
            {running && (
              <>
                <span className="chain__spin" aria-hidden="true" /> Recomputing {work.length} hashes…
              </>
            )}
            {!running && result?.ok && (
              <>
                <ShieldCheck size={16} aria-hidden="true" />
                <b>Chain intact</b> · {result.verified}/{result.total} · head {shortHash(result.headHash ?? "", 8)}… · {hasWebCrypto ? "Web Crypto" : "JS SHA-256"} ·{" "}
                {result.ms.toFixed(0)} ms
              </>
            )}
            {!running && result && !result.ok && result.brokenAt && (
              <>
                <ShieldAlert size={16} aria-hidden="true" />
                <b>Chain broken at #{result.brokenAt.seq}</b> · {result.verified} verified before it ·{" "}
                {result.brokenAt.prevMismatch
                  ? "its prevHash doesn’t match the hash before it"
                  : `stored ${shortHash(result.brokenAt.stored, 8)}… ≠ recomputed ${shortHash(result.brokenAt.computed, 8)}…`}
              </>
            )}
          </div>

          <div className="lled__heads mono">
            <div className="lled__hrow">
              <span className="t3">Computed head</span>
              <span className="lled__h" title={computedHead ?? undefined}>
                {computedHead ? `${shortHash(computedHead, 20)}…` : running ? "computing…" : "— (chain broken)"}
              </span>
            </div>
            <div className="lled__hrow">
              <span className="t3">Published head</span>
              <span className="lled__h" title={published ?? undefined}>
                {published ? `${shortHash(published, 20)}…` : headErr ? "unavailable" : "—"}
              </span>
              {published && (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() =>
                    navigator.clipboard?.writeText(published).then(
                      () => toast("Published head copied"),
                      () => toast("Copy blocked by the browser"),
                    ) ?? toast("Copy isn’t available here")
                  }
                >
                  <Copy size={13} aria-hidden="true" /> Copy
                </button>
              )}
            </div>
            <p className={`lled__match ${headMatch === true ? "c-long" : headMatch === false ? "c-short" : "t3"}`}>
              {headMatch === true && !tampered && "✓ Matches /ledger/head — what you verified is what the server publishes."}
              {headMatch === false && !headAhead && "✗ Doesn’t match the published head."}
              {headMatch === false && headAhead && "The ledger grew while this page loaded. Reload to verify the newest entries."}
              {headMatch === null && tampered && "Tampered copy: the computed head can’t match until you reset."}
              {headMatch === null && !tampered && headErr && "Couldn’t fetch /ledger/head to compare."}
            </p>
          </div>
        </div>

        <LiveTamper entries={entries} running={running} tampered={tampered} onTamper={applyTamper} onReset={resetTamper} />
      </section>

      <LiveTable entries={work} cells={cells} tamperedSeq={tampered?.seq ?? null} />
    </div>
  );
}

function LiveTopline({ head, headErr }: { head: LedgerHead | null; headErr: boolean }) {
  return (
    <div className="lled__top">
      <EngineTag />
      <span className="chip">SHA-256 · hash chain v2</span>
      <span className="chip">append-only</span>
      <span className="mono t3 lled__asof">
        {head?.asOf ? `head as of ${fmtAsOf(head.asOf, { date: true })}` : headErr ? "head unavailable" : ""}
      </span>
    </div>
  );
}

function LiveTamper({
  entries,
  running,
  tampered,
  onTamper,
  onReset,
}: {
  entries: LedgerEntryV2[];
  running: boolean;
  tampered: { seq: number; field: "exit" | "stop"; from: number | null; to: number } | null;
  onTamper: (seq: number, field: "exit" | "stop", to: number) => void;
  onReset: () => void;
}) {
  const [seq, setSeq] = useState<number>(() => entries[Math.max(0, entries.length - 1)].seq);
  const base = entries.find((e) => e.seq === seq) ?? entries[entries.length - 1];
  const field: "exit" | "stop" = base.type === "close" && typeof base.exit === "number" ? "exit" : "stop";
  const stored = base[field] as number;
  const [val, setVal] = useState("");
  useEffect(() => {
    const d = instFor(base.symbol)?.decimals ?? 2;
    setVal((stored * 1.012).toFixed(d));
  }, [base, stored]);
  const n = Number(val);
  const ok = Number.isFinite(n) && n > 0 && n !== stored;
  return (
    <div className="chain__tamper" id="live-tamper">
      <p className="eyebrow">
        <FlaskConical size={12} aria-hidden="true" /> Tamper test
      </p>
      <p className="chain__copy">Edit one entry in memory (a close’s exit, or an issue’s stop), then watch the chain break on exactly that entry.</p>
      <label className="field">
        <span>Ledger entry</span>
        <select className="select mono" value={base.seq} onChange={(e) => setSeq(Number(e.target.value))} disabled={running}>
          {entries.map((e) => (
            <option key={e.seq} value={e.seq}>
              #{e.seq} · {e.type} · {e.symbol} · {e.direction === "LONG" ? "▲" : "▼"} {e.direction}
            </option>
          ))}
        </select>
      </label>
      <dl className="chain__row mono">
        <div>
          <dt>Type</dt>
          <dd>{base.type}</dd>
        </div>
        <div>
          <dt>Stop</dt>
          <dd>{lv(base, base.stop)}</dd>
        </div>
        <div>
          <dt>Exit</dt>
          <dd>{lv(base, base.exit)}</dd>
        </div>
        <div>
          <dt>R</dt>
          <dd className={typeof base.r === "number" ? (base.r >= 0 ? "c-long" : "c-short") : "t3"}>{typeof base.r === "number" ? signedR(base.r) : "—"}</dd>
        </div>
      </dl>
      <label className="field">
        <span>New {field} price</span>
        <input className="input mono" inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)} disabled={running} aria-invalid={!ok} />
      </label>
      <div className="chain__tacts">
        <button type="button" className="btn btn--danger" disabled={!ok || running} onClick={() => onTamper(base.seq, field, n)}>
          <FlaskConical size={14} aria-hidden="true" /> Apply tamper
        </button>
        <button type="button" className="btn" disabled={!tampered || running} onClick={onReset}>
          <RotateCcw size={14} aria-hidden="true" /> Reset
        </button>
      </div>
      {tampered && (
        <p className="chain__note">
          <b className="mono">#{tampered.seq}</b> {tampered.field} {tampered.from === null ? "—" : tampered.from} →{" "}
          <span className="c-short mono">{tampered.to}</span>. Nothing is sent or saved; Reset restores the server’s copy.
        </p>
      )}
      {!ok && val !== "" && <p className="chain__warn">Enter a positive price that differs from the stored {field}.</p>}
    </div>
  );
}

const LPAGE = 25;
function LiveTable({ entries, cells, tamperedSeq }: { entries: LedgerEntryV2[]; cells: CellState[]; tamperedSeq: number | null }) {
  const [page, setPage] = useState(0);
  const idx = useMemo(() => new Map(entries.map((e, i) => [e.seq, i])), [entries]);
  const rows = useMemo(() => [...entries].reverse(), [entries]);
  const pages = Math.max(1, Math.ceil(rows.length / LPAGE));
  const slice = rows.slice(page * LPAGE, page * LPAGE + LPAGE);
  useEffect(() => {
    if (page > pages - 1) setPage(0);
  }, [page, pages]);
  return (
    <section className="panel ledger" aria-label="Live ledger entries">
      <header className="panel__head ledger__head">
        <div>
          <span className="eyebrow">Live ledger</span>
          <span className="mono t3 proof__meta"> newest first · times UTC</span>
        </div>
      </header>
      <div className="scroll-x">
        <table className="dtable mono ledger__t lled__t">
          <thead>
            <tr>
              <th className="r">Seq</th>
              <th>At (UTC)</th>
              <th>Type</th>
              <th>Symbol</th>
              <th>Dir</th>
              <th className="r">Entry zone</th>
              <th className="r">Stop</th>
              <th className="r">T1</th>
              <th className="r">T2</th>
              <th className="r">Exit</th>
              <th>Outcome</th>
              <th className="r">R</th>
              <th>Hash</th>
              <th>Check</th>
            </tr>
          </thead>
          <tbody>
            {slice.map((e) => {
              const c = cells[idx.get(e.seq) ?? 0] ?? "idle";
              const edited = e.seq === tamperedSeq;
              return (
                <tr key={e.seq} className={edited ? "is-edited" : c === "bad" ? "is-bad" : ""}>
                  <td className="r t2">{e.seq}</td>
                  <td className="t2">{fmtAt(e.at)}</td>
                  <td>
                    <span className={`lled__type lled__type--${e.type}`}>{e.type === "issue" ? "ISSUE" : "CLOSE"}</span>
                  </td>
                  <td>
                    <Link to={`/app/i/${e.symbol}`} className="ledger__sym">
                      {e.symbol}
                    </Link>
                  </td>
                  <td className={e.direction === "LONG" ? "c-long" : "c-short"}>
                    {e.direction === "LONG" ? "▲" : "▼"} {e.direction}
                  </td>
                  <td className="r">
                    {lv(e, e.entryLow)}–{lv(e, e.entryHigh)}
                  </td>
                  <td className="r t2">{lv(e, e.stop)}</td>
                  <td className="r t2">{lv(e, e.target1)}</td>
                  <td className="r t2">{lv(e, e.target2)}</td>
                  <td className={`r ${edited ? "c-short" : ""}`}>
                    {lv(e, e.exit)}
                    {edited && <span className="ledger__edited">edited</span>}
                  </td>
                  <td>{e.outcome ? <span className={`oc oc--${e.outcome}`}>{OUTCOME_V2[e.outcome] ?? e.outcome}</span> : <span className="t3">open</span>}</td>
                  <td className={`r ${typeof e.r === "number" ? (e.r > 0 ? "c-long" : e.r < 0 ? "c-short" : "") : "t3"}`}>{typeof e.r === "number" ? signedR(e.r) : "—"}</td>
                  <td className="t3" title={e.hash}>
                    {shortHash(e.hash, 8)}
                  </td>
                  <td>
                    {c === "ok" ? <span className="c-long">✓</span> : c === "bad" ? <span className="c-short">✗ break</span> : c === "skip" ? <span className="t3">–</span> : <span className="t3">·</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <footer className="ledger__pager mono">
          <span className="t3">
            {page * LPAGE + 1}–{Math.min(rows.length, page * LPAGE + LPAGE)} of {rows.length}
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
      )}
    </section>
  );
}
