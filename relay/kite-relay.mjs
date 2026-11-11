#!/usr/bin/env node
// Tudumm Kite relay — places owner-CONFIRMED orders at Zerodha Kite from a static IP.
//
// Why: since 1 Apr 2026 Kite only accepts API order placement from a static IP registered in the
// developer console. Cloudflare Workers have no static egress, so the Worker queues orders the
// owner confirmed in /admin/broker and this process PULLS them (no inbound ports, no TLS cert):
//
//   loop: POST {TUDUMM_URL}/api/internal/relay/claim  (Bearer RELAY_TOKEN; doubles as heartbeat)
//         -> { idle:true }                             nothing to do
//         -> { intent, apiKey, accessToken }           POST https://api.kite.trade/orders/regular
//            POST {TUDUMM_URL}/api/internal/relay/result { intentId, ok, orderId?, error? }
//
// Safety rules:
//   * An order placement is NEVER retried. A timeout/network error is reported as a failure with
//     "unknown_outcome" so the owner checks the Kite order book; the Worker also reconciles via the
//     order tag when Kite's postback arrives. Only the RESULT report is retried (it is idempotent).
//   * Only whitelisted Kite parameters are sent. The access token lives in memory for one request.
//   * Logs are JSON lines and never contain RELAY_TOKEN, the API key or the access token.
//   * IPv4 only for every connection, so the IP the Worker shows (CF-Connecting-IP) is the same
//     egress IP Kite sees — that is the IP to register in the Kite developer console.
//
// Env: TUDUMM_URL (default https://tudumm.in), RELAY_TOKEN (required, >= 32 chars).
// Node >= 20, zero dependencies.  Run: RELAY_TOKEN=... node relay/kite-relay.mjs
import http from "node:http";
import https from "node:https";

const VERSION = "1.0.0";
const ACTIVE_POLL_MS = 1500;
const IDLE_OFFHOURS_MS = 15_000;
const MAX_ERROR_BACKOFF_MS = 60_000;
const KITE_TIMEOUT_MS = 10_000;
const TUDUMM_TIMEOUT_MS = 15_000;
const MAX_BODY = 1024 * 1024;

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/;
const ALLOWED_PARAMS = ["exchange", "tradingsymbol", "transaction_type", "order_type", "quantity", "product", "validity", "price", "trigger_price", "market_protection", "tag"];
const PARAM_VALUE = /^[A-Za-z0-9&_.:\-]{1,40}$/;

/* ---------------- config ---------------- */

const secrets = new Set();

function fatal(msg) {
  log("error", msg);
  process.exit(2);
}

function config() {
  const tudumm = (process.env.TUDUMM_URL || "https://tudumm.in").replace(/\/+$/, "");
  const token = process.env.RELAY_TOKEN || "";
  if (token.length < 32) fatal("RELAY_TOKEN is missing or shorter than 32 characters");
  secrets.add(token);
  let u;
  try {
    u = new URL(tudumm);
  } catch {
    fatal("TUDUMM_URL is not a valid URL");
  }
  if (u.protocol !== "https:" && !LOOPBACK.test(u.origin)) fatal("TUDUMM_URL must be https:// (http is allowed only for 127.0.0.1/localhost tests)");
  // Test hook: a loopback mock of api.kite.trade. Production always talks to Kite over HTTPS.
  const kiteOverride = process.env.KITE_API_BASE || "";
  const kite = kiteOverride && LOOPBACK.test(kiteOverride) ? kiteOverride : "https://api.kite.trade";
  return { tudumm: u.origin + u.pathname.replace(/\/+$/, ""), token, kite };
}

/* ---------------- logging (no secrets, ever) ---------------- */

function redact(s) {
  let out = String(s);
  for (const x of secrets) if (x && x.length >= 6) out = out.split(x).join("[redacted]");
  return out.replace(/token\s+[A-Za-z0-9]+:[A-Za-z0-9]+/gi, "token [redacted]");
}

function log(level, msg, fields = {}) {
  const clean = {};
  for (const [k, v] of Object.entries(fields)) clean[k] = typeof v === "string" ? redact(v).slice(0, 300) : v;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg: redact(msg), ...clean });
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}

/* ---------------- HTTP (IPv4 only, bounded, timed out) ---------------- */

