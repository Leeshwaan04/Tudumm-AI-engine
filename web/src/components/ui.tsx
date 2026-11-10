import { useSyncExternalStore, type ReactNode } from "react";
import { useNow } from "../engine/live";
import { session, type SessionKey } from "../engine/sessions";

/* ---------- toast ---------- */
type ToastItem = { id: number; text: string };
let toasts: ToastItem[] = [];
const tl = new Set<() => void>();
let tid = 0;
export function toast(text: string) {
  const id = ++tid;
  toasts = [...toasts, { id, text }];
  tl.forEach((l) => l());
  window.setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    tl.forEach((l) => l());
  }, 2600);
}
export function Toaster() {
  const items = useSyncExternalStore(
    (l) => {
      tl.add(l);
      return () => tl.delete(l);
    },
    () => toasts,
  );
  return (
    <div className="toast-wrap" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="toast">
          {t.text}
        </div>
      ))}
    </div>
  );
}

/* ---------- demo badge + disclaimer ---------- */
export function DemoBadge() {
  return (
    <span className="demo-badge" title="All prices, signals and track-record data are simulated">
      DEMO DATA
    </span>
  );
}

export const DISCLAIMER =
  "Tudumm is a prototype. All prices, signals and track-record data are simulated. Nothing here is investment advice. Trading involves risk of loss.";

export function Disclaimer({ className = "" }: { className?: string }) {
  return <p className={`disclaimer ${className}`}>{DISCLAIMER}</p>;
}

/* ---------- session clock ---------- */
export function SessionDot({ state }: { state: string }) {
  return <i className={`sdot sdot--${state}`} aria-hidden="true" />;
}

export function SessionChip({ k, showTime = true }: { k: SessionKey; showTime?: boolean }) {
  const now = useNow(15_000);
  const s = session(k, now);
  return (
    <span className={`schip schip--${s.state}`} title={`${s.label}: ${s.status} · ${s.hours}`}>
      <SessionDot state={s.state} />
      <span className="schip__lab">{s.label}</span>
      {showTime && k !== "CRYPTO" && <span className="schip__time mono">{s.time}</span>}
      <span className="schip__st">{s.status}</span>
    </span>
  );
}

/* ---------- switch ---------- */
export function Switch({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="switch" onClick={() => onChange(!checked)}>
      <span className="switch__track" aria-hidden="true" />
      {children}
    </button>
  );
}

/* ---------- empty state ---------- */
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty__title serif">{title}</p>
      {children && <div className="empty__body">{children}</div>}
      {action && <div className="empty__act">{action}</div>}
    </div>
  );
}
