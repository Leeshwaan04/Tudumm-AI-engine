// Plain-SVG / HTML charts for the operator console. Thin marks, 4px rounded data-ends,
// hairline grid, one hover layer per chart, and a table view for every chart.
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { compact, dayLabel, int, pct } from "./format";

/* Series colors. Single-series charts use --viz-1. The 3-part plan mix uses a set validated
   (dataviz validate_palette.js, dark, surface #13161B): blue / aqua / dark saffron. */
export const PLAN_COLORS: Record<string, string> = { free: "#3987e5", pro: "#199e70", elite: "#c98500" };

function useWidth<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw !== undefined) setW(Math.round(cw));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceMax(v: number): number {
  if (v <= 0) return 4;
  if (v <= 4) return 4;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * exp;
}

/** Column with a 4px rounded top and a square baseline. */
function colPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/* ---------- frame: title + Chart/Table toggle ---------- */

export function ChartFrame({ title, meta, children, table, legend }: { title: string; meta?: ReactNode; children: ReactNode; table: ReactNode; legend?: ReactNode }) {
  const [mode, setMode] = useState<"chart" | "table">("chart");
  return (
    <section className="adm-card adm-chart">
      <div className="adm-card__head">
        <div className="adm-card__ttl">
          <h2>{title}</h2>
          {meta && <span className="adm-card__meta">{meta}</span>}
        </div>
        <div className="seg" role="group" aria-label={`${title} view`}>
          <button type="button" aria-pressed={mode === "chart"} onClick={() => setMode("chart")}>
            Chart
          </button>
          <button type="button" aria-pressed={mode === "table"} onClick={() => setMode("table")}>
            Table
          </button>
        </div>
      </div>
      <div className="adm-card__body">
        {mode === "chart" ? (
          <>
            {legend}
            {children}
          </>
        ) : (
          <div className="scroll-x adm-chart__table">{table}</div>
        )}
      </div>
    </section>
  );
}

/* ---------- column chart (one series, per-mark tooltip, arrow-key focus) ---------- */

export interface Col {
  key: string;
  label: string;
  value: number;
}

export function ColumnChart({ data, height = 180, unit = "", ariaLabel }: { data: Col[]; height?: number; unit?: string; ariaLabel: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const n = data.length;
  const pad = { l: 34, r: 8, t: 18, b: 22 };
  const pw = Math.max(0, w - pad.l - pad.r);
  const ph = height - pad.t - pad.b;
  const maxV = Math.max(0, ...data.map((d) => d.value));
  const top = niceMax(maxV);
  const ticks = [0, top / 2, top];
  const band = n ? pw / n : 0;
  const bw = Math.max(1, Math.min(24, band - 2));
  const y = (v: number) => pad.t + ph - (v / top) * ph;
  const maxIdx = data.reduce((best, d, i) => (d.value > (data[best]?.value ?? -1) ? i : best), 0);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 64))));

  const onKey = (e: KeyboardEvent) => {
    if (!n) return;
    if (e.key === "ArrowRight") setActive((a) => Math.min(n - 1, (a ?? -1) + 1));
    else if (e.key === "ArrowLeft") setActive((a) => Math.max(0, (a ?? n) - 1));
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(n - 1);
    else return;
    e.preventDefault();
  };

  const a = active !== null ? data[active] : undefined;
  const tipX = active !== null ? pad.l + band * active + band / 2 : 0;

  return (
    <div className="adm-viz" ref={ref} style={{ height }}>
      {w > 0 && (
        <svg
          width={w}
          height={height}
          role="img"
          aria-label={ariaLabel}
          tabIndex={0}
          onKeyDown={onKey}
          onFocus={() => setActive((x) => x ?? n - 1)}
          onBlur={() => setActive(null)}
          onPointerLeave={() => setActive(null)}
          className="adm-viz__svg"
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} className="adm-viz__grid" />
              <text x={pad.l - 6} y={y(t)} dy="0.32em" textAnchor="end" className="adm-viz__tick">
                {compact(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const x = pad.l + band * i + (band - bw) / 2;
            const h = Math.max(0, y(0) - y(d.value));
            return (
              <g key={d.key}>
                {d.value > 0 && <path d={colPath(x, y(d.value), bw, h)} className={`adm-viz__col${active === i ? " is-active" : ""}`} />}
                {(i % labelEvery === 0 || i === n - 1) && (i === n - 1 || n - 1 - i >= labelEvery * 0.6) && (
                  <text x={pad.l + band * i + band / 2} y={height - 6} textAnchor="middle" className="adm-viz__tick">
                    {d.label}
                  </text>
                )}
                <rect x={pad.l + band * i} y={pad.t} width={band} height={ph} fill="transparent" onPointerEnter={() => setActive(i)} onPointerDown={() => setActive(i)} />
              </g>
            );
          })}
          {maxV > 0 && data[maxIdx] && active === null && (
            <text x={pad.l + band * maxIdx + band / 2} y={y(maxV) - 5} textAnchor="middle" className="adm-viz__val">
              {int(maxV)}
            </text>
          )}
        </svg>
      )}
      {a && (
        <div className="adm-tip" style={{ left: Math.min(Math.max(tipX, 60), Math.max(60, w - 60)), top: 0 }} role="status">
          <b className="mono">
            {int(a.value)}
            {unit}
          </b>
          <span>{a.label}</span>
        </div>
      )}
    </div>
  );
}

