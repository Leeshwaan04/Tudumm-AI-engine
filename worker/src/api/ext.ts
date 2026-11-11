// Extension linking — OAuth-device-flow style.
//   1. extension: POST /api/v1/ext/link/start            -> {userCode, deviceToken, verifyUrl, expiresIn, interval}
//   2. user (signed in on the site): POST /ext/link/approve {userCode}
//   3. extension: POST /api/v1/ext/link/poll {deviceToken} -> pending | approved + token (exactly once) | expired
// The issued token is a kind=extension session (Bearer only, 180 days sliding, revocable in /me/sessions).
import { hashSecret, randomToken, randomUserCode, USER_CODE_ALPHABET } from "../lib/crypto";
import { json } from "../lib/edge";
import { first, isoIn, newId, nowIso } from "../lib/db";
import { isFlagOn } from "../lib/flags";
import { HttpError, readJsonObject, siteOrigin, userAgent } from "../lib/http";
import { enforce } from "../lib/ratelimit";
import { createSession } from "../lib/session";
import * as v from "../lib/validate";
import type { Ctx, RouteDef } from "./context";
import { requireUser } from "./context";
import { serverEventStmt } from "./userdata";

const LINK_TTL_MS = 10 * 60_000;
const POLL_INTERVAL_S = 5;
const DEVICE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const CODE_RE = new RegExp(`^[${USER_CODE_ALPHABET}]{8}$`);

function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function normalizeCode(raw: unknown): string {
  if (typeof raw !== "string") throw v.invalid("userCode", "must be the 8-character code shown in the extension");
  const s = raw.toUpperCase().replace(/[\s-]/g, "");
  if (!CODE_RE.test(s)) throw v.invalid("userCode", "must be the 8-character code shown in the extension");
  return s;
}

async function requireLinking(c: Ctx): Promise<void> {
  if (!(await isFlagOn(c.env, "extension_linking"))) throw new HttpError(503, "extension_linking_disabled");
}

async function linkStart(c: Ctx): Promise<Response> {
  await requireLinking(c);
  await readJsonObject(c.req, 1024);
  await enforce(c.env, `ext_start:ip:${await c.ipHash()}`, 10, 3600);
  const deviceToken = randomToken();
  const now = nowIso();
  const expiresAt = isoIn(LINK_TTL_MS);
  const tokenHash = await hashSecret(c.env, "device", deviceToken);
  // user_code is UNIQUE; on the (tiny) chance of a collision with a live code, retry.
  for (let attempt = 0; attempt < 3; attempt++) {
    const userCode = randomUserCode(8);
    const res = await c.env.DB.prepare(
      "INSERT OR IGNORE INTO ext_link_codes (id, user_code, device_token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(newId(), userCode, tokenHash, now, expiresAt)
      .run();
    if (Number(res.meta?.changes ?? 0)) {
      const pretty = formatCode(userCode);
      return json({
        userCode: pretty,
        deviceToken,
        verifyUrl: `${siteOrigin(c.env, c.req)}/app/link?code=${pretty}`,
        expiresIn: LINK_TTL_MS / 1000,
        interval: POLL_INTERVAL_S,
      });
    }
  }
  throw new HttpError(503, "try_again");
}

async function linkApprove(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  await requireLinking(c);
  const body = await readJsonObject(c.req, 1024);
  const code = normalizeCode(body.userCode);
  // Brute-force guard on top of the 31^8 code space and 10-minute lifetime.
  await enforce(c.env, `ext_approve:user:${user.id}`, 10, 900);
  const now = nowIso();
  const row = await first<{ id: string }>(
    c.env,
    "UPDATE ext_link_codes SET user_id = ?1, approved_at = ?2 WHERE user_code = ?3 AND approved_at IS NULL AND consumed_at IS NULL AND expires_at > ?2 RETURNING id",
    user.id,
    now,
    code,
  );
  if (!row) throw new HttpError(404, "code_not_found", { message: "That code is wrong, expired or already used. Start again from the extension." });
  return json({ ok: true, approved: true });
}

async function linkPoll(c: Ctx): Promise<Response> {
  const body = await readJsonObject(c.req, 1024);
  const deviceToken = body.deviceToken;
  if (typeof deviceToken !== "string" || !DEVICE_TOKEN_RE.test(deviceToken)) throw v.invalid("deviceToken", "is required");
  await enforce(c.env, `ext_poll:ip:${await c.ipHash()}`, 240, 3600);
  const tokenHash = await hashSecret(c.env, "device", deviceToken);
  const row = await first<{ id: string; user_id: string | null; expires_at: string; approved_at: string | null; consumed_at: string | null }>(
    c.env,
    "SELECT id, user_id, expires_at, approved_at, consumed_at FROM ext_link_codes WHERE device_token_hash = ?",
    tokenHash,
  );
  if (!row) throw new HttpError(404, "unknown_device");
  if (row.consumed_at) return json({ status: "consumed" }, {}, 410);
  if (!row.approved_at || !row.user_id) {
    if (Date.parse(row.expires_at) <= Date.now()) return json({ status: "expired" }, {}, 410);
    return json({ status: "pending", interval: POLL_INTERVAL_S });
  }
  // Claim exactly once (two concurrent polls can't both get a token).
  const claimed = await first<{ id: string }>(
    c.env,
    "UPDATE ext_link_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL RETURNING id",
    nowIso(),
    row.id,
  );
  if (!claimed) return json({ status: "consumed" }, {}, 410);
  const owner = await first<{ status: string }>(c.env, "SELECT status FROM users WHERE id = ?", row.user_id);
  if (!owner || owner.status !== "active") return json({ status: "expired" }, {}, 410);
  const session = await createSession(c.env, row.user_id, "extension", userAgent(c.req));
  await serverEventStmt(c.env, c.req, row.user_id, "extension_link", { linked: true }, "extension").run();
  return json({ status: "approved", token: session.token, tokenType: "Bearer", sessionId: session.id, expiresAt: session.expiresAt });
}

export const extRoutes: RouteDef[] = [
  { method: "POST", path: "/api/v1/ext/link/start", auth: "none", csrf: "extension", cors: true, noWriteLimit: true, handler: linkStart },
  { method: "POST", path: "/api/v1/ext/link/approve", auth: "user", cookieOnly: true, handler: linkApprove },
  { method: "POST", path: "/api/v1/ext/link/poll", auth: "none", csrf: "extension", cors: true, noWriteLimit: true, handler: linkPoll },
];
