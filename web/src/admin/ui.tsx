import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Check, Copy, RefreshCw, WifiOff } from "lucide-react";
import { api, ApiError, describeError, qs } from "./api";
import { dateTime, jsonPretty, timeOnly } from "./format";
import type { AuditItem, AuditPage } from "./types";

/* ---------- page chrome ---------- */

export function PageHead({ eyebrow, title, children, actions }: { eyebrow: string; title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="adm-head">
      <div className="adm-head__txt">
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="adm-head__title serif">{title}</h1>
        {children && <div className="adm-head__sub">{children}</div>}
      </div>
      {actions && <div className="adm-head__act">{actions}</div>}
    </header>
  );
}

export function Section({
  title,
  meta,
  actions,
  children,
  className = "",
  flush = false,
  id,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
  id?: string;
}) {
  return (
    <section className={`adm-card ${className}`} id={id}>
      <div className="adm-card__head">
        <div className="adm-card__ttl">
          <h2>{title}</h2>
          {meta && <span className="adm-card__meta">{meta}</span>}
        </div>
        {actions && <div className="adm-card__act">{actions}</div>}
      </div>
      <div className={flush ? "adm-card__flush" : "adm-card__body"}>{children}</div>
    </section>
  );
}

export function Refreshed({ fetchedAt, refreshing, onRefresh, label = "Refresh" }: { fetchedAt: number | null; refreshing: boolean; onRefresh: () => void; label?: string }) {
  return (
    <span className="adm-fresh">
      <span className="mono t3">{fetchedAt ? `as of ${timeOnly(fetchedAt)}` : "loading…"}</span>
      <button type="button" className="btn btn--sm btn--ghost" onClick={onRefresh} disabled={refreshing} aria-label={label}>
        <RefreshCw size={13} aria-hidden="true" className={refreshing ? "adm-spin" : undefined} />
        <span className="adm-hide-sm">{label}</span>
      </button>
    </span>
  );
}

/* ---------- states ---------- */

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="adm-loading" role="status" aria-live="polite">
      <span className="loading__beat" />
      <span className="loading__beat" />
      <span className="t3">{label}…</span>
    </div>
  );
}

