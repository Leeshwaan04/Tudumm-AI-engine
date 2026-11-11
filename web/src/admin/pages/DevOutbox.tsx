import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { ApiError } from "../api";
import { ago, dateTimeShort, dur } from "../format";
import { useApi, useNow } from "../hooks";
import { useAdmin } from "../session";
import { Async, CopyButton, Empty, PageHead, Pill, Refreshed, type Tone } from "../ui";
import type { DevOutboxItem } from "../types";

const STATE: Record<string, { tone: Tone; label: string }> = {
  valid: { tone: "ok", label: "valid" },
  expired: { tone: "neutral", label: "expired" },
  used_or_replaced: { tone: "neutral", label: "used / replaced" },
};

export default function DevOutbox() {
  const { me } = useAdmin();
  const on = me.capabilities.devCodes;
  // Each GET writes a dev_outbox.view audit row, so this page never auto-refreshes.
  const q = useApi<{ items: DevOutboxItem[] }>(on ? "/api/admin/dev-outbox" : null);
  const now = useNow(5_000);
  const off = !on || (q.error instanceof ApiError && q.error.code === "dev_codes_off");

  return (
    <>
      <PageHead
        eyebrow="Dev outbox · UAT only"
        title={
          <>
            Sign-in codes, <em>unsent</em>
          </>
        }
        actions={on ? <Refreshed fetchedAt={q.fetchedAt} refreshing={q.refreshing} onRefresh={q.reload} /> : undefined}
      >
        <p className="t2">
          Email delivery isn't configured, so one-time codes are written here instead of sent. Last 50, emails masked. Every view of this page is written to the{" "}
          <Link className="adm-link" to="/admin/audit?action=dev_outbox.view">
            audit log
          </Link>
          , so it refreshes only when you ask.
        </p>
      </PageHead>

      {off ? (
        <div className="adm-card">
          <Empty title="Dev codes are off.">
            Codes go out by email (or <span className="mono">AUTH_DEV_CODES</span> isn't <span className="mono">on</span>), so there's nothing to show. This page only exists during UAT.
          </Empty>
        </div>
      ) : (
        <>
          <div className="adm-banner adm-banner--warn" role="note">
            <AlertTriangle size={15} aria-hidden="true" />
            <span>Anyone holding a valid code can sign in as that email. Share codes only with the tester who requested them, and never in a public channel.</span>
          </div>
          <Async q={q} label="Reading the outbox">
            {(d) =>
              d.items.length === 0 ? (
                <div className="adm-card">
                  <Empty title="No codes issued yet.">A row appears each time someone requests a sign-in code.</Empty>
                </div>
              ) : (
                <div className="adm-card">
                  <div className="scroll-x">
                    <table className="dtable adm-table adm-outbox">
                      <thead>
                        <tr>
                          <th>Email (masked)</th>
                          <th>Code</th>
                          <th>State</th>
                          <th className="r">Attempts</th>
                          <th>Issued</th>
                          <th>Expires</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.items.map((r, i) => {
                          const exp = Date.parse(r.expiresAt);
                          // The server labels state at fetch time; re-derive expiry so a stale page doesn't show a dead code as valid.
                          const state = r.state === "valid" && Number.isFinite(exp) && exp <= now ? "expired" : r.state;
                          const st = STATE[state] ?? { tone: "neutral" as Tone, label: state };
                          const live = state === "valid";
                          return (
                            <tr key={`${r.createdAt}-${i}`} className={live ? undefined : "adm-row--dim"}>
                              <td className="mono">{r.email}</td>
                              <td>
                                <span className="adm-inline">
                                  <span className={`adm-code mono${live ? " is-live" : ""}`}>{r.code}</span>
                                  {live && <CopyButton text={r.code} label="Copy code" />}
                                </span>
                              </td>
                              <td>
                                <Pill tone={st.tone}>{st.label}</Pill>
                              </td>
                              <td className={`r mono${r.attempts >= 3 ? " c-brand" : " t2"}`}>{r.attempts} / 5</td>
                              <td className="mono t2" title={dateTimeShort(r.createdAt)}>
                                {ago(r.createdAt, now)}
                              </td>
                              <td className="mono t2">{live && Number.isFinite(exp) ? `in ${dur((exp - now) / 1000)}` : dateTimeShort(r.expiresAt)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="adm-card__foot">
                    <span className="mono t3">codes are single-use · 10-minute expiry · 5 attempts</span>
                  </div>
                </div>
              )
            }
          </Async>
        </>
      )}
    </>
  );
}
