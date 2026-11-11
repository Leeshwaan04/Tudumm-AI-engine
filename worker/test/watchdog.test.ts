// Feed watchdog: alert decisions (down / still down every 30 min / recovered), the NSE-hours window,
// and the order guard's freshness rule. Run: node --test worker/test/watchdog.test.ts
import "../../runner/lib/register.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
const W = await import("../src/market/watchdog.ts");

const IST = (h: number, m: number, day = 11) => Date.UTC(2026, 10, day, h, m) - 330 * 60000; // Wed 11 Nov 2026

test("india check window: 09:18-15:30 IST on weekdays only", () => {
  assert.equal(W.indiaCheckDue(IST(9, 17)), false); // open-time grace
  assert.equal(W.indiaCheckDue(IST(9, 18)), true);
  assert.equal(W.indiaCheckDue(IST(15, 29)), true);
  assert.equal(W.indiaCheckDue(IST(15, 30)), false);
  assert.equal(W.indiaCheckDue(IST(11, 0, 14)), false); // Saturday
});

test("decide: first sight ok -> no alert; ok -> down alerts once; repeats every 30 min; recovery alerts", () => {
  let r = W.decide(null, IST(10, 0), { india: 20 });
  assert.deepEqual(r.alerts, []);
  assert.equal(r.next.feeds.india?.ok, true);
  r = W.decide(r.next, IST(10, 1), { india: 400 });
  assert.deepEqual(r.alerts.map((a) => a.kind), ["down"]);
  r = W.decide(r.next, IST(10, 2), { india: 460 });
  assert.deepEqual(r.alerts, [], "no spam every minute");
  r = W.decide(r.next, IST(10, 31), { india: 2200 });
  assert.deepEqual(r.alerts.map((a) => a.kind), ["still_down"]);
  r = W.decide(r.next, IST(10, 32), { india: 3 });
  assert.deepEqual(r.alerts.map((a) => a.kind), ["recovered"]);
  assert.equal(r.next.feeds.india?.ok, true);
});

test("decide: no data at all counts as down; feeds not checked this pass keep their state", () => {
  const r1 = W.decide(null, IST(10, 0), { crypto: null });
  assert.deepEqual(r1.alerts.map((a) => `${a.feed}:${a.kind}`), ["crypto:down"]);
  const r2 = W.decide({ ...r1.next, feeds: { ...r1.next.feeds, india: { ok: false, since: "x", lastAlertAt: new Date(IST(9, 50)).toISOString(), ageSec: 999 } } }, IST(10, 5), { crypto: 5 });
  assert.equal(r2.next.feeds.india?.ok, false, "india untouched when not checked");
  assert.deepEqual(r2.alerts.map((a) => a.kind), ["recovered"]);
});

test("thresholds: india 180 s, crypto 600 s", () => {
  assert.equal(W.decide(null, IST(10, 0), { india: 180 }).next.feeds.india?.ok, true);
  assert.equal(W.decide(null, IST(10, 0), { india: 181 }).next.feeds.india?.ok, false);
  assert.equal(W.decide(null, IST(10, 0), { crypto: 600 }).next.feeds.crypto?.ok, true);
  assert.equal(W.decide(null, IST(10, 0), { crypto: 601 }).next.feeds.crypto?.ok, false);
});

test("order guard: needs a fresh 5paisa quote during the session; doesn't block outside it", () => {
  const now = IST(11, 0);
  const iso = (agoSec: number) => new Date(now - agoSec * 1000).toISOString();
  assert.equal(W.indiaQuoteProblem({ as_of: iso(30), source: "5paisa" }, now), null);
  assert.match(W.indiaQuoteProblem({ as_of: iso(300), source: "5paisa" }, now)?.reason ?? "", /5 min old/);
  assert.match(W.indiaQuoteProblem({ as_of: iso(5), source: "nse-archives" }, now)?.reason ?? "", /nse-archives/);
  assert.equal(W.indiaQuoteProblem(null, now)?.reason, "no live quote");
  assert.equal(W.indiaQuoteProblem(null, IST(20, 0)), null);
  assert.equal(W.indiaQuoteProblem(null, IST(11, 0, 15)), null); // Sunday
});

test("pushAlert: no topic or an unsafe topic -> not sent, never throws", async () => {
  assert.equal(await W.pushAlert({ NTFY_TOPIC: undefined }, "t", "b", "high", "warning"), false);
  assert.equal(await W.pushAlert({ NTFY_TOPIC: "short" }, "t", "b", "high", "warning"), false);
  assert.equal(await W.pushAlert({ NTFY_TOPIC: "../../etc/passwd-xxxxxxxxxx" }, "t", "b", "high", "warning"), false);
});
