// Backend-core integration tests against `wrangler dev --local` with FRESH local D1 databases.
//
//   node --test worker/test/core.test.mjs          (or: npm run test:core)
//
// The harness starts two isolated Workers (each with its own --persist-to dir and migrations):
//   :8787  production vars from wrangler.jsonc + `--var ADMIN_PASSWORD:test`
//   :8788  production vars, NO admin password, Turnstile secret = Cloudflare's always-fail test key
// It writes a temporary wrangler config (no build step, empty assets dir) so tests never rebuild
// the web app. Set TUDUMM_KEEP_STATE=1 to keep the temp dirs for inspection.
// Rate-limit buckets are keyed by an IP hash; miniflare honours a client-sent CF-Connecting-IP
// (Cloudflare's edge overwrites it in production), so each scenario uses its own fake IP.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT_A = Number(process.env.TUDUMM_TEST_PORT_A ?? 8787);
const PORT_B = Number(process.env.TUDUMM_TEST_PORT_B ?? 8788);
const EXT_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const TURNSTILE_ALWAYS_FAIL = "2x0000000000000000000000000000000AA";

/* ======================= harness ======================= */

function stripJsonc(text) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const nx = text[i + 1];
    if (inStr) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === "/" && nx === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && nx === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(base, proc, logRef, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (proc.exitCode !== null) throw new Error(`wrangler dev exited early:\n${logRef.text.slice(-3000)}`);
    try {
      const r = await fetch(`${base}/api/v1/health`);
      if (r.status === 200) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`wrangler dev did not become healthy:\n${logRef.text.slice(-3000)}`);
}

let detectedCompat = null;

async function startWorker({ name, port, vars = {}, cliVars = {} }) {
  const dir = mkdtempSync(join(tmpdir(), `tudumm-core-${name}-`));
  const pub = join(dir, "public");
  const persist = join(dir, "state");
  mkdirSync(pub);
  writeFileSync(join(pub, "index.html"), "<!doctype html><title>Tudumm test</title>");
  const base = JSON.parse(stripJsonc(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8")));
  const cfgFor = (compat) => ({
    name: `${base.name}-core-test-${name}`,
    main: join(ROOT, base.main),
    compatibility_date: compat,
    assets: { directory: pub, binding: "ASSETS", run_worker_first: true },
    d1_databases: base.d1_databases.map((d) => ({ ...d, database_id: `local-${name}`, migrations_dir: join(ROOT, d.migrations_dir) })),
    vars: { ...base.vars, ...vars },
  });
  const cfgPath = join(dir, "wrangler.json");
  const env = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" };
  let compat = process.env.TUDUMM_TEST_COMPAT_DATE ?? detectedCompat ?? base.compatibility_date;

  for (let attempt = 0; attempt < 2; attempt++) {
    writeFileSync(cfgPath, JSON.stringify(cfgFor(compat), null, 2));
    if (attempt === 0) {
      execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "tudumm-db", "--local", "--persist-to", persist, "-c", cfgPath], {
        cwd: ROOT,
        env,
        stdio: "pipe",
      });
    }
    // --inspector-port 0: ephemeral devtools port, so two workers never clash on 9229.
    const args = ["wrangler", "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0", "-c", cfgPath, "--persist-to", persist, "--show-interactive-dev-session=false", "--log-level", "warn"];
    for (const [k, v] of Object.entries(cliVars)) args.push("--var", `${k}:${v}`);
    const proc = spawn("npx", args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    SPAWNED.add(proc);
    const logRef = { text: "" };
    proc.stdout.on("data", (d) => (logRef.text += d));
    proc.stderr.on("data", (d) => (logRef.text += d));
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await waitHealthy(baseUrl, proc, logRef);
      return { name, baseUrl, proc, dir, persist, logRef, compat };
    } catch (err) {
      // Older local workerd binaries can't run a newer compatibility_date: retry with the newest supported one.
      const m = /newest date supported by this server binary is "(\d{4}-\d{2}-\d{2})"/.exec(logRef.text);
      kill(proc);
      if (m && attempt === 0) {
        compat = m[1];
        detectedCompat = m[1];
        await sleep(500);
        continue;
      }
      throw err;
    }
  }
  throw new Error("unreachable");
}

const SPAWNED = new Set();
process.on("exit", () => {
  for (const p of SPAWNED) kill(p);
});

function kill(proc) {
  SPAWNED.delete(proc);
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* gone */
    }
  }
}

async function stopWorker(w) {
  if (!w) return;
  kill(w.proc);
  await sleep(300);
  if (!process.env.TUDUMM_KEEP_STATE) rmSync(w.dir, { recursive: true, force: true });
}

/** Direct access to the worker's local D1 sqlite file (used only to fast-forward OTP expiry). */
function sqliteOf(w) {
  const d = join(w.persist, "v3", "d1", "miniflare-D1DatabaseObject");
  const f = readdirSync(d).find((x) => x.endsWith(".sqlite") && x !== "metadata.sqlite");
  return new DatabaseSync(join(d, f));
}

/* ======================= http client ======================= */

class Client {
  constructor(w, { ip = "203.0.113.1", origin } = {}) {
    this.w = w;
    this.base = w.baseUrl;
    this.ip = ip;
    this.origin = origin === undefined ? w.baseUrl : origin;
    this.jar = new Map();
    this.bearer = null;
  }
  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  async req(method, path, opts = {}) {
    const headers = { "cf-connecting-ip": this.ip, ...(opts.headers ?? {}) };
    const origin = opts.origin === undefined ? this.origin : opts.origin;
    if (origin && method !== "GET") headers.origin = origin;
    if (opts.origin && method === "GET") headers.origin = opts.origin;
    if (this.jar.size && !opts.noCookies) headers.cookie = this.cookieHeader();
    if (this.bearer && !opts.noBearer) headers.authorization = `Bearer ${this.bearer}`;
    let body;
    if (opts.body !== undefined) {
      body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
      headers["content-type"] = opts.contentType ?? "application/json";
    } else if (method !== "GET" && method !== "DELETE" && opts.contentType !== null) {
      body = "{}";
      headers["content-type"] = opts.contentType ?? "application/json";
    }
    const res = await fetch(this.base + path, { method, headers, body, redirect: "manual" });
    const setCookies = res.headers.getSetCookie();
    for (const sc of setCookies) {
      const [pair] = sc.split(";");
      const i = pair.indexOf("=");
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      if (/max-age=0/i.test(sc) || v === "") this.jar.delete(k);
      else this.jar.set(k, v);
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, headers: res.headers, json, text, setCookies };
  }
  get(p, o) {
    return this.req("GET", p, o);
  }
  post(p, body, o = {}) {
    return this.req("POST", p, { ...o, body });
  }
  put(p, body, o = {}) {
    return this.req("PUT", p, { ...o, body });
  }
  patch(p, body, o = {}) {
    return this.req("PATCH", p, { ...o, body });
  }
  del(p, body, o = {}) {
    return this.req("DELETE", p, { ...o, body });
  }
}

