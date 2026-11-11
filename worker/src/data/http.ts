// Polite HTTP for data adapters: timeouts (AbortSignal.timeout), small retries with backoff on
// 429/5xx/network errors, and a per-run health collector. Runs in the Worker and in Node (runner).
import type { SourceId } from "../market/types";

export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface GetOpts {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  /** Cloudflare cache hint (Worker only; ignored by Node). */
  cacheTtl?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getRaw(url: string, opts: GetOpts = {}): Promise<Response> {
  const retries = opts.retries ?? 1;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const init: RequestInit & { cf?: Record<string, unknown> } = {
        headers: { accept: "application/json", ...(opts.headers ?? {}) },
        redirect: "follow",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
      };
      if (opts.cacheTtl) init.cf = { cacheTtl: opts.cacheTtl, cacheEverything: true };
      const res = await fetch(url, init);
      if (res.ok) return res;
      // retry only transient statuses
      if (res.status === 429 || res.status >= 500) {
        lastErr = new HttpError(res.status, `HTTP ${res.status}`);
        await res.body?.cancel();
        if (attempt < retries) await sleep(400 * (attempt + 1));
        continue;
      }
      await res.body?.cancel();
      throw new HttpError(res.status, `HTTP ${res.status}`);
    } catch (e) {
      if (e instanceof HttpError && e.status !== 429 && e.status < 500) throw e;
      lastErr = e;
      if (attempt < retries) await sleep(400 * (attempt + 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function getJson<T = unknown>(url: string, opts: GetOpts = {}): Promise<T> {
  const res = await getRaw(url, opts);
  return (await res.json()) as T;
}

export function errMsg(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  if (e instanceof Error) {
    if (e.name === "TimeoutError" || e.name === "AbortError") return "timeout";
    return e.message.slice(0, 160);
  }
  return String(e).slice(0, 160);
}

/** Collects per-source outcomes during one run; persisted once at the end (see market/store.ts). */
export class Health {
  private m = new Map<SourceId, { ok: boolean; error: string | null }>();
  ok(source: SourceId): void {
    const cur = this.m.get(source);
    // a source is healthy for this run if at least one call succeeded and none failed hard
    if (!cur) this.m.set(source, { ok: true, error: null });
  }
  fail(source: SourceId, e: unknown): void {
    this.m.set(source, { ok: false, error: errMsg(e) });
  }
  entries(): { source: SourceId; ok: boolean; error: string | null }[] {
    return [...this.m.entries()].map(([source, v]) => ({ source, ...v }));
  }
}

/** Run fn, record health, return null on failure (never throws). */
export async function tryFetch<T>(health: Health, source: SourceId, fn: () => Promise<T>): Promise<T | null> {
  try {
    const v = await fn();
    health.ok(source);
    return v;
  } catch (e) {
    health.fail(source, e);
    return null;
  }
}
