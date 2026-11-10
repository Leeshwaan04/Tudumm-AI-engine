import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const mq = typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
function subscribeRM(l: () => void) {
  mq?.addEventListener("change", l);
  return () => mq?.removeEventListener("change", l);
}
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeRM, () => mq?.matches ?? false);
}

export function useMedia(query: string): boolean {
  const [m] = useState(() => (typeof window !== "undefined" ? window.matchMedia(query) : null));
  return useSyncExternalStore(
    (l) => {
      m?.addEventListener("change", l);
      return () => m?.removeEventListener("change", l);
    },
    () => m?.matches ?? false,
  );
}

/** Counts from 0 to `target` when `runKey` changes (instant under reduced motion). */
export function useCountUp(target: number, runKey: string | number | null, duration = 900, delay = 0): number {
  const reduced = useReducedMotion();
  const [v, setV] = useState(runKey === null || reduced ? target : 0);
  const raf = useRef(0);
  useEffect(() => {
    if (runKey === null || reduced) {
      setV(target);
      return;
    }
    setV(0);
    let start = 0;
    const timer = window.setTimeout(() => {
      const tick = (t: number) => {
        if (!start) start = t;
        const p = Math.min(1, (t - start) / duration);
        const eased = 1 - Math.pow(1 - p, 3);
        setV(target * eased);
        if (p < 1) raf.current = requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);
    }, delay);
    // guarantee the final value even if rAF is throttled (background tabs, headless capture)
    const settle = window.setTimeout(() => {
      cancelAnimationFrame(raf.current);
      setV(target);
    }, delay + duration + 80);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(settle);
      cancelAnimationFrame(raf.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey, reduced]);
  // keep in sync if target changes without a re-run
  useEffect(() => {
    if (runKey === null || reduced) setV(target);
  }, [target, runKey, reduced]);
  return v;
}

export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
