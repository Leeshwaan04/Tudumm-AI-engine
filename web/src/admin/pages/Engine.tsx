import { useMemo, useState } from "react";
import { Ban, Pause, Play, PlayCircle, Search } from "lucide-react";
import { api, qs } from "../api";
import { ago, dateTime, dateTimeShort, dur, int, pct, signed } from "../format";
import { useApi, useDebounced, useMutation, useNow } from "../hooks";
import { Async, AuditReceipt, ConfirmDialog, CopyButton, Empty, ErrorNote, PageHead, Pill, Refreshed, Section, type Tone } from "../ui";
import type { AdminSignalRow, EngineHealth, LedgerHead, SourceHealth, StrategyRow } from "../types";

const MARKETS = ["IN", "US", "EU", "CRYPTO", "FX", "CMDTY"] as const;
// "sit_out" is accepted by the route validator but market/admin.ts listSignals() has no filter for it
// (it would silently return every signal), so it isn't offered here.
const STATUSES = ["active", "pending", "t1_hit", "held", "invalidated", "closed"] as const;
const PAGE = 50;

/** Seconds after which a source counts as stale, by its freshness class. */
const STALE_AFTER: Record<string, number> = { realtime: 45 * 60, "delayed-15m": 90 * 60, eod: 36 * 3600, "daily-ref": 4 * 86400 };

function sourceState(s: SourceHealth): { tone: Tone; label: "ok" | "stale" | "error" } {
  if (!s.ok) return { tone: "bad", label: "error" };
  const lim = STALE_AFTER[s.freshness] ?? 3600;
  if (s.stale === true || (s.staleSeconds !== null && s.staleSeconds > lim)) return { tone: "warn", label: "stale" };
  return { tone: "ok", label: "ok" };
}

const STATUS_TONE: Record<string, Tone> = { active: "ok", pending: "info", t1_hit: "ok", sit_out: "neutral", held: "warn", invalidated: "bad", closed: "neutral" };

