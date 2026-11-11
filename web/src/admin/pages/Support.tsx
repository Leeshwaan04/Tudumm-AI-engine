import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, Send } from "lucide-react";
import { api, qs } from "../api";
import { ageDays, dateTime, dateTimeShort, dur } from "../format";
import { useApi, useMutation, useNow } from "../hooks";
import { Async, AuditReceipt, ConfirmDialog, Empty, ErrorNote, PageHead, Pager, Pill, Refreshed, Tabs, TicketStatusPill } from "../ui";
import type { Ticket, TicketMessage } from "../types";

const STATUSES = ["open", "pending", "resolved", "closed"] as const;
const CATEGORIES = ["bug", "billing", "signal", "account", "grievance", "other"] as const;
type StatusTab = "" | (typeof STATUSES)[number];

/**
 * The API stores the opening message both as ticket.body and as the first ticket_messages row
 * (worker/src/api/support.ts createTicket), so build the thread with the opener exactly once.
 */
export function threadOf(t: Ticket): TicketMessage[] {
  const msgs = t.messages ?? [];
  const first = msgs[0];
  if (first && first.author !== "admin" && first.body === t.body) return msgs;
  return [{ author: "user", body: t.body, createdAt: t.createdAt }, ...msgs];
}

export function AgeBadge({ createdAt, category, status, now }: { createdAt: string; category: string; status: string; now: number }) {
  const d = ageDays(createdAt, now);
  if (d === null) return null;
  const openish = status === "open" || status === "pending";
  const grievance = category === "grievance";
  const tone = grievance && openish ? (d > 21 ? "bad" : d > 7 ? "warn" : "neutral") : "neutral";
  const label = dur(d * 86400);
  return (
    <Pill tone={tone} title={grievance ? `Grievance SLA: acknowledge within 7 days, resolve within 21 · opened ${dateTime(createdAt)}` : `Opened ${dateTime(createdAt)}`}>
      {label}
      {grievance && openish && d > 21 ? " · over 21d" : grievance && openish && d > 7 ? " · over 7d" : ""}
    </Pill>
  );
}

