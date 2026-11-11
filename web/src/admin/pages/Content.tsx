import { useState, type FormEvent } from "react";
import { Megaphone, Pencil, Plus } from "lucide-react";
import { api } from "../api";
import { dateTimeShort, isoToLocalInput, jsonLine, localInputToIso } from "../format";
import { useApi, useMutation, useNow } from "../hooks";
import { Async, AuditReceipt, ConfirmDialog, Empty, ErrorNote, PageHead, Pill, Refreshed, Section } from "../ui";
import type { Announcement, FlagRow } from "../types";

const FLAG_INFO: Record<string, { what: string; risky?: string }> = {
  signups: { what: "New accounts can be created. Existing users can always sign in.", risky: "Turning this off stops every new sign-up immediately." },
  live_data: { what: "The web app and extension use real market data. Off = no market data is shown (an explicit “Live data unavailable” state).", risky: "Turning this off hides every price and signal for every user." },
  extension_linking: { what: "The Chrome extension can link to an account (device-code flow)." },
  require_signal_approval: { what: "New engine signals are held until an admin releases them (Engine page)." },
};

export default function Content() {
  return (
    <>
      <PageHead
        eyebrow="Content"
        title={
          <>
            Flags & <em>announcements</em>
          </>
        }
      >
        <p className="t2">Flag changes apply on the next config read (the public config is cached up to 30 s).</p>
      </PageHead>
      <div className="adm-grid-content">
        <Flags />
        <Announcements />
      </div>
    </>
  );
}

/* ---------------- flags ---------------- */

