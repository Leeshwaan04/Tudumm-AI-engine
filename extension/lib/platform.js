// Platform layer: real Chrome APIs when installed, a tiny shim in preview mode.
//
// Preview mode = any extension page opened outside Chrome's extension context
// (e.g. `python3 -m http.server 5190` from extension/). Storage is in-memory,
// mirrored to localStorage when available so the preview's frames share state,
// `?symbol=RELIANCE` (or `?url=…`) simulates page detection, and anything that
// needs a Chrome-only API explains itself with an "Available when installed" toast.

import { DEFAULT_SETTINGS, mergeSettings, terminalUrl, apiOrigin, TUDUMM_ORIGINS } from "./engine.js";
import { createUniverseSource, reasonText } from "./datasource.js";

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

/** [{ symbol, signalId|null }] the linked account tracks (from the web terminal). */
export async function getTracked() {
  const { tracked } = await storage.get("local", "tracked");
  return Array.isArray(tracked) ? tracked : [];
}

// ------------------------------------------------- Background messages --

/** Send a message to the background (installed only). Resolves to the response or { ok:false }. */
export function send(msg) {
  if (!IS_EXTENSION) return Promise.resolve({ ok: false, error: "preview" });
  return new Promise((resolve) => {
    try {
      chromeApi.runtime.sendMessage(msg, (res) => {
        if (chromeApi.runtime.lastError) resolve({ ok: false, error: chromeApi.runtime.lastError.message || "no-response" });
        else resolve(res || { ok: false, error: "no-response" });
      });
    } catch (err) {
      resolve({ ok: false, error: String((err && err.message) || err) });
    }
  });
}

/**
 * Toggle a star. Installed: the background updates local storage and, when the
 * account is linked, the server (rolled back if the server refuses).
 * → { on, synced, error? }
 */
export async function toggleWatch(symbol) {
  const list = await getWatchlist();
  const on = !list.includes(symbol);
  if (IS_EXTENSION) {
    const res = await send({ type: "watchSet", symbol, on });
    if (res && typeof res.on === "boolean") return { on: res.on, synced: !!res.synced, error: res.ok ? null : res.error || "Couldn't save." };
    return { on: !on, synced: false, error: res && res.error ? "The extension's background didn't answer. Try again." : null };
  }
  const next = on ? [...list, symbol] : list.filter((s) => s !== symbol);
  await storage.set("local", { watchlist: next });
  return { on, synced: false, error: null };
}

// ----------------------------------------------------------- Market data --

/**
 * Preview only: `?universe=tests/fixtures/universe-live.json` loads a recorded live
 * universe from the same server, so the live UI (badges, engine tag, no random
 * walk) can be reviewed without an API. Same-origin relative paths only.
 */
function previewFixturePath() {
  const raw = PARAMS.get("universe");
  if (!raw || !/^[A-Za-z0-9_\-./]{1,120}\.json$/.test(raw) || raw.includes("..") || raw.startsWith("/")) return null;
  return raw;
}

/** Preview pages read live data only when the Tudumm site serves them (same-origin API), or with ?live=1. */
function previewApiOrigin(webUrl) {
  const here = globalThis.location;
  if (here && /^https?:$/.test(here.protocol) && here.pathname.startsWith("/extension/")) return here.origin;
  if (PARAMS.get("live") === "1") return apiOrigin(webUrl);
  return null;
}
let previewSource = null;

/**
 * The market universe for this surface:
 *   { mode: "live", universe, fetchedAt, origin, reason, reasonText, stale }
 * | { mode: "offline", universe: null, origin, reason, reasonText, retryInMs }
 * Installed: from the background (one shared 60 s cache). Preview: fetched here.
 * There is no bundled fallback data set.
 */
