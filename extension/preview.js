// Preview showcase: mounts the real content-script chip on a mock chart page and
// drives the real popup + side panel (in iframes) from the same page.
// Everything shown is live API data (or a recorded live snapshot with
// ?universe=…): the mock page's chart draws real daily candles from
// /api/v1/market/candles, or says there are none. Nothing is generated.
import { createEngine, siteFor, terminalUrl, formatPct } from "./lib/engine.js";
import { validateMessage, handleDetect, handleSnapshot } from "./lib/protocol.js";
import * as P from "./lib/platform.js";
import * as UI from "./lib/ui.js";

const EXAMPLES = [
  { label: "TradingView · chart · NSE:RELIANCE", url: "https://www.tradingview.com/chart/?symbol=NSE%3ARELIANCE", title: "RELIANCE · Unnamed" },
  { label: "TradingView · symbol page · NSE-RELIANCE", url: "https://www.tradingview.com/symbols/NSE-RELIANCE/", title: "Reliance Industries Ltd. Stock Price | NSE:RELIANCE" },
  { label: "Yahoo Finance · RELIANCE.NS", url: "https://finance.yahoo.com/quote/RELIANCE.NS", title: "Reliance Industries Limited (RELIANCE.NS) Stock Price" },
  { label: "Yahoo Finance · BTC-USD", url: "https://finance.yahoo.com/quote/BTC-USD", title: "Bitcoin USD (BTC-USD) Price, Value, News & History" },
  { label: "Yahoo Finance · EURUSD=X", url: "https://finance.yahoo.com/quote/EURUSD=X", title: "EUR/USD (EURUSD=X) Live Rate, Chart & News" },
  { label: "Yahoo Finance · GC=F (gold)", url: "https://finance.yahoo.com/quote/GC=F", title: "Gold Dec 26 (GC=F) Stock Price, News, Quote & History" },
  { label: "Yahoo Finance · ^NSEI (NIFTY 50)", url: "https://finance.yahoo.com/quote/%5ENSEI", title: "NIFTY 50 (^NSEI) Charts, Data & News" },
  { label: "Yahoo Finance · TSLA", url: "https://finance.yahoo.com/quote/TSLA", title: "Tesla, Inc. (TSLA) Stock Price, News, Quote & History" },
  { label: "Yahoo Finance · ICICIBANK.NS", url: "https://finance.yahoo.com/quote/ICICIBANK.NS", title: "ICICI Bank Limited (ICICIBANK.NS) Stock Price" },
  { label: "Google Finance · RELIANCE:NSE", url: "https://www.google.com/finance/quote/RELIANCE:NSE", title: "Reliance Industries Ltd (RELIANCE) Stock Price & News - Google Finance" },
  { label: "Zerodha Kite · ciq NSE/RELIANCE", url: "https://kite.zerodha.com/chart/ext/ciq/NSE/RELIANCE/738561", title: "RELIANCE / Kite" },
  { label: "Zerodha Kite · tvc NSE/SBIN", url: "https://kite.zerodha.com/chart/web/tvc/NSE/SBIN/779521", title: "SBIN / Kite" },
  { label: "NSE India · get-quotes RELIANCE", url: "https://www.nseindia.com/get-quotes/equity?symbol=RELIANCE", title: "RELIANCE Share Price Today - NSE India" },
  { label: "Binance · spot BTC_USDT", url: "https://www.binance.com/en/trade/BTC_USDT", title: "BTCUSDT | Binance Spot" },
  { label: "Binance · futures BTCUSDT", url: "https://www.binance.com/en/futures/BTCUSDT", title: "BTCUSDT Perpetual | Binance Futures" },
  { label: "Binance · spot SOL_USDT", url: "https://www.binance.com/en/trade/SOL_USDT", title: "SOLUSDT | Binance Spot" },
  { label: "Investing.com · title “Apple Inc (AAPL)…”", url: "https://www.investing.com/equities/apple-computer-inc", title: "Apple Inc (AAPL) Stock Price Today - Investing.com" },
  { label: "Moneycontrol · title “Nifty Bank…”", url: "https://www.moneycontrol.com/indian-indices/nifty-bank-23.html", title: "Nifty Bank Live - Nifty Bank Index Today | Moneycontrol" },
  { label: "TradingView · NASDAQ:AMZN (not covered yet)", url: "https://www.tradingview.com/chart/?symbol=NASDAQ%3AAMZN", title: "AMZN · Unnamed" },
  { label: "google.com/search (unsupported site: no chip)", url: "https://www.google.com/search?q=reliance+share+price", title: "reliance share price - Google Search" },
];