let ipSeq = 10;
const freshIp = () => `198.51.100.${ipSeq++}`;
let mailSeq = 0;
const freshEmail = (tag) => `${tag}.${Date.now().toString(36)}.${mailSeq++}@example.com`;

async function login(w, email, ip = freshIp()) {
  const c = new Client(w, { ip });
  const s = await c.post("/api/v1/auth/start", { email });
  assert.equal(s.status, 200, `auth/start ${s.text}`);
  const v = await c.post("/api/v1/auth/verify", { email, code: s.json.devCode });
  assert.equal(v.status, 200, `auth/verify ${v.text}`);
  c.user = v.json.user;
  return c;
}

/* ======================= tests ======================= */

let A; // admin-enabled worker
let B; // no admin password, turnstile always-fail
const st = {}; // state shared across ordered tests

before(async () => {
  A = await startWorker({ name: "a", port: PORT_A, cliVars: { ADMIN_PASSWORD: "test" } });
  B = await startWorker({ name: "b", port: PORT_B, cliVars: { TURNSTILE_SECRET: TURNSTILE_ALWAYS_FAIL } });
});

after(async () => {
  await Promise.all([stopWorker(A), stopWorker(B)]);
  for (const p of SPAWNED) kill(p);
});

describe("config + health", () => {
  test("health reports db ok", async () => {
    const r = await new Client(A).get("/api/v1/health");
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.db, "ok");
  });

  test("config reports capabilities honestly (no secrets except the admin password)", async () => {
    const r = await new Client(A).get("/api/v1/config");
    assert.equal(r.status, 200);
    const cap = r.json.capabilities;
    assert.equal(cap.devCodes, true);
    assert.equal(cap.emailDelivery, false);
    assert.equal(cap.googleSignIn, false);
    assert.equal(cap.payments, false);
    assert.equal(cap.turnstile, false, "site key alone (no secret) must not enable turnstile");
    assert.equal(cap.adminConfigured, true);
    assert.equal(r.json.turnstileSiteKey, null);
    assert.equal(r.json.plans.length, 3);
    assert.ok(r.json.legal.termsVersion);
    assert.equal(r.json.flags.signups, true);
    assert.equal(r.json.flags.require_signal_approval, undefined, "internal flags are not public");
    assert.deepEqual(r.json.engine, { version: "v0", calibrated: false });
  });

  test("API responses carry security headers", async () => {
    const r = await new Client(A).get("/api/v1/me");
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.ok(r.headers.get("content-security-policy"));
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("access-control-allow-origin"), null);
  });

  test("unknown route 404, wrong method 405", async () => {
    const c = new Client(A);
    assert.equal((await c.get("/api/v1/nope")).status, 404);
    assert.equal((await c.get("/api/v1/auth/start")).status, 405);
  });
});

