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
  type IPrimitivePaneRenderer,
  type IPrimitivePaneView,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesPrimitive,
  type SeriesAttachedParameter,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Instrument, LiveStatus } from "../engine/types";
import { isTrade } from "../engine/types";
import { genCandles, withLivePrice, type Candle, type Timeframe } from "../engine/candles";
import { ema } from "../engine/indicators";
import { live } from "../engine/live";
import { entryMid } from "../engine/seed";

type DrawTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

/** Shaded entry-zone band drawn behind the candles (series primitive, lightweight-charts v5). */
class EntryBand implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private readonly views: readonly IPrimitivePaneView[];
  constructor(
    private lo: number,
    private hi: number,
  ) {
    const renderer: IPrimitivePaneRenderer = {
      draw: () => undefined,
      drawBackground: (target: DrawTarget) => {
        const s = this.series;
        if (!s) return;
        const y1 = s.priceToCoordinate(this.hi);
        const y2 = s.priceToCoordinate(this.lo);
        if (y1 === null || y2 === null) return;
        target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, verticalPixelRatio: vpr }) => {
          const top = Math.round(Math.min(y1, y2) * vpr);
          const h = Math.max(2, Math.round(Math.abs(y2 - y1) * vpr));
          ctx.fillStyle = "rgba(245, 184, 65, 0.10)";
          ctx.fillRect(0, top, bitmapSize.width, h);
          ctx.fillStyle = "rgba(245, 184, 65, 0.55)";
          const lw = Math.max(1, Math.round(vpr));
          ctx.fillRect(0, top, bitmapSize.width, lw);
          ctx.fillRect(0, top + h - lw, bitmapSize.width, lw);
        });
      },
    };
    this.views = [{ zOrder: () => "bottom", renderer: () => renderer }];
  }
  attached(p: SeriesAttachedParameter<Time, SeriesType>) {
    this.series = p.series;
  }
  detached() {
    this.series = null;
  }
  paneViews() {
    return this.views;
  }
}

export interface PriceChartProps {
  inst: Instrument;
  tf: Timeframe;
  showEma: boolean;
  status: LiveStatus;
}

const C = {
  text: "#807E75",
  grid: "rgba(35, 40, 51, 0.55)",
  line: "#232833",
  long: "#3DD68C",
  short: "#FF5C4D",
  brand: "#F5B841",
  ema20: "#7FA7FF",
  ema50: "#C9A6FF",
};