const $ = (id) => document.getElementById(id);
const live = UI.createLive();
let engine = null; // null while offline
let payload = null;
let chip;
let candleReq = 0;
let current = null; // { url, title }
let det = null;
let candles = null;
let canvas = null;
let hostUnsub = null;

// --------------------------------------------------------------- chip env --

function pingFrame(id) {
  const wrap = $(id);
  if (!wrap) return;
  wrap.classList.add("is-pinged");
  wrap.scrollIntoView({ block: "nearest", behavior: UI.reducedMotion() ? "auto" : "smooth" });
  setTimeout(() => wrap.classList.remove("is-pinged"), 1800);
}

const chipEnv = {
  container: null,
  async send(raw) {
    const msg = validateMessage(raw);
    if (!msg) return { ok: false };
    if (!engine && (msg.type === "detect" || msg.type === "snapshot")) {
      // Same answer as the background when there's no live data.
      const site = msg.type === "detect" ? siteFor(msg.url) : null;
      if (msg.type === "snapshot") return { ok: false, offline: true, reasonText: payload && payload.reasonText };
      return site ? { ok: true, offline: true, site: site.key, siteLabel: site.label, reasonText: payload && payload.reasonText, retryInMs: (payload && payload.retryInMs) || 15000 } : { ok: true, detection: null, snapshot: null };
    }
    if (msg.type === "detect") return handleDetect(engine, msg);
    if (msg.type === "snapshot") return handleSnapshot(engine, msg);
    if (msg.type === "openSidePanel") {
      P.toast("Open side panel: available when installed. In preview it's frame C.", { tone: "preview" });
      pingFrame("frame-panel-wrap");
      return { ok: true };
    }
    if (msg.type === "openTerminal") {
      const { webUrl } = await P.getSettings();
      const url = terminalUrl(webUrl, msg.symbol);
      if (url) P.openUrl(url);
      else P.toast("Set a valid http(s) web app URL in Options.", { tone: "warn" });
      return { ok: !!url };
    }
    return { ok: false };
  },
  getSettings: () => P.getSettings(),
  async setSiteEnabled(key, on) {
    const s = await P.getSettings();
    s.sites = { ...s.sites, [key]: !!on };
    await P.saveSettings(s);
  },
  onSettingsChanged(cb) {
    P.storage.onChanged((changes, area) => {
      if (area === "sync" && changes.settings) {
        P.getSettings().then((s) => {
          cb(s);
          renderHiddenBanner(s);
        });
      }
    });
  },
};

// -------------------------------------------------------------- host page --

/** Real daily candles for the mock chart from GET /api/v1/market/candles, or null. */
async function loadCandles(inst, n = 96) {
  const origin = payload && payload.origin;
  if (!origin) return null;
  try {
    const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(7000) : undefined;
    const res = await fetch(`${origin}/api/v1/market/candles?symbol=${encodeURIComponent(inst.symbol)}&tf=1D&limit=${n}`, { credentials: "omit", cache: "no-store", headers: { accept: "application/json" }, signal });
    if (!res.ok || !/json/i.test(res.headers.get("content-type") || "")) return null;
    const d = await res.json();
    const ok = (b) => b && [b.o, b.h, b.l, b.c].every((v) => typeof v === "number" && Number.isFinite(v) && v > 0);
    const bars = (Array.isArray(d && d.bars) ? d.bars : []).filter(ok).slice(-n);
    if (bars.length < 2) return null;
    const vmax = Math.max(1e-9, ...bars.map((b) => (Number.isFinite(b.v) && b.v > 0 ? b.v : 0)));
    return { tf: typeof d.tf === "string" ? d.tf.slice(0, 4) : "1D", bars: bars.map((b) => ({ open: b.o, close: b.c, hi: b.h, lo: b.l, v: Number.isFinite(b.v) && b.v > 0 ? b.v / vmax : 0 })) };
  } catch {
    return null;
  }
}

