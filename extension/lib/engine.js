// Tudumm extension engine: seed loading, alias resolution, URL/title symbol
// detection, the live tick simulation, and formatting.
//
// Pure ES module with no Chrome API calls, so it runs unchanged in the
// background service worker, the extension pages, preview mode and Node (tests).
//
// Live prices are a deterministic function of wall-clock time: every surface
// (popup, side panel, content chip via the background) computes the same price
// at the same moment without a long-running timer, which matters because MV3
// service workers are suspended when idle.

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

export const DEFAULT_SETTINGS = Object.freeze({
  webUrl: "http://localhost:5180",
  capital: 500000,
  currency: "INR",
  riskPct: 1,
  chipEnabled: true,
  sites: Object.freeze(Object.fromEntries(SITES.map((s) => [s.key, true]))),
});

export function mergeSettings(stored) {
  const s = stored && typeof stored === "object" ? stored : {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    sites: { ...DEFAULT_SETTINGS.sites, ...(s.sites || {}) },
  };
}

/** Returns a normalized http(s) base URL, or null for anything else (javascript:, data:, file:, junk). */
export function safeWebUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  let u;
  try {
    u = new URL(value.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname || u.username || u.password) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** `{webUrl}/app/i/{SYMBOL}` (or `/app`), or null when webUrl is not a valid http(s) URL. */
export function terminalUrl(webUrl, symbol, path) {
  const base = safeWebUrl(webUrl ?? DEFAULT_SETTINGS.webUrl);
  if (!base) return null;
  if (path) return `${base}${path}`;
  return symbol ? `${base}/app/i/${encodeURIComponent(symbol)}` : `${base}/app`;
}

// ---------------------------------------------------------------- PRNG ----

export function hashString(str) {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussianAt(seed, k) {
  const rnd = mulberry32((seed ^ Math.imul(k | 0, 0x9e3779b1)) >>> 0);
  const u1 = Math.max(rnd(), 1e-12);
  const u2 = rnd();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ----------------------------------------------------------- Formatting --

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
  queued: "REVEALING…",
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
  if (layerId === "flow" && inst.assetClass === "fx") {
    return "Spot FX trades OTC, so there is no consolidated order book. Tudumm reads CME futures volume and positioning instead.";
  }
  if (layerId === "fundamentals" && inst.assetClass === "crypto") {
    return "Not applicable. Tudumm will use on-chain flows here.";
  }
  return "No reliable data for this layer on this instrument yet.";
}

// --------------------------------------------------------- Seed loading --

export async function loadSeed(url, attempts = 3) {
  const target = url || new URL("../data/seed.json", import.meta.url);
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(target);
      if (!res.ok) throw new Error(`Seed load failed (${res.status})`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 200 * (i + 1)));
    }
  }
  throw lastErr || new Error("Seed load failed");
}

const upper = (s) => String(s || "").trim().toUpperCase();
const compact = (s) => upper(s).replace(/[^A-Z0-9]/g, "");
const isTickerLike = (s) => /^[A-Z0-9^.][A-Z0-9._\-!^=&:/ ]{0,24}$/.test(upper(s));

// Extra phrases for title-only sites. These are matching hints, not seed data.
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

// ---------------------------------------------------------------- Engine --