describe("auth (dev-code mode)", () => {
  test("happy path: code on screen, __Host- session cookie with the right flags", async () => {
    const email = freshEmail("alice");
    const c = new Client(A, { ip: freshIp() });
    const s = await c.post("/api/v1/auth/start", { email: email.toUpperCase() });
    assert.equal(s.status, 200);
    assert.equal(s.json.sent, false);
    assert.equal(s.json.devMode, true);
    assert.match(s.json.devCode, /^\d{6}$/);
    assert.match(s.json.notice, /UAT mode/);

    const v = await c.post("/api/v1/auth/verify", { email, code: s.json.devCode });
    assert.equal(v.status, 200, v.text);
    assert.equal(v.json.isNew, true);
    assert.equal(v.json.profile, null);
    assert.equal(v.json.user.email, email, "email is lowercased");
    assert.equal(v.json.user.emailVerified, false, "dev-code logins never verify the email");
    const ck = v.setCookies.find((x) => x.startsWith("__Host-tdm_s="));
    assert.ok(ck, "session cookie set");
    for (const flag of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/"]) assert.ok(ck.includes(flag), `cookie has ${flag}: ${ck}`);
    assert.ok(!/domain=/i.test(ck), "__Host- cookies have no Domain");

    const me = await c.get("/api/v1/me");
    assert.equal(me.status, 200);
    assert.equal(me.json.user.email, email);
    assert.equal(me.json.plan.id, "free");
    assert.deepEqual(me.json.counts, { watchlist: 0, tracked: 0, alerts: 0, unread: 0 });
    assert.equal(me.json.pendingConsents.length, 3);

    // The same code is single-use.
    const again = await new Client(A, { ip: freshIp() }).post("/api/v1/auth/verify", { email, code: s.json.devCode });
    assert.equal(again.status, 400);
    assert.equal(again.json.error, "invalid_code");
    c.user = v.json.user;
    st.alice = c;
    st.aliceEmail = email;
  });

  test("no account enumeration: auth/start answers identically for existing and new emails", async () => {
    const c = new Client(A, { ip: freshIp() });
    const existing = await c.post("/api/v1/auth/start", { email: st.aliceEmail });
    const fresh = await c.post("/api/v1/auth/start", { email: freshEmail("nobody") });
    assert.equal(existing.status, fresh.status);
    assert.deepEqual(Object.keys(existing.json).sort(), Object.keys(fresh.json).sort());
    assert.equal(existing.json.notice, fresh.json.notice);
  });

  test("invalid email is rejected", async () => {
    const r = await new Client(A, { ip: freshIp() }).post("/api/v1/auth/start", { email: "not-an-email" });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "invalid_input");
  });

  test("OTP: at most 5 attempts per code", async () => {
    const email = freshEmail("brute");
    const c = new Client(A, { ip: freshIp() });
    const s = await c.post("/api/v1/auth/start", { email });
    const wrong = s.json.devCode === "000000" ? "111111" : "000000";
    const left = [];
    for (let i = 0; i < 5; i++) {
      const r = await c.post("/api/v1/auth/verify", { email, code: wrong });
      assert.equal(r.status, 400);
      assert.equal(r.json.error, "invalid_code");
      left.push(r.json.attemptsLeft);
    }
    assert.deepEqual(left, [4, 3, 2, 1, 0]);
    const right = await c.post("/api/v1/auth/verify", { email, code: s.json.devCode });
    assert.equal(right.status, 400, "the correct code is dead after 5 failures");
    assert.equal(right.json.error, "invalid_code");
  });

  test("OTP: codes expire after 10 minutes", async () => {
    const email = freshEmail("late");
    const c = new Client(A, { ip: freshIp() });
    const s = await c.post("/api/v1/auth/start", { email });
    const db = sqliteOf(A);
    try {
      // Fast-forward: this code (the newest unconsumed one) was issued 11 minutes ago.
      db.prepare("UPDATE otp_codes SET expires_at = ? WHERE id = (SELECT id FROM otp_codes WHERE consumed_at IS NULL ORDER BY created_at DESC LIMIT 1)").run(
        new Date(Date.now() - 60_000).toISOString(),
      );
    } finally {
      db.close();
    }
    const v = await c.post("/api/v1/auth/verify", { email, code: s.json.devCode });
    assert.equal(v.status, 400);
    assert.equal(v.json.error, "code_expired");
  });

  test("OTP and session tokens are stored only as hashes; no raw IP is stored", async () => {
    const db = sqliteOf(A);
    try {
      const otp = db.prepare("SELECT * FROM otp_codes LIMIT 5").all();
      assert.ok(otp.length > 0);
      for (const r of otp) {
        assert.match(r.code_hash, /^[0-9a-f]{64}$/);
        assert.match(r.email_hash, /^[0-9a-f]{64}$/);
        assert.match(r.ip_hash, /^[0-9a-f]{64}$/);
        assert.ok(!("email" in r) && !("code" in r));
      }
      const s = db.prepare("SELECT token_hash FROM sessions LIMIT 5").all();
      for (const r of s) assert.match(r.token_hash, /^[0-9a-f]{64}$/);
      const anyIp = db.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE '%198.51.100.%'").get();
      assert.equal(anyIp.n, 0, "rate-limit keys contain hashes, never IPs");
    } finally {
      db.close();
    }
  });

  test("rate limit: 6th auth/start for the same email within 15 min is 429", async () => {
    const email = freshEmail("spam");
    const c = new Client(A, { ip: freshIp() });
    for (let i = 0; i < 5; i++) assert.equal((await c.post("/api/v1/auth/start", { email })).status, 200);
    const r = await c.post("/api/v1/auth/start", { email });
    assert.equal(r.status, 429);
    assert.equal(r.json.error, "rate_limited");
    assert.ok(Number(r.headers.get("retry-after")) > 0);
  });

  test("logout revokes the session and clears the cookie", async () => {
    const c = await login(A, freshEmail("erin"));
    const token = c.jar.get("__Host-tdm_s");
    const r = await c.post("/api/v1/auth/logout", {});
    assert.equal(r.status, 200);
    assert.ok(r.setCookies.some((x) => x.startsWith("__Host-tdm_s=;") && /Max-Age=0/.test(x)));
    const stale = new Client(A, { ip: c.ip });
    stale.jar.set("__Host-tdm_s", token);
    assert.equal((await stale.get("/api/v1/me")).status, 401, "old token no longer works");
  });

  test("logout-all revokes every session of the user", async () => {
    const email = freshEmail("multi");
    const one = await login(A, email);
    const two = await login(A, email);
    assert.equal(two.user.id, one.user.id);
    const r = await one.post("/api/v1/auth/logout-all", {});
    assert.equal(r.status, 200);
    assert.ok(r.json.revoked >= 2);
    assert.equal((await two.get("/api/v1/me")).status, 401);
  });

  test("Google sign-in is capability-gated (503 without client id/secret)", async () => {
    const r = await new Client(A).get("/api/v1/auth/google/start");
    assert.equal(r.status, 503);
    assert.equal(r.json.error, "google_unavailable");
  });
});

