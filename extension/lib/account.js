// Tudumm account linking for the extension (device-code flow) + server-synced
// watchlist. Runs in the background service worker only; extension pages talk
// to it through messages and never see the token.
//
//   1. POST {web}/api/v1/ext/link/start            → { userCode, deviceToken, verifyUrl, expiresIn, interval }
//   2. the user approves on {web}/app/link?code=…   (signed in on the website)
//   3. POST {web}/api/v1/ext/link/poll {deviceToken} every `interval` s
//                                                  → pending | approved + token (once) | expired (410)
//   4. Bearer token → GET /me, /watchlist, /tracked; POST/DELETE /watchlist/:symbol
//   5. Unlink → POST /api/v1/auth/logout (revokes this extension session), then clear storage.
//
// Token custody:
//   - stored only in chrome.storage.local under "auth" (never sync, never session-shared with pages' UI state)
//   - bound to the origin that issued it; sent ONLY to the configured web app origin, and only when the
//     two match (authedFetch is the single place an Authorization header is built)
//   - credentials:"omit" (no cookies), redirect:"error" (a redirect can't carry it elsewhere), no referrer
//   - the device token from step 1 lives in chrome.storage.session (trusted contexts only) until claimed
//
// Pure ES module: fetch, storage, settings, time and tab opening are injected.

import { apiOrigin, isLoopbackHost, TUDUMM_ORIGINS } from "./engine.js";

const SYMBOL_RE = /^[A-Z0-9]{1,15}$/;
const USER_CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const DEVICE_TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,256}$/;
const UUIDISH_RE = /^[A-Za-z0-9-]{8,64}$/;
const CAPS_TTL_MS = 5 * 60_000;
const SYNC_TTL_MS = 60_000;

export const KEYS = Object.freeze({
  auth: "auth", // local: { token, origin, sessionId, expiresAt, linkedAt }   (secret)
  account: "account", // local: public account summary for the UI
  watchlist: "watchlist", // local: ["BTCUSDT", …]
  tracked: "tracked", // local: [{ symbol, signalId|null }]
  linkDevice: "linkDevice", // session: { deviceToken, origin }   (secret, until claimed)
  linkState: "linkState", // session: { status, userCode, verifyUrl, expiresAt, interval, origin, error? }
});

/** Human text for API failures (status + error code). */
export function errorText(status, code) {
  if (status === 0) return "Can't reach Tudumm. Check your connection and the web app URL in Options.";
  if (status === 401) return "Your Tudumm link has ended (it was revoked or expired). Link again to keep syncing.";
  if (status === 403 && code === "account_suspended") return "This Tudumm account is suspended. Contact support on the website.";
  if (status === 403) return "Tudumm refused the request from the extension.";
  if (status === 409 && code === "limit_reached") return "Your watchlist is full (200 symbols).";
  if (status === 429) return "Slow down — try again in a minute.";
  if (status === 503 && code === "extension_linking_disabled") return "Account linking is switched off on Tudumm right now.";
  if (status === 503) return "That part of Tudumm isn't available right now.";
  if (status === 404 && code === "not_found") return "This Tudumm server doesn't support extension linking yet.";
  return `Tudumm answered with an error (${status}${code ? ` · ${code}` : ""}).`;
}

/** Only open approval pages on the web app's own origin or a known Tudumm origin. */
export function safeVerifyUrl(raw, origin, userCode) {
  const fallback = `${origin}/app/link?code=${encodeURIComponent(userCode)}`;
  if (typeof raw !== "string" || raw.length > 512) return fallback;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return fallback;
  }
  const okScheme = u.protocol === "https:" || (u.protocol === "http:" && isLoopbackHost(u.hostname));
  const okOrigin = u.origin === origin || TUDUMM_ORIGINS.includes(u.origin);
  if (!okScheme || !okOrigin || u.username || u.password) return fallback;
  return u.href;
}

function sanitizeTracked(items) {
  const out = [];
  for (const t of Array.isArray(items) ? items.slice(0, 500) : []) {
    if (!t || typeof t.symbol !== "string" || !SYMBOL_RE.test(t.symbol)) continue;
    const signalId = typeof t.signalId === "string" && t.signalId.length <= 64 ? t.signalId : null;
    out.push({ symbol: t.symbol, signalId });
  }
  return out;
}