/** Fill a UTC day series so every day in the window has a column (missing = 0). */
export function fillDays(rows: { day: string; n: number }[], days: number): Col[] {
  const map = new Map(rows.map((r) => [r.day, r.n]));
  const out: Col[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    out.push({ key, label: dayLabel(key), value: map.get(key) ?? 0 });
  }
  return out;
}

/* ---------- horizontal bars (ranked; value at the tip) ---------- */

export interface HBar {
  key: string;
  label: ReactNode;
  value: number;
  /** secondary text after the value, e.g. "12 viewers" or "41% of previous" */
  note?: ReactNode;
}

export function HBars({ rows, max, format = int, ariaLabel, color }: { rows: HBar[]; max?: number; format?: (n: number) => string; ariaLabel: string; color?: string }) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <ol className="adm-hbars" aria-label={ariaLabel}>
      {rows.map((r) => (
        <li key={r.key} className="adm-hbar" tabIndex={0}>
          <span className="adm-hbar__lab">{r.label}</span>
          <span className="adm-hbar__track" aria-hidden="true">
            {r.value > 0 && <span className="adm-hbar__fill" style={{ width: `${Math.max(0.6, (r.value / top) * 100)}%`, background: color }} />}
          </span>
          <span className="adm-hbar__val mono">{format(r.value)}</span>
          {r.note !== undefined && <span className="adm-hbar__note">{r.note}</span>}
        </li>
      ))}
    </ol>
  );
}

/* ---------- tall segmented bar (part-to-whole, <= 6 parts) ---------- */

export interface Part {
  key: string;
  label: string;
  value: number;
  color: string;
}

export function SegmentedBar({ parts, ariaLabel }: { parts: Part[]; ariaLabel: string }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const visible = parts.filter((p) => p.value > 0);
  const gaps = Math.max(0, visible.length - 1) * 2;
  const h = hover ? parts.find((p) => p.key === hover) : undefined;
  return (
    <div className="adm-seg">
      <div className="adm-seg__bar" ref={ref} role="img" aria-label={`${ariaLabel}: ${parts.map((p) => `${p.label} ${p.value} (${total ? pct(p.value / total, 0) : "0%"})`).join(", ")}`}>
        {total === 0 ? (
          <span className="adm-seg__none hatch">No users yet</span>
        ) : (
          visible.map((p) => {
            const share = p.value / total;
            const px = (w - gaps) * share;
            const label = pct(share, 0);
            const fits = px >= label.length * 7.5 + 14;
            return (
              <span
                key={p.key}
                className={`adm-seg__part${hover === p.key ? " is-active" : ""}`}
                style={{ flexGrow: p.value, background: p.color }}
                tabIndex={0}
                onPointerEnter={() => setHover(p.key)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(p.key)}
                onBlur={() => setHover(null)}
                aria-label={`${p.label}: ${p.value} (${label})`}
              >
                {fits && <span className="adm-seg__in mono">{label}</span>}
              </span>
            );
          })
        )}
      </div>
      <ul className="adm-legend">
        {parts.map((p) => (
          <li key={p.key} className={hover === p.key ? "is-active" : undefined}>
            <i style={{ background: p.color }} aria-hidden="true" />
            <span>{p.label}</span>
          </li>
        ))}
      </ul>
      <p className="adm-seg__read mono t2" aria-live="polite">
        {h ? `${h.label} · ${int(h.value)} users · ${total ? pct(h.value / total, 1) : "—"}` : `${int(total)} users`}
      </p>
    </div>
  );
}

