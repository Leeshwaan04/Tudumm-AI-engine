import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { qs } from "../api";
import { ChartFrame, ColumnChart, fillDays, HBars, Meter, PLAN_COLORS, RetentionGrid, SegmentedBar } from "../charts";
import { dayLabel, int, pct } from "../format";
import { useApi } from "../hooks";
import { useAdmin } from "../session";
import { Async, PageHead, Pill, Refreshed, Section } from "../ui";
import type { Capabilities, Overview as OverviewData } from "../types";

const WINDOWS = [7, 30, 90] as const;

const FUNNEL_LABEL: Record<string, string> = {
  signup_start: "Started sign-up",
  login: "Signed in",
  onboarding_complete: "Finished onboarding",
  first_track: "Tracked a signal",
};

export default function Overview() {
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(30);
  const q = useApi<OverviewData>(`/api/admin/overview${qs({ days })}`);
  const { me } = useAdmin();

  return (
    <>
      <PageHead
        eyebrow="Overview"
        title={
          <>
            How the desk is <em>doing</em>
          </>
        }
        actions={<Refreshed fetchedAt={q.fetchedAt} refreshing={q.refreshing} onRefresh={q.reload} />}
      >
        <div className="adm-filters" role="group" aria-label="Time window">
          <span className="eyebrow">Window</span>
          <div className="seg">
            {WINDOWS.map((d) => (
              <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}>
                {d}d
              </button>
            ))}
          </div>
        </div>
      </PageHead>

      <CapabilityStrip caps={me.capabilities} />

      <Async q={q} label="Computing aggregates">
        {(d) => <OverviewBody d={d} />}
      </Async>
    </>
  );
}

function CapabilityStrip({ caps }: { caps: Capabilities }) {
  const items: { label: string; on: boolean; off: string }[] = [
    { label: "Email delivery", on: caps.emailDelivery, off: caps.devCodes ? "off · dev codes on" : "off" },
    { label: "Payments", on: caps.payments, off: "off · plans by admin grant" },
    { label: "Google sign-in", on: caps.googleSignIn, off: "off" },
    { label: "Turnstile", on: caps.turnstile, off: "off" },
    { label: "Live data", on: caps.liveData, off: "flag off" },
    { label: "Extension linking", on: caps.extensionLinking, off: "flag off" },
  ];
  if (caps.signups !== undefined) items.push({ label: "Sign-ups", on: caps.signups, off: "flag off" });
  return (
    <ul className="adm-caps" aria-label="System capabilities">
      {items.map((i) => (
        <li key={i.label} className={i.on ? "is-on" : "is-off"}>
          <i aria-hidden="true" />
          <span>{i.label}</span>
          <span className="mono">{i.on ? "on" : i.off}</span>
        </li>
      ))}
    </ul>
  );
}

