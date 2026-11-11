import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, ChevronDown, LifeBuoy, LogIn, MessageSquare, Send } from "lucide-react";
import { useDocumentTitle } from "../../components/hooks";
import { toast } from "../../components/ui";
import { fmtAsOf } from "../../components/badges";
import { Turnstile, type TurnstileHandle } from "../../components/Turnstile";
import { useSession, openSignIn } from "../../api/session";
import { supportApi } from "../../api/endpoints";
import { useApi } from "../../api/useApi";
import { ApiError, errorText } from "../../api/client";
import { useCaps, useConfig } from "../../api/config";
import { track } from "../../api/events";
import type { Ticket } from "../../api/types";

const CATEGORIES: { id: string; label: string; hint: string }[] = [
  { id: "bug", label: "Something's broken", hint: "What you did, what you expected and what happened instead." },
  { id: "signal", label: "A signal or data question", hint: "Include the symbol and, if you have it, the signal id (e.g. SIG-BTCUSDT-…)." },
  { id: "account", label: "Account or sign-in", hint: "Never send us a sign-in code. We'll never ask for one." },
  { id: "billing", label: "Plans and early access", hint: "Billing isn't live yet. Tell us which plan you're interested in." },
  { id: "grievance", label: "Complaint / grievance", hint: "Tell us what went wrong and what outcome you want. Grievances are tracked by age." },
  { id: "other", label: "Something else", hint: "Feedback and ideas are welcome too." },
];
const CAT_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label])) as Record<string, string>;

const SUBJECT_MIN = 3;
const SUBJECT_MAX = 140;
const BODY_MIN = 10;
const BODY_MAX = 5000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const STATUS: Record<Ticket["status"], { label: string; cls: string }> = {
  open: { label: "Open", cls: "open" },
  pending: { label: "Pending", cls: "pending" },
  resolved: { label: "Resolved", cls: "resolved" },
  closed: { label: "Closed", cls: "closed" },
};

function when(iso: string): string {
  return fmtAsOf(iso, { date: true });
}