function request(url, { method = "GET", headers = {}, body = null, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      u,
      { method, headers: { "user-agent": `tudumm-kite-relay/${VERSION}`, ...headers, ...(body ? { "content-length": Buffer.byteLength(body) } : {}) }, family: 4, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > MAX_BODY) req.destroy(new Error("response too large"));
          else chunks.push(c);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json, text });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ---------------- market window (IST = UTC+05:30) ---------------- */

export function inMarketWindow(ms = Date.now()) {
  const ist = new Date(ms + 330 * 60_000);
  const day = ist.getUTCDay(); // 0 Sun .. 6 Sat
  if (day === 0 || day === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 9 * 60 && mins < 15 * 60 + 40;
}

/* ---------------- relay ---------------- */

let stopping = false;
let inFlight = null;
let wake = null;

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);
    wake = () => {
      clearTimeout(t);
      wake = null;
      resolve();
    };
  });
}

function buildForm(params) {
  const form = new URLSearchParams();
  for (const k of ALLOWED_PARAMS) {
    const v = params?.[k];
    if (v === undefined || v === null) continue;
    const s = String(v);
    if (!PARAM_VALUE.test(s)) throw new Error(`refusing order: parameter ${k} has an unexpected value`);
    form.set(k, s);
  }
  for (const k of ["exchange", "tradingsymbol", "transaction_type", "order_type", "quantity", "product"]) {
    if (!form.has(k)) throw new Error(`refusing order: missing ${k}`);
  }
  if (!/^[1-9][0-9]{0,6}$/.test(form.get("quantity"))) throw new Error("refusing order: bad quantity");
  return form;
}

