// v0.2 account linking (device code), token custody, watchlist sync, unlink,
// and the message protocol's page-only allowlist.
// Run: node extension/tests/account.test.mjs
import { check, done, section } from "./harness.mjs";
import { createAccountService, safeVerifyUrl, errorText, KEYS } from "../lib/account.js";
import { validateMessage, senderKind, allowedFrom, PAGE_ONLY_TYPES, CONTENT_TYPES } from "../lib/protocol.js";

const ORIGIN = "https://tudumm.in";
const TOKEN = "tok_" + "A".repeat(40);
const DEVICE = "D".repeat(43);

/** In-memory chrome.storage over "local" and "session". */
function memStore() {
  const areas = { local: {}, session: {} };
  return {
    areas,
    get: async (area, keys) => {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => k in areas[area]).map((k) => [k, structuredClone(areas[area][k])]));
    },
    set: async (area, obj) => Object.assign(areas[area], structuredClone(obj)),
    remove: async (area, keys) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete areas[area][k];
    },
  };
}

/** A fake Tudumm API: records every request (url, method, headers, body). */
function fakeServer() {
  const calls = [];
  const state = { approved: false, consumed: false, revoked: false, watchlist: ["AAPL"], linking: true, watchFull: false };
  const res = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: u.href, origin: u.origin, path: u.pathname, method: init.method || "GET", headers, body, init });
    if (u.origin !== ORIGIN) return res({ error: "wrong_host" }, 500);
    const authed = headers.authorization === `Bearer ${TOKEN}` && !state.revoked;
    const p = u.pathname;
    if (p === "/api/v1/config") return res({ capabilities: { extensionLinking: state.linking, liveData: true } });
    if (p === "/api/v1/ext/link/start") return state.linking ? res({ userCode: "ABCD-EF23", deviceToken: DEVICE, verifyUrl: `${ORIGIN}/app/link?code=ABCD-EF23`, expiresIn: 600, interval: 5 }) : res({ error: "extension_linking_disabled" }, 503);
    if (p === "/api/v1/ext/link/poll") {
      if (body.deviceToken !== DEVICE) return res({ error: "unknown_device" }, 404);
      if (!state.approved) return res({ status: "pending", interval: 5 });
      if (state.consumed) return res({ status: "consumed" }, 410);
      state.consumed = true;
      return res({ status: "approved", token: TOKEN, tokenType: "Bearer", sessionId: "11111111-2222-3333-4444-555555555555", expiresAt: "2027-05-01T00:00:00.000Z" });
    }
    if (!authed) return res({ error: "unauthorized" }, 401);
    if (p === "/api/v1/me") return res({ user: { email: "trader@example.com", displayName: null }, plan: { id: "free", name: "Free" }, counts: { watchlist: state.watchlist.length } });
    if (p === "/api/v1/tracked") return res({ items: [{ symbol: "BTCUSDT", signalId: null }] });
    if (p === "/api/v1/watchlist" && (init.method || "GET") === "GET") return res({ symbols: state.watchlist });
    if (p === "/api/v1/watchlist" && init.method === "PUT") {
      state.watchlist = body.symbols;
      return res({ symbols: state.watchlist });
    }
    const m = p.match(/^\/api\/v1\/watchlist\/([A-Z0-9]+)$/);
    if (m && init.method === "POST") {
      if (state.watchFull) return res({ error: "limit_reached", limit: 200 }, 409);
      if (!state.watchlist.includes(m[1])) state.watchlist.push(m[1]);
      return res({ symbols: state.watchlist });
    }
    if (m && init.method === "DELETE") {
      state.watchlist = state.watchlist.filter((s) => s !== m[1]);
      return res({ symbols: state.watchlist });
    }
    if (p === "/api/v1/auth/logout") {
      state.revoked = true;
      return res({ ok: true });
    }
    return res({ error: "not_found" }, 404);
  }
  return { calls, state, fetchImpl };
}

function setup({ webUrl = ORIGIN } = {}) {
  const server = fakeServer();
  const store = memStore();
  const settings = { webUrl };
  const opened = [];
  let t = 1_000_000;
  const svc = createAccountService({ fetchImpl: server.fetchImpl, store, getSettings: async () => settings, now: () => t, sleep: async () => {}, openTab: (u) => opened.push(u) });
  return { server, store, settings, opened, svc, tick: (ms) => (t += ms) };
}

