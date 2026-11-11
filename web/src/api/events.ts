// First-party product analytics: POST /api/v1/events (worker/src/api/events.ts).
// - only allowlisted event names leave the browser (the server drops anything else too)
// - batched: flushed every 10 s, at 25 events, and when the tab is hidden (sendBeacon)
// - anonymous id in localStorage; linked to the account server-side when a session exists
// - "Allow product analytics" off => track() is a no-op and the queue is dropped
// - props are flat and short; never put emails, names or free text in them
import { useSyncExternalStore } from "react";
import { onListToggle, storage } from "../engine/profile";

export const EVENT_NAMES = [
  "page_view",
  "instrument_view",
  "signal_view",
  "track_toggle",
  "watchlist_toggle",
  "alert_create",
  "search",
  "onboarding_step",
  "onboarding_complete",
  "plan_view",
  "upgrade_click",
  "extension_preview",
  "extension_link",
  "verify_chain",
  "tamper_test",
  "signup_start",
  "login",
  "logout",
  "support_submit",
  "sizer_use",
  "filter_change",
] as const;
export type EventName = (typeof EVENT_NAMES)[number];
const ALLOWED = new Set<string>(EVENT_NAMES);

type Prop = string | number | boolean | null;
interface QueuedEvent {
  name: EventName;
  props?: Record<string, Prop>;
  path: string;
  ts: number;
}

const ANON_KEY = "tudumm.anon.v1";
const OPT_KEY = "tudumm.analytics.v1";
const MAX_BATCH = 25;
const FLUSH_MS = 10_000;

function anonId(): string {
  let id = storage.get(ANON_KEY);
  if (id && /^[A-Za-z0-9_-]{8,64}$/.test(id)) return id;
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  id = btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  storage.set(ANON_KEY, id);
  return id;
}

/* ---------------- opt-out (default on) ---------------- */
let enabled = storage.get(OPT_KEY) !== "off";
const optListeners = new Set<() => void>();
export function setAnalyticsEnabled(on: boolean) {
  enabled = on;
  storage.set(OPT_KEY, on ? "on" : "off");
  if (!on) queue = [];
  optListeners.forEach((l) => l());
}
export function useAnalyticsEnabled(): boolean {
  return useSyncExternalStore(
    (l) => {
      optListeners.add(l);
      return () => optListeners.delete(l);
    },
    () => enabled,
  );
}

/* ---------------- queue ---------------- */
let queue: QueuedEvent[] = [];
let timer = 0;
let apiDown = false;

function cleanProps(p: Record<string, unknown> | undefined): Record<string, Prop> | undefined {
  if (!p) return undefined;
  const out: Record<string, Prop> = {};
  let n = 0;
  for (const [k, v] of Object.entries(p)) {
    if (n >= 12 || !/^[A-Za-z0-9_]{1,40}$/.test(k)) continue;
    if (typeof v === "string") out[k] = v.slice(0, 120);
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = Math.round(v * 1e4) / 1e4;
    else if (typeof v === "boolean" || v === null) out[k] = v;
    else continue;
    n++;
  }
  return n ? out : undefined;
}

export function track(name: EventName, props?: Record<string, unknown>) {
  if (!enabled || !ALLOWED.has(name) || typeof window === "undefined") return;
  queue.push({ name, props: cleanProps(props), path: window.location.pathname, ts: Date.now() });
  if (queue.length >= MAX_BATCH) void flush();
  else if (!timer) timer = window.setTimeout(() => void flush(), FLUSH_MS);
}

function body(events: QueuedEvent[]) {
  return JSON.stringify({ anonId: anonId(), source: "web", events: events.map((e) => ({ name: e.name, props: e.props, path: e.path, ts: e.ts })) });
}

export async function flush(useBeacon = false): Promise<void> {
  window.clearTimeout(timer);
  timer = 0;
  if (!enabled || !queue.length || apiDown) {
    queue = apiDown ? [] : queue;
    return;
  }
  const batch = queue.splice(0, MAX_BATCH);
  const payload = body(batch);
  if (useBeacon && typeof navigator.sendBeacon === "function") {
    const ok = navigator.sendBeacon("/api/v1/events", new Blob([payload], { type: "application/json" }));
    if (ok) return;
  }
  try {
    const res = await fetch("/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      credentials: "same-origin",
      keepalive: true,
    });
    // No API behind this origin (static preview): stop trying for this page session.
    if (res.status === 404 || (res.status >= 500 && !(res.headers.get("content-type") ?? "").includes("json"))) apiDown = true;
  } catch {
    // network blip: put the batch back once (bounded)
    if (queue.length < 100) queue.unshift(...batch);
  }
  if (queue.length) timer = window.setTimeout(() => void flush(), FLUSH_MS);
}

if (typeof window !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flush(true);
  });
  window.addEventListener("pagehide", () => void flush(true));
}

// watchlist / tracking toggles anywhere in the app
onListToggle((store, symbol, on) => track(store === "watchlist" ? "watchlist_toggle" : "track_toggle", { symbol, on }));