function drawChart() {
  if (!canvas || !candles) return;
  const box = canvas.parentElement.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.max(200, Math.floor(box.width));
  const H = Math.max(160, Math.floor(box.height));
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
    canvas.width = W * dpr;
    canvas.height = H * dpr;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const padR = 64;
  const volH = H * 0.16;
  const plotH = H - volH - 34;
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of candles) {
    lo = Math.min(lo, c.lo);
    hi = Math.max(hi, c.hi);
  }
  const pad = (hi - lo) * 0.08;
  lo -= pad;
  hi += pad;
  const y = (p) => 28 + (1 - (p - lo) / (hi - lo)) * plotH;
  ctx.strokeStyle = "#f0f1f4";
  ctx.lineWidth = 1;
  ctx.font = "10px ui-monospace, Menlo, monospace";
  ctx.fillStyle = "#8a91a2";
  for (let i = 0; i <= 5; i++) {
    const p = lo + ((hi - lo) * i) / 5;
    const yy = Math.round(y(p)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, yy);
    ctx.lineTo(W - padR, yy);
    ctx.stroke();
    ctx.fillText(p.toFixed(p > 1000 ? 0 : 2), W - padR + 8, yy + 3);
  }
  const n = candles.length;
  const step = (W - padR - 8) / n;
  const bw = Math.max(2, step * 0.62);
  candles.forEach((c, i) => {
    const x = 4 + i * step + step / 2;
    const up = c.close >= c.open;
    ctx.strokeStyle = ctx.fillStyle = up ? "#0f9d63" : "#d93a2b";
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, y(c.hi));
    ctx.lineTo(Math.round(x) + 0.5, y(c.lo));
    ctx.stroke();
    const top = y(Math.max(c.open, c.close));
    const h = Math.max(1, Math.abs(y(c.open) - y(c.close)));
    ctx.fillRect(x - bw / 2, top, bw, h);
    ctx.globalAlpha = 0.16;
    ctx.fillRect(x - bw / 2, H - 4 - c.v * volH * 0.8, bw, c.v * volH * 0.8);
    ctx.globalAlpha = 1;
  });
  const last = candles[n - 1];
  const ly = Math.round(y(last.close)) + 0.5;
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = "#2c4bd8";
  ctx.beginPath();
  ctx.moveTo(0, ly);
  ctx.lineTo(W - padR, ly);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#2c4bd8";
  ctx.fillRect(W - padR + 2, ly - 9, padR - 4, 18);
  ctx.fillStyle = "#fff";
  ctx.fillText(last.close.toFixed(last.close > 1000 ? 1 : 2), W - padR + 7, ly + 3.5);
}

