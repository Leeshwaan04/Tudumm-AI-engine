import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Eye, EyeOff, Lock } from "lucide-react";
import { LogoMark } from "../components/Logo";
import { api, ApiError } from "./api";
import { ErrorNote, Loading } from "./ui";
import type { AdminMe, PublicConfig } from "./types";

type Gate = "checking" | "ready" | "not_configured" | "unknown";

export function Login() {
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const nextRaw = sp.get("next") ?? "/admin";
  // only allow in-portal redirects
  const next = nextRaw.startsWith("/admin") && !nextRaw.startsWith("//") && !nextRaw.startsWith("/admin/login") ? nextRaw : "/admin";
  const [gate, setGate] = useState<Gate>("checking");
  const [cfgErr, setCfgErr] = useState<unknown>(null);
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    setGate("checking");
    (async () => {
      // Already signed in? Skip the form.
      try {
        await api<AdminMe>("/api/admin/me");
        if (live) navigate(next, { replace: true });
        return;
      } catch (e) {
        if (e instanceof ApiError && e.code === "admin_not_configured") {
          if (live) setGate("not_configured");
          return;
        }
      }
      try {
        const c = await api<PublicConfig>("/api/v1/config");
        if (!live) return;
        setGate(c.capabilities.adminConfigured ? "ready" : "not_configured");
        setCfgErr(null);
      } catch (e) {
        if (!live) return;
        setCfgErr(e);
        setGate("unknown");
      }
    })();
    return () => {
      live = false;
    };
  }, [nonce, navigate, next]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pw || pending) return;
    setPending(true);
    setErr(null);
    try {
      await api<{ ok: boolean; expiresAt: string }>("/api/admin/login", { method: "POST", body: { password: pw } });
      setPw("");
      navigate(next, { replace: true });
    } catch (e2) {
      if (e2 instanceof ApiError && e2.code === "admin_not_configured") setGate("not_configured");
      setErr(e2);
    } finally {
      setPending(false);
    }
  };

  const notice = sp.get("expired") ? "Your admin session ended. Sign in again to continue." : sp.get("signedout") ? "Signed out. The admin cookie was revoked." : null;

  return (
    <div className="adm-login">
      <div className="adm-login__card">
        <div className="adm-login__brand">
          <LogoMark size={30} />
          <span className="eyebrow">Tudumm · operator console</span>
        </div>
        <h1 className="adm-login__t serif">
          The <em>desk</em> behind the verdicts.
        </h1>
        <p className="t2 adm-login__lede">Users, engine controls, support and the audit trail. One owner password; every attempt is recorded.</p>

        {notice && <p className="adm-login__notice">{notice}</p>}

        {gate === "checking" && <Loading label="Checking admin availability" />}

        {gate === "not_configured" && (
          <div className="adm-gate" role="status">
            <Lock size={16} aria-hidden="true" />
            <div>
              <p>Admin isn't configured yet.</p>
              <p className="t2">
                Owner: run <code className="mono">scripts/set-secrets.sh</code> to set <code className="mono">ADMIN_PASSWORD</code>. Until then every admin route answers{" "}
                <code className="mono">503 admin_not_configured</code>.
              </p>
              <button type="button" className="btn btn--sm" onClick={() => setNonce((n) => n + 1)}>
                Check again
              </button>
            </div>
          </div>
        )}

        {(gate === "ready" || gate === "unknown") && (
          <form className="adm-login__form" onSubmit={submit}>
            {gate === "unknown" && cfgErr ? <ErrorNote error={cfgErr} onRetry={() => setNonce((n) => n + 1)} compact /> : null}
            <label className="field" htmlFor="adm-pw">
              <span>Admin password</span>
              <span className="adm-pw">
                <input
                  id="adm-pw"
                  className="input mono"
                  type={show ? "text" : "password"}
                  autoComplete="current-password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  maxLength={512}
                  autoFocus
                  required
                />
                <button type="button" className="btn btn--icon btn--ghost btn--sm" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide password" : "Show password"} aria-pressed={show}>
                  {show ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                </button>
              </span>
            </label>
            {err ? <ErrorNote error={err} compact /> : null}
            <button type="submit" className="btn btn--primary btn--lg" disabled={!pw || pending}>
              {pending ? "Signing in…" : "Sign in"}
            </button>
            <p className="mono t3 adm-login__fine">8-hour session · SameSite=Strict cookie · 5 attempts per 15 min</p>
          </form>
        )}
      </div>
    </div>
  );
}
