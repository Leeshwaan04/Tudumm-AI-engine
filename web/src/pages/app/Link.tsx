import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { CheckCircle2, MonitorSmartphone, ShieldCheck } from "lucide-react";
import { useDocumentTitle } from "../../components/hooks";
import { NAState } from "../../components/badges";
import { useConfig } from "../../api/config";
import { extLinkApi } from "../../api/endpoints";
import { ApiError, errorText } from "../../api/client";
import { openSignIn, useSession } from "../../api/session";
import { track } from "../../api/events";
import { clearCache } from "../../api/useApi";

const CODE_RE = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/;
const norm = (c: string) => {
  const x = c.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return x.length > 4 ? `${x.slice(0, 4)}-${x.slice(4)}` : x;
};

/** Device-flow approval for the Chrome extension: /app/link?code=XXXX-XXXX */
export default function LinkDevice() {
  useDocumentTitle("Link extension · Tudumm");
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const cfg = useConfig();
  const session = useSession();
  const fromUrl = norm(params.get("code") ?? "");
  const [code, setCode] = useState(fromUrl);
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => setCode(fromUrl), [fromUrl]);

  const valid = CODE_RE.test(code);

  const approve = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!valid) {
      setErr("Codes look like ABCD-EF23 — copy it from the extension.");
      return;
    }
    setState("busy");
    setErr(null);
    try {
      await extLinkApi.approve(code);
      setState("done");
      clearCache("me:sessions");
      track("extension_link", { ok: true });
    } catch (ex) {
      setState("idle");
      setErr(ex instanceof ApiError && ex.status === 404 ? "That code is wrong, expired (codes last 10 minutes) or already used. Start again from the extension." : errorText(ex));
      track("extension_link", { ok: false, error: ex instanceof ApiError ? ex.code : "network" });
    }
  };

  return (
    <div className="linkp">
      <header className="phead">
        <div>
          <p className="eyebrow">Chrome extension</p>
          <h1 className="phead__title serif">
            Link the <em>extension</em>
          </h1>
        </div>
        <p className="phead__note">The extension uses its own revocable token. It never sees your email code or this browser's session.</p>
      </header>

      {cfg.status === "ready" && !cfg.caps.extensionLinking ? (
        <NAState title="Extension linking is switched off right now" reason="The Tudumm team has paused new extension links. The extension keeps working in guest mode." />
      ) : cfg.status === "unavailable" ? (
        <NAState title="Linking isn't available right now" reason="The Tudumm API can't be reached. Try again in a minute." />
      ) : state === "done" ? (
        <section className="panel linkp__card linkp__card--ok" aria-live="polite">
          <CheckCircle2 size={28} aria-hidden="true" className="c-long" />
          <h2 className="serif">Extension linked</h2>
          <p className="t2">Go back to the extension — it finishes connecting within a few seconds and your watchlist syncs. You can unlink it any time under Account → Devices.</p>
          <div className="linkp__act">
            <Link to="/app/account" className="btn">
              Manage devices
            </Link>
            <Link to="/app" className="btn btn--primary">
              Open the terminal
            </Link>
          </div>
        </section>
      ) : session.status === "unknown" ? (
        <p className="mono t3" role="status">
          Checking your session…
        </p>
      ) : session.status !== "signed_in" ? (
        <section className="panel linkp__card">
          <MonitorSmartphone size={26} aria-hidden="true" className="c-brand" />
          <h2 className="serif">Sign in to approve this device</h2>
          <p className="t2">
            {fromUrl ? (
              <>
                Your extension is showing code <b className="mono">{fromUrl}</b>. Sign in, then approve it here.
              </>
            ) : (
              "Sign in first, then enter the code your extension shows."
            )}
          </p>
          {session.status === "suspended" ? (
            <p className="form-err">This account is suspended, so it can't link new devices.</p>
          ) : (
            <button type="button" className="btn btn--primary" onClick={() => openSignIn("Sign in to approve the Tudumm extension on this device.")}>
              Sign in to continue
            </button>
          )}
        </section>
      ) : (
        <section className="panel linkp__card">
          <ShieldCheck size={26} aria-hidden="true" className="c-brand" />
          <h2 className="serif">Approve Tudumm extension on this device?</h2>
          <p className="t2">
            Signed in as <b>{session.me?.user.email}</b>. Only approve if the code below matches the one in your extension, and you started this yourself.
          </p>
          <form className="linkp__form" onSubmit={approve} noValidate>
            <label className="field">
              <span>Code from the extension</span>
              <input
                className="input mono linkp__code"
                value={code}
                onChange={(e) => {
                  setCode(norm(e.target.value));
                  setErr(null);
                }}
                placeholder="ABCD-EF23"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={!!err}
              />
            </label>
            {err && (
              <p className="form-err" role="alert">
                {err}
              </p>
            )}
            <div className="linkp__act">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setParams({});
                  navigate("/app");
                }}
              >
                Don't approve
              </button>
              <button type="submit" className="btn btn--primary" disabled={!valid || state === "busy"}>
                {state === "busy" ? "Approving…" : "Approve extension"}
              </button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
