// Message protocol: content script (chip) ↔ background, and extension pages
// (popup, side panel, options) ↔ background.
// The same validator + handlers back the real service worker and preview mode,
// so the chip behaves identically in both.
//
// Strict allowlist: unknown types, unexpected keys or wrong shapes are dropped.
// Account and data messages are PAGE-ONLY: the background refuses them from
// content scripts, so a host page can never start or end a link, or read
// account state, through the chip.

const SYMBOL_RE = /^[A-Z0-9]{1,15}$/;
const ALLOWED = {
  // content script (and pages)
  detect: ["type", "url", "title", "loadedAt"],
  snapshot: ["type", "symbol", "loadedAt"],
  openSidePanel: ["type", "symbol"],
  openTerminal: ["type", "symbol"],
  // extension pages only
  universe: ["type", "force"],
  account: ["type", "refresh"],
  linkStart: ["type"],
  linkCancel: ["type"],
  unlink: ["type"],
  watchSet: ["type", "symbol", "on"],
  watchClear: ["type"],
};
export const MESSAGE_TYPES = Object.freeze(Object.keys(ALLOWED));
export const PAGE_ONLY_TYPES = Object.freeze(["universe", "account", "linkStart", "linkCancel", "unlink", "watchSet", "watchClear"]);
export const CONTENT_TYPES = Object.freeze(["detect", "snapshot", "openSidePanel", "openTerminal"]);

/**
 * Who sent a runtime message:
 *   "page"    an extension page of THIS extension (popup, side panel, options, preview)
 *   "content" our content script in a web page tab
 *   null      anything else (other extensions, or no sender) → ignore
 */
export function senderKind(sender, runtimeId, extensionBaseUrl) {
  if (!sender || !runtimeId || sender.id !== runtimeId) return null;
  const url = typeof sender.url === "string" ? sender.url : "";
  if (extensionBaseUrl && url.startsWith(extensionBaseUrl)) return "page";
  if (sender.tab && sender.tab.id != null && /^https:\/\//.test(url)) return "content";
  return null;
}

/** May this sender send this (already validated) message type? */
export function allowedFrom(kind, type) {
  if (kind === "page") return MESSAGE_TYPES.includes(type);
  if (kind === "content") return CONTENT_TYPES.includes(type);
  return false;
}

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
    case "universe":
      if (msg.force != null && typeof msg.force !== "boolean") return null;
      return { type: "universe", force: msg.force === true };
    case "account":
      if (msg.refresh != null && typeof msg.refresh !== "boolean") return null;
      return { type: "account", refresh: msg.refresh === true };
    case "linkStart":
    case "linkCancel":
    case "unlink":
    case "watchClear":
      return { type: msg.type };
    case "watchSet":
      if (!okSymbol(msg.symbol, false) || typeof msg.on !== "boolean") return null;
      return { type: "watchSet", symbol: msg.symbol, on: msg.on };
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
