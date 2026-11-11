// Unit tests for worker/src/api/hooks.ts (alert evaluation + signal notifications), run in Node
// against a D1-compatible shim over node:sqlite with the real 0001_core.sql schema.
//   node --test worker/test/core.hooks.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";

// Worker sources use extensionless relative imports (bundler style); teach Node to try ".ts".
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
      throw err;
    }
  },
});

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(HERE, "..", "migrations", "0001_core.sql");

/* ---------- minimal D1 shim (prepare/bind/first/all/run/batch) ---------- */
function makeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(readFileSync(MIGRATION, "utf8"));
  const returnsRows = (sql) => /^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
  const norm = (v) => (typeof v === "boolean" ? (v ? 1 : 0) : v);
  class Stmt {
    constructor(sql, binds = []) {
      this.sql = sql;
      this.binds = binds;
    }
    bind(...b) {
      return new Stmt(this.sql, b.map(norm));
    }
    exec() {
      const s = db.prepare(this.sql);
      if (returnsRows(this.sql)) {
        const rows = s.all(...this.binds).map((r) => ({ ...r }));
        return { results: rows, success: true, meta: { changes: /\bRETURNING\b/i.test(this.sql) ? rows.length : 0 } };
      }
      const r = s.run(...this.binds);
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
    prepare: (sql) => new Stmt(sql),
    async batch(stmts) {
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

let hooks;
before(async () => {
  hooks = await import("../src/api/hooks.ts");
});

const NOW = new Date().toISOString();
function seed(d1) {
  const users = [
    ["u-alice", "alice@example.com", 1, "active"],
    ["u-bob", "bob@example.com", 0, "active"],
    ["u-carl", "carl@example.com", 1, "suspended"],
    ["u-dina", "dina@example.com", 1, "active"],
  ];
  for (const [id, email, ver, status] of users) {
    d1.raw.prepare("INSERT INTO users (id, email, email_verified, status, created_at) VALUES (?, ?, ?, ?, ?)").run(id, email, ver, status, NOW);
  }
  const alerts = [
    ["a1", "u-alice", "BTCUSDT", "price_above", 100, 1],
    ["a2", "u-bob", "BTCUSDT", "price_below", 50, 1],
    ["a3", "u-alice", "ETHUSDT", "price_above", 5000, 0], // repeating
    ["a4", "u-carl", "BTCUSDT", "price_above", 1, 1], // suspended owner
    ["a5", "u-alice", "*", "new_signal", null, 0], // any watchlist symbol
    ["a6", "u-dina", "*", "new_signal", null, 0], // but dina has no watchlist
    ["a7", "u-dina", "SOLUSDT", "signal_update", null, 0],
  ];
  for (const [id, uid, sym, kind, thr, oneShot] of alerts) {
    d1.raw
      .prepare("INSERT INTO alerts (id, user_id, symbol, kind, threshold, one_shot, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)")
      .run(id, uid, sym, kind, thr, oneShot, NOW);
  }
  d1.raw.prepare("INSERT INTO watchlist (user_id, symbol, added_at) VALUES ('u-alice', 'BTCUSDT', ?)").run(NOW);
  d1.raw.prepare("INSERT INTO tracked (user_id, signal_id, symbol, added_at) VALUES ('u-bob', 'sym:BTCUSDT', 'BTCUSDT', ?)").run(NOW);
  d1.raw.prepare("INSERT INTO tracked (user_id, signal_id, symbol, added_at) VALUES ('u-dina', 'SIG-SOL-1', 'SOLUSDT', ?)").run(NOW);
}

const notes = (d1, user) => d1.raw.prepare("SELECT kind, title, body, link, dedupe_key FROM notifications WHERE user_id = ? ORDER BY created_at, title").all(user);
const alert = (d1, id) => d1.raw.prepare("SELECT active, last_triggered_at FROM alerts WHERE id = ?").get(id);

test("onPricesUpdated: fires matching alerts once, skips suspended owners, honours one-shot and cooldown", async () => {
  const d1 = makeD1();
  seed(d1);
  const env = { DB: d1, APP_ENV: "test", SITE_URL: "https://tudumm.in" };
  await hooks.onPricesUpdated(env, { BTCUSDT: 120, ETHUSDT: 6000, "bad sym!": 5, XRPUSDT: Number.NaN });

  const a = notes(d1, "u-alice");
  assert.equal(a.length, 2, "alice: BTC above + ETH above");
  assert.ok(a.every((n) => n.kind === "price_alert"));
  assert.match(a.find((n) => n.title.startsWith("BTCUSDT")).title, /rose above 100/);
  assert.equal(a.find((n) => n.title.startsWith("BTCUSDT")).link, "/app/i/BTCUSDT");
  assert.equal(notes(d1, "u-bob").length, 0, "bob's price_below 50 must not fire at 120");
  assert.equal(notes(d1, "u-carl").length, 0, "suspended users get nothing");

  assert.equal(alert(d1, "a1").active, 0, "one-shot alert deactivates");
  assert.ok(alert(d1, "a1").last_triggered_at);
  assert.equal(alert(d1, "a3").active, 1, "repeating alert stays active");
  assert.equal(alert(d1, "a4").active, 1, "suspended owner's alert untouched");

  // Second run: a1 is inactive, a3 is in its 24 h cooldown => nothing new.
  await hooks.onPricesUpdated(env, { BTCUSDT: 130, ETHUSDT: 6100 });
  assert.equal(notes(d1, "u-alice").length, 2);

  // Price drops: bob's below-alert fires.
  await hooks.onPricesUpdated(env, { BTCUSDT: 40 });
  assert.equal(notes(d1, "u-bob").length, 1);
});

test("onPricesUpdated: tolerates empty/garbage input and never throws", async () => {
  const d1 = makeD1();
  const env = { DB: d1, APP_ENV: "test" };
  await hooks.onPricesUpdated(env, {});
  await hooks.onPricesUpdated(env, null);
  await hooks.onPricesUpdated({ DB: { prepare() { throw new Error("db down"); } } }, { BTCUSDT: 1 });
});

test("onSignalEvent: notifies '*' alert owners with the symbol on their watchlist and symbol trackers; dedupes", async () => {
  const d1 = makeD1();
  seed(d1);
  const env = { DB: d1, APP_ENV: "test" };
  const ev = { type: "issued", signalId: "SIG-BTC-42", symbol: "BTCUSDT", market: "CRYPTO", direction: "LONG", at: NOW, detail: { entryLow: 100, entryHigh: 101, stop: 95, target1: 108 } };
  await hooks.onSignalEvent(env, ev);
  const a = notes(d1, "u-alice");
  const b = notes(d1, "u-bob");
  assert.equal(a.length, 1, "alice: '*' new_signal alert + BTCUSDT on watchlist");
  assert.equal(b.length, 1, "bob: tracks sym:BTCUSDT");
  assert.equal(notes(d1, "u-dina").length, 0, "dina: '*' alert but no BTCUSDT on watchlist");
  assert.equal(a[0].kind, "new_signal");
  assert.match(a[0].body, /uncalibrated/i, "honesty label present");
  assert.equal(a[0].dedupe_key, "sig:SIG-BTC-42:issued");

  await hooks.onSignalEvent(env, ev); // replay
  assert.equal(notes(d1, "u-alice").length, 1, "replayed event is deduped");
  assert.equal(notes(d1, "u-bob").length, 1);
});

test("onSignalEvent: held signals stay silent; lifecycle updates reach trackers and signal_update alerts", async () => {
  const d1 = makeD1();
  seed(d1);
  const env = { DB: d1, APP_ENV: "test" };
  await hooks.onSignalEvent(env, { type: "issued", signalId: "SIG-BTC-9", symbol: "BTCUSDT", market: "CRYPTO", direction: "SHORT", at: NOW, detail: { held: true } });
  await hooks.onSignalEvent(env, { type: "held", signalId: "SIG-BTC-9", symbol: "BTCUSDT", market: "CRYPTO", direction: "SHORT", at: NOW });
  assert.equal(d1.raw.prepare("SELECT COUNT(*) AS n FROM notifications").get().n, 0, "held => no notifications");

  await hooks.onSignalEvent(env, { type: "closed", signalId: "SIG-SOL-1", symbol: "SOLUSDT", market: "CRYPTO", direction: "LONG", at: NOW, detail: { outcome: "target", r: 2.5, exit: 210 } });
  const d = notes(d1, "u-dina");
  assert.equal(d.length, 1, "dina tracks SIG-SOL-1 and has a signal_update alert: one (deduped) notification");
  assert.equal(d[0].kind, "signal_update");
  assert.match(d[0].title, /closed: target \(\+2\.50R\)/);

  // Garbage events are ignored.
  await hooks.onSignalEvent(env, { type: "issued", signalId: "x", symbol: "bad sym!", market: "X", direction: null, at: NOW });
  await hooks.onSignalEvent(env, null);
});

test("emails go only to VERIFIED active users, in one Resend batch call", async () => {
  const d1 = makeD1();
  seed(d1);
  const env = { DB: d1, APP_ENV: "test", RESEND_API_KEY: "re_test", EMAIL_FROM: "Tudumm <hello@tudumm.in>", SITE_URL: "https://tudumm.in" };
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response("{}", { status: 200 });
  };
  try {
    // bob (unverified) and alice (verified) both get in-app notifications for this event.
    await hooks.onSignalEvent(env, { type: "issued", signalId: "SIG-BTC-77", symbol: "BTCUSDT", market: "CRYPTO", direction: "LONG", at: NOW });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(notes(d1, "u-bob").length, 1, "unverified user still gets the in-app notification");
  assert.equal(calls.length, 1, "exactly one subrequest");
  assert.equal(calls[0].url, "https://api.resend.com/emails/batch");
  const to = calls[0].body.flatMap((m) => m.to);
  assert.deepEqual(to, ["alice@example.com"], "only the verified address is emailed");
  assert.match(calls[0].body[0].text, /https:\/\/tudumm\.in\/app\/i\/BTCUSDT/);
});