function Flags() {
  const q = useApi<{ items: FlagRow[] }>("/api/admin/flags");
  const [target, setTarget] = useState<FlagRow | null>(null);
  const [receipt, setReceipt] = useState<{ key: string; n: number } | null>(null);
  // PUT replaces `value` too, so send the current value back unchanged.
  const m = useMutation(async (f: FlagRow) => api<{ flag: FlagRow }>(`/api/admin/flags/${encodeURIComponent(f.key)}`, { method: "PUT", body: { enabled: !f.enabled, value: f.value ?? null } }));

  return (
    <Section title="Feature flags" meta={q.data ? `${q.data.items.length} flags` : undefined} actions={<Refreshed fetchedAt={q.fetchedAt} refreshing={q.refreshing} onRefresh={q.reload} />} flush>
      {receipt && (
        <div className="adm-receipt-wrap adm-receipt-wrap--in">
          <AuditReceipt key={receipt.n} targetId={receipt.key} action="flag.set" onDismiss={() => setReceipt(null)} />
        </div>
      )}
      <Async q={q} label="Loading flags">
        {(d) => (
          <ul className="adm-flags">
            {d.items.map((f) => {
              const info = FLAG_INFO[f.key];
              return (
                <li key={f.key} className="adm-flag">
                  <div className="adm-flag__txt">
                    <p className="mono adm-flag__k">{f.key}</p>
                    <p className="t2">{info?.what ?? "Custom flag."}</p>
                    <p className="mono t3">
                      {f.updatedBy === "default" ? "default value (never changed)" : `set by ${f.updatedBy} · ${dateTimeShort(f.updatedAt)}`}
                      {f.value !== null && f.value !== undefined ? ` · value ${jsonLine(f.value, 60)}` : ""}
                    </p>
                  </div>
                  <button type="button" role="switch" aria-checked={f.enabled} className="switch" onClick={() => (m.reset(), setTarget(f))} aria-label={`${f.key}: ${f.enabled ? "on" : "off"}`}>
                    <span className="switch__track" aria-hidden="true" />
                    <span className="mono">{f.enabled ? "on" : "off"}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Async>
      <ConfirmDialog
        open={target !== null}
        title={target ? `Turn ${target.key} ${target.enabled ? "off" : "on"}?` : ""}
        tone={target && FLAG_INFO[target.key]?.risky && target.enabled ? "danger" : "primary"}
        confirmLabel={target ? `Turn ${target.enabled ? "off" : "on"}` : "Confirm"}
        typeToConfirm={target && FLAG_INFO[target.key]?.risky ? target.key : undefined}
        onConfirm={async () => {
          if (!target) return;
          const r = await m.run(target);
          if (r) {
            q.setData((d) => (d ? { items: d.items.map((x) => (x.key === r.flag.key ? r.flag : x)) } : d));
            setReceipt({ key: target.key, n: Date.now() });
            setTarget(null);
          }
        }}
        onClose={() => setTarget(null)}
        pending={m.pending}
        error={m.error}
      >
        {target && (
          <>
            <p>{FLAG_INFO[target.key]?.what ?? "Custom flag."}</p>
            {FLAG_INFO[target.key]?.risky && <p className="c-brand">{FLAG_INFO[target.key]!.risky}</p>}
            <p className="t3">Audit-logged as flag.set with before/after. This endpoint takes no reason field.</p>
          </>
        )}
      </ConfirmDialog>
    </Section>
  );
}

/* ---------------- announcements ---------------- */

interface Draft {
  level: Announcement["level"];
  message: string;
  link: string;
  startsAt: string; // datetime-local
  endsAt: string;
  active: boolean;
}

const EMPTY: Draft = { level: "info", message: "", link: "", startsAt: "", endsAt: "", active: true };

function linkOk(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  if (t.startsWith("/") && !t.startsWith("//") && !t.startsWith("/\\")) return true;
  try {
    return new URL(t).protocol === "https:";
  } catch {
    return false;
  }
}

function annState(a: Announcement, now: number): { tone: "ok" | "neutral" | "info" | "warn"; label: string } {
  if (!a.active) return { tone: "neutral", label: "inactive" };
  if (a.startsAt && Date.parse(a.startsAt) > now) return { tone: "info", label: "scheduled" };
  if (a.endsAt && Date.parse(a.endsAt) <= now) return { tone: "neutral", label: "ended" };
  return { tone: "ok", label: "live" };
}

function Announcements() {
  const q = useApi<{ items: Announcement[] }>("/api/admin/announcements");
  const now = useNow(30_000);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [toggle, setToggle] = useState<Announcement | null>(null);
  const [receipt, setReceipt] = useState<{ id: string; action: string; n: number } | null>(null);

  const save = useMutation(async (id: string | "new", d: Draft) => {
    const body = {
      level: d.level,
      message: d.message.trim(),
      link: d.link.trim() || null,
      startsAt: localInputToIso(d.startsAt),
      endsAt: localInputToIso(d.endsAt),
      active: d.active,
    };
    if (id === "new") return { action: "announcement.create", r: await api<{ announcement: Announcement | null }>("/api/admin/announcements", { method: "POST", body }) };
    return { action: "announcement.update", r: await api<{ announcement: Announcement | null }>(`/api/admin/announcements/${encodeURIComponent(id)}`, { method: "PATCH", body }) };
  });
  const flip = useMutation(async (a: Announcement) => api<{ announcement: Announcement | null }>(`/api/admin/announcements/${encodeURIComponent(a.id)}`, { method: "PATCH", body: { active: !a.active } }));

  const startEdit = (a: Announcement | null) => {
    save.reset();
    if (!a) {
      setDraft(EMPTY);
      setEditing("new");
    } else {
      setDraft({ level: a.level, message: a.message, link: a.link ?? "", startsAt: isoToLocalInput(a.startsAt), endsAt: isoToLocalInput(a.endsAt), active: a.active });
      setEditing(a.id);
    }
  };

  const msgLen = draft.message.trim().length;
  const rangeBad = !!(draft.startsAt && draft.endsAt && new Date(draft.endsAt).getTime() <= new Date(draft.startsAt).getTime());
  const valid = msgLen >= 3 && msgLen <= 500 && linkOk(draft.link) && !rangeBad;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing || !valid) return;
    const out = await save.run(editing, draft);
    if (out) {
      const a = out.r.announcement;
      setReceipt(a ? { id: a.id, action: out.action, n: Date.now() } : null);
      setEditing(null);
      q.reload();
    }
  };

  return (
    <Section
      title="Announcements"
      meta="banner shown in the web app (max 5 live, critical first)"
      actions={
        <>
          <Refreshed fetchedAt={q.fetchedAt} refreshing={q.refreshing} onRefresh={q.reload} />
          <button type="button" className="btn btn--sm btn--primary" onClick={() => startEdit(null)} disabled={editing === "new"}>
            <Plus aria-hidden="true" /> New
          </button>
        </>
      }
    >
      {receipt && (
        <div className="adm-receipt-wrap">
          <AuditReceipt key={receipt.n} targetId={receipt.id} action={receipt.action} onDismiss={() => setReceipt(null)} />
        </div>
      )}

      {editing && (
        <form className="adm-annform" onSubmit={submit} aria-label={editing === "new" ? "New announcement" : "Edit announcement"}>
          <div className="adm-annform__grid">
            <label className="field">
              <span>Level</span>
              <select className="select" value={draft.level} onChange={(e) => setDraft({ ...draft, level: e.target.value as Draft["level"] })}>
                <option value="info">Info</option>
                <option value="warning">Warning</option>
                <option value="critical">Critical</option>
              </select>
            </label>
            <label className="field adm-annform__msg">
              <span>Message</span>
              <textarea className="input adm-textarea" rows={2} maxLength={500} value={draft.message} onChange={(e) => setDraft({ ...draft, message: e.target.value })} placeholder="e.g. NSE end-of-day data is delayed today; signals for India will update by 21:00 IST." />
              <span className={`mono adm-count${msgLen > 0 && msgLen < 3 ? " c-short" : ""}`}>{msgLen}/500 · min 3</span>
            </label>
            <label className="field">
              <span>Link (optional)</span>
              <input className="input mono" value={draft.link} onChange={(e) => setDraft({ ...draft, link: e.target.value })} placeholder="/app/proof or https://…" maxLength={500} aria-invalid={!linkOk(draft.link)} />
              {!linkOk(draft.link) && <span className="c-short adm-count">Use a /relative path or an https:// URL.</span>}
            </label>
            <label className="field">
              <span>Starts (optional)</span>
              <input className="input mono" type="datetime-local" value={draft.startsAt} onChange={(e) => setDraft({ ...draft, startsAt: e.target.value })} />
            </label>
            <label className="field">
              <span>Ends (optional)</span>
              <input className="input mono" type="datetime-local" value={draft.endsAt} onChange={(e) => setDraft({ ...draft, endsAt: e.target.value })} aria-invalid={rangeBad} />
              {rangeBad && <span className="c-short adm-count">Must end after it starts.</span>}
            </label>
            <div className="field">
              <span>Active</span>
              <button type="button" role="switch" aria-checked={draft.active} className="switch" onClick={() => setDraft({ ...draft, active: !draft.active })}>
                <span className="switch__track" aria-hidden="true" />
                {draft.active ? "Active" : "Inactive"}
              </button>
            </div>
          </div>
          <div className="adm-annprev" aria-label="Preview">
            <p className="eyebrow">Preview</p>
            <AnnBanner level={draft.level} message={draft.message.trim() || "Your message"} link={draft.link.trim() || null} />
          </div>
          {save.error ? <ErrorNote error={save.error} compact /> : null}
          <div className="adm-dialog__act">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(null)} disabled={save.pending}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary btn--sm" disabled={!valid || save.pending}>
              {save.pending ? "Saving…" : editing === "new" ? "Publish announcement" : "Save changes"}
            </button>
          </div>
        </form>
      )}

      <Async q={q} label="Loading announcements">
        {(d) =>
          d.items.length === 0 ? (
            <Empty title="No announcements.">Use New to post a banner (maintenance windows, data delays, launch notes).</Empty>
          ) : (
            <ul className="adm-anns">
              {d.items.map((a) => {
                const st = annState(a, now);
                return (
                  <li key={a.id} className="adm-ann">
                    <AnnBanner level={a.level} message={a.message} link={a.link} />
                    <div className="adm-ann__meta">
                      <Pill tone={st.tone}>{st.label}</Pill>
                      <span className="mono t3">
                        {a.startsAt ? `from ${dateTimeShort(a.startsAt)}` : "from publish"} · {a.endsAt ? `until ${dateTimeShort(a.endsAt)}` : "no end"}
                      </span>
                      <span className="mono t3">created {dateTimeShort(a.createdAt)}</span>
                      <span className="adm-ann__act">
                        <button type="button" className="btn btn--sm btn--ghost" onClick={() => startEdit(a)}>
                          <Pencil aria-hidden="true" /> Edit
                        </button>
                        <button type="button" className={`btn btn--sm${a.active ? " adm-btn-danger" : ""}`} onClick={() => (flip.reset(), setToggle(a))}>
                          {a.active ? "Deactivate" : "Activate"}
                        </button>
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )
        }
      </Async>

      <ConfirmDialog
        open={toggle !== null}
        title={toggle?.active ? "Take this announcement down?" : "Put this announcement back up?"}
        tone={toggle?.active ? "danger" : "primary"}
        confirmLabel={toggle?.active ? "Deactivate" : "Activate"}
        onConfirm={async () => {
          if (!toggle) return;
          const r = await flip.run(toggle);
          if (r) {
            setReceipt({ id: toggle.id, action: "announcement.update", n: Date.now() });
            setToggle(null);
            q.reload();
          }
        }}
        onClose={() => setToggle(null)}
        pending={flip.pending}
        error={flip.error}
      >
        {toggle && (
          <>
            <AnnBanner level={toggle.level} message={toggle.message} link={toggle.link} />
            <p className="t3">There's no delete: deactivated announcements stay in the list and in the audit log.</p>
          </>
        )}
      </ConfirmDialog>
    </Section>
  );
}

function AnnBanner({ level, message, link }: { level: string; message: string; link: string | null }) {
  return (
    <div className={`adm-annb adm-annb--${level}`}>
      <Megaphone size={14} aria-hidden="true" />
      <span className="adm-annb__lvl mono">{level}</span>
      <span className="adm-annb__m">{message}</span>
      {link && <span className="adm-annb__l mono">{link}</span>}
    </div>
  );
}
