// Broker (Zerodha Kite, owner-only, REAL money) safety tests. No network: loopback mocks only.
//   node --test worker/test/broker.test.ts
//
//   guardrails.ts  ticket validation (every field), every limit, hard ceilings, boundaries
//   kite.ts        checksums vs node:crypto, login URL, IST expiry maths, token vault, HTTP client
//   vault.ts       key ids, round trips, tamper/wrong-key failures, format vs node:crypto
//   util.ts        IST helpers (must agree with kite.ts), scalar pickers
//   routes.ts      the order state machine on a node:sqlite D1 shim: confirm-time re-check with
//                  current limits, claim-once, kill switch, postback checksum, owner-only routes
//   relay          relay/kite-relay.mjs as a child process against loopback mocks of Kite + Tudumm:
//                  placement never retried, param whitelist, result-report retry, no secrets in logs
import "../../runner/lib/register.ts";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createHash, hkdfSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import http from "node:http";
import { spawn } from "node:child_process";

const G = await import("../src/broker/guardrails.ts");
const K = await import("../src/broker/kite.ts");
const V = await import("../src/broker/vault.ts");
const U = await import("../src/broker/util.ts");
const { brokerRoutes } = await import("../src/broker/routes.ts");
const { HttpError } = await import("../src/lib/http.ts");
type OrderTicket = import("../src/broker/guardrails.ts").OrderTicket;
type Limits = import("../src/broker/guardrails.ts").Limits;

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY_PATH = join(HERE, "..", "..", "relay", "kite-relay.mjs");
const { inMarketWindow } = await import(RELAY_PATH);

type Body = Record<string, unknown>;

/* ======================= helpers ======================= */

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function thrown(fn: () => unknown): any {
  try {
    fn();
  } catch (e) {
    return e;
  }
  assert.fail("expected the call to throw");
}

function httpErr(fn: () => unknown): any {
  const e = thrown(fn);
  assert.ok(e instanceof HttpError, `expected HttpError, got ${e}`);
  return e;
}

/** parseTicket must reject with 400 invalid_input naming `field`. */
function rejects(body: Body, field: string, msg?: RegExp) {
  const e = httpErr(() => G.parseTicket(body));
  assert.equal(e.status, 400);
  assert.equal(e.code, "invalid_input");
  assert.equal(e.extra?.field, field, `expected field ${field}, got ${e.extra?.field}: ${e.extra?.message}`);
  if (msg) assert.match(String(e.extra?.message), msg);
}

/** enforceLimits must throw 409 with this code. */
function conflict(fn: () => unknown, code: string): any {
  const e = httpErr(fn);
  assert.equal(e.status, 409);
  assert.equal(e.code, code, `expected ${code}, got ${e.code}`);
  return e;
}

const limitBody = (o: Body = {}): Body => ({ exchange: "NSE", tradingsymbol: "INFY", transaction_type: "BUY", quantity: 10, product: "CNC", order_type: "LIMIT", price: 1500, ...o });
const marketBody = (o: Body = {}): Body => ({ exchange: "NSE", tradingsymbol: "INFY", transaction_type: "BUY", quantity: 10, product: "CNC", order_type: "MARKET", estPrice: 1500, ...o });
const slBody = (o: Body = {}): Body => ({ exchange: "NSE", tradingsymbol: "INFY", transaction_type: "BUY", quantity: 10, product: "CNC", order_type: "SL", price: 1500, trigger_price: 1490, ...o });
const slmBody = (o: Body = {}): Body => ({ exchange: "NSE", tradingsymbol: "INFY", transaction_type: "BUY", quantity: 10, product: "CNC", order_type: "SL-M", trigger_price: 1510, estPrice: 1500, ...o });

const limits = (o: Partial<Limits> = {}): Limits => ({
  tradingEnabled: true,
  maxOrderValueInr: 25_000,
  maxQty: 100,
  dailyOrderCap: 10,
  allowedExchanges: ["NSE", "BSE"],
  allowedProducts: ["CNC", "MIS"],
  ...o,
});
const OK_CTX = { connected: true, confirmedToday: 0 };

/** Deterministic LCG so property-style samples are identical on every run. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

/* ======================= guardrails: parseTicket ======================= */

describe("guardrails.parseTicket", () => {
  test("a valid LIMIT ticket parses with defaults (validity DAY, no trigger/est/signal)", () => {
    const t = G.parseTicket(limitBody());
    assert.deepEqual(t, {
      exchange: "NSE",
      tradingsymbol: "INFY",
      transaction_type: "BUY",
      quantity: 10,
      product: "CNC",
      order_type: "LIMIT",
      price: 1500,
      trigger_price: null,
      validity: "DAY",
      estPrice: null,
      signalId: null,
    });
  });

  test("exchange: every allowed enum value; lowercase is normalised; anything else rejected", () => {
    assert.deepEqual([...G.EXCHANGES], ["NSE", "BSE", "NFO", "BFO", "CDS", "BCD", "MCX"]);
    for (const x of G.EXCHANGES) assert.equal(G.parseTicket(limitBody({ exchange: x })).exchange, x);
    assert.equal(G.parseTicket(limitBody({ exchange: "nse" })).exchange, "NSE");
    for (const bad of ["NYSE", "NSE ", "", "NSE:INFY", null, undefined, 1, ["NSE"], {}]) rejects(limitBody({ exchange: bad }), "exchange");
  });

  test("product: CNC/MIS/NRML/MTF only, case-sensitive", () => {
    assert.deepEqual([...G.PRODUCTS], ["CNC", "MIS", "NRML", "MTF"]);
    for (const p of G.PRODUCTS) assert.equal(G.parseTicket(limitBody({ product: p })).product, p);
    for (const bad of ["cnc", "BO", "CO", "", null, undefined, 0]) rejects(limitBody({ product: bad }), "product");
  });

  test("order_type: MARKET/LIMIT/SL/SL-M only, case-sensitive", () => {
    assert.deepEqual([...G.ORDER_TYPES], ["MARKET", "LIMIT", "SL", "SL-M"]);
    for (const bad of ["market", "limit", "SL-L", "SLM", "STOP", "", null, undefined]) rejects(limitBody({ order_type: bad }), "order_type");
  });

  test("transaction_type: BUY/SELL only, case-sensitive", () => {
    assert.deepEqual([...G.SIDES], ["BUY", "SELL"]);
    assert.equal(G.parseTicket(limitBody({ transaction_type: "SELL" })).transaction_type, "SELL");
    for (const bad of ["buy", "sell", "SHORT", "", null, undefined, true]) rejects(limitBody({ transaction_type: bad }), "transaction_type");
  });

  test("validity: DAY/IOC; omitted/null/'' default to DAY; GTT/TTL/lowercase rejected", () => {
    assert.deepEqual([...G.VALIDITIES], ["DAY", "IOC"]);
    assert.equal(G.parseTicket(limitBody({ validity: "IOC" })).validity, "IOC");
    assert.equal(G.parseTicket(limitBody({ validity: "DAY" })).validity, "DAY");
    for (const omitted of [undefined, null, ""]) assert.equal(G.parseTicket(limitBody({ validity: omitted })).validity, "DAY");
    for (const bad of ["day", "TTL", "GTC", "GTT", 0, false]) rejects(limitBody({ validity: bad }), "validity");
  });

  test("tradingsymbol: real Kite symbols incl. M&M, BAJAJ-AUTO, futures and options", () => {
    const ok = [
      "INFY",
      "M&M",
      "M&MFIN",
      "BAJAJ-AUTO",
      "NIFTY25NOVFUT",
      "NIFTY2511324000CE",
      "BANKNIFTY25DEC52000PE",
      "SENSEX25N1385000PE",
      "USDINR25NOVFUT",
      "GOLDM25DECFUT",
      "SBIN-BE",
      "NIFTY_ETF",
      "A.B",
      "0", // single char, digit first is fine
      "A".repeat(40),
    ];
    for (const s of ok) assert.equal(G.parseTicket(limitBody({ tradingsymbol: s })).tradingsymbol, s, s);
    // normalised: trimmed + upper-cased
    assert.equal(G.parseTicket(limitBody({ tradingsymbol: "  m&m  " })).tradingsymbol, "M&M");
    assert.equal(G.parseTicket(limitBody({ tradingsymbol: "bajaj-auto" })).tradingsymbol, "BAJAJ-AUTO");
    assert.equal(G.parseTicket(limitBody({ tradingsymbol: "INFY\n" })).tradingsymbol, "INFY");
  });

  test("tradingsymbol: rejects empty, >40 chars, bad first char, spaces, separators, non-ASCII, non-strings", () => {
    const bad = ["", "   ", "A".repeat(41), "-INFY", "&M", "_X", ".X", "INFY 50", "NSE:INFY", "IN/FY", "INFY;", "IN\nFY", "IN\u0000FY", "ИНФИ", "INFY%", "INFY'", 'INFY"', "INFY+"];
    for (const s of bad) rejects(limitBody({ tradingsymbol: s }), "tradingsymbol");
    for (const s of [123, null, undefined, ["INFY"], {}]) rejects(limitBody({ tradingsymbol: s }), "tradingsymbol");
    assert.equal(G.TRADINGSYMBOL_RE.test("A".repeat(40)), true);
    assert.equal(G.TRADINGSYMBOL_RE.test("A".repeat(41)), false);
  });

  test("quantity: integer 1..HARD_MAX_QTY (100000); boundaries and junk", () => {
    assert.equal(G.HARD_MAX_QTY, 100_000);
    assert.equal(G.parseTicket(limitBody({ quantity: 1 })).quantity, 1);
    assert.equal(G.parseTicket(limitBody({ quantity: G.HARD_MAX_QTY })).quantity, 100_000);
    for (const bad of [0, -1, G.HARD_MAX_QTY + 1, 1.5, 0.999, "10", NaN, Infinity, -Infinity, null, undefined, true]) rejects(limitBody({ quantity: bad }), "quantity");
  });

  test("LIMIT: price required (>0, <= 1e7); trigger must be absent; estPrice ignored", () => {
    for (const bad of [undefined, null, 0, -1, -0.05, "1500", NaN, Infinity, 10_000_000.0001, 1e8]) rejects(limitBody({ price: bad }), "price");
    assert.equal(G.parseTicket(limitBody({ price: 10_000_000 })).price, 10_000_000);
    assert.equal(G.parseTicket(limitBody({ price: 0.0001 })).price, 0.0001);
    rejects(limitBody({ trigger_price: 1490 }), "trigger_price", /omitted for LIMIT/);
    rejects(limitBody({ trigger_price: "1490" }), "trigger_price");
    // "absent" = undefined, null, "" or 0 (clients commonly send 0 for unused fields)
    for (const absent of [undefined, null, "", 0]) assert.equal(G.parseTicket(limitBody({ trigger_price: absent })).trigger_price, null);
    assert.equal(G.parseTicket(limitBody({ estPrice: 1234 })).estPrice, null, "estPrice is not stored for LIMIT");
  });

  test("SL: needs price AND trigger; BUY trigger <= price, SELL trigger >= price (equal allowed)", () => {
    const t = G.parseTicket(slBody());
    assert.equal(t.price, 1500);
    assert.equal(t.trigger_price, 1490);
    assert.equal(t.estPrice, null);
    rejects(slBody({ price: undefined }), "price");
    rejects(slBody({ price: 0 }), "price");
    rejects(slBody({ trigger_price: undefined }), "trigger_price");
    rejects(slBody({ trigger_price: 0 }), "trigger_price");
    // BUY stop-loss
    assert.ok(G.parseTicket(slBody({ price: 1500, trigger_price: 1500 })));
    rejects(slBody({ price: 1500, trigger_price: 1500.05 }), "trigger_price", /at or below/);
    // SELL stop-loss
    assert.ok(G.parseTicket(slBody({ transaction_type: "SELL", price: 1500, trigger_price: 1500 })));
    assert.ok(G.parseTicket(slBody({ transaction_type: "SELL", price: 1490, trigger_price: 1500 })));
    rejects(slBody({ transaction_type: "SELL", price: 1500, trigger_price: 1499.95 }), "trigger_price", /at or above/);
  });

  test("SL-M: price must be absent; trigger AND estPrice required", () => {
    const t = G.parseTicket(slmBody());
    assert.equal(t.price, null);
    assert.equal(t.trigger_price, 1510);
    assert.equal(t.estPrice, 1500);
    rejects(slmBody({ price: 1500 }), "price", /omitted for SL-M/);
    assert.equal(G.parseTicket(slmBody({ price: 0 })).price, null);
    rejects(slmBody({ trigger_price: undefined }), "trigger_price");
    rejects(slmBody({ estPrice: undefined }), "estPrice", /required for SL-M/);
    rejects(slmBody({ estPrice: 0 }), "estPrice");
    rejects(slmBody({ estPrice: -5 }), "estPrice");
  });

  test("MARKET: price and trigger must be absent; estPrice required (>0, <= 1e7)", () => {
    const t = G.parseTicket(marketBody());
    assert.equal(t.price, null);
    assert.equal(t.trigger_price, null);
    assert.equal(t.estPrice, 1500);
    rejects(marketBody({ price: 1500 }), "price", /omitted for MARKET/);
    rejects(marketBody({ trigger_price: 1500 }), "trigger_price", /omitted for MARKET/);
    for (const absent of [undefined, null, "", 0]) rejects(marketBody({ estPrice: absent }), "estPrice", /required for MARKET/);
    for (const bad of [-1, "1500", NaN, 10_000_000.5]) rejects(marketBody({ estPrice: bad }), "estPrice");
  });

  test("prices: at most 4 decimals on price, trigger_price and estPrice", () => {
    for (const p of [1500.05, 0.0025, 1.1234, 99_999.9999, 0.0001]) assert.equal(G.parseTicket(limitBody({ price: p })).price, p);
    for (const p of [1.12345, 0.00001, 0.00005, 1500.00001, 0.33333]) rejects(limitBody({ price: p }), "price", /4 decimals/);
    rejects(slBody({ trigger_price: 1489.12345 }), "trigger_price", /4 decimals/);
    rejects(marketBody({ estPrice: 1500.00009 }), "estPrice", /4 decimals/);
  });

  test("prices: valid 4-decimal values above ~10 lakh are accepted (regression: fixed 1e-6 tolerance rejected them)", () => {
    for (const p of [8_765_432.1234, 9_089_780.4052, 1_204_263.2809, 9_999_999.9999]) assert.equal(G.parseTicket(limitBody({ price: p })).price, p, String(p));
    const r = lcg(42);
    for (let i = 0; i < 20_000; i++) {
      const p = (1 + Math.floor(r() * 1e11)) / 10_000; // every 4-dp value in (0, 1e7]
      assert.equal(G.parseTicket(marketBody({ estPrice: p })).estPrice, p);
    }
  });

  test("prices: float noise is canonicalised to 4 decimals, so the Kite payload never carries it", () => {
    const t = G.parseTicket(limitBody({ price: 30021 * 0.05 })); // 1501.0500000000002
    assert.equal(t.price, 1501.05);
    assert.equal(G.kitePayload(t, "tdm0123456789abcdef0").price, "1501.05");
    assert.equal(G.parseTicket(limitBody({ price: 0.1 + 0.2 })).price, 0.3);
  });

  test("signalId: optional; valid ids kept, 'sym:' and junk rejected", () => {
    assert.equal(G.parseTicket(limitBody({ signalId: "SIG-INFY-1" })).signalId, "SIG-INFY-1");
    for (const absent of [undefined, null, ""]) assert.equal(G.parseTicket(limitBody({ signalId: absent })).signalId, null);
    for (const bad of ["sym:INFY", "-x", "a b", 12, "x".repeat(65)]) rejects(limitBody({ signalId: bad }), "signalId");
  });
});