function renderHost() {
  const host = $("host");
  if (hostUnsub) hostUnsub();
  hostUnsub = null;
  canvas = null;
  candles = null;
  const { h } = UI;
  const siteName = det && det.siteLabel ? det.siteLabel : "Web page";
  const nav = h("div", { class: "host-nav" }, h("span", { class: "host-logo" }, `${siteName} (mock)`), h("span", {}, "Markets"), h("span", {}, "Screener"), h("span", {}, "News"));
  const inst = det && det.symbol && engine ? engine.get(det.symbol) : null;
  if (!engine) {
    host.replaceChildren(
      nav,
      h(
        "div",
        { class: "host-empty" },
        h("b", {}, "Live data temporarily unavailable — retrying"),
        h("span", {}, (payload && payload.reasonText) || "The Tudumm market API didn't answer."),
        h("button", { type: "button", class: "btn btn--sm", onclick: () => location.reload() }, "Retry now"),
      ),
    );
  } else if (inst && !(inst.price > 0)) {
    host.replaceChildren(nav, h("div", { class: "host-sym" }, h("h2", {}, inst.symbol), h("span", { class: "sub" }, `${inst.name} · ${inst.exchange}`)), h("div", { class: "host-empty" }, h("b", {}, "No price yet"), h("span", {}, "The live API has no quote for this instrument yet, so there is nothing to chart.")));
  } else if (inst) {
    const px = h("span", { class: "px" });
    const ch = h("span", { class: "ch" });
    const setPx = (now) => {
      const q = engine.quote(inst.symbol, now);
      px.textContent = UI.h("span").textContent || engine.snapshot(inst.symbol, now).priceText;
      ch.textContent = q.change == null ? (q.changePct == null ? "" : formatPct(q.changePct)) : `${q.change >= 0 ? "+" : "−"}${Math.abs(q.change).toFixed(inst.decimals)} (${formatPct(q.changePct)})`;
      ch.className = `ch ${(q.change ?? q.changePct ?? 0) >= 0 ? "up" : "dn"}`;
      // Only a real-time quote belongs in today's bar (delayed / end-of-day prices don't).
      if (candles && q.price != null && inst.freshness === "realtime") {
        const c = candles[candles.length - 1];
        c.close = q.price;
        c.hi = Math.max(c.hi, q.price);
        c.lo = Math.min(c.lo, q.price);
        drawChart();
      }
    };
    const chart = h("div", { class: "host-chart" }, h("div", { class: "host-empty" }, h("b", {}, "Loading daily candles…")));
    host.replaceChildren(nav, h("div", { class: "host-sym" }, h("h2", {}, inst.symbol), h("span", { class: "sub" }, `${inst.name} · ${inst.exchange}`), px, ch), chart);
    const req = ++candleReq;
    loadCandles(inst).then((got) => {
      if (req !== candleReq) return;
      if (!got) {
        chart.replaceChildren(h("div", { class: "host-empty" }, h("b", {}, "No chart"), h("span", {}, "The Tudumm API has no candles for this instrument here, so nothing is drawn.")));
        return;
      }
      candles = got.bars;
      canvas = h("canvas", { "aria-label": `Daily candles for ${inst.symbol} from the Tudumm API`, role: "img" });
      chart.replaceChildren(canvas, h("div", { class: "host-tf" }, ["1D"].map((t) => h("span", { class: t === got.tf ? "on" : "" }, t))));
      setPx(Date.now());
      requestAnimationFrame(drawChart);
    });
    let lastTick = null;
    setPx(Date.now());
    hostUnsub = live.subscribe((now) => {
      const t = engine.quote(inst.symbol, now).tick;
      if (t !== lastTick) {
        lastTick = t;
        setPx(now);
      }
    });
    requestAnimationFrame(drawChart);
  } else if (det && det.ticker) {
    host.replaceChildren(nav, h("div", { class: "host-sym" }, h("h2", {}, det.ticker), h("span", { class: "sub" }, "Mock page · Tudumm has no data for this ticker")), h("div", { class: "host-empty" }, h("b", {}, `${det.ticker} chart`), h("span", {}, "Tudumm detects the ticker but doesn't cover it yet, so the chip says so.")));
  } else {
    host.replaceChildren(
      h("div", { class: "host-nav" }, h("span", { class: "host-logo" }, "Unsupported page (mock)")),
      h("div", { class: "host-empty" }, h("b", {}, "No chip on this page"), h("span", {}, "The content script only runs on the eight supported sites, and only shows when it finds a ticker.")),
    );
  }
  P.getSettings().then(renderHiddenBanner);
}

