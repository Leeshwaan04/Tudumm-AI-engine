import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Bell, CheckCheck, LifeBuoy, LogOut, Megaphone, UserRound, X } from "lucide-react";
import { useConfig } from "../api/config";
import { notificationsApi } from "../api/endpoints";
import { openSignIn, patchMe, signOut, useSession } from "../api/session";
import { useApi } from "../api/useApi";
import { errorText } from "../api/client";
import type { Announcement, Notification } from "../api/types";
import { storage } from "../engine/profile";
import { fmtAsOf } from "./badges";
import { toast } from "./ui";

/* ---------------- shared popover behaviour ---------------- */
function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return { open, setOpen, ref };
}

/* ---------------- sign in / avatar ---------------- */
export function AuthControl() {
  const session = useSession();
  const cfg = useConfig();
  const caps = cfg.caps;
  const canSignIn = caps.emailDelivery || caps.devCodes || caps.googleSignIn;

  if (session.status === "unknown") return <span className="auth-ph" aria-hidden="true" />;
  if (session.status === "suspended") {
    return (
      <Link to="/app/support" className="acct-chip acct-chip--warn" title="This account is suspended. Contact support.">
        Suspended
      </Link>
    );
  }
  if (session.status === "signed_out") {
    if (!canSignIn) return null;
    return (
      <button type="button" className="btn btn--sm btn--primary auth-btn" onClick={() => openSignIn()}>
        Sign in
      </button>
    );
  }
  return (
    <>
      <BellMenu />
      <AvatarMenu />
    </>
  );
}

