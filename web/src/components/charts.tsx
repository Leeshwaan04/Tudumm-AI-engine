import { useEffect, useMemo, useRef, useState } from "react";
import type { CurvePoint } from "../engine/ledger";
import { MINUS } from "../engine/format";

export function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function Sparkline({
  values,
  width = 120,
  height = 36,
  color = "var(--brand)",
  fill = true,
  label,
}: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
  label?: string;
}) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * width, height - 3 - ((v - min) / span) * (height - 6)] as const);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label ?? "Sparkline"} className="spark">
      {fill && <path d={`${d} L${width} ${height} L0 ${height} Z`} fill={color} opacity="0.1" />}
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r="2.6" fill={color} />
    </svg>
  );
}

function niceTicks(min: number, max: number, n = 4): number[] {
  const span = max - min || 1;
  const raw = span / n;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}
const fmtRTick = (v: number) => `${v > 0 ? "+" : v < 0 ? MINUS : ""}${Math.abs(v).toFixed(0)}R`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Cumulative-R equity curve with optional drawdown panel and hover readout. */
export function EquityCurve({
  points,
  height = 240,
  drawdown = false,
  ddHeight = 96,
  compact = false,
}: {
  points: CurvePoint[];
  height?: number;
  drawdown?: boolean;
  ddHeight?: number;
  compact?: boolean;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: compact ? 36 : 46, r: 12, t: 12, b: 24 };
  const W = Math.max(0, w);
  const innerW = Math.max(10, W - pad.l - pad.r);
  const H = height;
  const innerH = H - pad.t - pad.b;
  const t0 = points[0]?.t ?? 0;
  const t1 = points[points.length - 1]?.t ?? 1;
  const minY = Math.min(0, ...points.map((p) => p.cum));
  const maxY = Math.max(0, ...points.map((p) => p.cum));
  const minDD = Math.min(-1, ...points.map((p) => p.dd));
  const x = (t: number) => pad.l + ((t - t0) / (t1 - t0 || 1)) * innerW;
  const y = (v: number) => pad.t + (1 - (v - minY) / (maxY - minY || 1)) * innerH;
  const yd = (v: number) => 8 + (v / minDD) * (ddHeight - 20);

  const { line, area, ddLine, ddArea, monthTicks } = useMemo(() => {
    if (!points.length || !W) return { line: "", area: "", ddLine: "", ddArea: "", monthTicks: [] as { x: number; label: string }[] };
    const l = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.cum).toFixed(1)}`).join(" ");
    const a = `M${x(points[0].t)} ${y(0)} ${l.replace(/^M/, "L")} L${x(t1)} ${y(0)} Z`;
    const dl = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${yd(p.dd).toFixed(1)}`).join(" ");
    const da = `M${x(points[0].t)} ${yd(0)} ${dl.replace(/^M/, "L")} L${x(t1)} ${yd(0)} Z`;
    const ticks: { x: number; label: string }[] = [];
    const start = new Date(t0);
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const every = innerW < 420 ? 6 : 3;
    while (d.getTime() <= t1) {
      if (d.getUTCMonth() % every === 0) ticks.push({ x: x(d.getTime()), label: `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}` });
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
    return { line: l, area: a, ddLine: dl, ddArea: da, monthTicks: ticks };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, W, H, ddHeight]);

  const yTicks = niceTicks(minY, maxY, compact ? 3 : 4);
  const hp = hover !== null ? points[hover] : null;
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const t = t0 + ((px - pad.l) / innerW) * (t1 - t0);
    let lo = 0;
    let hi = points.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (points[mid].t < t) lo = mid;
      else hi = mid;
    }
    setHover(Math.abs(points[lo].t - t) < Math.abs(points[hi].t - t) ? lo : hi);
  };
  const last = points[points.length - 1];
  const totalH = H + (drawdown ? ddHeight : 0);

  return (
    <div className="eq" ref={ref}>
      {W > 0 && points.length > 1 && (
        <svg
          width={W}
          height={totalH}
          viewBox={`0 0 ${W} ${totalH}`}
          role="img"
          aria-label={`Cumulative R equity curve: ${points.length} closed calls, ending at ${last.cum.toFixed(1)}R`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id="eqfill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#F5B841" stopOpacity="0.22" />
              <stop offset="100%" stopColor="#F5B841" stopOpacity="0" />
            </linearGradient>
          </defs>
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke={v === 0 ? "#323946" : "#1b1f27"} />
              <text x={pad.l - 8} y={y(v) + 3.5} textAnchor="end" className="eq__tick">
                {fmtRTick(v)}
              </text>
            </g>
          ))}
          {monthTicks.map((m) => (
            <text key={m.label} x={m.x} y={H - 6} textAnchor="middle" className="eq__tick">
              {m.label}
            </text>
          ))}
          <path d={area} fill="url(#eqfill)" />
          <path d={line} fill="none" stroke="#F5B841" strokeWidth="1.6" strokeLinejoin="round" />
          <circle cx={x(last.t)} cy={y(last.cum)} r="3.5" fill="#F5B841" />
          {drawdown && (
            <g transform={`translate(0 ${H})`}>
              <line x1={pad.l} x2={W - pad.r} y1={yd(0)} y2={yd(0)} stroke="#323946" />
              <text x={pad.l - 8} y={yd(0) + 3.5} textAnchor="end" className="eq__tick">
                0R
              </text>
              <text x={pad.l - 8} y={yd(minDD) + 3.5} textAnchor="end" className="eq__tick">
                {fmtRTick(minDD)}
              </text>
              <path d={ddArea} fill="rgba(255, 92, 77, 0.16)" />
              <path d={ddLine} fill="none" stroke="#FF5C4D" strokeWidth="1.2" />
              <text x={W - pad.r} y={ddHeight - 4} textAnchor="end" className="eq__tick">
                drawdown from peak (R)
              </text>
            </g>
          )}
          {hp && (
            <g pointerEvents="none">
              <line x1={x(hp.t)} x2={x(hp.t)} y1={pad.t} y2={totalH - (drawdown ? 10 : pad.b)} stroke="#4a5263" strokeDasharray="3 3" />
              <circle cx={x(hp.t)} cy={y(hp.cum)} r="4" fill="#0A0B0D" stroke="#F5B841" strokeWidth="1.5" />
            </g>
          )}
        </svg>
      )}
      {hp && (
        <div className="eq__tip mono" style={{ left: Math.min(W - 170, Math.max(0, x(hp.t) + 10)) }}>
          <b>{hp.id}</b> · {new Date(hp.t).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit", timeZone: "UTC" })}
          <br />
          Trade <span className={hp.r >= 0 ? "c-long" : "c-short"}>{`${hp.r >= 0 ? "+" : MINUS}${Math.abs(hp.r).toFixed(2)}R`}</span> · Cum{" "}
          <span className="c-brand">
            {hp.cum >= 0 ? "+" : MINUS}
            {Math.abs(hp.cum).toFixed(1)}R
          </span>
          {drawdown && (
            <>
              <br />
              DD <span className="c-short">{hp.dd.toFixed(1)}R</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
