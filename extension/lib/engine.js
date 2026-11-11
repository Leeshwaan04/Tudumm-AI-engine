// Tudumm extension engine: alias resolution, URL/title symbol detection, live
// quotes, signal geometry, sizing and formatting over the market universe from
// the Tudumm API (GET /api/v1/market/universe).
//
// Pure ES module with no Chrome API calls, so it runs unchanged in the
// background service worker, the extension pages, preview mode and Node (tests).
//
// There is no made-up data anywhere: prices change only when real data
// arrives (a universe refresh or a Binance tick). No data → an honest "—".

export const LAYERS = [
  { id: "price", label: "Price & Structure", short: "Price" },
  { id: "flow", label: "Order Flow", short: "Flow" },
  { id: "derivatives", label: "Derivatives", short: "Derivs" },
  { id: "fundamentals", label: "Fundamentals", short: "Fund." },
  { id: "context", label: "Context & Sentiment", short: "Context" },
];

// A layer "agrees" with the call when its score is at least this strong.
export const AGREE_THRESHOLD = 25;

export const SITES = [
  { key: "tradingview", label: "TradingView", host: "www.tradingview.com", match: "https://www.tradingview.com/*", mode: "url", example: "https://www.tradingview.com/chart/?symbol=NSE%3ARELIANCE" },
  { key: "yahoo", label: "Yahoo Finance", host: "finance.yahoo.com", match: "https://finance.yahoo.com/*", mode: "url", example: "https://finance.yahoo.com/quote/RELIANCE.NS" },
  { key: "google", label: "Google Finance", host: "www.google.com", path: "/finance", match: "https://www.google.com/finance/*", mode: "url", example: "https://www.google.com/finance/quote/RELIANCE:NSE" },
  { key: "kite", label: "Zerodha Kite", host: "kite.zerodha.com", match: "https://kite.zerodha.com/*", mode: "url", example: "https://kite.zerodha.com/chart/ext/ciq/NSE/RELIANCE/738561" },
  { key: "nse", label: "NSE India", host: "www.nseindia.com", match: "https://www.nseindia.com/*", mode: "url", example: "https://www.nseindia.com/get-quotes/equity?symbol=RELIANCE" },
  { key: "binance", label: "Binance", host: "www.binance.com", match: "https://www.binance.com/*", mode: "url", example: "https://www.binance.com/en/trade/BTC_USDT" },
  { key: "investing", label: "Investing.com", host: "www.investing.com", match: "https://www.investing.com/*", mode: "title", example: "https://www.investing.com/equities/apple-computer-inc" },
  { key: "moneycontrol", label: "Moneycontrol", host: "www.moneycontrol.com", match: "https://www.moneycontrol.com/*", mode: "title", example: "https://www.moneycontrol.com/india/stockpricequote/refineries/relianceindustries/RI" },
];

export const PRODUCTION_WEB_URL = "https://tudumm.in";
/** Tudumm web origins the manifest grants host access to (no CORS needed for these). */
export const TUDUMM_ORIGINS = Object.freeze(["https://tudumm.in", "https://tudumm-ai-engine.sumitbagewadi6.workers.dev"]);

export const DEFAULT_SETTINGS = Object.freeze({
  webUrl: PRODUCTION_WEB_URL,
  capital: 500000,
  currency: "INR",
  riskPct: 1,
  chipEnabled: true,
  sites: Object.freeze(Object.fromEntries(SITES.map((s) => [s.key, true]))),
});

