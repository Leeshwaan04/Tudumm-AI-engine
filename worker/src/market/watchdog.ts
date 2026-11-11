// Feed watchdog (runs from Cloudflare, so it still works when the owner's Mac or VPS is down).
// Every minute during NSE hours (+ every 15 min for crypto) it checks how old the newest live quote
// is, records the state in snapshots `meta:watchdog:<feed>`, and pushes a phone alert via ntfy (NTFY_TOPIC)
// when a feed stops, every 30 min while it stays down, and when it recovers. It also reminds the
// owner to log in to Kite on trading days (Kite requires a manual login every day).
import type { Env } from "../env";
import type { MarketDb } from "./store";
import { parseJson, stmt } from "./store";
import { INSTRUMENTS, nseSessionOpen } from "./instruments";

const IN_SYMBOLS = INSTRUMENTS.filter((i) => i.market === "IN").map((i) => i.symbol);
/** No India quote for this long during the session = the feed is down. */
export const INDIA_STALE_SEC = 180;
/** Crypto is pushed every 15 s by the live runner; the Worker can't fetch it itself (403s). */
export const CRYPTO_STALE_SEC = 600;
const REPEAT_MS = 30 * 60_000;

export type FeedName = "india" | "crypto";
export interface FeedState {
  ok: boolean;
  since: string; // when it entered this state
  lastAlertAt: string | null;
  ageSec: number | null;
}
export interface WatchdogState {
  feeds: Partial<Record<FeedName, FeedState>>;
  kiteReminderDay: string | null;
  checkedAt: string;
}

function ist(ms: number) {
  const d = new Date(ms + 330 * 60000);
  return { ymd: d.toISOString().slice(0, 10), dow: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes(), hhmm: d.toISOString().slice(11, 16) };
}

/** India is only judged inside the session, after a 3-minute grace for the open (09:18–15:30 IST). */
export function indiaCheckDue(nowMs: number): boolean {
  if (!nseSessionOpen(nowMs)) return false;
  return ist(nowMs).min >= 9 * 60 + 18;
}

/**
 * Order guard (pure): during the NSE session an India ticket needs Tudumm's own live quote for that
 * instrument (5paisa, <= INDIA_STALE_SEC old). Returns why not, or null when trading may proceed.
 * Outside the session (after-market orders) there is no live price to compare, so it doesn't block.
 */
export function indiaQuoteProblem(quote: { as_of: string; source: string } | null, nowMs: number): { ageSec: number | null; reason: string } | null {
  if (!nseSessionOpen(nowMs)) return null;
  if (!quote) return { ageSec: null, reason: "no live quote" };
  const ageSec = Math.max(0, (nowMs - Date.parse(quote.as_of)) / 1000);
  if (quote.source !== "5paisa") return { ageSec, reason: `the latest price is from ${quote.source}, not the live feed` };
  if (ageSec > INDIA_STALE_SEC) return { ageSec, reason: `the live price is ${Math.round(ageSec / 60)} min old` };
  return null;
}

/** Pure decision: next state + the alerts to send. */
export function decide(
  prev: WatchdogState | null,
  nowMs: number,
  ages: Partial<Record<FeedName, number | null>>,
): { next: WatchdogState; alerts: { feed: FeedName; kind: "down" | "still_down" | "recovered"; ageSec: number | null }[] } {
  const now = new Date(nowMs).toISOString();
  const next: WatchdogState = { feeds: { ...(prev?.feeds ?? {}) }, kiteReminderDay: prev?.kiteReminderDay ?? null, checkedAt: now };
  const alerts: { feed: FeedName; kind: "down" | "still_down" | "recovered"; ageSec: number | null }[] = [];
  for (const feed of Object.keys(ages) as FeedName[]) {
    const age = ages[feed] ?? null;
    const limit = feed === "india" ? INDIA_STALE_SEC : CRYPTO_STALE_SEC;
    const ok = age !== null && age <= limit;
    const was = next.feeds[feed];
    if (!was) {
      next.feeds[feed] = { ok, since: now, lastAlertAt: ok ? null : now, ageSec: age };
      if (!ok) alerts.push({ feed, kind: "down", ageSec: age });
      continue;
    }
    if (was.ok && !ok) {
      next.feeds[feed] = { ok, since: now, lastAlertAt: now, ageSec: age };
      alerts.push({ feed, kind: "down", ageSec: age });
    } else if (!was.ok && ok) {
      next.feeds[feed] = { ok, since: now, lastAlertAt: now, ageSec: age };
      alerts.push({ feed, kind: "recovered", ageSec: age });
    } else if (!ok && (!was.lastAlertAt || nowMs - Date.parse(was.lastAlertAt) >= REPEAT_MS)) {
      next.feeds[feed] = { ...was, lastAlertAt: now, ageSec: age };
      alerts.push({ feed, kind: "still_down", ageSec: age });
    } else next.feeds[feed] = { ...was, ageSec: age };
  }
  return { next, alerts };
}