export default function Support() {
  useDocumentTitle("Support · Tudumm");
  const { status } = useSession();
  const signedIn = status === "signed_in";
  return (
    <div className="sup">
      <header className="phead">
        <div>
          <p className="eyebrow">Support</p>
          <h1 className="phead__title serif">
            Ask a person. <em>Get a straight answer.</em>
          </h1>
        </div>
        <p className="phead__note">
          Every ticket is read by a person. During the beta there's no guaranteed response time; complaints are tracked by age so none get lost.
        </p>
      </header>
      <div className="sup__grid">
        <NewTicket signedIn={signedIn} />
        <aside className="sup__side">
          {signedIn ? (
            <MyTickets />
          ) : (
            <section className="panel sup__panel">
              <header className="panel__head">
                <span className="eyebrow">Your tickets</span>
              </header>
              <div className="panel__body">
                <p className="sup__hint">Sign in to see your tickets, read replies and answer them here.</p>
                <button type="button" className="btn" onClick={() => openSignIn("Sign in to see your support tickets and replies")}>
                  <LogIn size={15} aria-hidden="true" /> Sign in
                </button>
              </div>
            </section>
          )}
          <section className="panel sup__panel">
            <header className="panel__head">
              <span className="eyebrow">Before you write</span>
            </header>
            <div className="panel__body sup__faq">
              <p>
                <b>Is a signal advice?</b> No. Calls are informational and not investment advice; read the{" "}
                <Link className="u-link" to="/risk">
                  risk disclosure
                </Link>
                .
              </p>
              <p>
                <b>Your data:</b> export or delete it yourself from{" "}
                <Link className="u-link" to="/app/account">
                  Account
                </Link>
                .
              </p>
              <p className="sup__india">
                For India: Unresolved grievance? You'll be able to escalate on SEBI SCORES once Tudumm is registered. Tudumm is not registered with SEBI
                today.
              </p>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

/* ---------------- new ticket ---------------- */
function NewTicket({ signedIn }: { signedIn: boolean }) {
  const caps = useCaps();
  const cfg = useConfig();
  const tickets = useApi(signedIn ? "me:tickets" : null, () => supportApi.mine());
  const siteKey = cfg.config?.turnstileSiteKey ?? null;
  const needsHuman = !signedIn && caps.turnstile && !!siteKey;
  const humanUnavailable = !signedIn && caps.turnstile && !siteKey;

  const [category, setCategory] = useState("bug");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; subject: string } | null>(null);
  const ts = useRef<TurnstileHandle>(null);

  const s = subject.trim();
  const b = body.trim();
  const e = email.trim();
  const problems = {
    subject: s.length < SUBJECT_MIN ? `At least ${SUBJECT_MIN} characters.` : s.length > SUBJECT_MAX ? `At most ${SUBJECT_MAX} characters.` : null,
    body: b.length < BODY_MIN ? `At least ${BODY_MIN} characters.` : b.length > BODY_MAX ? `At most ${BODY_MAX} characters.` : null,
    email: signedIn ? null : !EMAIL_RE.test(e) ? "Enter the email we should reply to." : null,
    human: needsHuman && !token ? "Complete the human check." : null,
  };
  const valid = !problems.subject && !problems.body && !problems.email && !problems.human && !humanUnavailable;
  const cat = CATEGORIES.find((c) => c.id === category) ?? CATEGORIES[0];

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setTouched(true);
    if (!valid || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await supportApi.create({
        category,
        subject: s,
        body: b,
        ...(signedIn ? {} : { email: e }),
        ...(needsHuman && token ? { turnstileToken: token } : {}),
      });
      track("support_submit", { category, signedIn });
      setDone({ id: r.ticket.id, subject: r.ticket.subject });
      setSubject("");
      setBody("");
      setTouched(false);
      toast("Ticket sent");
      if (signedIn) void tickets.reload();
    } catch (x) {
      if (x instanceof ApiError && x.status === 503) setErr(x.code === "turnstile_unavailable" ? errorText(x) : "Support is temporarily unavailable. Try again shortly.");
      else setErr(errorText(x));
      if (needsHuman) ts.current?.reset();
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <section className="panel sup__panel sup__done" aria-live="polite">
        <div className="panel__body">
          <CheckCircle2 size={22} aria-hidden="true" className="c-long" />
          <h2 className="serif">Got it. A person will read this.</h2>
          <p className="sup__hint">
            Ticket <span className="mono sup__id">{done.id.slice(0, 8)}</span> · “{done.subject}”
          </p>
          <p className="sup__hint">
            {signedIn
              ? caps.emailDelivery
                ? "Replies appear in My tickets and the bell, and are emailed to you."
                : "Replies appear in My tickets and the bell. Email copies aren't switched on yet."
              : caps.emailDelivery
                ? "We'll reply to the email you gave."
                : "Email delivery isn't switched on yet, so we can't email you a reply. Sign in with the same email to read replies in the app."}
          </p>
          <div className="sup__actions">
            <button type="button" className="btn" onClick={() => setDone(null)}>
              Write another
            </button>
            {!signedIn && (
              <button type="button" className="btn btn--primary" onClick={() => openSignIn("Sign in to read replies to your ticket")}>
                <LogIn size={15} aria-hidden="true" /> Sign in
              </button>
            )}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="panel sup__panel" aria-labelledby="sup-new">
      <header className="panel__head">
        <span className="eyebrow" id="sup-new">
          <LifeBuoy size={13} aria-hidden="true" /> New ticket
        </span>
      </header>
      <form className="panel__body sup__form" onSubmit={submit} noValidate>
        {!signedIn && !caps.emailDelivery && (
          <p className="sup__note sup__note--warn">
            Email delivery isn't switched on yet. If you write as a guest we can read your ticket but can't email you back.{" "}
            <button type="button" className="u-link sup__linkbtn" onClick={() => openSignIn("Sign in so replies to your ticket reach you")}>
              Sign in first
            </button>{" "}
            to get replies in the app.
          </p>
        )}
        <label className="field">
          <span>Topic</span>
          <select className="select" value={category} onChange={(ev) => setCategory(ev.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <p className="sup__hint">{cat.hint}</p>
        {!signedIn && (
          <label className="field">
            <span>Your email</span>
            <input
              className="input"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(ev) => setEmail(ev.target.value)}
              aria-invalid={touched && !!problems.email}
              aria-describedby="sup-email-err"
              required
            />
            <span id="sup-email-err" className="form-err" aria-live="polite">
              {touched ? problems.email : null}
            </span>
          </label>
        )}
        <label className="field">
          <span className="sup__lab">
            Subject <span className={`mono sup__count ${s.length > SUBJECT_MAX ? "is-over" : ""}`}>{s.length} / {SUBJECT_MAX}</span>
          </span>
          <input
            className="input"
            value={subject}
            maxLength={SUBJECT_MAX + 20}
            onChange={(ev) => setSubject(ev.target.value)}
            aria-invalid={touched && !!problems.subject}
            aria-describedby="sup-subj-err"
            required
          />
          <span id="sup-subj-err" className="form-err" aria-live="polite">
            {touched ? problems.subject : null}
          </span>
        </label>
        <label className="field">
          <span className="sup__lab">
            Message <span className={`mono sup__count ${b.length > BODY_MAX ? "is-over" : ""}`}>{b.length} / {BODY_MAX}</span>
          </span>
          <textarea
            className="input sup__textarea"
            rows={7}
            value={body}
            onChange={(ev) => setBody(ev.target.value)}
            aria-invalid={touched && !!problems.body}
            aria-describedby="sup-body-err"
            required
          />
          <span id="sup-body-err" className="form-err" aria-live="polite">
            {touched ? problems.body : null}
          </span>
        </label>
        {needsHuman && siteKey && (
          <div className="field">
            <span>Human check</span>
            <Turnstile ref={ts} siteKey={siteKey} onToken={setToken} />
            <span className="form-err" aria-live="polite">
              {touched ? problems.human : null}
            </span>
          </div>
        )}
        {humanUnavailable && <p className="form-err">The human check isn't available right now, so guest tickets are paused. Sign in to write to us.</p>}
        <p className="form-err" role="alert">
          {err}
        </p>
        <div className="sup__actions">
          <button type="submit" className="btn btn--primary" disabled={busy || humanUnavailable}>
            <Send size={15} aria-hidden="true" /> {busy ? "Sending…" : "Send ticket"}
          </button>
          <span className="sup__fine">Don't include passwords, sign-in codes, card numbers or broker credentials.</span>
        </div>
      </form>
    </section>
  );
}

/* ---------------- my tickets ---------------- */
function MyTickets() {
  const t = useApi("me:tickets", () => supportApi.mine(), { refreshMs: 60_000 });
  const [open, setOpen] = useState<string | null>(null);
  const items = t.data?.items ?? [];
  return (
    <section className="panel sup__panel">
      <header className="panel__head">
        <span className="eyebrow">
          <MessageSquare size={13} aria-hidden="true" /> My tickets
        </span>
        {t.data && <span className="mono t3">{items.length}</span>}
      </header>
      <div className="panel__body">
        {t.error && !t.data ? (
          <div className="sup__err" role="alert">
            <p>{errorText(t.error)}</p>
            <button type="button" className="btn btn--sm" onClick={() => void t.reload()}>
              Retry
            </button>
          </div>
        ) : t.loading && !t.data ? (
          <p className="sup__hint">Loading your tickets…</p>
        ) : items.length === 0 ? (
          <p className="sup__hint">No tickets yet. Anything you send appears here with our replies.</p>
        ) : (
          <ul className="sup__tickets">
            {items.map((tk) => (
              <TicketItem key={tk.id} t={tk} open={open === tk.id} onToggle={() => setOpen((o) => (o === tk.id ? null : tk.id))} onReplied={() => void t.reload()} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function TicketItem({ t, open, onToggle, onReplied }: { t: Ticket; open: boolean; onToggle: () => void; onReplied: () => void }) {
  const st = STATUS[t.status] ?? { label: t.status, cls: "closed" };
  const msgs = t.messages.length ? t.messages : [{ author: "user" as const, body: t.body, createdAt: t.createdAt }];
  const lastAdmin = [...t.messages].reverse().find((m) => m.author === "admin");
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const closed = t.status === "closed";
  const r = reply.trim();

  const send = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!r || r.length > BODY_MAX || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await supportApi.reply(t.id, r);
      setReply("");
      toast("Reply sent");
      onReplied();
    } catch (x) {
      setErr(x instanceof ApiError && x.code === "ticket_closed" ? "This ticket is closed. Open a new ticket instead." : errorText(x));
    } finally {
      setBusy(false);
    }
  };

  const panelId = `tk-${t.id}`;
  return (
    <li className={`sup__ticket ${open ? "is-open" : ""}`}>
      <button type="button" className="sup__tk-head" aria-expanded={open} aria-controls={panelId} onClick={onToggle}>
        <span className="sup__tk-main">
          <b>{t.subject}</b>
          <span className="sup__tk-meta mono">
            {CAT_LABEL[t.category] ?? t.category} · updated {when(t.updatedAt)}
            {lastAdmin ? " · replied" : ""}
          </span>
        </span>
        <span className={`sup__st sup__st--${st.cls}`}>{st.label}</span>
        <ChevronDown size={14} aria-hidden="true" className="sup__chev" />
      </button>
      {open && (
        <div className="sup__thread" id={panelId}>
          <ol className="sup__msgs">
            {msgs.map((m, i) => (
              <li key={i} className={`sup__msg sup__msg--${m.author}`}>
                <p className="sup__msg-meta mono">
                  {m.author === "admin" ? "Tudumm team" : "You"} · {when(m.createdAt)}
                </p>
                <p className="sup__msg-body">{m.body}</p>
              </li>
            ))}
          </ol>
          {closed ? (
            <p className="sup__hint">This ticket is closed. If you still need help, open a new ticket.</p>
          ) : (
            <form className="sup__reply" onSubmit={send} noValidate>
              <label className="field">
                <span>Reply</span>
                <textarea className="input sup__textarea sup__textarea--sm" rows={3} value={reply} onChange={(ev) => setReply(ev.target.value)} maxLength={BODY_MAX + 20} />
              </label>
              <p className="form-err" aria-live="polite">
                {r.length > BODY_MAX ? `At most ${BODY_MAX} characters.` : err}
              </p>
              <button type="submit" className="btn btn--sm" disabled={!r || r.length > BODY_MAX || busy}>
                <Send size={13} aria-hidden="true" /> {busy ? "Sending…" : "Send reply"}
              </button>
            </form>
          )}
        </div>
      )}
    </li>
  );
}