/* ======================= guardrails: value + limits ======================= */

describe("guardrails.ticketValue", () => {
  test("LIMIT and SL are valued at price x qty (no buffer)", () => {
    assert.deepEqual(G.ticketValue(G.parseTicket(limitBody({ price: 1500.05, quantity: 3 }))), { value: 4500.15, basis: "price" });
    assert.deepEqual(G.ticketValue(G.parseTicket(slBody({ price: 1500, trigger_price: 1490, quantity: 10 }))), { value: 15_000, basis: "price" });
  });

  test("MARKET is valued at estPrice x (1 + 2%) x qty", () => {
    assert.equal(G.MARKET_BUFFER, 0.02);
    assert.deepEqual(G.ticketValue(G.parseTicket(marketBody({ estPrice: 1000, quantity: 10 }))), { value: 10_200, basis: "est_price_buffered" });
  });

  test("SL-M is valued at max(estPrice, trigger) x 1.02 x qty", () => {
    assert.equal(G.ticketValue(G.parseTicket(slmBody({ estPrice: 1000, trigger_price: 1100, quantity: 10 }))).value, 11_220);
    assert.equal(G.ticketValue(G.parseTicket(slmBody({ transaction_type: "SELL", estPrice: 1000, trigger_price: 900, quantity: 10 }))).value, 10_200);
  });

  test("value is rounded to paise", () => {
    assert.equal(G.ticketValue(G.parseTicket(marketBody({ estPrice: 333.3333, quantity: 3 }))).value, 1020);
    assert.equal(G.ticketValue(G.parseTicket(limitBody({ price: 0.0025, quantity: 7 }))).value, 0.02);
  });
});

describe("guardrails.enforceLimits", () => {
  const T = (o: Body = {}) => G.parseTicket(limitBody(o));

  test("a ticket inside every limit passes and returns its value", () => {
    assert.deepEqual(G.enforceLimits(T(), limits(), OK_CTX), { value: 15_000, basis: "price" });
  });

  test("kill switch (tradingEnabled=false) blocks first, before any other check", () => {
    conflict(() => G.enforceLimits(T(), limits({ tradingEnabled: false }), OK_CTX), "trading_disabled");
    // even with every other check failing too
    const worst = limits({ tradingEnabled: false, allowedExchanges: [], allowedProducts: [], maxQty: 1, maxOrderValueInr: 1, dailyOrderCap: 0 });
    conflict(() => G.enforceLimits(T(), worst, { connected: false, confirmedToday: 999 }), "trading_disabled");
  });

  test("no live Kite session blocks (second check)", () => {
    conflict(() => G.enforceLimits(T(), limits(), { connected: false, confirmedToday: 0 }), "broker_not_connected");
    conflict(() => G.enforceLimits(T({ exchange: "MCX" }), limits(), { connected: false, confirmedToday: 0 }), "broker_not_connected");
  });

  test("allowedExchanges: only listed exchanges pass", () => {
    const e = conflict(() => G.enforceLimits(T({ exchange: "NFO" }), limits(), OK_CTX), "exchange_not_allowed");
    assert.deepEqual(e.extra.allowed, ["NSE", "BSE"]);
    assert.ok(G.enforceLimits(T({ exchange: "NFO" }), limits({ allowedExchanges: ["NFO"] }), OK_CTX));
    conflict(() => G.enforceLimits(T({ exchange: "NSE" }), limits({ allowedExchanges: [] }), OK_CTX), "exchange_not_allowed");
  });

  test("allowedProducts: only listed products pass", () => {
    const e = conflict(() => G.enforceLimits(T({ product: "NRML" }), limits(), OK_CTX), "product_not_allowed");
    assert.deepEqual(e.extra.allowed, ["CNC", "MIS"]);
    conflict(() => G.enforceLimits(T({ product: "MTF" }), limits(), OK_CTX), "product_not_allowed");
    assert.ok(G.enforceLimits(T({ product: "MIS" }), limits(), OK_CTX));
  });

  test("maxQty: exactly at the limit passes, one over fails", () => {
    assert.ok(G.enforceLimits(T({ quantity: 100, price: 1 }), limits(), OK_CTX));
    const e = conflict(() => G.enforceLimits(T({ quantity: 101, price: 1 }), limits(), OK_CTX), "qty_over_limit");
    assert.equal(e.extra.limit, 100);
    assert.equal(e.extra.actual, 101);
  });

  test("maxOrderValueInr (LIMIT/SL): exactly at the limit passes, a paisa over fails", () => {
    assert.equal(G.enforceLimits(T({ price: 250, quantity: 100 }), limits(), OK_CTX).value, 25_000);
    const e = conflict(() => G.enforceLimits(T({ price: 2500.01, quantity: 10 }), limits(), OK_CTX), "value_over_limit");
    assert.equal(e.extra.actual, 25_000.1);
    assert.equal(e.extra.limit, 25_000);
    assert.equal(e.extra.basis, "price");
    conflict(() => G.enforceLimits(G.parseTicket(slBody({ price: 2500.01, trigger_price: 2500 })), limits(), OK_CTX), "value_over_limit");
  });

  test("maxOrderValueInr (MARKET): the 2% buffer is applied to estPrice before comparing", () => {
    const m = G.parseTicket(marketBody({ estPrice: 1000, quantity: 10 })); // 10,000 raw, 10,200 buffered
    assert.equal(G.enforceLimits(m, limits({ maxOrderValueInr: 10_200 }), OK_CTX).value, 10_200);
    const e = conflict(() => G.enforceLimits(m, limits({ maxOrderValueInr: 10_199.99 }), OK_CTX), "value_over_limit");
    assert.equal(e.extra.basis, "est_price_buffered");
    assert.equal(e.extra.actual, 10_200);
    // without the buffer 10,000 would have passed a 10,100 limit: the buffer is what blocks it
    conflict(() => G.enforceLimits(m, limits({ maxOrderValueInr: 10_100 }), OK_CTX), "value_over_limit");
  });

  test("maxOrderValueInr (SL-M): buffer on max(estPrice, trigger)", () => {
    const t = G.parseTicket(slmBody({ estPrice: 1000, trigger_price: 1100, quantity: 10 })); // 11,220
    assert.ok(G.enforceLimits(t, limits({ maxOrderValueInr: 11_220 }), OK_CTX));
    conflict(() => G.enforceLimits(t, limits({ maxOrderValueInr: 11_219.99 }), OK_CTX), "value_over_limit");
  });

  test("dailyOrderCap: below the cap passes, at the cap fails, cap 0 blocks everything", () => {
    assert.ok(G.enforceLimits(T(), limits({ dailyOrderCap: 10 }), { connected: true, confirmedToday: 9 }));
    const e = conflict(() => G.enforceLimits(T(), limits({ dailyOrderCap: 10 }), { connected: true, confirmedToday: 10 }), "daily_cap_reached");
    assert.equal(e.extra.limit, 10);
    conflict(() => G.enforceLimits(T(), limits({ dailyOrderCap: 0 }), OK_CTX), "daily_cap_reached");
  });

  test("check order: exchange, product, quantity, value, daily cap", () => {
    const bad = limits({ allowedExchanges: ["BSE"], allowedProducts: ["MIS"], maxQty: 1, maxOrderValueInr: 1, dailyOrderCap: 0 });
    conflict(() => G.enforceLimits(T(), bad, OK_CTX), "exchange_not_allowed");
    conflict(() => G.enforceLimits(T(), { ...bad, allowedExchanges: ["NSE"] }, OK_CTX), "product_not_allowed");
    conflict(() => G.enforceLimits(T(), { ...bad, allowedExchanges: ["NSE"], allowedProducts: ["CNC"] }, OK_CTX), "qty_over_limit");
    conflict(() => G.enforceLimits(T(), { ...bad, allowedExchanges: ["NSE"], allowedProducts: ["CNC"], maxQty: 10 }, OK_CTX), "value_over_limit");
    conflict(() => G.enforceLimits(T(), { ...bad, allowedExchanges: ["NSE"], allowedProducts: ["CNC"], maxQty: 10, maxOrderValueInr: 15_000 }, OK_CTX), "daily_cap_reached");
  });

  test("fails CLOSED on a malformed (e.g. rebuilt-from-storage) ticket or a corrupt limits row", () => {
    const good = T();
    // These all passed before the fix: NaN / 0 compare false against every limit.
    conflict(() => G.enforceLimits({ ...good, quantity: NaN }, limits(), OK_CTX), "ticket_invalid");
    conflict(() => G.enforceLimits({ ...good, quantity: 0 }, limits(), OK_CTX), "ticket_invalid");
    conflict(() => G.enforceLimits({ ...good, quantity: 1.5 }, limits(), OK_CTX), "ticket_invalid");
    conflict(() => G.enforceLimits({ ...good, price: null }, limits(), OK_CTX), "ticket_invalid");
    conflict(() => G.enforceLimits({ ...good, price: NaN }, limits(), OK_CTX), "ticket_invalid");
    const m = G.parseTicket(marketBody());
    conflict(() => G.enforceLimits({ ...m, estPrice: null }, limits(), OK_CTX), "ticket_invalid");
    conflict(() => G.enforceLimits({ ...m, estPrice: 0 }, limits(), OK_CTX), "ticket_invalid");
    const slm = G.parseTicket(slmBody());
    conflict(() => G.enforceLimits({ ...slm, trigger_price: null }, limits(), OK_CTX), "ticket_invalid");
    // corrupt limits: NaN must block, not pass
    conflict(() => G.enforceLimits(good, limits({ maxQty: NaN }), OK_CTX), "qty_over_limit");
    conflict(() => G.enforceLimits(good, limits({ maxOrderValueInr: NaN }), OK_CTX), "value_over_limit");
    conflict(() => G.enforceLimits(good, limits({ dailyOrderCap: NaN }), OK_CTX), "daily_cap_reached");
    conflict(() => G.enforceLimits(good, limits(), { connected: true, confirmedToday: NaN }), "daily_cap_reached");
  });

  test("confirm-time re-check: a stored payload rebuilds the same ticket, and current (lowered) limits apply", () => {
    const tickets = [
      G.parseTicket(limitBody({ signalId: "SIG-1", validity: "IOC" })),
      G.parseTicket(slBody({ transaction_type: "SELL", price: 1490, trigger_price: 1500 })),
      G.parseTicket(slmBody({ exchange: "nfo", tradingsymbol: "nifty2511324000ce", product: "NRML", quantity: 75 })),
      G.parseTicket(marketBody({ tradingsymbol: "M&M", estPrice: 3012.35 })),
      G.parseTicket(limitBody({ exchange: "CDS", tradingsymbol: "USDINR25NOVFUT", price: 84.1225, product: "NRML" })),
    ];
    for (const t of tickets) {
      const back = G.ticketFromPayload(G.kitePayload(t, G.intentTag(crypto.randomUUID())), t.estPrice, t.signalId);
      assert.deepEqual(back, t);
      assert.deepEqual(G.ticketValue(back), G.ticketValue(t));
    }
    const t = tickets[0] as OrderTicket;
    const back = G.ticketFromPayload(G.kitePayload(t, "tdm0123456789abcdef0"), t.estPrice, t.signalId);
    assert.ok(G.enforceLimits(back, limits(), OK_CTX));
    conflict(() => G.enforceLimits(back, limits({ maxQty: 9 }), OK_CTX), "qty_over_limit");
    conflict(() => G.enforceLimits(back, limits({ maxOrderValueInr: 14_999.99 }), OK_CTX), "value_over_limit");
    conflict(() => G.enforceLimits(back, limits({ allowedExchanges: ["BSE"] }), OK_CTX), "exchange_not_allowed");
    conflict(() => G.enforceLimits(back, limits({ tradingEnabled: false }), OK_CTX), "trading_disabled");
  });
});

