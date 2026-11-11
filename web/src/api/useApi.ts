import { useCallback, useEffect, useSyncExternalStore } from "react";

/**
 * Minimal stale-while-revalidate cache.
 * useApi(key, fetcher): returns the cached value immediately (if any), revalidates in the
 * background on mount / key change / every `refreshMs`, and dedupes concurrent requests.
 * key === null disables the request (e.g. signed out).
 */
interface Entry<T = unknown> {
  data: T | undefined;
  error: unknown;
  at: number;
  inflight: Promise<T> | null;
  listeners: Set<() => void>;
  snap: Snapshot<T>;
}

export interface Snapshot<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
}

const cache = new Map<string, Entry>();

function entry<T>(key: string): Entry<T> {
  let e = cache.get(key) as Entry<T> | undefined;
  if (!e) {
    e = { data: undefined, error: null, at: 0, inflight: null, listeners: new Set(), snap: { data: undefined, error: null, loading: false } };
    cache.set(key, e as Entry);
  }
  return e;
}

function publish<T>(e: Entry<T>) {
  e.snap = { data: e.data, error: e.error, loading: !!e.inflight };
  e.listeners.forEach((l) => l());
}

export function revalidate<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const e = entry<T>(key);
  if (e.inflight) return e.inflight;
  const p = fetcher()
    .then((d) => {
      e.data = d;
      e.error = null;
      e.at = Date.now();
      return d;
    })
    .catch((err) => {
      e.error = err;
      throw err;
    })
    .finally(() => {
      e.inflight = null;
      publish(e);
    });
  e.inflight = p;
  publish(e);
  return p;
}

/** Overwrite (optimistic) or re-fetch a cached key from anywhere. */
export function mutate<T>(key: string, next: T | ((prev: T | undefined) => T)) {
  const e = entry<T>(key);
  e.data = typeof next === "function" ? (next as (p: T | undefined) => T)(e.data) : next;
  e.error = null;
  publish(e);
}

/** Drop every cached key that starts with `prefix` (e.g. on sign-out). */
export function clearCache(prefix = "") {
  for (const [k, e] of cache) {
    if (!k.startsWith(prefix)) continue;
    e.data = undefined;
    e.error = null;
    e.at = 0;
    publish(e);
  }
}

const EMPTY: Snapshot<never> = { data: undefined, error: null, loading: false };

export function useApi<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  opts: { refreshMs?: number; staleMs?: number } = {},
): Snapshot<T> & { reload: () => Promise<T | undefined>; mutate: (next: T | ((prev: T | undefined) => T)) => void } {
  const { refreshMs, staleMs = 5_000 } = opts;
  const snap = useSyncExternalStore(
    useCallback(
      (l: () => void) => {
        if (!key) return () => undefined;
        const e = entry<T>(key);
        e.listeners.add(l);
        return () => e.listeners.delete(l);
      },
      [key],
    ),
    () => (key ? entry<T>(key).snap : (EMPTY as Snapshot<T>)),
  );

  useEffect(() => {
    if (!key) return;
    const e = entry<T>(key);
    if (Date.now() - e.at > staleMs) revalidate(key, fetcher).catch(() => undefined);
    if (!refreshMs) return;
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") revalidate(key, fetcher).catch(() => undefined);
    }, refreshMs);
    return () => window.clearInterval(t);
    // fetcher identity is intentionally not a dependency (callers pass inline closures)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refreshMs, staleMs]);

  const reload = useCallback(async () => {
    if (!key) return undefined;
    try {
      return await revalidate(key, fetcher);
    } catch {
      return undefined;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const mut = useCallback(
    (next: T | ((prev: T | undefined) => T)) => {
      if (key) mutate(key, next);
    },
    [key],
  );
  return { ...snap, loading: snap.loading || (!!key && snap.data === undefined && !snap.error), reload, mutate: mut };
}
