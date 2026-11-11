// Real-time crypto ticks (and the PAXG gold proxy) from Binance's public market
// data stream, the same one the web app uses:
//   wss://data-stream.binance.vision/stream?streams=btcusdt@miniTicker/...
// Live mode only. Reconnects with exponential backoff + jitter, closes while the
// page is hidden and reopens when it's visible again, and reconnects when the
// stream goes silent. No simulated values: if the stream is down, prices simply
// stay at the last real value (and say when that was).
//
// Pure ES module: WebSocket, timers and the document are injectable for tests.

import { binanceStreamPair } from "./engine.js";

export const STREAM_BASE = "wss://data-stream.binance.vision/stream?streams=";
export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;
export const SILENCE_MS = 45_000;

/**
 * [{ symbol: "XAUUSD", pair: "PAXGUSDT" }, …]: live crypto in real time (whichever venue
 * served the universe quote, as the web app does) and gold via the PAXG proxy.
 */
export function binancePairs(instruments) {
  const out = [];
  for (const i of instruments || []) {
    const pair = binanceStreamPair(i);
    if (pair && !out.some((p) => p.pair === pair)) out.push({ symbol: i.symbol, pair });
  }
  return out;
}

export function streamUrl(pairs) {
  if (!pairs.length) return null;
  return STREAM_BASE + pairs.map((p) => `${p.pair.toLowerCase()}@miniTicker`).join("/");
}

/** Parse one combined-stream frame → { pair, price, at } or null. */
export function parseMiniTicker(raw) {
  let msg = raw;
  if (typeof raw === "string") {
    if (raw.length > 4096) return null;
    try {
      msg = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const d = msg && typeof msg === "object" ? msg.data || msg : null;
  if (!d || d.e !== "24hrMiniTicker" || typeof d.s !== "string") return null;
  const price = Number(d.c);
  const at = Number(d.E);
  if (!Number.isFinite(price) || price <= 0) return null;
  return { pair: d.s.toUpperCase(), price, at: Number.isFinite(at) && at > 0 ? at : Date.now() };
}

export function backoffDelay(attempt, rnd = Math.random) {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * Math.pow(2, Math.max(0, attempt)));
  return Math.round(base * (0.75 + rnd() * 0.5));
}

/**
 * createTickStream({ pairs, onTick(symbol, price, at), onStatus(status) })
 * status: "connecting" | "live" | "paused" (page hidden) | "retrying" | "off"
 */
export function createTickStream({ pairs, onTick, onStatus = () => {}, WebSocketImpl = globalThis.WebSocket, doc = globalThis.document, timers = globalThis, rnd = Math.random, now = () => Date.now() }) {
  const url = streamUrl(pairs || []);
  const bySymbol = new Map((pairs || []).map((p) => [p.pair, p.symbol]));
  let ws = null;
  let attempt = 0;
  let retryTimer = null;
  let silenceTimer = null;
  let stopped = true;
  let status = "off";
  let lastMsgAt = 0;

  const setStatus = (s) => {
    if (s === status) return;
    status = s;
    try {
      onStatus(s);
    } catch {
      /* listener errors don't break the stream */
    }
  };
  const hidden = () => !!(doc && doc.visibilityState === "hidden");

  function clearTimers() {
    if (retryTimer) timers.clearTimeout(retryTimer);
    if (silenceTimer) timers.clearTimeout(silenceTimer);
    retryTimer = silenceTimer = null;
  }

  function close() {
    clearTimers();
    if (ws) {
      const w = ws;
      ws = null;
      w.onopen = w.onmessage = w.onerror = w.onclose = null;
      try {
        w.close();
      } catch {
        /* already closed */
      }
    }
  }

  function armSilence() {
    if (silenceTimer) timers.clearTimeout(silenceTimer);
    silenceTimer = timers.setTimeout(() => {
      // The socket is open but quiet: treat it as dead and reconnect.
      if (!stopped && now() - lastMsgAt >= SILENCE_MS) {
        close();
        schedule();
      }
    }, SILENCE_MS);
  }

  function schedule() {
    if (stopped || hidden()) return;
    setStatus("retrying");
    const delay = backoffDelay(attempt++, rnd);
    retryTimer = timers.setTimeout(connect, delay);
  }

  function connect() {
    retryTimer = null;
    if (stopped || !url || !WebSocketImpl) return;
    if (hidden()) return setStatus("paused");
    setStatus("connecting");
    let w;
    try {
      w = new WebSocketImpl(url);
    } catch {
      return schedule();
    }
    ws = w;
    w.onopen = () => {
      lastMsgAt = now();
      armSilence();
    };
    w.onmessage = (e) => {
      const t = parseMiniTicker(e && e.data);
      if (!t) return;
      lastMsgAt = now();
      attempt = 0;
      setStatus("live");
      armSilence();
      const symbol = bySymbol.get(t.pair);
      if (symbol) onTick(symbol, t.price, t.at);
    };
    w.onerror = () => {
      /* onclose follows; reconnect there */
    };
    w.onclose = () => {
      if (ws !== w) return;
      ws = null;
      clearTimers();
      schedule();
    };
  }

  function onVisibility() {
    if (stopped) return;
    if (hidden()) {
      close();
      setStatus("paused");
    } else if (!ws && !retryTimer) {
      attempt = 0;
      connect();
    }
  }

  return {
    get status() {
      return status;
    },
    get url() {
      return url;
    },
    start() {
      if (!url || !WebSocketImpl) return false;
      if (!stopped) return true;
      stopped = false;
      if (doc && doc.addEventListener) doc.addEventListener("visibilitychange", onVisibility);
      connect();
      return true;
    },
    stop() {
      stopped = true;
      if (doc && doc.removeEventListener) doc.removeEventListener("visibilitychange", onVisibility);
      close();
      setStatus("off");
    },
  };
}