export function createEngine(seed, options = {}) {
  const loadedAt = options.loadedAt ?? Date.now();
  const instruments = seed.instruments;
  const bySymbol = new Map(instruments.map((i) => [i.symbol, i]));
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

  // ---------------------------------------------------- Live simulation --

  const sim = new Map();
  for (const inst of instruments) {
    const seedN = hashString(inst.symbol);
    const rnd = mulberry32(seedN);
    const period = 1200 + Math.floor(rnd() * 800); // 1.2–2.0s per instrument
    const phase = Math.floor(rnd() * period);
    const sigma = inst.assetClass === "fx" ? 0.0001 : inst.assetClass === "crypto" ? 0.0008 : 0.0003;
    sim.set(inst.symbol, { seedN, period, phase, sigma, cache: new Map() });
  }
  const PHI = 0.98;
  const TERMS = 260; // PHI^260 ≈ 0.005, so the truncated sum is effectively exact

  function tickIndex(symbol, t) {
    const s = sim.get(symbol);
    return Math.floor((t - s.phase) / s.period);
  }

  function rawAt(symbol, k) {
    const s = sim.get(symbol);
    const hit = s.cache.get(k);
    if (hit !== undefined) return hit;
    let x = 0;
    let w = 1;
    for (let j = 0; j < TERMS; j++) {
      x += w * gaussianAt(s.seedN, k - j);
      w *= PHI;
    }
    const inst = bySymbol.get(symbol);
    const raw = inst.price * (1 + s.sigma * x);
    if (s.cache.size >= 6) s.cache.delete(s.cache.keys().next().value);
    s.cache.set(k, raw);
    return raw;
  }

  function geometry(sig) {
    if (sig.entryLow == null) return null;
    const mid = (sig.entryLow + sig.entryHigh) / 2;
    const sign = sig.direction === "SHORT" ? -1 : 1;
    const risk = Math.abs(mid - sig.stop);
    return { mid, sign, risk };
  }

  const revealCache = new Map();
  /** Effective status at time t, relative to this surface's load time. */
  function signalState(symbol, t = Date.now(), at = loadedAt) {
    const inst = bySymbol.get(symbol);
    const sig = inst.signal;
    if (sig.status !== "queued") {
      return { status: sig.status, issuedAt: at - sig.issuedMinutesAgo * 60000, revealAt: null, secondsToReveal: 0, revealedFromQueue: false };
    }
    const revealAt = at + (sig.revealAfterSec ?? 30) * 1000;
    if (t < revealAt) {
      return { status: "queued", issuedAt: null, revealAt, secondsToReveal: (revealAt - t) / 1000, revealedFromQueue: false };
    }
    const key = `${symbol}@${revealAt}`;
    let st = revealCache.get(key);
    if (!st) {
      const p = rawAt(symbol, tickIndex(symbol, revealAt));
      const inZone = p >= sig.entryLow && p <= sig.entryHigh;
      st = { status: inZone ? "active" : "pending", side: p > sig.entryHigh ? 1 : -1 };
      revealCache.set(key, st);
    }
    return { status: st.status, issuedAt: revealAt, revealAt, secondsToReveal: 0, revealedFromQueue: true, pendingSide: st.side };
  }

  function reflect(p, lo, hi) {
    if (lo != null && p < lo) p = lo + (lo - p);
    if (hi != null && p > hi) p = hi - (p - hi);
    if (lo != null && p < lo) p = lo;
    if (hi != null && p > hi) p = hi;
    return p;
  }

  function clampFor(inst, state, p) {
    const sig = inst.signal;
    const g = geometry(sig);
    if (!g) return p;
    const st = state.status;
    if (st === "active" || st === "t1_hit") {
      const m = g.risk * 0.12;
      const stopLevel = st === "t1_hit" ? g.mid : sig.stop;
      if (g.sign > 0) return reflect(p, stopLevel + m, sig.target2 - m);
      return reflect(p, sig.target2 + m, stopLevel - m);
    }
    if (st === "pending") {
      const mz = (sig.entryHigh - sig.entryLow) * 0.15 + inst.price * 0.00005;
      const side = state.pendingSide ?? (inst.price > sig.entryHigh ? 1 : -1);
      return side > 0 ? reflect(p, sig.entryHigh + mz, null) : reflect(p, null, sig.entryLow - mz);
    }
    return p;
  }

  function priceAt(symbol, t = Date.now(), at = loadedAt) {
    const inst = bySymbol.get(symbol);
    const k = tickIndex(symbol, t);
    const state = signalState(symbol, t, at);
    const p = clampFor(inst, state, rawAt(symbol, k));
    const f = Math.pow(10, inst.decimals);
    return Math.round(p * f) / f;
  }

  function quote(symbol, t = Date.now(), at = loadedAt) {
    const inst = bySymbol.get(symbol);
    const k = tickIndex(symbol, t);
    const price = priceAt(symbol, t, at);
    const s = sim.get(symbol);
    const prevPrice = priceAt(symbol, t - s.period, at);
    const state = signalState(symbol, t, at);
    const g = geometry(inst.signal);
    const r = g ? (g.sign * (price - g.mid)) / g.risk : null;
    return {
      symbol,
      tick: k,
      price,
      prevPrice,
      dir: price > prevPrice ? 1 : price < prevPrice ? -1 : 0,
      change: price - inst.prevClose,
      changePct: (price - inst.prevClose) / inst.prevClose,
      r,
      state,
    };
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

  function issuedText(symbol, t = Date.now(), at = loadedAt) {
    const st = signalState(symbol, t, at);
    if (st.status === "queued") return "queued";
    return formatAgo(t - st.issuedAt);
  }

  /** Everything a surface needs to draw a signal, as plain serializable data. */
  function snapshot(symbol, t = Date.now(), at = loadedAt) {
    const inst = bySymbol.get(symbol);
    if (!inst) return null;
    const sig = inst.signal;
    const q = quote(symbol, t, at);
    const st = q.state;
    const isSit = sig.status === "sit_out";
    const live = st.status === "active" || st.status === "t1_hit";
    return {
      symbol,
      name: inst.name,
      exchange: inst.exchange,
      market: inst.market,
      assetClass: inst.assetClass,
      currency: inst.currency,
      id: sig.id,
      status: st.status,
      statusText: STATUS_TEXT[st.status],
      secondsToReveal: st.secondsToReveal,
      countdown: st.status === "queued" ? formatCountdown(st.secondsToReveal) : null,
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
      r: live ? q.r : null,
      rText: live ? formatR(q.r) : null,
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
    const perUnit = g.risk;
    let qty = riskInst / perUnit;
    const fractional = inst.assetClass === "crypto";
    qty = fractional ? Math.floor(qty * 1000) / 1000 : Math.floor(qty);
    const entry = g.mid;
    const notional = qty * entry;
    const fxNote =
      currency === inst.currency || (currency === "USD" && inst.currency === "USDT") || (currency === "USDT" && inst.currency === "USD")
        ? null
        : `Converted ${currency}→${inst.currency} at simulated rates.`;
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
    const L = seed.ledger || [];
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
      head: L.length ? L[L.length - 1].hash : null,
    };
  }

  return {
    seed,
    loadedAt,
    instruments,
    markets: seed.markets,
    get: (s) => bySymbol.get(s) || null,
    resolve,
    detect,
    search,
    priceAt,
    quote,
    tickIndex,
    signalState,
    tradeMap,
    confluence,
    snapshot,
    issuedText,
    sizePosition,
    convert,
    ledgerStats,
    periodOf: (s) => sim.get(s)?.period ?? 1600,
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
