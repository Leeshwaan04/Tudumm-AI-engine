import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Bell, Download, LogIn, LogOut, Puzzle, ShieldCheck, Trash2, X } from "lucide-react";
import { useDocumentTitle } from "../../components/hooks";
import { EmptyState, Switch, toast } from "../../components/ui";
import { fmtAsOf } from "../../components/badges";
import { useSession, openSignIn, signOut, signedOutLocally, patchMe, refreshMe } from "../../api/session";
import { alertsApi, consentApi, meApi } from "../../api/endpoints";
import { useApi } from "../../api/useApi";
import { ApiError, errorText } from "../../api/client";
import { useCaps } from "../../api/config";
import { setAnalyticsEnabled, useAnalyticsEnabled } from "../../api/events";
import type { Alert, Consent, Me, SessionRow } from "../../api/types";
import { PERSONA_BY_ID, useProfile } from "../../engine/profile";
import { MARKET_LABEL } from "../../engine/universe";
import { fmtMoney } from "../../engine/format";

/* ---------------- helpers ---------------- */

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  return fmtAsOf(iso, { date: true });
}

function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** "Chrome on macOS" from a user agent (no fingerprinting, just a label). */
function deviceLabel(ua: string | null, kind: SessionRow["kind"]): string {
  if (kind === "extension") return "Tudumm extension";
  if (!ua) return "Unknown browser";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : /curl|node|undici/i.test(ua)
              ? "Script / API client"
              : "Browser";
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X|Macintosh/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /CrOS/.test(ua)
            ? "ChromeOS"
            : /Linux/.test(ua)
              ? "Linux"
              : "";
  return os ? `${browser} on ${os}` : browser;
}

const KIND_LABEL: Record<Alert["kind"], string> = {
  price_above: "Price above",
  price_below: "Price below",
  new_signal: "New signal",
  signal_update: "Signal update",
};

const CONSENT_LABEL: Record<string, { label: string; to: string | null }> = {
  terms: { label: "Terms of use", to: "/terms" },
  risk_disclosure: { label: "Risk disclosure", to: "/risk" },
  privacy: { label: "Privacy notice", to: "/privacy" },
  marketing: { label: "Product news by email", to: null },
};

const PLAN_SOURCE: Record<string, string> = {
  default: "Default plan",
  admin_grant: "Granted by the Tudumm team",
  billing: "Paid",
};

