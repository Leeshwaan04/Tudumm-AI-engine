// CONTRACT between the data/engine agent (caller) and the backend-core agent (implementer).
// The engine calls these after each run; backend-core implements alert evaluation and
// notifications (in-app rows, email when a provider is configured). Keep signatures stable.
//
// Cost model (Free plan safe): each call issues a CONSTANT number of D1 statements regardless of
// how many users match (lists are passed as one JSON parameter and expanded with json_each), and at
// most ONE email subrequest (Resend batch, <= 100 recipients). Hooks never throw into the engine.
import type { Env } from "../env";
import type { SignalEvent } from "../market/types";
import { newId, nowIso } from "../lib/db";
import { emailConfigured, sendEmailBatch, type EmailMessage } from "../lib/email";
import { logError } from "../lib/log";
import { SYMBOL_RE } from "../lib/validate";

const MAX_TRIGGERS_PER_RUN = 500;
const MAX_RECIPIENTS_PER_EVENT = 1000;
/** Repeating (oneShot=false) price alerts re-fire at most once per this window. */
const REPEAT_COOLDOWN_MS = 24 * 3_600_000;
const DISCLAIMER = "Engine v0 signals are rule-based and uncalibrated. Not investment advice.";

interface Note {
  id: string;
  u: string; // user id
  k: string; // kind
  t: string; // title
  b: string; // body
  l: string; // link
  d: string; // dedupe key
}

function fmt(n: unknown): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const dp = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return n.toLocaleString("en-US", { maximumFractionDigits: dp });
}

function linkFor(symbol: string): string {
  return `/app/i/${encodeURIComponent(symbol)}`;
}

