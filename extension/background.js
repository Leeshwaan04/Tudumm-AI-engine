// Tudumm background service worker (ES module).
// - Owns the market data: the universe from {webUrl}/api/v1/market/universe
//   (60 s cache, also kept in chrome.storage.session so a restarted worker doesn't
//   refetch). There is no fallback data: when the API can't be reached the
//   surfaces show "Can't reach Tudumm — retrying".
// - Answers the content-script chip (detect / snapshot) from that data; crypto and
//   the PAXG gold proxy get fresh Binance prices while a chip is open.
// - Owns the Tudumm account link (device-code flow) and the token. The token sits
//   in chrome.storage.local and is only ever sent to the configured web app origin.
// - Remembers per-tab detections (chrome.storage.session) so the side panel can
//   follow the active tab, and opens the side panel / terminal on request.
import { createEngine, mergeSettings, terminalUrl, apiOrigin, binanceStreamPair, siteFor } from "./lib/engine.js";
import { validateMessage, handleDetect, handleSnapshot, senderKind, allowedFrom } from "./lib/protocol.js";
import { createUniverseSource } from "./lib/datasource.js";
import { createAccountService, KEYS } from "./lib/account.js";

const EXT_BASE = chrome.runtime.getURL("");
const BINANCE_REST = "https://data-api.binance.vision/api/v3/ticker/price?symbol=";
const BINANCE_REFRESH_MS = 2500;

// Defense in depth: keep chrome.storage.local (it holds the account token) out of
// reach of content scripts, where Chrome supports restricting it.
try {
  const p = chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
  if (p && p.catch) p.catch(() => {});
} catch {
  /* older Chrome: content.js never reads local storage anyway */
}

async function getSettings() {
  try {
    const { settings } = await chrome.storage.sync.get("settings");
    return mergeSettings(settings);
  } catch {
    return mergeSettings(null);
  }
}

const store = {
  get: (area, keys) => chrome.storage[area].get(keys),
  set: (area, obj) => chrome.storage[area].set(obj),
  remove: (area, keys) => chrome.storage[area].remove(keys),
};

// ------------------------------------------------------------ market data --

const source = createUniverseSource({
  fetchImpl: (url, init) => fetch(url, init),
  getSettings,
  cache: {
    get: async () => (await chrome.storage.session.get("universeCache")).universeCache || null,
    set: (payload) => chrome.storage.session.set({ universeCache: payload }),
    clear: () => chrome.storage.session.remove("universeCache"),
  },
});

let current = null; // { key, engine|null, payload }   engine is null while offline
let building = null;
const binanceAt = new Map();

async function getData() {
  if (building) return building;
  building = (async () => {
    const payload = await source.get();
    if (payload.mode !== "live") {
      current = { key: "offline", engine: null, payload };
      return current;
    }
    const key = `live@${payload.fetchedAt}@${payload.origin}`;
    if (!current || current.key !== key) {
      const prev = current;
      const engine = createEngine(payload.universe, { loadedAt: prev && prev.engine ? prev.engine.loadedAt : Date.now() });
      // Keep Binance prices fetched since this universe was built.
      if (prev && prev.engine) {
        for (const inst of prev.engine.instruments) {
          const q = prev.engine.quote(inst.symbol);
          if (q.price != null && q.at) engine.setQuote(inst.symbol, { price: q.price, at: q.at, source: inst.source });
        }
      }
      current = { key, engine, payload };
    }
    return current;
  })().finally(() => (building = null));
  return building;
}

/**
 * Live mode: refresh a crypto (or PAXG gold proxy) price from Binance's public market
 * data while a chip shows it (stale-while-revalidate, at most every 2.5 s per symbol).
 * The service worker sleeps when idle, so it polls REST on demand instead of holding
 * a stream open; pages (popup, side panel) use the WebSocket stream (lib/ticks.js).
 */
function refreshBinance(engine, symbol) {
  const inst = engine.get(symbol);
  const pair = engine.live && inst ? binanceStreamPair(inst) : null;
  if (!pair) return;
  const last = binanceAt.get(symbol) || 0;
  if (Date.now() - last < BINANCE_REFRESH_MS) return;
  binanceAt.set(symbol, Date.now());
  fetch(BINANCE_REST + pair, { credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(4000) })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      const price = d && Number(d.price);
      if (Number.isFinite(price) && price > 0) engine.setQuote(symbol, { price, at: Date.now(), source: "binance" });
    })
    .catch(() => {});
}

// ---------------------------------------------------------------- account --

const account = createAccountService({
  fetchImpl: (url, init) => fetch(url, init),
  store,
  getSettings,
  openTab: (url) => chrome.tabs.create({ url }),
});

// A restarted worker resumes an in-flight link.
account.pollLoop().catch(() => {});