section("verify URL safety");
check("same-origin verifyUrl kept", safeVerifyUrl(`${ORIGIN}/app/link?code=ABCD-EF23`, ORIGIN, "ABCD-EF23") === `${ORIGIN}/app/link?code=ABCD-EF23`);
check("foreign verifyUrl replaced", safeVerifyUrl("https://evil.example/app/link", ORIGIN, "ABCD-EF23") === `${ORIGIN}/app/link?code=ABCD-EF23`);
check("javascript: verifyUrl replaced", safeVerifyUrl("javascript:alert(1)", ORIGIN, "ABCD-EF23").startsWith(ORIGIN));
check("http verifyUrl to a public host replaced", safeVerifyUrl("http://tudumm.in/app/link", ORIGIN, "X").startsWith(ORIGIN + "/"));
check("429 says slow down", /Slow down/.test(errorText(429)));

section("device-code linking");
{
  const { server, store, svc, opened, settings } = setup();
  const st0 = await svc.status();
  check("unlinked status advertises the capability", st0.linked === false && st0.capabilities.extensionLinking === true);
  const r = await svc.startLink();
  check("start returns the user code", r.ok && r.userCode === "ABCD-EF23");
  check("approval page opened on the web app", opened.length === 1 && opened[0] === `${ORIGIN}/app/link?code=ABCD-EF23`);
  check("device token kept in session storage only", store.areas.session[KEYS.linkDevice]?.deviceToken === DEVICE && !JSON.stringify(store.areas.local).includes(DEVICE));
  const pend = await svc.status();
  check("status shows pending code, never the device token", pend.link.status === "pending" && pend.link.userCode === "ABCD-EF23" && !JSON.stringify(pend).includes(DEVICE));
  check("poll while pending", (await svc.pollOnce()) === "pending");
  server.state.approved = true;
  check("poll after approval → approved", (await svc.pollOnce()) === "approved");
  check("token stored in local storage, bound to its origin", store.areas.local[KEYS.auth]?.token === TOKEN && store.areas.local[KEYS.auth]?.origin === ORIGIN);
  check("device token forgotten once claimed", !store.areas.session[KEYS.linkDevice] && !store.areas.session[KEYS.linkState]);
  const st = await svc.status();
  check("linked status has the account, never the token", st.linked && st.user.email === "trader@example.com" && !JSON.stringify(st).includes(TOKEN));
  check("first sync merges local stars up (union)", server.state.watchlist.includes("AAPL"));
  check("tracked pulled from the account", store.areas.local[KEYS.tracked]?.[0]?.symbol === "BTCUSDT");
  const authCalls = server.calls.filter((c) => c.headers.authorization);
  check("Bearer only ever sent to the web app origin", authCalls.length > 0 && authCalls.every((c) => c.origin === ORIGIN));
  check("no cookies, no redirects followed, no referrer", server.calls.every((c) => c.init.credentials === "omit" && c.init.redirect === "error" && c.init.referrerPolicy === "no-referrer"));
  check("link start/poll carry no Authorization", server.calls.filter((c) => /ext\/link/.test(c.path)).every((c) => !c.headers.authorization));

  section("watchlist sync");
  const add = await svc.setWatch("NVDA", true);
  check("star → POST /watchlist/NVDA and synced", add.ok && add.synced && server.state.watchlist.includes("NVDA") && server.calls.at(-1).method === "POST");
  server.state.watchlist.push("ETHUSDT"); // added on the website
  const del = await svc.setWatch("NVDA", false);
  check("unstar → DELETE and server list adopted (two-way)", del.ok && !server.state.watchlist.includes("NVDA") && store.areas.local[KEYS.watchlist].includes("ETHUSDT"));
  server.state.watchFull = true;
  const before = [...store.areas.local[KEYS.watchlist]];
  const full = await svc.setWatch("TSLA", true);
  check("server refusal rolls the star back", full.ok === false && /full/.test(full.error) && JSON.stringify(store.areas.local[KEYS.watchlist]) === JSON.stringify(before));
  server.state.watchFull = false;
  check("bad symbol refused before any request", (await svc.setWatch("<x>", true)).ok === false);
  const cleared = await svc.clearWatch();
  check("clear empties the account list too", cleared.ok && cleared.synced && server.state.watchlist.length === 0);

  section("origin binding");
  settings.webUrl = "https://evil.example";
  const n = server.calls.length;
  const moved = await svc.status();
  check("web URL changed → origin mismatch shown", moved.originMismatch === true);
  const w = await svc.setWatch("AAPL", true);
  check("no token sent after the web URL moved", w.synced === false && server.calls.slice(n).every((c) => !c.headers.authorization));
  const ref = await svc.refresh({ force: true });
  check("refresh refuses on a foreign origin", ref.ok === false && server.calls.slice(n).every((c) => !c.headers.authorization));
  const un1 = await svc.unlink();
  check("unlink on a foreign origin removes locally and says to revoke on the site", un1.ok && un1.revoked === false && /Revoke it/.test(un1.error) && !store.areas.local[KEYS.auth]);
  check("still nothing sent with a token", server.calls.slice(n).every((c) => !c.headers.authorization));
}

