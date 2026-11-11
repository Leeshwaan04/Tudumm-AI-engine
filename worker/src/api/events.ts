// POST /api/v1/events — activity insights. Guests (anonId) and signed-in users. Unknown names are
// dropped, props are bounded, and no IP is stored (country + coarse device class only).
import { json } from "../lib/edge";
import { newId, nowIso } from "../lib/db";
import { clientCountry, clientDevice, HttpError, readJsonObject } from "../lib/http";
import { enforce } from "../lib/ratelimit";
import * as v from "../lib/validate";
import type { Ctx, RouteDef } from "./context";

export const EVENT_NAMES = new Set([
  "page_view",
  "instrument_view",
  "signal_view",
  "track_toggle",
  "watchlist_toggle",
  "alert_create",
  "search",
  "onboarding_step",
  "onboarding_complete",
  "plan_view",
  "upgrade_click",
  "extension_preview",
  "extension_link",
  "verify_chain",
  "tamper_test",
  "signup_start",
  "login",
  "logout",
  "support_submit",
  "sizer_use",
  "filter_change",
]);

const MAX_BATCH = 25;
const MAX_PROPS_BYTES = 2048;
const ANON_RE = /^[A-Za-z0-9_-]{8,64}$/;
const PROP_KEY_RE = /^[A-Za-z0-9_]{1,40}$/;
// Never keep anything that looks like contact data in free-form props.
const PII_LIKE = /@|\b\d{10,}\b/;

/** Flat props only: up to 20 keys, primitive values, strings <= 200 chars, JSON <= 2 KB. */
function cleanProps(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, string | number | boolean | null> = {};
  let n = 0;
  for (const [k, val] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= 20) break;
    if (!PROP_KEY_RE.test(k)) continue;
    if (typeof val === "string") {
      const s = val.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200);
      if (PII_LIKE.test(s)) continue;
      out[k] = s;
    } else if (typeof val === "number" && Number.isFinite(val)) out[k] = val;
    else if (typeof val === "boolean" || val === null) out[k] = val;
    else continue;
    n++;
  }
  if (!n) return null;
  const s = JSON.stringify(out);
  return s.length <= MAX_PROPS_BYTES ? s : JSON.stringify({ _truncated: true });
}

function cleanPath(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.startsWith("/")) return null;
  // Path only: query strings and fragments can carry personal data.
  const p = raw.split(/[?#]/)[0] ?? "";
  return p.replace(/[^A-Za-z0-9/_\-.:~%]/g, "").slice(0, 200) || null;
}

function cleanTs(raw: unknown, now: number): string {
  let t: number | null = null;
  if (typeof raw === "number" && Number.isFinite(raw)) t = raw;
  else if (typeof raw === "string" && raw.length <= 40) t = Date.parse(raw);
  // Accept client clocks within the last 24 h and up to 5 min ahead; otherwise use server time.
  if (t === null || !Number.isFinite(t) || t < now - 86_400_000 || t > now + 300_000) return new Date(now).toISOString();
  return new Date(t).toISOString();
}

async function postEvents(c: Ctx): Promise<Response> {
  const body = await readJsonObject(c.req, 64 * 1024);
  const anonRaw = body.anonId;
  const anonId = typeof anonRaw === "string" && ANON_RE.test(anonRaw) ? anonRaw : null;
  if (!anonId && !c.user) throw v.invalid("anonId", "must be 8-64 chars of A-Z a-z 0-9 _ -");
  if (!Array.isArray(body.events)) throw v.invalid("events", "must be an array");
  if (body.events.length > MAX_BATCH) throw new HttpError(400, "batch_too_large", { max: MAX_BATCH });

  await enforce(c.env, `events:ip:${await c.ipHash()}`, 60, 60);

  const now = Date.now();
  const country = clientCountry(c.req);
  const device = clientDevice(c.req);
  const source = c.via === "bearer" || body.source === "extension" ? "extension" : "web";
  const rows: { id: string; n: string; p: string | null; pa: string | null; t: string }[] = [];
  let dropped = 0;
  for (const e of body.events as unknown[]) {
    if (!e || typeof e !== "object") {
      dropped++;
      continue;
    }
    const o = e as Record<string, unknown>;
    if (typeof o.name !== "string" || !EVENT_NAMES.has(o.name)) {
      dropped++;
      continue;
    }
    rows.push({ id: newId(), n: o.name, p: cleanProps(o.props), pa: cleanPath(o.path), t: cleanTs(o.ts, now) });
  }
  if (rows.length) {
    // One statement for the whole batch (json_each), regardless of size.
    await c.env.DB.prepare(
      `INSERT INTO events (id, user_id, anon_id, name, props, path, created_at, country, device, source)
       SELECT json_extract(value, '$.id'), ?1, ?2, json_extract(value, '$.n'), json_extract(value, '$.p'), json_extract(value, '$.pa'),
              json_extract(value, '$.t'), ?3, ?4, ?5
       FROM json_each(?6)`,
    )
      .bind(c.user?.id ?? null, anonId, country, device, source, JSON.stringify(rows))
      .run();
  }
  return json({ accepted: rows.length, dropped, at: nowIso() }, {}, 202);
}

export const eventRoutes: RouteDef[] = [{ method: "POST", path: "/api/v1/events", auth: "optional", cors: true, noWriteLimit: true, handler: postEvents }];
