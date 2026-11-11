// Page-side data session shared by the popup and the side panel.
//
//   const data = createDataSession({ onSignals, onMode });
//   await data.start();          // loads the live universe (or an explicit offline state)
//   data.engine / data.payload   // always current; the engine is rebuilt when signals change
//                                // data.engine is null while offline: surfaces say so
//
// - Polls the universe every 60 s (the background caches it for 60 s too).
//   Quote-only changes are folded into the current engine; a new, removed or
//   changed signal rebuilds the engine and calls onSignals({ added }) so the
//   surface can re-render and run the Reveal on genuinely new calls.
// - Crypto and the PAXG gold proxy tick from the Binance public stream
//   (lib/ticks.js). Nothing is simulated: no random walk, no bundled data set.
// - Offline (the API can't be reached and there's no recent live data): no
//   engine, onMode(payload) so the surface shows "Live data temporarily
//   unavailable — retrying", and a retry after payload.retryInMs.
// - Polling and the stream pause while the page is hidden.

import { createEngine } from "./engine.js";
import { binancePairs, createTickStream } from "./ticks.js";
import * as P from "./platform.js";

export const POLL_MS = 60_000;

const OPEN = new Set(["active", "pending", "t1_hit"]);

export function openSignalIds(engine) {
  return new Set(engine.instruments.filter((i) => OPEN.has(i.signal.status)).map((i) => i.signal.id));
}

/** Signals that are open now and weren't open before (by id). */
export function newSignals(before, after) {
  const prev = openSignalIds(before);
  return after.instruments.filter((i) => OPEN.has(i.signal.status) && !prev.has(i.signal.id)).map((i) => i.symbol);
}

export function createDataSession({ onSignals = () => {}, onMode = () => {}, onTickStatus = () => {}, loader = P.loadData, doc = globalThis.document } = {}) {
  let payload = null;
  let engine = null;
  let stream = null;
  let timer = null;
  let retryTimer = null;
  let started = false;
  let tickStatus = "off";

  function build(p, prevEngine) {
    return createEngine(p.universe, { loadedAt: prevEngine ? prevEngine.loadedAt : Date.now() });
  }

  function startStream() {
    if (stream) stream.stop();
    stream = null;
    tickStatus = "off";
    if (!engine || !engine.live) return onTickStatus("off");
    const pairs = binancePairs(engine.instruments);
    if (!pairs.length) return onTickStatus("off");
    stream = createTickStream({
      pairs,
      onTick: (symbol, price, at) => {
        if (engine) engine.setQuote(symbol, { price, at, source: "binance" });
      },
      onStatus: (s) => {
        tickStatus = s;
        onTickStatus(s);
      },
    });
    stream.start();
  }

  async function refresh({ force = false } = {}) {
    const next = await loader({ force });
    if (!next) return;
    const prev = payload;
    const prevEngine = engine;
    payload = next;
    clearTimeout(retryTimer);
    if (next.mode !== "live" || !next.universe) {
      // Offline: drop the engine (never keep showing old numbers as if current) and retry.
      engine = null;
      startStream();
      retryTimer = setTimeout(() => {
        if (doc && doc.visibilityState === "hidden") return;
        refresh({ force: true }).catch(() => {});
      }, Math.max(5_000, next.retryInMs || 15_000));
      if (prev) onMode(payload, { modeChanged: prev.mode !== next.mode });
      return;
    }
    const modeChanged = !prev || prev.mode !== next.mode || prev.origin !== next.origin;
    if (!modeChanged && prevEngine) {
      const candidate = build(next, prevEngine);
      if (candidate.signalKey() === prevEngine.signalKey()) {
        prevEngine.applyQuotes(next.universe);
        // Keep stale/reason in sync for the badge without a full re-render.
        if (prev.stale !== next.stale || prev.reason !== next.reason) onMode(payload, { modeChanged: false });
        return;
      }
      // Carry real Binance prices that arrived since the universe was built.
      for (const inst of prevEngine.instruments) {
        const q = prevEngine.quote(inst.symbol);
        if (q.price != null && q.at) candidate.setQuote(inst.symbol, { price: q.price, at: q.at });
      }
      engine = candidate;
      onSignals({ added: newSignals(prevEngine, candidate) });
      return;
    }
    engine = build(next, null);
    startStream();
    if (prev) onMode(payload, { modeChanged: true });
  }

  function schedule() {
    clearInterval(timer);
    timer = setInterval(() => {
      if (doc && doc.visibilityState === "hidden") return;
      refresh().catch(() => {});
    }, POLL_MS);
  }

  return {
    get engine() {
      return engine;
    },
    get payload() {
      return payload;
    },
    get live() {
      return !!(payload && payload.mode === "live");
    },
    get tickStatus() {
      return tickStatus;
    },
    async start() {
      if (started) return;
      started = true;
      await refresh();
      schedule();
      if (doc && doc.addEventListener) {
        doc.addEventListener("visibilitychange", () => {
          if (doc.visibilityState === "visible" && payload && Date.now() - payload.fetchedAt > POLL_MS) refresh().catch(() => {});
        });
      }
    },
    /** Retry now (e.g. the offline state's "Retry now" button). */
    retry: () => refresh({ force: true }),
    stop() {
      clearInterval(timer);
      clearTimeout(retryTimer);
      if (stream) stream.stop();
    },
  };
}
