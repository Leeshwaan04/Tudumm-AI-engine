import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronRight, ShieldCheck } from "lucide-react";
import { qs } from "../api";
import { dateTime, jsonLine, shortId, TZ_LABEL } from "../format";
import { useApi } from "../hooks";
import { Async, CopyButton, Empty, ErrorNote, JsonBlock, PageHead, Pager, Pill, Refreshed, type Tone } from "../ui";
import type { AuditItem, AuditPage } from "../types";

/** Every action string the Worker writes today (worker/src: admin/*, api/billing.ts, api/me.ts). */
const KNOWN_ACTIONS = [
  "admin.login.success",
  "admin.login.failure",
  "admin.login.rate_limited",
  "admin.logout",
  "user.suspend",
  "user.unsuspend",
  "user.plan_set",
  "user.note_add",
  "user.revoke_sessions",
  "user.self_delete",
  "billing.plan_set",
  "flag.set",
  "announcement.create",
  "announcement.update",
  "support.reply",
  "support.status",
  "engine.run",
  "engine.signal_hold",
  "engine.signal_release",
  "engine.signal_invalidate",
  "engine.strategy_set",
  "engine.run.failed",
  "dev_outbox.view",
];

const ACTION_RE = /^[a-z0-9_.]+$/;

function actionTone(a: string): Tone {
  if (a.endsWith(".failed") || a === "admin.login.failure" || a === "admin.login.rate_limited") return "bad";
  if (a === "user.suspend" || a === "engine.signal_invalidate" || a === "user.revoke_sessions" || a === "user.self_delete") return "warn";
  if (a.startsWith("admin.")) return "neutral";
  if (a.startsWith("engine.")) return "brand";
  if (a.startsWith("support.")) return "info";
  return "ok";
}

function targetHref(i: AuditItem): string | null {
  if (!i.targetId) return null;
  if (i.targetType === "user") return `/admin/users/${i.targetId}`;
  if (i.targetType === "ticket") return `/admin/support/${i.targetId}`;
  return null;
}

