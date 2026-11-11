import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from "react";
import { useLocation } from "react-router-dom";
import { AlertTriangle, ArrowLeft, Mail, X } from "lucide-react";
import { authApi } from "../api/endpoints";
import { ApiError, errorText } from "../api/client";
import { useConfig } from "../api/config";
import { closeSignIn, completeSignIn, openSignIn, useSession, useSignInSheet } from "../api/session";
import { track } from "../api/events";
import { Turnstile, type TurnstileHandle } from "./Turnstile";
import { LogoMark } from "./Logo";
import { toast } from "./ui";

const RESEND_SEC = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const GOOGLE_ERRORS: Record<string, string> = {
  google_unavailable: "Google sign-in isn't available right now.",
  state_mismatch: "Google sign-in expired. Try again.",
  account_suspended: "This account is suspended.",
  signups_closed: "New sign-ups are paused right now.",
};

/**
 * Sign-in sheet (email → 6-digit code). Rendered once at the app root; any component opens it
 * with openSignIn(reason). Every option shown is backed by a capability from GET /api/v1/config.
 */
export function SignInSheet() {
  const sheet = useSignInSheet();
  const location = useLocation();

  // Google callback errors come back as ?auth_error=<code>
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    const err = p.get("auth_error");
    if (!err) return;
    p.delete("auth_error");
    const q = p.toString();
    window.history.replaceState(null, "", `${location.pathname}${q ? `?${q}` : ""}${location.hash}`);
    openSignIn(GOOGLE_ERRORS[err] ?? "Sign-in didn't complete. Try again.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!sheet.open) return null;
  return <Sheet reason={sheet.reason} />;
}

function Sheet({ reason }: { reason: string | null }) {
  const cfg = useConfig();
  const session = useSession();
  const caps = cfg.caps;
  const siteKey = cfg.config?.turnstileSiteKey ?? null;
  const emailOk = caps.emailDelivery || caps.devCodes;
  const needsTs = caps.turnstile;
  const tsReady = !needsTs || !!siteKey;
  const location = useLocation();

  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [tsToken, setTsToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [digits, setDigits] = useState<string[]>(() => Array(6).fill(""));
  const [sentAt, setSentAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const tsRef = useRef<TurnstileHandle>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const codeRefs = useRef<(HTMLInputElement | null)[]>([]);
  const startedRef = useRef(false);

  useEffect(() => {
    if (!startedRef.current) {
      startedRef.current = true;
      track("signup_start", { reason: reason ? "prompted" : "direct" });
    }
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") closeSignIn();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [reason]);

  useEffect(() => {
    if (session.status === "signed_in") closeSignIn();
  }, [session.status]);

  useEffect(() => {
    if (step !== "code") return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [step]);

  useEffect(() => {
    if (step === "email") boxRef.current?.querySelector<HTMLInputElement>("input[type=email]")?.focus();
    else codeRefs.current[0]?.focus();
  }, [step]);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const em = email.trim().toLowerCase();
    if (!EMAIL_RE.test(em)) {
      setErr("Enter a valid email address.");
      return;
    }
    if (needsTs && !tsToken) {
      setErr("Complete the human check first.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await authApi.start(em, tsToken ?? undefined);
      setEmail(em);
      setDevCode(r.devMode && r.devCode ? r.devCode : null);
      setDigits(Array(6).fill(""));
      setSentAt(Date.now());
      setNow(Date.now());
      setStep("code");
    } catch (ex) {
      setErr(errorText(ex));
    } finally {
      setBusy(false);
      if (needsTs) {
        setTsToken(null);
        tsRef.current?.reset();
      }
    }
  };

  const verify = async (code: string) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await authApi.verify(email, code);
      const me = await completeSignIn(r.isNew);
      if (!me) throw new ApiError(500, "session_missing", "Signed in, but the session didn't stick. Allow cookies for this site and try again.");
      closeSignIn();
      toast(r.isNew ? `Welcome to Tudumm — signed in as ${me.user.email}` : `Signed in as ${me.user.email}`);
    } catch (ex) {
      setErr(errorText(ex));
      if (ex instanceof ApiError && (ex.code === "code_expired" || (ex.code === "invalid_code" && ex.data.attemptsLeft === 0))) {
        setDigits(Array(6).fill(""));
      }
      codeRefs.current[0]?.focus();
    } finally {
      setBusy(false);
    }
  };

  const setDigit = (i: number, v: string) => {
    const clean = v.replace(/\D/g, "");
    if (clean.length > 1) {
      fill(clean, i);
      return;
    }
    const next = digits.slice();
    next[i] = clean;
    setDigits(next);
    if (clean && i < 5) codeRefs.current[i + 1]?.focus();
    if (next.every((d) => d)) void verify(next.join(""));
  };
  const fill = (raw: string, from = 0) => {
    const chars = raw.replace(/\D/g, "").slice(0, 6 - from).split("");
    if (!chars.length) return;
    const next = digits.slice();
    chars.forEach((c, k) => (next[from + k] = c));
    setDigits(next);
    const last = Math.min(5, from + chars.length);
    codeRefs.current[last]?.focus();
    if (next.every((d) => d)) void verify(next.join(""));
  };
  const onPaste = (e: ClipboardEvent<HTMLInputElement>, i: number) => {
    e.preventDefault();
    fill(e.clipboardData.getData("text"), i);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>, i: number) => {
    if (e.key === "Backspace" && !digits[i] && i > 0) {
      codeRefs.current[i - 1]?.focus();
      const next = digits.slice();
      next[i - 1] = "";
      setDigits(next);
      e.preventDefault();
    }
    if (e.key === "ArrowLeft" && i > 0) codeRefs.current[i - 1]?.focus();
    if (e.key === "ArrowRight" && i < 5) codeRefs.current[i + 1]?.focus();
  };

  const resendIn = Math.max(0, Math.ceil(RESEND_SEC - (now - sentAt) / 1000));
  const nextPath = `${location.pathname}${location.search}`.startsWith("/app") ? `${location.pathname}${location.search}` : "/app";
  const apiDown = cfg.status === "unavailable";
  const nothing = !apiDown && cfg.status === "ready" && !emailOk && !caps.googleSignIn;

  return (
    <div className="modal sheet-wrap" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && closeSignIn()}>
      <div className="modal__box sheet" role="dialog" aria-modal="true" aria-labelledby="signin-title" ref={boxRef}>
        <header className="sheet__head">
          <LogoMark size={24} />
          <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label="Close sign-in" onClick={closeSignIn}>
            <X size={16} />
          </button>
        </header>

        {step === "email" ? (
          <>
            <div>
              <p className="eyebrow">Account</p>
              <h2 id="signin-title" className="sheet__title serif">
                Sign in to <em>Tudumm</em>
              </h2>
              <p className="sheet__lede">{reason ?? "Keep your watchlist, tracked calls, alerts and profile in sync across devices. No password: we send a 6-digit code."}</p>
            </div>

            {apiDown && (
              <p className="sheet__note sheet__note--warn" role="status">
                <AlertTriangle size={14} aria-hidden="true" /> Sign-in isn't available right now: the Tudumm API can't be reached. You can keep using the terminal as a guest.
              </p>
            )}
            {cfg.status === "loading" && <p className="sheet__note">Checking which sign-in options are available…</p>}
            {nothing && (
              <p className="sheet__note sheet__note--warn" role="status">
                <AlertTriangle size={14} aria-hidden="true" /> Sign-in is switched off while email delivery is being set up. Your watchlist and profile stay saved in this browser.
              </p>
            )}
            {caps.signups === false && cfg.status === "ready" && <p className="sheet__note">New sign-ups are paused right now; existing accounts can still sign in.</p>}

            {emailOk && (
              <form className="sheet__form" onSubmit={send} noValidate>
                {caps.devCodes && !caps.emailDelivery && (
                  <p className="uat-box" role="note">
                    <b>UAT MODE</b> — email delivery isn't configured, so your code will be shown on screen after you continue. Don't enter real financial details during UAT.
                  </p>
                )}
                <label className="field">
                  <span>Email</span>
                  <input
                    className="input"
                    type="email"
                    autoComplete="email"
                    inputMode="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    aria-invalid={!!err}
                    aria-describedby={err ? "signin-err" : undefined}
                    required
                  />
                </label>
                {needsTs && siteKey && <Turnstile ref={tsRef} siteKey={siteKey} onToken={setTsToken} />}
                {needsTs && !siteKey && <p className="form-err">The human check is required but isn't configured yet, so email sign-in is paused.</p>}
                {err && (
                  <p className="form-err" id="signin-err" role="alert">
                    {err}
                  </p>
                )}
                <button type="submit" className="btn btn--primary btn--lg sheet__cta" disabled={busy || !tsReady || (needsTs && !tsToken)}>
                  <Mail size={15} aria-hidden="true" />
                  {busy ? "Sending…" : "Email me a code"}
                </button>
              </form>
            )}

            {caps.googleSignIn && (
              <>
                {emailOk && <p className="sheet__or mono">or</p>}
                <a className="btn btn--lg sheet__google" href={authApi.googleStartUrl(nextPath)} onClick={() => track("signup_start", { method: "google" })}>
                  <GoogleG /> Continue with Google
                </a>
              </>
            )}

            <p className="sheet__fine">
              By continuing you agree to the <a href="/terms" target="_blank" rel="noreferrer" className="u-link">Terms</a>, the{" "}
              <a href="/risk" target="_blank" rel="noreferrer" className="u-link">Risk disclosure</a> and the{" "}
              <a href="/privacy" target="_blank" rel="noreferrer" className="u-link">Privacy notice</a>. Signals are probabilistic and not investment advice.
            </p>
          </>
        ) : (
          <>
            <div>
              <button type="button" className="btn btn--ghost btn--sm sheet__back" onClick={() => { setStep("email"); setErr(null); }}>
                <ArrowLeft size={14} aria-hidden="true" /> Change email
              </button>
              <h2 id="signin-title" className="sheet__title serif">
                Enter your <em>code</em>
              </h2>
              <p className="sheet__lede">
                {devCode ? "Your one-time code for " : "We sent a 6-digit code to "}
                <b className="mono">{email}</b>. It expires in 10 minutes.
              </p>
            </div>

            {devCode && (
              <div className="uat-box uat-box--code" role="note" aria-live="polite">
                <p>
                  <b>UAT MODE</b> — email delivery isn't configured; your code is <span className="uat-box__code mono">{devCode}</span>
                </p>
                <p className="uat-box__warn">Testing build: don't enter real financial details.</p>
                <button type="button" className="btn btn--sm" onClick={() => fill(devCode, 0)}>
                  Use this code
                </button>
              </div>
            )}

            <div className="otp" role="group" aria-label="6-digit code">
              {digits.map((d, i) => (
                <input
                  key={i}
                  ref={(el) => {
                    codeRefs.current[i] = el;
                  }}
                  className="otp__cell mono"
                  inputMode="numeric"
                  autoComplete={i === 0 ? "one-time-code" : "off"}
                  maxLength={6}
                  value={d}
                  aria-label={`Digit ${i + 1}`}
                  onChange={(e) => setDigit(i, e.target.value)}
                  onPaste={(e) => onPaste(e, i)}
                  onKeyDown={(e) => onKeyDown(e, i)}
                  disabled={busy}
                />
              ))}
            </div>
            {err && (
              <p className="form-err" role="alert">
                {err}
              </p>
            )}
            {busy && <p className="sheet__note">Checking…</p>}

            {needsTs && siteKey && resendIn === 0 && <Turnstile ref={tsRef} siteKey={siteKey} onToken={setTsToken} />}
            <div className="sheet__resend">
              {resendIn > 0 ? (
                <span className="mono t3">Resend in {resendIn}s</span>
              ) : (
                <button type="button" className="btn btn--ghost btn--sm" disabled={busy || (needsTs && !tsToken)} onClick={() => void send()}>
                  Resend code
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function GoogleG() {
  return (
    <svg width="15" height="15" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}
