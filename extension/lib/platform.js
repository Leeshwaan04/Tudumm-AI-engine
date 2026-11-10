// Platform layer: real Chrome APIs when installed, a tiny shim in preview mode.
//
// Preview mode = any extension page opened outside Chrome's extension context
// (e.g. `python3 -m http.server 5190` from extension/). Storage is in-memory,
// mirrored to localStorage when available so the preview's frames share state,
// `?symbol=RELIANCE` (or `?url=…`) simulates page detection, and anything that
// needs a Chrome-only API explains itself with an "Available when installed" toast.

import { DEFAULT_SETTINGS, mergeSettings, terminalUrl } from "./engine.js";

const chromeApi = globalThis.chrome;
export const IS_EXTENSION = !!(chromeApi && chromeApi.runtime && chromeApi.runtime.id);
export const IS_PREVIEW = !IS_EXTENSION;
export const PARAMS = new URLSearchParams(globalThis.location ? location.search : "");
export const IN_PREVIEW_FRAME = IS_PREVIEW && globalThis.parent && globalThis.parent !== globalThis;

// ------------------------------------------------------------- Storage --

const listeners = new Set();
const mem = { sync: {}, local: {}, session: {} };
const LS_PREFIX = "tudumm-preview:";

function lsRead(area) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + area);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function lsWrite(area, obj) {
  try {
    localStorage.setItem(LS_PREFIX + area, JSON.stringify(obj));
  } catch {
    /* private mode / blocked storage: memory only */
  }
}

if (IS_PREVIEW) {
  for (const area of ["sync", "local"]) mem[area] = lsRead(area) || {};
  try {
    addEventListener("storage", (e) => {
      if (!e.key || !e.key.startsWith(LS_PREFIX)) return;
      const area = e.key.slice(LS_PREFIX.length);
      if (!(area in mem)) return;
      const next = lsRead(area) || {};
      const changes = {};
      for (const k of new Set([...Object.keys(mem[area]), ...Object.keys(next)])) {
        if (JSON.stringify(mem[area][k]) !== JSON.stringify(next[k])) changes[k] = { oldValue: mem[area][k], newValue: next[k] };
      }
      mem[area] = next;
      if (Object.keys(changes).length) for (const fn of listeners) fn(changes, area);
    });
  } catch {
    /* no window */
  }
}

export const storage = {
  async get(area, keys) {
    if (IS_EXTENSION) {
      try {
        return await chromeApi.storage[area].get(keys ?? null);
      } catch {
        return {};
      }
    }
    const src = mem[area];
    if (keys == null) return { ...src };
    const list = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(list.filter((k) => k in src).map((k) => [k, src[k]]));
  },
  async set(area, obj) {
    if (IS_EXTENSION) return chromeApi.storage[area].set(obj);
    const changes = {};
    for (const [k, v] of Object.entries(obj)) {
      changes[k] = { oldValue: mem[area][k], newValue: v };
      mem[area][k] = v;
    }
    if (area !== "session") lsWrite(area, mem[area]);
    for (const fn of listeners) fn(changes, area);
  },
  async remove(area, keys) {
    if (IS_EXTENSION) return chromeApi.storage[area].remove(keys);
    const list = Array.isArray(keys) ? keys : [keys];
    const changes = {};
    for (const k of list) {
      changes[k] = { oldValue: mem[area][k], newValue: undefined };
      delete mem[area][k];
    }
    if (area !== "session") lsWrite(area, mem[area]);
    for (const fn of listeners) fn(changes, area);
  },
  onChanged(fn) {
    if (IS_EXTENSION) chromeApi.storage.onChanged.addListener(fn);
    else listeners.add(fn);
  },
};

export async function getSettings() {
  const { settings } = await storage.get("sync", "settings");
  return mergeSettings(settings);
}
export async function saveSettings(settings) {
  await storage.set("sync", { settings: mergeSettings(settings) });
}
export { DEFAULT_SETTINGS };

export async function getWatchlist() {
  const { watchlist } = await storage.get("local", "watchlist");
  return Array.isArray(watchlist) ? watchlist : [];
}
export async function toggleWatch(symbol) {
  const list = await getWatchlist();
  const next = list.includes(symbol) ? list.filter((s) => s !== symbol) : [...list, symbol];
  await storage.set("local", { watchlist: next });
  return next.includes(symbol);
}

// --------------------------------------------------------------- Toast --

let toastHost = null;
export function toast(message, { tone = "info", action = null, timeout = 3200 } = {}) {
  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.className = "toasts";
    toastHost.setAttribute("role", "status");
    toastHost.setAttribute("aria-live", "polite");
    document.body.appendChild(toastHost);
  }
  const el = document.createElement("div");
  el.className = `toast toast--${tone}`;
  const text = document.createElement("span");
  text.textContent = message;
  el.appendChild(text);
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "toast-action";
    b.textContent = action.label;
    b.addEventListener("click", () => {
      action.run();
      el.remove();
    });
    el.appendChild(b);
  }
  toastHost.appendChild(el);
  setTimeout(() => el.classList.add("is-leaving"), timeout);
  setTimeout(() => el.remove(), timeout + 260);
  return el;
}

export function previewOnly(what) {
  toast(`${what}: available when installed`, { tone: "preview" });
  if (IN_PREVIEW_FRAME) {
    try {
      parent.postMessage({ type: "tudumm:preview-notice", what }, location.origin);
    } catch {
      /* cross-origin parent */
    }
  }
}

// ------------------------------------------------------------- Actions --