/** Place ONE order. Never retried: every path returns a result to report. */
async function placeOrder(cfg, claim) {
  const { intent, apiKey, accessToken } = claim;
  if (typeof apiKey === "string") secrets.add(apiKey);
  if (typeof accessToken === "string") secrets.add(accessToken);
  try {
    let form;
    try {
      form = buildForm(intent.params);
    } catch (err) {
      return { ok: false, error: `relay_refused: ${err.message}` };
    }
    let res;
    try {
      res = await request(`${cfg.kite}/orders/regular`, {
        method: "POST",
        headers: {
          "X-Kite-Version": "3",
          authorization: `token ${apiKey}:${accessToken}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: form.toString(),
        timeoutMs: KITE_TIMEOUT_MS,
      });
    } catch (err) {
      return {
        ok: false,
        error: `unknown_outcome: no response from Kite (${err.code || err.message}). The order MAY have been placed — check the Kite order book before trying again.`,
      };
    }
    const orderId = res.json?.data?.order_id;
    if (res.status >= 200 && res.status < 300 && res.json?.status === "success" && typeof orderId === "string" && /^[A-Za-z0-9]{1,32}$/.test(orderId)) {
      return { ok: true, orderId };
    }
    if (res.status >= 500 || !res.json || (res.status >= 200 && res.status < 300)) {
      // 5xx, an unreadable body, or a 2xx without a usable order id: Kite may well have accepted the
      // order, so this must never be reported as a definite failure (the owner could place it twice).
      return { ok: false, error: `unknown_outcome: Kite answered HTTP ${res.status}${res.status < 300 ? " without a usable order id" : ""}. The order MAY have been placed — check the Kite order book.` };
    }
    const type = typeof res.json.error_type === "string" ? res.json.error_type : "Error";
    const message = typeof res.json.message === "string" ? res.json.message : `HTTP ${res.status}`;
    return { ok: false, error: `${type}: ${message}`.slice(0, 480) };
  } finally {
    // Drop the access token from the redaction set only after logging is done for this order.
    setTimeout(() => {
      if (typeof accessToken === "string") secrets.delete(accessToken);
    }, 5_000).unref();
  }
}

/** Report a result. Retries the REPORT (idempotent on the Worker), never the order. */
async function report(cfg, intentId, result) {
  const body = JSON.stringify({ intentId, ...result });
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const r = await request(`${cfg.tudumm}/api/internal/relay/result`, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
        body,
        timeoutMs: TUDUMM_TIMEOUT_MS,
      });
      if (r.status === 200) return true;
      if (r.status === 409 || r.status === 404 || r.status === 400) {
        log("warn", "result not accepted", { intentId, status: r.status, error: r.json?.error ?? "" });
        return false;
      }
      log("warn", "result report failed, retrying", { intentId, status: r.status, attempt });
    } catch (err) {
      log("warn", "result report error, retrying", { intentId, error: err.message, attempt });
    }
    await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempt)));
  }
  log("error", "giving up reporting the result; the Worker will mark it unknown after 5 minutes", { intentId, ok: result.ok });
  return false;
}

async function cycle(cfg, state) {
  const r = await request(`${cfg.tudumm}/api/internal/relay/claim`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    body: JSON.stringify({ version: VERSION }),
    timeoutMs: TUDUMM_TIMEOUT_MS,
  });
  if (r.status === 200 && r.json) {
    if (typeof r.json.relayIp === "string" && r.json.relayIp !== state.ip) {
      state.ip = r.json.relayIp;
      log("info", "Tudumm sees this relay at this public IP — it must be the static IP registered in the Kite developer console", { ip: state.ip });
    }
    if (r.json.idle !== false || !r.json.intent) {
      if (r.json.reason !== state.reason) {
        state.reason = r.json.reason;
        log("info", "idle", { reason: String(r.json.reason ?? "") });
      }
      return inMarketWindow() ? ACTIVE_POLL_MS : IDLE_OFFHOURS_MS;
    }
    state.reason = null;
    const intent = r.json.intent;
    if (typeof intent.id !== "string") {
      log("error", "claim response without an intent id; ignoring");
      return ACTIVE_POLL_MS;
    }
    const summary = `${intent.params?.transaction_type} ${intent.params?.quantity} ${intent.params?.exchange}:${intent.params?.tradingsymbol} ${intent.params?.order_type}`;
    log("info", "placing order", { intentId: intent.id, order: summary });
    inFlight = (async () => {
      const result = await placeOrder(cfg, r.json);
      log(result.ok ? "info" : "warn", result.ok ? "order placed" : "order failed", { intentId: intent.id, orderId: result.orderId ?? "", error: result.error ?? "" });
      await report(cfg, intent.id, result);
    })();
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
    return 250; // there may be more queued orders
  }
  if (r.status === 401) {
    log("error", "RELAY_TOKEN rejected by Tudumm (401). Check the secret on both sides.");
    return MAX_ERROR_BACKOFF_MS;
  }
  if (r.status === 503) {
    log("error", "relay not configured on the Worker (503)", { error: String(r.json?.error ?? "") });
    return MAX_ERROR_BACKOFF_MS;
  }
  if (r.status === 429) {
    const ra = Number(r.headers["retry-after"] ?? r.json?.retryAfter ?? 5);
    return Math.min(MAX_ERROR_BACKOFF_MS, Math.max(1, Number.isFinite(ra) ? ra : 5) * 1000);
  }
  throw new Error(`claim answered HTTP ${r.status}`);
}

async function main() {
  const cfg = config();
  log("info", "relay starting", { version: VERSION, tudumm: cfg.tudumm, kite: cfg.kite, node: process.version });
  const state = { ip: null, reason: undefined, errors: 0 };

  const shutdown = (sig) => {
    if (stopping) return;
    stopping = true;
    log("info", "shutting down", { signal: sig, orderInFlight: !!inFlight });
    if (wake) wake();
    // Hard stop if an in-flight order/report hangs (Kite timeout + report retries are bounded anyway).
    setTimeout(() => {
      log("error", "forced exit after 30s");
      process.exit(1);
    }, 30_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  while (!stopping) {
    let delay;
    try {
      delay = await cycle(cfg, state);
      state.errors = 0;
    } catch (err) {
      state.errors++;
      delay = Math.min(MAX_ERROR_BACKOFF_MS, 1000 * 2 ** Math.min(state.errors, 6));
      log("warn", "claim failed", { error: err.message, retryInMs: delay });
    }
    if (stopping) break;
    await sleep(delay);
  }
  if (inFlight) await inFlight.catch(() => undefined);
  log("info", "stopped");
  process.exit(0);
}

const isMain = import.meta.url === new URL(`file://${process.argv[1]}`).href || process.argv[1]?.endsWith("kite-relay.mjs");
if (isMain) main();