function fmtThreshold(v: number | null): string {
  if (v === null) return "";
  return v.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function Section({ title, icon, aside, children, className = "" }: { title: string; icon?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel acct__sec ${className}`}>
      <header className="panel__head">
        <span className="eyebrow acct__eyebrow">
          {icon}
          {title}
        </span>
        {aside}
      </header>
      <div className="panel__body">{children}</div>
    </section>
  );
}

function AnalyticsToggle() {
  const on = useAnalyticsEnabled();
  return (
    <div className="acct__row acct__row--switch">
      <Switch
        checked={on}
        onChange={(v) => {
          setAnalyticsEnabled(v);
          toast(v ? "Product analytics on" : "Product analytics off — this browser sends no events");
        }}
      >
        Allow product analytics
      </Switch>
      <p className="acct__hint">
        First-party, named events only (no third-party trackers, no IP stored). When off, this browser sends nothing.{" "}
        <Link to="/privacy#analytics" className="u-link">
          What we record
        </Link>
      </p>
    </div>
  );
}

/* ---------------- page ---------------- */

export default function Account() {
  useDocumentTitle("Account · Tudumm");
  const { status, me } = useSession();

  if (status === "unknown") {
    return (
      <div className="acct">
        <AccountHead title={<>Your account</>} note="Checking your session…" />
        <div className="loading" role="status" aria-live="polite">
          <span className="loading__beat" />
          <span className="loading__beat" />
          <span className="visually-hidden">Loading account</span>
        </div>
      </div>
    );
  }

  if (status === "suspended") {
    return (
      <div className="acct">
        <AccountHead title={<>Account suspended</>} note="Signed-in features are paused for this account." />
        <EmptyState
          title="This account is suspended."
          action={
            <Link to="/app/support" className="btn">
              Contact support
            </Link>
          }
        >
          If you think that's a mistake, open a support ticket and a person will look at it. You can keep browsing signals as a guest.
        </EmptyState>
      </div>
    );
  }

  if (status !== "signed_in" || !me) return <SignedOut />;
  return <SignedIn me={me} />;
}

function AccountHead({ title, note }: { title: ReactNode; note: ReactNode }) {
  return (
    <header className="phead">
      <div>
        <p className="eyebrow">Account</p>
        <h1 className="phead__title serif">{title}</h1>
      </div>
      <p className="phead__note">{note}</p>
    </header>
  );
}

function SignedOut() {
  return (
    <div className="acct">
      <AccountHead
        title={
          <>
            Your account, <em>your data.</em>
          </>
        }
        note="You're browsing as a guest. Your profile, watchlist and tracked list live in this browser only."
      />
      <div className="acct__grid">
        <Section title="Sign in" icon={<LogIn size={13} aria-hidden="true" />}>
          <p className="acct__lede serif">Keep your watchlist, alerts and tickets on every device.</p>
          <ul className="acct__bullets">
            <li>Sign in with a one-time code sent to your email. No password.</li>
            <li>Your guest watchlist, tracked list and profile are merged into the account the first time.</li>
            <li>Price and signal alerts, notifications and your support history need an account.</li>
          </ul>
          <button type="button" className="btn btn--primary" onClick={() => openSignIn("Sign in to manage your account")}>
            <LogIn size={15} aria-hidden="true" /> Sign in
          </button>
        </Section>
        <Section title="Privacy" icon={<ShieldCheck size={13} aria-hidden="true" />}>
          <AnalyticsToggle />
          <p className="acct__hint">
            Read the{" "}
            <Link to="/privacy" className="u-link">
              privacy notice
            </Link>
            ,{" "}
            <Link to="/terms" className="u-link">
              terms
            </Link>{" "}
            and{" "}
            <Link to="/risk" className="u-link">
              risk disclosure
            </Link>
            .
          </p>
        </Section>
      </div>
    </div>
  );
}

function SignedIn({ me }: { me: Me }) {
  const name = me.user.displayName || me.user.email;
  return (
    <div className="acct">
      <AccountHead
        title={
          <>
            Your account, <em>your data.</em>
          </>
        }
        note={
          <>
            Signed in as <b className="acct__email">{me.user.email}</b>
            {name !== me.user.email ? ` (${name})` : ""}. Member since {fmtDay(me.user.createdAt)}.
          </>
        }
      />
      <div className="acct__grid">
        <PlanSection me={me} />
        <ProfileSection me={me} />
        <AlertsSection />
        <NotificationsSection me={me} />
        <SessionsSection />
        <ConsentsSection me={me} />
        <PrivacySection />
        <DangerSection />
      </div>
    </div>
  );
}

/* ---------------- plan ---------------- */
function PlanSection({ me }: { me: Me }) {
  const p = me.plan;
  return (
    <Section
      title="Plan"
      aside={
        <Link to="/#pricing" className="u-link acct__aside">
          See plans
        </Link>
      }
    >
      <div className="acct__plan">
        <p className="acct__plan-name serif">{p.name}</p>
        <span className={`chip ${p.id === "free" ? "" : "chip--brand"}`}>{p.id}</span>
      </div>
      <p className="acct__meta mono">
        {PLAN_SOURCE[p.source] ?? p.source}
        {p.expiresAt ? ` · until ${fmtDay(p.expiresAt)}` : p.id === "free" ? "" : " · no end date"} · up to {p.limits.alerts} alerts
      </p>
      {p.features.length > 0 && (
        <ul className="acct__feats">
          {p.features.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
      {p.id === "free" && <p className="acct__hint">Billing isn't live yet. Ask for early access through Support if you need a paid plan.</p>}
    </Section>
  );
}

/* ---------------- profile ---------------- */
function ProfileSection({ me }: { me: Me }) {
  const profile = useProfile();
  const [name, setName] = useState(me.user.displayName ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setName(me.user.displayName ?? ""), [me.user.displayName]);
  const trimmed = name.trim();
  const changed = trimmed !== (me.user.displayName ?? "");
  const tooLong = trimmed.length > 60;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!changed || tooLong) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await meApi.patch({ displayName: trimmed || null });
      patchMe({ user: r.user });
      toast(trimmed ? "Display name saved" : "Display name removed");
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Profile"
      aside={
        <Link to="/app/profile" className="u-link acct__aside">
          Edit trading profile
        </Link>
      }
    >
      <form className="acct__form" onSubmit={save} noValidate>
        <label className="field">
          <span>Display name (optional)</span>
          <div className="acct__inline">
            <input
              className="input"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              placeholder="How Tudumm greets you"
              aria-invalid={tooLong}
              aria-describedby="acct-name-err"
              autoComplete="nickname"
            />
            <button type="submit" className="btn" disabled={!changed || tooLong || busy}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </label>
        <p id="acct-name-err" className="form-err" aria-live="polite">
          {tooLong ? "Keep it to 60 characters or fewer." : err}
        </p>
      </form>
      <dl className="acct__dl">
        <div>
          <dt>Email</dt>
          <dd className="mono">
            {me.user.email}
            {me.user.emailVerified ? <span className="chip acct__chip-ok">verified</span> : <span className="chip">not verified by email</span>}
          </dd>
        </div>
        <div>
          <dt>Trading style</dt>
          <dd>{PERSONA_BY_ID[profile.persona]?.label ?? profile.persona}</dd>
        </div>
        <div>
          <dt>Markets</dt>
          <dd>{profile.markets.map((m) => MARKET_LABEL[m] ?? m).join(", ") || "—"}</dd>
        </div>
        <div>
          <dt>Capital · risk per trade</dt>
          <dd className="mono">
            {fmtMoney(profile.capital, profile.currency)} · {profile.riskPct}%
          </dd>
        </div>
      </dl>
    </Section>
  );
}

/* ---------------- alerts ---------------- */
function AlertsSection() {
  const a = useApi("me:alerts", () => alertsApi.list(), { staleMs: 2_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const items = a.data?.items ?? [];
  const shown = items.filter((x) => !(x.symbol === "*" && x.kind === "new_signal"));

  const toggle = async (al: Alert) => {
    setBusy(al.id);
    a.mutate((prev) => (prev ? { ...prev, items: prev.items.map((x) => (x.id === al.id ? { ...x, active: !al.active } : x)) } : prev!));
    try {
      const r = await alertsApi.patch(al.id, { active: !al.active });
      a.mutate((prev) => (prev ? { ...prev, items: prev.items.map((x) => (x.id === al.id ? r.alert : x)) } : prev!));
      toast(r.alert.active ? `${al.symbol} alert on` : `${al.symbol} alert paused`);
    } catch (x) {
      a.mutate((prev) => (prev ? { ...prev, items: prev.items.map((y) => (y.id === al.id ? al : y)) } : prev!));
      toast(errorText(x));
    } finally {
      setBusy(null);
    }
  };
  const remove = async (al: Alert) => {
    setBusy(al.id);
    try {
      await alertsApi.remove(al.id);
      a.mutate((prev) => (prev ? { ...prev, items: prev.items.filter((x) => x.id !== al.id) } : prev!));
      toast("Alert deleted");
    } catch (x) {
      toast(errorText(x));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section
      title="Alerts"
      icon={<Bell size={13} aria-hidden="true" />}
      aside={a.data ? <span className="mono t3 acct__aside">{items.length} / {a.data.limit}</span> : undefined}
      className="acct__sec--wide"
    >
      {a.error && !a.data ? (
        <div className="acct__err" role="alert">
          <p>{errorText(a.error)}</p>
          <button type="button" className="btn btn--sm" onClick={() => void a.reload()}>
            Retry
          </button>
        </div>
      ) : a.loading && !a.data ? (
        <p className="acct__hint">Loading your alerts…</p>
      ) : shown.length === 0 ? (
        <p className="acct__hint">
          No price or signal alerts yet. Open any instrument and use <b>Set price alert</b> or <b>Notify me about new signals</b>.{" "}
          <Link to="/app/markets" className="u-link">
            Browse markets
          </Link>
        </p>
      ) : (
        <div className="acct__table-wrap">
          <table className="dtable acct__table">
            <thead>
              <tr>
                <th scope="col">Symbol</th>
                <th scope="col">Alert</th>
                <th scope="col">Last fired</th>
                <th scope="col">Active</th>
                <th scope="col">
                  <span className="visually-hidden">Delete</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((al) => (
                <tr key={al.id} className={al.active ? "" : "is-off"}>
                  <td className="mono">
                    {al.symbol === "*" ? (
                      "Watchlist"
                    ) : (
                      <Link to={`/app/i/${al.symbol}`} className="u-link">
                        {al.symbol}
                      </Link>
                    )}
                  </td>
                  <td>
                    {KIND_LABEL[al.kind] ?? al.kind}
                    {al.threshold !== null && <span className="mono"> {fmtThreshold(al.threshold)}</span>}
                    {al.kind.startsWith("price") && <span className="t3"> · {al.oneShot ? "once" : "repeats daily"}</span>}
                  </td>
                  <td className="mono t3">{al.lastTriggeredAt ? fmtWhen(al.lastTriggeredAt) : "never"}</td>
                  <td>
                    <Switch checked={al.active} onChange={() => busy !== al.id && void toggle(al)}>
                      <span className="visually-hidden">{al.active ? "Pause" : "Resume"} {al.symbol} alert</span>
                    </Switch>
                  </td>
                  <td className="acct__td-act">
                    <button
                      type="button"
                      className="btn btn--ghost btn--icon btn--sm"
                      aria-label={`Delete ${al.symbol} ${KIND_LABEL[al.kind] ?? al.kind} alert`}
                      disabled={busy === al.id}
                      onClick={() => void remove(al)}
                    >
                      <X size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

/* ---------------- notifications ---------------- */
function NotificationsSection({ me }: { me: Me }) {
  const caps = useCaps();
  const a = useApi("me:alerts", () => alertsApi.list(), { staleMs: 2_000 });
  const watchAlert = a.data?.items.find((x) => x.symbol === "*" && x.kind === "new_signal") ?? null;
  const [busy, setBusy] = useState<"mkt" | "watch" | null>(null);

  const setMarketing = async (v: boolean) => {
    setBusy("mkt");
    try {
      const r = await meApi.patch({ marketingOptIn: v });
      patchMe({ user: r.user });
      void refreshMe();
      toast(v ? "You'll get occasional product news" : "Product news turned off");
    } catch (x) {
      toast(errorText(x));
    } finally {
      setBusy(null);
    }
  };

  const setWatch = async (v: boolean) => {
    setBusy("watch");
    try {
      if (v) {
        const r = await alertsApi.create({ symbol: "*", kind: "new_signal" });
        a.mutate((prev) => (prev ? { ...prev, items: [r.alert, ...prev.items] } : { items: [r.alert], limit: me.plan.limits.alerts }));
        toast("You'll be notified about new signals on your watchlist");
      } else if (watchAlert) {
        await alertsApi.remove(watchAlert.id);
        a.mutate((prev) => (prev ? { ...prev, items: prev.items.filter((x) => x.id !== watchAlert.id) } : prev!));
        toast("Watchlist signal notifications off");
      }
    } catch (x) {
      toast(errorText(x));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section title="Notifications">
      <div className="acct__row acct__row--switch">
        <Switch checked={!!watchAlert && watchAlert.active} onChange={(v) => busy === null && a.data && void setWatch(v)}>
          New signals on my watchlist
        </Switch>
        <p className="acct__hint">
          {a.error && !a.data ? errorText(a.error) : "Fires when Tudumm issues a call on any symbol you've starred. Held or sitting-out calls never notify."}
        </p>
      </div>
      <div className="acct__row acct__row--switch">
        <Switch checked={me.user.marketingOptIn} onChange={(v) => busy === null && void setMarketing(v)}>
          Email me about product news
        </Switch>
        <p className="acct__hint">Occasional updates about new markets and features. Never shared or sold.</p>
      </div>
      <p className={`acct__note ${caps.emailDelivery ? "" : "acct__note--warn"}`}>
        {caps.emailDelivery
          ? me.user.emailVerified
            ? "Alerts appear in the bell and are also emailed to you."
            : "Alerts appear in the bell. Email copies start once your email is verified by a real sign-in code."
          : "Delivery is in-app only for now: email isn't switched on yet, so alerts show up in the bell and nowhere else."}
      </p>
    </Section>
  );
}

/* ---------------- sessions + extension devices ---------------- */
function SessionsSection() {
  const caps = useCaps();
  const s = useApi("me:sessions", () => meApi.sessions(), { staleMs: 2_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const items = s.data?.items ?? [];
  const web = items.filter((x) => x.kind !== "extension");
  const ext = items.filter((x) => x.kind === "extension");

  const revoke = async (row: SessionRow) => {
    setBusy(row.id);
    try {
      await meApi.revokeSession(row.id);
      s.mutate((prev) => (prev ? { items: prev.items.filter((x) => x.id !== row.id) } : prev!));
      toast(row.kind === "extension" ? "Extension unlinked" : "Device signed out");
    } catch (x) {
      toast(errorText(x));
    } finally {
      setBusy(null);
    }
  };

  const signOutAll = async () => {
    setBusy("all");
    await signOut({ all: true, silent: true });
    toast("Signed out on every device");
    setBusy(null);
  };

  const row = (r: SessionRow) => (
    <li key={r.id} className="acct__dev">
      <div className="acct__dev-main">
        <p>
          <b>{deviceLabel(r.userAgent, r.kind)}</b>
          {r.current && <span className="chip chip--brand acct__chip">This device</span>}
        </p>
        <p className="acct__meta mono">
          Signed in {fmtWhen(r.createdAt)} · last used {fmtWhen(r.lastUsedAt)} · expires {fmtDay(r.expiresAt)}
        </p>
      </div>
      {r.current ? (
        <button type="button" className="btn btn--sm" onClick={() => void signOut()}>
          <LogOut size={13} aria-hidden="true" /> Sign out
        </button>
      ) : (
        <button type="button" className="btn btn--sm btn--danger" disabled={busy === r.id} onClick={() => void revoke(r)}>
          {busy === r.id ? "…" : r.kind === "extension" ? "Unlink" : "Revoke"}
        </button>
      )}
    </li>
  );

  return (
    <Section
      title="Devices and sessions"
      className="acct__sec--wide"
      aside={
        web.length > 1 || ext.length > 0 ? (
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy === "all"} onClick={() => void signOutAll()}>
            Sign out everywhere
          </button>
        ) : undefined
      }
    >
      {s.error && !s.data ? (
        <div className="acct__err" role="alert">
          <p>{errorText(s.error)}</p>
          <button type="button" className="btn btn--sm" onClick={() => void s.reload()}>
            Retry
          </button>
        </div>
      ) : s.loading && !s.data ? (
        <p className="acct__hint">Loading sessions…</p>
      ) : (
        <div className="acct__devs">
          <div>
            <p className="acct__sub">Browsers</p>
            {web.length ? <ul className="acct__devlist">{web.map(row)}</ul> : <p className="acct__hint">No other browser sessions.</p>}
          </div>
          <div>
            <p className="acct__sub">
              <Puzzle size={12} aria-hidden="true" /> Linked extension devices
            </p>
            {ext.length ? (
              <ul className="acct__devlist">{ext.map(row)}</ul>
            ) : caps.extensionLinking ? (
              <p className="acct__hint">
                None linked. In the Tudumm Chrome extension, choose <b>Link account</b>: it shows a code and opens a page here to approve it. Linked
                devices sync your watchlist and can be unlinked at any time.
              </p>
            ) : (
              <p className="acct__hint">None linked. Extension linking is switched off right now.</p>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}

/* ---------------- consents ---------------- */
function ConsentsSection({ me }: { me: Me }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Consent["kind"] | null>(null);
  // newest row per kind (the list is newest first)
  const latest = new Map<string, Consent>();
  for (const c of me.consents) if (!latest.has(c.kind)) latest.set(c.kind, c);
  const rows = [...latest.values()];

  const apply = (r: { consents: Consent[]; pendingConsents: { kind: string; version: string }[] }) => patchMe({ consents: r.consents, pendingConsents: r.pendingConsents });

  const accept = async (kind: Consent["kind"], version: string) => {
    setBusy(kind);
    try {
      apply(await consentApi.accept(kind, version));
      toast(`${CONSENT_LABEL[kind]?.label ?? kind} accepted`);
    } catch (x) {
      toast(errorText(x));
    } finally {
      setBusy(null);
    }
  };
  const withdraw = async (kind: Consent["kind"]) => {
    setBusy(kind);
    try {
      apply(await consentApi.withdraw(kind));
      setConfirm(null);
      if (kind === "marketing") void refreshMe();
      toast(`${CONSENT_LABEL[kind]?.label ?? kind}: consent withdrawn`);
    } catch (x) {
      toast(errorText(x));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section title="Consents" className="acct__sec--wide">
      {me.pendingConsents.length > 0 && (
        <div className="acct__pending" role="status">
          <p>
            <b>Action needed.</b> Accept the current version{me.pendingConsents.length > 1 ? "s" : ""} to keep using signed-in features.
          </p>
          <ul>
            {me.pendingConsents.map((p) => {
              const meta = CONSENT_LABEL[p.kind];
              return (
                <li key={p.kind}>
                  <span>
                    {meta?.to ? (
                      <Link to={meta.to} className="u-link">
                        {meta.label}
                      </Link>
                    ) : (
                      (meta?.label ?? p.kind)
                    )}{" "}
                    <span className="mono t3">v{p.version}</span>
                  </span>
                  <button type="button" className="btn btn--sm btn--primary" disabled={busy === p.kind} onClick={() => void accept(p.kind as Consent["kind"], p.version)}>
                    {busy === p.kind ? "…" : "I accept"}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="acct__hint">No consents recorded yet.</p>
      ) : (
        <div className="acct__table-wrap">
          <table className="dtable acct__table">
            <thead>
              <tr>
                <th scope="col">Document</th>
                <th scope="col">Version</th>
                <th scope="col">Accepted</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const meta = CONSENT_LABEL[c.kind];
                const active = !c.withdrawnAt;
                return (
                  <tr key={`${c.kind}:${c.version}:${c.acceptedAt}`}>
                    <td>
                      {meta?.to ? (
                        <Link to={meta.to} className="u-link">
                          {meta.label}
                        </Link>
                      ) : (
                        (meta?.label ?? c.kind)
                      )}
                    </td>
                    <td className="mono">{c.version}</td>
                    <td className="mono t3">{fmtWhen(c.acceptedAt)}</td>
                    <td>{active ? <span className="chip acct__chip-ok">active</span> : <span className="chip">withdrawn {fmtDay(c.withdrawnAt)}</span>}</td>
                    <td className="acct__td-act">
                      {active &&
                        (confirm === c.kind ? (
                          <span className="acct__confirm">
                            <button type="button" className="btn btn--sm btn--danger" disabled={busy === c.kind} onClick={() => void withdraw(c.kind)}>
                              {busy === c.kind ? "…" : "Confirm"}
                            </button>
                            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirm(null)}>
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirm(c.kind)}>
                            Withdraw
                          </button>
                        ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {confirm && confirm !== "marketing" && (
        <p className="acct__note acct__note--warn" role="status">
          Withdrawing this means Tudumm will ask you to accept it again before you can keep using signed-in features. To stop using Tudumm entirely,
          delete your account below.
        </p>
      )}
    </Section>
  );
}

/* ---------------- privacy: analytics + export ---------------- */
function PrivacySection() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const download = async () => {
    setBusy(true);
    setErr(null);
    try {
      const { blob, filename } = await meApi.exportData();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast("Your data export is downloading");
    } catch (x) {
      setErr(x instanceof ApiError && x.status === 429 ? "Slow down — you can download your data up to 5 times a day. Try again later." : errorText(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Privacy and your data" icon={<ShieldCheck size={13} aria-hidden="true" />}>
      <AnalyticsToggle />
      <div className="acct__row">
        <button type="button" className="btn" onClick={() => void download()} disabled={busy}>
          <Download size={15} aria-hidden="true" /> {busy ? "Preparing…" : "Download my data"}
        </button>
        <p className="acct__hint">A JSON file with every row Tudumm holds about your account. Up to 5 downloads a day.</p>
        <p className="form-err" aria-live="polite">
          {err}
        </p>
      </div>
    </Section>
  );
}

/* ---------------- danger zone ---------------- */
function DangerSection() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ok = typed.trim() === "DELETE";

  const del = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true);
    setErr(null);
    try {
      await meApi.deleteAccount();
      signedOutLocally("Your account was deleted");
      navigate("/");
    } catch (x) {
      setErr(errorText(x));
      setBusy(false);
    }
  };

  return (
    <Section title="Delete account" icon={<Trash2 size={13} aria-hidden="true" />} className="acct__sec--danger">
      <p className="acct__hint">
        Erases your email, profile, watchlist, tracked list, alerts, notifications and every session, immediately. Activity events and support tickets
        are kept for statistics and grievance records but de-linked from you. This can't be undone.
      </p>
      {!open ? (
        <button type="button" className="btn btn--danger" onClick={() => setOpen(true)}>
          <Trash2 size={15} aria-hidden="true" /> Delete my account…
        </button>
      ) : (
        <form className="acct__form" onSubmit={del} noValidate>
          <label className="field">
            <span>
              Type <b className="mono">DELETE</b> to confirm
            </span>
            <input className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} autoFocus />
          </label>
          <div className="acct__actions">
            <button type="submit" className="btn btn--danger" disabled={!ok || busy}>
              {busy ? "Deleting…" : "Permanently delete"}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                setOpen(false);
                setTyped("");
                setErr(null);
              }}
            >
              Cancel
            </button>
          </div>
          <p className="form-err" aria-live="polite">
            {err}
          </p>
        </form>
      )}
    </Section>
  );
}