async function insertNotes(env: Env, notes: Note[]): Promise<number> {
  if (!notes.length) return 0;
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO notifications (id, user_id, kind, title, body, link, created_at, dedupe_key)
     SELECT json_extract(value, '$.id'), json_extract(value, '$.u'), json_extract(value, '$.k'), json_extract(value, '$.t'),
            json_extract(value, '$.b'), json_extract(value, '$.l'), ?1, json_extract(value, '$.d')
     FROM json_each(?2)`,
  )
    .bind(nowIso(), JSON.stringify(notes))
    .run();
  return Number(res.meta?.changes ?? 0);
}

/** Email copies for users with a VERIFIED address only (dev-code accounts never get email). */
async function emailNotes(env: Env, notes: Note[], siteUrl: string): Promise<number> {
  if (!emailConfigured(env) || !notes.length) return 0;
  const userIds = [...new Set(notes.map((n) => n.u))].slice(0, 100);
  const res = await env.DB.prepare(
    "SELECT id, email FROM users WHERE id IN (SELECT value FROM json_each(?1)) AND email_verified = 1 AND status = 'active'",
  )
    .bind(JSON.stringify(userIds))
    .all<{ id: string; email: string }>();
  const emailOf = new Map((res.results ?? []).map((r) => [r.id, r.email]));
  const msgs: EmailMessage[] = [];
  for (const n of notes) {
    const to = emailOf.get(n.u);
    if (!to) continue;
    msgs.push({
      to,
      subject: `Tudumm: ${n.t}`,
      text: `${n.t}\n\n${n.b}\n\nOpen: ${siteUrl}${n.l}\n\nYou get this because you set an alert or track this signal. Manage alerts in your Tudumm profile.`,
    });
    if (msgs.length >= 100) break;
  }
  return sendEmailBatch(env, msgs);
}

function siteUrl(env: Env): string {
  try {
    return env.SITE_URL ? new URL(env.SITE_URL).origin : "";
  } catch {
    return "";
  }
}

/** Called after prices refresh. prices = { SYMBOL: lastPrice } for instruments updated this run. */
export async function onPricesUpdated(env: Env, prices: Record<string, number>): Promise<void> {
  try {
    const clean: Record<string, number> = {};
    let n = 0;
    for (const [sym, p] of Object.entries(prices ?? {})) {
      if (n >= 500) break;
      if (typeof p === "number" && Number.isFinite(p) && p > 0 && SYMBOL_RE.test(sym)) {
        clean[sym] = p;
        n++;
      }
    }
    if (!n) return;
    const now = Date.now();
    const nowStr = new Date(now).toISOString();
    const cooldown = new Date(now - REPEAT_COOLDOWN_MS).toISOString();

    // 1) Candidates: one query, comparison done in SQL against json_each({SYMBOL: price}).
    const cand = await env.DB.prepare(
      `SELECT a.id, a.user_id, a.symbol, a.kind, a.threshold, p.value AS price
       FROM json_each(?1) p
       JOIN alerts a ON a.symbol = p.key AND a.active = 1 AND a.kind IN ('price_above', 'price_below')
       JOIN users u ON u.id = a.user_id AND u.status = 'active'
       WHERE ((a.kind = 'price_above' AND p.value >= a.threshold) OR (a.kind = 'price_below' AND p.value <= a.threshold))
         AND (a.one_shot = 1 OR a.last_triggered_at IS NULL OR a.last_triggered_at < ?2)
       LIMIT ?3`,
    )
      .bind(JSON.stringify(clean), cooldown, MAX_TRIGGERS_PER_RUN)
      .all<{ id: string; user_id: string; symbol: string; kind: string; threshold: number; price: number }>();
    const rows = cand.results ?? [];
    if (!rows.length) return;

    // 2) Claim atomically (one-shot alerts deactivate) — concurrent runs can't double-fire.
    const claimed = await env.DB.prepare(
      `UPDATE alerts SET last_triggered_at = ?1, active = CASE WHEN one_shot = 1 THEN 0 ELSE active END
       WHERE id IN (SELECT value FROM json_each(?2)) AND active = 1
         AND (one_shot = 1 OR last_triggered_at IS NULL OR last_triggered_at < ?3)
       RETURNING id`,
    )
      .bind(nowStr, JSON.stringify(rows.map((r) => r.id)), cooldown)
      .all<{ id: string }>();
    const ok = new Set((claimed.results ?? []).map((r) => r.id));

    // 3) Notifications (deduped per alert per hour).
    const hour = nowStr.slice(0, 13);
    const notes: Note[] = rows
      .filter((r) => ok.has(r.id))
      .map((r) => {
        const dir = r.kind === "price_above" ? "rose above" : "fell below";
        return {
          id: newId(),
          u: r.user_id,
          k: "price_alert",
          t: `${r.symbol} ${dir} ${fmt(r.threshold)}`,
          b: `Last price ${fmt(r.price)} (your alert: ${r.kind === "price_above" ? "above" : "below"} ${fmt(r.threshold)}). Prices may be delayed depending on the market's data source.`,
          l: linkFor(r.symbol),
          d: `alert:${r.id}:${hour}`,
        };
      });
    await insertNotes(env, notes);
    await emailNotes(env, notes, siteUrl(env));
  } catch (err) {
    logError("hooks.onPricesUpdated", err);
  }
}

