// Unit tests for the live feed's pure parts: TOTP (RFC 6238 vectors), scrip-master parsing and
// resolution, tick -> quote/bar, 5paisa date parsing, websocket host routing. Run: npm run test:live
import "../lib/register.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { base32Decode, totp } from "./totp.ts";
import { IndiaBook, dayT, istYmd, parseScripMaster, resolveScrips, vixSnapshot } from "./india.ts";
import { feedUrlFor, parseNetDate } from "./fivepaisa.ts";

// RFC 6238 appendix B, SHA-1 seed "12345678901234567890" (base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ); 6-digit = last 6 of the 8-digit values
const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
test("totp: RFC 6238 SHA-1 vectors (6 digits)", () => {
  assert.equal(totp(SEED, 59_000), "287082");
  assert.equal(totp(SEED, 1111111109_000), "081804");
  assert.equal(totp(SEED, 1111111111_000), "050471");
  assert.equal(totp(SEED, 1234567890_000), "005924");
  assert.equal(totp(SEED, 2000000000_000), "279037");
  assert.equal(totp(SEED, 20000000000_000), "353130");
});

test("totp: base32 tolerates spaces/lowercase/padding and rejects garbage", () => {
  assert.deepEqual(base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq"), Buffer.from("12345678901234567890"));
  assert.deepEqual(base32Decode("MZXW6==="), Buffer.from("foo"));
  assert.throws(() => base32Decode("not-base32!"), /base32/);
  assert.throws(() => base32Decode("   "), /empty/);
});

const CSV = [
  "Exch,ExchType,ScripCode,Name,Expiry,ScripType,StrikeRate,FullName,TickSize,LotSize,QtyLimit,Multiplier,SymbolRoot,BOCOAllowed,ISIN,ScripData,Series",
  'N,C,2885,RELIANCE,1980-01-01 00:00:00,XX,0,"RELIANCE INDUSTRIES, LTD",0.05,1,0,1,RELIANCE,Y,INE002A01018,RELIANCE_EQ,EQ',
  "N,C,1333,HDFCBANK,1980-01-01 00:00:00,XX,0,HDFC BANK LTD,0.05,1,0,1,HDFCBANK,Y,INE040A01034,HDFCBANK_EQ,EQ",
  "N,C,11536,TCS,1980-01-01 00:00:00,XX,0,TATA CONSULTANCY,0.05,1,0,1,TCS,Y,INE467B01029,TCS_EQ,EQ",
  "N,C,1594,INFY,1980-01-01 00:00:00,XX,0,INFOSYS,0.05,1,0,1,INFY,Y,INE009A01021,INFY_EQ,EQ",
  "N,C,4963,ICICIBANK,1980-01-01 00:00:00,XX,0,ICICI BANK,0.05,1,0,1,ICICIBANK,Y,INE090A01021,ICICIBANK_EQ,EQ",
  "N,C,3045,SBIN,1980-01-01 00:00:00,XX,0,STATE BANK,0.05,1,0,1,SBIN,Y,INE062A01020,SBIN_EQ,EQ",
  "N,C,99999,SBIN,1980-01-01 00:00:00,XX,0,STATE BANK BE,0.05,1,0,1,SBIN,Y,INE062A01020,SBIN_BE,BE",
  "N,C,999920000,NIFTY,1980-01-01 00:00:00,EQ,0,NIFTY 50,0.05,1,0,1,NIFTY,N,,NIFTY,",
  "N,C,999920005,BANKNIFTY,1980-01-01 00:00:00,EQ,0,NIFTY BANK,0.05,1,0,1,BANKNIFTY,N,,BANKNIFTY,",
  "N,C,999920019,INDIAVIX,1980-01-01 00:00:00,EQ,0,INDIA VIX,0.05,1,0,1,INDIAVIX,N,,INDIAVIX,",
  "N,D,35001,NIFTY,2026-11-26 00:00:00,XX,0,NIFTY 26 Nov 2026,0.05,75,0,1,NIFTY,N,,NIFTY_20261126,",
].join("\r\n");

test("scrip master: parses quoted CSV and resolves the India universe + VIX", () => {
  const rows = parseScripMaster(CSV);
  assert.equal(rows.length, 11);
  assert.equal(rows[0]?.names.includes("RELIANCE INDUSTRIES, LTD"), true);
  const { map, notes } = resolveScrips(rows, {});
  assert.deepEqual(Object.fromEntries([...map].map(([k, v]) => [k, v.code])), {
    NIFTY: 999920000, BANKNIFTY: 999920005, RELIANCE: 2885, HDFCBANK: 1333, TCS: 11536, INFY: 1594, ICICIBANK: 4963, SBIN: 3045, INDIAVIX: 999920019,
  });
  assert.ok(notes.every((n) => !n.includes("NOT FOUND")));
  // F&O rows (ExchType D) must never be picked for the cash index
  assert.notEqual(map.get("NIFTY")?.code, 35001);
});

test("scrip master: overrides win; unknown index falls back with a visible note; missing VIX is reported", () => {
  const rows = parseScripMaster(CSV.split("\r\n").filter((l) => !/NIFTY|INDIAVIX/.test(l) || l.startsWith("Exch")).join("\n"));
  const { map, notes } = resolveScrips(rows, { RELIANCE: 42 });
  assert.equal(map.get("RELIANCE")?.code, 42);
  assert.equal(map.get("NIFTY")?.code, 999920000);
  assert.ok(notes.some((n) => n.startsWith("NIFTY=999920000 (fallback")));
  assert.ok(notes.some((n) => n.startsWith("INDIAVIX: NOT FOUND")));
  assert.throws(() => parseScripMaster("foo,bar\n1,2"), /unexpected header/);
});

test("ticks: quote fields, forming daily bar, VIX has no bar, unknown tokens ignored", () => {
  const book = new IndiaBook();
  book.setScrips(new Map([["SBIN", { exch: "N", exchType: "C", code: 3045 }], ["INDIAVIX", { exch: "N", exchType: "C", code: 999920019 }]]));
  const now = Date.UTC(2026, 10, 11, 6, 0, 0); // 11:30 IST
  book.apply({ Token: 3045, LastRate: 812.5, PClose: 800, OpenRate: 805, High: 815, Low: 801, TotalQty: 123456, BidRate: 812.45, OffRate: 812.55, BidQty: 10, OffQty: 20, TickDt: `/Date(${now - 1000}+0530)/` }, now);
  book.apply({ Token: 999920019, LastRate: 13.2, PClose: 13.0, OpenRate: 13.1, High: 13.4, Low: 12.9 }, now);
  book.apply({ Token: 1, LastRate: 1 }, now);
  book.apply({ Token: 3045, LastRate: 0 }, now); // ignored: no price
  const q = book.quotes.get("SBIN");
  assert.equal(q?.price, 812.5);
  assert.equal(q?.changePct, 1.563);
  assert.equal(q?.source, "5paisa");
  assert.equal(q?.asOf, new Date(now - 1000).toISOString());
  assert.deepEqual(book.bars.get("SBIN"), { symbol: "SBIN", tf: "1D", t: dayT("2026-11-11"), o: 805, h: 815, l: 801, c: 812.5, v: 123456 });
  assert.equal(book.bars.has("INDIAVIX"), false);
  assert.equal(book.quotes.size, 2);
  assert.deepEqual(book.takeQuotes(false, "x").map((x) => x.symbol).sort(), ["INDIAVIX", "SBIN"]);
  assert.equal(book.takeQuotes(false, "x").length, 0, "dirty set clears after a push");
  assert.equal(book.takeQuotes(true, "2026-11-11T06:01:00.000Z")[0]?.asOf, "2026-11-11T06:01:00.000Z", "heartbeat re-stamps asOf");
  assert.deepEqual(book.quiet(now + 30_000, 20_000).sort(), ["INDIAVIX", "SBIN"]);
});

test("ticks: an old replayed TickDt is clamped to the push clock", () => {
  const book = new IndiaBook();
  book.setScrips(new Map([["SBIN", { exch: "N", exchType: "C", code: 3045 }]]));
  const now = Date.UTC(2026, 10, 11, 6, 0, 0);
  book.apply({ Token: 3045, LastRate: 800, PClose: 790, OpenRate: 795, High: 801, Low: 794, TickDt: `/Date(${now - 600_000}+0530)/` }, now);
  assert.equal(book.quotes.get("SBIN")?.asOf, new Date(now - 5000).toISOString());
});

test("dates, IST and feed host routing", () => {
  assert.equal(parseNetDate("/Date(1706956047000+0530)/"), 1706956047000);
  assert.equal(parseNetDate("/Date(-62135596800000)/"), null);
  assert.equal(parseNetDate(undefined), null);
  assert.equal(istYmd(Date.UTC(2026, 10, 10, 19, 0)), "2026-11-11"); // 00:30 IST next day
  assert.equal(dayT("2026-11-11"), Date.UTC(2026, 10, 11) / 1000);
  const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
  assert.match(feedUrlFor(jwt({ RedirectServer: "A" })), /^wss:\/\/aopenfeed\./);
  assert.match(feedUrlFor(jwt({ RedirectServer: "B" })), /^wss:\/\/bopenfeed\./);
  assert.match(feedUrlFor(jwt({ RedirectServer: "C" })), /^wss:\/\/openfeed\./);
  assert.match(feedUrlFor("garbage"), /^wss:\/\/openfeed\./);
});

test("VIX snapshot: dedupes by date (later wins), sorted, capped at 260", () => {
  const hist: [string, number][] = [];
  for (let k = 0; k < 300; k++) hist.push([new Date(Date.UTC(2025, 0, 1) + k * 86400000).toISOString().slice(0, 10), 10 + k / 100]);
  hist.push(["2025-01-01", 99]);
  const s = vixSnapshot(hist, "2026-11-11T00:00:00.000Z");
  const h = (s.json as { history: [string, number][] }).history;
  assert.equal(h.length, 260);
  assert.equal(s.key, "ctx:IN");
  assert.equal(s.source, "5paisa");
  assert.ok(h.every((x, i) => i === 0 || (h[i - 1] as [string, number])[0] < x[0]));
});