export default function Support() {
  const { id } = useParams();
  const [sp, setSp] = useSearchParams();
  const status = (sp.get("status") ?? "") as StatusTab;
  const category = sp.get("category") ?? "";
  const page = Math.max(1, Number(sp.get("page") ?? "1") || 1);
  const now = useNow(60_000);
  const list = useApi<{ items: Ticket[]; page: number; hasMore: boolean }>(`/api/admin/support${qs({ status, category, page })}`);

  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    if (k !== "page") n.delete("page");
    setSp(n, { replace: true });
  };
  const keep = sp.toString() ? `?${sp.toString()}` : "";

  return (
    <>
      <PageHead
        eyebrow="Support"
        title={
          <>
            The <em>inbox</em>
          </>
        }
        actions={<Refreshed fetchedAt={list.fetchedAt} refreshing={list.refreshing} onRefresh={list.reload} />}
      >
        <div className="adm-filters">
          <Tabs<StatusTab>
            label="Ticket status"
            value={status}
            onChange={(v) => set("status", v)}
            tabs={[{ key: "", label: "All" }, ...STATUSES.map((s) => ({ key: s, label: s[0]!.toUpperCase() + s.slice(1) }))]}
          />
          <label className="adm-sel">
            <span className="eyebrow">Category</span>
            <select className="select" value={category} onChange={(e) => set("category", e.target.value)}>
              <option value="">Any</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>
      </PageHead>

      <div className={`adm-inbox${id ? " has-thread" : ""}`}>
        <div className="adm-inbox__list adm-card">
          <Async q={list} label="Loading tickets">
            {(d) =>
              d.items.length === 0 ? (
                <Empty title={status || category ? "Nothing in this view." : "Inbox zero."}>{status || category ? "Try another status or category." : "Tickets from the web app's support form land here."}</Empty>
              ) : (
                <>
                  <ul className="adm-tickets">
                    {d.items.map((t) => (
                      <li key={t.id}>
                        <Link to={`/admin/support/${t.id}${keep}`} className={`adm-ticket${t.id === id ? " is-active" : ""}`} aria-current={t.id === id ? "true" : undefined}>
                          <span className="adm-ticket__top">
                            <TicketStatusPill status={t.status} />
                            <span className={`mono adm-ticket__cat${t.category === "grievance" ? " is-griev" : ""}`}>{t.category}</span>
                            <AgeBadge createdAt={t.createdAt} category={t.category} status={t.status} now={now} />
                          </span>
                          <span className="adm-ticket__subj">{t.subject}</span>
                          <span className="adm-ticket__meta">
                            <span className="adm-break">{t.email}</span>
                            <span className="mono t3">upd {dateTimeShort(t.updatedAt)}</span>
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                  <div className="adm-card__foot">
                    <Pager page={d.page} hasMore={d.hasMore} onPage={(p) => set("page", String(p))} disabled={list.refreshing} />
                  </div>
                </>
              )
            }
          </Async>
        </div>
        <div className="adm-inbox__thread">
          {id ? (
            <Thread id={id} back={`/admin/support${keep}`} onChanged={list.reload} now={now} />
          ) : (
            <div className="adm-card adm-inbox__placeholder">
              <Empty title="Pick a ticket.">The thread, reply box and status controls open here.</Empty>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Thread({ id, back, onChanged, now }: { id: string; back: string; onChanged: () => void; now: number }) {
  const navigate = useNavigate();
  const q = useApi<{ ticket: Ticket }>(`/api/admin/support/${encodeURIComponent(id)}`);
  const [body, setBody] = useState("");
  const [after, setAfter] = useState<(typeof STATUSES)[number]>("pending");
  const [statusTo, setStatusTo] = useState<(typeof STATUSES)[number] | null>(null);
  const [receipt, setReceipt] = useState<{ action: string; key: number; note?: string } | null>(null);

  const reply = useMutation(async (text: string, st: string) => api<{ ok: boolean; status: string; emailed: boolean }>(`/api/admin/support/${encodeURIComponent(id)}/reply`, { method: "POST", body: { body: text, status: st } }));
  const setStatus = useMutation(async (st: string) => api<{ ok: boolean; status: string }>(`/api/admin/support/${encodeURIComponent(id)}/status`, { method: "POST", body: { status: st } }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const t = body.trim();
    if (!t) return;
    const r = await reply.run(t, after);
    if (r) {
      setBody("");
      setReceipt({ action: "support.reply", key: Date.now(), note: r.emailed ? "Reply sent and emailed to the requester." : "Reply saved and shown in the user's profile. Not emailed: email delivery isn't configured." });
      q.reload();
      onChanged();
    }
  };

  return (
    <div className="adm-card adm-thread">
      <Async q={q} label="Loading thread">
        {({ ticket: t }) => (
          <>
            <div className="adm-thread__head">
              <button type="button" className="btn btn--sm btn--ghost adm-thread__back" onClick={() => navigate(back)}>
                <ArrowLeft aria-hidden="true" /> Inbox
              </button>
              <h2 className="adm-thread__t serif">{t.subject}</h2>
              <div className="adm-inline">
                <TicketStatusPill status={t.status} />
                <span className={`mono adm-ticket__cat${t.category === "grievance" ? " is-griev" : ""}`}>{t.category}</span>
                <AgeBadge createdAt={t.createdAt} category={t.category} status={t.status} now={now} />
                <span className="adm-break t2">{t.email}</span>
                {t.userId ? (
                  <Link className="adm-link mono" to={`/admin/users/${t.userId}`}>
                    view user →
                  </Link>
                ) : (
                  <span className="t3">guest (no account)</span>
                )}
              </div>
            </div>

            {receipt && (
              <div className="adm-receipt-wrap adm-receipt-wrap--in">
                {receipt.note && <p className="t2">{receipt.note}</p>}
                <AuditReceipt key={receipt.key} targetId={t.id} action={receipt.action} onDismiss={() => setReceipt(null)} />
              </div>
            )}

            <ol className="adm-msgs">
              {threadOf(t).map((m, i) => (
                <li key={`${m.createdAt}-${i}`} className={`adm-msg adm-msg--${m.author === "admin" ? "admin" : "user"}`}>
                  <p className="adm-msg__who mono">
                    {m.author === "admin" ? "Tudumm support" : t.email} · {dateTime(m.createdAt)}
                  </p>
                  <p className="adm-msg__b">{m.body}</p>
                </li>
              ))}
            </ol>

            <form className="adm-reply" onSubmit={submit}>
              <label className="field" htmlFor="adm-reply">
                <span>Reply to {t.email}</span>
                <textarea
                  id="adm-reply"
                  className="input adm-textarea"
                  rows={4}
                  maxLength={5000}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Plain text. The user sees it in their profile; it's emailed only when email delivery is configured."
                />
              </label>
              {reply.error ? <ErrorNote error={reply.error} compact /> : null}
              <div className="adm-reply__act">
                <label className="adm-sel adm-sel--row">
                  <span className="eyebrow">Then set</span>
                  <select className="select" value={after} onChange={(e) => setAfter(e.target.value as (typeof STATUSES)[number])}>
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="mono t3">{body.trim().length}/5000</span>
                <button type="submit" className="btn btn--primary btn--sm" disabled={!body.trim() || reply.pending}>
                  <Send aria-hidden="true" /> {reply.pending ? "Sending…" : "Send reply"}
                </button>
              </div>
            </form>

            <div className="adm-statusbar">
              <span className="eyebrow">Change status</span>
              <div className="seg" role="group" aria-label="Ticket status">
                {STATUSES.map((s) => (
                  <button key={s} type="button" aria-pressed={t.status === s} disabled={t.status === s} onClick={() => (setStatus.reset(), setStatusTo(s))}>
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <ConfirmDialog
              open={statusTo !== null}
              title={`Mark as ${statusTo ?? ""}?`}
              tone={statusTo === "closed" ? "danger" : "primary"}
              confirmLabel={`Set ${statusTo ?? ""}`}
              onConfirm={async () => {
                if (!statusTo) return;
                const r = await setStatus.run(statusTo);
                if (r) {
                  setReceipt({ action: "support.status", key: Date.now() });
                  setStatusTo(null);
                  q.reload();
                  onChanged();
                }
              }}
              onClose={() => setStatusTo(null)}
              pending={setStatus.pending}
              error={setStatus.error}
            >
              <p>
                {t.status} → <b>{statusTo}</b>. The user isn't notified of status-only changes; send a reply if they should know.
              </p>
              {t.category === "grievance" && (statusTo === "closed" || statusTo === "resolved") && <p className="t2">This is a grievance: make sure the resolution is written in the thread before closing.</p>}
            </ConfirmDialog>
          </>
        )}
      </Async>
    </div>
  );
}