describe("CSRF / origin policy", () => {
  test("cross-origin, missing-origin and non-JSON state changes are refused", async () => {
    const c = st.alice;
    const evil = await c.put("/api/v1/profile", { persona: "swing" }, { origin: "https://evil.example" });
    assert.equal(evil.status, 403);
    assert.equal(evil.json.error, "bad_origin");
    const none = await c.put("/api/v1/profile", { persona: "swing" }, { origin: null });
    assert.equal(none.status, 403, "missing Origin is refused for cookie auth");
    const form = await c.put("/api/v1/profile", "persona=swing", { contentType: "application/x-www-form-urlencoded" });
    assert.equal(form.status, 415);
    const textPlain = await c.post("/api/v1/watchlist/BTCUSDT", "{}", { contentType: "text/plain" });
    assert.equal(textPlain.status, 415);
    const xsite = await c.put("/api/v1/profile", { persona: "swing" }, { headers: { "sec-fetch-site": "cross-site" } });
    assert.equal(xsite.status, 403);
    const ok = await c.put("/api/v1/profile", { persona: "swing" });
    assert.equal(ok.status, 200, ok.text);
  });

  test("login CSRF: auth/start from another site is refused", async () => {
    const r = await new Client(A, { ip: freshIp(), origin: "https://evil.example" }).post("/api/v1/auth/start", { email: freshEmail("x") });
    assert.equal(r.status, 403);
  });

  test("CORS preflight only for chrome-extension origins on allowed routes, never credentialed", async () => {
    const c = new Client(A);
    const ok = await c.req("OPTIONS", "/api/v1/me", { origin: EXT_ORIGIN, contentType: null, headers: { origin: EXT_ORIGIN, "access-control-request-method": "GET" } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get("access-control-allow-origin"), EXT_ORIGIN);
    assert.equal(ok.headers.get("access-control-allow-credentials"), null);
    const bad = await c.req("OPTIONS", "/api/v1/me", { contentType: null, headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    assert.equal(bad.status, 403);
    const adm = await c.req("OPTIONS", "/api/admin/me", { contentType: null, headers: { origin: EXT_ORIGIN, "access-control-request-method": "GET" } });
    assert.equal(adm.status, 403, "no CORS on admin routes");
  });
});

describe("profile, watchlist, tracked, sync", () => {
  test("profile: validation + 'scalper' alias", async () => {
    const c = st.alice;
    const bad = await c.put("/api/v1/profile", { riskPct: 9 });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.field, "riskPct");
    const badMk = await c.put("/api/v1/profile", { markets: ["IN", "MARS"] });
    assert.equal(badMk.status, 400);
    const r = await c.put("/api/v1/profile", { persona: "scalper", markets: ["CRYPTO", "IN"], capital: 250000, currency: "USDT", riskPct: 0.5, onboarded: true });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(
      { ...r.json.profile, updatedAt: undefined },
      { persona: "intraday", markets: ["CRYPTO", "IN"], capital: 250000, currency: "USDT", riskPct: 0.5, onboarded: true, updatedAt: undefined },
    );
  });

  test("watchlist: full replace keeps order, add/remove, validation", async () => {
    const c = st.alice;
    assert.equal((await c.put("/api/v1/watchlist", { symbols: ["BTCUSDT", "bad sym!"] })).status, 400);
    const r = await c.put("/api/v1/watchlist", { symbols: ["nifty", "BTCUSDT", "AAPL", "BTCUSDT"] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.symbols, ["NIFTY", "BTCUSDT", "AAPL"]);
    assert.deepEqual((await c.post("/api/v1/watchlist/ETHUSDT")).json.symbols, ["NIFTY", "BTCUSDT", "AAPL", "ETHUSDT"]);
    assert.deepEqual((await c.del("/api/v1/watchlist/NIFTY")).json.symbols, ["BTCUSDT", "AAPL", "ETHUSDT"]);
    const tooMany = await c.put("/api/v1/watchlist", { symbols: Array.from({ length: 201 }, (_, i) => `S${i}`) });
    assert.equal(tooMany.status, 400);
  });

  test("tracked: symbol-level and signal-level items", async () => {
    const c = st.alice;
    const r = await c.put("/api/v1/tracked", { symbols: ["BTCUSDT", "NIFTY"] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.symbols, ["BTCUSDT", "NIFTY"]);
    const add = await c.post("/api/v1/tracked/ETHUSDT", { signalId: "SIG-ETHUSDT-8336" });
    assert.equal(add.status, 200);
    assert.deepEqual(
      add.json.items.map((i) => [i.symbol, i.signalId]),
      [
        ["BTCUSDT", null],
        ["NIFTY", null],
        ["ETHUSDT", "SIG-ETHUSDT-8336"],
      ],
    );
    const rm = await c.del("/api/v1/tracked/NIFTY");
    assert.deepEqual(rm.json.symbols, ["BTCUSDT", "ETHUSDT"]);
  });

  test("sync: union of lists, server wins for an existing profile", async () => {
    const c = await login(A, freshEmail("carol"));
    st.carol = c;
    const guest = { profile: { persona: "options", markets: ["US"], capital: 1000, currency: "USD", riskPct: 8, onboarded: true }, watchlist: ["SPY", "nvda", "??"], tracked: ["SPY"] };
    const r = await c.post("/api/v1/sync", guest);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.merged.profile, true);
    assert.equal(r.json.profile.persona, "options");
    assert.equal(r.json.profile.riskPct, 5, "lenient sync clamps riskPct into 0.1–5");
    assert.deepEqual(r.json.watchlist.symbols, ["SPY", "NVDA"]);
    const r2 = await c.post("/api/v1/sync", { profile: { persona: "investor" }, watchlist: ["SPY", "TSLA"], tracked: ["AAPL"] });
    assert.equal(r2.json.merged.profile, false);
    assert.equal(r2.json.profile.persona, "options", "server profile wins");
    assert.deepEqual(r2.json.watchlist.symbols, ["SPY", "NVDA", "TSLA"]);
    assert.deepEqual(r2.json.tracked.symbols, ["SPY", "AAPL"]);
  });

  test("consents: accept, list pending, withdraw", async () => {
    const c = st.carol;
    const cfg = (await c.get("/api/v1/config")).json.legal;
    const r = await c.post("/api/v1/consents", { kind: "terms", version: cfg.termsVersion });
    assert.equal(r.status, 201);
    assert.equal(r.json.pendingConsents.length, 2);
    await c.post("/api/v1/consents", { kind: "terms", version: cfg.termsVersion }); // idempotent
    const me = await c.get("/api/v1/me");
    assert.equal(me.json.consents.filter((x) => x.kind === "terms").length, 1);
    const w = await c.del("/api/v1/consents/terms");
    assert.equal(w.status, 200);
    assert.equal(w.json.pendingConsents.length, 3);
    assert.equal((await c.post("/api/v1/consents", { kind: "cookies", version: "1" })).status, 400);
  });
});

describe("alerts, notifications, support — IDOR", () => {
  test("alerts: validation and ownership", async () => {
    const alice = st.alice;
    assert.equal((await alice.post("/api/v1/alerts", { symbol: "BTCUSDT", kind: "price_above", threshold: 0 })).status, 400);
    assert.equal((await alice.post("/api/v1/alerts", { symbol: "BTCUSDT", kind: "price_above", threshold: -5 })).status, 400);
    assert.equal((await alice.post("/api/v1/alerts", { symbol: "*", kind: "price_above", threshold: 5 })).status, 400);
    assert.equal((await alice.post("/api/v1/alerts", { symbol: "BTCUSDT", kind: "moon" })).status, 400);
    const a = await alice.post("/api/v1/alerts", { symbol: "btcusdt", kind: "price_above", threshold: 100000 });
    assert.equal(a.status, 201, a.text);
    assert.equal(a.json.alert.symbol, "BTCUSDT");
    assert.equal(a.json.alert.oneShot, true);
    const s = await alice.post("/api/v1/alerts", { symbol: "*", kind: "new_signal" });
    assert.equal(s.status, 201);
    st.aliceAlert = a.json.alert.id;

    const bob = await login(A, freshEmail("bob"));
    st.bob = bob;
    const list = await bob.get("/api/v1/alerts");
    assert.equal(list.json.items.length, 0);
    assert.equal((await bob.get(`/api/v1/alerts/${st.aliceAlert}`)).status, 404);
    assert.equal((await bob.patch(`/api/v1/alerts/${st.aliceAlert}`, { active: false })).status, 404);
    assert.equal((await bob.del(`/api/v1/alerts/${st.aliceAlert}`)).status, 404);
    const mine = await alice.get(`/api/v1/alerts/${st.aliceAlert}`);
    assert.equal(mine.status, 200);
    assert.equal(mine.json.alert.active, true, "bob's attempts changed nothing");
    const patched = await alice.patch(`/api/v1/alerts/${st.aliceAlert}`, { threshold: 90000 });
    assert.equal(patched.json.alert.threshold, 90000);
  });

  test("support tickets: owner-only reads and replies", async () => {
    const alice = st.alice;
    const t = await alice.post("/api/v1/support", { category: "signal", subject: "Question about BTC", body: "Why did the engine sit out today?" });
    assert.equal(t.status, 201, t.text);
    st.aliceTicket = t.json.ticket.id;
    const bob = st.bob;
    const bl = await bob.get("/api/v1/support");
    assert.equal(bl.json.items.length, 0);
    assert.equal((await bob.post(`/api/v1/support/${st.aliceTicket}/reply`, { body: "hijack" })).status, 404);
    const al = await alice.get("/api/v1/support");
    assert.equal(al.json.items.length, 1);
    assert.equal(al.json.items[0].messages.length, 1);
  });

  test("support works signed-out with an email (and requires it)", async () => {
    const anon = new Client(A, { ip: freshIp() });
    assert.equal((await anon.post("/api/v1/support", { category: "bug", subject: "Broken chart", body: "The chart does not load on Safari." })).status, 400);
    const ok = await anon.post("/api/v1/support", { category: "grievance", subject: "Complaint", body: "Formal grievance about a signal.", email: freshEmail("anon") });
    assert.equal(ok.status, 201);
    assert.deepEqual(Object.keys(ok.json.ticket).sort(), ["category", "createdAt", "id", "status", "subject"]);
  });

  test("sessions: users can't revoke someone else's session; notifications can't be marked across users", async () => {
    const sessions = await st.alice.get("/api/v1/me/sessions");
    assert.equal(sessions.status, 200);
    const aliceSession = sessions.json.items.find((s) => s.current);
    assert.ok(aliceSession);
    assert.equal((await st.bob.del(`/api/v1/me/sessions/${aliceSession.id}`)).status, 404);
    assert.equal((await st.alice.get("/api/v1/me")).status, 200, "alice still signed in");
    const mark = await st.bob.post("/api/v1/notifications/read", { ids: [crypto.randomUUID()] });
    assert.equal(mark.json.marked, 0);
  });
});

describe("activity events", () => {
  test("allowlist filtering, PII-safe props, batch cap", async () => {
    const anon = new Client(A, { ip: freshIp() });
    const r = await anon.post("/api/v1/events", {
      anonId: "anon_test_123456",
      events: [
        { name: "page_view", path: "/app?email=a@b.com#x" },
        { name: "drop_table_users", props: { x: 1 } },
        { name: "instrument_view", props: { symbol: "BTCUSDT", contact: "me@example.com", nested: { a: 1 } } },
        { name: "signup_start" },
      ],
    });
    assert.equal(r.status, 202, r.text);
    assert.equal(r.json.accepted, 3);
    assert.equal(r.json.dropped, 1);
    const big = await anon.post("/api/v1/events", { anonId: "anon_test_123456", events: Array.from({ length: 26 }, () => ({ name: "page_view" })) });
    assert.equal(big.status, 400);
    assert.equal(big.json.error, "batch_too_large");
    assert.equal((await anon.post("/api/v1/events", { events: [{ name: "page_view" }] })).status, 400, "guests need an anonId");
    // signed-in events link to the user
    const s = await st.alice.post("/api/v1/events", { anonId: "anon_alice_123456", events: [{ name: "onboarding_complete" }, { name: "track_toggle", props: { symbol: "BTCUSDT" } }] });
    assert.equal(s.json.accepted, 2);
  });
});

describe("extension linking (device flow) + Bearer + CORS", () => {
  test("start -> pending -> approve -> token once -> Bearer works -> revocable", async () => {
    const ext = new Client(A, { ip: freshIp(), origin: EXT_ORIGIN });
    const s = await ext.post("/api/v1/ext/link/start", {});
    assert.equal(s.status, 200, s.text);
    assert.match(s.json.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(s.json.verifyUrl, `https://tudumm.in/app/link?code=${s.json.userCode}`);
    assert.equal(s.json.expiresIn, 600);
    assert.equal(s.json.interval, 5);
    assert.equal(s.headers.get("access-control-allow-origin"), EXT_ORIGIN);
    assert.equal(s.headers.get("access-control-allow-credentials"), null);

    assert.equal((await ext.post("/api/v1/ext/link/poll", { deviceToken: s.json.deviceToken })).json.status, "pending");
    // A random web origin can't drive the device flow.
    assert.equal((await new Client(A, { origin: "https://evil.example" }).post("/api/v1/ext/link/start", {})).status, 403);

    assert.equal((await st.alice.post("/api/v1/ext/link/approve", { userCode: "ZZZZ-ZZZZ" })).status, 404);
    const ap = await st.alice.post("/api/v1/ext/link/approve", { userCode: s.json.userCode.toLowerCase().replace("-", "") });
    assert.equal(ap.status, 200, ap.text);

    const p = await ext.post("/api/v1/ext/link/poll", { deviceToken: s.json.deviceToken });
    assert.equal(p.json.status, "approved");
    assert.match(p.json.token, /^[A-Za-z0-9_-]{43}$/);
    const p2 = await ext.post("/api/v1/ext/link/poll", { deviceToken: s.json.deviceToken });
    assert.equal(p2.status, 410, "token is handed out exactly once");

    ext.bearer = p.json.token;
    const me = await ext.get("/api/v1/me", { origin: EXT_ORIGIN });
    assert.equal(me.status, 200);
    assert.equal(me.json.user.id, st.alice.user.id);
    assert.equal(me.json.session.kind, "extension");
    assert.equal(me.headers.get("access-control-allow-origin"), EXT_ORIGIN);
    assert.equal(me.headers.get("access-control-allow-credentials"), null);
    const w = await ext.post("/api/v1/watchlist/SOLUSDT", {});
    assert.equal(w.status, 200, "Bearer writes work from the extension origin");
    assert.equal((await ext.get("/api/v1/me/export")).status, 403, "account-level actions need the web session");

    // The extension token is not a valid cookie.
    const asCookie = new Client(A);
    asCookie.jar.set("__Host-tdm_s", p.json.token);
    assert.equal((await asCookie.get("/api/v1/me")).status, 401);

    const sessions = await st.alice.get("/api/v1/me/sessions");
    const extSession = sessions.json.items.find((x) => x.kind === "extension");
    assert.ok(extSession);
    assert.equal((await st.alice.del(`/api/v1/me/sessions/${extSession.id}`)).status, 200);
    assert.equal((await ext.get("/api/v1/me")).status, 401, "revoked in /me/sessions");
    st.extUsed = true;
  });
});

describe("billing (capability-gated)", () => {
  test("disabled honestly without provider keys", async () => {
    const r = await st.alice.get("/api/v1/billing");
    assert.equal(r.status, 200);
    assert.equal(r.json.enabled, false);
    assert.ok(r.json.reason);
    assert.equal((await st.alice.post("/api/v1/billing/checkout", { plan: "pro", provider: "razorpay" })).status, 503);
    const wh = await new Client(A, { origin: null }).post("/api/v1/billing/webhook/razorpay", { event: "order.paid" });
    assert.equal(wh.status, 503);
    const ws = await new Client(A, { origin: null }).post("/api/v1/billing/webhook/stripe", { type: "checkout.session.completed" });
    assert.equal(ws.status, 503);
  });
});

describe("admin", () => {
  const adminIp = freshIp();
  let admin;

  test("login: wrong password 401, right password sets a Strict __Host- cookie", async () => {
    admin = new Client(A, { ip: adminIp });
    const bad = await admin.post("/api/admin/login", { password: "nope" });
    assert.equal(bad.status, 401);
    assert.equal(bad.json.error, "invalid_credentials");
    assert.equal((await admin.get("/api/admin/me")).status, 401);
    const evil = await new Client(A, { ip: freshIp(), origin: "https://evil.example" }).post("/api/admin/login", { password: "test" });
    assert.equal(evil.status, 403, "cross-origin admin login refused");
    const ok = await admin.post("/api/admin/login", { password: "test" });
    assert.equal(ok.status, 200, ok.text);
    const ck = ok.setCookies.find((x) => x.startsWith("__Host-tdm_a="));
    assert.ok(ck);
    for (const flag of ["Secure", "HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=28800"]) assert.ok(ck.includes(flag), `admin cookie has ${flag}`);
    const me = await admin.get("/api/admin/me");
    assert.equal(me.status, 200);
    assert.equal(me.json.capabilities.adminConfigured, true);
    assert.equal((await st.alice.get("/api/admin/me")).status, 401, "a user session is not an admin session");
  });

  test("admin routes refuse cross-site requests", async () => {
    const xs = await admin.get("/api/admin/users", { headers: { "sec-fetch-site": "cross-site" } });
    assert.equal(xs.status, 403);
    const xo = await admin.post(`/api/admin/users/${st.alice.user.id}/notes`, { body: "x" }, { origin: "https://evil.example" });
    assert.equal(xo.status, 403);
  });

  test("users: search, detail, plan grant, notes", async () => {
    const list = await admin.get(`/api/admin/users?q=${encodeURIComponent(st.aliceEmail.slice(0, 12))}`);
    assert.equal(list.status, 200);
    assert.ok(list.json.items.some((u) => u.id === st.alice.user.id));
    const pct = await admin.get("/api/admin/users?q=%25");
    assert.equal(pct.status, 200, "LIKE wildcards are escaped");
    assert.equal(pct.json.total, 0);

    assert.equal((await admin.post(`/api/admin/users/${st.alice.user.id}/plan`, { plan: "pro" })).status, 400, "reason required");
    const g = await admin.post(`/api/admin/users/${st.alice.user.id}/plan`, { plan: "pro", reason: "UAT tester" });
    assert.equal(g.status, 200, g.text);
    const me = await st.alice.get("/api/v1/me");
    assert.equal(me.json.plan.id, "pro");
    assert.equal(me.json.plan.limits.alerts, 500);

    assert.equal((await admin.post(`/api/admin/users/${st.alice.user.id}/notes`, { body: "Helpful tester" })).status, 201);
    const d = await admin.get(`/api/admin/users/${st.alice.user.id}`);
    assert.equal(d.status, 200);
    assert.equal(d.json.notes.length, 1);
    assert.ok(d.json.watchlist.length >= 1);
    assert.ok(d.json.alerts.length >= 1);
    assert.ok(d.json.tickets.length >= 1);
    assert.ok(Array.isArray(d.json.timeline));
    assert.ok(d.json.sessions.every((s) => !("token_hash" in s) && !("tokenHash" in s)));
    assert.equal((await admin.get(`/api/admin/users/${crypto.randomUUID()}`)).status, 404);
  });

  test("suspend: sessions revoked, login refused (403); unsuspend restores", async () => {
    const bob = st.bob;
    const s = await admin.post(`/api/admin/users/${bob.user.id}/suspend`, { reason: "abuse test" });
    assert.equal(s.status, 200, s.text);
    assert.equal((await bob.get("/api/v1/me")).status, 401);
    const c = new Client(A, { ip: freshIp() });
    const start = await c.post("/api/v1/auth/start", { email: bob.user.email });
    const v = await c.post("/api/v1/auth/verify", { email: bob.user.email, code: start.json.devCode });
    assert.equal(v.status, 403);
    assert.equal(v.json.error, "account_suspended");
    assert.equal((await admin.post(`/api/admin/users/${bob.user.id}/unsuspend`, {})).status, 200);
    const again = await login(A, bob.user.email);
    assert.equal((await again.get("/api/v1/me")).status, 200);
  });

  test("revoke-sessions", async () => {
    const r = await admin.post(`/api/admin/users/${st.carol.user.id}/revoke-sessions`, {});
    assert.equal(r.status, 200);
    assert.ok(r.json.revoked >= 1);
    assert.equal((await st.carol.get("/api/v1/me")).status, 401);
  });

  test("flags: signups off blocks new accounts only", async () => {
    const off = await admin.put("/api/admin/flags/signups", { enabled: false });
    assert.equal(off.status, 200, off.text);
    assert.equal((await new Client(A).get("/api/v1/config")).json.flags.signups, false);
    const c = new Client(A, { ip: freshIp() });
    const email = freshEmail("late-signup");
    const start = await c.post("/api/v1/auth/start", { email });
    assert.equal(start.status, 200, "no enumeration: start still answers normally");
    const v = await c.post("/api/v1/auth/verify", { email, code: start.json.devCode });
    assert.equal(v.status, 403);
    assert.equal(v.json.error, "signups_closed");
    await login(A, st.aliceEmail); // existing accounts still sign in
    assert.equal((await admin.put("/api/admin/flags/signups", { enabled: true })).status, 200);
    const f = await admin.get("/api/admin/flags/require_signal_approval");
    assert.equal(f.status, 200);
    assert.equal(f.json.flag.enabled, false);
    assert.equal((await admin.put("/api/admin/flags/Bad-Key", { enabled: true })).status, 400);
  });

  test("announcements: create shows on /config, unsafe links rejected, patch", async () => {
    assert.equal((await admin.post("/api/admin/announcements", { level: "info", message: "Hello testers", link: "javascript:alert(1)" })).status, 400);
    const a = await admin.post("/api/admin/announcements", { level: "warning", message: "Maintenance tonight", link: "/app/status" });
    assert.equal(a.status, 201, a.text);
    const cfg = await new Client(A).get("/api/v1/config");
    assert.ok(cfg.json.announcements.some((x) => x.id === a.json.announcement.id));
    const p = await admin.patch(`/api/admin/announcements/${a.json.announcement.id}`, { active: false });
    assert.equal(p.status, 200);
    assert.equal(p.json.announcement.active, false);
  });

  test("support desk: reply notifies the user; status change", async () => {
    const list = await admin.get("/api/admin/support?status=open");
    assert.ok(list.json.items.some((t) => t.id === st.aliceTicket));
    const r = await admin.post(`/api/admin/support/${st.aliceTicket}/reply`, { body: "The context layer flagged high event risk." });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.emailed, false, "no email provider => not emailed, honestly reported");
    const mine = await st.alice.get("/api/v1/support");
    assert.equal(mine.json.items[0].status, "pending");
    assert.equal(mine.json.items[0].messages.at(-1).author, "admin");
    const n = await st.alice.get("/api/v1/notifications?unread=1");
    assert.ok(n.json.items.some((x) => x.kind === "support_reply"));
    assert.equal((await st.alice.post("/api/v1/notifications/read", { all: true })).json.unread, 0);
    assert.equal((await admin.post(`/api/admin/support/${st.aliceTicket}/status`, { status: "resolved" })).status, 200);
    assert.equal((await admin.post(`/api/admin/support/${st.aliceTicket}/status`, { status: "deleted" })).status, 400);
  });

  test("events feed: unknown names were never stored, no IP columns", async () => {
    const bad = await admin.get("/api/admin/events?name=drop_table_users");
    assert.equal(bad.status, 200);
    assert.equal(bad.json.items.length, 0);
    const pv = await admin.get("/api/admin/events?name=page_view");
    const row = pv.json.items.find((e) => e.anonId === "anon_test_123456");
    assert.ok(row);
    assert.equal(row.path, "/app", "query string and fragment stripped");
    assert.ok(!Object.keys(row).some((k) => /ip/i.test(k)));
    const iv = await admin.get("/api/admin/events?name=instrument_view");
    const ivRow = iv.json.items.find((e) => e.anonId === "anon_test_123456");
    assert.deepEqual(ivRow.props, { symbol: "BTCUSDT" }, "email-like and nested props dropped");
  });

  test("engine routes delegate to market/admin.ts", async () => {
    const h = await admin.get("/api/admin/engine/health");
    assert.equal(h.status, 200, h.text);
    assert.ok(Array.isArray(h.json.sources));
    const s = await admin.get("/api/admin/engine/signals?limit=5");
    assert.equal(s.status, 200, s.text);
    assert.ok(Array.isArray(s.json.items));
    assert.equal((await admin.get("/api/admin/engine/strategies")).status, 200);
    assert.equal((await admin.post("/api/admin/engine/strategies", { strategy: "trend", market: "MARS", enabled: false })).status, 400);
    const ss = await admin.post("/api/admin/engine/strategies", { strategy: "trend_pullback", market: "CRYPTO", enabled: true });
    assert.ok([200, 502].includes(ss.status), ss.text);
    const hold = await admin.post("/api/admin/engine/signals/SIG-DOES-NOT-EXIST/hold", { hold: true, reason: "test hold" });
    assert.ok([200, 404, 502].includes(hold.status), hold.text);
    const inv = await admin.post("/api/admin/engine/signals/SIG-DOES-NOT-EXIST/invalidate", { reason: "test invalidate" });
    assert.ok([200, 404, 502].includes(inv.status), inv.text);
    const run = await admin.post("/api/admin/engine/run", {});
    assert.ok([200, 502].includes(run.status), run.text);
  });

  test("dev outbox: masked email + code, only while dev codes are on", async () => {
    const r = await admin.get("/api/admin/dev-outbox");
    assert.equal(r.status, 200);
    assert.ok(r.json.items.length > 0 && r.json.items.length <= 50);
    for (const it of r.json.items) {
      assert.match(it.email, /\*\*\*/);
      assert.ok(!it.email.includes(st.aliceEmail));
      assert.match(it.code, /^\d{6}$/);
    }
  });

  test("overview + compliance aggregates", async () => {
    const o = await admin.get("/api/admin/overview?days=30");
    assert.equal(o.status, 200, o.text);
    assert.ok(o.json.kpis.totalUsers >= 4);
    assert.ok(o.json.kpis.dau.users >= 1);
    assert.equal(o.json.kpis.planMix.pro, 1);
    assert.equal(o.json.funnel.length, 4);
    assert.ok(o.json.funnel[0].actors >= 1, "signup_start counted");
    assert.ok(o.json.topInstruments.some((t) => t.symbol === "BTCUSDT"));
    assert.ok(Array.isArray(o.json.retention) && o.json.retention.length >= 1);
    const c = await admin.get("/api/admin/compliance");
    assert.equal(c.status, 200);
    assert.ok(Array.isArray(c.json.consents));
    assert.equal(typeof c.json.grievances.olderThan7Days, "number");
  });

  test("export + delete (DPDP/GDPR)", async () => {
    const email = freshEmail("dave");
    const dave = await login(A, email);
    await dave.put("/api/v1/watchlist", { symbols: ["TCS", "INFY"] });
    await dave.post("/api/v1/consents", { kind: "privacy", version: "2026-11-10" });
    await dave.post("/api/v1/alerts", { symbol: "TCS", kind: "price_below", threshold: 3000 });
    const ex = await dave.get("/api/v1/me/export");
    assert.equal(ex.status, 200);
    assert.match(ex.headers.get("content-disposition"), /attachment; filename="tudumm-export-/);
    assert.equal(ex.json.user.email, email);
    assert.deepEqual(ex.json.watchlist.map((w) => w.symbol), ["TCS", "INFY"]);
    assert.equal(ex.json.consents.length, 1);
    assert.ok(!/token_hash|code_hash|ip_hash/.test(ex.text), "no hashes/secrets in the export");

    assert.equal((await dave.del("/api/v1/me", { confirm: "yes" })).status, 400);
    const d = await dave.del("/api/v1/me", { confirm: "DELETE" });
    assert.equal(d.status, 200, d.text);
    assert.ok(d.setCookies.some((x) => x.startsWith("__Host-tdm_s=;")));
    const stale = new Client(A);
    stale.jar.set("__Host-tdm_s", "x".repeat(43));
    assert.equal((await dave.get("/api/v1/me")).status, 401);

    const detail = await admin.get(`/api/admin/users/${dave.user.id}`);
    assert.equal(detail.json.user.status, "deleted");
    assert.equal(detail.json.user.email, `deleted+${dave.user.id}@invalid`);
    assert.equal(detail.json.watchlist.length, 0);
    assert.equal(detail.json.alerts.length, 0);
    assert.equal(detail.json.profile, null);
    const comp = await admin.get("/api/admin/compliance");
    const kinds = Object.fromEntries(comp.json.dataRequests.last30Days.map((r) => [r.kind, r.n]));
    assert.ok(kinds.export >= 1 && kinds.delete >= 1, "data_requests rows logged");

    const back = await login(A, email);
    assert.notEqual(back.user.id, dave.user.id, "the address can sign up again as a fresh account");
  });

  test("audit log has a row for every admin mutation and never the password", async () => {
    const r = await admin.get("/api/admin/audit?page=1");
    assert.equal(r.status, 200);
    let items = r.json.items;
    if (r.json.hasMore) items = items.concat((await admin.get("/api/admin/audit?page=2")).json.items);
    const actions = new Set(items.map((i) => i.action));
    for (const a of [
      "admin.login.failure",
      "admin.login.success",
      "user.plan_set",
      "user.note_add",
      "user.suspend",
      "user.unsuspend",
      "user.revoke_sessions",
      "flag.set",
      "announcement.create",
      "announcement.update",
      "support.reply",
      "support.status",
      "engine.strategy_set",
      "engine.signal_hold",
      "engine.signal_invalidate",
      "engine.run",
      "dev_outbox.view",
      "user.self_delete",
    ]) {
      assert.ok(actions.has(a), `audit has ${a}`);
    }
    assert.ok(!JSON.stringify(items).includes('"test"'), "the admin password never appears in the audit log");
    const plan = items.find((i) => i.action === "user.plan_set");
    assert.equal(plan.targetId, st.alice.user.id);
    assert.equal(plan.detail.reason, "UAT tester");
    assert.match(plan.actor, /^admin:[0-9a-f]{8}$/);
  });

  test("audit log is append-only at the database level", async () => {
    const db = sqliteOf(A);
    try {
      assert.throws(() => db.prepare("UPDATE audit_log SET action = 'x'").run(), /append-only/);
      assert.throws(() => db.prepare("DELETE FROM audit_log").run(), /append-only/);
    } finally {
      db.close();
    }
  });

  test("admin login is rate-limited (5 per 15 min per IP)", async () => {
    const c = new Client(A, { ip: freshIp() });
    for (let i = 0; i < 5; i++) assert.equal((await c.post("/api/admin/login", { password: `wrong-${i}` })).status, 401);
    const r = await c.post("/api/admin/login", { password: "test" });
    assert.equal(r.status, 429, "even the right password is refused once limited");
  });

  test("admin logout", async () => {
    assert.equal((await admin.post("/api/admin/logout", {})).status, 200);
    assert.equal((await admin.get("/api/admin/me")).status, 401);
  });
});

describe("worker without ADMIN_PASSWORD; Turnstile fail-closed", () => {
  test("admin is disabled with a clear 503", async () => {
    const c = new Client(B, { ip: freshIp() });
    const cfg = await c.get("/api/v1/config");
    assert.equal(cfg.json.capabilities.adminConfigured, false);
    const r = await c.post("/api/admin/login", { password: "test" });
    assert.equal(r.status, 503);
    assert.deepEqual(r.json, { error: "admin_not_configured", hint: "Owner: run scripts/set-secrets.sh" });
    assert.equal((await c.get("/api/admin/me")).status, 503);
    assert.equal((await c.get("/api/admin/overview")).status, 503);
  });

  test("with a Turnstile secret, auth/start requires a token and never passes a bad one", async () => {
    const c = new Client(B, { ip: freshIp() });
    const cfg = await c.get("/api/v1/config");
    assert.equal(cfg.json.capabilities.turnstile, true);
    assert.ok(cfg.json.turnstileSiteKey);
    const none = await c.post("/api/v1/auth/start", { email: freshEmail("ts") });
    assert.equal(none.status, 400);
    assert.equal(none.json.error, "turnstile_required");
    const bad = await c.post("/api/v1/auth/start", { email: freshEmail("ts"), turnstileToken: "XXXX.DUMMY.TOKEN.XXXX" });
    // 400 when Cloudflare answered "invalid", 503 when siteverify is unreachable from this machine.
    assert.ok([400, 503].includes(bad.status), bad.text);
    assert.ok(["turnstile_failed", "turnstile_unavailable"].includes(bad.json.error));
  });
});