// ------------------------------------------------------------- lifecycle --

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const { settings } = await chrome.storage.sync.get("settings");
    await chrome.storage.sync.set({ settings: mergeSettings(settings) });
  } catch {
    /* storage unavailable */
  }
  // The toolbar icon opens the popup; the side panel opens from explicit buttons.
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes.settings) return;
  const before = mergeSettings(changes.settings.oldValue);
  const after = mergeSettings(changes.settings.newValue);
  if (apiOrigin(before.webUrl) !== apiOrigin(after.webUrl)) {
    source.invalidate();
    current = null;
  }
});

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function reply(promise, sendResponse) {
  promise.then(sendResponse, (err) => sendResponse({ ok: false, error: String((err && err.message) || err || "error") }));
  return true;
}

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  // Only our own extension contexts; there is no externally_connectable, so web
  // pages and other extensions cannot reach this listener at all.
  const kind = senderKind(sender, chrome.runtime.id, EXT_BASE);
  if (!kind) return false;
  const msg = validateMessage(raw);
  if (!msg || !allowedFrom(kind, msg.type)) return false;
  const tab = sender.tab || null;

  switch (msg.type) {
    case "openSidePanel": {
      if (!tab || tab.id == null) {
        sendResponse({ ok: false, error: "no-tab" });
        return false;
      }
      let opening;
      try {
        // Called synchronously inside the listener so the click's user gesture still counts.
        opening = chrome.sidePanel.open({ tabId: tab.id });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message) });
        return false;
      }
      if (msg.symbol) chrome.storage.session.set({ sidepanelFocus: { symbol: msg.symbol, at: Date.now() } }).catch(() => {});
      opening.then(
        () => sendResponse({ ok: true }),
        (err) => sendResponse({ ok: false, error: String(err && err.message) }),
      );
      return true;
    }

    case "openTerminal":
      return reply(
        getSettings().then(async ({ webUrl }) => {
          const url = terminalUrl(webUrl, msg.symbol); // null unless https (or http on localhost)
          if (!url) return { ok: false, error: "invalid-web-url" };
          await chrome.tabs.create({ url, ...(tab && Number.isInteger(tab.index) ? { index: tab.index + 1 } : {}) });
          return { ok: true };
        }),
        sendResponse,
      );

    case "detect": {
      // Detection only comes from our content script in a tab's top frame, and the
      // claimed URL must match the sender's actual origin.
      if (kind !== "content" || !tab || tab.id == null || sender.frameId !== 0) return false;
      if (sender.url && !sameOrigin(sender.url, msg.url)) return false;
      return reply(
        getData().then(({ engine, payload }) => {
          // Offline: say so on supported sites instead of showing stale or made-up data.
          if (!engine) {
            const site = siteFor(msg.url);
            return site ? { ok: true, offline: true, site: site.key, siteLabel: site.label, reasonText: payload.reasonText || null, retryInMs: payload.retryInMs || 15000 } : { ok: true, detection: null, snapshot: null };
          }
          const res = handleDetect(engine, msg);
          if (res.detection && res.detection.symbol) refreshBinance(engine, res.detection.symbol);
          const key = `tab:${tab.id}`;
          const st = res.detection ? chrome.storage.session.set({ [key]: { ...res.detection, tabId: tab.id, at: Date.now() } }) : chrome.storage.session.remove(key);
          st.catch(() => {});
          return res;
        }),
        sendResponse,
      );
    }

    case "snapshot":
      return reply(
        getData().then(({ engine, payload }) => {
          if (!engine) return { ok: false, offline: true, reasonText: payload.reasonText || null };
          refreshBinance(engine, msg.symbol);
          return handleSnapshot(engine, msg);
        }),
        sendResponse,
      );

    // ---- extension pages only (enforced by allowedFrom above) ----

    case "universe":
      return reply(
        source.get({ force: msg.force }).then((payload) => ({ ok: true, payload })),
        sendResponse,
      );

    case "account":
      return reply(
        (async () => {
          const st = await account.status({ refreshCaps: msg.refresh });
          if (st.link && st.link.status === "pending") account.pollLoop().catch(() => {});
          if (st.linked && !st.originMismatch) account.refresh({ force: msg.refresh }).catch(() => {});
          return { ok: true, status: st };
        })(),
        sendResponse,
      );

    case "linkStart":
      return reply(account.startLink(), sendResponse);

    case "linkCancel":
      return reply(account.cancelLink(), sendResponse);

    case "unlink":
      return reply(account.unlink(), sendResponse);

    case "watchSet":
      return reply(account.setWatch(msg.symbol, msg.on), sendResponse);

    case "watchClear":
      return reply(account.clearWatch(), sendResponse);

    default:
      return false;
  }
});

// Keep per-tab detections tidy.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`tab:${tabId}`).catch(() => {});
});
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== "loading") return;
  const key = `tab:${tabId}`;
  try {
    const got = await chrome.storage.session.get(key);
    // A full navigation starts; the content script re-reports on the new page if
    // it's supported. Keep very fresh reports (SPA navigations report instantly).
    if (got[key] && Date.now() - got[key].at > 1500) await chrome.storage.session.remove(key);
  } catch {
    /* ignore */
  }
});

// Exposed for debugging from the service worker console (no secrets).
globalThis.tudumm = { data: () => getData().then((d) => ({ mode: d.payload.mode, reason: d.payload.reason, fetchedAt: d.payload.fetchedAt })), KEYS };
