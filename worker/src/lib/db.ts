// Thin D1 helpers. EVERY statement goes through prepare().bind() — never string-built SQL with
// user input. D1 caps bound parameters at 100 per statement, so list-shaped inputs are passed as
// ONE JSON parameter and expanded with json_each(?) inside SQL.
import type { Env } from "../env";

export type Row = Record<string, unknown>;

export function nowIso(): string {
  return new Date().toISOString();
}

export function isoIn(ms: number, from = Date.now()): string {
  return new Date(from + ms).toISOString();
}

export function newId(): string {
  return crypto.randomUUID();
}

export async function first<T = Row>(env: Pick<Env, "DB">, sql: string, ...binds: unknown[]): Promise<T | null> {
  return (await env.DB.prepare(sql).bind(...binds).first<T>()) ?? null;
}

export async function all<T = Row>(env: Pick<Env, "DB">, sql: string, ...binds: unknown[]): Promise<T[]> {
  const res = await env.DB.prepare(sql).bind(...binds).all<T>();
  return res.results ?? [];
}

export async function run(env: Pick<Env, "DB">, sql: string, ...binds: unknown[]): Promise<D1Result> {
  return env.DB.prepare(sql).bind(...binds).run();
}

export function stmt(env: Pick<Env, "DB">, sql: string, ...binds: unknown[]): D1PreparedStatement {
  return env.DB.prepare(sql).bind(...binds);
}

export function changes(res: D1Result): number {
  return Number((res.meta as { changes?: number } | undefined)?.changes ?? 0);
}

export function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== "string" || !text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Escape LIKE wildcards; use with `LIKE ? ESCAPE '\'`. */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}