export function ErrorNote({ error, onRetry, compact = false }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  const offline = error instanceof ApiError && error.offline;
  const code = error instanceof ApiError ? error.code : null;
  const status = error instanceof ApiError ? error.status : null;
  return (
    <div className={`adm-err${compact ? " adm-err--compact" : ""}`} role="alert">
      {offline ? <WifiOff size={15} aria-hidden="true" /> : <AlertTriangle size={15} aria-hidden="true" />}
      <div className="adm-err__txt">
        <p>{describeError(error)}</p>
        {code && !offline && (
          <p className="mono t3 adm-err__code">
            {status ? `HTTP ${status} · ` : ""}
            {code}
          </p>
        )}
      </div>
      {onRetry && (
        <button type="button" className="btn btn--sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="adm-empty">
      <p className="adm-empty__t serif">{title}</p>
      {children && <div className="adm-empty__b">{children}</div>}
    </div>
  );
}

/** Loading / error / content switch that keeps the previous frame while refreshing. */
export function Async<T>({
  q,
  children,
  label,
}: {
  q: { data: T | null; error: unknown; loading: boolean; refreshing: boolean; reload: () => void };
  children: (d: T) => ReactNode;
  label?: string;
}) {
  if (q.loading) return <Loading label={label} />;
  if (q.data === null) return q.error ? <ErrorNote error={q.error} onRetry={q.reload} /> : <Loading label={label} />;
  return (
    <>
      {q.error ? <ErrorNote error={q.error} onRetry={q.reload} compact /> : null}
      <div className={`adm-async${q.refreshing ? " adm-refetch" : ""}`}>{children(q.data)}</div>
    </>
  );
}

/* ---------- pills ---------- */

export type Tone = "ok" | "warn" | "bad" | "neutral" | "brand" | "info";

export function Pill({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`adm-pill adm-pill--${tone}`} title={title}>
      {children}
    </span>
  );
}

const USER_TONE: Record<string, Tone> = { active: "ok", suspended: "bad", deleted: "neutral" };
export function UserStatusPill({ status }: { status: string }) {
  return <Pill tone={USER_TONE[status] ?? "neutral"}>{status}</Pill>;
}

const PLAN_TONE: Record<string, Tone> = { free: "neutral", pro: "info", elite: "brand" };
export function PlanPill({ plan }: { plan: string }) {
  return <Pill tone={PLAN_TONE[plan] ?? "neutral"}>{plan}</Pill>;
}

const TICKET_TONE: Record<string, Tone> = { open: "brand", pending: "info", resolved: "ok", closed: "neutral" };
export function TicketStatusPill({ status }: { status: string }) {
  return <Pill tone={TICKET_TONE[status] ?? "neutral"}>{status}</Pill>;
}

/* ---------- tabs ---------- */

export function Tabs<K extends string>({ tabs, value, onChange, label }: { tabs: { key: K; label: ReactNode; count?: number }[]; value: K; onChange: (k: K) => void; label: string }) {
  return (
    <div className="adm-tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.key} type="button" role="tab" aria-selected={value === t.key} className="adm-tab" onClick={() => onChange(t.key)}>
          {t.label}
          {t.count !== undefined && <span className="adm-tab__n mono">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/* ---------- pager ---------- */

export function Pager({ page, hasMore, total, pageSize, onPage, disabled }: { page: number; hasMore: boolean; total?: number; pageSize?: number; onPage: (p: number) => void; disabled?: boolean }) {
  const pages = total !== undefined && pageSize ? Math.max(1, Math.ceil(total / pageSize)) : null;
  return (
    <nav className="adm-pager" aria-label="Pagination">
      <button type="button" className="btn btn--sm" disabled={disabled || page <= 1} onClick={() => onPage(page - 1)}>
        ← Newer
      </button>
      <span className="mono t2">
        Page {page}
        {pages !== null ? ` of ${pages}` : ""}
        {total !== undefined ? ` · ${total.toLocaleString("en-US")} total` : ""}
      </span>
      <button type="button" className="btn btn--sm" disabled={disabled || !hasMore} onClick={() => onPage(page + 1)}>
        Older →
      </button>
    </nav>
  );
}

/* ---------- copy ---------- */

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      className="btn btn--sm btn--ghost adm-copy"
      onClick={() => {
        navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setDone(true);
            setFailed(false);
            window.setTimeout(() => setDone(false), 1400);
          })
          .catch(() => setFailed(true));
      }}
      aria-label={`${label}: ${text}`}
      title={failed ? "Clipboard blocked — select and copy manually" : label}
    >
      {done ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      <span className="adm-hide-sm">{done ? "Copied" : failed ? "Blocked" : label}</span>
    </button>
  );
}

export function JsonBlock({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="t3">—</span>;
  return <pre className="adm-json mono">{jsonPretty(value)}</pre>;
}

/* ---------- confirm dialog (native <dialog>, focus-trapped, Esc closes) ---------- */

export interface ReasonSpec {
  required: boolean;
  label?: string;
  placeholder?: string;
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  tone = "primary",
  reason,
  onConfirm,
  onClose,
  pending,
  error,
  canConfirm = true,
  typeToConfirm,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  tone?: "primary" | "danger";
  reason?: ReasonSpec | null;
  onConfirm: (reason: string) => void;
  onClose: () => void;
  pending?: boolean;
  error?: unknown;
  canConfirm?: boolean;
  /** Operator must type this exact word to enable the confirm button. */
  typeToConfirm?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState("");
  const [typed, setTyped] = useState("");
  const rid = useId();
  const tid = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setText("");
      setTyped("");
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open]);

  const trimmed = text.trim();
  const reasonOk = !reason || (!reason.required && trimmed.length === 0) || (trimmed.length >= 3 && trimmed.length <= 500);
  const typedOk = !typeToConfirm || typed.trim() === typeToConfirm;
  const ok = reasonOk && typedOk && canConfirm && !pending;

  return (
    <dialog
      ref={ref}
      className="adm-dialog"
      aria-labelledby={`${rid}-t`}
      onCancel={(e) => {
        e.preventDefault();
        if (!pending) onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !pending) onClose();
      }}
    >
      {open && (
        <form
          className="adm-dialog__box"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) onConfirm(trimmed);
          }}
        >
          <h2 id={`${rid}-t`} className="adm-dialog__t serif">
            {title}
          </h2>
          {children && <div className="adm-dialog__body">{children}</div>}
          {reason && (
            <label className="field" htmlFor={`${rid}-r`}>
              <span>
                {reason.label ?? "Reason"} {reason.required ? <b className="c-brand">required</b> : <span className="t3">optional</span>}
              </span>
              <textarea
                id={`${rid}-r`}
                className="input adm-textarea"
                rows={3}
                maxLength={500}
                value={text}
                placeholder={reason.placeholder ?? "Recorded in the audit log"}
                onChange={(e) => setText(e.target.value)}
                autoFocus
              />
              <span className={`mono adm-count${trimmed.length > 0 && trimmed.length < 3 ? " c-short" : ""}`}>
                {trimmed.length}/500{reason.required ? " · min 3" : ""}
              </span>
            </label>
          )}
          {typeToConfirm && (
            <label className="field" htmlFor={tid}>
              <span>
                Type <b className="mono">{typeToConfirm}</b> to confirm
              </span>
              <input id={tid} className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
            </label>
          )}
          {error ? <ErrorNote error={error} compact /> : null}
          <div className="adm-dialog__act">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={pending}>
              Cancel
            </button>
            <button type="submit" className={`btn ${tone === "danger" ? "adm-btn-danger" : "btn--primary"}`} disabled={!ok}>
              {pending ? "Working…" : confirmLabel}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

