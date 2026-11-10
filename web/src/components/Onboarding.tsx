import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { MARKET_LABEL, MARKET_ORDER, instrumentsIn } from "../engine/seed";
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

  useEffect(() => {
    boxRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [step]);

  const cap = Number(capital.replace(/[^0-9.]/g, ""));
  const capOk = Number.isFinite(cap) && cap > 0;
  const canNext = step === 0 ? true : step === 1 ? mkts.length > 0 : capOk && risk > 0;

  const finish = () => {
    updateProfile({ persona, markets: mkts, capital: capOk ? cap : profile.capital, currency, riskPct: risk, onboarded: true });
    onDone();
  };
  const skip = () => {
    updateProfile({ onboarded: true });
    onDone();
  };

  const toggleMarket = (m: MarketId) => setMkts((l) => (l.includes(m) ? l.filter((x) => x !== m) : [...l, m]));

  return (
    <div className="modal" role="presentation">
      <div className="modal__box onb" role="dialog" aria-modal="true" aria-labelledby="onb-title" ref={boxRef}>
        <header className="onb__head">
          <LogoMark size={26} />
          <div className="onb__progress mono" aria-label={`Step ${step + 1} of 3`}>
            {[0, 1, 2].map((i) => (
              <span key={i} className={i <= step ? "is-on" : ""} />
            ))}
            <b>{step + 1} / 3</b>
          </div>
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
            <p className="onb__lede">Used by the position sizer and the “Your risk” panel. Stored only in this browser.</p>
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

        <footer className="onb__foot">
          <button type="button" className="btn btn--ghost btn--sm" onClick={skip}>
            Skip, use defaults
          </button>
          <div className="onb__nav">
            {step > 0 && (
              <button type="button" className="btn" onClick={() => setStep((s) => s - 1)}>
                Back
              </button>
            )}
            {step < 2 ? (
              <button type="button" className="btn btn--primary" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>
                Next
              </button>
            ) : (
              <button type="button" className="btn btn--primary" disabled={!canNext} onClick={finish}>
                Open my feed
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
