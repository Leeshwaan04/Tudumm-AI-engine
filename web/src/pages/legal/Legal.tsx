import { useEffect, type ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { AlertTriangle, ArrowUpRight } from "lucide-react";
import { Wordmark } from "../../components/Logo";
import { LegalLinks } from "../../components/badges";
import { useDocumentTitle } from "../../components/hooks";
import { useLegal } from "../../api/config";
import { EVENT_NAMES } from "../../api/events";

export type LegalDoc = "terms" | "privacy" | "risk";

/** Fallback only until GET /api/v1/config answers (mirrors worker/src/lib/plans.ts LEGAL). */
const FALLBACK_VERSION = "2026-11-10";

const DOCS: Record<LegalDoc, { title: string; short: string; path: string; lede: string }> = {
  terms: {
    title: "Terms of use",
    short: "Terms",
    path: "/terms",
    lede: "The rules for using Tudumm while it is in beta: what the service is, what it isn't, and what we each agree to.",
  },
  privacy: {
    title: "Privacy notice",
    short: "Privacy",
    path: "/privacy",
    lede: "What Tudumm stores about you, why, for how long, who processes it, and how to export or delete it.",
  },
  risk: {
    title: "Risk disclosure",
    short: "Risk disclosure",
    path: "/risk",
    lede: "Read this before you act on anything Tudumm shows you. Trading involves risk of loss.",
  },
};

const DISCLAIMER = "Tudumm is in beta. Signals are probabilistic and not investment advice. Trading involves risk of loss.";

function fmtEffective(v: string): string {
  const d = new Date(`${v}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(d.getTime())) return v;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

interface Section {
  id: string;
  title: string;
  body: ReactNode;
}

export default function Legal({ doc }: { doc: LegalDoc }) {
  const meta = DOCS[doc];
  const legal = useLegal();
  const version = (doc === "terms" ? legal?.termsVersion : doc === "privacy" ? legal?.privacyVersion : legal?.riskVersion) ?? FALLBACK_VERSION;
  useDocumentTitle(`${meta.title} · Tudumm`);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [doc]);
  const sections = doc === "terms" ? termsSections() : doc === "privacy" ? privacySections() : riskSections();

  return (
    <div className="legal">
      <header className="legal__bar">
        <Link to="/" className="legal__brand" aria-label="Tudumm home">
          <Wordmark height={24} />
        </Link>
        <nav className="legal__tabs" aria-label="Legal documents">
          {(Object.keys(DOCS) as LegalDoc[]).map((k) => (
            <NavLink key={k} to={DOCS[k].path} className="legal__tab">
              {DOCS[k].short}
            </NavLink>
          ))}
        </nav>
        <Link to="/app" className="btn btn--sm legal__open">
          Open terminal <ArrowUpRight size={13} aria-hidden="true" />
        </Link>
      </header>

      <main className="legal__main" id="main">
        <div className="legal__head">
          <p className="eyebrow">Legal · {meta.short}</p>
          <h1 className="legal__title serif">{meta.title}</h1>
          <p className="legal__lede">{meta.lede}</p>
          <p className="legal__ver mono">
            Version {version} · effective {fmtEffective(version)}
          </p>
          <div className="legal__draft" role="note">
            <AlertTriangle size={15} aria-hidden="true" />
            <p>
              <b>Draft — pending legal review.</b> This is prototype text written in plain language for the beta. It will be replaced by a reviewed
              version before Tudumm launches commercially; the version and date above will change when it is.
            </p>
          </div>
        </div>

        <div className="legal__layout">
          <nav className="legal__toc" aria-label="On this page">
            <p className="eyebrow">On this page</p>
            <ol>
              {sections.map((s, i) => (
                <li key={s.id}>
                  <a href={`#${s.id}`}>
                    <span className="mono">{String(i + 1).padStart(2, "0")}</span> {s.title}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
          <article className="legal__doc">
            {sections.map((s, i) => (
              <section key={s.id} id={s.id} className="legal__sec">
                <h2 className="serif">
                  <span className="legal__num mono">{String(i + 1).padStart(2, "0")}</span>
                  {s.title}
                </h2>
                {s.body}
              </section>
            ))}
          </article>
        </div>
      </main>

      <footer className="legal__foot">
        <nav className="legal__foot-links" aria-label="Footer">
          <LegalLinks />
          <Link to="/">Home</Link>
        </nav>
        <p className="disclaimer">{DISCLAIMER}</p>
      </footer>
    </div>
  );
}

const SupportLink = ({ children = "Support" }: { children?: ReactNode }) => (
  <Link className="u-link" to="/app/support">
    {children}
  </Link>
);

/* ---------------- terms ---------------- */
function termsSections(): Section[] {
  return [
    {
      id: "service",
      title: "A beta service",
      body: (
        <>
          <p>
            Tudumm is a market-analysis tool in public beta. It reads price and structure, order flow, derivatives, fundamentals and context for a
            small set of instruments and turns them into trade setups (direction, entry zone, stop, two targets, a confidence score and the
            condition that cancels the call), or tells you it is sitting out.
          </p>
          <p>
            Because it is a beta, features change, break or disappear without notice, data can be late or missing, and the service can be paused.
            There is no uptime commitment.
          </p>
        </>
      ),
    },
    {
      id: "eligibility",
      title: "Who can use Tudumm",
      body: (
        <ul>
          <li>You must be at least 18 and able to enter a binding agreement where you live.</li>
          <li>You are responsible for checking that using a tool like this is lawful for you in your country.</li>
          <li>You use Tudumm for your own research. You may not resell it or present its output as your own advisory service.</li>
        </ul>
      ),
    },
    {
      id: "accounts",
      title: "Accounts and sign-in",
      body: (
        <>
          <p>
            You can browse without an account; your settings then stay in your browser. If you sign in, you do so with a one-time code sent to
            your email (or Google, when enabled). Keep access to that inbox secure: anyone who can read it can sign in as you.
          </p>
          <ul>
            <li>One person per account. Give us an email address you control.</li>
            <li>You can see and revoke your signed-in devices, export your data and delete your account at any time from Account.</li>
            <li>We may suspend an account that breaks these terms, abuses the service or puts other users at risk, and we'll tell you why when we can.</li>
          </ul>
        </>
      ),
    },
    {
      id: "acceptable-use",
      title: "Acceptable use",
      body: (
        <ul>
          <li>No scraping, bulk downloading or automated access beyond what the product itself offers.</li>
          <li>No attempts to break, probe or overload the service, bypass rate limits or human checks, or access other people's data.</li>
          <li>No reverse-engineering of the service to rebuild it, and no use of it to build a competing data product.</li>
          <li>No harassment of our team or other users through support or any other channel.</li>
        </ul>
      ),
    },
    {
      id: "no-advice",
      title: "Not investment advice",
      body: (
        <>
          <p>
            Tudumm publishes probabilistic, rule-based analysis. It is not personalised investment advice, a research recommendation, or an offer
            to buy or sell anything. Tudumm is not registered with SEBI or any other financial regulator.
          </p>
          <p>
            You decide whether to trade, and you carry the full result of that decision. Read the{" "}
            <Link className="u-link" to="/risk">
              risk disclosure
            </Link>{" "}
            before you act on anything you see here.
          </p>
        </>
      ),
    },
    {
      id: "data",
      title: "Market data and licences",
      body: (
        <>
          <p>
            Market data comes from: a broker market-data feed (India, real-time), Binance public market data (crypto, real-time), Cboe
            delayed quotes (US, 15-minute delayed), NSE archive files (India history and option data, end of day), ECB reference rates via
            Frankfurter (FX, daily), SEC EDGAR (US fundamentals) and alternative.me (crypto sentiment). Each price shows how fresh it is.
          </p>
          <p>
            Several of these sources restrict commercial use. During the beta Tudumm is offered for evaluation, and we are pursuing proper licences
            before any paid launch. Data is provided as-is; it can be delayed, wrong or missing, and you must not redistribute it. Tudumm never
            fills gaps with made-up numbers: when a source is down, the app says so.
          </p>
        </>
      ),
    },
    {
      id: "plans",
      title: "Plans and payments",
      body: (
        <p>
          Billing is not live yet; everyone is on the free plan unless we grant early access to a paid plan. If paid plans open, prices, what each
          plan includes and how to cancel will be shown before you pay, and these terms will be updated first.
        </p>
      ),
    },
    {
      id: "liability",
      title: "Limitation of liability",
      body: (
        <>
          <p>
            Tudumm is provided "as is" and "as available". To the fullest extent the law allows, we are not liable for trading losses, lost profits,
            or any indirect or consequential loss arising from your use of the service, its signals or its data, including errors, delays and
            outages.
          </p>
          <p>
            Nothing in these terms limits liability that cannot be limited by law, or your statutory rights as a consumer.
          </p>
        </>
      ),
    },
    {
      id: "changes",
      title: "Changes to these terms",
      body: (
        <p>
          We will update these terms as the product and its legal review progress. Each version has a date. When a change matters, signed-in users
          are asked to accept the new version before continuing; you can stop using Tudumm and delete your account at any time.
        </p>
      ),
    },
    {
      id: "contact",
      title: "Contact",
      body: (
        <p>
          Questions, complaints or grievances: open a ticket from <SupportLink />. You don't need an account to do so.
        </p>
      ),
    },
  ];
}

/* ---------------- privacy ---------------- */
function privacySections(): Section[] {
  return [
    {
      id: "summary",
      title: "In short",
      body: (
        <ul>
          <li>We store the minimum needed to run your account: your email, your settings and lists, your alerts and your support tickets.</li>
          <li>We record first-party product analytics (named events, no third-party trackers) so we can see which features work. You can switch it off.</li>
          <li>We don't sell your data, show ads, or store your IP address.</li>
          <li>You can download everything we hold about you, or delete your account, from Account.</li>
        </ul>
      ),
    },
    {
      id: "data-stored",
      title: "What we store",
      body: (
        <>
          <p>If you use Tudumm without signing in, your profile, watchlist and tracked list stay in your browser's localStorage and never reach us.</p>
          <p>If you sign in, we store:</p>
          <ul>
            <li>
              <b>Account:</b> email address, whether it was verified, optional display name, plan, country (derived from the network edge, not your
              IP), marketing preference, and sign-up and last-seen times.
            </li>
            <li>
              <b>Settings and lists:</b> your profile (trading style, markets, capital, currency, risk per trade), watchlist and tracked signals.
            </li>
            <li>
              <b>Alerts and notifications:</b> the price and signal alerts you set and the notifications they generated.
            </li>
            <li>
              <b>Consents:</b> which version of the terms, risk disclosure and privacy notice you accepted, when, and any withdrawal.
            </li>
            <li>
              <b>Support tickets:</b> what you wrote to us and our replies.
            </li>
            <li>
              <b>Sessions:</b> your signed-in devices (browser user agent, created and last-used times). Session tokens are stored only as keyed
              hashes.
            </li>
            <li>
              <b>Product events:</b> described below.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "analytics",
      title: "Product analytics",
      body: (
        <>
          <p>
            Tudumm records its own first-party events, sent to our own server. Each event has a name, a few short properties (for example the
            instrument symbol you opened), the page path without query string, and a time. Only these event names are accepted; anything else is
            dropped:
          </p>
          <ul className="legal__events mono">
            {EVENT_NAMES.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <ul>
            <li>
              A random anonymous id is kept in your browser's localStorage so events from one browser can be grouped. When you're signed in,
              events are also linked to your account.
            </li>
            <li>
              <b>No IP address is stored.</b> We keep only a country and a device class (desktop, mobile or tablet). Values that look like an
              email or phone number are discarded.
            </li>
            <li>
              To opt out, turn off <b>Allow product analytics</b> in{" "}
              <Link className="u-link" to="/app/account">
                Account
              </Link>{" "}
              (it works without an account too). When it's off,
              this browser sends no events at all.
            </li>
          </ul>
          <p>
            We also use Cloudflare Web Analytics for aggregate page-load statistics. It is cookieless and doesn't track you across sites.
          </p>
        </>
      ),
    },
    {
      id: "sessions",
      title: "Sessions and cookies",
      body: (
        <ul>
          <li>
            Signing in sets one essential, HttpOnly cookie that keeps you signed in for 30 days, extended while you use Tudumm. It isn't readable by
            scripts and isn't used for advertising.
          </li>
          <li>
            The browser extension, when linked, uses a separate token valid for 180 days (also extended with use). It appears under linked devices in
            Account, where you can revoke it.
          </li>
          <li>Signing in with Google, when enabled, uses a short-lived cookie for the sign-in handshake only.</li>
          <li>Your browser's localStorage holds your guest settings, your data-mode choice and the anonymous analytics id.</li>
        </ul>
      ),
    },
    {
      id: "retention",
      title: "How long we keep it",
      body: (
        <ul>
          <li>One-time sign-in codes: deleted within 24 hours.</li>
          <li>Account data: kept while your account is open, and deleted when you delete your account (see below).</li>
          <li>Expired or revoked sessions stop working immediately and are removed over time.</li>
          <li>
            Product events: during the beta there's no automatic deletion schedule yet. We'll publish one before launch. Deleting your account
            de-links your events from you.
          </li>
          <li>Support tickets: kept as grievance-handling records, de-linked from you if you delete your account.</li>
        </ul>
      ),
    },
    {
      id: "export-delete",
      title: "Export and delete",
      body: (
        <ul>
          <li>
            <b>Download my data</b> in Account gives you a JSON file with every row we hold about your account (up to five downloads a day).
          </li>
          <li>
            <b>Delete account</b> in Account erases your email, profile, watchlist, tracked list, alerts, notifications and sessions straight away.
            Activity events and support tickets are kept for aggregate statistics and grievance records but are de-linked from you, and your email
            is removed from them.
          </li>
        </ul>
      ),
    },
    {
      id: "processors",
      title: "Who processes it",
      body: (
        <ul>
          <li>
            <b>Cloudflare</b>: hosting, the D1 database that stores the data above, Turnstile human checks (when enabled) and Cloudflare Web
            Analytics (cookieless).
          </li>
          <li>
            <b>Resend</b>: sends sign-in codes and alert emails, only when email delivery is enabled. Until then, codes and notifications stay in the
            app.
          </li>
          <li>
            <b>Google</b>: only if you choose "Sign in with Google" when that option is enabled.
          </li>
          <li>Market data providers never receive your personal data; Tudumm fetches public data on its own.</li>
        </ul>
      ),
    },
    {
      id: "rights",
      title: "Your rights (DPDP Act and GDPR)",
      body: (
        <>
          <p>
            Under India's Digital Personal Data Protection Act, 2023 and, where it applies, the EU/UK GDPR, you can ask to access, correct or erase
            your personal data, withdraw consent (as easily as you gave it), nominate someone to exercise your rights, and raise a grievance.
          </p>
          <ul>
            <li>Access and portability: Account → Download my data.</li>
            <li>Correction: edit your profile and display name in the app, or ask us via Support.</li>
            <li>Erasure: Account → Delete account.</li>
            <li>Withdrawing consent: Account → Consents, and the analytics and marketing switches.</li>
            <li>
              Grievances and anything else: open a ticket in <SupportLink /> with the category "Grievance". If you're unhappy with our answer, you can
              complain to the Data Protection Board of India or your local data-protection authority.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "contact",
      title: "Contact",
      body: (
        <p>
          Privacy questions and requests: <SupportLink />. We'll tell you if we need to verify that a request comes from the account holder.
        </p>
      ),
    },
  ];
}

/* ---------------- risk ---------------- */
function riskSections(): Section[] {
  return [
    {
      id: "probabilistic",
      title: "Signals are probabilities, not promises",
      body: (
        <>
          <p>
            Every Tudumm call can lose. A setup with a stop, two targets and a confidence score describes a possible trade with defined risk; it
            doesn't predict what the market will do. Losing streaks happen even when a method has an edge.
          </p>
          <p>Probability, not promise. Never risk money you can't afford to lose.</p>
        </>
      ),
    },
    {
      id: "engine",
      title: "Engine v0 is rule-based and uncalibrated",
      body: (
        <ul>
          <li>Live calls come from engine v0: transparent rules on trend, momentum, order book, options and sentiment, applied to free public data.</li>
          <li>
            Its confidence number is a heuristic score, not a measured probability. It hasn't yet been calibrated against enough closed outcomes, so
            read it as a ranking within Tudumm, not as a chance of winning.
          </li>
          <li>Sitting out is a deliberate outcome. A missing call is not a hidden one.</li>
        </ul>
      ),
    },
    {
      id: "data",
      title: "Data can be delayed, end-of-day or missing",
      body: (
        <>
          <p>Each price carries a freshness badge. In live beta:</p>
          <ul>
            <li>
              <b>Crypto</b>: real-time from Binance public data.
            </li>
            <li>
              <b>US</b>: 15-minute delayed quotes (Cboe) and daily history.
            </li>
            <li>
              <b>India</b>: end of day, from NSE archive files published after the close. Nothing intraday.
            </li>
            <li>
              <b>FX</b>: daily ECB reference rates (one fixing a day, no intraday high or low).
            </li>
          </ul>
          <p>
            Sources fail, publish late or change format. When a layer has no data Tudumm shows "not available" with the reason. Always check a live
            price with your broker before you place an order.
          </p>
        </>
      ),
    },
    {
      id: "proxies",
      title: "Some instruments are proxies",
      body: (
        <ul>
          <li>
            <b>Gold (XAUUSD)</b> is tracked through PAXG, a gold-backed token on Binance. It can trade at a premium or discount to spot gold.
          </li>
          <li>
            <b>WTI crude (CL)</b> is tracked through the USO ETF, which holds futures and can drift from the spot or front-month price.
          </li>
          <li>
            <b>ASML</b> uses its NASDAQ listing (ADR, USD), not the Euronext Amsterdam shares.
          </li>
        </ul>
      ),
    },
    {
      id: "no-advice",
      title: "Not investment advice, and not registered",
      body: (
        <>
          <p>
            Tudumm is not registered with the Securities and Exchange Board of India (SEBI) as an investment adviser or research analyst, nor with
            any other financial regulator anywhere. Nothing on Tudumm is personalised advice or a recommendation to buy or sell.
          </p>
          <p>Talk to a registered adviser if you need advice for your situation.</p>
        </>
      ),
    },
    {
      id: "loss",
      title: "You can lose money",
      body: (
        <ul>
          <li>Trading involves risk of loss, and leveraged products (futures, options, margin, perpetual swaps) can lose more than your stake.</li>
          <li>Stops are not guaranteed: gaps, slippage and fast markets can fill you far beyond a stop.</li>
          <li>The position sizer is arithmetic on your inputs. It doesn't know your broker's margin, lot sizes, fees or taxes.</li>
          <li>Crypto markets run 24/7 and can move sharply while you're away.</li>
        </ul>
      ),
    },
    {
      id: "past",
      title: "Past results don't predict future results",
      body: (
        <p>
          The public ledger records every live call and its outcome, hash-chained so it can't be quietly edited. A record of past calls, especially
          a short one, says little about future performance. With fewer than 30 closed calls it's too early to judge anything.
        </p>
      ),
    },
    {
      id: "contact",
      title: "Questions",
      body: (
        <p>
          If anything here is unclear, ask us in <SupportLink />.
        </p>
      ),
    },
  ];
}