export function PriceChart({ inst, tf, showEma, status }: PriceChartProps) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);
  const e20 = useRef<ISeriesApi<"Line"> | null>(null);
  const e50 = useRef<ISeriesApi<"Line"> | null>(null);
  const data = useRef<Candle[]>([]);
  const lines = useRef<IPriceLine[]>([]);

  // create once per instrument
  useEffect(() => {
    if (!el.current) return;
    const s = inst.signal;
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
      timeScale: { borderColor: C.line, timeVisible: true, secondsVisible: false, rightOffset: 6 },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#4a5263", labelBackgroundColor: "#20252E" },
        horzLine: { color: "#4a5263", labelBackgroundColor: "#20252E" },
      },
      localization: { priceFormatter: (p: number) => p.toLocaleString(inst.currency === "INR" ? "en-IN" : "en-US", { minimumFractionDigits: inst.decimals, maximumFractionDigits: inst.decimals }) },
    });
    const lvls = isTrade(s) ? [s.stop, s.target2, s.entryLow, s.entryHigh] : [];
    const cs = c.addSeries(CandlestickSeries, {
      upColor: C.long,
      downColor: C.short,
      borderVisible: false,
      wickUpColor: C.long,
      wickDownColor: C.short,
      priceLineColor: "#EEEAE0",
      priceLineStyle: LineStyle.Dotted,
      autoscaleInfoProvider: (original: () => { priceRange: { minValue: number; maxValue: number } } | null) => {
        const res = original();
        if (!res || !lvls.length) return res;
        return {
          ...res,
          priceRange: {
            minValue: Math.min(res.priceRange.minValue, ...lvls),
            maxValue: Math.max(res.priceRange.maxValue, ...lvls),
          },
        };
      },
    });
    cs.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.24 } });
    const vs = c.addSeries(HistogramSeries, {
      priceScaleId: "vol",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const l20 = c.addSeries(LineSeries, { color: C.ema20, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const l50 = c.addSeries(LineSeries, { color: C.ema50, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    if (isTrade(s)) cs.attachPrimitive(new EntryBand(s.entryLow, s.entryHigh));
    chart.current = c;
    candles.current = cs;
    volume.current = vs;
    e20.current = l20;
    e50.current = l50;

    const unsub = live.subscribeSymbol(inst.symbol)(() => {
      const arr = data.current;
      if (!arr.length || !candles.current) return;
      const px = live.getTick(inst.symbol).price;
      const last = withLivePrice(arr[arr.length - 1], px);
      arr[arr.length - 1] = last;
      candles.current.update({ time: last.time as UTCTimestamp, open: last.open, high: last.high, low: last.low, close: last.close });
      const closes = arr.map((k) => k.close);
      const a = ema(closes, 20);
      const b = ema(closes, 50);
      e20.current?.update({ time: last.time as UTCTimestamp, value: a[a.length - 1] });
      e50.current?.update({ time: last.time as UTCTimestamp, value: b[b.length - 1] });
    });
    return () => {
      unsub();
      c.remove();
      chart.current = null;
      candles.current = null;
      lines.current = [];
    };
  }, [inst]);

  // (re)generate deterministic candles ending at the live price
  useEffect(() => {
    const cs = candles.current;
    if (!cs || !chart.current) return;
    const arr = genCandles(inst, tf, live.getTick(inst.symbol).price);
    data.current = arr;
    cs.setData(arr.map((k) => ({ time: k.time as UTCTimestamp, open: k.open, high: k.high, low: k.low, close: k.close })));
    volume.current?.setData(
      arr.map((k) => ({
        time: k.time as UTCTimestamp,
        value: k.volume,
        color: k.close >= k.open ? "rgba(61, 214, 140, 0.32)" : "rgba(255, 92, 77, 0.32)",
      })),
    );
    const closes = arr.map((k) => k.close);
    const toLine = (vals: number[]) =>
      vals.map((v, i) => ({ time: arr[i].time as UTCTimestamp, value: v })).filter((p) => !Number.isNaN(p.value));
    e20.current?.setData(toLine(ema(closes, 20)));
    e50.current?.setData(toLine(ema(closes, 50)));
    chart.current.timeScale().setVisibleLogicalRange({ from: arr.length - 130, to: arr.length + 4 });
  }, [inst, tf]);

  useEffect(() => {
    e20.current?.applyOptions({ visible: showEma });
    e50.current?.applyOptions({ visible: showEma });
  }, [showEma, inst]);

  // price lines follow status (t1_hit draws the breakeven stop)
  useEffect(() => {
    const cs = candles.current;
    const s = inst.signal;
    if (!cs) return;
    lines.current.forEach((l) => cs.removePriceLine(l));
    lines.current = [];
    if (!isTrade(s) || status === "queued") return;
    const add = (price: number, color: string, title: string, style = LineStyle.Dashed) =>
      lines.current.push(cs.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
    add(s.stop, C.short, status === "t1_hit" ? "SL (orig)" : "SL", status === "t1_hit" ? LineStyle.Dotted : LineStyle.Dashed);
    if (status === "t1_hit") add(entryMid(s), C.brand, "SL → BE", LineStyle.Solid);
    add(s.target1, C.long, "T1");
    add(s.target2, C.long, "T2");
  }, [status, inst]);

  return <div ref={el} className="chart" />;
}
