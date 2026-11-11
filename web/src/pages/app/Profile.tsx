import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Check, Copy, RotateCcw, X } from "lucide-react";
import { toast } from "../../components/ui";
import { useDocumentTitle } from "../../components/hooks";
import { MARKET_LABEL, MARKET_ORDER, getInstrument, instrumentsIn } from "../../engine/universe";
import type { MarketId } from "../../engine/types";
import {
  CURRENCIES,
  PERSONAS,
  resetDemo,
  toggleIn,
  trackingStore,
  updateProfile,
  useProfile,
  useStore,
  watchlistStore,
  type ProfileCurrency,
} from "../../engine/profile";
import { fmtMoney } from "../../engine/format";

export default function Profile() {
  useDocumentTitle("Profile · Tudumm");
  const profile = useProfile();
  const watch = useStore(watchlistStore);
  const tracked = useStore(trackingStore);
  const navigate = useNavigate();
  const [capital, setCapital] = useState(String(profile.capital));
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setCapital(String(profile.capital)), [profile.capital]);
  const cap = Number(capital.replace(/[^0-9.]/g, ""));
  const capOk = Number.isFinite(cap) && cap > 0;
  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:5180";

  const saved = (what: string) => toast(`${what} saved`);
  const toggleMarket = (m: MarketId) => {
    const next = profile.markets.includes(m) ? profile.markets.filter((x) => x !== m) : [...profile.markets, m];
    if (!next.length) {
      toast("Keep at least one market selected");
      return;
    }
    updateProfile({ markets: next });
    saved("Markets");
  };

  return (
    <div className="prof">
      <header className="phead">
        <div>
          <p className="eyebrow">Profile</p>
          <h1 className="phead__title serif">
            Your terminal, <em>your risk.</em>
          </h1>
        </div>
        <p className="phead__note">Saved in this browser only (localStorage). Nothing is sent anywhere.</p>
      </header>

      <div className="prof__grid">
        <section className="panel prof__sec">
          <header className="panel__head">
            <span className="eyebrow">Trading style</span>
          </header>
          <div className="panel__body">
            <div className="onb__personas prof__personas" role="radiogroup" aria-label="Trading style">
              {PERSONAS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={profile.persona === p.id}
                  className="onb__persona"
                  onClick={() => {
                    updateProfile({ persona: p.id });
                    saved("Style");
                  }}
                >
                  <span className="onb__persona-top">
                    <b>{p.label}</b>
                    {profile.persona === p.id && <Check size={15} aria-hidden="true" />}
                  </span>
                  <span>{p.blurb}</span>
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="panel prof__sec">
          <header className="panel__head">
            <span className="eyebrow">Markets</span>
            <span className="mono t3 prof__meta">default feed filter</span>
          </header>
          <div className="panel__body">
            <div className="onb__markets prof__markets">
              {MARKET_ORDER.map((m) => (
                <button key={m} type="button" className="fchip onb__mkt" aria-pressed={profile.markets.includes(m)} onClick={() => toggleMarket(m)}>
                  {profile.markets.includes(m) && <Check size={13} aria-hidden="true" />}
                  {MARKET_LABEL[m]} <span className="count">{instrumentsIn(m).length}</span>
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="panel prof__sec">
          <header className="panel__head">
            <span className="eyebrow">Capital & risk</span>
          </header>
          <div className="panel__body prof__risk">
            <label className="field">
              <span>Trading capital</span>
              <input
                className="input mono"
                inputMode="decimal"
                value={capital}
                onChange={(e) => setCapital(e.target.value)}
                onBlur={() => {
                  if (capOk && cap !== profile.capital) {
                    updateProfile({ capital: cap });
                    saved("Capital");
                  }
                }}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                aria-invalid={!capOk}
              />
            </label>
            <label className="field">
              <span>Currency</span>
              <select
                className="select"
                value={profile.currency}
                onChange={(e) => {
                  updateProfile({ currency: e.target.value as ProfileCurrency });
                  saved("Currency");
                }}
              >
                {CURRENCIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className="field prof__slider">
              <span>
                Risk per trade <b className="mono">{profile.riskPct.toFixed(2)}%</b>
              </span>
              <input type="range" min={0.25} max={3} step={0.25} value={profile.riskPct} onChange={(e) => updateProfile({ riskPct: Number(e.target.value) })} />
            </label>
            <p className="prof__preview">
              {capOk ? (
                <>
                  Each call risks <b className="mono">{fmtMoney((profile.capital * profile.riskPct) / 100, profile.currency)}</b> at its stop.
                </>
              ) : (
                <span className="c-short">Enter a capital amount above zero.</span>
              )}
            </p>
          </div>
        </section>

        <section className="panel prof__sec">
          <header className="panel__head">
            <span className="eyebrow">Watchlist & tracking</span>
          </header>
          <div className="panel__body prof__lists">
            <div>
              <p className="prof__sub">Watchlist</p>
              {watch.length === 0 ? (
                <p className="t3 prof__hint">Empty. Use the Watchlist button on any instrument page.</p>
              ) : (
                <ul className="prof__chips">
                  {watch.map((s) => (
                    <li key={s}>
                      <Link to={`/app/i/${s}`} className="mono">
                        {s}
                      </Link>
                      <button type="button" aria-label={`Remove ${s} from watchlist`} onClick={() => toggleIn(watchlistStore, s)}>
                        <X size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="prof__sub">Tracking (Your risk)</p>
              {tracked.length === 0 ? (
                <p className="t3 prof__hint">Nothing tracked. Press Track on a signal card.</p>
              ) : (
                <ul className="prof__chips">
                  {tracked.filter((s) => getInstrument(s)).map((s) => (
                    <li key={s}>
                      <Link to={`/app/i/${s}`} className="mono">
                        {s}
                      </Link>
                      <button type="button" aria-label={`Stop tracking ${s}`} onClick={() => toggleIn(trackingStore, s)}>
                        <X size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>

        <section className="panel prof__sec">
          <header className="panel__head">
            <span className="eyebrow">Chrome extension</span>
          </header>
          <div className="panel__body prof__ext">
            <p>
              The extension’s <b>Open terminal</b> button opens <code className="mono">{"{web URL}"}/app/i/{"{SYMBOL}"}</code>. Set the web URL in
              the extension’s Options page; it defaults to <code className="mono">http://localhost:5180</code>.
            </p>
            <div className="prof__origin">
              <span className="t3">This terminal is running at</span>
              <code className="mono">{origin}</code>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() =>
                  navigator.clipboard?.writeText(origin).then(
                    () => toast("Web URL copied"),
                    () => toast("Copy blocked by the browser"),
                  ) ?? toast("Copy isn’t available here")
                }
              >
                <Copy size={13} aria-hidden="true" /> Copy
              </button>
            </div>
            <p className="t3">
              Install steps are on the <Link className="u-link" to="/#extension">home page</Link>.
            </p>
          </div>
        </section>

        <section className="panel prof__sec prof__danger">
          <header className="panel__head">
            <span className="eyebrow">Reset this browser</span>
          </header>
          <div className="panel__body">
            <p className="t2">Clears your profile, watchlist and tracked signals from this browser and shows onboarding again.</p>
            {!confirm ? (
              <button type="button" className="btn btn--danger" onClick={() => setConfirm(true)}>
                <RotateCcw size={14} aria-hidden="true" /> Reset local data
              </button>
            ) : (
              <div className="prof__confirm">
                <span>Clear everything?</span>
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={() => {
                    resetDemo();
                    setConfirm(false);
                    navigate("/app");
                  }}
                >
                  Yes, clear it
                </button>
                <button type="button" className="btn" onClick={() => setConfirm(false)}>
                  Cancel
                </button>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