/* ======================= guardrails: payload, tag, describe, limits update ======================= */

// The relay's own whitelist, read from its source so the two can't drift apart silently.
const RELAY_SRC = readFileSync(RELAY_PATH, "utf8");
const RELAY_ALLOWED: string[] = JSON.parse((/const ALLOWED_PARAMS = (\[[^\]]*\]);/.exec(RELAY_SRC) as RegExpExecArray)[1] as string);
const RELAY_VALUE_RE = new RegExp((/const PARAM_VALUE = \/(.+)\/;/.exec(RELAY_SRC) as RegExpExecArray)[1] as string);

describe("guardrails.kitePayload / ticketFromPayload / intentTag / describeTicket", () => {
  const TAG = "tdm0123456789abcdef0";

  test("LIMIT payload: exact whitelisted string fields, no trigger, no market protection, no estPrice", () => {
    const p = G.kitePayload(G.parseTicket(limitBody({ price: 1500.5 })), TAG);
    assert.deepEqual(p, { exchange: "NSE", tradingsymbol: "INFY", transaction_type: "BUY", order_type: "LIMIT", quantity: "10", product: "CNC", validity: "DAY", tag: TAG, price: "1500.5" });
  });

  test("MARKET payload: market_protection=-1, no price/trigger", () => {
    const p = G.kitePayload(G.parseTicket(marketBody()), TAG);
    assert.equal(p.market_protection, "-1");
    assert.equal("price" in p, false);
    assert.equal("trigger_price" in p, false);
    assert.equal("estPrice" in p, false);
  });

  test("SL payload has price + trigger; SL-M payload has trigger + market_protection", () => {
    const sl = G.kitePayload(G.parseTicket(slBody()), TAG);
    assert.equal(sl.price, "1500");
    assert.equal(sl.trigger_price, "1490");
    assert.equal("market_protection" in sl, false);
    const slm = G.kitePayload(G.parseTicket(slmBody()), TAG);
    assert.equal("price" in slm, false);
    assert.equal(slm.trigger_price, "1510");
    assert.equal(slm.market_protection, "-1");
  });

  test("every Worker payload passes the relay's param whitelist and value regex (edge symbols/prices)", () => {
    const cases = [
      limitBody({ tradingsymbol: "M&M" }),
      limitBody({ tradingsymbol: "BAJAJ-AUTO", price: 10_000_000, quantity: G.HARD_MAX_QTY }),
      limitBody({ tradingsymbol: "A".repeat(40), price: 0.0001 }),
      limitBody({ exchange: "CDS", tradingsymbol: "USDINR25NOVFUT", price: 0.0025, validity: "IOC" }),
      slBody({ exchange: "NFO", tradingsymbol: "NIFTY2511324000CE", price: 101.05, trigger_price: 100 }),
      slmBody({ exchange: "MCX", tradingsymbol: "GOLDM25DECFUT" }),
      marketBody({ exchange: "BSE", tradingsymbol: "SBIN.BE", estPrice: 8_765_432.1234 }),
    ];
    for (const b of cases) {
      const p = G.kitePayload(G.parseTicket(b), G.intentTag(crypto.randomUUID()));
      for (const [k, val] of Object.entries(p)) {
        assert.ok(RELAY_ALLOWED.includes(k), `relay would drop ${k}`);
        assert.ok(RELAY_VALUE_RE.test(val), `relay would refuse ${k}=${val}`);
      }
      assert.match(p.quantity as string, /^[1-9][0-9]{0,6}$/);
    }
  });

  test("intentTag: 'tdm' + 17 hex = 20 chars (Kite's tag max), matches TAG_RE, deterministic", () => {
    const id = "0f1e2d3c-4b5a-4968-8776-655443322110";
    const tag = G.intentTag(id);
    assert.equal(tag, "tdm0f1e2d3c4b5a49688");
    assert.equal(tag.length, 20);
    assert.match(tag, G.TAG_RE);
    assert.equal(G.intentTag(id), tag);
    for (let i = 0; i < 200; i++) assert.match(G.intentTag(crypto.randomUUID()), G.TAG_RE);
    for (const bad of ["tdm0123456789abcdef", "tdm0123456789abcdef01", "TDM0123456789abcdef0", "tdm0123456789ABCDEF0", "xyz0123456789abcdef0"]) assert.equal(G.TAG_RE.test(bad), false, bad);
  });

  test("ticketFromPayload never invents a SELL or IOC", () => {
    const t = G.ticketFromPayload({ exchange: "NSE", tradingsymbol: "INFY", transaction_type: "sell", quantity: "1", product: "CNC", order_type: "LIMIT", validity: "GTT", price: "1" }, null, null);
    assert.equal(t.transaction_type, "BUY");
    assert.equal(t.validity, "DAY");
  });

  test("describeTicket lines", () => {
    assert.equal(G.describeTicket(G.parseTicket(limitBody())), "BUY 10 NSE:INFY LIMIT @ 1500 · CNC · DAY");
    assert.equal(G.describeTicket(G.parseTicket(slBody())), "BUY 10 NSE:INFY SL @ 1500 (trigger 1490) · CNC · DAY");
    assert.equal(G.describeTicket(G.parseTicket(slmBody())), "BUY 10 NSE:INFY SL-M (trigger 1510, est 1500) · CNC · DAY");
    assert.equal(G.describeTicket(G.parseTicket(marketBody({ transaction_type: "SELL", validity: "IOC" }))), "SELL 10 NSE:INFY MARKET (est 1500) · CNC · IOC");
  });
});

describe("guardrails.parseLimitsUpdate (hard ceilings)", () => {
  const cur = limits();
  const rejectsL = (body: Body, field: string) => {
    const e = httpErr(() => G.parseLimitsUpdate(body, cur));
    assert.equal(e.status, 400);
    assert.equal(e.extra?.field, field);
  };

  test("hard ceilings are what the spec says", () => {
    assert.equal(G.HARD_MAX_ORDER_VALUE_INR, 10_000_000);
    assert.equal(G.HARD_MAX_QTY, 100_000);
    assert.equal(G.HARD_MAX_DAILY_CAP, 500);
  });

  test("omitted fields keep their current value; tradingEnabled is never returned", () => {
    const out = G.parseLimitsUpdate({}, cur);
    assert.deepEqual(out, { maxOrderValueInr: 25_000, maxQty: 100, dailyOrderCap: 10, allowedExchanges: ["NSE", "BSE"], allowedProducts: ["CNC", "MIS"] });
    assert.equal("tradingEnabled" in out, false);
  });

  test("tradingEnabled can't be changed here (kill switch has its own confirmed endpoint)", () => {
    rejectsL({ tradingEnabled: true }, "tradingEnabled");
    rejectsL({ tradingEnabled: false }, "tradingEnabled");
    rejectsL({ tradingEnabled: undefined }, "tradingEnabled");
  });

  test("maxOrderValueInr: 1..10,000,000, rounded to paise", () => {
    assert.equal(G.parseLimitsUpdate({ maxOrderValueInr: 1 }, cur).maxOrderValueInr, 1);
    assert.equal(G.parseLimitsUpdate({ maxOrderValueInr: 10_000_000 }, cur).maxOrderValueInr, 10_000_000);
    assert.equal(G.parseLimitsUpdate({ maxOrderValueInr: 1234.567 }, cur).maxOrderValueInr, 1234.57);
    for (const bad of [0, 0.99, -1, 10_000_000.01, "5000", NaN, null, Infinity]) rejectsL({ maxOrderValueInr: bad }, "maxOrderValueInr");
  });

  test("maxQty: integer 1..100,000", () => {
    assert.equal(G.parseLimitsUpdate({ maxQty: 1 }, cur).maxQty, 1);
    assert.equal(G.parseLimitsUpdate({ maxQty: 100_000 }, cur).maxQty, 100_000);
    for (const bad of [0, -1, 100_001, 1.5, "10", null]) rejectsL({ maxQty: bad }, "maxQty");
  });

  test("dailyOrderCap: integer 0..500 (0 = no orders today)", () => {
    assert.equal(G.parseLimitsUpdate({ dailyOrderCap: 0 }, cur).dailyOrderCap, 0);
    assert.equal(G.parseLimitsUpdate({ dailyOrderCap: 500 }, cur).dailyOrderCap, 500);
    for (const bad of [-1, 501, 2.5, "3", null]) rejectsL({ dailyOrderCap: bad }, "dailyOrderCap");
  });

  test("allowedExchanges / allowedProducts: non-empty subsets, de-duplicated, canonical order, case-insensitive", () => {
    assert.deepEqual(G.parseLimitsUpdate({ allowedExchanges: ["nfo", "NSE", "NSE", "mcx"] }, cur).allowedExchanges, ["NSE", "NFO", "MCX"]);
    assert.deepEqual(G.parseLimitsUpdate({ allowedProducts: ["mis", "NRML"] }, cur).allowedProducts, ["MIS", "NRML"]);
    for (const bad of [[], ["NYSE"], ["NSE", "LSE"], "NSE", null, [1], new Array(8).fill("NSE")]) rejectsL({ allowedExchanges: bad }, "allowedExchanges");
    for (const bad of [[], ["BO"], "CNC", new Array(5).fill("CNC")]) rejectsL({ allowedProducts: bad }, "allowedProducts");
  });
});

/* ======================= kite.ts ======================= */

