import { Link } from "react-router-dom";
import { ageDays, dateOnly, dateTimeShort, dur, int, pct, shortId } from "../format";
import { useApi, useNow } from "../hooks";
import { Async, Empty, PageHead, Pill, Refreshed, Section } from "../ui";
import type { Compliance as ComplianceData } from "../types";

const CONSENT_LABEL: Record<string, string> = {
  terms: "Terms of use",
  risk_disclosure: "Risk disclosure",
  privacy: "Privacy notice",
  marketing: "Marketing email",
};

const REQUEST_LABEL: Record<string, string> = { export: "Data export", delete: "Account deletion" };

export default function Compliance() {
  const q = useApi<ComplianceData>("/api/admin/compliance");
  const now = useNow(60_000);

  return (
    <>
      <PageHead
        eyebrow="Compliance"
        title={
          <>
            Consent, data rights & <em>grievances</em>
          </>
        }
        actions={<Refreshed fetchedAt={q.fetchedAt} refreshing={q.refreshing} onRefresh={q.reload} />}
      >
        <p className="t2">Read-only. Grievances are answered from Support; data exports and deletions run self-serve from the user's Account page.</p>
      </PageHead>

      <Async q={q} label="Reading compliance records">
        {(d) => {
          const overdue = d.grievances.olderThan21Days;
          const late = d.grievances.olderThan7Days;
          const pendingReq = d.dataRequests.pending.length;
          const last30 = d.dataRequests.last30Days.reduce((s, r) => s + Number(r.n || 0), 0);
          return (
            <div className="adm-comp">
              <div className="adm-kpis adm-kpis--4" aria-label="Compliance figures">
                <div className={`adm-kpi${overdue > 0 ? " adm-kpi--bad" : ""}`}>
                  <span className="adm-kpi__l">Grievances over 21 days</span>
                  <span className="adm-kpi__v">{int(overdue)}</span>
                  <span className="adm-kpi__s">open or pending · past the resolve window</span>
                </div>
                <div className={`adm-kpi${late > 0 ? " adm-kpi--warn" : ""}`}>
                  <span className="adm-kpi__l">Grievances over 7 days</span>
                  <span className="adm-kpi__v">{int(late)}</span>
                  <span className="adm-kpi__s">includes the 21-day ones</span>
                </div>
                <div className="adm-kpi">
                  <span className="adm-kpi__l">Pending data requests</span>
                  <span className="adm-kpi__v">{int(pendingReq)}</span>
                  <span className="adm-kpi__s">export / delete not yet completed</span>
                </div>
                <div className="adm-kpi">
                  <span className="adm-kpi__l">Data requests · 30d</span>
                  <span className="adm-kpi__v">{int(last30)}</span>
                  <span className="adm-kpi__s">{d.dataRequests.last30Days.map((r) => `${r.n} ${r.kind}`).join(" · ") || "none"}</span>
                </div>
              </div>

              <Section
                title="Aged grievances"
                meta={d.notes ?? "acknowledge within 7 days · resolve within 21"}
                flush
                className={overdue > 0 ? "adm-card--alert" : undefined}
              >
                {d.grievances.items.length === 0 ? (
                  <Empty title="No grievance is older than 7 days.">Open grievances younger than a week stay in the Support inbox until they age in here.</Empty>
                ) : (
                  <div className="scroll-x">
                    <table className="dtable adm-table">
                      <thead>
                        <tr>
                          <th>Age</th>
                          <th>Subject</th>
                          <th>From</th>
                          <th>Status</th>
                          <th>Opened</th>
                          <th className="r">Open</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.grievances.items.map((g) => {
                          const age = ageDays(g.created_at, now) ?? 0;
                          return (
                            <tr key={g.id} className={g.overdue21 ? "adm-row--bad" : undefined}>
                              <td>
                                <Pill tone={g.overdue21 ? "bad" : "warn"} title={g.overdue21 ? "Past the 21-day resolve window" : "Past the 7-day acknowledge window"}>
                                  {dur(age * 86400)}
                                  {g.overdue21 ? " · over 21d" : " · over 7d"}
                                </Pill>
                              </td>
                              <td className="adm-trunc adm-trunc--w" title={g.subject}>
                                {g.subject}
                              </td>
                              <td>
                                <span className="adm-break t2">{g.email}</span>
                                {g.user_id && (
                                  <Link className="adm-link mono adm-sub" to={`/admin/users/${g.user_id}`}>
                                    user {shortId(g.user_id)}
                                  </Link>
                                )}
                              </td>
                              <td>
                                <Pill tone={g.status === "open" ? "brand" : "info"}>{g.status}</Pill>
                              </td>
                              <td className="mono t2">{dateTimeShort(g.created_at)}</td>
                              <td className="r">
                                <Link className="btn btn--sm" to={`/admin/support/${g.id}`}>
                                  Answer →
                                </Link>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Section>

              <div className="adm-grid2">
                <Section title="Consents on record" meta="by document and version" flush>
                  {d.consents.length === 0 ? (
                    <Empty title="No consents recorded yet.">Rows appear when signed-in users accept Terms, Risk and Privacy during onboarding.</Empty>
                  ) : (
                    <div className="scroll-x">
                      <table className="dtable adm-table">
                        <thead>
                          <tr>
                            <th>Document</th>
                            <th>Version</th>
                            <th className="r">Accepted</th>
                            <th className="r">Active</th>
                            <th className="r">Withdrawn</th>
                            <th>Kept</th>
                          </tr>
                        </thead>
                        <tbody>
                          {d.consents.map((c) => {
                            const total = Number(c.total) || 0;
                            const active = Number(c.active) || 0;
                            const share = total ? active / total : 0;
                            return (
                              <tr key={`${c.kind}-${c.version}`}>
                                <td>{CONSENT_LABEL[c.kind] ?? c.kind}</td>
                                <td className="mono t2">v{c.version}</td>
                                <td className="r mono">{int(total)}</td>
                                <td className="r mono">{int(active)}</td>
                                <td className={`r mono${Number(c.withdrawn) > 0 ? " c-brand" : " t3"}`}>{int(Number(c.withdrawn) || 0)}</td>
                                <td>
                                  <span className="adm-keep" title={`${pct(share, 1)} still active`}>
                                    <span className="adm-keep__bar" aria-hidden="true">
                                      <span style={{ width: `${share * 100}%` }} />
                                    </span>
                                    <span className="mono t2">{pct(share, 0)}</span>
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Section>

                <Section title="Pending data requests" meta="oldest first" flush>
                  {d.dataRequests.pending.length === 0 ? (
                    <Empty title="Nothing pending.">Exports are generated on request and deletions run immediately, so this normally stays empty.</Empty>
                  ) : (
                    <div className="scroll-x">
                      <table className="dtable adm-table">
                        <thead>
                          <tr>
                            <th>Request</th>
                            <th>User</th>
                            <th>Status</th>
                            <th>Opened</th>
                            <th className="r">Age</th>
                          </tr>
                        </thead>
                        <tbody>
                          {d.dataRequests.pending.map((r) => (
                            <tr key={r.id}>
                              <td>{REQUEST_LABEL[r.kind] ?? r.kind}</td>
                              <td>
                                {r.user_id ? (
                                  <Link className="adm-link mono" to={`/admin/users/${r.user_id}`}>
                                    {shortId(r.user_id)}
                                  </Link>
                                ) : (
                                  <span className="t3">—</span>
                                )}
                              </td>
                              <td>
                                <Pill tone="warn">{r.status}</Pill>
                              </td>
                              <td className="mono t2">{dateOnly(r.created_at)}</td>
                              <td className="r mono t2">{dur((ageDays(r.created_at, now) ?? 0) * 86400)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Section>
              </div>

              <p className="adm-note t3">
                Tudumm isn't SEBI-registered; nothing here should be described as a SEBI SCORES process. SLA windows above are an internal reference for the owner to confirm against the
                applicable rules.
              </p>
            </div>
          );
        }}
      </Async>
    </>
  );
}
