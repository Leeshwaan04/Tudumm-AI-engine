import { useEffect, useRef, useState } from "react";
import { Check, ExternalLink } from "lucide-react";
import { useConfig } from "../api/config";
import { consentApi } from "../api/endpoints";
import { errorText } from "../api/client";
import { patchMe, useSession } from "../api/session";
import { track } from "../api/events";
import type { Consent } from "../api/types";
import { MARKET_LABEL, MARKET_ORDER, instrumentsIn } from "../engine/universe";
import type { MarketId } from "../engine/types";
import { CURRENCIES, PERSONAS, updateProfile, useProfile, type Persona, type ProfileCurrency } from "../engine/profile";
import { fmtMoney } from "../engine/format";
import { LogoMark } from "./Logo";

export function Onboarding({ initialStep = 0, onDone }: { initialStep?: number; onDone: () => void }) {
  const profile = useProfile();
  const [step, setStep] = useState(initialStep);
  const [persona, setPersona] = useState<Persona>(profile.persona);
  const [mkts, setMkts] = useState<MarketId[]>(profile.markets);
  const [capital, setCapital] = useState(String(profile.capital));
  const [currency, setCurrency] = useState<ProfileCurrency>(profile.currency);
  const [risk, setRisk] = useState(profile.riskPct);
  const boxRef = useRef<HTMLDivElement>(null);
  const session = useSession();
  const legal = useConfig().config?.legal ?? null;
  const signedIn = session.status === "signed_in";
  const consentOnly = initialStep === 3 && profile.onboarded;
  const [agree, setAgree] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [consentErr, setConsentErr] = useState<string | null>(null);

  useEffect(() => {
    boxRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    track("onboarding_step", { step, consentOnly });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const cap = Number(capital.replace(/[^0-9.]/g, ""));
  const capOk = Number.isFinite(cap) && cap > 0;
  const docs = consentDocs(legal, session.me?.pendingConsents ?? null);
  const allAgreed = docs.every((d) => agree[d.kind]);
  const canNext = step === 0 ? true : step === 1 ? mkts.length > 0 : step === 2 ? capOk && risk > 0 : allAgreed && !saving;

  const saveProfile = (skipped: boolean) => {
    if (consentOnly) return;
    if (skipped) updateProfile({ onboarded: true });
    else updateProfile({ persona, markets: mkts, capital: capOk ? cap : profile.capital, currency, riskPct: risk, onboarded: true });
  };
  const finish = async () => {
    if (signedIn) {
      setSaving(true);
      setConsentErr(null);
      try {
        let last: { consents: Consent[]; pendingConsents: { kind: string; version: string }[] } | null = null;
        for (const d of docs) last = await consentApi.accept(d.kind, d.version);
        if (last) patchMe({ consents: last.consents, pendingConsents: last.pendingConsents });
      } catch (e) {
        setConsentErr(errorText(e));
        setSaving(false);
        return;
      }
      setSaving(false);
    }
    saveProfile(false);
    track("onboarding_complete", { skipped: false, signedIn, consentOnly });
    onDone();
  };
  const skip = () => {
    // Signed-in users must record the legal consents; skipping only skips the profile questions.
    if (signedIn) {
      setStep(3);
      return;
    }
    saveProfile(true);
    track("onboarding_complete", { skipped: true, signedIn });
    onDone();
  };
  const last = 3;

  const toggleMarket = (m: MarketId) => setMkts((l) => (l.includes(m) ? l.filter((x) => x !== m) : [...l, m]));

  return (
    <div className="modal" role="presentation">
      <div className="modal__box onb" role="dialog" aria-modal="true" aria-labelledby="onb-title" ref={boxRef}>
        <header className="onb__head">
          <LogoMark size={26} />
          {consentOnly ? (
            <span className="eyebrow">Updated terms</span>
          ) : (
            <div className="onb__progress mono" aria-label={`Step ${step + 1} of 4`}>
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className={i <= step ? "is-on" : ""} />
              ))}
              <b>{step + 1} / 4</b>
            </div>
          )}
        </header>

        {step === 0 && (
          <section>
            <p className="eyebrow">Set up your terminal</p>
            <h2 id="onb-title" className="onb__title serif">
              How do you <em>trade</em>?
            </h2>
            <p className="onb__lede">This sets your default feed filters and which evidence Tudumm leads with. Change it any time.</p>
            <div className="onb__personas" role="radiogroup" aria-label="Trading style">
              {PERSONAS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={persona === p.id}
                  className="onb__persona"
                  onClick={() => setPersona(p.id)}
                  data-autofocus={persona === p.id ? "" : undefined}
                >
                  <span className="onb__persona-top">
                    <b>{p.label}</b>
                    {persona === p.id && <Check size={15} aria-hidden="true" />}
                  </span>
                  <span>{p.blurb}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {step === 1 && (
          <section>
            <p className="eyebrow">Markets</p>
            <h2 id="onb-title" className="onb__title serif">
              Which markets do you <em>watch</em>?
            </h2>
            <p className="onb__lede">Your feed starts filtered to these. Pick at least one.</p>
            <div className="onb__markets">
              {MARKET_ORDER.map((m, i) => (
                <button
                  key={m}
                  type="button"
                  className="fchip onb__mkt"
                  aria-pressed={mkts.includes(m)}
                  onClick={() => toggleMarket(m)}
                  data-autofocus={i === 0 ? "" : undefined}
                >
                  {mkts.includes(m) && <Check size={13} aria-hidden="true" />}
                  {MARKET_LABEL[m]} <span className="count">{instrumentsIn(m).length}</span>
                </button>
              ))}
            </div>
            <div className="onb__inline">
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setMkts([...MARKET_ORDER])}>
                Select all
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setMkts([])}>
                Clear
              </button>
            </div>
            {mkts.length === 0 && <p className="onb__warn">Select at least one market to continue.</p>}
          </section>
        )}

        {step === 2 && (
          <section>
            <p className="eyebrow">Risk</p>
            <h2 id="onb-title" className="onb__title serif">
              How much do you <em>risk</em> per trade?
            </h2>
            <p className="onb__lede">Used by the position sizer and the “Your risk” panel. {signedIn ? "Saved to your account." : "Stored only in this browser until you sign in."}</p>
            <div className="onb__grid">
              <label className="field">
                <span>Trading capital</span>
                <input
                  className="input mono"
                  inputMode="decimal"
                  value={capital}
                  onChange={(e) => setCapital(e.target.value)}
                  aria-invalid={!capOk}
                  data-autofocus=""
                />
              </label>
              <label className="field">
                <span>Currency</span>
                <select className="select" value={currency} onChange={(e) => setCurrency(e.target.value as ProfileCurrency)}>
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field onb__risk">
                <span>
                  Risk per trade <b className="mono">{risk.toFixed(2)}%</b>
                </span>
                <input type="range" min={0.25} max={3} step={0.25} value={risk} onChange={(e) => setRisk(Number(e.target.value))} />
              </label>
            </div>
            <p className="onb__preview">
              {capOk ? (
                <>
                  Each call risks <b className="mono">{fmtMoney((cap * risk) / 100, currency)}</b> if its stop is hit.
                  {risk > 2 && <span className="c-short"> Above 2% per trade, a normal losing streak cuts deep.</span>}
                </>
              ) : (
                <span className="c-short">Enter a capital amount above zero.</span>
              )}
            </p>
          </section>
        )}

        {step === 3 && (
          <section>
            <p className="eyebrow">{consentOnly ? "Please review" : "Before you start"}</p>
            <h2 id="onb-title" className="onb__title serif">
              Probability, <em>not promise</em>.
            </h2>
            <p className="onb__lede">
              Tudumm is in beta. Live calls come from engine v0, a rule-based engine that isn't calibrated yet, on free data that can be delayed or end-of-day. Nothing here is investment advice.
              {signedIn ? " Your acceptance is recorded with your account." : " Signing in records your acceptance with your account."}
            </p>
            <div className="consents" role="group" aria-label="Legal documents">
              {docs.map((d, i) => (
                <label key={d.kind} className="consent">
                  <input
                    type="checkbox"
                    checked={!!agree[d.kind]}
                    onChange={(e) => setAgree((a) => ({ ...a, [d.kind]: e.target.checked }))}
                    data-autofocus={i === 0 ? "" : undefined}
                  />
                  <span className="consent__txt">
                    I've read and accept the{" "}
                    <a href={d.href} target="_blank" rel="noreferrer" className="u-link">
                      {d.label} <ExternalLink size={11} aria-hidden="true" />
                    </a>
                    <span className="consent__ver mono">version {d.version}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="onb__fine">Drafts pending legal review. You can view or withdraw consents any time in Account.</p>
            {consentErr && (
              <p className="form-err" role="alert">
                {consentErr}
              </p>
            )}
          </section>
        )}

        <footer className="onb__foot">
          {step < last && !consentOnly ? (
            <button type="button" className="btn btn--ghost btn--sm" onClick={skip}>
              {signedIn ? "Skip profile questions" : "Skip, use defaults"}
            </button>
          ) : (
            <span />
          )}
          <div className="onb__nav">
            {step > 0 && !consentOnly && (
              <button type="button" className="btn" onClick={() => setStep((s) => s - 1)}>
                Back
              </button>
            )}
            {step < last ? (
              <button type="button" className="btn btn--primary" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>
                Next
              </button>
            ) : (
              <button type="button" className="btn btn--primary" disabled={!canNext} onClick={() => void finish()}>
                {saving ? "Saving…" : consentOnly ? "Accept and continue" : "Agree and open my feed"}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

const DOC_META: { kind: "terms" | "risk_disclosure" | "privacy"; label: string; href: string; key: "termsVersion" | "riskVersion" | "privacyVersion" }[] = [
  { kind: "terms", label: "Terms of use", href: "/terms", key: "termsVersion" },
  { kind: "risk_disclosure", label: "Risk disclosure", href: "/risk", key: "riskVersion" },
  { kind: "privacy", label: "Privacy notice", href: "/privacy", key: "privacyVersion" },
];

/** The three required documents with their current versions (pending versions win when signed in). */
function consentDocs(
  legal: { termsVersion: string; riskVersion: string; privacyVersion: string } | null,
  pending: { kind: string; version: string }[] | null,
) {
  const docs = DOC_META.map((d) => ({ ...d, version: pending?.find((p) => p.kind === d.kind)?.version ?? legal?.[d.key] ?? "draft" }));
  // When signed in and some are already accepted, only ask for the outstanding ones.
  if (pending && pending.length) {
    const due = docs.filter((d) => pending.some((p) => p.kind === d.kind));
    if (due.length) return due;
  }
  return docs;
}