describe("kite checksums (vs independently computed SHA-256 hex)", () => {
  test("sha256 sanity vector", async () => {
    assert.equal(await K.sessionChecksum("a", "b", "c"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("sessionChecksum = SHA-256(api_key + request_token + api_secret)", async () => {
    const vectors = [
      ["kitekey123", "reqTok0123456789abcdef", "s3cr3t-api-secret"],
      ["xxxxxxxxxxxxxxxx", "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"],
      ["", "", ""],
    ] as const;
    for (const [k, rt, s] of vectors) {
      const got = await K.sessionChecksum(k, rt, s);
      assert.equal(got, sha256(k + rt + s));
      assert.match(got, /^[0-9a-f]{64}$/);
    }
    assert.notEqual(await K.sessionChecksum("k", "r", "s"), await K.sessionChecksum("r", "k", "s"));
  });

  test("postbackChecksum = SHA-256(order_id + order_timestamp + api_secret)", async () => {
    const id = "251111000123456";
    const ts = "2026-11-11 10:15:42";
    const secret = "s3cr3t-api-secret";
    assert.equal(await K.postbackChecksum(id, ts, secret), sha256(id + ts + secret));
    assert.notEqual(await K.postbackChecksum(id, ts, secret), sha256(ts + id + secret));
    assert.notEqual(await K.postbackChecksum(id, ts, secret), await K.postbackChecksum(id, ts, `${secret}x`));
  });
});

describe("kite.loginUrl", () => {
  test("Kite Connect v3 login URL with api_key and redirect_params state", () => {
    const state = "AbC_dEf-0123456789abcdefghijklmnopqrstuvwxy"; // 43 chars base64url, like randomToken()
    const raw = K.loginUrl("kitekey123", state);
    const u = new URL(raw);
    assert.equal(`${u.origin}${u.pathname}`, K.KITE_LOGIN_URL);
    assert.equal(K.KITE_LOGIN_URL, "https://kite.zerodha.com/connect/login");
    assert.equal(u.searchParams.get("v"), "3");
    assert.equal(u.searchParams.get("api_key"), "kitekey123");
    assert.equal(u.searchParams.get("redirect_params"), `state=${state}`);
    assert.ok(raw.includes(`redirect_params=state%3D${state}`), raw); // '=' URL-encoded once, as Kite expects
    assert.deepEqual([...u.searchParams.keys()].sort(), ["api_key", "redirect_params", "v"]);
  });

  test("a hostile state can't inject top-level query params", () => {
    const u = new URL(K.loginUrl("k", "x&api_key=evil&v=1"));
    assert.equal(u.searchParams.get("api_key"), "k");
    assert.equal(u.searchParams.get("v"), "3");
    assert.equal(u.searchParams.getAll("api_key").length, 1);
  });
});

const istFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
function ist(ms: number): string {
  const o: Record<string, string> = {};
  for (const p of istFmt.formatToParts(new Date(ms))) o[p.type] = p.value;
  return `${o.year}-${o.month}-${o.day} ${o.hour}:${o.minute}:${o.second}`;
}
const Z = (s: string) => Date.parse(s);

describe("IST time maths (Kite tokens expire 06:00 IST; daily cap resets at IST midnight)", () => {
  test("nextKiteExpiry: the first 06:00 IST strictly after now", () => {
    const cases: [string, string][] = [
      ["2026-11-11T03:30:00.000Z", "2026-11-12T00:30:00.000Z"], // 09:00 IST login -> next morning
      ["2026-11-10T20:30:00.000Z", "2026-11-11T00:30:00.000Z"], // 02:00 IST login -> same morning (4h)
      ["2026-11-11T00:29:59.999Z", "2026-11-11T00:30:00.000Z"], // 05:59:59.999 IST -> 1 ms later
      ["2026-11-11T00:30:00.000Z", "2026-11-12T00:30:00.000Z"], // exactly 06:00 IST -> strictly after
      ["2026-11-10T18:30:00.000Z", "2026-11-11T00:30:00.000Z"], // IST midnight
      ["2026-11-10T18:29:59.999Z", "2026-11-11T00:30:00.000Z"], // 23:59:59.999 IST
      ["2026-11-10T23:59:59.999Z", "2026-11-11T00:30:00.000Z"], // UTC midnight-ish = 05:29 IST
      ["2026-11-11T00:00:00.000Z", "2026-11-11T00:30:00.000Z"], // UTC midnight = 05:30 IST
      ["2026-12-31T20:00:00.000Z", "2027-01-01T00:30:00.000Z"], // 01:30 IST on 1 Jan (year boundary)
      ["2026-12-31T10:00:00.000Z", "2027-01-01T00:30:00.000Z"], // 15:30 IST on 31 Dec
      ["2028-02-28T20:00:00.000Z", "2028-02-29T00:30:00.000Z"], // leap day
      ["2027-02-28T10:00:00.000Z", "2027-03-01T00:30:00.000Z"], // month end, non-leap
      ["2026-03-08T07:00:00.000Z", "2026-03-09T00:30:00.000Z"], // US DST change day: IST has none
      ["2026-03-29T01:00:00.000Z", "2026-03-30T00:30:00.000Z"], // EU DST change day
      ["2026-11-01T06:00:00.000Z", "2026-11-02T00:30:00.000Z"], // US DST end
    ];
    for (const [now, want] of cases) {
      assert.equal(K.nextKiteExpiry(Z(now)), want, now);
      assert.equal(U.next0600Ist(Z(now)), want, `util ${now}`);
    }
  });

  test("istDayStartIso: IST midnight at or before now", () => {
    const cases: [string, string][] = [
      ["2026-11-11T03:30:00.000Z", "2026-11-10T18:30:00.000Z"],
      ["2026-11-10T18:30:00.000Z", "2026-11-10T18:30:00.000Z"], // exactly midnight IST
      ["2026-11-10T18:29:59.999Z", "2026-11-09T18:30:00.000Z"], // 1 ms before
      ["2026-11-11T00:00:00.000Z", "2026-11-10T18:30:00.000Z"], // UTC midnight is still the IST day
      ["2027-01-01T00:00:00.000Z", "2026-12-31T18:30:00.000Z"],
    ];
    for (const [now, want] of cases) {
      assert.equal(K.istDayStartIso(Z(now)), want, now);
      assert.equal(U.istDayStartIso(Z(now)), want, `util ${now}`);
    }
  });

  test("property: vs Intl Asia/Kolkata over 2000-2040 (expiry is 06:00:00 IST, within (now, now+24h]; day start is 00:00:00 IST)", () => {
    const r = lcg(7);
    const lo = Z("2000-01-01T00:00:00Z");
    const span = Z("2040-12-31T00:00:00Z") - lo;
    for (let i = 0; i < 5000; i++) {
      const now = lo + Math.floor(r() * span);
      const exp = Date.parse(K.nextKiteExpiry(now));
      assert.ok(exp > now && exp - now <= 86_400_000, `${new Date(now).toISOString()}`);
      assert.equal(ist(exp).slice(11), "06:00:00");
      assert.equal(exp % 1000, 0);
      const start = Date.parse(K.istDayStartIso(now));
      assert.ok(start <= now && now - start < 86_400_000);
      assert.equal(ist(start).slice(11), "00:00:00");
      assert.equal(ist(start).slice(0, 10), ist(now).slice(0, 10), "same IST calendar day");
      assert.equal(U.next0600Ist(now), K.nextKiteExpiry(now));
      assert.equal(U.istDayStartIso(now), K.istDayStartIso(now));
    }
  });
});

describe("kite config helpers", () => {
  test("kiteConfigured needs both key and secret", () => {
    assert.equal(K.kiteConfigured({ KITE_API_KEY: "k", KITE_API_SECRET: "s" }), true);
    assert.equal(K.kiteConfigured({ KITE_API_KEY: "k" }), false);
    assert.equal(K.kiteConfigured({ KITE_API_SECRET: "s" }), false);
    assert.equal(K.kiteConfigured({ KITE_API_KEY: "", KITE_API_SECRET: "s" }), false);
  });

  test("relayConfigured: RELAY_TOKEN must be >= 32 chars", () => {
    assert.equal(K.relayConfigured({ RELAY_TOKEN: "x".repeat(32) }), true);
    assert.equal(K.relayConfigured({ RELAY_TOKEN: "x".repeat(31) }), false);
    assert.equal(K.relayConfigured({}), false);
  });

  test("kiteBase: loopback override honoured ONLY in development", () => {
    assert.equal(K.kiteBase({ APP_ENV: "development", KITE_API_BASE: "http://127.0.0.1:9999" }), "http://127.0.0.1:9999");
    assert.equal(K.kiteBase({ APP_ENV: "production", KITE_API_BASE: "http://127.0.0.1:9999" }), K.KITE_API);
    assert.equal(K.kiteBase({ APP_ENV: undefined, KITE_API_BASE: "http://127.0.0.1:9999" } as any), K.KITE_API);
    for (const bad of ["https://evil.example", "http://10.0.0.1:80", "http://127.0.0.1", "http://127.0.0.1:8080/x", "http://localhost:8080", "http://127.0.0.1:8080@evil.example"]) {
      assert.equal(K.kiteBase({ APP_ENV: "development", KITE_API_BASE: bad }), "https://api.kite.trade", bad);
    }
  });

  test("cleanKiteMessage strips control chars and caps at 200", () => {
    assert.equal(K.cleanKiteMessage("bad\u0000\ninput\u007f "), "bad  input");
    assert.equal(K.cleanKiteMessage("x".repeat(300)).length, 200);
    assert.equal(K.cleanKiteMessage(42), "");
    assert.equal(new K.KiteError(403, "TokenException", "m").tokenProblem, true);
    assert.equal(new K.KiteError(400, "InputException", "m").tokenProblem, false);
  });
});

describe("kite access-token vault (kite.ts encryptToken/decryptToken)", () => {
  const SECRET = "kite-api-secret-0123456789abcdef";
  const TOKEN = "accessTokenAbc123XYZ7890qwerty";
  const AAD = K.tokenAad("11111111-2222-4333-8444-555555555555", "AB1234");

  test("round trip; AAD format", async () => {
    assert.equal(AAD, "kite:11111111-2222-4333-8444-555555555555:AB1234");
    const { ct, iv } = await K.encryptToken(SECRET, TOKEN, AAD);
    assert.equal(await K.decryptToken(SECRET, ct, iv, AAD), TOKEN);
  });

  test("format matches an independent node:crypto HKDF-SHA-256 + AES-256-GCM decrypt", async () => {
    const { ct, iv } = await K.encryptToken(SECRET, TOKEN, AAD);
    const key = Buffer.from(hkdfSync("sha256", SECRET, "tudumm/broker/v1", "kite-access-token", 32));
    const raw = Buffer.from(ct, "base64url");
    const ivb = Buffer.from(iv, "base64url");
    assert.equal(ivb.length, 12, "96-bit IV");
    const d = createDecipheriv("aes-256-gcm", key, ivb);
    d.setAAD(Buffer.from(AAD));
    d.setAuthTag(raw.subarray(raw.length - 16));
    const pt = Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString("utf8");
    assert.equal(pt, TOKEN);
  });

  test("wrong secret, other row/user (AAD), tampered ct/iv, truncation, junk -> null", async () => {
    const { ct, iv } = await K.encryptToken(SECRET, TOKEN, AAD);
    assert.equal(await K.decryptToken(`${SECRET}x`, ct, iv, AAD), null);
    assert.equal(await K.decryptToken(SECRET, ct, iv, K.tokenAad("11111111-2222-4333-8444-555555555556", "AB1234")), null);
    assert.equal(await K.decryptToken(SECRET, ct, iv, K.tokenAad("11111111-2222-4333-8444-555555555555", "AB1235")), null);
    const flip = (s: string, i: number) => {
      const b = Buffer.from(s, "base64url");
      b[i] = (b[i] as number) ^ 0x01;
      return b.toString("base64url");
    };
    assert.equal(await K.decryptToken(SECRET, flip(ct, 0), iv, AAD), null);
    assert.equal(await K.decryptToken(SECRET, flip(ct, Buffer.from(ct, "base64url").length - 1), iv, AAD), null); // auth tag
    assert.equal(await K.decryptToken(SECRET, ct, flip(iv, 5), AAD), null);
    assert.equal(await K.decryptToken(SECRET, ct.slice(0, -4), iv, AAD), null);
    assert.equal(await K.decryptToken(SECRET, "", iv, AAD), null);
    assert.equal(await K.decryptToken(SECRET, ct, "", AAD), null);
    assert.equal(await K.decryptToken(SECRET, "!!!not base64!!!", iv, AAD), null);
  });

  test("a fresh random IV per encryption", async () => {
    const seen = new Set<string>();
    const cts = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { ct, iv } = await K.encryptToken(SECRET, TOKEN, AAD);
      seen.add(iv);
      cts.add(ct);
    }
    assert.equal(seen.size, 50);
    assert.equal(cts.size, 50);
  });
});

describe("kite HTTP client (fetch mocked; no network)", () => {
  const ENV: any = { KITE_API_KEY: "kitekey123", KITE_API_SECRET: "s3cr3t-api-secret", APP_ENV: "production" };
  const real = globalThis.fetch;
  let calls: { url: string; init: any }[] = [];
  const mock = (fn: (url: string, init: any) => Response | Promise<Response>) => {
    calls = [];
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return fn(String(url), init);
    }) as any;
  };
  const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  after(() => {
    globalThis.fetch = real;
  });

  test("GET: Kite v3 header, token auth, query, returns data", async () => {
    mock(() => jsonRes(200, { status: "success", data: [{ order_id: "1" }] }));
    const d = await K.kiteCall(ENV, { method: "GET", path: "/orders", accessToken: "acc123", query: { a: "b c" } });
    assert.deepEqual(d, [{ order_id: "1" }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://api.kite.trade/orders?a=b+c");
    const h = calls[0]?.init.headers;
    assert.equal(h["X-Kite-Version"], "3");
    assert.equal(h.authorization, "token kitekey123:acc123");
    assert.equal(calls[0]?.init.method, "GET");
  });

  test("exchangeRequestToken: POSTs api_key, request_token and the SHA-256 checksum as a form", async () => {
    mock(() => jsonRes(200, { status: "success", data: { user_id: " ab1234 ", access_token: "AccessTok0123456789" } }));
    const out = await K.exchangeRequestToken(ENV, "reqTok0123456789");
    assert.deepEqual(out, { userId: "AB1234", accessToken: "AccessTok0123456789" });
    const c = calls[0] as { url: string; init: any };
    assert.equal(c.url, "https://api.kite.trade/session/token");
    assert.equal(c.init.method, "POST");
    assert.equal(c.init.headers["content-type"], "application/x-www-form-urlencoded");
    assert.equal(c.init.headers.authorization, undefined, "no access token yet");
    const form = new URLSearchParams(c.init.body);
    assert.deepEqual(Object.fromEntries(form), { api_key: "kitekey123", request_token: "reqTok0123456789", checksum: sha256("kitekey123reqTok0123456789s3cr3t-api-secret") });
  });

  test("exchangeRequestToken rejects an unexpected session payload", async () => {
    for (const data of [{ user_id: "AB1234" }, { user_id: "A", access_token: "AccessTok0123456789" }, { user_id: "AB1234", access_token: "short" }, { user_id: "AB 1234", access_token: "AccessTok0123456789" }, null]) {
      mock(() => jsonRes(200, { status: "success", data }));
      const e = await K.exchangeRequestToken(ENV, "reqTok0123456789").then(
        () => null,
        (x) => x,
      );
      assert.ok(e instanceof K.KiteError);
      assert.equal(e.errorType, "DataException");
    }
  });

  test("error mapping: Kite error_type, 403 => TokenException, junk types, non-JSON, network, timeout, not configured", async () => {
    const run = async () =>
      K.kiteCall(ENV, { method: "GET", path: "/user/margins", accessToken: "a" }).then(
        () => null,
        (x) => x,
      );
    mock(() => jsonRes(403, { status: "error", error_type: "TokenException", message: "Incorrect `api_key` or `access_token`." }));
    let e = await run();
    assert.equal(e.status, 403);
    assert.equal(e.errorType, "TokenException");
    assert.equal(e.tokenProblem, true);
    mock(() => new Response("<html>forbidden</html>", { status: 403 }));
    e = await run();
    assert.equal(e.errorType, "TokenException");
    mock(() => jsonRes(400, { status: "error", error_type: "Input Exception<script>", message: "x" }));
    e = await run();
    assert.equal(e.errorType, "GeneralException");
    mock(() => new Response("oops", { status: 502 }));
    e = await run();
    assert.equal(e.status, 502);
    assert.equal(e.message, "Kite returned HTTP 502");
    mock(() => jsonRes(200, { status: "error", message: "nope" }));
    e = await run();
    assert.ok(e instanceof K.KiteError, "200 without status=success is still an error");
    mock(() => {
      throw new TypeError("fetch failed");
    });
    e = await run();
    assert.equal(e.status, 504);
    assert.equal(e.errorType, "NetworkException");
    mock(() => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    e = await run();
    assert.equal(e.errorType, "Timeout");
    mock(() => jsonRes(200, { status: "success", data: {} }));
    e = await K.kiteCall({ ...ENV, KITE_API_KEY: undefined }, { method: "GET", path: "/orders" }).then(
      () => null,
      (x) => x,
    );
    assert.equal(e.status, 503);
    assert.equal(e.errorType, "NotConfigured");
    assert.equal(calls.length, 0, "no request without an API key");
  });
});

/* ======================= vault.ts ======================= */

describe("vault.ts (BROKER_VAULT_KEY or adapter fallback secret)", () => {
  const KITE_SECRET = "kite-api-secret-0123456789abcdef";
  const VAULT_KEY = "v".repeat(32);
  const kite: any = { id: "kite", vaultFallbackSecret: (env: any) => env.KITE_API_SECRET };
  const upstox: any = { id: "upstox", vaultFallbackSecret: (env: any) => env.UPSTOX_SECRET };
  const bare: any = { id: "dhan" }; // no fallback secret
  const AAD = V.credsAad("kite", "conn-1", "AB1234");

  test("credsAad format", () => {
    assert.equal(AAD, "kite:conn-1:AB1234");
  });

  test("key id: BROKER_VAULT_KEY >= 32 chars -> v1; else <broker>:app fallback; else null", () => {
    assert.equal(V.currentKid({ BROKER_VAULT_KEY: VAULT_KEY, KITE_API_SECRET: KITE_SECRET } as any, kite), "v1");
    assert.equal(V.currentKid({ BROKER_VAULT_KEY: VAULT_KEY } as any, bare), "v1");
    assert.equal(V.currentKid({ BROKER_VAULT_KEY: "v".repeat(31), KITE_API_SECRET: KITE_SECRET } as any, kite), "kite:app");
    assert.equal(V.currentKid({ KITE_API_SECRET: KITE_SECRET } as any, kite), "kite:app");
    assert.equal(V.currentKid({ BROKER_VAULT_KEY: "v".repeat(31) } as any, kite), null);
    assert.equal(V.currentKid({} as any, kite), null);
    assert.equal(V.currentKid({ KITE_API_SECRET: "" } as any, kite), null);
    assert.equal(V.currentKid({ KITE_API_SECRET: KITE_SECRET } as any, bare), null);
  });

  test("neither key set: seal throws, open returns null", async () => {
    await assert.rejects(V.seal({} as any, kite, "creds", AAD), /vault: no key material/);
    await assert.rejects(V.seal({ BROKER_VAULT_KEY: "short" } as any, bare, "creds", AAD), /vault: no key material/);
    assert.equal(await V.open({} as any, kite, "AAAA", "AAAAAAAAAAAAAAAA", "v1", AAD), null);
  });

  test("round trip with v1 and with the fallback; wrong/rotated key fails", async () => {
    const envV1: any = { BROKER_VAULT_KEY: VAULT_KEY, KITE_API_SECRET: KITE_SECRET };
    const a = await V.seal(envV1, kite, "token-plaintext", AAD);
    assert.equal(a.kid, "v1");
    assert.equal(await V.open(envV1, kite, a.ct, a.iv, a.kid, AAD), "token-plaintext");
    assert.equal(await V.open({ ...envV1, BROKER_VAULT_KEY: "w".repeat(32) }, kite, a.ct, a.iv, a.kid, AAD), null, "wrong key");
    assert.equal(await V.open({ KITE_API_SECRET: KITE_SECRET } as any, kite, a.ct, a.iv, a.kid, AAD), null, "key removed");
    assert.equal(await V.open({ ...envV1, BROKER_VAULT_KEY: "v".repeat(31) } as any, kite, a.ct, a.iv, a.kid, AAD), null, "key too short now");
    assert.equal(await V.open(envV1, kite, a.ct, a.iv, "kite:app", AAD), null, "same ct, other kid");

    const envFb: any = { KITE_API_SECRET: KITE_SECRET };
    const b = await V.seal(envFb, kite, "token-plaintext", AAD);
    assert.equal(b.kid, "kite:app");
    assert.equal(await V.open(envFb, kite, b.ct, b.iv, b.kid, AAD), "token-plaintext");
    assert.equal(await V.open({ KITE_API_SECRET: `${KITE_SECRET}x` } as any, kite, b.ct, b.iv, b.kid, AAD), null, "rotated secret");
    // Adding BROKER_VAULT_KEY later switches NEW ciphertexts to v1 but old ones still open.
    assert.equal(V.currentKid({ ...envFb, BROKER_VAULT_KEY: VAULT_KEY }, kite), "v1");
    assert.equal(await V.open({ ...envFb, BROKER_VAULT_KEY: VAULT_KEY }, kite, b.ct, b.iv, b.kid, AAD), "token-plaintext");
  });

  test("kids are scoped: unknown kid, another broker's kid, another broker's adapter -> null", async () => {
    const env: any = { BROKER_VAULT_KEY: VAULT_KEY, KITE_API_SECRET: KITE_SECRET, UPSTOX_SECRET: KITE_SECRET };
    const a = await V.seal(env, kite, "p", AAD);
    assert.equal(await V.open(env, kite, a.ct, a.iv, "v2", AAD), null);
    assert.equal(await V.open(env, kite, a.ct, a.iv, "upstox:app", AAD), null);
    assert.equal(await V.open(env, upstox, a.ct, a.iv, "v1", AAD), null, "HKDF info binds the broker id");
    const fb = await V.seal({ KITE_API_SECRET: KITE_SECRET } as any, kite, "p", AAD);
    assert.equal(await V.open(env, upstox, fb.ct, fb.iv, "kite:app", AAD), null);
  });

  test("tamper / AAD mismatch -> null", async () => {
    const env: any = { BROKER_VAULT_KEY: VAULT_KEY };
    const a = await V.seal(env, bare, "secret-json", AAD);
    const b = Buffer.from(a.ct, "base64url");
    b[3] = (b[3] as number) ^ 0x80;
    assert.equal(await V.open(env, bare, b.toString("base64url"), a.iv, a.kid, AAD), null);
    const ivb = Buffer.from(a.iv, "base64url");
    ivb[0] = (ivb[0] as number) ^ 0x01;
    assert.equal(await V.open(env, bare, a.ct, ivb.toString("base64url"), a.kid, AAD), null);
    assert.equal(await V.open(env, bare, a.ct, a.iv, a.kid, V.credsAad("kite", "conn-2", "AB1234")), null);
    assert.equal(await V.open(env, bare, "", a.iv, a.kid, AAD), null);
    assert.equal(await V.open(env, bare, a.ct, "", a.kid, AAD), null);
  });

  test("unique 96-bit IV per seal; format matches node:crypto HKDF(info=broker-creds:<id>) + AES-256-GCM", async () => {
    const env: any = { BROKER_VAULT_KEY: VAULT_KEY };
    const ivs = new Set<string>();
    for (let i = 0; i < 50; i++) ivs.add((await V.seal(env, kite, "p", AAD)).iv);
    assert.equal(ivs.size, 50);
    const a = await V.seal(env, kite, "independent-check", AAD);
    const key = Buffer.from(hkdfSync("sha256", VAULT_KEY, "tudumm/broker/v1", "broker-creds:kite", 32));
    const raw = Buffer.from(a.ct, "base64url");
    const iv = Buffer.from(a.iv, "base64url");
    assert.equal(iv.length, 12);
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAAD(Buffer.from(AAD));
    d.setAuthTag(raw.subarray(raw.length - 16));
    assert.equal(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString("utf8"), "independent-check");
  });

  test("the kite.ts token key and the vault key are domain-separated even from the same secret", async () => {
    const t = await K.encryptToken(KITE_SECRET, "tok", "same-aad");
    assert.equal(await V.open({ KITE_API_SECRET: KITE_SECRET } as any, kite, t.ct, t.iv, "kite:app", "same-aad"), null);
  });
});

/* ======================= util.ts ======================= */

describe("util.ts scalar helpers", () => {
  test("pick keeps only listed finite scalars, cleans + caps strings", () => {
    const out = U.pick({ a: "x\u0000y", b: 1, c: NaN, d: true, e: null, f: { nested: 1 }, g: "z".repeat(300), h: "not listed" }, ["a", "b", "c", "d", "e", "f", "g"]);
    assert.deepEqual(Object.keys(out).sort(), ["a", "b", "d", "e", "g"]);
    assert.equal(out.a, "x y");
    assert.equal((out.g as string).length, 200);
    assert.deepEqual(U.pick(null, ["a"]), {});
  });

  test("numbers / n / nOrNull / s / sOrNull / cleanText", () => {
    assert.deepEqual(U.numbers({ cash: 1, Bad: 2, x_y: Infinity, ok_1: -3, str: "4" }), { cash: 1, ok_1: -3 });
    assert.equal(U.n("5"), 0);
    assert.equal(U.n(NaN), 0);
    assert.equal(U.nOrNull(Infinity), null);
    assert.equal(U.nOrNull(2.5), 2.5);
    assert.equal(U.s(5), "");
    assert.equal(U.sOrNull(""), null);
    assert.equal(U.cleanText("  a\tb  "), "a b");
    assert.equal(U.cleanText("x".repeat(10), 4), "xxxx");
  });
});

/* ======================= routes.ts on a D1 shim ======================= */

const MIGRATIONS = ["0001_core.sql", "0002_market.sql", "0003_broker.sql"].map((f) => readFileSync(join(HERE, "..", "migrations", f), "utf8"));

/** Minimal D1 (prepare/bind/first/all/run/batch) over node:sqlite with the real migrations. */
function makeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const m of MIGRATIONS) db.exec(m);
  const returnsRows = (sql: string) => /^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
  const norm = (x: unknown) => (typeof x === "boolean" ? (x ? 1 : 0) : x);
  class Stmt {
    sql: string;
    binds: unknown[];
    constructor(sql: string, binds: unknown[] = []) {
      this.sql = sql;
      this.binds = binds;
    }
    bind(...b: unknown[]) {
      return new Stmt(this.sql, b.map(norm));
    }
    exec() {
      const s = db.prepare(this.sql);
      if (returnsRows(this.sql)) {
        const rows = s.all(...(this.binds as any[])).map((r: any) => ({ ...r }));
        return { results: rows, success: true, meta: { changes: /\bRETURNING\b/i.test(this.sql) ? rows.length : 0 } };
      }
      const r = s.run(...(this.binds as any[]));
      return { results: [], success: true, meta: { changes: Number(r.changes) } };
    }
    async first() {
      return this.exec().results[0] ?? null;
    }
    async all() {
      return this.exec();
    }
    async run() {
      return this.exec();
    }
  }
  return {
    raw: db,
    prepare: (sql: string) => new Stmt(sql),
    async batch(stmts: Stmt[]) {
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => s.exec());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

const R_SECRET = "kite-api-secret-for-tests-0123456789";
const R_KEY = "kitekey123";
const R_ACCESS = "LiveAccessTokenForTests0123456789";
const R_RELAY = `relay-token-${"r".repeat(40)}`;
const ADMIN = { sessionId: "aaaaaaaa-1111-4111-8111-111111111111", actor: "admin:aaaaaaaa", expiresAt: "2099-01-01T00:00:00.000Z" };
const OTHER_ADMIN = { sessionId: "bbbbbbbb-2222-4222-8222-222222222222", actor: "admin:bbbbbbbb", expiresAt: "2099-01-01T00:00:00.000Z" };

function handler(method: string, path: string) {
  const r = brokerRoutes.find((x: any) => x.method === method && x.path === path);
  assert.ok(r, `${method} ${path} is routed`);
  return r.handler;
}

function mkCtx(env: any, o: { method: string; path: string; body?: unknown; admin?: any; headers?: Record<string, string>; params?: Record<string, string> }) {
  const url = new URL(`https://tudumm.test${o.path}`);
  const req = new Request(url, {
    method: o.method,
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", ...(o.headers ?? {}) },
    body: o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body),
  });
  return { req, env, exec: { waitUntil() {}, passThroughOnException() {} }, url, params: o.params ?? {}, user: null, session: null, via: null, admin: o.admin ?? null, cookies: [], ipHash: async () => "ab".repeat(32) };
}

async function call(h: (c: any) => Promise<Response>, c: any): Promise<{ status: number; body: any }> {
  try {
    const res = await h(c);
    return { status: res.status, body: await res.json() };
  } catch (e: any) {
    if (e instanceof HttpError) return { status: e.status, body: { error: e.code, ...(e.extra ?? {}) } };
    throw e;
  }
}

/** Route tests never touch the network: Kite calls (e.g. /quote/ltp) fail unless a test installs a mock. */
let ltpMock: ((inst: string) => number | null) | null = null;
const realFetch = globalThis.fetch;
const guardedFetch = (async (url: any, init: any) => {
  const u = new URL(String(url));
  if (u.hostname === "api.kite.trade" && u.pathname === "/quote/ltp" && ltpMock) {
    const inst = u.searchParams.get("i") ?? "";
    const lp = ltpMock(inst);
    if (lp === null) return new Response(JSON.stringify({ status: "error", error_type: "PermissionException", message: "Insufficient permission" }), { status: 403 });
    return new Response(JSON.stringify({ status: "success", data: { [inst]: { instrument_token: 1, last_price: lp } } }), { status: 200 });
  }
  if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return realFetch(url, init);
  throw new TypeError(`network disabled in tests: ${u.hostname}`);
}) as typeof fetch;

/** A fresh Tudumm quote as the live feed writes it (source 5paisa). */
function liveQuote(db: any, symbol: string, price: number, ageMs = 1000, source = "5paisa") {
  const at = new Date(Date.now() - ageMs).toISOString();
  db.raw
    .prepare("INSERT OR REPLACE INTO quotes (symbol, price, prev_close, change_pct, as_of, source, updated_at) VALUES (?, ?, NULL, NULL, ?, ?, ?)")
    .run(symbol, price, at, source, at);
}

async function setup(o: { trading?: boolean; connect?: boolean; limits?: Record<string, unknown> } = {}) {
  ltpMock = null;
  globalThis.fetch = guardedFetch; // (re)installed per test: other suites restore their own captured fetch
  const db = makeD1();
  const env: any = { DB: db, KITE_API_KEY: R_KEY, KITE_API_SECRET: R_SECRET, RELAY_TOKEN: R_RELAY, ADMIN_PASSWORD: "pw", APP_ENV: "production", SITE_URL: "https://tudumm.test" };
  setLimitsRow(db, { trading_enabled: o.trading === false ? 0 : 1, ...(o.limits ?? {}) });
  let sessionId: string | null = null;
  if (o.connect !== false) sessionId = await connectKite(db);
  return { db, env, sessionId };
}

function setLimitsRow(db: any, patch: Record<string, unknown>) {
  for (const [k, val] of Object.entries(patch)) {
    assert.match(k, /^[a-z_]+$/);
    db.raw.prepare(`UPDATE broker_limits SET ${k} = ? WHERE id = 1`).run(val as any);
  }
}

async function connectKite(db: any, expiresInMs = 3_600_000): Promise<string> {
  const id = crypto.randomUUID();
  const sealed = await K.encryptToken(R_SECRET, R_ACCESS, K.tokenAad(id, "AB1234"));
  db.raw
    .prepare("INSERT INTO broker_sessions (id, kite_user_id, token_ct, token_iv, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, "AB1234", sealed.ct, sealed.iv, "admin:test", new Date().toISOString(), new Date(Date.now() + expiresInMs).toISOString());
  return id;
}

const intentRow = (db: any, id: string) => db.raw.prepare("SELECT * FROM order_intents WHERE id = ?").get(id) as any;
const count = (db: any, sql: string, ...b: any[]) => Number((db.raw.prepare(sql).get(...b) as any).n);

const createOrder = (env: any, body: Body = limitBody(), admin: any = ADMIN) =>
  call(handler("POST", "/api/admin/broker/orders"), mkCtx(env, { method: "POST", path: "/api/admin/broker/orders", body, admin }));
const confirmOrder = (env: any, id: string, token: string, admin: any = ADMIN) =>
  call(handler("POST", "/api/admin/broker/orders/:id/confirm"), mkCtx(env, { method: "POST", path: `/api/admin/broker/orders/${id}/confirm`, params: { id }, body: { confirmToken: token }, admin }));
const setTrading = (env: any, body: Body) => call(handler("POST", "/api/admin/broker/trading"), mkCtx(env, { method: "POST", path: "/api/admin/broker/trading", body, admin: ADMIN }));
const relayClaim = (env: any, token: string | null = R_RELAY) =>
  call(handler("POST", "/api/internal/relay/claim"), mkCtx(env, { method: "POST", path: "/api/internal/relay/claim", body: { version: "1.0.0" }, headers: token ? { authorization: `Bearer ${token}` } : {} }));
const relayResult = (env: any, body: Body, token: string = R_RELAY) =>
  call(handler("POST", "/api/internal/relay/result"), mkCtx(env, { method: "POST", path: "/api/internal/relay/result", body, headers: { authorization: `Bearer ${token}` } }));
const postback = (env: any, body: Body) => call(handler("POST", "/api/v1/broker/kite/postback"), mkCtx(env, { method: "POST", path: "/api/v1/broker/kite/postback", body }));

async function createAndConfirm(env: any, body: Body = limitBody()) {
  const c = await createOrder(env, body);
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const id = c.body.intent.id as string;
  const f = await confirmOrder(env, id, c.body.confirmToken);
  assert.equal(f.status, 200, JSON.stringify(f.body));
  return { id, tag: c.body.intent.tag as string };
}

describe("routes.ts: owner-only access", () => {
  test("every /api/admin/broker route is auth=admin; the only public broker routes are the Kite callback/postback and the Bearer relay", () => {
    const admin = brokerRoutes.filter((r: any) => r.path.startsWith("/api/admin/broker"));
    assert.ok(admin.length >= 15);
    for (const r of admin) assert.equal(r.auth, "admin", `${r.method} ${r.path}`);
    const nonAdmin = brokerRoutes
      .filter((r: any) => r.auth !== "admin")
      .map((r: any) => `${r.method} ${r.path} csrf=${r.csrf ?? "default"}`)
      .sort();
    assert.deepEqual(nonAdmin, [
      "GET /api/v1/broker/kite/callback csrf=default",
      "POST /api/internal/relay/claim csrf=none",
      "POST /api/internal/relay/result csrf=none",
      "POST /api/v1/broker/kite/postback csrf=none",
    ]);
    for (const r of brokerRoutes) if (r.auth !== "admin") assert.ok(!r.path.startsWith("/api/admin/"), r.path);
  });

  test("every admin handler refuses (401) without an admin session BEFORE touching D1, Kite or secrets", async () => {
    const poisoned = new Proxy({}, { get: (_t, p) => (p === "then" ? undefined : assert.fail(`env.${String(p)} touched before the admin check`)) });
    for (const r of brokerRoutes.filter((x: any) => x.auth === "admin")) {
      const id = "cccccccc-3333-4333-8333-333333333333";
      const c = mkCtx(poisoned, { method: r.method, path: r.path.replace(":id", id), params: { id }, body: r.method === "GET" ? undefined : {} });
      const out = await call(r.handler, c);
      assert.equal(out.status, 401, `${r.method} ${r.path}`);
      assert.equal(out.body.error, "admin_auth_required");
    }
  });
});

describe("routes.ts: order state machine (D1 shim)", () => {
  test("happy path: create -> confirm -> relay claim -> placed -> postback; secrets never in browser responses", async () => {
    const { db, env } = await setup();
    const c = await createOrder(env, limitBody({ tradingsymbol: "M&M", price: 3000.5, quantity: 2 }));
    assert.equal(c.status, 201);
    assert.equal(c.body.intent.status, "pending_confirm");
    assert.match(c.body.confirmToken, /^[A-Za-z0-9_-]{43}$/);
    assert.match(c.body.intent.tag, G.TAG_RE);
    assert.equal(c.body.summary.value, 6001);
    const row = intentRow(db, c.body.intent.id);
    assert.notEqual(row.confirm_token_hash, c.body.confirmToken, "confirm token stored only as a hash");
    assert.equal(row.confirm_token_hash, sha256(`broker_confirm:${c.body.confirmToken}`));
    assert.deepEqual(JSON.parse(row.payload), { exchange: "NSE", tradingsymbol: "M&M", transaction_type: "BUY", order_type: "LIMIT", quantity: "2", product: "CNC", validity: "DAY", tag: row.tag, price: "3000.5" });

    const f = await confirmOrder(env, c.body.intent.id, c.body.confirmToken);
    assert.equal(f.status, 200);
    assert.equal(f.body.intent.status, "queued");
    assert.equal(intentRow(db, c.body.intent.id).confirm_token_hash, null, "token is single-use");

    const cl = await relayClaim(env);
    assert.equal(cl.status, 200);
    assert.equal(cl.body.idle, false);
    assert.equal(cl.body.intent.id, c.body.intent.id);
    assert.deepEqual(cl.body.intent.params, JSON.parse(row.payload));
    assert.equal(cl.body.accessToken, R_ACCESS);
    assert.equal(cl.body.apiKey, R_KEY);
    assert.equal(intentRow(db, c.body.intent.id).status, "claimed");

    const res = await relayResult(env, { intentId: c.body.intent.id, ok: true, orderId: "251111000000001" });
    assert.deepEqual(res.body, { ok: true, status: "placed" });

    const list = await call(handler("GET", "/api/admin/broker/orders"), mkCtx(env, { method: "GET", path: "/api/admin/broker/orders", admin: ADMIN }));
    for (const browser of [c.body, f.body, list.body]) {
      const s = JSON.stringify(browser);
      assert.ok(!s.includes(R_ACCESS), "access token leaked to a browser response");
      assert.ok(!s.includes(R_SECRET));
      assert.ok(!s.includes("confirm_token_hash") && !s.includes(row.confirm_token_hash));
    }
    const audit = JSON.stringify(db.raw.prepare("SELECT * FROM audit_log").all());
    assert.ok(!audit.includes(R_ACCESS) && !audit.includes(c.body.confirmToken), "no secrets in audit");
  });

  test("guardrails are re-checked at confirm with the CURRENT limits (lowered qty/value, removed exchange)", async () => {
    for (const [patch, code] of [
      [{ max_qty: 5 }, "qty_over_limit"],
      [{ max_order_value_inr: 14_999 }, "value_over_limit"],
      [{ allowed_exchanges: '["BSE"]' }, "exchange_not_allowed"],
      [{ allowed_products: '["MIS"]' }, "product_not_allowed"],
      [{ daily_order_cap: 0 }, "daily_cap_reached"],
      [{ trading_enabled: 0 }, "trading_disabled"],
    ] as const) {
      const { db, env } = await setup();
      const c = await createOrder(env, limitBody()); // 10 x 1500 = 15,000: fine under the defaults
      assert.equal(c.status, 201);
      setLimitsRow(db, patch);
      const f = await confirmOrder(env, c.body.intent.id, c.body.confirmToken);
      assert.equal(f.status, 409, JSON.stringify(patch));
      assert.equal(f.body.error, code);
      assert.equal(intentRow(db, c.body.intent.id).status, "pending_confirm", "nothing queued");
      assert.equal((await relayClaim(env)).body.idle, true);
    }
  });

  test("a MARKET ticket's buffered estimate is re-checked at confirm too", async () => {
    const { db, env } = await setup();
    liveQuote(db, "INFY", 1000);
    const c = await createOrder(env, marketBody({ estPrice: 1000, quantity: 10 })); // 10,200 buffered
    assert.equal(c.status, 201);
    assert.equal(c.body.summary.value, 10_200);
    assert.equal(c.body.summary.basis, "est_price_buffered");
    setLimitsRow(db, { max_order_value_inr: 10_100 }); // raw 10,000 would pass; buffered must not
    const f = await confirmOrder(env, c.body.intent.id, c.body.confirmToken);
    assert.equal(f.body.error, "value_over_limit");
  });

  test("MARKET / SL-M value checks use a SERVER price: the higher of the live quote and the client's estimate", async () => {
    const { db, env } = await setup({ limits: { max_order_value_inr: 50_000 } });
    // client under-states (estPrice 100) but the live 5paisa quote is 1500: value = 1500 * 1.02 * 10
    liveQuote(db, "INFY", 1500);
    const c = await createOrder(env, marketBody({ estPrice: 100, quantity: 10 }));
    assert.equal(c.status, 201);
    assert.equal(c.body.summary.value, 15_300);
    // and the stored estimate is the verified one, so a later confirm can't fall back to 100
    assert.equal(intentRow(db, c.body.intent.id).est_price, 1500);
    const s = await createOrder(env, slmBody({ estPrice: 1, trigger_price: 1510, quantity: 10 }));
    assert.equal(s.status, 201);
    assert.equal(s.body.summary.value, 15_402); // SL-M is valued at max(estimate, trigger 1510) * 1.02
  });

  test("MARKET / SL-M without any live price -> 409 live_price_unavailable (LIMIT still works)", async () => {
    const { db, env } = await setup();
    let r = await createOrder(env, marketBody());
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "live_price_unavailable");
    liveQuote(db, "INFY", 1500, 5 * 60_000); // stale (5 min) -> not trusted
    r = await createOrder(env, slmBody());
    assert.equal(r.body.error, "live_price_unavailable");
    liveQuote(db, "INFY", 1500, 1000, "nse-archives"); // fresh but not a live source -> not trusted
    r = await createOrder(env, marketBody());
    assert.equal(r.body.error, "live_price_unavailable");
    assert.equal((await createOrder(env, limitBody())).status, 201);
  });

  test("MARKET falls back to Kite's LTP when there's no live Tudumm quote (e.g. F&O, other stocks)", async () => {
    const { env } = await setup({ limits: { max_order_value_inr: 50_000 } });
    const asked: string[] = [];
    ltpMock = (inst) => {
      asked.push(inst);
      return 2000;
    };
    const r = await createOrder(env, marketBody({ tradingsymbol: "M&M", estPrice: 1500, quantity: 10 }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.summary.value, 20_400);
    assert.deepEqual(asked, ["NSE:M&M"]);
    ltpMock = () => null; // Personal Kite apps: no quote permission
    assert.equal((await createOrder(env, marketBody({ tradingsymbol: "M&M" }))).body.error, "live_price_unavailable");
  });

  test("Kite session expired/disconnected between create and confirm -> 409, not queued", async () => {
    const { db, env, sessionId } = await setup();
    const c = await createOrder(env);
    db.raw.prepare("UPDATE broker_sessions SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), sessionId);
    const f = await confirmOrder(env, c.body.intent.id, c.body.confirmToken);
    assert.equal(f.status, 409);
    assert.equal(f.body.error, "broker_not_connected");
  });

  test("confirm needs the creating admin session + the exact token; single use; expires", async () => {
    const { db, env } = await setup();
    const c = await createOrder(env);
    const id = c.body.intent.id;
    assert.equal((await confirmOrder(env, id, c.body.confirmToken, OTHER_ADMIN)).body.error, "confirm_session_mismatch");
    const wrong = `${c.body.confirmToken.slice(0, -1)}${c.body.confirmToken.endsWith("A") ? "B" : "A"}`;
    const w = await confirmOrder(env, id, wrong);
    assert.equal(w.status, 403);
    assert.equal(w.body.error, "confirm_token_invalid");
    assert.equal((await confirmOrder(env, id, "short")).status, 400);
    assert.equal((await confirmOrder(env, id, c.body.confirmToken)).status, 200);
    const again = await confirmOrder(env, id, c.body.confirmToken);
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "intent_not_pending");

    const c2 = await createOrder(env);
    db.raw.prepare("UPDATE order_intents SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1).toISOString(), c2.body.intent.id);
    const late = await confirmOrder(env, c2.body.intent.id, c2.body.confirmToken);
    assert.equal(late.status, 410);
    assert.equal(late.body.error, "intent_expired");
  });

  test("daily cap: create is refused at the cap, and confirms are capped atomically", async () => {
    const { env } = await setup({ limits: { daily_order_cap: 1 } });
    const a = await createOrder(env);
    const b = await createOrder(env);
    assert.equal((await confirmOrder(env, a.body.intent.id, a.body.confirmToken)).status, 200);
    const fb = await confirmOrder(env, b.body.intent.id, b.body.confirmToken);
    assert.equal(fb.status, 409);
    assert.equal(fb.body.error, "daily_cap_reached");
    const c = await createOrder(env);
    assert.equal(c.status, 409);
    assert.equal(c.body.error, "daily_cap_reached");
  });

  test("create refuses when trading is off or Kite isn't connected (and validates the ticket first)", async () => {
    assert.equal((await createOrder((await setup({ trading: false })).env)).body.error, "trading_disabled");
    assert.equal((await createOrder((await setup({ connect: false })).env)).body.error, "broker_not_connected");
    const bad = await createOrder((await setup()).env, limitBody({ price: 1.23456 }));
    assert.equal(bad.status, 400);
    assert.equal(bad.body.field, "price");
  });

  test("an intent is claimed by the relay only once (concurrent claims included)", async () => {
    const { db, env } = await setup();
    const { id } = await createAndConfirm(env);
    const [x, y] = await Promise.all([relayClaim(env), relayClaim(env)]);
    const got = [x, y].filter((r) => r.body.idle === false);
    assert.equal(got.length, 1, "exactly one claim wins");
    assert.equal(got[0]?.body.intent.id, id);
    assert.equal(intentRow(db, id).status, "claimed");
    const z = await relayClaim(env);
    assert.equal(z.body.idle, true);
    assert.equal(z.body.reason, "no_orders");
  });

  test("no automatic retry: a failed or never-reported placement is never handed out again", async () => {
    const { db, env } = await setup();
    const a = await createAndConfirm(env);
    assert.equal((await relayClaim(env)).body.intent.id, a.id);
    assert.deepEqual((await relayResult(env, { intentId: a.id, ok: false, error: "unknown_outcome: no response from Kite" })).body, { ok: true, status: "failed" });
    for (let i = 0; i < 3; i++) assert.equal((await relayClaim(env)).body.idle, true);

    const b = await createAndConfirm(env);
    assert.equal((await relayClaim(env)).body.intent.id, b.id);
    // the relay never reports; 5 minutes later the sweep marks it failed ("MAY have been placed")
    db.raw.prepare("UPDATE order_intents SET claimed_at = ? WHERE id = ?").run(new Date(Date.now() - 6 * 60_000).toISOString(), b.id);
    assert.equal((await relayClaim(env)).body.idle, true);
    const row = intentRow(db, b.id);
    assert.equal(row.status, "failed");
    assert.match(row.error, /^relay_no_result: .*MAY have been placed/);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM order_intents WHERE status = 'queued'"), 0);
  });

  test("a queued intent past its 2-minute window is expired, never claimed", async () => {
    const { db, env } = await setup();
    const { id } = await createAndConfirm(env);
    db.raw.prepare("UPDATE order_intents SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1).toISOString(), id);
    const cl = await relayClaim(env);
    assert.equal(cl.body.idle, true);
    assert.equal(intentRow(db, id).status, "expired");
  });

  test("kill switch: cancels pending + queued, the relay idles, and re-enabling doesn't resurrect them", async () => {
    const { db, env } = await setup();
    const q = await createAndConfirm(env);
    const p = await createOrder(env);
    const off = await setTrading(env, { enabled: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.cancelled, 2);
    for (const id of [q.id, p.body.intent.id]) {
      const r = intentRow(db, id);
      assert.equal(r.status, "cancelled");
      assert.equal(r.error, "kill_switch");
    }
    assert.equal((await relayClaim(env)).body.reason, "trading_disabled");
    assert.equal((await confirmOrder(env, p.body.intent.id, p.body.confirmToken)).body.error, "intent_not_pending");
    assert.equal((await setTrading(env, { enabled: true })).body.error, "confirmation_required");
    assert.equal((await setTrading(env, { enabled: true, confirm: "ENABLE" })).status, 200);
    assert.equal((await relayClaim(env)).body.idle, true);
  });

  test("kill switch flipped in the DB alone (no cancel sweep) still blocks the claim atomically", async () => {
    const { db, env } = await setup();
    const { id } = await createAndConfirm(env);
    setLimitsRow(db, { trading_enabled: 0 });
    assert.equal((await relayClaim(env)).body.reason, "trading_disabled");
    assert.equal(intentRow(db, id).status, "queued");
  });

  test("disconnect cancels pending + queued intents", async () => {
    const { db, env } = await setup();
    const q = await createAndConfirm(env);
    const d = await call(handler("POST", "/api/admin/broker/disconnect"), mkCtx(env, { method: "POST", path: "/api/admin/broker/disconnect", body: {}, admin: ADMIN }));
    assert.equal(d.status, 200);
    assert.equal(intentRow(db, q.id).status, "cancelled");
    assert.equal(intentRow(db, q.id).error, "disconnected");
    assert.equal((await relayClaim(env)).body.idle, true);
  });

  test("relay auth: Bearer RELAY_TOKEN required; a short RELAY_TOKEN means not configured", async () => {
    const { db, env } = await setup();
    const { id } = await createAndConfirm(env);
    assert.equal((await relayClaim(env, null)).status, 401);
    assert.equal((await relayClaim(env, `${R_RELAY}x`)).status, 401);
    assert.equal((await relayClaim({ ...env, RELAY_TOKEN: "x".repeat(31) })).status, 503);
    assert.equal((await relayResult(env, { intentId: id, ok: true, orderId: "1" }, "nope")).status, 401);
    assert.equal(intentRow(db, id).status, "queued", "nothing claimed by a bad token");
  });

  test("relay result: only for claimed intents; idempotent success; can't overwrite a placed order", async () => {
    const { db, env } = await setup();
    const { id } = await createAndConfirm(env);
    const early = await relayResult(env, { intentId: id, ok: true, orderId: "251111000000002" });
    assert.equal(early.status, 409);
    assert.equal(early.body.error, "intent_not_claimed");
    await relayClaim(env);
    assert.equal((await relayResult(env, { intentId: id, ok: true, orderId: "bad id!" })).status, 400);
    assert.equal((await relayResult(env, { intentId: id, ok: true, orderId: "251111000000002" })).body.status, "placed");
    assert.equal((await relayResult(env, { intentId: id, ok: true, orderId: "251111000000002" })).body.idempotent, true);
    const late = await relayResult(env, { intentId: id, ok: false, error: "x" });
    assert.equal(late.status, 409);
    const r = intentRow(db, id);
    assert.equal(r.status, "placed");
    assert.equal(r.kite_order_id, "251111000000002");
  });

  test("relay result arriving after the no-result sweep re-opens to placed (order was placed)", async () => {
    const { db, env } = await setup();
    const { id } = await createAndConfirm(env);
    await relayClaim(env);
    db.raw.prepare("UPDATE order_intents SET claimed_at = ? WHERE id = ?").run(new Date(Date.now() - 6 * 60_000).toISOString(), id);
    await relayClaim(env); // sweep -> failed
    assert.equal(intentRow(db, id).status, "failed");
    assert.equal((await relayResult(env, { intentId: id, ok: true, orderId: "251111000000003" })).body.status, "placed");
  });
});

describe("routes.ts: Kite postback (checksum before any order state change)", () => {
  const ORDER_ID = "251111000000009";
  const TS = "2026-11-11 10:15:42";
  const good = (o: Body = {}) => ({ order_id: ORDER_ID, order_timestamp: TS, checksum: sha256(ORDER_ID + TS + R_SECRET), status: "COMPLETE", tradingsymbol: "INFY", exchange: "NSE", transaction_type: "BUY", quantity: 10, filled_quantity: 10, ...o });

  async function placed() {
    const s = await setup();
    const { id, tag } = await createAndConfirm(s.env);
    await relayClaim(s.env);
    await relayResult(s.env, { intentId: id, ok: true, orderId: ORDER_ID });
    return { ...s, id, tag };
  }

  test("bad checksum -> 401, no order_updates row, intent untouched, failure audited", async () => {
    const { db, env, id } = await placed();
    const before = intentRow(db, id);
    for (const checksum of [sha256(ORDER_ID + TS + "wrong-secret"), sha256(ORDER_ID + "2026-11-11 10:15:43" + R_SECRET), "0".repeat(64)]) {
      const r = await postback(env, good({ checksum, status: "REJECTED" }));
      assert.equal(r.status, 401);
      assert.equal(r.body.error, "invalid_checksum");
    }
    // a valid checksum for (order_id, ts) can't be reused for a different order id
    const r2 = await postback(env, good({ order_id: "251111000000010", status: "REJECTED" }));
    assert.equal(r2.status, 401);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM order_updates"), 0);
    assert.deepEqual(intentRow(db, id), before);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'broker.postback.bad_checksum'"), 4);
  });

  test("malformed postbacks -> 400 before anything is written", async () => {
    const { db, env } = await placed();
    for (const body of [good({ checksum: "xyz" }), good({ order_id: "bad id" }), good({ order_timestamp: "" }), good({ order_id: 123 }), "not json", "[]"]) {
      const r = await postback(env, body as any);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM order_updates"), 0);
  });

  test("valid REJECTED postback marks the intent rejected; replays are de-duplicated", async () => {
    const { db, env, id } = await placed();
    const r = await postback(env, good({ status: "REJECTED", status_message: "Insufficient funds" }));
    assert.deepEqual(r.body, { ok: true });
    const row = intentRow(db, id);
    assert.equal(row.status, "rejected");
    assert.equal(row.kite_status, "REJECTED");
    assert.equal(row.error, "Kite: Insufficient funds");
    assert.equal((await postback(env, good({ status: "REJECTED", status_message: "Insufficient funds" }))).body.duplicate, true);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM order_updates"), 1);
    const stored = JSON.parse((db.raw.prepare("SELECT payload FROM order_updates").get() as any).payload);
    assert.equal("checksum" in stored, false, "checksum isn't stored");
  });

  test("a postback matched by tag reconciles a swept 'no result' intent to placed", async () => {
    const { db, env } = await setup();
    const { id, tag } = await createAndConfirm(env);
    await relayClaim(env);
    db.raw.prepare("UPDATE order_intents SET claimed_at = ? WHERE id = ?").run(new Date(Date.now() - 6 * 60_000).toISOString(), id);
    await relayClaim(env); // sweep -> failed, kite_order_id NULL
    assert.equal(intentRow(db, id).status, "failed");
    const r = await postback(env, good({ tag, status: "OPEN" }));
    assert.deepEqual(r.body, { ok: true });
    const row = intentRow(db, id);
    assert.equal(row.status, "placed");
    assert.equal(row.kite_order_id, ORDER_ID);
    assert.equal(row.error, null);
  });

  test("a postback never touches an intent that isn't at Kite yet (queued / pending)", async () => {
    const { db, env } = await setup();
    const { id, tag } = await createAndConfirm(env); // queued, not claimed
    await postback(env, good({ tag, status: "REJECTED" }));
    assert.equal(intentRow(db, id).status, "queued");
  });
});

/* ======================= relay/kite-relay.mjs ======================= */

describe("relay inMarketWindow (IST 09:00-15:40, Mon-Fri)", () => {
  test("boundaries", () => {
    // 2026-11-09 is a Monday; IST = UTC+05:30
    assert.equal(inMarketWindow(Z("2026-11-09T03:30:00Z")), true); // 09:00 IST
    assert.equal(inMarketWindow(Z("2026-11-09T03:29:59Z")), false); // 08:59:59
    assert.equal(inMarketWindow(Z("2026-11-09T10:09:59Z")), true); // 15:39:59
    assert.equal(inMarketWindow(Z("2026-11-09T10:10:00Z")), false); // 15:40
    assert.equal(inMarketWindow(Z("2026-11-14T05:00:00Z")), false); // Saturday
    assert.equal(inMarketWindow(Z("2026-11-15T05:00:00Z")), false); // Sunday
    assert.equal(inMarketWindow(Z("2026-11-13T19:00:00Z")), false); // Fri 00:30 IST Sat
  });
});

describe("relay/kite-relay.mjs process vs loopback mocks of Kite + Tudumm", () => {
  const RELAY_TOKEN = `relay-proc-token-${"q".repeat(40)}`;
  const API_KEY = "relayApiKey9876543";
  const ACCESS = "relayAccessTokenZYXW987654321";
  type Scn = { name: string; params: Record<string, unknown>; kite?: "ok" | "400" | "500" | "reset" | "ok_no_id"; failReportOnce?: boolean };
  const base = { exchange: "NSE", tradingsymbol: "INFY", transaction_type: "BUY", order_type: "LIMIT", quantity: "1", product: "CNC", validity: "DAY", price: "1500" };
  const scenarios: Scn[] = [
    { name: "ok", kite: "ok", params: { ...base, tradingsymbol: "M&M", variety: "amo", squareoff: "5", disclosed_quantity: "1", iceberg_legs: "2" } },
    { name: "kite400", kite: "400", params: { ...base } },
    { name: "kite500", kite: "500", params: { ...base } },
    { name: "reset", kite: "reset", params: { ...base } },
    { name: "badSymbol", params: { ...base, tradingsymbol: "INFY BE" } },
    { name: "badQty", params: { ...base, quantity: "0" } },
    { name: "missingProduct", params: { ...base, product: undefined } },
    { name: "reportRetry", kite: "ok", failReportOnce: true, params: { ...base } },
    { name: "okNoId", kite: "ok_no_id", params: { ...base } },
  ];
  const intents = scenarios.map((s, i) => {
    const id = crypto.randomUUID();
    const tag = G.intentTag(id);
    const params: Record<string, unknown> = { ...s.params, tag };
    for (const k of Object.keys(params)) if (params[k] === undefined) delete params[k];
    return { ...s, id, tag, params, orderId: `2511110000${String(i).padStart(5, "0")}` };
  });
  const byName = (n: string) => intents.find((x) => x.name === n) as (typeof intents)[number];

  const kiteReqs: { headers: http.IncomingHttpHeaders; form: URLSearchParams }[] = [];
  const results: { auth: string | undefined; body: any }[] = [];
  const claims: { auth: string | undefined }[] = [];
  let logs = "";
  let exitCode: number | null = null;
  let kiteSrv: http.Server;
  let tdmSrv: http.Server;
  const queue = [...intents];
  const failedOnce = new Set<string>();

  const readBody = (req: http.IncomingMessage) =>
    new Promise<string>((resolve) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => resolve(s));
    });
  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const listen = (srv: http.Server) => new Promise<number>((r) => srv.listen(0, "127.0.0.1", () => r((srv.address() as any).port)));

  before(
    async () => {
      kiteSrv = http.createServer(async (req, res) => {
        const form = new URLSearchParams(await readBody(req));
        kiteReqs.push({ headers: req.headers, form });
        const it = intents.find((x) => x.tag === form.get("tag"));
        if (req.url !== "/orders/regular" || req.method !== "POST" || !it) return send(res, 404, { status: "error", error_type: "GeneralException", message: "unexpected" });
        if (it.kite === "ok") return send(res, 200, { status: "success", data: { order_id: it.orderId } });
        if (it.kite === "ok_no_id") return send(res, 200, { status: "success", data: {} });
        if (it.kite === "400") return send(res, 400, { status: "error", error_type: "InputException", message: "Invalid `price`." });
        if (it.kite === "500") return send(res, 500, { status: "error", error_type: "GeneralException", message: "upstream" });
        req.socket.destroy(); // "reset": the request may or may not have reached the OMS
      });
      tdmSrv = http.createServer(async (req, res) => {
        const body = await readBody(req);
        if (req.url === "/api/internal/relay/claim") {
          claims.push({ auth: req.headers.authorization });
          const next = queue.shift();
          if (!next) return send(res, 200, { idle: true, reason: "no_orders", relayIp: "127.0.0.1" });
          return send(res, 200, { idle: false, intent: { id: next.id, tag: next.tag, variety: "regular", params: next.params }, apiKey: API_KEY, accessToken: ACCESS, relayIp: "127.0.0.1" });
        }
        if (req.url === "/api/internal/relay/result") {
          const parsed = JSON.parse(body);
          results.push({ auth: req.headers.authorization, body: parsed });
          const it = intents.find((x) => x.id === parsed.intentId);
          if (it?.failReportOnce && !failedOnce.has(it.id)) {
            failedOnce.add(it.id);
            return send(res, 503, { error: "unavailable" });
          }
          return send(res, 200, { ok: true });
        }
        send(res, 404, { error: "not_found" });
      });
      const [kp, tp] = await Promise.all([listen(kiteSrv), listen(tdmSrv)]);
      const child = spawn(process.execPath, [RELAY_PATH], {
        env: { RELAY_TOKEN, TUDUMM_URL: `http://127.0.0.1:${tp}`, KITE_API_BASE: `http://127.0.0.1:${kp}` },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (d) => (logs += d));
      child.stderr.on("data", (d) => (logs += d));
      const exited = new Promise<void>((r) => child.on("exit", (code) => ((exitCode = code), r())));
      const expected = intents.length + 1; // one result each, plus one retried report
      const deadline = Date.now() + 25_000;
      while (results.length < expected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 800)); // would a retry of any placement show up?
      child.kill("SIGTERM");
      const t = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(t);
      kiteSrv.closeAllConnections();
      tdmSrv.closeAllConnections();
      await Promise.all([new Promise((r) => kiteSrv.close(r)), new Promise((r) => tdmSrv.close(r))]);
    },
    { timeout: 45_000 },
  );

  const kiteCount = (tag: string) => kiteReqs.filter((r) => r.form.get("tag") === tag).length;
  const resultsFor = (id: string) => results.filter((r) => r.body.intentId === id).map((r) => r.body);

  test("every intent was claimed once and got a result", () => {
    assert.equal(claims.length >= intents.length + 1, true, `claims: ${claims.length}`);
    for (const it of intents) assert.ok(resultsFor(it.id).length >= 1, `${it.name} has a result`);
  });

  test("a placement is sent to Kite at most once — never retried after 4xx, 5xx or a connection reset", () => {
    for (const it of intents) {
      const want = it.kite ? 1 : 0;
      assert.equal(kiteCount(it.tag), want, `${it.name}: ${kiteCount(it.tag)} Kite requests`);
    }
  });

  test("success reports the Kite order id", () => {
    assert.deepEqual(resultsFor(byName("ok").id), [{ intentId: byName("ok").id, ok: true, orderId: byName("ok").orderId }]);
  });

  test("a definite Kite rejection (4xx JSON) is a plain failure with Kite's error text", () => {
    const [r] = resultsFor(byName("kite400").id);
    assert.equal(r.ok, false);
    assert.equal(r.error, "InputException: Invalid `price`.");
  });

  test("5xx and connection reset are reported as unknown_outcome (MAY have been placed)", () => {
    for (const n of ["kite500", "reset"]) {
      const [r] = resultsFor(byName(n).id);
      assert.equal(r.ok, false, n);
      assert.match(r.error, /^unknown_outcome: .*MAY have been placed/, n);
    }
  });

  test("invalid params are refused locally and never reach Kite", () => {
    for (const [n, re] of [
      ["badSymbol", /^relay_refused: refusing order: parameter tradingsymbol/],
      ["badQty", /^relay_refused: refusing order: bad quantity/],
      ["missingProduct", /^relay_refused: refusing order: missing product/],
    ] as const) {
      const [r] = resultsFor(byName(n).id);
      assert.equal(r.ok, false);
      assert.match(r.error, re, n);
      assert.equal(kiteCount(byName(n).tag), 0);
    }
  });

  test("only whitelisted params are sent to Kite, values unchanged; X-Kite-Version 3 + token auth", () => {
    const it = byName("ok");
    const req = kiteReqs.find((r) => r.form.get("tag") === it.tag);
    assert.ok(req);
    assert.deepEqual(Object.fromEntries(req.form), { exchange: "NSE", tradingsymbol: "M&M", transaction_type: "BUY", order_type: "LIMIT", quantity: "1", product: "CNC", validity: "DAY", price: "1500", tag: it.tag });
    for (const k of req.form.keys()) assert.ok(RELAY_ALLOWED.includes(k));
    assert.equal(req.headers["x-kite-version"], "3");
    assert.equal(req.headers.authorization, `token ${API_KEY}:${ACCESS}`);
    assert.equal(req.headers["content-type"], "application/x-www-form-urlencoded");
  });

  test("the RESULT report is retried (identical body) while the placement is not", () => {
    const it = byName("reportRetry");
    const rs = resultsFor(it.id);
    assert.equal(rs.length, 2);
    assert.deepEqual(rs[0], rs[1]);
    assert.equal(rs[0].ok, true);
    assert.equal(kiteCount(it.tag), 1);
  });

  test("Tudumm calls carry the Bearer RELAY_TOKEN", () => {
    for (const c of claims) assert.equal(c.auth, `Bearer ${RELAY_TOKEN}`);
    for (const r of results) assert.equal(r.auth, `Bearer ${RELAY_TOKEN}`);
  });

  test("logs never contain RELAY_TOKEN, the API key or the access token", () => {
    assert.ok(logs.length > 0);
    for (const secret of [RELAY_TOKEN, API_KEY, ACCESS]) assert.equal(logs.includes(secret), false, "secret in relay logs");
    for (const line of logs.trim().split("\n")) assert.doesNotThrow(() => JSON.parse(line), line);
  });

  test("exits cleanly on SIGTERM", () => {
    assert.equal(exitCode, 0);
  });

  test("a 2xx 'success' without a valid order id is reported as unknown_outcome, not a definite failure", () => {
    const [r] = resultsFor(byName("okNoId").id);
    assert.equal(r.ok, false);
    assert.match(r.error, /^unknown_outcome/);
  });
});