/* ---------- audit receipt: shows the audit row an action just wrote ---------- */

export function AuditReceipt({ targetId, action, onDismiss }: { targetId: string; action: string; onDismiss: () => void }) {
  const [item, setItem] = useState<AuditItem | null | undefined>(undefined);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    api<AuditPage>(`/api/admin/audit${qs({ targetId, action })}`)
      .then((p) => {
        if (live) setItem(p.items[0] ?? null);
      })
      .catch((e) => {
        if (live) setErr(e);
      });
    return () => {
      live = false;
    };
  }, [targetId, action]);
  return (
    <div className="adm-receipt" role="status">
      <div className="adm-receipt__head">
        <Check size={14} aria-hidden="true" className="c-long" />
        <span>
          Done. Audit entry <span className="mono">{action}</span>
        </span>
        <button type="button" className="btn btn--sm btn--ghost" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      {err ? (
        <ErrorNote error={err} compact />
      ) : item ? (
        <dl className="adm-receipt__dl mono">
          <div>
            <dt>id</dt>
            <dd>{item.id}</dd>
          </div>
          <div>
            <dt>at</dt>
            <dd>{dateTime(item.at)}</dd>
          </div>
          <div>
            <dt>actor</dt>
            <dd>{item.actor}</dd>
          </div>
          <div>
            <dt>target</dt>
            <dd>
              {item.targetType}:{item.targetId}
            </dd>
          </div>
          {item.detail !== null && item.detail !== undefined && (
            <div className="adm-receipt__wide">
              <dt>detail</dt>
              <dd>
                <JsonBlock value={item.detail} />
              </dd>
            </div>
          )}
        </dl>
      ) : item === null ? (
        <p className="t3">No matching audit row was returned — check the full trail.</p>
      ) : (
        <p className="t3 mono">Reading audit log…</p>
      )}
      <Link className="adm-link" to={`/admin/audit?targetId=${encodeURIComponent(targetId)}`}>
        Full audit trail for this target →
      </Link>
    </div>
  );
}
