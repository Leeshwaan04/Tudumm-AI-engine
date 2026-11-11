import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

/**
 * Cloudflare Turnstile, loaded only when the API reports `capabilities.turnstile` and hands us a
 * site key. The script is injected on first use (never on pages that don't need it).
 */
interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  remove: (id?: string) => void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<TurnstileApi> | null = null;
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile missing")));
    s.onerror = () => {
      loading = null;
      reject(new Error("turnstile failed to load"));
    };
    document.head.appendChild(s);
  });
  return loading;
}

export interface TurnstileHandle {
  reset: () => void;
}

export const Turnstile = forwardRef<TurnstileHandle, { siteKey: string; onToken: (t: string | null) => void }>(function Turnstile({ siteKey, onToken }, ref) {
  const el = useRef<HTMLDivElement>(null);
  const id = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);
  const cb = useRef(onToken);
  cb.current = onToken;

  useImperativeHandle(ref, () => ({
    reset: () => {
      cb.current(null);
      if (id.current && window.turnstile) window.turnstile.reset(id.current);
    },
  }));

  useEffect(() => {
    let alive = true;
    loadTurnstile()
      .then((ts) => {
        if (!alive || !el.current) return;
        id.current = ts.render(el.current, {
          sitekey: siteKey,
          theme: "dark",
          callback: (t: string) => cb.current(t),
          "expired-callback": () => cb.current(null),
          "error-callback": () => cb.current(null),
        });
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (id.current && window.turnstile) {
        try {
          window.turnstile.remove(id.current);
        } catch {
          /* ignore */
        }
      }
      id.current = null;
    };
  }, [siteKey]);

  return (
    <div className="ts">
      <div ref={el} />
      {failed && <p className="form-err">The human check couldn't load. Check your connection or ad blocker, then reopen this sheet.</p>}
    </div>
  );
});
