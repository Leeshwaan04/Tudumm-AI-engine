// Polite fetching for the runner: browser-like UA for NSE, declared UA for SEC, ≤ 4 concurrent,
// retries on 429/5xx, and a small disk cache of compact per-day rows.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./sink.ts";

export const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const CACHE = join(ROOT, "runner", ".cache");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HttpStatus extends Error {
  status: number;
  constructor(status: number, url: string) {
    super(`HTTP ${status} ${url}`);
    this.status = status;
  }
}

export async function fetchBuf(url: string, headers: Record<string, string> = {}, timeoutMs = 60000, retries = 2): Promise<Buffer> {
  let last: unknown;
  for (let k = 0; k <= retries; k++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": BROWSER_UA, accept: "*/*", ...headers }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      await res.body?.cancel();
      if (res.status === 404 || res.status === 403) throw new HttpStatus(res.status, url);
      last = new HttpStatus(res.status, url);
    } catch (e) {
      if (e instanceof HttpStatus && (e.status === 404 || e.status === 403)) throw e;
      last = e;
    }
    await sleep(800 * (k + 1));
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export async function fetchJsonUrl<T>(url: string, headers: Record<string, string> = {}, timeoutMs = 60000): Promise<T> {
  return JSON.parse((await fetchBuf(url, headers, timeoutMs)).toString("utf8")) as T;
}

/** Run tasks with at most `n` in flight and a small gap between starts. */
export async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>, gapMs = 120): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
      await sleep(gapMs);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

export function cacheGet<T>(name: string): T | null {
  const f = join(CACHE, name);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as T;
  } catch {
    return null;
  }
}

export function cachePut(name: string, v: unknown): void {
  mkdirSync(join(CACHE, name.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(join(CACHE, name), JSON.stringify(v));
}
