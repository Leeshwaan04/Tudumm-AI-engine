// Feature flags (D1 table feature_flags). Defaults apply when a row is missing.
import type { Env } from "../env";
import { parseJson } from "./db";

export const FLAG_DEFAULTS: Record<string, boolean> = {
  require_signal_approval: false,
  live_data: true,
  signups: true,
  extension_linking: true,
};

/** Flags safe to expose on the public /api/v1/config. */
export const PUBLIC_FLAGS = ["live_data", "signups", "extension_linking"] as const;

export interface FlagRow {
  key: string;
  enabled: boolean;
  value: unknown;
  updatedAt: string;
  updatedBy: string;
}

export async function loadFlags(env: Pick<Env, "DB">): Promise<Record<string, FlagRow>> {
  const res = await env.DB.prepare("SELECT key, enabled, value, updated_at, updated_by FROM feature_flags LIMIT 200").all<{
    key: string;
    enabled: number;
    value: string | null;
    updated_at: string;
    updated_by: string;
  }>();
  const out: Record<string, FlagRow> = {};
  for (const r of res.results ?? []) {
    out[r.key] = { key: r.key, enabled: r.enabled === 1, value: parseJson(r.value, null), updatedAt: r.updated_at, updatedBy: r.updated_by };
  }
  return out;
}

export function flagOn(flags: Record<string, FlagRow>, key: string): boolean {
  const f = flags[key];
  return f ? f.enabled : (FLAG_DEFAULTS[key] ?? false);
}

export async function isFlagOn(env: Pick<Env, "DB">, key: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT enabled FROM feature_flags WHERE key = ?").bind(key).first<{ enabled: number }>();
  return r ? r.enabled === 1 : (FLAG_DEFAULTS[key] ?? false);
}