function sanitizeSymbols(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter((s) => typeof s === "string" && SYMBOL_RE.test(s)))].slice(0, 200);
}

/**
 * store: { get(area, keys) → obj, set(area, obj), remove(area, keys) } over "local" and "session".
 * getSettings() → { webUrl, … }.  openTab(url) opens a browser tab (background: chrome.tabs.create).
 */
export function createAccountService({ fetchImpl = globalThis.fetch, store, getSettings, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), openTab = () => {} }) {
  let caps = null; // { origin, at, value }
  let polling = false;
  let lastSync = 0;

  const get1 = async (area, key) => (await store.get(area, key))[key];

  async function currentOrigin() {
    return apiOrigin((await getSettings()).webUrl);
  }

  async function request(origin, path, { method = "GET", body, token = null, timeoutMs = 8000 } = {}) {
    const url = new URL(path, origin);
    if (url.origin !== origin) return { ok: false, status: 0, code: "origin_mismatch", data: null };
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    let res;
    try {
      const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
      res = await fetchImpl(url.href, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        signal,
      });
    } catch {
      return { ok: false, status: 0, code: "network", data: null };
    }
    let data = null;
    const type = (res.headers && res.headers.get && res.headers.get("content-type")) || "";
    if (/json/i.test(type)) {
      try {
        data = await res.json();
      } catch {
        data = null;
      }
    } else if (res.ok) {
      // An HTML page where the API should be: an older deployment without these routes.
      return { ok: false, status: 404, code: "not_found", data: null };
    }
    const code = data && typeof data.error === "string" ? data.error.slice(0, 64) : null;
    return { ok: res.ok, status: res.status, code, data };
  }

  /**
   * The ONLY place a Bearer token is attached. The token goes to the configured web app
   * origin, and only if that is the origin that issued it.
   */
  async function authedFetch(path, init = {}) {
    const origin = await currentOrigin();
    const auth = await get1("local", KEYS.auth);
    if (!origin || !auth || typeof auth.token !== "string" || auth.origin !== origin) return { ok: false, status: 0, code: "not_linked", data: null };
    const r = await request(origin, path, { ...init, token: auth.token });
    if (r.status === 401) await dropLink("revoked");
    return r;
  }

  async function dropLink(why) {
    const origin = (await get1("local", KEYS.auth))?.origin || null;
    await store.remove("local", [KEYS.auth, KEYS.tracked]);
    await store.set("local", {
      [KEYS.account]: {
        linked: false,
        origin,
        notice: why === "revoked" ? "Your link ended: the extension's key was revoked or expired. Your watchlist stays in this browser. Link again any time." : null,
        at: now(),
      },
    });
  }

  async function capabilities({ force = false } = {}) {
    const origin = await currentOrigin();
    if (!origin) return { origin: null, reachable: false, extensionLinking: false, reason: "The web app URL in Options isn't a valid https address." };
    if (!force && caps && caps.origin === origin && now() - caps.at < CAPS_TTL_MS) return caps.value;
    const r = await request(origin, "/api/v1/config");
    let value;
    if (r.ok && r.data && r.data.capabilities && typeof r.data.capabilities === "object") {
      const c = r.data.capabilities;
      value = { origin, reachable: true, extensionLinking: c.extensionLinking === true, liveData: c.liveData === true, reason: c.extensionLinking === true ? null : "Account linking isn't switched on for this Tudumm server yet." };
    } else if (r.status === 404 || r.code === "not_found") {
      value = { origin, reachable: true, extensionLinking: false, reason: `${new URL(origin).host} doesn't run the Tudumm account API yet.` };
    } else {
      value = { origin, reachable: false, extensionLinking: false, reason: errorText(r.status, r.code) };
    }
    caps = { origin, at: now(), value };
    return value;
  }

  /** Everything the UI may know. Never includes the token or the device token. */
  async function status({ refreshCaps = false } = {}) {
    const origin = await currentOrigin();
    const local = await store.get("local", [KEYS.auth, KEYS.account, KEYS.tracked]);
    const session = await store.get("session", [KEYS.linkState]);
    const auth = local[KEYS.auth];
    const acct = local[KEYS.account] || null;
    const linked = !!(auth && auth.token);
    const linkState = session[KEYS.linkState] || null;
    const pending = linkState && linkState.status === "pending" && linkState.expiresAt > now() ? linkState : null;
    return {
      origin,
      linked,
      linkedOrigin: linked ? auth.origin : null,
      originMismatch: linked && auth.origin !== origin,
      user: linked && acct && acct.user ? acct.user : null,
      plan: linked && acct && acct.plan ? acct.plan : null,
      counts: linked && acct && acct.counts ? acct.counts : null,
      linkedAt: linked ? auth.linkedAt : null,
      syncedAt: linked && acct ? acct.syncedAt || null : null,
      trackedCount: linked ? (local[KEYS.tracked] || []).length : 0,
      notice: !linked && acct && acct.notice ? acct.notice : null,
      link: pending
        ? { status: "pending", userCode: pending.userCode, verifyUrl: pending.verifyUrl, expiresAt: pending.expiresAt }
        : linkState && linkState.status !== "pending"
          ? { status: linkState.status, error: linkState.error || null }
          : linkState && linkState.status === "pending"
            ? { status: "expired", error: null }
            : null,
      capabilities: linked && !refreshCaps ? null : await capabilities({ force: refreshCaps }),
    };
  }

  async function startLink() {
    const origin = await currentOrigin();
    if (!origin) return { ok: false, error: "The web app URL in Options isn't a valid https address." };
    const auth = await get1("local", KEYS.auth);
    if (auth && auth.token && auth.origin === origin) return { ok: true, already: true };
    const r = await request(origin, "/api/v1/ext/link/start", { method: "POST", body: {} });
    if (!r.ok || !r.data) {
      caps = null;
      return { ok: false, error: errorText(r.status, r.code) };
    }
    const d = r.data;
    const userCode = typeof d.userCode === "string" ? d.userCode.toUpperCase() : "";
    if (!USER_CODE_RE.test(userCode) || typeof d.deviceToken !== "string" || !DEVICE_TOKEN_RE.test(d.deviceToken)) return { ok: false, error: "Tudumm sent a link code the extension didn't recognise." };
    const expiresIn = Number.isFinite(d.expiresIn) ? Math.min(Math.max(d.expiresIn, 60), 1800) : 600;
    const interval = Number.isFinite(d.interval) ? Math.min(Math.max(d.interval, 2), 30) : 5;
    const verifyUrl = safeVerifyUrl(d.verifyUrl, origin, userCode);
    const state = { status: "pending", userCode, verifyUrl, expiresAt: now() + expiresIn * 1000, interval, origin, startedAt: now() };
    await withLinkLock(() => store.set("session", { [KEYS.linkDevice]: { deviceToken: d.deviceToken, origin }, [KEYS.linkState]: state }));
    await store.remove("local", KEYS.account); // clears an old "link ended" notice
    try {
      await openTab(verifyUrl);
    } catch {
      /* the UI offers "Open approval page" again */
    }
    pollLoop();
    return { ok: true, userCode, verifyUrl, expiresAt: state.expiresAt };
  }

  async function cancelLink() {
    await withLinkLock(() => store.remove("session", [KEYS.linkDevice, KEYS.linkState]));
    return { ok: true };
  }

  /**
   * Link-state transitions run one at a time. Polls can overlap (pollLoop plus an
   * explicit poll), and the loser of a race gets 410 for a token the winner already
   * claimed: it must not overwrite the finished link with "expired".
   */
  let linkLock = Promise.resolve();
  function withLinkLock(fn) {
    const run = linkLock.then(fn, fn);
    linkLock = run.catch(() => {});
    return run;
  }

  /** End the link attempt for `deviceToken`, unless it was already claimed, cancelled or replaced. */
  function endLinkState(deviceToken, status, error = null) {
    return withLinkLock(async () => {
      const cur = await get1("session", KEYS.linkDevice);
      if (!cur || cur.deviceToken !== deviceToken) return false;
      await store.remove("session", KEYS.linkDevice);
      await store.set("session", { [KEYS.linkState]: { status, error } });
      return true;
    });
  }

  /** One poll. → "pending" | "approved" | "expired" | "error" | "none" */
  async function pollOnce() {
    const s = await store.get("session", [KEYS.linkDevice, KEYS.linkState]);
    const dev = s[KEYS.linkDevice];
    const st = s[KEYS.linkState];
    if (!dev || !st || st.status !== "pending") return "none";
    const origin = await currentOrigin();
    if (dev.origin !== origin) {
      return (await endLinkState(dev.deviceToken, "error", "The web app URL changed while linking. Start again.")) ? "error" : "none";
    }
    if (now() > st.expiresAt) {
      return (await endLinkState(dev.deviceToken, "expired")) ? "expired" : "none";
    }
    const r = await request(origin, "/api/v1/ext/link/poll", { method: "POST", body: { deviceToken: dev.deviceToken } });
    const d = r.data || {};
    if (r.ok && d.status === "approved") {
      if (typeof d.token !== "string" || !TOKEN_RE.test(d.token)) {
        return (await endLinkState(dev.deviceToken, "error", "Tudumm approved the link but sent a key the extension didn't recognise. Start again.")) ? "error" : "none";
      }
      // The token is claimed (single use): store it and forget the device token and link state.
      await withLinkLock(async () => {
        await store.set("local", {
          [KEYS.auth]: {
            token: d.token,
            origin,
            sessionId: typeof d.sessionId === "string" && UUIDISH_RE.test(d.sessionId) ? d.sessionId : null,
            expiresAt: typeof d.expiresAt === "string" ? d.expiresAt.slice(0, 40) : null,
            linkedAt: now(),
          },
        });
        await store.remove("session", [KEYS.linkDevice, KEYS.linkState]);
      });
      await refresh({ force: true, firstSync: true });
      return "approved";
    }
    if (r.ok) return "pending";
    if (r.status === 410 || r.status === 404) {
      return (await endLinkState(dev.deviceToken, "expired")) ? "expired" : "none";
    }
    if (r.status === 503 || r.status === 400) {
      return (await endLinkState(dev.deviceToken, "error", errorText(r.status, r.code))) ? "error" : "none";
    }
    return r.status === 429 ? "slow" : "pending"; // network blips and 5xx: keep waiting until expiry
  }

  /** Polls until the link is approved, expires or is cancelled. Safe to call repeatedly. */
  async function pollLoop() {
    if (polling) return;
    polling = true;
    try {
      let wait = null;
      for (;;) {
        const st = await get1("session", KEYS.linkState);
        if (!st || st.status !== "pending") break;
        await sleep((wait ?? st.interval ?? 5) * 1000);
        const res = await pollOnce();
        if (res !== "pending" && res !== "slow") break;
        wait = res === "slow" ? Math.min((st.interval || 5) * 2, 30) : null;
      }
    } finally {
      polling = false;
    }
  }

  /** Pull /me, /watchlist and /tracked. On the first sync, local stars are merged up (union). */
  async function refresh({ force = false, firstSync = false } = {}) {
    const auth = await get1("local", KEYS.auth);
    if (!auth) return { ok: false, error: "Not linked." };
    if (!force && now() - lastSync < SYNC_TTL_MS) return { ok: true, cached: true };
    lastSync = now();
    const me = await authedFetch("/api/v1/me");
    if (!me.ok) return { ok: false, error: errorText(me.status, me.code) };
    let wl = await authedFetch("/api/v1/watchlist");
    if (firstSync && wl.ok) {
      const local = sanitizeSymbols(await get1("local", KEYS.watchlist));
      const server = sanitizeSymbols(wl.data && wl.data.symbols);
      const extra = local.filter((s) => !server.includes(s));
      if (extra.length) {
        const put = await authedFetch("/api/v1/watchlist", { method: "PUT", body: { symbols: [...server, ...extra].slice(0, 200) } });
        if (put.ok) wl = put;
      }
    }
    const tr = await authedFetch("/api/v1/tracked");
    const u = (me.data && me.data.user) || {};
    const p = (me.data && me.data.plan) || {};
    const counts = (me.data && me.data.counts) || {};
    const patch = {
      [KEYS.account]: {
        linked: true,
        origin: auth.origin,
        user: { email: typeof u.email === "string" ? u.email.slice(0, 120) : null, displayName: typeof u.displayName === "string" ? u.displayName.slice(0, 60) : null },
        plan: { id: typeof p.id === "string" ? p.id.slice(0, 16) : "free", name: typeof p.name === "string" ? p.name.slice(0, 30) : null },
        counts: { watchlist: Number(counts.watchlist) || 0, tracked: Number(counts.tracked) || 0, alerts: Number(counts.alerts) || 0, unread: Number(counts.unread) || 0 },
        syncedAt: now(),
      },
    };
    if (wl.ok && wl.data) patch[KEYS.watchlist] = sanitizeSymbols(wl.data.symbols);
    if (tr.ok && tr.data) patch[KEYS.tracked] = sanitizeTracked(tr.data.items);
    await store.set("local", patch);
    return { ok: true };
  }

  /** Star toggle: local first (optimistic), then the server; rolled back if the server refuses. */
  async function setWatch(symbol, on) {
    if (typeof symbol !== "string" || !SYMBOL_RE.test(symbol)) return { ok: false, error: "Bad symbol." };
    const before = sanitizeSymbols(await get1("local", KEYS.watchlist));
    const next = on ? (before.includes(symbol) ? before : [...before, symbol]) : before.filter((s) => s !== symbol);
    await store.set("local", { [KEYS.watchlist]: next });
    const auth = await get1("local", KEYS.auth);
    const origin = await currentOrigin();
    if (!auth || auth.origin !== origin) return { ok: true, on, synced: false, watchlist: next };
    const r = await authedFetch(`/api/v1/watchlist/${encodeURIComponent(symbol)}`, on ? { method: "POST", body: {} } : { method: "DELETE" });
    if (r.ok && r.data && Array.isArray(r.data.symbols)) {
      const server = sanitizeSymbols(r.data.symbols);
      await store.set("local", { [KEYS.watchlist]: server });
      return { ok: true, on: server.includes(symbol), synced: true, watchlist: server };
    }
    if (r.status === 401) return { ok: true, on, synced: false, watchlist: next, error: errorText(401) };
    await store.set("local", { [KEYS.watchlist]: before });
    return { ok: false, on: before.includes(symbol), synced: false, watchlist: before, error: errorText(r.status, r.code) };
  }

  /** Empty the watchlist here and, when linked, on the server (PUT []). */
  async function clearWatch() {
    const before = sanitizeSymbols(await get1("local", KEYS.watchlist));
    await store.set("local", { [KEYS.watchlist]: [] });
    const auth = await get1("local", KEYS.auth);
    const origin = await currentOrigin();
    if (!auth || auth.origin !== origin) return { ok: true, synced: false };
    const r = await authedFetch("/api/v1/watchlist", { method: "PUT", body: { symbols: [] } });
    if (r.ok) return { ok: true, synced: true };
    if (r.status === 401) return { ok: true, synced: false, error: errorText(401) };
    await store.set("local", { [KEYS.watchlist]: before });
    return { ok: false, synced: false, error: errorText(r.status, r.code) };
  }

  /** Revoke the extension session on the server (when we may), then forget it locally either way. */
  async function unlink() {
    const auth = await get1("local", KEYS.auth);
    if (!auth) {
      await store.remove("local", [KEYS.account, KEYS.tracked]);
      return { ok: true, revoked: false };
    }
    const origin = await currentOrigin();
    let revoked = false;
    let error = null;
    if (origin && auth.origin === origin) {
      const r = await authedFetch("/api/v1/auth/logout", { method: "POST", body: {} });
      revoked = r.ok || r.status === 401;
      if (!revoked) error = `${errorText(r.status, r.code)} The key was removed from this browser; revoke it under Account → Devices on the website to be sure.`;
    } else {
      error = `This browser was linked on ${auth.origin}, but the web app URL now points elsewhere, so the key was only removed locally. Revoke it under Account → Devices on ${auth.origin}.`;
    }
    await store.remove("local", [KEYS.auth, KEYS.account, KEYS.tracked]);
    await store.remove("session", [KEYS.linkDevice, KEYS.linkState]);
    lastSync = 0;
    return { ok: true, revoked, error };
  }

  return { status, capabilities, startLink, cancelLink, pollOnce, pollLoop, refresh, setWatch, clearWatch, unlink, authedFetch, _request: request };
}