export default function AuditLog() {
  const [sp, setSp] = useSearchParams();
  const action = sp.get("action") ?? "";
  const targetId = sp.get("targetId") ?? "";
  const page = Math.max(1, Number(sp.get("page") ?? "1") || 1);
  const [aIn, setAIn] = useState(action);
  const [tIn, setTIn] = useState(targetId);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    setAIn(action);
    setTIn(targetId);
  }, [action, targetId]);

  const actionBad = aIn.trim() !== "" && !ACTION_RE.test(aIn.trim());
  const res = useApi<AuditPage>(`/api/admin/audit${qs({ action, targetId, page: page > 1 ? page : null })}`);

  const apply = (e: FormEvent) => {
    e.preventDefault();
    if (actionBad) return;
    const n = new URLSearchParams();
    if (aIn.trim()) n.set("action", aIn.trim());
    if (tIn.trim()) n.set("targetId", tIn.trim().slice(0, 80));
    setSp(n, { replace: true });
  };

  const setPage = (p: number) => {
    const n = new URLSearchParams(sp);
    if (p > 1) n.set("page", String(p));
    else n.delete("page");
    setSp(n, { replace: true });
  };

  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <>
      <PageHead
        eyebrow="Audit log"
        title={
          <>
            Every move, <em>on the record</em>
          </>
        }
        actions={<Refreshed fetchedAt={res.fetchedAt} refreshing={res.refreshing} onRefresh={res.reload} />}
      >
        <p className="t2">Append-only (database triggers refuse updates and deletes). Newest first, 50 per page. Times in {TZ_LABEL || "local time"}.</p>
        <form className="adm-filters" onSubmit={apply} role="search">
          <label className="adm-sel">
            <span className="eyebrow">Action</span>
            <input
              className="input mono adm-in-action"
              list="adm-audit-actions"
              value={aIn}
              maxLength={80}
              placeholder="any"
              onChange={(e) => setAIn(e.target.value)}
              aria-invalid={actionBad}
              spellCheck={false}
            />
            <datalist id="adm-audit-actions">
              {KNOWN_ACTIONS.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </label>
          <label className="adm-sel">
            <span className="eyebrow">Target id</span>
            <input className="input mono adm-in-target" value={tIn} maxLength={80} placeholder="user / ticket / signal id" onChange={(e) => setTIn(e.target.value)} spellCheck={false} />
          </label>
          <button type="submit" className="btn btn--sm" disabled={actionBad}>
            Apply
          </button>
          {(action || targetId) && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setSp(new URLSearchParams(), { replace: true })}>
              Clear filters
            </button>
          )}
        </form>
        {actionBad && <ErrorNote error={new Error("Action is lowercase letters, digits, dots and underscores (e.g. user.suspend).")} compact />}
      </PageHead>

      <Async q={res} label="Reading the audit log">
        {(d) =>
          d.items.length === 0 ? (
            <Empty title={action || targetId ? "No entries match." : "The log is empty."}>
              {action || targetId ? "Filters are exact matches. Clear one to widen the search." : "Admin sign-ins and every admin mutation are written here."}
            </Empty>
          ) : (
            <div className="adm-card">
              <div className="scroll-x">
                <table className="dtable adm-table adm-audit-t">
                  <thead>
                    <tr>
                      <th aria-label="Expand" />
                      <th>When</th>
                      <th>Action</th>
                      <th>Actor</th>
                      <th>Target</th>
                      <th>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.items.map((i) => {
                      const isOpen = open.has(i.id);
                      const href = targetHref(i);
                      const hasDetail = i.detail !== null && i.detail !== undefined;
                      return (
                        <AuditRow key={i.id} i={i} isOpen={isOpen} hasDetail={hasDetail} href={href} onToggle={() => toggle(i.id)} onAction={(a) => setSp(new URLSearchParams({ action: a }), { replace: true })} />
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="adm-card__foot">
                <span className="mono t3">
                  <ShieldCheck size={12} aria-hidden="true" className="adm-ico-inline" /> read-only · {d.items.length} on this page
                </span>
                <Pager page={d.page} hasMore={d.hasMore} onPage={setPage} disabled={res.refreshing} />
              </div>
            </div>
          )
        }
      </Async>
    </>
  );
}

function AuditRow({
  i,
  isOpen,
  hasDetail,
  href,
  onToggle,
  onAction,
}: {
  i: AuditItem;
  isOpen: boolean;
  hasDetail: boolean;
  href: string | null;
  onToggle: () => void;
  onAction: (a: string) => void;
}) {
  return (
    <>
      <tr className={isOpen ? "is-open" : undefined}>
        <td className="adm-audit-t__x">
          {hasDetail ? (
            <button type="button" className="btn btn--sm btn--ghost btn--icon" onClick={onToggle} aria-expanded={isOpen} aria-label={isOpen ? "Hide detail" : "Show detail"}>
              {isOpen ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
            </button>
          ) : null}
        </td>
        <td className="mono t2">{dateTime(i.at)}</td>
        <td>
          <button type="button" className="adm-ev-btn" onClick={() => onAction(i.action)} title="Show only this action">
            <Pill tone={actionTone(i.action)}>{i.action}</Pill>
          </button>
        </td>
        <td className="mono t2">{i.actor}</td>
        <td className="mono">
          {i.targetId ? (
            <span className="adm-inline">
              <span className="t3">{i.targetType ?? "—"}</span>
              {href ? (
                <Link className="adm-link" to={href} title={i.targetId}>
                  {shortId(i.targetId, 12)}
                </Link>
              ) : (
                <span className="t2" title={i.targetId}>
                  {shortId(i.targetId, 24)}
                </span>
              )}
            </span>
          ) : (
            <span className="t3">{i.targetType ?? "—"}</span>
          )}
        </td>
        <td className="mono t3 adm-trunc adm-trunc--w">{hasDetail ? jsonLine(i.detail, 90) : "—"}</td>
      </tr>
      {isOpen && hasDetail && (
        <tr className="adm-audit-t__detail">
          <td />
          <td colSpan={5}>
            <div className="adm-audit-t__json">
              <JsonBlock value={i.detail} />
              <span className="adm-inline">
                <span className="mono t3">entry {i.id}</span>
                <CopyButton text={i.id} label="Copy id" />
              </span>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
