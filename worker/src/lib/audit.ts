// Append-only audit log (UPDATE/DELETE are blocked by triggers in 0001_core.sql).
// detail must never contain secrets (passwords, tokens, OTPs) or raw IPs.
import type { Env } from "../env";
import { newId, nowIso } from "./db";

export function auditStmt(
  env: Pick<Env, "DB">,
  actor: string,
  action: string,
  targetType: string | null,
  targetId: string | null,
  detail?: Record<string, unknown>,
): D1PreparedStatement {
  const d = detail ? JSON.stringify(detail).slice(0, 4000) : null;
  return env.DB.prepare("INSERT INTO audit_log (id, actor, action, target_type, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(
    newId(),
    actor.slice(0, 80),
    action.slice(0, 80),
    targetType,
    targetId,
    d,
    nowIso(),
  );
}

export async function audit(
  env: Pick<Env, "DB">,
  actor: string,
  action: string,
  targetType: string | null,
  targetId: string | null,
  detail?: Record<string, unknown>,
): Promise<void> {
  await auditStmt(env, actor, action, targetType, targetId, detail).run();
}