export async function loadData({ force = false } = {}) {
  if (IS_EXTENSION) {
    const res = await send({ type: "universe", force });
    if (res && res.ok && res.payload && (res.payload.universe || res.payload.mode === "offline")) return res.payload;
    // The worker didn't answer (e.g. just updated): say so, and retry.
    return { mode: "offline", universe: null, fetchedAt: Date.now(), origin: null, reason: "background", reasonText: reasonText("background"), retryInMs: 15_000, stale: false };
  }
  const fixture = previewFixturePath();
  if (fixture && !previewSource) {
    const here = globalThis.location.origin;
    previewSource = createUniverseSource({
      getSettings: async () => ({ ...(await getSettings()), webUrl: here }),
      apiOriginFor: () => here,
      ttlMs: 24 * 3600_000,
      fetchImpl: (url, init) => fetch(new URL(fixture, globalThis.location.href).href, init),
    });
    const base = previewSource;
    previewSource = { get: (o) => base.get(o).then((p) => (p && p.mode === "live" ? { ...p, recorded: true } : p)) };
  }
  if (!previewSource) {
    previewSource = createUniverseSource({
      getSettings,
      apiOriginFor: (webUrl) => previewApiOrigin(webUrl) || apiOrigin(webUrl),
    });
  }
  return previewSource.get({ force });
}

// --------------------------------------------------------------- Account --

const PREVIEW_ACCOUNT = Object.freeze({ preview: true, linked: false, link: null, capabilities: { reachable: false, extensionLinking: false, reason: "Account linking runs in the installed extension." } });

/** Public account state (never the token). */
export async function getAccount({ refresh = false } = {}) {
  if (!IS_EXTENSION) return PREVIEW_ACCOUNT;
  const res = await send({ type: "account", refresh });
  if (res && res.ok && res.status) return res.status;
  return { linked: false, link: null, capabilities: { reachable: false, extensionLinking: false, reason: "The extension's background didn't answer. Close and reopen this panel." } };
}

export async function linkStart() {
  if (!IS_EXTENSION) {
    previewOnly("Link your Tudumm account");
    return { ok: false, error: null };
  }
  return send({ type: "linkStart" });
}
export const linkCancel = () => (IS_EXTENSION ? send({ type: "linkCancel" }) : Promise.resolve({ ok: true }));
export const unlink = () => (IS_EXTENSION ? send({ type: "unlink" }) : Promise.resolve({ ok: true }));

/** Calls fn() when anything account-related changes (link state, account, tracked). Never passes the values. */
export function onAccountChanged(fn) {
  storage.onChanged((changes, area) => {
    if ((area === "local" && (changes.account || changes.auth || changes.tracked)) || (area === "session" && changes.linkState)) fn();
  });
}

/** Clear the watchlist (and, when linked, the account's watchlist on the server). */
export async function clearWatchlist() {
  if (IS_EXTENSION) return send({ type: "watchClear" });
  await storage.set("local", { watchlist: [] });
  return { ok: true, synced: false };
}

export function isTudummOrigin(origin) {
  return TUDUMM_ORIGINS.includes(origin);
}

/** The optional host permission a local dev API needs (the market API has no CORS), or null. */
export function devHostPattern(webUrl) {
  const origin = apiOrigin(webUrl);
  if (!origin || TUDUMM_ORIGINS.includes(origin)) return null;
  const u = new URL(origin);
  if (u.protocol !== "http:") return null;
  if (u.hostname === "localhost") return "http://localhost/*";
  if (u.hostname === "127.0.0.1") return "http://127.0.0.1/*";
  return null;
}

/**
 * Installed only: ask Chrome for the optional localhost host permission when the web
 * app URL points at a local dev server. MUST be called synchronously from a click.
 * → Promise<"granted"|"denied"|"not-needed">
 */
export function requestDevHostAccess(webUrl) {
  const pattern = devHostPattern(webUrl);
  if (!pattern || !IS_EXTENSION || !chromeApi.permissions) return Promise.resolve("not-needed");
  try {
    return chromeApi.permissions.request({ origins: [pattern] }).then(
      (ok) => (ok ? "granted" : "denied"),
      () => "denied",
    );
  } catch {
    return Promise.resolve("denied");
  }
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
