import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Instrument, LiveStatus } from "../engine/types";
import { isTrade } from "../engine/types";
import { ema } from "../engine/indicators";
import { activeLive } from "../engine/live";
import { entryMid } from "../engine/universe";
import type { Bar } from "../api/market";
import { C, EntryBand } from "./PriceChart";

export const TF_SECONDS: Record<string, number> = { "15m": 900, "1H": 3600, "4H": 14400, "1D": 86400, "1W": 604800 };

/**
 * Chart of real bars from GET /api/v1/market/candles. Close-only sources (ECB FX) draw a line.
 * For real-time instruments the last bar follows the Binance stream; nothing is simulated.
 */
export function LiveChart({
  inst,
  bars,
  line,
  tfSec,
  tickable,
  showEma,
  status,
}: {
  inst: Instrument;
  bars: Bar[];
  line: boolean;
  tfSec: number;
  tickable: boolean;
  showEma: boolean;
  status: LiveStatus;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const main = useRef<ISeriesApi<"Candlestick"> | ISeriesApi<"Line"> | null>(null);
  const vol = useRef<ISeriesApi<"Histogram"> | null>(null);
  const e20 = useRef<ISeriesApi<"Line"> | null>(null);
  const e50 = useRef<ISeriesApi<"Line"> | null>(null);
  const data = useRef<Bar[]>([]);
  const lines = useRef<IPriceLine[]>([]);

  // create once per instrument / series kind
  useEffect(() => {
    if (!el.current) return;
    const s = inst.signal;
    const loc = inst.currency === "INR" ? "en-IN" : "en-US";
    const c = createChart(el.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: C.text,
        fontFamily: '"Geist Mono Variable", "Geist Mono", ui-monospace, monospace',
        fontSize: 11,
        attributionLogo: true,
      },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      rightPriceScale: { borderColor: C.line },
      timeScale: { borderColor: C.line, timeVisible: tfSec < 86400, secondsVisible: false, rightOffset: 6 },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#4a5263", labelBackgroundColor: "#20252E" },
        horzLine: { color: "#4a5263", labelBackgroundColor: "#20252E" },
      },
      localization: { priceFormatter: (p: number) => p.toLocaleString(loc, { minimumFractionDigits: inst.decimals, maximumFractionDigits: inst.decimals }) },
    });
    const lvls = isTrade(s) ? [s.stop, s.target2, s.entryLow, s.entryHigh] : [];
    const autoscale = (original: () => { priceRange: { minValue: number; maxValue: number } } | null) => {
      const res = original();
      if (!res || !lvls.length) return res;
      return { ...res, priceRange: { minValue: Math.min(res.priceRange.minValue, ...lvls), maxValue: Math.max(res.priceRange.maxValue, ...lvls) } };
    };
    const m = line
      ? c.addSeries(LineSeries, { color: "#EEEAE0", lineWidth: 2, priceLineColor: "#EEEAE0", priceLineStyle: LineStyle.Dotted, autoscaleInfoProvider: autoscale })
      : c.addSeries(CandlestickSeries, {
          upColor: C.long,
          downColor: C.short,
          borderVisible: false,
          wickUpColor: C.long,
          wickDownColor: C.short,
          priceLineColor: "#EEEAE0",
          priceLineStyle: LineStyle.Dotted,
          autoscaleInfoProvider: autoscale,
        });
    m.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: line ? 0.08 : 0.24 } });
    if (!line) {
      const vs = c.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
      c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      vol.current = vs;
    }
    e20.current = c.addSeries(LineSeries, { color: C.ema20, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    e50.current = c.addSeries(LineSeries, { color: C.ema50, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    if (isTrade(s)) m.attachPrimitive(new EntryBand(s.entryLow, s.entryHigh));
    chart.current = c;
    main.current = m;
    return () => {
      c.remove();
      chart.current = null;
      main.current = null;
      vol.current = null;
      lines.current = [];
    };
  }, [inst.symbol, line, tfSec]); // eslint-disable-line react-hooks/exhaustive-deps

  const pushBar = (b: Bar) => {
    const m = main.current;
    if (!m) return;
    if (line) (m as ISeriesApi<"Line">).update({ time: b.t as UTCTimestamp, value: b.c });
    else (m as ISeriesApi<"Candlestick">).update({ time: b.t as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c });
  };
  const emaTail = () => {
    const arr = data.current;
    const closes = arr.map((k) => k.c);
    const a = ema(closes, 20);
    const b = ema(closes, 50);
    const last = arr[arr.length - 1];
    if (!last) return;
    if (Number.isFinite(a[a.length - 1])) e20.current?.update({ time: last.t as UTCTimestamp, value: a[a.length - 1] });
    if (Number.isFinite(b[b.length - 1])) e50.current?.update({ time: last.t as UTCTimestamp, value: b[b.length - 1] });
  };

  // data
  useEffect(() => {
    const m = main.current;
    if (!m || !chart.current) return;
    const arr = bars.filter((b) => Number.isFinite(b.t) && Number.isFinite(b.c)).map((b) => ({ ...b }));
    data.current = arr;
    if (line) (m as ISeriesApi<"Line">).setData(arr.map((k) => ({ time: k.t as UTCTimestamp, value: k.c })));
    else (m as ISeriesApi<"Candlestick">).setData(arr.map((k) => ({ time: k.t as UTCTimestamp, open: k.o, high: k.h, low: k.l, close: k.c })));
    vol.current?.setData(arr.map((k) => ({ time: k.t as UTCTimestamp, value: k.v ?? 0, color: k.c >= k.o ? "rgba(61, 214, 140, 0.32)" : "rgba(255, 92, 77, 0.32)" })));
    const closes = arr.map((k) => k.c);
    const toLine = (vals: number[]) => vals.map((v, i) => ({ time: arr[i].t as UTCTimestamp, value: v })).filter((p) => Number.isFinite(p.value));
    e20.current?.setData(toLine(ema(closes, 20)));
    e50.current?.setData(toLine(ema(closes, 50)));
    if (arr.length > 0) chart.current.timeScale().setVisibleLogicalRange({ from: Math.max(-2, arr.length - 130), to: arr.length + 4 });
  }, [bars, line]);

  // real-time: the last bar follows the stream (and rolls over when a new bar opens)
  useEffect(() => {
    if (!tickable) return;
    const store = activeLive();
    return store.subscribeSymbol(inst.symbol)(() => {
      const arr = data.current;
      if (!arr.length) return;
      const tk = store.getTick(inst.symbol);
      const px = tk.price;
      if (!(px > 0)) return;
      const nowSec = Math.floor((tk.at ?? Date.now()) / 1000);
      let last = arr[arr.length - 1];
      if (nowSec >= last.t + tfSec) {
        const t = last.t + Math.floor((nowSec - last.t) / tfSec) * tfSec;
        last = { t, o: last.c, h: Math.max(last.c, px), l: Math.min(last.c, px), c: px, v: 0 };
        arr.push(last);
      } else {
        last = { ...last, h: Math.max(last.h, px), l: Math.min(last.l, px), c: px };
        arr[arr.length - 1] = last;
      }
      pushBar(last);
      emaTail();
    });
  }, [inst.symbol, tickable, tfSec, line]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    e20.current?.applyOptions({ visible: showEma });
    e50.current?.applyOptions({ visible: showEma });
  }, [showEma, inst.symbol, line, tfSec]);

  // signal levels
  useEffect(() => {
    const m = main.current;
    const s = inst.signal;
    if (!m) return;
    lines.current.forEach((l) => m.removePriceLine(l));
    lines.current = [];
    if (!isTrade(s) || status === "sit_out") return;
    const add = (price: number, color: string, title: string, style = LineStyle.Dashed) =>
      lines.current.push(m.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
    add(s.stop, C.short, status === "t1_hit" ? "SL (orig)" : "SL", status === "t1_hit" ? LineStyle.Dotted : LineStyle.Dashed);
    if (status === "t1_hit") add(entryMid(s), C.brand, "SL → BE", LineStyle.Solid);
    add(s.target1, C.long, "T1");
    add(s.target2, C.long, "T2");
  }, [status, inst, line, tfSec]);

  return <div ref={el} className="chart" />;
}
