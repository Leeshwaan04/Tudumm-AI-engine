import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";

export interface Query<T> {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
  /** True while refetching with previous data still on screen. */
  refreshing: boolean;
  fetchedAt: number | null;
  reload: () => void;
  setData: (fn: (d: T | null) => T | null) => void;
}

/**
 * GET a JSON path. Keeps the previous render while refetching (no skeleton flash).
 * `path = null` skips the request. Data lives only in React state (never localStorage).
 */
export function useApi<T>(path: string | null): Query<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState<boolean>(path !== null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    api<T>(path, { signal: ctrl.signal })
      .then((d) => {
        setDataState(d);
        setError(null);
        setFetchedAt(Date.now());
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const setData = useCallback((fn: (d: T | null) => T | null) => setDataState((d) => fn(d)), []);
  return { data, error, loading: loading && data === null, refreshing: loading && data !== null, fetchedAt, reload, setData };
}

export function useInterval(fn: () => void, ms: number | null): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const id = window.setInterval(() => ref.current(), ms);
    return () => window.clearInterval(id);
  }, [ms]);
}

/** Re-render every `ms` (for relative times and countdowns). */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), ms);
  return now;
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** Run a mutation with pending + error state. */
export function useMutation<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const ref = useRef(fn);
  ref.current = fn;
  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setPending(true);
    setError(null);
    try {
      return await ref.current(...args);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);
  const reset = useCallback(() => setError(null), []);
  return { run, pending, error, reset };
}
