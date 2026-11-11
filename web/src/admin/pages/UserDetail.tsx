import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { Ban, CalendarClock, KeyRound, ShieldCheck, Undo2 } from "lucide-react";
import { api, qs } from "../api";
import { ago, dateOnly, dateTime, dateTimeShort, endOfLocalDayIso, int, jsonLine, shortId, todayLocalInput } from "../format";
import { useApi, useMutation, useNow } from "../hooks";
import {
  Async,
  AuditReceipt,
  ConfirmDialog,
  CopyButton,
  Empty,
  ErrorNote,
  JsonBlock,
  PageHead,
  Pager,
  Pill,
  PlanPill,
  Refreshed,
  Section,
  Tabs,
  TicketStatusPill,
  UserStatusPill,
} from "../ui";
import type { AdminUser, AuditPage, PlanId, UserDetail as Detail } from "../types";
import { threadOf } from "./Support";

type Action = "suspend" | "unsuspend" | "plan" | "revoke" | null;
type Tab = "timeline" | "sessions" | "lists" | "alerts" | "tickets" | "payments" | "audit";

export default function UserDetail() {
  const { id = "" } = useParams();
  const q = useApi<Detail>(`/api/admin/users/${encodeURIComponent(id)}`);
  const [action, setAction] = useState<Action>(null);
  const [receipt, setReceipt] = useState<{ action: string; key: number; extra?: string } | null>(null);
  const [tab, setTab] = useState<Tab>("timeline");
  const now = useNow(60_000);

  // plan dialog fields
  const [plan, setPlan] = useState<PlanId>("pro");
  const [expiry, setExpiry] = useState<string>("");

  const mut = useMutation(async (kind: Exclude<Action, null>, reason: string) => {
    const base = `/api/admin/users/${encodeURIComponent(id)}`;
    if (kind === "suspend") {
      const r = await api<{ ok: boolean; user: AdminUser }>(`${base}/suspend`, { method: "POST", body: { reason } });
      return { action: "user.suspend", user: r.user };
    }
    if (kind === "unsuspend") {
      const r = await api<{ ok: boolean; user: AdminUser }>(`${base}/unsuspend`, { method: "POST", body: reason ? { reason } : {} });
      return { action: "user.unsuspend", user: r.user };
    }
    if (kind === "plan") {
      const expiresAt = plan !== "free" && expiry ? endOfLocalDayIso(expiry) : null;
      const r = await api<{ ok: boolean; user: AdminUser }>(`${base}/plan`, { method: "POST", body: { plan, expiresAt, reason } });
      return { action: "user.plan_set", user: r.user };
    }
    // revoke-sessions takes no reason in the API, so the reason is recorded as an admin note.
    const r = await api<{ ok: boolean; revoked: number }>(`${base}/revoke-sessions`, { method: "POST", body: {} });
    await api(`${base}/notes`, { method: "POST", body: { body: `Revoked all sessions (${r.revoked}). Reason: ${reason}` } });
    return { action: "user.revoke_sessions", extra: `${r.revoked} session${r.revoked === 1 ? "" : "s"} revoked; reason saved as a note.` };
  });

  const confirm = async (reason: string) => {
    if (!action) return;
    const out = await mut.run(action, reason);
    if (!out) return;
    if ("user" in out && out.user) q.setData((d) => (d ? { ...d, user: out.user } : d));
    setReceipt({ action: out.action, key: Date.now(), extra: "extra" in out ? out.extra : undefined });
    setAction(null);
    q.reload();
  };

  const open = (a: Exclude<Action, null>) => {
    mut.reset();
    if (a === "plan") {
      setPlan(q.data?.user.plan === "pro" ? "elite" : "pro");
      setExpiry("");
    }
    setAction(a);
  };

  return (
    <Async q={q} label="Loading user">
      {(d) => {
        const u = d.user;
        const deleted = u.status === "deleted";
        const activeSessions = d.sessions.filter((s) => !s.revokedAt && Date.parse(s.expiresAt) > now).length;
        return (
          <>
            <PageHead
              eyebrow={`Users · ${shortId(u.id)}`}
              title={<span className="adm-break">{u.displayName || u.email}</span>}
              actions={<Refreshed fetchedAt={q.fetchedAt} refreshing={q.refreshing} onRefresh={q.reload} />}
            >
              <div className="adm-idline">
                <UserStatusPill status={u.status} />
                <PlanPill plan={u.plan} />
                {u.emailVerified ? <Pill tone="ok">email verified</Pill> : <Pill tone="neutral" title="Signed in with a dev code (UAT), or never verified">unverified</Pill>}
                {u.displayName && <span className="adm-break t2">{u.email}</span>}
                <span className="mono t3">{u.id}</span>
                <CopyButton text={u.id} label="Copy id" />
              </div>
            </PageHead>

            <div className="adm-actions" role="toolbar" aria-label="User actions">
              {u.status === "suspended" ? (
                <button type="button" className="btn btn--sm" onClick={() => open("unsuspend")}>
                  <Undo2 aria-hidden="true" /> Unsuspend
                </button>
              ) : (
                <button type="button" className="btn btn--sm adm-btn-danger" onClick={() => open("suspend")} disabled={deleted}>
                  <Ban aria-hidden="true" /> Suspend
                </button>
              )}
              <button type="button" className="btn btn--sm" onClick={() => open("plan")} disabled={deleted}>
                <CalendarClock aria-hidden="true" /> Grant plan
              </button>
              <button type="button" className="btn btn--sm adm-btn-danger" onClick={() => open("revoke")} disabled={activeSessions === 0}>
                <KeyRound aria-hidden="true" /> Revoke sessions <span className="mono">({activeSessions})</span>
              </button>
              {deleted && <span className="t3">This account was deleted by its owner; actions are disabled.</span>}
            </div>

            {receipt && (
              <div className="adm-receipt-wrap">
                {receipt.extra && <p className="t2">{receipt.extra}</p>}
                <AuditReceipt key={receipt.key} targetId={u.id} action={receipt.action} onDismiss={() => setReceipt(null)} />
              </div>
            )}

            <div className="adm-detail">
              <div className="adm-detail__side">
                <Section title="Account">
                  <dl className="adm-dl">
                    <Row k="Joined" v={dateTime(u.createdAt)} />
                    <Row k="Last seen" v={`${ago(u.lastSeenAt, now)}${u.lastSeenAt ? ` · ${dateTimeShort(u.lastSeenAt)}` : ""}`} />
                    <Row k="Country" v={u.country ?? "—"} />
                    <Row k="Marketing" v={u.marketingOptIn ? "opted in" : "not opted in"} />
                    <Row k="Plan (effective)" v={u.plan} />
                    <Row k="Plan (stored)" v={`${d.rawPlan.plan} · ${d.rawPlan.source}${d.rawPlan.expiresAt ? ` · until ${dateTime(d.rawPlan.expiresAt)}` : ""}`} />
                  </dl>
                </Section>

                <Section title="Profile" meta={d.profile?.updatedAt ? `updated ${ago(d.profile.updatedAt, now)}` : undefined}>
                  {d.profile ? (
                    <dl className="adm-dl">
                      <Row k="Persona" v={d.profile.persona} />
                      <Row k="Markets" v={d.profile.markets.join(" · ") || "—"} />
                      <Row k="Capital" v={`${int(d.profile.capital)} ${d.profile.currency}`} />
                      <Row k="Risk / trade" v={`${d.profile.riskPct}%`} />
                      <Row k="Onboarded" v={d.profile.onboarded ? "yes" : "no"} />
                    </dl>
                  ) : (
                    <p className="t3">No profile saved yet.</p>
                  )}
                </Section>

                <Section title="Consents" meta={d.pendingConsents.length ? `${d.pendingConsents.length} pending` : "all current"}>
                  {d.consents.length === 0 && d.pendingConsents.length === 0 ? (
                    <p className="t3">No consent records.</p>
                  ) : (
                    <ul className="adm-list">
                      {d.consents.map((c, i) => (
                        <li key={`${c.kind}-${c.version}-${i}`}>
                          <span>{c.kind}</span>
                          <span className="mono t3">v{c.version}</span>
                          {c.withdrawnAt ? <Pill tone="bad">withdrawn {dateOnly(c.withdrawnAt)}</Pill> : <span className="mono t3">{dateOnly(c.acceptedAt)}</span>}
                        </li>
                      ))}
                      {d.pendingConsents.map((c) => (
                        <li key={`p-${c.kind}`}>
                          <span>{c.kind}</span>
                          <span className="mono t3">v{c.version}</span>
                          <Pill tone="warn">not accepted</Pill>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>

                <Notes userId={u.id} notes={d.notes} onAdded={() => {
                  setReceipt({ action: "user.note_add", key: Date.now() });
                  q.reload();
                }} />
              </div>

              <div className="adm-detail__main">
                <Tabs<Tab>
                  label="User records"
                  value={tab}
                  onChange={setTab}
                  tabs={[
                    { key: "timeline", label: "Timeline", count: d.timeline.length },
                    { key: "sessions", label: "Sessions", count: d.sessions.length },
                    { key: "lists", label: "Watchlist & tracked", count: d.watchlist.length + d.tracked.length },
                    { key: "alerts", label: "Alerts", count: d.alerts.length },
                    { key: "tickets", label: "Tickets", count: d.tickets.length },
                    { key: "payments", label: "Payments", count: d.payments.length },
                    { key: "audit", label: "Audit" },
                  ]}
                />
                <div className="adm-tabpanel" role="tabpanel">
                  {tab === "timeline" && <Timeline d={d} now={now} />}
                  {tab === "sessions" && <Sessions d={d} now={now} />}
                  {tab === "lists" && <Lists d={d} />}
                  {tab === "alerts" && <Alerts d={d} />}
                  {tab === "tickets" && <Tickets d={d} />}
                  {tab === "payments" && <Payments d={d} />}
                  {tab === "audit" && <UserAudit userId={u.id} key={receipt?.key ?? 0} />}
                </div>
              </div>
            </div>

            <ConfirmDialog
              open={action === "suspend"}
              title={`Suspend ${u.email}?`}
              tone="danger"
              confirmLabel="Suspend account"
              reason={{ required: true, placeholder: "e.g. Abuse report #12 — sharing signals in a paid Telegram group" }}
              onConfirm={confirm}
              onClose={() => setAction(null)}
              pending={mut.pending}
              error={mut.error}
            >
              <p>The user is signed out everywhere (all {activeSessions} active sessions are revoked) and can't sign in again until unsuspended.</p>
            </ConfirmDialog>

            <ConfirmDialog
              open={action === "unsuspend"}
              title={`Unsuspend ${u.email}?`}
              confirmLabel="Unsuspend"
              reason={{ required: false }}
              onConfirm={confirm}
              onClose={() => setAction(null)}
              pending={mut.pending}
              error={mut.error}
            >
              <p>The account becomes active again. Revoked sessions stay revoked; the user signs in fresh.</p>
            </ConfirmDialog>

            <ConfirmDialog
              open={action === "plan"}
              title="Grant a plan"
              confirmLabel={plan === "free" ? "Move to Free" : `Grant ${plan === "pro" ? "Pro" : "Elite"}`}
              reason={{ required: true, placeholder: "e.g. UAT tester, founder comp until launch" }}
              onConfirm={confirm}
              onClose={() => setAction(null)}
              pending={mut.pending}
              error={mut.error}
              canConfirm={!(plan !== "free" && expiry && !endOfLocalDayIso(expiry))}
            >
              <p className="t2">
                Currently <b>{u.plan}</b>
                {u.planExpiresAt ? ` until ${dateTime(u.planExpiresAt)}` : ""} ({u.planSource}). Billing isn't involved; this is an admin grant.
              </p>
              <div className="adm-form2">
                <label className="field">
                  <span>Plan</span>
                  <select className="select" value={plan} onChange={(e) => setPlan(e.target.value as PlanId)}>
                    <option value="free">Free</option>
                    <option value="pro">Pro</option>
                    <option value="elite">Elite</option>
                  </select>
                </label>
                <label className="field">
                  <span>Expires (end of day, optional)</span>
                  <input className="input mono" type="date" value={expiry} min={todayLocalInput(1)} disabled={plan === "free"} onChange={(e) => setExpiry(e.target.value)} />
                </label>
              </div>
              <p className="t3">{plan === "free" ? "Free never expires." : expiry ? `Ends ${dateTime(endOfLocalDayIso(expiry))}, then the user falls back to Free.` : "No expiry: the grant lasts until changed."}</p>
            </ConfirmDialog>

            <ConfirmDialog
              open={action === "revoke"}
              title="Revoke all sessions?"
              tone="danger"
              confirmLabel={`Revoke ${activeSessions} session${activeSessions === 1 ? "" : "s"}`}
              reason={{ required: true, placeholder: "e.g. User reported a lost phone" }}
              onConfirm={confirm}
              onClose={() => setAction(null)}
              pending={mut.pending}
              error={mut.error}
            >
              <p>Signs the user out of the web app and unlinks every extension device. The account itself stays active.</p>
              <p className="t3">The revoke endpoint doesn't take a reason, so your reason is saved as an admin note (also audited).</p>
            </ConfirmDialog>
          </>
        );
      }}
    </Async>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}

function Notes({ userId, notes, onAdded }: { userId: string; notes: Detail["notes"]; onAdded: () => void }) {
  const [body, setBody] = useState("");
  const m = useMutation(async (text: string) => api<{ ok: boolean; id: string }>(`/api/admin/users/${encodeURIComponent(userId)}/notes`, { method: "POST", body: { body: text } }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const t = body.trim();
    if (!t) return;
    const r = await m.run(t);
    if (r) {
      setBody("");
      onAdded();
    }
  };
  return (
    <Section title="Internal notes" meta="admin-only · audited">
      <form className="adm-noteform" onSubmit={submit}>
        <label className="visually-hidden" htmlFor="adm-note">
          New note
        </label>
        <textarea id="adm-note" className="input adm-textarea" rows={3} maxLength={4000} value={body} placeholder="Context for the next operator. Never paste secrets." onChange={(e) => setBody(e.target.value)} />
        {m.error ? <ErrorNote error={m.error} compact /> : null}
        <div className="adm-noteform__act">
          <span className="mono t3">{body.trim().length}/4000</span>
          <button type="submit" className="btn btn--sm" disabled={!body.trim() || m.pending}>
            {m.pending ? "Saving…" : "Add note"}
          </button>
        </div>
      </form>
      {notes.length === 0 ? (
        <p className="t3">No notes yet.</p>
      ) : (
        <ol className="adm-notes">
          {notes.map((n) => (
            <li key={n.id}>
              <p className="adm-notes__b">{n.body}</p>
              <p className="mono t3">
                {n.actor} · {dateTimeShort(n.createdAt)}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

function Timeline({ d, now }: { d: Detail; now: number }) {
  if (!d.timeline.length) return <Empty title="No events yet.">Events appear as the user browses the terminal (page views, tracks, searches…).</Empty>;
  return (
    <div className="scroll-x">
      <table className="dtable adm-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Event</th>
            <th>Path</th>
            <th>Props</th>
            <th>Where</th>
          </tr>
        </thead>
        <tbody>
          {d.timeline.map((e) => (
            <tr key={e.id}>
              <td className="mono t2" title={dateTime(e.at)}>
                {ago(e.at, now)}
              </td>
              <td>
                <span className="adm-ev mono">{e.name}</span>
              </td>
              <td className="mono t2 adm-trunc">{e.path ?? "—"}</td>
              <td className="mono t3 adm-trunc" title={jsonLine(e.props, 2000)}>
                {jsonLine(e.props, 80) || "—"}
              </td>
              <td className="mono t3">{[e.source, e.device, e.country].filter(Boolean).join(" · ") || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Sessions({ d, now }: { d: Detail; now: number }) {
  if (!d.sessions.length) return <Empty title="No sessions." />;
  return (
    <div className="scroll-x">
      <table className="dtable adm-table">
        <thead>
          <tr>
            <th>Session</th>
            <th>Kind</th>
            <th>State</th>
            <th>Created</th>
            <th>Last used</th>
            <th>Expires</th>
            <th>User agent</th>
          </tr>
        </thead>
        <tbody>
          {d.sessions.map((s) => {
            const state = s.revokedAt ? "revoked" : Date.parse(s.expiresAt) <= now ? "expired" : "active";
            return (
              <tr key={s.id}>
                <td className="mono t2">{shortId(s.id)}</td>
                <td>{s.kind === "extension" ? <Pill tone="info">extension</Pill> : <Pill>web</Pill>}</td>
                <td>{state === "active" ? <Pill tone="ok">active</Pill> : <Pill tone="neutral">{state}</Pill>}</td>
                <td className="mono t2">{dateTimeShort(s.createdAt)}</td>
                <td className="mono t2">{ago(s.lastUsedAt, now)}</td>
                <td className="mono t2">{s.revokedAt ? `revoked ${dateTimeShort(s.revokedAt)}` : dateTimeShort(s.expiresAt)}</td>
                <td className="t3 adm-trunc" title={s.userAgent ?? undefined}>
                  {s.userAgent ?? "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Lists({ d }: { d: Detail }) {
  return (
    <div className="adm-lists">
      <div>
        <p className="eyebrow">Watchlist · {d.watchlist.length}</p>
        {d.watchlist.length ? (
          <ul className="adm-chips">
            {d.watchlist.map((w) => (
              <li key={w.symbol} className="chip" title={`added ${dateTime(w.addedAt)}`}>
                {w.symbol}
              </li>
            ))}
          </ul>
        ) : (
          <p className="t3">Empty.</p>
        )}
      </div>
      <div>
        <p className="eyebrow">Tracked · {d.tracked.length}</p>
        {d.tracked.length ? (
          <table className="dtable adm-table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Signal</th>
                <th>Added</th>
              </tr>
            </thead>
            <tbody>
              {d.tracked.map((t, i) => (
                <tr key={`${t.symbol}-${t.signalId ?? i}`}>
                  <td className="mono">{t.symbol}</td>
                  <td className="mono t2">{t.signalId ?? <span className="t3">symbol-level</span>}</td>
                  <td className="mono t2">{dateTimeShort(t.addedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="t3">Nothing tracked.</p>
        )}
      </div>
    </div>
  );
}

function Alerts({ d }: { d: Detail }) {
  if (!d.alerts.length) return <Empty title="No alerts." />;
  return (
    <div className="scroll-x">
      <table className="dtable adm-table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Kind</th>
            <th className="r">Threshold</th>
            <th>State</th>
            <th>Created</th>
            <th>Last fired</th>
          </tr>
        </thead>
        <tbody>
          {d.alerts.map((a) => (
            <tr key={a.id}>
              <td className="mono">{a.symbol}</td>
              <td className="mono t2">{a.kind}</td>
              <td className="r mono">{a.threshold ?? "—"}</td>
              <td>
                {a.active ? <Pill tone="ok">active</Pill> : <Pill>off</Pill>} {a.oneShot && <span className="t3">one-shot</span>}
              </td>
              <td className="mono t2">{dateTimeShort(a.createdAt)}</td>
              <td className="mono t2">{dateTimeShort(a.lastTriggeredAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Tickets({ d }: { d: Detail }) {
  if (!d.tickets.length) return <Empty title="No support tickets." />;
  return (
    <ul className="adm-tlist">
      {d.tickets.map((t) => (
        <li key={t.id}>
          <Link to={`/admin/support/${t.id}`} className="adm-tlist__a">
            <span className="adm-tlist__s">{t.subject}</span>
            <span className="adm-inline">
              <TicketStatusPill status={t.status} />
              <span className="mono t3">{t.category}</span>
              <span className="mono t3">{replyCount(t)}</span>
              <span className="mono t3">{dateTimeShort(t.updatedAt)}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function replyCount(t: Detail["tickets"][number]): string {
  const n = threadOf(t).length - 1;
  return n === 0 ? "no replies" : `${n} ${n === 1 ? "reply" : "replies"}`;
}

function Payments({ d }: { d: Detail }) {
  if (!d.payments.length) return <Empty title="No payments.">Billing isn't live yet; plans come from admin grants.</Empty>;
  return (
    <div className="scroll-x">
      <table className="dtable adm-table">
        <thead>
          <tr>
            <th>Provider</th>
            <th>Ref</th>
            <th className="r">Amount</th>
            <th>Plan</th>
            <th>Status</th>
            <th>At</th>
          </tr>
        </thead>
        <tbody>
          {d.payments.map((p, i) => (
            <tr key={String(p.provider_ref ?? i)}>
              <td>{String(p.provider ?? "—")}</td>
              <td className="mono t2">{String(p.provider_ref ?? "—")}</td>
              <td className="r mono">
                {typeof p.amount_minor === "number" ? (p.amount_minor / 100).toFixed(2) : "—"} {String(p.currency ?? "")}
              </td>
              <td>{String(p.plan ?? "—")}</td>
              <td>{String(p.status ?? "—")}</td>
              <td className="mono t2">{dateTimeShort(typeof p.created_at === "string" ? p.created_at : null)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UserAudit({ userId }: { userId: string }) {
  const [page, setPage] = useState(1);
  const q = useApi<AuditPage>(`/api/admin/audit${qs({ targetId: userId, page })}`);
  return (
    <Async q={q} label="Loading audit trail">
      {(d) =>
        d.items.length === 0 ? (
          <Empty title="No admin actions on this user yet." />
        ) : (
          <>
            <ol className="adm-audit">
              {d.items.map((a) => (
                <li key={a.id}>
                  <div className="adm-audit__h">
                    <ShieldCheck size={13} aria-hidden="true" />
                    <span className="mono">{a.action}</span>
                    <span className="mono t3">{a.actor}</span>
                    <span className="mono t3">{dateTime(a.at)}</span>
                  </div>
                  {a.detail !== null && a.detail !== undefined && <JsonBlock value={a.detail} />}
                </li>
              ))}
            </ol>
            <Pager page={d.page} hasMore={d.hasMore} onPage={setPage} disabled={q.refreshing} />
          </>
        )
      }
    </Async>
  );
}