function OverviewBody({ d }: { d: OverviewData }) {
  const k = d.kpis;
  const cols = useMemo(() => fillDays(k.newUsersPerDay, d.days), [k.newUsersPerDay, d.days]);
  const last7 = cols.slice(-7).reduce((s, c) => s + c.value, 0);
  const stickiness = k.mau.users ? k.dau.users / k.mau.users : null;
  const funnelTop = Math.max(1, d.funnel[0]?.actors ?? 0);
  const paid = (k.planMix.pro ?? 0) + (k.planMix.elite ?? 0);

  return (
    <div className="adm-ov">
      <div className="adm-kpis" aria-label="Key figures">
        <Kpi label="Users" value={int(k.totalUsers)} sub="all time, excl. deleted" />
        <Kpi label={`New users · ${d.days}d`} value={int(k.newUsers)} sub={d.days > 7 ? `${int(last7)} in the last 7 days` : "this window"} />
        <Kpi label="DAU" value={int(k.dau.users)} sub={`+ ${int(k.dau.guests)} guests`} />
        <Kpi label="WAU" value={int(k.wau.users)} sub={`+ ${int(k.wau.guests)} guests`} />
        <Kpi label="MAU" value={int(k.mau.users)} sub={`+ ${int(k.mau.guests)} guests${stickiness !== null ? ` · DAU/MAU ${pct(stickiness, 0)}` : ""}`} />
        <Kpi label="Onboarding completion" value={pct(k.onboardingCompletionRate)} meter={k.onboardingCompletionRate} sub="profiles marked onboarded" />
        <Kpi label="Free → paid" value={pct(k.paidShare)} meter={k.paidShare} sub={`${int(paid)} on Pro or Elite`} />
        <Kpi label="Extension-linked" value={int(k.extensionLinkedUsers)} sub="users with a live device token" />
        <Kpi label="Open tickets" value={int(k.openTickets)} sub="open + pending" to="/admin/support" tone={k.openTickets > 0 ? "brand" : undefined} />
        <Kpi label="Tracked signals" value={int(k.trackedSignals)} sub={`by ${int(k.trackingUsers)} users · ${int(k.activeAlerts)} active alerts`} />
      </div>

      <div className="adm-grid2">
        <ChartFrame
          title="New users per day"
          meta={`${dayLabel(cols[0]?.key ?? "")} – ${dayLabel(cols[cols.length - 1]?.key ?? "")} · UTC days`}
          table={
            <table className="dtable">
              <thead>
                <tr>
                  <th>Day (UTC)</th>
                  <th className="r">New users</th>
                </tr>
              </thead>
              <tbody>
                {[...cols].reverse().map((c) => (
                  <tr key={c.key}>
                    <td className="mono">{c.key}</td>
                    <td className="r mono">{int(c.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          }
        >
          {k.newUsers === 0 ? <p className="adm-chart__empty t2">No sign-ups in this window yet. Columns appear as users verify their first code.</p> : null}
          <ColumnChart data={cols} ariaLabel={`New users per day over ${d.days} days, ${k.newUsers} total. Use arrow keys to read each day.`} />
        </ChartFrame>

        <ChartFrame
          title="Active users"
          meta="signed-in vs guests, by window"
          legend={
            <ul className="adm-legend">
              <li>
                <i style={{ background: "var(--brand)" }} aria-hidden="true" />
                <span>Signed-in users</span>
              </li>
              <li>
                <i style={{ background: "var(--info)" }} aria-hidden="true" />
                <span>Guests (distinct anonId)</span>
              </li>
            </ul>
          }
          table={
            <table className="dtable">
              <thead>
                <tr>
                  <th>Window</th>
                  <th className="r">Users</th>
                  <th className="r">Guests</th>
                </tr>
              </thead>
              <tbody>
                {(["dau", "wau", "mau"] as const).map((w) => (
                  <tr key={w}>
                    <td className="mono">{w.toUpperCase()}</td>
                    <td className="r mono">{int(k[w].users)}</td>
                    <td className="r mono">{int(k[w].guests)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          }
        >
          <ActiveBars k={k} />
          <p className="adm-note">
            The overview API returns DAU / WAU / MAU totals, not a per-day DAU series, so this shows the three windows side by side. {d.notes ? <span className="t3">{d.notes}</span> : null}
          </p>
        </ChartFrame>
      </div>

      <div className="adm-grid3">
        <ChartFrame
          title="Funnel"
          meta={`distinct actors · ${d.days}d`}
          table={
            <table className="dtable">
              <thead>
                <tr>
                  <th>Step</th>
                  <th className="r">Actors</th>
                  <th className="r">Of first step</th>
                </tr>
              </thead>
              <tbody>
                {d.funnel.map((f) => (
                  <tr key={f.step}>
                    <td>{FUNNEL_LABEL[f.step] ?? f.step}</td>
                    <td className="r mono">{int(f.actors)}</td>
                    <td className="r mono">{pct(f.actors / funnelTop, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          }
        >
          <HBars
            ariaLabel="Funnel steps"
            max={funnelTop}
            rows={d.funnel.map((f, i) => {
              const prev = i > 0 ? d.funnel[i - 1]?.actors ?? 0 : null;
              return {
                key: f.step,
                label: (
                  <>
                    <span className="mono t3">{i + 1}</span> {FUNNEL_LABEL[f.step] ?? f.step}
                  </>
                ),
                value: f.actors,
                note: prev === null ? <span className="t3">entry</span> : <span className="t3">{prev ? `${pct(f.actors / prev, 0)} of step ${i}` : "—"}</span>,
              };
            })}
          />
          <p className="adm-note t3">Sign-up start counts guests too; later steps count signed-in users. Tracking counts adds and toggles in the window.</p>
        </ChartFrame>

        <ChartFrame
          title="Plan mix"
          meta="effective plan (expired grants count as free)"
          table={
            <table className="dtable">
              <thead>
                <tr>
                  <th>Plan</th>
                  <th className="r">Users</th>
                  <th className="r">Share</th>
                </tr>
              </thead>
              <tbody>
                {(["free", "pro", "elite"] as const).map((p) => (
                  <tr key={p}>
                    <td>{p}</td>
                    <td className="r mono">{int(k.planMix[p] ?? 0)}</td>
                    <td className="r mono">{k.totalUsers ? pct((k.planMix[p] ?? 0) / k.totalUsers, 1) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          }
        >
          <SegmentedBar
            ariaLabel="Plan mix"
            parts={(["free", "pro", "elite"] as const).map((p) => ({ key: p, label: p[0]!.toUpperCase() + p.slice(1), value: k.planMix[p] ?? 0, color: PLAN_COLORS[p]! }))}
          />
        </ChartFrame>

        <ChartFrame
          title="Top instruments"
          meta={`instrument_view events · ${d.days}d`}
          table={
            <table className="dtable">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th className="r">Views</th>
                  <th className="r">Viewers</th>
                </tr>
              </thead>
              <tbody>
                {d.topInstruments.map((t) => (
                  <tr key={t.symbol}>
                    <td className="mono">{t.symbol}</td>
                    <td className="r mono">{int(t.views)}</td>
                    <td className="r mono">{int(t.viewers)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          }
        >
          {d.topInstruments.length ? (
            <HBars
              ariaLabel="Most viewed instruments"
              rows={d.topInstruments.map((t) => ({
                key: t.symbol,
                label: <span className="mono">{t.symbol}</span>,
                value: t.views,
                note: <span className="t3">{int(t.viewers)} {t.viewers === 1 ? "viewer" : "viewers"}</span>,
              }))}
            />
          ) : (
            <p className="adm-chart__empty t2">No instrument views in this window. The web app sends instrument_view when someone opens a deep-dive.</p>
          )}
        </ChartFrame>
      </div>

      <Section title="Retention by weekly sign-up cohort" meta={`cohorts that signed up in the last ${d.days} days · week 0 = signup week`}>
        {d.retention.length ? (
          <RetentionGrid rows={d.retention} />
        ) : (
          <p className="adm-chart__empty t2">No cohorts yet. A row appears for each week with at least one sign-up.</p>
        )}
      </Section>
    </div>
  );
}

function ActiveBars({ k }: { k: OverviewData["kpis"] }) {
  const max = Math.max(1, k.mau.users + k.mau.guests, k.wau.users + k.wau.guests, k.dau.users + k.dau.guests);
  return (
    <ol className="adm-act" aria-label="Active users by window">
      {(["dau", "wau", "mau"] as const).map((w) => {
        const u = k[w].users;
        const g = k[w].guests;
        return (
          <li key={w} tabIndex={0} aria-label={`${w.toUpperCase()}: ${u} signed-in users, ${g} guests`}>
            <span className="adm-act__w mono">{w.toUpperCase()}</span>
            <span className="adm-act__bar" aria-hidden="true">
              {u > 0 && <span style={{ width: `${(u / max) * 100}%`, background: "var(--brand)" }} />}
              {g > 0 && <span style={{ width: `${(g / max) * 100}%`, background: "var(--info)" }} />}
            </span>
            <span className="adm-act__v mono">
              {int(u)} <span className="t3">+ {int(g)}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Kpi({ label, value, sub, meter, to, tone }: { label: string; value: string; sub?: string; meter?: number; to?: string; tone?: "brand" }) {
  const body = (
    <>
      <span className="adm-kpi__l">{label}</span>
      <span className="adm-kpi__v">{value}</span>
      {meter !== undefined && <Meter value={meter} label={label} />}
      {sub && <span className="adm-kpi__s">{sub}</span>}
      {tone === "brand" && (
        <span className="adm-kpi__flag">
          <Pill tone="brand">needs reply</Pill>
        </span>
      )}
    </>
  );
  return to ? (
    <Link to={to} className="adm-kpi adm-kpi--link">
      {body}
    </Link>
  ) : (
    <div className="adm-kpi">{body}</div>
  );
}