function AvatarMenu() {
  const { me } = useSession();
  const { open, setOpen, ref } = usePopover();
  const navigate = useNavigate();
  if (!me) return null;
  const label = me.user.displayName || me.user.email;
  const initial = (label.trim()[0] ?? "?").toUpperCase();
  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };
  return (
    <div className="pop" ref={ref}>
      <button type="button" className="avatar" aria-haspopup="menu" aria-expanded={open} aria-label={`Account menu for ${me.user.email}`} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true">{initial}</span>
      </button>
      {open && (
        <div className="pop__panel menu" role="menu">
          <div className="menu__who">
            <p className="menu__name">{label}</p>
            {me.user.displayName && <p className="menu__email mono">{me.user.email}</p>}
            <span className="chip chip--brand menu__plan">{me.plan?.name ?? me.user.plan} plan</span>
          </div>
          <button type="button" role="menuitem" className="menu__item" onClick={() => go("/app/account")}>
            <UserRound size={15} aria-hidden="true" /> Account
          </button>
          <button type="button" role="menuitem" className="menu__item" onClick={() => go("/app/support")}>
            <LifeBuoy size={15} aria-hidden="true" /> Support
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu__item"
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
          >
            <LogOut size={15} aria-hidden="true" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------------- notifications bell ---------------- */
export const NOTIF_KEY = "me:notifications";

function BellMenu() {
  const { me } = useSession();
  const { open, setOpen, ref } = usePopover();
  const navigate = useNavigate();
  const q = useApi(me ? NOTIF_KEY : null, () => notificationsApi.list(false, 20), { refreshMs: 60_000, staleMs: 15_000 });
  const [busy, setBusy] = useState(false);
  const unread = q.data?.unread ?? me?.counts.unread ?? 0;

  useEffect(() => {
    if (open) void q.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const applyRead = (ids: string[] | "all", nextUnread: number) => {
    const at = new Date().toISOString();
    q.mutate((prev) =>
      prev
        ? { ...prev, unread: nextUnread, items: prev.items.map((n) => (ids === "all" || ids.includes(n.id) ? { ...n, readAt: n.readAt ?? at } : n)) }
        : prev!,
    );
    if (me) patchMe({ counts: { ...me.counts, unread: nextUnread } });
  };

  const markAll = async () => {
    setBusy(true);
    try {
      const r = await notificationsApi.markAll();
      applyRead("all", r.unread ?? 0);
    } catch (e) {
      toast(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const openItem = async (n: Notification) => {
    if (!n.readAt) {
      applyRead([n.id], Math.max(0, unread - 1));
      notificationsApi.markRead([n.id]).catch(() => undefined);
    }
    if (n.link && n.link.startsWith("/")) {
      setOpen(false);
      navigate(n.link);
    }
  };

  return (
    <div className="pop" ref={ref}>
      <button
        type="button"
        className="bell"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        onClick={() => setOpen((o) => !o)}
      >
        <Bell size={16} aria-hidden="true" />
        {unread > 0 && <span className="bell__n mono">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="pop__panel notifs" role="dialog" aria-label="Notifications">
          <header className="notifs__head">
            <span className="eyebrow">Notifications</span>
            <button type="button" className="btn btn--ghost btn--sm" disabled={busy || unread === 0} onClick={() => void markAll()}>
              <CheckCheck size={13} aria-hidden="true" /> Mark all read
            </button>
          </header>
          {q.error && !q.data ? (
            <p className="notifs__empty">{errorText(q.error)}</p>
          ) : !q.data ? (
            <p className="notifs__empty">Loading…</p>
          ) : q.data.items.length === 0 ? (
            <p className="notifs__empty">
              Nothing yet. Set a price alert or switch on "Notify me about new signals" on any instrument page.
            </p>
          ) : (
            <ul className="notifs__list">
              {q.data.items.map((n) => (
                <li key={n.id}>
                  <button type="button" className={`notif ${n.readAt ? "" : "is-unread"}`} onClick={() => void openItem(n)}>
                    <span className="notif__dot" aria-hidden="true" />
                    <span className="notif__body">
                      <b>{n.title}</b>
                      {n.body && <span>{n.body}</span>}
                      <span className="notif__at mono">{fmtAsOf(n.createdAt, { date: true })}</span>
                    </span>
                    {!n.readAt && <span className="visually-hidden">unread</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <footer className="notifs__foot">
            <Link to="/app/account" className="u-link" onClick={() => setOpen(false)}>
              Manage alerts
            </Link>
          </footer>
        </div>
      )}
    </div>
  );
}

/* ---------------- announcements ---------------- */
const DISMISS_KEY = "tudumm.dismissed.v1";
function readDismissed(): string[] {
  try {
    const v = JSON.parse(storage.get(DISMISS_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
let dismissed = readDismissed();
const dl = new Set<() => void>();
function dismiss(id: string) {
  dismissed = [...dismissed.filter((x) => x !== id), id].slice(-50);
  storage.set(DISMISS_KEY, JSON.stringify(dismissed));
  dl.forEach((l) => l());
}

export function AnnouncementBar() {
  const cfg = useConfig();
  const ds = useSyncExternalStore(
    (l) => {
      dl.add(l);
      return () => dl.delete(l);
    },
    () => dismissed,
  );
  const now = Date.now();
  const items = (cfg.config?.announcements ?? []).filter((a: Announcement) => {
    if (ds.includes(a.id)) return false;
    if (a.startsAt && Date.parse(a.startsAt) > now) return false;
    if (a.endsAt && Date.parse(a.endsAt) < now) return false;
    return true;
  });
  if (!items.length) return null;
  return (
    <>
      {items.map((a) => (
        <div key={a.id} className={`banner banner--${a.level === "critical" ? "critical" : a.level === "warning" ? "warning" : "info"} announce`} role={a.level === "critical" ? "alert" : "status"}>
          <Megaphone size={15} aria-hidden="true" />
          <p>
            {a.message}{" "}
            {a.link && <AnnouncementLink href={a.link}>Details</AnnouncementLink>}
          </p>
          <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label="Dismiss announcement" onClick={() => dismiss(a.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </>
  );
}

function AnnouncementLink({ href, children }: { href: string; children: ReactNode }) {
  if (href.startsWith("/")) {
    return (
      <Link to={href} className="u-link">
        {children}
      </Link>
    );
  }
  if (/^https:\/\//.test(href)) {
    return (
      <a href={href} className="u-link" target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  }
  return null;
}
