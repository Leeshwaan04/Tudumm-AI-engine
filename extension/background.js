// Tudumm background service worker (ES module).
// Owns the seed + engine, answers the content script, remembers per-tab
// detections (chrome.storage.session) so the side panel can follow the active
// tab, and opens the side panel / terminal on request.
import { loadSeed, createEngine, mergeSettings, terminalUrl } from "./lib/engine.js";
import { validateMessage, handleDetect, handleSnapshot } from "./lib/protocol.js";

let enginePromise = null;
function getEngine() {
  if (!enginePromise) {
    enginePromise = loadSeed().then((seed) => createEngine(seed));
    enginePromise.catch(() => {
      enginePromise = null;
    });
  }
  return enginePromise;
}

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

async function webUrl() {
  try {
    const { settings } = await chrome.storage.sync.get("settings");
    return mergeSettings(settings).webUrl;
  } catch {
    return mergeSettings(null).webUrl;
  }
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  // Only our own extension contexts; there is no externally_connectable, so web
  // pages and other extensions cannot reach this listener at all.
  if (!sender || sender.id !== chrome.runtime.id) return false;
  const msg = validateMessage(raw);
  if (!msg) return false;
  const tab = sender.tab || null;

  if (msg.type === "openSidePanel") {
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

  if (msg.type === "openTerminal") {
    webUrl().then(async (base) => {
      const url = terminalUrl(base, msg.symbol); // null unless http(s)
      if (!url) return sendResponse({ ok: false, error: "invalid-web-url" });
      try {
        await chrome.tabs.create({ url, ...(tab && Number.isInteger(tab.index) ? { index: tab.index + 1 } : {}) });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message) });
      }
    });
    return true;
  }

  if (msg.type === "detect") {
    // Detection only comes from our content script in a tab's top frame, and the
    // claimed URL must match the sender's actual origin.
    if (!tab || tab.id == null || sender.frameId !== 0) return false;
    if (sender.url && !sameOrigin(sender.url, msg.url)) return false;
    getEngine().then(
      (engine) => {
        const res = handleDetect(engine, msg);
        const key = `tab:${tab.id}`;
        const store = res.detection ? chrome.storage.session.set({ [key]: { ...res.detection, tabId: tab.id, at: Date.now() } }) : chrome.storage.session.remove(key);
        store.catch(() => {});
        sendResponse(res);
      },
      () => sendResponse({ ok: false, error: "seed" }),
    );
    return true;
  }

  if (msg.type === "snapshot") {
    getEngine().then(
      (engine) => sendResponse(handleSnapshot(engine, msg)),
      () => sendResponse({ ok: false, error: "seed" }),
    );
    return true;
  }
  return false;
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