section("unlink & revocation");
{
  const { server, store, svc } = setup();
  await svc.startLink();
  server.state.approved = true;
  await svc.pollOnce();
  const un = await svc.unlink();
  check("unlink calls POST /auth/logout with the token", server.calls.some((c) => c.path === "/api/v1/auth/logout" && c.method === "POST" && c.headers.authorization === `Bearer ${TOKEN}`));
  check("unlink revokes and clears local storage", un.ok && un.revoked && !store.areas.local[KEYS.auth] && !store.areas.local[KEYS.account]);
  check("status after unlink", (await svc.status()).linked === false);
}
{
  const { server, store, svc } = setup();
  await svc.startLink();
  server.state.approved = true;
  await svc.pollOnce();
  server.state.revoked = true; // revoked from Account → Devices on the website
  await svc.refresh({ force: true });
  const st = await svc.status();
  check("401 drops the link and explains it", st.linked === false && /revoked or expired/.test(st.notice) && !store.areas.local[KEYS.auth]);
}
{
  const { server, svc, tick } = setup();
  await svc.startLink();
  tick(11 * 60_000);
  check("unapproved code expires", (await svc.pollOnce()) === "expired" && (await svc.status()).link.status === "expired");
  server.state.linking = false;
  const off = await svc.status({ refreshCaps: true });
  check("capability off → explained, no link button state", off.capabilities.extensionLinking === false && typeof off.capabilities.reason === "string");
  const st = await svc.startLink();
  check("start while disabled → honest error", st.ok === false && /switched off/.test(st.error));
}
{
  const { svc } = setup();
  await svc.startLink();
  await svc.cancelLink();
  check("cancel clears the pending link", (await svc.status()).link === null);
}

section("protocol allowlist");
const RID = "abcdefghijklmnopabcdefghijklmnop";
const BASE = `chrome-extension://${RID}/`;
check("extension page sender → page", senderKind({ id: RID, url: `${BASE}popup.html` }, RID, BASE) === "page");
check("content script sender → content", senderKind({ id: RID, url: "https://www.tradingview.com/chart/", tab: { id: 3 } }, RID, BASE) === "content");
check("other extension → ignored", senderKind({ id: "zzz", url: `${BASE}popup.html` }, RID, BASE) === null);
check("http page tab → ignored", senderKind({ id: RID, url: "http://example.com/", tab: { id: 1 } }, RID, BASE) === null);
check("content scripts can't touch the account or data", PAGE_ONLY_TYPES.every((t) => !allowedFrom("content", t)));
check("content scripts keep the chip messages", CONTENT_TYPES.every((t) => allowedFrom("content", t)));
check("pages may send every type", [...PAGE_ONLY_TYPES, ...CONTENT_TYPES].every((t) => allowedFrom("page", t)));
check("unknown sender may send nothing", !allowedFrom(null, "snapshot"));
check("linkStart validates", validateMessage({ type: "linkStart" })?.type === "linkStart");
check("extra keys rejected", validateMessage({ type: "linkStart", token: "x" }) === null && validateMessage({ type: "unlink", url: "https://x" }) === null);
check("watchSet needs a symbol and boolean", validateMessage({ type: "watchSet", symbol: "BTCUSDT", on: true })?.on === true && validateMessage({ type: "watchSet", symbol: "btc", on: true }) === null && validateMessage({ type: "watchSet", symbol: "BTCUSDT", on: "yes" }) === null);
check("watchClear validates", validateMessage({ type: "watchClear" })?.type === "watchClear");
check("universe force must be boolean", validateMessage({ type: "universe", force: "1" }) === null && validateMessage({ type: "universe" })?.force === false);
check("unknown type rejected", validateMessage({ type: "getToken" }) === null && validateMessage({ type: "__proto__" }) === null);

await done(import.meta.url);