export function mergeSettings(stored) {
  // `dataMode` (Live/Demo) was a v0.2 draft setting: there is no demo mode, so a stored value is dropped.
  const { dataMode: _legacy, ...s } = stored && typeof stored === "object" ? stored : {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    sites: { ...DEFAULT_SETTINGS.sites, ...(s.sites || {}) },
  };
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
export function isLoopbackHost(hostname) {
  return LOOPBACK.has(String(hostname || "").toLowerCase());
}

/**
 * Returns a normalized base URL, or null for anything else (javascript:, data:, file:, junk).
 * Production rule: https only. Plain http is accepted only for this machine
 * (localhost / 127.0.0.1 / [::1]) so a local dev server can be used.
 */
export function safeWebUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  let u;
  try {
    u = new URL(value.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopbackHost(u.hostname))) return null;
  if (!u.hostname || u.username || u.password) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** Why a web URL was refused, for the Options page. null when it's fine. */
export function webUrlProblem(value) {
  if (safeWebUrl(value)) return null;
  let u;
  try {
    u = new URL(String(value || "").trim());
  } catch {
    return "Enter a full address, e.g. https://tudumm.in";
  }
  if (u.protocol === "http:") return "Use https:// (plain http is allowed only for localhost while developing).";
  return "Enter an https:// address, e.g. https://tudumm.in";
}

/** The API origin for a web URL (the API is served by the same origin as the web app). */
export function apiOrigin(webUrl) {
  const base = safeWebUrl(webUrl);
  return base ? new URL(base).origin : null;
}

// ------------------------------------------------- Freshness & honesty --

export const FRESHNESS_TEXT = {
  realtime: "REAL-TIME",
  "delayed-15m": "DELAYED 15M",
  eod: "END OF DAY",
  "daily-ref": "DAILY REF",
};
export const FRESHNESS_SHORT = { realtime: "RT", "delayed-15m": "15M", eod: "EOD", "daily-ref": "REF" };
export const FRESHNESS_HELP = {
  realtime: "Streams in real time from the exchange's public feed.",
  "delayed-15m": "Quotes are delayed by about 15 minutes.",
  eod: "End-of-day data, published after the session closes.",
  "daily-ref": "One reference rate per business day (no intraday ticks).",
};
const SOURCE_TEXT = {
  binance: "BINANCE",
  "binance-futures": "BINANCE",
  bybit: "BYBIT",
  cboe: "CBOE",
  "nse-archives": "NSE",
  "ecb-frankfurter": "ECB",
  "sec-edgar": "SEC",
  "alternative-me": "ALTERNATIVE.ME",
};
const PROXY_TEXT = { XAUUSD: "PAXG PROXY FOR GOLD", CL: "USO ETF PROXY FOR WTI", ASML: "ASML ADR (NASDAQ)" };

export const ENGINE_TAG = "ENGINE V0 · UNCALIBRATED";
export const ENGINE_HELP =
  "Live signals come from engine v0: fixed rules over price, flow, derivatives, fundamentals and context. Its confidence is a rule score that hasn't been calibrated against outcomes yet, so 70% doesn't mean 7 in 10 calls work out. Read it as a ranking.";

/** "REAL-TIME · BINANCE", or null when the API didn't say. */
export function freshnessText(inst) {
  if (!inst || !inst.freshness) return null;
  const f = FRESHNESS_TEXT[inst.freshness] || String(inst.freshness).toUpperCase().slice(0, 16);
  const src = SOURCE_TEXT[inst.source] || (inst.source ? String(inst.source).toUpperCase().slice(0, 16) : "");
  return src ? `${f} · ${src}` : f;
}

export function proxyText(inst) {
  if (inst && inst.symbol === "XAUUSD" && inst.source === "bybit") return "XAUT PROXY FOR GOLD";
  return (inst && PROXY_TEXT[inst.symbol]) || null;
}

const PAXG_NOTE = "PAXG (Paxos Gold) on Binance: tokenized gold used as a proxy for spot gold.";

/** The Binance pair a live instrument streams from, or null (crypto in real time, and gold via PAXG). */
export function binanceStreamPair(inst) {
  if (!inst || !inst.live) return null;
  if (inst.symbol === "XAUUSD") return "PAXGUSDT";
  if (inst.source === "binance" || (inst.assetClass === "crypto" && inst.freshness === "realtime")) {
    const pair = String(inst.dataSymbol || inst.symbol).toUpperCase();
    return /^[A-Z0-9]{5,20}$/.test(pair) ? pair : null;
  }
  return null;
}

/** "as of 14:32" today, "as of 7 Nov" otherwise. */
export function asOfText(iso, now = Date.now()) {
  if (iso == null || iso === "") return null;
  const t = typeof iso === "string" ? Date.parse(iso) : Number(iso);
  if (!Number.isFinite(t) || t <= 0) return null;
  const d = new Date(t);
  const n = new Date(now);
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  if (sameDay) return `as of ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `as of ${d.getDate()} ${d.toLocaleString("en-US", { month: "short" })}`;
}

/** `{webUrl}/app/i/{SYMBOL}` (or `/app`), or null when webUrl is not a valid http(s) URL. */
export function terminalUrl(webUrl, symbol, path) {
  const base = safeWebUrl(webUrl ?? DEFAULT_SETTINGS.webUrl);
  if (!base) return null;
  if (path) return `${base}${path}`;
  return symbol ? `${base}/app/i/${encodeURIComponent(symbol)}` : `${base}/app`;
}

const CURRENCIES = {
  INR: { prefix: "₹", suffix: "", locale: "en-IN" },
  USD: { prefix: "$", suffix: "", locale: "en-US" },
  EUR: { prefix: "€", suffix: "", locale: "en-US" },
  JPY: { prefix: "¥", suffix: "", locale: "en-US" },
  USDT: { prefix: "", suffix: " USDT", locale: "en-US" },
};
export const CAPITAL_CURRENCIES = ["INR", "USD", "EUR", "JPY", "USDT"];

const nfCache = new Map();
function nf(locale, d) {
  const key = locale + d;
  let f = nfCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, { minimumFractionDigits: d, maximumFractionDigits: d });
    nfCache.set(key, f);
  }
  return f;
}

export function currencyInfo(code) {
  return CURRENCIES[code] || { prefix: "", suffix: ` ${code}`, locale: "en-US" };
}

export function formatNumber(value, decimals, currency) {
  if (value == null || !Number.isFinite(value)) return "—";
  const { locale } = currencyInfo(currency);
  return nf(locale, decimals).format(value).replace(/^-/, "−");
}

export function formatMoney(value, currency, decimals) {
  if (value == null || !Number.isFinite(value)) return "—";
  const c = currencyInfo(currency);
  const d = decimals ?? (Math.abs(value) >= 1000 ? 0 : 2);
  const neg = value < 0;
  return `${neg ? "−" : ""}${c.prefix}${nf(c.locale, d).format(Math.abs(value))}${c.suffix}`;
}

export function formatPrice(inst, value) {
  return formatMoney(value, inst.currency, inst.decimals);
}

/** Decimals used for a signal's levels: 0 when every level is whole, else at least 2. */
export function levelDecimals(inst) {
  const s = inst.signal;
  const lv = [s.entryLow, s.entryHigh, s.stop, s.target1, s.target2].filter((v) => v != null);
  let need = 0;
  for (const v of lv) {
    const str = String(v);
    const i = str.indexOf(".");
    if (i >= 0) need = Math.max(need, str.length - i - 1);
  }
  if (need === 0) return 0;
  return Math.min(inst.decimals, Math.max(need, Math.min(inst.decimals, 2)));
}

export function formatLevel(inst, value) {
  return formatNumber(value, levelDecimals(inst), inst.currency);
}

export function formatPct(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return "—";
  const s = (Math.abs(v) * 100).toFixed(d);
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${s}%`;
}

export function formatR(r, d = 2) {
  if (r == null || !Number.isFinite(r)) return "—";
  const a = Math.abs(r).toFixed(d);
  if (Number(a) === 0) return `0.${"0".repeat(d)}R`;
  return `${r > 0 ? "+" : "−"}${a}R`;
}

export function formatAgo(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 10) return m % 60 ? `${h}h ${m % 60}m ago` : `${h}h ago`;
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function formatCountdown(sec) {
  const s = Math.max(0, Math.ceil(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export const STATUS_TEXT = {
  active: "ACTIVE",
  pending: "ENTRY PENDING",
  t1_hit: "T1 HIT · STOP AT BREAKEVEN",
  sit_out: "SITTING OUT",
};

export const REGIME_TEXT = {
  "trending-up": "Trending up",
  "trending-down": "Trending down",
  range: "Range",
  "high-vol": "High volatility",
};

export const STYLE_TEXT = { intraday: "Intraday", swing: "Swing", positional: "Positional", investing: "Investing" };

// Why a layer is N/A for an asset class, and what Tudumm uses instead.
export function naReason(inst, layerId) {
  const note = inst.signal && inst.signal.layerNotes && inst.signal.layerNotes[layerId];
  if (typeof note === "string" && note.trim()) return note.trim().slice(0, 400);
  return "No data for this layer on this instrument yet.";
}

const upper = (s) => String(s || "").trim().toUpperCase();
const compact = (s) => upper(s).replace(/[^A-Z0-9]/g, "");
const isTickerLike = (s) => /^[A-Z0-9^.][A-Z0-9._\-!^=&:/ ]{0,24}$/.test(upper(s));

// Extra phrases for title-only sites. These are matching hints, not market data.
const TITLE_HINTS = {
  BANKNIFTY: ["BANK NIFTY"],
  XAUUSD: ["XAU/USD", "GOLD SPOT", "GOLD FUTURES"],
  CL: ["CRUDE OIL WTI", "WTI CRUDE", "CRUDE OIL"],
  BTCUSDT: ["BTC/USD", "BTC/USDT", "BTC USD"],
  ETHUSDT: ["ETH/USD", "ETH/USDT", "ETH USD"],
  SOLUSDT: ["SOL/USD", "SOL/USDT"],
  EURUSD: ["EUR/USD"],
  USDINR: ["USD/INR"],
  USDJPY: ["USD/JPY"],
  SPY: ["SPDR S&P 500"],
  RELIANCE: ["RELIANCE INDUSTRIES"],
  SBIN: ["SBI"],
};

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ------------------------------------------------------ Normalization --

const KNOWN_STATUSES = new Set(["active", "pending", "t1_hit", "sit_out"]);
const fin = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v, max = 600) => (typeof v === "string" ? v.slice(0, max) : null);

/**
 * A signal the UI can always draw. Unknown statuses (held, closed, invalidated…)
 * and setups with broken levels become an honest "sitting out".
 */
export function normalizeSignal(raw, inst) {
  const s = raw && typeof raw === "object" ? raw : null;
  const layers = {};
  for (const l of LAYERS) {
    const v = s && s.layers ? fin(s.layers[l.id]) : null;
    layers[l.id] = v == null ? null : Math.max(-100, Math.min(100, Math.round(v)));
  }
  if (!s) {
    return { id: `SIT-${inst.symbol}`, status: "sit_out", regime: "range", issuedMinutesAgo: 0, layers, layerNotes: {}, thesis: "No signal for this instrument yet.", invalidation: null, direction: null, confidence: null };
  }
  const status = KNOWN_STATUSES.has(s.status) ? s.status : "sit_out";
  const out = {
    ...s,
    id: text(s.id, 64) || `SIG-${inst.symbol}`,
    status,
    regime: text(s.regime, 32) || "range",
    issuedMinutesAgo: fin(s.issuedMinutesAgo) ?? 0,
    layers,
    layerNotes: s.layerNotes && typeof s.layerNotes === "object" ? s.layerNotes : {},
    thesis: text(s.thesis) || "",
    invalidation: text(s.invalidation),
  };
  if (status === "sit_out") return { ...out, direction: null, confidence: null };
  const lv = { entryLow: fin(s.entryLow), entryHigh: fin(s.entryHigh), stop: fin(s.stop), target1: fin(s.target1), target2: fin(s.target2) };
  const dir = s.direction === "LONG" ? 1 : s.direction === "SHORT" ? -1 : 0;
  const ok = dir && Object.values(lv).every((v) => v != null) && lv.entryHigh >= lv.entryLow;
  const mid = ok ? (lv.entryLow + lv.entryHigh) / 2 : 0;
  const risk = ok ? dir * (mid - lv.stop) : 0;
  if (!ok || !(risk > 0) || !(dir * (lv.target2 - mid) > 0) || !(dir * (lv.target1 - mid) > 0)) {
    return { ...out, status: "sit_out", direction: null, confidence: null, thesis: out.thesis || "The published levels didn't check out, so Tudumm isn't showing this setup." };
  }
  const conf = fin(s.confidence);
  return {
    ...out,
    ...lv,
    direction: s.direction,
    confidence: conf == null ? 0.5 : Math.max(0, Math.min(1, conf)),
    rr1: fin(s.rr1) ?? Math.round(((dir * (lv.target1 - mid)) / risk) * 100) / 100,
    rr2: fin(s.rr2) ?? Math.round(((dir * (lv.target2 - mid)) / risk) * 100) / 100,
  };
}

// ---------------------------------------------------------------- Engine --

/** createEngine(universe) over the API's market universe (already sanitized). */
export function createEngine(universe, options = {}) {
  const loadedAt = options.loadedAt ?? Date.now();
  const live = true;
  const instruments = (universe.instruments || []).map((i) => ({ ...i, live: true, signal: normalizeSignal(i.signal, i) }));
  const bySymbol = new Map(instruments.map((i) => [i.symbol, i]));

  // Quotes change only when real data arrives: a universe refresh or a Binance tick.
  const liveQ = new Map();
  for (const i of instruments) liveQ.set(i.symbol, { price: fin(i.price) && i.price > 0 ? i.price : null, prev: null, tick: 0, at: Date.parse(i.asOf) || null });
  function setQuote(symbol, { price, at = Date.now(), source = null } = {}) {
    const q = liveQ.get(symbol);
    const inst = bySymbol.get(symbol);
    if (!q || !inst || !(fin(price) && price > 0)) return false;
    if (q.at && at < q.at) return false; // never overwrite a newer price with an older one
    // The badge names the venue that served the latest price (e.g. a Binance tick
    // on top of a Bybit-sourced universe quote).
    if (source && typeof source === "string" && source !== inst.source) {
      inst.source = source.slice(0, 32);
      if (symbol === "XAUUSD") inst.proxyNote = inst.source === "binance" ? PAXG_NOTE : inst.proxyNote;
    }
    q.at = at;
    inst.asOf = new Date(at).toISOString();
    inst.stale = false;
    inst.hasData = true;
    if (q.price === price) return false;
    q.prev = q.price;
    q.price = price;
    q.tick += 1;
    inst.price = price;
    return true;
  }
  /** Fold a fresh universe's quotes into this engine (used when no signal changed). */
  function applyQuotes(universe) {
    let n = 0;
    for (const fresh of (universe && universe.instruments) || []) {
      const inst = bySymbol.get(fresh.symbol);
      if (!inst) continue;
      if (fin(fresh.prevClose) != null) inst.prevClose = fresh.prevClose;
      if (fin(fresh.changePct) != null) inst.changePct = fresh.changePct;
      const at = Date.parse(fresh.asOf);
      if (Number.isFinite(at)) {
        if (setQuote(fresh.symbol, { price: fresh.price, at, source: fresh.source || null })) n++;
        inst.stale = !!fresh.stale && (liveQ.get(fresh.symbol)?.at ?? 0) <= at;
      }
    }
    return n;
  }
  const exact = new Map();
  const compactIdx = new Map();
  for (const inst of instruments) {
    for (const a of [inst.symbol, inst.name, ...(inst.aliases || [])]) {
      if (!exact.has(upper(a))) exact.set(upper(a), inst.symbol);
      if (!compactIdx.has(compact(a))) compactIdx.set(compact(a), inst.symbol);
    }
  }

  // Phrases for scanning page titles: names, aliases (3+ chars), hints.
  const phrases = [];
  for (const inst of instruments) {
    const set = new Set([inst.name, inst.symbol, ...(inst.aliases || []), ...(TITLE_HINTS[inst.symbol] || [])].map(upper));
    for (const p of set) {
      if (p.replace(/[^A-Z0-9]/g, "").length < 3) continue;
      phrases.push({ symbol: inst.symbol, phrase: p, re: new RegExp(`(^|[^A-Z0-9])${escapeRe(p)}(?![A-Z0-9])`) });
    }
  }
  phrases.sort((a, b) => b.phrase.length - a.phrase.length);

  function resolve(candidate) {
    if (!candidate) return null;
    const c = upper(candidate);
    if (exact.has(c)) return exact.get(c);
    if (compactIdx.has(compact(c))) return compactIdx.get(compact(c));
    if (c.includes(":")) {
      for (const part of c.split(":")) {
        if (exact.has(part)) return exact.get(part);
      }
    }
    const stripped = c.replace(/\.(NS|BO|AS)$/, "").replace(/-EQ$/, "");
    if (stripped !== c && exact.has(stripped)) return exact.get(stripped);
    return null;
  }

  function scanTitle(title) {
    if (!title) return null;
    const t = upper(title);
    let best = null;
    for (const p of phrases) {
      const m = p.re.exec(t);
      if (!m) continue;
      const start = m.index + m[1].length;
      if (!best || start < best.start || (start === best.start && p.phrase.length > best.len)) {
        best = { symbol: p.symbol, start, len: p.phrase.length };
      }
    }
    return best ? best.symbol : null;
  }

  function detect(url, title) {
    const ext = extractCandidates(url, title);
    if (!ext.site) return { site: null, siteLabel: null, symbol: null, ticker: null, via: null };
    for (const cand of ext.candidates) {
      const sym = resolve(cand);
      if (sym) return { site: ext.site.key, siteLabel: ext.site.label, symbol: sym, ticker: sym, via: ext.via || "url" };
    }
    if (ext.scanTitle) {
      const sym = scanTitle(title);
      if (sym) return { site: ext.site.key, siteLabel: ext.site.label, symbol: sym, ticker: sym, via: "title" };
    }
    const ticker = ext.candidates.length ? displayTicker(ext.candidates[0]) : null;
    return { site: ext.site.key, siteLabel: ext.site.label, symbol: null, ticker, via: ext.via || null };
  }

  function search(query, limit = 12) {
    const q = upper(query);
    if (!q) return [];
    const qc = compact(q);
    const scored = [];
    for (const inst of instruments) {
      let score = 0;
      const hay = [inst.symbol, inst.name, ...(inst.aliases || [])];
      for (const h of hay) {
        const H = upper(h);
        if (H === q || compact(H) === qc) score = Math.max(score, 100);
        else if (H.startsWith(q)) score = Math.max(score, 60);
        else if (H.includes(q) || (qc.length >= 2 && compact(H).includes(qc))) score = Math.max(score, 30);
      }
      if (score) scored.push({ inst, score });
    }
    scored.sort((a, b) => b.score - a.score || a.inst.symbol.localeCompare(b.inst.symbol));
    return scored.slice(0, limit).map((s) => s.inst);
  }

  function geometry(sig) {
    if (sig.entryLow == null) return null;
    const mid = (sig.entryLow + sig.entryHigh) / 2;
    const sign = sig.direction === "SHORT" ? -1 : 1;
    const risk = Math.abs(mid - sig.stop);
    return { mid, sign, risk };
  }

  /** A signal's state as published by the API (no client-side reveals or simulation). */
  function signalState(symbol) {
    const sig = bySymbol.get(symbol).signal;
    const issued = Date.parse(sig.issuedAt);
    return { status: sig.status, issuedAt: Number.isFinite(issued) ? issued : loadedAt - sig.issuedMinutesAgo * 60000 };
  }

  /** The latest real price, or null when the API has none. */
  function priceAt(symbol) {
    return liveQ.get(symbol)?.price ?? null;
  }

  function liveQuote(symbol, t, at) {
    const inst = bySymbol.get(symbol);
    const q = liveQ.get(symbol);
    const price = q.price;
    const prevPrice = q.prev ?? price;
    const g = geometry(inst.signal);
    const pc = fin(inst.prevClose) && inst.prevClose > 0 ? inst.prevClose : null;
    const changePct = price != null && pc ? (price - pc) / pc : fin(inst.changePct) != null ? inst.changePct / 100 : null;
    return {
      symbol,
      tick: q.tick,
      price,
      prevPrice,
      dir: price != null && prevPrice != null ? (price > prevPrice ? 1 : price < prevPrice ? -1 : 0) : 0,
      change: price != null && pc ? price - pc : null,
      changePct,
      r: g && price != null ? (g.sign * (price - g.mid)) / g.risk : null,
      state: signalState(symbol),
      at: q.at,
    };
  }

  function quote(symbol, t = Date.now(), at = loadedAt) {
    return liveQuote(symbol, t, at);
  }

  /** Trade Map geometry, R-oriented: stop on the left, target 2 on the right. */
  function tradeMap(symbol, price, state) {
    const inst = bySymbol.get(symbol);
    const sig = inst.signal;
    const g = geometry(sig);
    if (!g) return null;
    const rOf = (p) => (g.sign * (p - g.mid)) / g.risk;
    const rMin = -1.2;
    const rMax = Math.max(sig.rr2, rOf(sig.target2)) + 0.2;
    const pos = (r) => Math.min(100, Math.max(0, ((r - rMin) / (rMax - rMin)) * 100));
    const eA = rOf(sig.entryLow);
    const eB = rOf(sig.entryHigh);
    const needleR = price == null ? null : rOf(price);
    const st = state?.status ?? sig.status;
    return {
      sign: g.sign,
      stop: { pos: pos(-1), price: sig.stop, label: "SL", rText: "−1R" },
      entry: { pos0: pos(Math.min(eA, eB)), pos1: pos(Math.max(eA, eB)), pos: pos(0), label: "Entry", rText: "0" },
      t1: { pos: pos(rOf(sig.target1)), price: sig.target1, label: "T1", rText: `+${sig.rr1.toFixed(1)}R` },
      t2: { pos: pos(rOf(sig.target2)), price: sig.target2, label: "T2", rText: `+${sig.rr2.toFixed(1)}R` },
      needle: needleR == null ? null : { pos: pos(needleR), r: needleR, offscale: needleR < rMin || needleR > rMax },
      breakeven: st === "t1_hit",
      pending: st === "pending",
    };
  }

  function confluence(symbol) {
    const sig = bySymbol.get(symbol).signal;
    const rows = LAYERS.map((l) => ({ ...l, score: sig.layers[l.id] }));
    const scored = rows.filter((r) => r.score != null);
    const agree = scored.filter((r) => r.score >= AGREE_THRESHOLD).length;
    return { rows, agree, total: scored.length, na: rows.length - scored.length };
  }

  function issuedText(symbol, t = Date.now()) {
    return formatAgo(t - signalState(symbol).issuedAt);
  }

  /** Everything a surface needs to draw a signal, as plain serializable data. */
  function snapshot(symbol, t = Date.now(), at = loadedAt) {
    const inst = bySymbol.get(symbol);
    if (!inst) return null;
    const sig = inst.signal;
    const q = quote(symbol, t, at);
    const st = q.state;
    const isSit = sig.status === "sit_out";
    const inTrade = st.status === "active" || st.status === "t1_hit";
    return {
      symbol,
      live: true,
      freshness: inst.freshness || null,
      freshnessText: freshnessText(inst),
      freshnessShort: FRESHNESS_SHORT[inst.freshness] || null,
      freshnessHelp: [FRESHNESS_HELP[inst.freshness], inst.proxyNote].filter(Boolean).join(" ") || null,
      proxyText: proxyText(inst),
      asOfText: asOfText(q.at ?? inst.asOf, t),
      stale: !!inst.stale,
      hasPrice: q.price != null,
      engineText: ENGINE_TAG,
      name: inst.name,
      exchange: inst.exchange,
      market: inst.market,
      assetClass: inst.assetClass,
      currency: inst.currency,
      id: sig.id,
      status: st.status,
      statusText: STATUS_TEXT[st.status],
      direction: sig.direction || null,
      confidence: sig.confidence ?? null,
      confidencePct: sig.confidence == null ? null : Math.round(sig.confidence * 100),
      timeframe: sig.timeframe || null,
      style: sig.style || null,
      strategy: sig.strategy || null,
      regime: sig.regime,
      issuedText: issuedText(symbol, t, at),
      price: q.price,
      priceText: formatPrice(inst, q.price),
      tickDir: q.dir,
      changePct: q.changePct,
      changeText: formatPct(q.changePct),
      r: inTrade ? q.r : null,
      rText: inTrade && q.r != null ? formatR(q.r) : null,
      levels: isSit
        ? null
        : {
            entry: `${formatLevel(inst, sig.entryLow)}–${formatLevel(inst, sig.entryHigh)}`,
            stop: formatLevel(inst, sig.stop),
            t1: formatLevel(inst, sig.target1),
            t2: formatLevel(inst, sig.target2),
            rr: `${sig.rr1.toFixed(2)} / ${sig.rr2.toFixed(2)}`,
          },
      map: isSit ? null : tradeMap(symbol, q.price, st),
      confluence: confluence(symbol),
      thesis: sig.thesis,
      invalidation: sig.invalidation && sig.invalidation !== "None" ? sig.invalidation : null,
    };
  }

  // ------------------------------------------------------- Position sizing --

  function perUsd(code, t) {
    if (code === "USD" || code === "USDT") return 1;
    if (code === "INR") return priceAt("USDINR", t);
    if (code === "JPY") return priceAt("USDJPY", t);
    if (code === "EUR") return 1 / priceAt("EURUSD", t);
    return 1;
  }

  function convert(amount, from, to, t = Date.now()) {
    if (from === to) return amount;
    return (amount / perUsd(from, t)) * perUsd(to, t);
  }

  function sizePosition(symbol, { capital, currency, riskPct }, t = Date.now()) {
    const inst = bySymbol.get(symbol);
    const sig = inst.signal;
    const g = geometry(sig);
    if (!g || !(capital > 0) || !(riskPct > 0)) return null;
    const riskCap = capital * (riskPct / 100);
    const riskInst = convert(riskCap, currency, inst.currency, t);
    if (!(Number.isFinite(riskInst) && riskInst > 0)) {
      return { unavailable: `No live ${currency}→${inst.currency} rate yet, so Tudumm can't convert your capital. Set the capital currency to ${inst.currency === "USDT" ? "USD" : inst.currency} in Options to size this trade.` };
    }
    const perUnit = g.risk;
    let qty = riskInst / perUnit;
    const fractional = inst.assetClass === "crypto";
    qty = fractional ? Math.floor(qty * 1000) / 1000 : Math.floor(qty);
    const entry = g.mid;
    const notional = qty * entry;
    const fxNote =
      currency === inst.currency || (currency === "USD" && inst.currency === "USDT") || (currency === "USDT" && inst.currency === "USD")
        ? null
        : `Converted ${currency}→${inst.currency} at the latest ECB reference rate.`;
    return {
      riskCap,
      riskInst,
      qty,
      qtyText: fractional ? qty.toFixed(3) : new Intl.NumberFormat("en-US").format(qty),
      unit: inst.assetClass === "fx" ? "units" : inst.assetClass === "crypto" ? inst.symbol.replace(/USDT$/, "") : inst.assetClass === "commodity" ? "units" : inst.assetClass === "index" ? "index units" : "shares",
      entry,
      notional,
      maxLoss: qty * perUnit,
      rewardT1: qty * Math.abs(sig.target1 - entry),
      rewardT2: qty * Math.abs(sig.target2 - entry),
      fxNote,
      indexNote: inst.assetClass === "index" ? "Trade via futures/options; lot sizes vary." : null,
      tooSmall: qty <= 0,
    };
  }

  function ledgerStats() {
    const all = Array.isArray(universe.ledger) ? universe.ledger : [];
    // Live ledger v2 mixes "issue" and "close" entries: stats come from closed calls only.
    const L = all.filter((e) => e && e.type === "close" && fin(e.r) != null);
    const wins = L.filter((e) => e.r > 0);
    const losses = L.filter((e) => e.r <= 0);
    const sum = (a) => a.reduce((s, e) => s + e.r, 0);
    const grossWin = sum(wins);
    const grossLoss = Math.abs(sum(losses));
    let cum = 0;
    let peak = 0;
    let mdd = 0;
    for (const e of L) {
      cum += e.r;
      peak = Math.max(peak, cum);
      mdd = Math.max(mdd, peak - cum);
    }
    return {
      count: L.length,
      winRate: L.length ? wins.length / L.length : 0,
      avgWin: wins.length ? grossWin / wins.length : 0,
      avgLoss: losses.length ? -grossLoss / losses.length : 0,
      expectancy: L.length ? sum(L) / L.length : 0,
      profitFactor: grossLoss ? grossWin / grossLoss : null,
      totalR: cum,
      maxDrawdown: mdd,
      head: all.length ? all[all.length - 1].hash : null,
      entries: all.length,
      live,
      tooFew: L.length < 30,
    };
  }

  return {
    universe,
    live,
    loadedAt,
    instruments,
    setQuote,
    applyQuotes,
    /** Changes whenever a signal is added, removed or changes state: then surfaces re-render. */
    signalKey: () => instruments.map((i) => `${i.symbol}:${i.signal.id}:${i.signal.status}:${i.signal.confidence ?? ""}:${i.signal.stopCurrent ?? ""}`).join("|"),
    markets: universe.markets || [],
    get: (s) => bySymbol.get(s) || null,
    resolve,
    detect,
    search,
    priceAt,
    quote,
    signalState,
    tradeMap,
    confluence,
    snapshot,
    issuedText,
    sizePosition,
    convert,
    ledgerStats,
  };
}

// ------------------------------------------------- URL candidate parsing --

export function siteFor(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  return SITES.find((s) => s.host === u.hostname && (!s.path || u.pathname === s.path || u.pathname.startsWith(`${s.path}/`))) || null;
}

function dec(s) {
  try {
    return decodeURIComponent(String(s).replace(/\+/g, " "));
  } catch {
    return String(s);
  }
}

function displayTicker(c) {
  let t = upper(c);
  if (t.includes(":")) {
    const parts = t.split(":").filter(Boolean);
    const exch = /^(NSE|BSE|NASDAQ|NYSE|AMEX|NYSEARCA|BINANCE|OANDA|FX|FX_IDC|TVC|COMEX|NYMEX|EURONEXT|INDEXNSE|INDEXSP|INDEXDJX|LON|ETR|AMS|CURRENCY|MCX|CBOE)$/;
    t = parts.find((p) => !exch.test(p)) || parts[parts.length - 1];
  }
  return t.slice(0, 18);
}

/** Pull symbol candidates out of a supported site's URL (and title when allowed). */
export function extractCandidates(url, title) {
  const site = siteFor(url);
  if (!site) return { site: null, candidates: [], scanTitle: false };
  const u = new URL(url);
  const path = u.pathname;
  const out = [];
  const push = (v) => {
    const s = dec(v).trim();
    if (s && isTickerLike(s) && !out.includes(s)) out.push(s);
  };
  let scanTitle = false;
  let via = "url";

  switch (site.key) {
    case "tradingview": {
      const q = u.searchParams.get("symbol") || u.searchParams.get("tvwidgetsymbol");
      if (q) push(q);
      const m = path.match(/^\/symbols\/([^/]+)\/?/i);
      if (m) {
        const seg = dec(m[1]);
        const dash = seg.indexOf("-");
        if (dash > 0) push(`${seg.slice(0, dash)}:${seg.slice(dash + 1)}`);
        push(seg);
      }
      if (!out.length && title && /^\/chart\//.test(path)) {
        const first = String(title).trim().split(/\s+/)[0];
        if (first && /^[A-Z0-9][A-Z0-9_.!:\-&]{0,20}$/.test(first)) push(first);
        scanTitle = true;
        via = "title";
      }
      break;
    }
    case "yahoo": {
      const m = path.match(/^\/quote\/([^/?#]+)/i);
      if (m) push(m[1]);
      else {
        const p = u.searchParams.get("p");
        if (p) push(p);
      }
      break;
    }
    case "google": {
      const m = path.match(/^\/finance\/quote\/([^/?#]+)/i);
      if (m) push(m[1]);
      break;
    }
    case "kite": {
      const m = path.match(/^\/chart\/(?:ext|web)\/(?:ciq|tvc)\/([^/]+)\/([^/]+)/i);
      if (m) {
        push(`${dec(m[1])}:${dec(m[2])}`);
        push(m[2]);
      }
      break;
    }
    case "nse": {
      const q = u.searchParams.get("symbol");
      if (q) push(q);
      break;
    }
    case "binance": {
      const m = path.match(/^\/(?:[a-z]{2}(?:-[A-Za-z]{2,4})?\/)?(?:trade|futures|margin)\/([^/?#]+)/i);
      if (m) push(m[1]);
      const pm = path.match(/^\/(?:[a-z]{2}(?:-[A-Za-z]{2,4})?\/)?price\/([a-z0-9-]+)/i);
      if (pm) push(pm[1].replace(/-/g, " "));
      break;
    }
    case "investing":
    case "moneycontrol":
      scanTitle = true;
      via = "title";
      break;
    default:
      break;
  }
  return { site, candidates: out, scanTitle, via };
}