function describe(event: SignalEvent): { kind: "new_signal" | "signal_update"; title: string; body: string } | null {
  const sym = event.symbol;
  const dir = event.direction ?? "";
  const d = (event.detail ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case "issued":
    case "released": {
      const levels =
        typeof d.entryLow === "number" && typeof d.entryHigh === "number"
          ? ` Entry ${fmt(d.entryLow)}–${fmt(d.entryHigh)}, stop ${fmt(d.stop)}, T1 ${fmt(d.target1)}.`
          : "";
      return { kind: "new_signal", title: `New ${dir} setup on ${sym}`.replace("  ", " "), body: `A new ${dir} signal was issued for ${sym}.${levels} ${DISCLAIMER}` };
    }
    case "activated":
      return { kind: "signal_update", title: `${sym} ${dir} signal is active`, body: `Price entered the entry zone.${typeof d.price === "number" ? ` Last ${fmt(d.price)}.` : ""} ${DISCLAIMER}` };
    case "t1_hit":
      return { kind: "signal_update", title: `${sym} hit target 1`, body: `Target 1 reached; the engine moves the stop to breakeven. ${DISCLAIMER}` };
    case "closed": {
      const outcome = typeof d.outcome === "string" ? d.outcome.replace(/[^a-z_]/g, "") : "closed";
      const r = typeof d.r === "number" && Number.isFinite(d.r) ? ` (${d.r >= 0 ? "+" : ""}${d.r.toFixed(2)}R)` : "";
      return { kind: "signal_update", title: `${sym} signal closed: ${outcome}${r}`, body: `The ${dir} signal on ${sym} closed${typeof d.exit === "number" ? ` at ${fmt(d.exit)}` : ""}. Recorded in the public ledger. ${DISCLAIMER}` };
    }
    case "invalidated":
      return { kind: "signal_update", title: `${sym} signal invalidated`, body: `The ${dir} signal on ${sym} was withdrawn before completion. It stays in the ledger as an event. ${DISCLAIMER}` };
    default:
      return null; // "held": hidden from users, never notify
  }
}

/** Called for every signal lifecycle event (issued, activated, t1_hit, closed, invalidated, held). */
export async function onSignalEvent(env: Env, event: SignalEvent): Promise<void> {
  try {
    if (!event || typeof event.symbol !== "string" || !SYMBOL_RE.test(event.symbol) || typeof event.signalId !== "string") return;
    const detail = (event.detail ?? {}) as Record<string, unknown>;
    // A signal created while require_signal_approval is on is held: say nothing until "released".
    if (event.type === "issued" && (detail.held === true || detail.status === "held")) return;
    const desc = describe(event);
    if (!desc) return;
    const sid = event.signalId.slice(0, 64);
    const symKey = `sym:${event.symbol}`;

    // Recipients: matching alerts (exact symbol, or '*' + symbol on the watchlist) UNION trackers
    // of this signal or of the symbol. One query; UNION de-duplicates users.
    const res = await env.DB.prepare(
      `SELECT a.user_id AS user_id FROM alerts a JOIN users u ON u.id = a.user_id AND u.status = 'active'
        WHERE a.active = 1 AND a.kind = ?2
          AND (a.symbol = ?1 OR (a.symbol = '*' AND EXISTS (SELECT 1 FROM watchlist w WHERE w.user_id = a.user_id AND w.symbol = ?1)))
       UNION
       SELECT t.user_id FROM tracked t JOIN users u ON u.id = t.user_id AND u.status = 'active'
        WHERE t.signal_id = ?3 OR t.signal_id = ?4
       LIMIT ?5`,
    )
      .bind(event.symbol, desc.kind, sid, symKey, MAX_RECIPIENTS_PER_EVENT)
      .all<{ user_id: string }>();
    const users = (res.results ?? []).map((r) => r.user_id);
    if (!users.length) return;

    const notes: Note[] = users.map((u) => ({
      id: newId(),
      u,
      k: desc.kind,
      t: desc.title,
      b: desc.body,
      l: linkFor(event.symbol),
      d: `sig:${sid}:${event.type === "released" ? "issued" : event.type}`,
    }));
    const inserted = await insertNotes(env, notes);
    await env.DB.prepare(
      `UPDATE alerts SET last_triggered_at = ?1 WHERE active = 1 AND kind = ?2 AND (symbol = ?3 OR symbol = '*')
         AND user_id IN (SELECT value FROM json_each(?4))`,
    )
      .bind(nowIso(), desc.kind, event.symbol, JSON.stringify(users))
      .run();
    // Only email when this event produced new rows (a replayed event is deduped above).
    if (inserted > 0) await emailNotes(env, notes, siteUrl(env));
  } catch (err) {
    logError("hooks.onSignalEvent", err);
  }
}
