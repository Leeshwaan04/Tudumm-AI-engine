import type { Direction, Instrument, LayerScores, LiveStatus, TradeSignal } from "../engine/types";
import { LAYER_LABEL, LAYER_ORDER, LAYER_SHORT, agreement, entryMid, rAt } from "../engine/universe";
import { fmtPrice, fmtSignedPct, fmtLevel, MINUS } from "../engine/format";
import { useTick } from "../engine/live";
import { useReducedMotion } from "./hooks";

/* ---------- Direction ---------- */
export function DirectionPill({ direction, size = "md" }: { direction: Direction; size?: "sm" | "md" | "lg" }) {
  const long = direction === "LONG";
  return (
    <span className={`dpill dpill--${long ? "long" : "short"} dpill--${size}`} data-anchor="direction">
      <span aria-hidden="true">{long ? "▲" : "▼"}</span> {direction}
    </span>
  );
}

/* ---------- Status ---------- */
export const STATUS_LABEL: Record<LiveStatus, string> = {
  active: "Active",
  pending: "Entry pending",
  t1_hit: "T1 hit · stop at breakeven",
  sit_out: "Sitting out",
};
export function StatusPill({ status }: { status: LiveStatus }) {
  return (
    <span className={`spill spill--${status}`} data-anchor="status">
      <i aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}

/* ---------- Live price ---------- */
export function LivePrice({
  inst,
  showChange = false,
  className = "",
}: {
  inst: Instrument;
  showChange?: boolean;
  className?: string;
}) {
  const t = useTick(inst.symbol);
  const reduced = useReducedMotion();
  const chg = ((t.price - inst.prevClose) / inst.prevClose) * 100;
  const flash = !reduced && t.seq > 0 ? (t.dir > 0 ? "up" : t.dir < 0 ? "down" : "") : "";
  return (
    <span className={`lp ${className}`}>
      <span key={t.seq} className={`lp__px mono ${flash ? `lp--${flash}` : ""}`}>
        {fmtPrice(inst, t.price)}
      </span>
      {showChange && (
        <span className={`lp__chg mono ${chg >= 0 ? "c-long" : "c-short"}`}>
          <span aria-hidden="true">{chg >= 0 ? "▲" : "▼"}</span> {fmtSignedPct(chg)}
        </span>
      )}
    </span>
  );
}

/* ---------- Confluence meter ---------- */
export function ConfluenceMeter({
  layers,
  tone = "trade",
  showScores = false,
  showHeader = true,
}: {
  layers: LayerScores;
  tone?: "trade" | "sitout" | "sealed";
  showScores?: boolean;
  showHeader?: boolean;
}) {
  const a = agreement(layers);
  const label = LAYER_ORDER.map((l) => `${LAYER_LABEL[l]} ${layers[l] === null ? "not applicable" : layers[l]}`).join(", ");
  return (
    <div className={`cm cm--${tone} ${showScores ? "cm--scores" : ""}`} data-anchor="confluence">
      {showHeader && (
        <div className="cm__head">
          <span className="eyebrow">Confluence</span>
          <span className="cm__sum mono">
            {tone === "sealed" ? (
              "sealed"
            ) : (
              <>
                {a.agree}/{a.applicable} agree{a.na ? ` · ${a.na} N/A` : ""}
              </>
            )}
          </span>
        </div>
      )}
      <div className="cm__row" role="img" aria-label={`Layer agreement: ${label}`}>
        {LAYER_ORDER.map((l) => {
          const v = layers[l];
          const na = v === null;
          const neg = !na && v! < 0;
          const w = na ? 100 : Math.min(100, Math.abs(v!));
          return (
            <div key={l} className={`cm__seg ${na ? "is-na" : neg ? "is-neg" : "is-pos"}`} title={`${LAYER_LABEL[l]}: ${na ? "N/A" : v}`}>
              <span className="cm__lab">{LAYER_SHORT[l]}</span>
              <span className="cm__bar">
                {tone === "sealed" ? (
                  <i className="cm__fill cm__fill--sealed" style={{ width: "100%" }} />
                ) : na ? (
                  <i className="cm__fill hatch" style={{ width: "100%" }}>
                    <em>N/A</em>
                  </i>
                ) : (
                  <i className="cm__fill" style={{ width: `${Math.max(3, w)}%` }} />
                )}
              </span>
              {showScores && (
                <b className="cm__score mono">{na ? "N/A" : v! > 0 ? `+${v}` : v === 0 ? "0" : `${MINUS}${Math.abs(v!)}`}</b>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- Trade map ---------- */
function rLabel(r: number): string {
  if (Math.abs(r) < 0.005) return "0";
  const s = Math.abs(r).toFixed(1).replace(/\.0$/, "");
  return `${r > 0 ? "+" : MINUS}${s}R`;
}

export function TradeMap({
  inst,
  signal: s,
  status,
  price,
  big = false,
}: {
  inst: Instrument;
  signal: TradeSignal;
  status: LiveStatus;
  price?: number;
  big?: boolean;
}) {
  const t = useTick(inst.symbol);
  const px = price ?? t.price;
  const rMin = -1.25;
  const rMax = s.rr2 + 0.3;
  const x = (r: number) => ((Math.min(rMax, Math.max(rMin, r)) - rMin) / (rMax - rMin)) * 100;
  const zA = rAt(s, s.entryLow);
  const zB = rAt(s, s.entryHigh);
  const zLo = Math.min(zA, zB);
  const zHi = Math.max(zA, zB);
  const rNow = rAt(s, px);
  const xs = { sl: x(-1), zl: x(zLo), zh: x(zHi), e: x(0), t1: x(s.rr1), t2: x(s.rr2), now: x(rNow) };
  const t1 = status === "t1_hit";
  const aria = `Trade map. Stop ${fmtLevel(inst, s.stop)} at minus 1R. Entry ${fmtLevel(inst, s.entryLow)} to ${fmtLevel(inst, s.entryHigh)}. Target 1 ${fmtLevel(inst, s.target1)} at ${s.rr1}R. Target 2 ${fmtLevel(inst, s.target2)} at ${s.rr2}R. Price now ${fmtPrice(inst, px)}, ${rNow.toFixed(2)}R.`;
  const lab = (pos: number, cls: string, text: string, anchor?: string) => (
    <span className={`tm__lab ${cls}`} style={{ left: `${pos}%`, ["--x" as string]: pos }} data-anchor={anchor}>
      {text}
    </span>
  );
  return (
    <div className={`tm ${big ? "tm--big" : ""} ${t1 ? "tm--t1" : ""}`} role="img" aria-label={aria} data-anchor="trademap">
      <div className="tm__labels tm__labels--r mono">
        {lab(xs.sl, "is-sl", "−1R")}
        {lab(xs.e, "is-e", "0")}
        {lab(xs.t1, "is-t", rLabel(s.rr1))}
        {lab(xs.t2, "is-t", rLabel(s.rr2))}
      </div>
      <div className="tm__track">
        <span className="tm__rail" />
        <span className="tm__seg tm__seg--loss" style={{ left: `${xs.sl}%`, width: `${Math.max(0, xs.zl - xs.sl)}%` }} />
        <span className="tm__seg tm__seg--gain" style={{ left: `${xs.zh}%`, width: `${Math.max(0, xs.t2 - xs.zh)}%` }} />
        <span className="tm__zone" style={{ left: `${xs.zl}%`, width: `${Math.max(1.2, xs.zh - xs.zl)}%` }} data-anchor="entry" />
        <span className="tm__tick tm__tick--sl" style={{ left: `${xs.sl}%` }} data-anchor="stop" />
        {t1 && <span className="tm__tick tm__tick--be" style={{ left: `${xs.e}%` }} title="Stop trailed to breakeven" />}
        <span className="tm__tick tm__tick--t tm__tick--t1" style={{ left: `${xs.t1}%` }} data-anchor="t1" />
        <span className="tm__tick tm__tick--t" style={{ left: `${xs.t2}%` }} data-anchor="t2" />
        <span className="tm__needle" style={{ left: `${xs.now}%` }} data-anchor="needle">
          <b />
        </span>
      </div>
      <div className="tm__labels tm__labels--n mono">
        {lab(xs.sl, "is-sl", t1 ? "SL→BE" : "SL")}
        {lab(xs.e, "is-e", "Entry")}
        {lab(xs.t1, "is-t", t1 ? "T1 ✓" : "T1")}
        {lab(xs.t2, "is-t", "T2")}
      </div>
    </div>
  );
}

/* ---------- Levels row ---------- */
export function LevelsRow({ inst, s }: { inst: Instrument; s: TradeSignal }) {
  return (
    <dl className="levels mono" data-anchor="levels">
      <div data-anchor="lv-entry">
        <dt>Entry</dt>
        <dd>
          {fmtLevel(inst, s.entryLow)}–{fmtLevel(inst, s.entryHigh)}
        </dd>
      </div>
      <div data-anchor="lv-stop">
        <dt>SL</dt>
        <dd className="c-short">{fmtLevel(inst, s.stop)}</dd>
      </div>
      <div data-anchor="lv-t1">
        <dt>T1</dt>
        <dd className="c-long">{fmtLevel(inst, s.target1)}</dd>
      </div>
      <div data-anchor="lv-t2">
        <dt>T2</dt>
        <dd className="c-long">{fmtLevel(inst, s.target2)}</dd>
      </div>
      <div data-anchor="lv-rr">
        <dt>R:R</dt>
        <dd>
          {s.rr1.toFixed(2)} / {s.rr2.toFixed(2)}
        </dd>
      </div>
    </dl>
  );
}

/** Distance from price to the entry zone, as % of price (for pending entries). */
export function distanceToZone(s: TradeSignal, px: number): number {
  if (px >= s.entryLow && px <= s.entryHigh) return 0;
  const edge = px > s.entryHigh ? s.entryHigh : s.entryLow;
  return ((px - edge) / px) * 100;
}

export { entryMid };
