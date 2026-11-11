import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Activity, ArrowUpRight, Briefcase, Cpu, Flag, Inbox, LayoutDashboard, LifeBuoy, LogOut, Scale, ScrollText, Users } from "lucide-react";
import { LogoMark } from "../components/Logo";
import { api, ApiError, onAuthLost } from "./api";
import { hasBroker } from "./broker";
import { dur } from "./format";
import { useNow } from "./hooks";
import { AdminCtx } from "./session";
import { ErrorNote, Loading } from "./ui";
import type { AdminMe, PublicConfig } from "./types";

const NAV = [
  { to: "/admin", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/admin/users", label: "Users", icon: Users },
  { to: "/admin/activity", label: "Activity", icon: Activity },
  { to: "/admin/engine", label: "Engine", icon: Cpu },
  ...(hasBroker ? [{ to: "/admin/broker", label: "Broker", icon: Briefcase }] : []),
  { to: "/admin/support", label: "Support", icon: LifeBuoy },
  { to: "/admin/content", label: "Content", icon: Flag },
  { to: "/admin/compliance", label: "Compliance", icon: Scale },
  { to: "/admin/audit", label: "Audit log", icon: ScrollText },
];

export function AdminLayout() {
  const [me, setMe] = useState<AdminMe | null>(null);
  const [err, setErr] = useState<ApiError | Error | null>(null);
  const [appEnv, setAppEnv] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [lost, setLost] = useState(false);
  const loc = useLocation();
  const navigate = useNavigate();
  const now = useNow(30_000);

  useEffect(() => {
    let live = true;
    api<AdminMe>("/api/admin/me")
      .then((m) => {
        if (!live) return;
        setMe(m);
        setErr(null);
      })
      .catch((e: unknown) => {
        if (live) setErr(e instanceof Error ? e : new Error(String(e)));
      });
    api<PublicConfig>("/api/v1/config")
      .then((c) => {
        if (live) setAppEnv(c.appEnv);
      })
      .catch(() => {
        /* env chip is optional */
      });
    return () => {
      live = false;
    };
  }, [nonce]);

  // Only a 401 *after* a session was established counts as "session ended"; the first /me probe
  // on a cold visit is handled below as a plain redirect to the login form.
  const hadSession = useRef(false);
  hadSession.current = me !== null;
  useEffect(() => onAuthLost(() => hadSession.current && setLost(true)), []);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [loc.pathname]);

  const expiresMs = me ? Date.parse(me.expiresAt) : NaN;
  const expired = Number.isFinite(expiresMs) && expiresMs <= now;

  const refreshMe = useCallback(() => setNonce((n) => n + 1), []);
  const ctx = useMemo(() => (me ? { me, appEnv, refreshMe } : null), [me, appEnv, refreshMe]);

  const next = encodeURIComponent(loc.pathname + loc.search);
  if (lost || expired) return <Navigate to={`/admin/login?expired=1&next=${next}`} replace />;
  if (err instanceof ApiError && (err.status === 401 || err.code === "admin_not_configured")) return <Navigate to={`/admin/login?next=${next}`} replace />;

  if (!me || !ctx) {
    return (
      <div className="adm-boot">
        {err ? (
          <div className="adm-boot__err">
            <LogoMark size={28} />
            <ErrorNote error={err} onRetry={refreshMe} />
          </div>
        ) : (
          <Loading label="Checking admin session" />
        )}
      </div>
    );
  }

  const logout = async () => {
    try {
      await api("/api/admin/logout", { method: "POST" });
    } catch {
      /* the cookie may already be gone; go to login either way */
    }
    navigate("/admin/login?signedout=1", { replace: true });
  };

  const left = Number.isFinite(expiresMs) ? (expiresMs - now) / 1000 : null;
  const nav = me.capabilities.devCodes ? [...NAV, { to: "/admin/dev-outbox", label: "Dev outbox", icon: Inbox, end: false }] : NAV;

  return (
    <AdminCtx.Provider value={ctx}>
      <div className="adm">
        <aside className="adm-side" aria-label="Admin navigation">
          <Link to="/admin" className="adm-brand" aria-label="Tudumm operator console">
            <LogoMark size={22} />
            <span className="adm-brand__w serif">tudumm</span>
            <span className="adm-brand__tag mono">operator</span>
          </Link>
          <nav className="adm-nav">
            {nav.map((n) => (
              <NavLink key={n.to} to={n.to} end={"end" in n ? n.end : false} className="adm-nav__i">
                <n.icon size={16} aria-hidden="true" />
                <span>{n.label}</span>
              </NavLink>
            ))}
          </nav>
          <div className="adm-side__foot">
            <Link to="/app" className="adm-nav__i adm-nav__i--quiet">
              <ArrowUpRight size={15} aria-hidden="true" />
              <span>Open the terminal</span>
            </Link>
          </div>
        </aside>

        <div className="adm-main">
          <header className="adm-top">
            <Link to="/admin" className="adm-top__brand" aria-label="Operator console home">
              <LogoMark size={22} />
              <span className="adm-brand__tag mono">operator</span>
            </Link>
            <div className="adm-top__meta">
              {appEnv && <span className={`adm-env mono adm-env--${appEnv === "production" ? "prod" : "dev"}`}>{appEnv}</span>}
              <span className="adm-top__who mono" title={`Session ${me.sessionId.slice(0, 8)}`}>
                {me.actor}
              </span>
              {left !== null && (
                <span className={`adm-top__exp mono${left < 900 ? " c-brand" : ""}`} title={`Admin session expires ${new Date(expiresMs).toLocaleString()}`}>
                  {dur(left)} left
                </span>
              )}
            </div>
            <button type="button" className="btn btn--sm btn--ghost" onClick={logout} aria-label="Sign out" title="Sign out">
              <LogOut size={14} aria-hidden="true" />
              <span className="adm-hide-sm">Sign out</span>
            </button>
          </header>
          <nav className="adm-strip" aria-label="Admin sections">
            {nav.map((n) => (
              <NavLink key={n.to} to={n.to} end={"end" in n ? n.end : false} className="adm-strip__i">
                <n.icon size={14} aria-hidden="true" />
                <span>{n.label}</span>
              </NavLink>
            ))}
          </nav>
          <main className="adm-page" id="adm-main">
            <Outlet />
          </main>
          <footer className="adm-foot">
            <p className="t3">
              Every admin mutation is written to the append-only audit log. Admin data is held in memory only and never stored in this browser.
            </p>
          </footer>
        </div>
      </div>
    </AdminCtx.Provider>
  );
}