/** POST a phone notification to ntfy.sh/<NTFY_TOPIC>. Best effort; never throws. */
export async function pushAlert(env: Pick<Env, "NTFY_TOPIC">, title: string, body: string, priority: "high" | "default", tags: string): Promise<boolean> {
  const topic = env.NTFY_TOPIC;
  if (!topic || !/^[A-Za-z0-9_-]{16,64}$/.test(topic)) return false;
  try {
    const res = await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      headers: { Title: title, Priority: priority === "high" ? "5" : "3", Tags: tags, "Content-Type": "text/plain; charset=utf-8" },
      body,
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const mins = (s: number | null) => (s === null ? "no data" : s < 120 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);

function alertText(feed: FeedName, kind: "down" | "still_down" | "recovered", ageSec: number | null, nowMs: number): { title: string; body: string; priority: "high" | "default"; tags: string } {
  const what = feed === "india" ? "India live data (5paisa)" : "Crypto live data";
  const at = `${ist(nowMs).hhmm} IST`;
  if (kind === "recovered") return { title: `Tudumm: ${what} recovered`, body: `${what} is updating again (${at}).`, priority: "default", tags: "white_check_mark" };
  return {
    title: `Tudumm: ${what} ${kind === "down" ? "STOPPED" : "still down"}`,
    body: `Last update ${mins(ageSec)} ago (${at}). Calls for these instruments are not refreshing: don't act on them until this recovers. Check that the live feed is running (Mac awake and online, or the VPS).`,
    priority: "high",
    tags: "warning",
  };
}

/** One watchdog pass (cron). Returns a short summary for the cron log. */
export async function runWatchdog(env: Env, db: MarketDb, nowMs: number, scope: FeedName): Promise<string> {
  // one state row per scope: the minute cron (india) and the 15-min cron (crypto) can run in the same minute
  const key = `meta:watchdog:${scope}`;
  const [qRows, stRows, kiteRows] = await db.read([
    stmt(
      `SELECT (SELECT MAX(as_of) FROM quotes WHERE source = '5paisa' AND symbol IN (SELECT value FROM json_each(?))) AS india_as_of,
              (SELECT as_of FROM quotes WHERE symbol = 'BTCUSDT') AS crypto_as_of`,
      JSON.stringify(IN_SYMBOLS),
    ),
    stmt(`SELECT json FROM snapshots WHERE key = ?`, key),
    stmt(`SELECT COUNT(*) AS n FROM broker_sessions WHERE revoked_at IS NULL AND expires_at > ?`, new Date(nowMs).toISOString()),
  ]);
  const age = (iso: unknown) => (iso ? Math.max(0, (nowMs - Date.parse(String(iso))) / 1000) : null);
  const ages: Partial<Record<FeedName, number | null>> = {};
  if (scope === "india" && indiaCheckDue(nowMs)) ages.india = age(qRows?.[0]?.india_as_of);
  if (scope === "crypto") ages.crypto = age(qRows?.[0]?.crypto_as_of);
  const prev = parseJson<WatchdogState | null>(stRows?.[0]?.json, null);
  const { next, alerts } = decide(prev, nowMs, ages);
  const sent: string[] = [];
  for (const a of alerts) {
    const t = alertText(a.feed, a.kind, a.ageSec, nowMs);
    const ok = await pushAlert(env, t.title, t.body, t.priority, t.tags);
    sent.push(`${a.feed}:${a.kind}${ok ? "" : "(not sent)"}`);
    console.log(JSON.stringify({ component: "watchdog", feed: a.feed, kind: a.kind, ageSec: a.ageSec, pushed: ok }));
  }
  // Kite needs a manual login every trading day (tokens end 06:00 IST): one reminder at ~09:00 IST.
  const p = ist(nowMs);
  if (scope === "india" && env.KITE_API_KEY && p.dow >= 1 && p.dow <= 5 && p.min >= 9 * 60 && p.min < 9 * 60 + 15 && next.kiteReminderDay !== p.ymd && Number(kiteRows?.[0]?.n ?? 0) === 0) {
    next.kiteReminderDay = p.ymd;
    const ok = await pushAlert(env, "Tudumm: log in to Kite for today", "Kite sessions end at 06:00 IST. Open tudumm.in/admin -> Broker -> Connect Kite before you trade.", "default", "key");
    sent.push(`kite:reminder${ok ? "" : "(not sent)"}`);
  }
  const iso = new Date(nowMs).toISOString();
  await db.write([stmt(`INSERT OR REPLACE INTO snapshots (key, json, as_of, source, updated_at) VALUES (?, ?, ?, 'engine', ?)`, key, JSON.stringify(next), iso, iso)]);
  const st = (Object.entries(next.feeds) as [FeedName, FeedState][]).map(([f, s]) => `${f}:${s.ok ? "ok" : "DOWN"}(${mins(s.ageSec)})`).join(" ");
  return `watchdog ${st || "idle (market closed)"}${sent.length ? `; alerts ${sent.join(",")}` : ""}`;
}
