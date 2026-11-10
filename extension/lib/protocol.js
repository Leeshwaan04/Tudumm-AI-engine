// Message protocol between the content script (chip) and the background.
// The same validator + handlers back the real service worker and preview mode,
// so the chip behaves identically in both.
//
// Strict allowlist: unknown types, unexpected keys or wrong shapes are dropped.

const SYMBOL_RE = /^[A-Z0-9]{1,15}$/;
const ALLOWED = {
  detect: ["type", "url", "title", "loadedAt"],
  snapshot: ["type", "symbol", "loadedAt"],
  openSidePanel: ["type", "symbol"],
  openTerminal: ["type", "symbol"],
};
export const MESSAGE_TYPES = Object.freeze(Object.keys(ALLOWED));

function isPlainObject(v) {
  return v != null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
}

function okLoadedAt(v, now) {
  return typeof v === "number" && Number.isFinite(v) && v > now - 7 * 24 * 3600e3 && v < now + 60e3;
}

function okSymbol(v, nullable) {
  return (nullable && v == null) || (typeof v === "string" && SYMBOL_RE.test(v));
}

/** Returns a sanitized copy of a valid message, or null. */
export function validateMessage(msg, now = Date.now()) {
  if (!isPlainObject(msg) || typeof msg.type !== "string" || !Object.hasOwn(ALLOWED, msg.type)) return null;
  const keys = Object.keys(msg);
  if (keys.some((k) => !ALLOWED[msg.type].includes(k))) return null;
  switch (msg.type) {
    case "detect": {
      if (typeof msg.url !== "string" || msg.url.length > 2048) return null;
      if (msg.title != null && (typeof msg.title !== "string" || msg.title.length > 400)) return null;
      if (!okLoadedAt(msg.loadedAt, now)) return null;
      let u;
      try {
        u = new URL(msg.url);
      } catch {
        return null;
      }
      if (u.protocol !== "https:") return null;
      return { type: "detect", url: u.href, title: msg.title || "", loadedAt: msg.loadedAt };
    }
    case "snapshot":
      if (!okSymbol(msg.symbol, false) || !okLoadedAt(msg.loadedAt, now)) return null;
      return { type: "snapshot", symbol: msg.symbol, loadedAt: msg.loadedAt };
    case "openSidePanel":
    case "openTerminal":
      if (!okSymbol(msg.symbol, true)) return null;
      return { type: msg.type, symbol: msg.symbol ?? null };
    default:
      return null;
  }
}

/** detect → { ok, detection, snapshot } */
export function handleDetect(engine, msg, now = Date.now()) {
  const d = engine.detect(msg.url, msg.title);
  if (!d.site) return { ok: true, detection: null, snapshot: null };
  const detection = { site: d.site, siteLabel: d.siteLabel, symbol: d.symbol, ticker: d.ticker, via: d.via, url: msg.url };
  return { ok: true, detection, snapshot: d.symbol ? engine.snapshot(d.symbol, now, msg.loadedAt) : null };
}

/** snapshot → { ok, snapshot } */
export function handleSnapshot(engine, msg, now = Date.now()) {
  if (!engine.get(msg.symbol)) return { ok: false };
  return { ok: true, snapshot: engine.snapshot(msg.symbol, now, msg.loadedAt) };
}
