import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";

/*
 * Shared chart primitives for LiveChart (the simulated-candle PriceChart was removed with Demo mode;
 * every chart now draws real bars from /api/v1/market/candles).
 */

type DrawTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

/** Shaded entry-zone band drawn behind the candles (series primitive, lightweight-charts v5). */
export class EntryBand implements ISeriesPrimitive<Time> {
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

export const C = {
  text: "#807E75",
  grid: "rgba(35, 40, 51, 0.55)",
  line: "#232833",
  long: "#3DD68C",
  short: "#FF5C4D",
  brand: "#F5B841",
  ema20: "#7FA7FF",
  ema50: "#C9A6FF",
};