export default function Engine() {
  const health = useApi<EngineHealth>("/api/admin/engine/health");
  const head = useApi<LedgerHead>("/api/v1/market/ledger/head");
  const now = useNow(30_000);
  const [runOpen, setRunOpen] = useState(false);
  const [runOut, setRunOut] = useState<{ ok: boolean; summary: string; at: number } | null>(null);
  const run = useMutation(async () => api<{ ok: boolean; summary: string }>("/api/admin/engine/run", { method: "POST", body: {} }));

  return (
    <>
      <PageHead
        eyebrow="Engine"
        title={
          <>
            Engine <em>v0</em> controls
          </>
        }
        actions={
          <>
            <Refreshed
              fetchedAt={health.fetchedAt}
              refreshing={health.refreshing}
              onRefresh={() => {
                health.reload();
                head.reload();
              }}
            />
            <button type="button" className="btn btn--sm btn--primary" onClick={() => (run.reset(), setRunOpen(true))}>
              <PlayCircle aria-hidden="true" /> Run engine now
            </button>
          </>
        }
      >
        <p className="t2">
          Rule-based and <b>uncalibrated</b>: confidence is a score, not a probability estimate yet. Holds hide a signal from users; invalidations close it early and are recorded as
          ledger events, never edits.
        </p>
      </PageHead>

      {runOut && (
        <div className={`adm-banner adm-banner--${runOut.ok ? "ok" : "warn"}`} role="status">
          <b>{runOut.ok ? "Engine run finished" : "Engine run reported a problem"}</b>
          <span className="mono">{runOut.summary}</span>
          <span className="mono t3">{dateTime(new Date(runOut.at).toISOString())}</span>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setRunOut(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="adm-grid-eng">
        <Section title="Engine state" meta="from /engine/health and the public ledger head">
          {health.error && !health.data ? (
            <ErrorNote error={health.error} onRetry={health.reload} />
          ) : (
            <dl className="adm-stats">
              <div>
                <dt>Last run</dt>
                <dd className="mono">{health.data ? (health.data.lastRunAt ? ago(health.data.lastRunAt, now) : "never") : "…"}</dd>
                {health.data?.lastRunAt && <dd className="mono t3">{dateTimeShort(health.data.lastRunAt)}</dd>}
              </div>
              <div>
                <dt>Live signals</dt>
                <dd className="mono">{health.data ? int(health.data.liveSignals) : "…"}</dd>
              </div>
              <div>
                <dt>Ledger entries</dt>
                <dd className="mono">{health.data ? int(health.data.ledgerEntries) : "…"}</dd>
              </div>
              <div className="adm-stats__wide">
                <dt>Live ledger head</dt>
                {head.error && !head.data ? (
                  <dd>
                    <ErrorNote error={head.error} onRetry={head.reload} compact />
                  </dd>
                ) : head.data ? (
                  <>
                    <dd className="adm-hash mono">
                      <span title={head.data.headHash}>
                        #{head.data.headSeq} · {head.data.headHash.slice(0, 12)}…{head.data.headHash.slice(-6)}
                      </span>
                      <CopyButton text={head.data.headHash} label="Copy hash" />
                    </dd>
                    <dd className="mono t3">
                      {int(head.data.count)} entries{head.data.asOf ? ` · head at ${dateTimeShort(head.data.asOf)}` : " · empty chain (genesis)"}
                    </dd>
                  </>
                ) : (
                  <dd className="mono">…</dd>
                )}
              </div>
            </dl>
          )}
        </Section>

        <Section title="Source health" meta={health.data ? `${health.data.sources.length} sources` : undefined} flush>
          <Async q={health} label="Checking sources">
            {(h) =>
              h.sources.length === 0 ? (
                <Empty title="No sources reported.">The engine hasn't written any source-health rows yet. Run the engine or the ingest runner, then refresh.</Empty>
              ) : (
                <div className="scroll-x">
                  <table className="dtable adm-table">
                    <thead>
                      <tr>
                        <th>Source</th>
                        <th>State</th>
                        <th>Freshness</th>
                        <th>Last success</th>
                        <th className="r">Age</th>
                        <th>Last error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {h.sources.map((s) => {
                        const st = sourceState(s);
                        return (
                          <tr key={s.source}>
                            <td className="mono">{s.source}</td>
                            <td>
                              <Pill tone={st.tone}>{st.label}</Pill>
                            </td>
                            <td className="mono t2">{s.freshness}</td>
                            <td className="mono t2">{s.lastSuccessAt ? dateTimeShort(s.lastSuccessAt) : "never"}</td>
                            <td className="r mono t2">{s.staleSeconds !== null ? dur(s.staleSeconds) : "—"}</td>
                            <td className="t3 adm-trunc adm-trunc--w" title={s.lastError ?? undefined}>
                              {s.lastError ?? "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )
            }
          </Async>
        </Section>
      </div>

      <Signals
        onLedgerChange={() => {
          health.reload();
          head.reload();
        }}
      />
      <Strategies />

      <ConfirmDialog
        open={runOpen}
        title="Run the engine now?"
        confirmLabel="Run now"
        onConfirm={async () => {
          const r = await run.run();
          if (r) {
            setRunOut({ ...r, at: Date.now() });
            setRunOpen(false);
            health.reload();
            head.reload();
          }
        }}
        onClose={() => setRunOpen(false)}
        pending={run.pending}
        error={run.error}
      >
        <p>Fetches the light sources, recomputes signals and advances the lifecycle, exactly like the */15 cron. Limited to 6 runs per 10 minutes per admin session.</p>
      </ConfirmDialog>
    </>
  );
}

/* ---------------- live signals ---------------- */

function Signals({ onLedgerChange }: { onLedgerChange: () => void }) {
  const [status, setStatus] = useState("");
  const [market, setMarket] = useState("");
  const [qRaw, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const q = useDebounced(qRaw.replace(/[^A-Za-z0-9 ._:-]/g, ""), 300);
  const res = useApi<{ items: AdminSignalRow[]; total: number }>(`/api/admin/engine/signals${qs({ status, market, q: q.trim(), limit: PAGE, offset })}`);
  const [target, setTarget] = useState<{ row: AdminSignalRow; kind: "hold" | "release" | "invalidate" } | null>(null);
  const [receipt, setReceipt] = useState<{ id: string; action: string; key: number } | null>(null);
  const now = useNow(60_000);

  const m = useMutation(async (row: AdminSignalRow, kind: "hold" | "release" | "invalidate", reason: string) => {
    const base = `/api/admin/engine/signals/${encodeURIComponent(row.id)}`;
    if (kind === "invalidate") await api(`${base}/invalidate`, { method: "POST", body: { reason } });
    else await api(`${base}/hold`, { method: "POST", body: { hold: kind === "hold", reason } });
    return kind;
  });

  const onFilter = (fn: () => void) => {
    fn();
    setOffset(0);
  };

  return (
    <Section
      title="Live signals"
      meta={res.data ? `${int(res.data.total)} matching` : undefined}
      actions={<Refreshed fetchedAt={res.fetchedAt} refreshing={res.refreshing} onRefresh={res.reload} />}
      flush
    >
      <div className="adm-filters adm-filters--in">
        <label className="adm-search">
          <Search size={14} aria-hidden="true" />
          <span className="visually-hidden">Search signals</span>
          <input className="input" type="search" placeholder="Symbol or signal id" value={qRaw} maxLength={40} onChange={(e) => onFilter(() => setQ(e.target.value))} />
        </label>
        <label className="adm-sel">
          <span className="eyebrow">Status</span>
          <select className="select" value={status} onChange={(e) => onFilter(() => setStatus(e.target.value))}>
            <option value="">Any</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="adm-sel">
          <span className="eyebrow">Market</span>
          <select className="select" value={market} onChange={(e) => onFilter(() => setMarket(e.target.value))}>
            <option value="">All</option>
            {MARKETS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      {receipt && (
        <div className="adm-receipt-wrap adm-receipt-wrap--in">
          <AuditReceipt key={receipt.key} targetId={receipt.id} action={receipt.action} onDismiss={() => setReceipt(null)} />
        </div>
      )}

      <Async q={res} label="Loading signals">
        {(d) =>
          d.items.length === 0 ? (
            <Empty title={status || market || q ? "No signals match." : "No signals yet."}>
              {status || market || q ? "Clear a filter to widen the list." : "The engine hasn't issued anything. Use Run engine now, or wait for the */15 cron."}
            </Empty>
          ) : (
            <>
              <div className="scroll-x">
                <table className="dtable adm-table">
                  <thead>
                    <tr>
                      <th>Signal</th>
                      <th>Market</th>
                      <th>Call</th>
                      <th>Status</th>
                      <th>Strategy</th>
                      <th className="r" title="Engine v0 confidence score (0–100). Uncalibrated: not a probability.">
                        Score · v0
                      </th>
                      <th>Issued</th>
                      <th>Updated</th>
                      <th className="r">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.items.map((s) => {
                      const closed = s.status === "closed" || s.status === "invalidated";
                      return (
                        <tr key={s.id} className={s.held ? "adm-row--held" : undefined}>
                          <td>
                            <span className="adm-sig">
                              <b className="mono">{s.symbol}</b>
                              <span className="mono t3">{s.id}</span>
                            </span>
                          </td>
                          <td className="mono t2">{s.market}</td>
                          <td>
                            {s.direction === "LONG" ? (
                              <span className="adm-dir adm-dir--long mono">▲ LONG</span>
                            ) : s.direction === "SHORT" ? (
                              <span className="adm-dir adm-dir--short mono">▼ SHORT</span>
                            ) : (
                              <span className="t3 mono">—</span>
                            )}
                          </td>
                          <td>
                            <span className="adm-inline">
                              <Pill tone={STATUS_TONE[s.status] ?? "neutral"}>{s.status.replace("_", " ")}</Pill>
                              {s.held && s.status !== "held" && <Pill tone="warn">held</Pill>}
                            </span>
                          </td>
                          <td className="mono t2">{s.strategy ?? "—"}</td>
                          <td className="r mono" title="Engine v0 score, uncalibrated">
                            {s.confidence !== null ? Math.round(s.confidence * 100) : "—"}
                          </td>
                          <td className="mono t2" title={dateTime(s.issuedAt)}>
                            {ago(s.issuedAt, now)}
                          </td>
                          <td className="mono t2" title={dateTime(s.updatedAt)}>
                            {ago(s.updatedAt, now)}
                          </td>
                          <td className="r">
                            <span className="adm-rowact">
                              {s.held ? (
                                <button type="button" className="btn btn--sm" onClick={() => (m.reset(), setTarget({ row: s, kind: "release" }))} disabled={closed} aria-label={`Release ${s.symbol}`} title="Release">
                                  <Play aria-hidden="true" />
                                  <span className="adm-rowact__l">Release</span>
                                </button>
                              ) : (
                                <button type="button" className="btn btn--sm" onClick={() => (m.reset(), setTarget({ row: s, kind: "hold" }))} disabled={closed} aria-label={`Hold ${s.symbol}`} title="Hold">
                                  <Pause aria-hidden="true" />
                                  <span className="adm-rowact__l">Hold</span>
                                </button>
                              )}
                              <button
                                type="button"
                                className="btn btn--sm adm-btn-danger"
                                onClick={() => (m.reset(), setTarget({ row: s, kind: "invalidate" }))}
                                disabled={closed}
                                aria-label={`Invalidate ${s.symbol}`}
                                title="Invalidate"
                              >
                                <Ban aria-hidden="true" />
                                <span className="adm-rowact__l">Invalidate</span>
                              </button>
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="adm-card__foot">
                <span className="mono t3">
                  {int(offset + 1)}–{int(offset + d.items.length)} of {int(d.total)}
                </span>
                <nav className="adm-pager" aria-label="Signals pages">
                  <button type="button" className="btn btn--sm" disabled={offset === 0 || res.refreshing} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                    ← Previous
                  </button>
                  <button type="button" className="btn btn--sm" disabled={offset + PAGE >= d.total || res.refreshing} onClick={() => setOffset(offset + PAGE)}>
                    Next →
                  </button>
                </nav>
              </div>
            </>
          )
        }
      </Async>

      <ConfirmDialog
        open={target !== null}
        title={
          target
            ? target.kind === "invalidate"
              ? `Invalidate ${target.row.symbol}?`
              : target.kind === "hold"
                ? `Hold ${target.row.symbol}?`
                : `Release ${target.row.symbol}?`
            : ""
        }
        tone={target?.kind === "invalidate" ? "danger" : "primary"}
        confirmLabel={target?.kind === "invalidate" ? "Invalidate signal" : target?.kind === "hold" ? "Hold signal" : "Release signal"}
        reason={{ required: true, placeholder: target?.kind === "invalidate" ? "e.g. Bad print from source; levels computed off a stale candle" : "e.g. Reviewing before release" }}
        typeToConfirm={target?.kind === "invalidate" ? target.row.symbol : undefined}
        onConfirm={async (reason) => {
          if (!target) return;
          const k = await m.run(target.row, target.kind, reason);
          if (k) {
            setReceipt({ id: target.row.id, action: k === "invalidate" ? "engine.signal_invalidate" : k === "hold" ? "engine.signal_hold" : "engine.signal_release", key: Date.now() });
            setTarget(null);
            res.reload();
            if (k === "invalidate") onLedgerChange();
          }
        }}
        onClose={() => setTarget(null)}
        pending={m.pending}
        error={m.error}
      >
        {target && (
          <>
            <p className="mono t2">
              {target.row.id} · {target.row.market} · {target.row.direction ?? "no direction"} · {target.row.status}
            </p>
            {target.kind === "invalidate" ? (
              <p>Closes the signal early with outcome “invalidated”. It's appended to the public ledger as an event and can't be undone.</p>
            ) : target.kind === "hold" ? (
              <p>Hides the signal from users until released. Nothing is written to the ledger.</p>
            ) : (
              <p>Makes the signal visible to users again.</p>
            )}
          </>
        )}
      </ConfirmDialog>
    </Section>
  );
}

/* ---------------- strategies kill-switch grid ---------------- */

function Strategies() {
  const res = useApi<{ items: StrategyRow[] }>("/api/admin/engine/strategies");
  const [target, setTarget] = useState<StrategyRow | null>(null);
  const [receipt, setReceipt] = useState<{ id: string; key: number } | null>(null);
  const m = useMutation(async (r: StrategyRow) => api("/api/admin/engine/strategies", { method: "POST", body: { strategy: r.strategy, market: r.market, enabled: !r.enabled } }));

  const grid = useMemo(() => {
    const items = res.data?.items ?? [];
    const strategies = [...new Set(items.map((i) => i.strategy))].sort();
    const markets = MARKETS.filter((mk) => items.some((i) => i.market === mk));
    const extra = [...new Set(items.map((i) => i.market))].filter((mk) => !(MARKETS as readonly string[]).includes(mk));
    const cell = new Map(items.map((i) => [`${i.strategy}|${i.market}`, i]));
    return { strategies, markets: [...markets, ...extra], cell };
  }, [res.data]);

  return (
    <Section title="Strategy kill switches" meta="strategy × market · disabled strategies issue no new signals" actions={<Refreshed fetchedAt={res.fetchedAt} refreshing={res.refreshing} onRefresh={res.reload} />}>
      {receipt && (
        <div className="adm-receipt-wrap">
          <AuditReceipt key={receipt.key} targetId={receipt.id} action="engine.strategy_set" onDismiss={() => setReceipt(null)} />
        </div>
      )}
      <Async q={res} label="Loading strategies">
        {() =>
          grid.strategies.length === 0 ? (
            <Empty title="No strategies registered.">The engine reports no strategy × market rows yet.</Empty>
          ) : (
            <div className="scroll-x">
              <table className="adm-kill">
                <thead>
                  <tr>
                    <th scope="col">Strategy</th>
                    {grid.markets.map((mk) => (
                      <th key={mk} scope="col" className="mono">
                        {mk}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {grid.strategies.map((st) => (
                    <tr key={st}>
                      <th scope="row" className="mono">
                        {st}
                      </th>
                      {grid.markets.map((mk) => {
                        const c = grid.cell.get(`${st}|${mk}`);
                        if (!c)
                          return (
                            <td key={mk} className="adm-kill__na hatch" title="This strategy doesn't run in this market">
                              <span className="visually-hidden">not applicable</span>
                            </td>
                          );
                        return (
                          <td key={mk} className={c.enabled ? "is-on" : "is-off"}>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={c.enabled}
                              className="switch adm-kill__sw"
                              onClick={() => (m.reset(), setTarget(c))}
                              aria-label={`${st} in ${mk}: ${c.enabled ? "enabled" : "disabled"}`}
                            >
                              <span className="switch__track" aria-hidden="true" />
                              <span className="mono">{c.enabled ? "on" : "off"}</span>
                            </button>
                            <span className="adm-kill__st mono">
                              {int(c.signals)} sig · {int(c.closed)} closed
                            </span>
                            <span className="adm-kill__st mono">
                              win {c.winRate !== null ? pct(c.winRate, 0) : "—"} · {c.avgR !== null ? signed(c.avgR, 2, "R") : "—"}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Async>
      <ConfirmDialog
        open={target !== null}
        title={target ? `${target.enabled ? "Disable" : "Enable"} ${target.strategy} in ${target.market}?` : ""}
        tone={target?.enabled ? "danger" : "primary"}
        confirmLabel={target?.enabled ? "Disable strategy" : "Enable strategy"}
        onConfirm={async () => {
          if (!target) return;
          const r = await m.run(target);
          if (r !== undefined) {
            setReceipt({ id: `${target.strategy}:${target.market}`, key: Date.now() });
            setTarget(null);
            res.reload();
          }
        }}
        onClose={() => setTarget(null)}
        pending={m.pending}
        error={m.error}
      >
        {target && (
          <>
            <p>{target.enabled ? "No new signals from this strategy in this market. Live signals already issued keep running to their exit." : "The strategy starts issuing signals in this market on the next engine run."}</p>
            <p className="t3">Audit-logged as engine.strategy_set. This endpoint takes no reason field.</p>
          </>
        )}
      </ConfirmDialog>
    </Section>
  );
}