/** Open the Tudumm side panel. Must be called synchronously from a click. */
export function openSidePanel({ windowId, tabId, focusSymbol } = {}) {
  if (!IS_EXTENSION || !chromeApi.sidePanel) {
    previewOnly("Open side panel");
    return Promise.resolve(false);
  }
  const target = tabId != null ? { tabId } : windowId != null ? { windowId } : null;
  if (!target) return Promise.resolve(false);
  let opened;
  try {
    opened = chromeApi.sidePanel.open(target);
  } catch {
    return Promise.resolve(false);
  }
  if (focusSymbol) chromeApi.storage.session.set({ sidepanelFocus: { symbol: focusSymbol, at: Date.now() } }).catch(() => {});
  return opened.then(
    () => true,
    () => false,
  );
}

export async function openTerminal(symbol, path) {
  const { webUrl } = await getSettings();
  const url = terminalUrl(webUrl, symbol, path);
  if (!url) {
    toast("The web app URL in Options isn't a valid http(s) address.", { tone: "warn", action: { label: "Fix", run: openOptions } });
    return null;
  }
  openUrl(url);
  return url;
}

/** Opens http(s) URLs only. */
export function openUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (IS_EXTENSION && chromeApi.tabs?.create) chromeApi.tabs.create({ url: u.href });
  else window.open(u.href, "_blank", "noopener,noreferrer");
  return true;
}

export function openOptions() {
  if (IS_EXTENSION && chromeApi.runtime.openOptionsPage) chromeApi.runtime.openOptionsPage();
  else window.open("options.html", "_blank", "noopener");
}

// ----------------------------------------------------- Page detection --

/**
 * The page the user is looking at, for the popup:
 * installed → active tab URL/title via activeTab; preview → ?symbol= / ?url= params.
 */
export async function getActivePage() {
  if (IS_EXTENSION) {
    try {
      const [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
      if (!tab) return null;
      let stored = null;
      try {
        stored = (await chromeApi.storage.session.get(`tab:${tab.id}`))[`tab:${tab.id}`] || null;
      } catch {
        stored = null;
      }
      return { tabId: tab.id, windowId: tab.windowId, url: tab.url || stored?.url || "", title: tab.title || "", stored };
    } catch {
      return null;
    }
  }
  return previewPage();
}

export function previewPage() {
  const symbol = PARAMS.get("symbol");
  const url = PARAMS.get("url");
  const title = PARAMS.get("title") || "";
  if (url) return { tabId: 1, windowId: 1, url, title, simulated: true };
  if (symbol) return { tabId: 1, windowId: 1, url: "", title: "", symbol: symbol.toUpperCase(), simulated: true };
  return { tabId: 1, windowId: 1, url: "", title: "", simulated: true };
}

/** Remember a detection for a tab so the side panel can follow it. */
export async function rememberTabDetection(tabId, det) {
  if (!IS_EXTENSION || tabId == null) return;
  try {
    await chromeApi.storage.session.set({ [`tab:${tabId}`]: { ...det, tabId, at: Date.now() } });
  } catch {
    /* session storage unavailable */
  }
}

/** Preview frames can be told which "page" is open by preview.html. */
export function onPreviewPage(fn) {
  if (!IS_PREVIEW) return;
  addEventListener("message", (e) => {
    if (e.origin !== location.origin) return;
    if (e.data && e.data.type === "tudumm:preview-page") fn(e.data);
  });
}

export const chromeRef = IS_EXTENSION ? chromeApi : null;

// ------------------------------------------------- Side panel: follow tab --

/**
 * Calls onDetection(det|null) for the active tab of the side panel's window,
 * again whenever the user switches tabs or the content script re-detects (SPA
 * navigation). Preview: driven by ?symbol=/?url= and preview.html messages.
 */
export async function followActiveTab(onDetection, detectFn) {
  if (!IS_EXTENSION) {
    const p = previewPage();
    onDetection(p.symbol || p.url ? detectFn(p) : null);
    onPreviewPage((data) => onDetection(detectFn({ url: data.url || "", title: data.title || "", symbol: data.symbol || null })));
    return;
  }
  let windowId = null;
  let activeTabId = null;
  const load = async () => {
    if (activeTabId == null) return onDetection(null);
    const key = `tab:${activeTabId}`;
    try {
      const got = await chromeApi.storage.session.get(key);
      onDetection(got[key] || null);
    } catch {
      onDetection(null);
    }
  };
  try {
    windowId = (await chromeApi.windows.getCurrent()).id;
    const [tab] = await chromeApi.tabs.query({ active: true, windowId });
    activeTabId = tab ? tab.id : null;
  } catch {
    activeTabId = null;
  }
  await load();
  chromeApi.tabs.onActivated.addListener((info) => {
    if (windowId != null && info.windowId !== windowId) return;
    activeTabId = info.tabId;
    load();
  });
  chromeApi.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && activeTabId != null && `tab:${activeTabId}` in changes) load();
  });
}

/** One-shot "open this symbol" hand-off from the popup / chip to the side panel. */
export async function watchSidepanelFocus(onFocus) {
  if (!IS_EXTENSION) {
    const d = PARAMS.get("detail");
    if (d) onFocus(d.toUpperCase());
    return;
  }
  const take = async () => {
    try {
      const { sidepanelFocus } = await chromeApi.storage.session.get("sidepanelFocus");
      if (sidepanelFocus && Date.now() - sidepanelFocus.at < 15000) {
        await chromeApi.storage.session.remove("sidepanelFocus");
        onFocus(sidepanelFocus.symbol);
      }
    } catch {
      /* ignore */
    }
  };
  await take();
  chromeApi.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.sidepanelFocus && changes.sidepanelFocus.newValue) take();
  });
}