/* ---------- retention cohort grid (sequential single hue) ---------- */

export function RetentionGrid({ rows, now = Date.now() }: { rows: { cohort: string; size: number; weeks: number[] }[]; now?: number }) {
  const maxWeeks = Math.max(1, ...rows.map((r) => r.weeks.length));
  const [tip, setTip] = useState<string | null>(null);
  return (
    <div className="adm-ret">
      <div className="scroll-x">
        <table className="dtable adm-ret__t">
          <thead>
            <tr>
              <th scope="col">Cohort (week of)</th>
              <th scope="col" className="r">
                Users
              </th>
              {Array.from({ length: maxWeeks }, (_, i) => (
                <th key={i} scope="col" className="r">
                  W{i}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const start = Date.parse(`${r.cohort}T00:00:00Z`);
              return (
                <tr key={r.cohort}>
                  <th scope="row" className="mono">
                    {dayLabel(r.cohort)}
                  </th>
                  <td className="r mono">{int(r.size)}</td>
                  {Array.from({ length: maxWeeks }, (_, i) => {
                    const elapsed = Number.isFinite(start) && start + i * 7 * 86_400_000 <= now;
                    if (!elapsed) return <td key={i} className="adm-ret__cell adm-ret__cell--future" aria-label="not yet elapsed" />;
                    const users = r.weeks[i] ?? 0;
                    const share = r.size ? users / r.size : 0;
                    const alpha = share === 0 ? 0 : 0.12 + Math.min(1, share) * 0.78;
                    const dark = alpha > 0.55;
                    const label = `${dayLabel(r.cohort)} cohort, week ${i}: ${users} of ${r.size} active (${pct(share, 0)})`;
                    return (
                      <td
                        key={i}
                        className="adm-ret__cell r mono"
                        style={{ background: alpha ? `rgba(245,184,65,${alpha.toFixed(2)})` : undefined, color: dark ? "var(--brand-ink)" : undefined }}
                        tabIndex={0}
                        title={label}
                        onPointerEnter={() => setTip(label)}
                        onFocus={() => setTip(label)}
                        onPointerLeave={() => setTip(null)}
                        onBlur={() => setTip(null)}
                      >
                        {pct(share, 0)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="adm-ret__foot">
        <span className="adm-ret__scale" aria-hidden="true">
          <i style={{ background: "rgba(245,184,65,.12)" }} />
          <i style={{ background: "rgba(245,184,65,.40)" }} />
          <i style={{ background: "rgba(245,184,65,.65)" }} />
          <i style={{ background: "rgba(245,184,65,.90)" }} />
        </span>
        <span className="t3">share of cohort active that week · hatched = not elapsed</span>
        <span className="mono t2 adm-ret__tip" aria-live="polite">
          {tip ?? ""}
        </span>
      </div>
    </div>
  );
}

/* ---------- tiny sparkline-ish meter for rates ---------- */

export function Meter({ value, label }: { value: number; label: string }) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <span className="adm-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)} aria-label={label}>
      <span style={{ width: `${v * 100}%` }} />
    </span>
  );
}