function renderHiddenBanner(s) {
  const host = $("host");
  const old = host.querySelector(".host-hidden");
  if (old) old.remove();
  if (!det || !det.site || !(det.symbol || det.ticker)) return;
  const off = !s.chipEnabled || s.sites[det.site] === false;
  if (!off) return;
  const { h } = UI;
  const why = !s.chipEnabled ? "The chip is switched off for all sites in Options." : `The chip is hidden on ${det.siteLabel}.`;
  const bar = h(
    "div",
    { class: "host-hidden", style: { position: "absolute", left: "12px", right: "12px", top: "56px", display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap", padding: "10px 12px", background: "#fff7e6", border: "1px solid #f2d394", borderRadius: "8px", color: "#5a4310", fontSize: "12.5px" } },
    h("span", { style: { flex: "1", minWidth: "200px" } }, `${why} In Chrome you'd re-enable it from the Options page.`),
    h("button", { type: "button", class: "btn btn--sm btn--primary", onclick: async () => { const st = await P.getSettings(); st.chipEnabled = true; st.sites = { ...st.sites, [det.site]: true }; await P.saveSettings(st); } }, "Show the chip again"),
    h("a", { href: "options.html", target: "_blank", rel: "noopener", class: "btn btn--sm", style: { textDecoration: "none" } }, "Open Options ↗"),
  );
  host.appendChild(bar);
}

// ---------------------------------------------------------------- driving --

function describe(d) {
  const el = $("detect-result");
  el.replaceChildren();
  const { h } = UI;
  if (!engine) {
    el.append(h("span", { class: "miss" }, `No live data: ${(payload && payload.reasonText) || "the Tudumm API didn't answer."} The chip and popup say so instead of showing numbers.`));
    return;
  }
  if (!d || !d.site) {
    el.append(h("span", { class: "miss" }, "Not a supported site → no chip, popup shows “No supported symbol on this page”."));
    return;
  }
  if (d.symbol) {
    const s = engine.snapshot(d.symbol);
    el.append(`${d.siteLabel} → detected `, h("b", {}, d.symbol), ` via ${d.via} · ${s.direction ? `${s.direction === "LONG" ? "▲" : "▼"} ${s.direction} ${s.confidencePct}%` : s.statusText} · ${s.statusText}`);
    return;
  }
  if (d.ticker) {
    el.append(`${d.siteLabel} → ticker `, h("b", {}, d.ticker), " found, not covered yet.");
    return;
  }
  el.append(h("span", { class: "miss" }, `${d.siteLabel} → no ticker on this page → no chip.`));
}

function framesTo(page, initial) {
  const qs = (extra) => {
    const p = new URLSearchParams({ url: page.url, title: page.title || "", ...extra });
    // Pass a recorded live universe through to the frames (preview only).
    if (P.PARAMS.get("universe")) p.set("universe", P.PARAMS.get("universe"));
    return p.toString();
  };
  if (initial) {
    $("frame-popup").src = `popup.html?${qs({})}`;
    $("frame-panel").src = `sidepanel.html?${qs({ tab: "feed" })}`;
    return;
  }
  for (const id of ["frame-popup", "frame-panel"]) {
    try {
      $(id).contentWindow.postMessage({ type: "tudumm:preview-page", url: page.url, title: page.title || "" }, location.origin);
    } catch {
      /* frame not ready */
    }
  }
}

function simulate(page, { initial = false } = {}) {
  current = page;
  const site = siteFor(page.url);
  det = engine ? engine.detect(page.url, page.title) : site ? { site: site.key, siteLabel: site.label, symbol: null, ticker: null } : null;
  $("url").textContent = page.url;
  $("tab-title").textContent = page.title || new URL(page.url).hostname;
  renderHost();
  describe(det);
  chip.detect(page.url, page.title);
  framesTo(page, initial);
}

async function init() {
  document.documentElement.dataset.booted = "1";
  const brand = $("brand");
  payload = await P.loadData();
  UI.setData(payload);
  brand.replaceWith(UI.h("span", { class: "pv-brand-mark", style: { display: "inline-flex", gap: "12px", alignItems: "center" } }, UI.wordmark(), UI.dataBadge()));

  engine = payload && payload.mode === "live" && payload.universe ? createEngine(payload.universe) : null;
  chipEnv.container = $("viewport");
  if (!window.TudummChip) throw new Error("content.js renderer missing");
  chip = window.TudummChip.create(chipEnv);

  const sel = $("example");
  EXAMPLES.forEach((ex, i) => sel.appendChild(UI.h("option", { value: String(i) }, ex.label)));
  const startIdx = Math.min(EXAMPLES.length - 1, Math.max(0, Number(P.PARAMS.get("ex")) || 0));
  sel.value = String(startIdx);
  sel.addEventListener("change", () => {
    const ex = EXAMPLES[Number(sel.value)];
    try {
      const q = new URLSearchParams({ ex: sel.value });
      if (P.PARAMS.get("universe")) q.set("universe", P.PARAMS.get("universe"));
      history.replaceState(null, "", `?${q}`);
    } catch {
      /* file:// */
    }
    $("custom").value = "";
    simulate({ url: ex.url, title: ex.title });
  });

  $("controls").addEventListener("submit", (e) => {
    e.preventDefault();
    const raw = $("custom").value.trim();
    let u;
    try {
      u = new URL(raw);
    } catch {
      P.toast("That isn't a valid URL. Try https://finance.yahoo.com/quote/NVDA", { tone: "warn" });
      return;
    }
    if (u.protocol !== "https:") {
      P.toast("Only https pages on the supported sites are read.", { tone: "warn" });
    }
    simulate({ url: u.href, title: "" });
  });

  addEventListener("message", (e) => {
    if (e.origin !== location.origin || !e.data || e.data.type !== "tudumm:preview-notice") return;
    if (/side panel/i.test(e.data.what)) pingFrame("frame-panel-wrap");
  });
  addEventListener("resize", () => requestAnimationFrame(drawChart));

  const ex = EXAMPLES[startIdx];
  simulate({ url: ex.url, title: ex.title }, { initial: true });
}

init().catch((err) => {
  console.error(err);
  P.toast(`Preview failed to start: ${err.message}`, { tone: "warn", timeout: 8000 });
});
