import { useEffect } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Search } from "lucide-react";
import { qs } from "../api";
import { ago, dateOnly, int } from "../format";
import { useApi, useDebounced, useNow } from "../hooks";
import { Async, Empty, PageHead, Pager, PlanPill, Refreshed, UserStatusPill } from "../ui";
import type { UsersPage } from "../types";

export default function Users() {
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const now = useNow(60_000);
  const qRaw = sp.get("q") ?? "";
  const plan = sp.get("plan") ?? "";
  const status = sp.get("status") ?? "";
  const page = Math.max(1, Number(sp.get("page") ?? "1") || 1);
  const q = useDebounced(qRaw, 300);

  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    if (k !== "page") n.delete("page");
    setSp(n, { replace: true });
  };

  const res = useApi<UsersPage>(`/api/admin/users${qs({ q: q.trim(), plan, status, page })}`);

  // If the page went past the end (e.g. after a filter change), step back.
  useEffect(() => {
    const d = res.data;
    if (d && d.items.length === 0 && d.page > 1 && d.total > 0) set("page", String(Math.ceil(d.total / d.pageSize)));
  }, [res.data]);

  return (
    <>
      <PageHead eyebrow="Users" title="People on the desk" actions={<Refreshed fetchedAt={res.fetchedAt} refreshing={res.refreshing} onRefresh={res.reload} />}>
        <div className="adm-filters" role="search">
          <label className="adm-search">
            <Search size={14} aria-hidden="true" />
            <span className="visually-hidden">Search users</span>
            <input className="input" type="search" placeholder="Email, name or user id" value={qRaw} maxLength={100} onChange={(e) => set("q", e.target.value)} />
          </label>
          <label className="adm-sel">
            <span className="eyebrow">Plan</span>
            <select className="select" value={plan} onChange={(e) => set("plan", e.target.value)}>
              <option value="">Any</option>
              <option value="free">Free</option>
              <option value="pro">Pro</option>
              <option value="elite">Elite</option>
            </select>
          </label>
          <label className="adm-sel">
            <span className="eyebrow">Status</span>
            <select className="select" value={status} onChange={(e) => set("status", e.target.value)}>
              <option value="">Any</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
              <option value="deleted">Deleted</option>
            </select>
          </label>
          {(qRaw || plan || status) && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setSp(new URLSearchParams(), { replace: true })}>
              Clear filters
            </button>
          )}
        </div>
      </PageHead>

      <Async q={res} label="Loading users">
        {(d) =>
          d.items.length === 0 ? (
            <Empty title={qRaw || plan || status ? "No users match." : "No users yet."}>
              {qRaw || plan || status ? "Try a shorter search or clear the filters." : "Accounts appear here after someone verifies their first sign-in code."}
            </Empty>
          ) : (
            <div className="adm-card">
              <div className="scroll-x">
                <table className="dtable adm-table adm-table--click">
                  <thead>
                    <tr>
                      <th>User</th>
                      <th>Status</th>
                      <th>Plan</th>
                      <th>Country</th>
                      <th>Joined</th>
                      <th>Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.items.map((u) => (
                      <tr key={u.id} onClick={() => navigate(`/admin/users/${u.id}`)}>
                        <td>
                          <Link to={`/admin/users/${u.id}`} className="adm-user" onClick={(e) => e.stopPropagation()}>
                            <span className="adm-user__e">{u.email}</span>
                            <span className="adm-user__n t3">
                              {u.displayName ? u.displayName : <span className="mono">{u.id.slice(0, 8)}</span>}
                              {!u.emailVerified && <span className="adm-tag">unverified</span>}
                            </span>
                          </Link>
                        </td>
                        <td>
                          <UserStatusPill status={u.status} />
                        </td>
                        <td>
                          <span className="adm-inline">
                            <PlanPill plan={u.plan} />
                            {u.planExpiresAt && <span className="mono t3">to {dateOnly(u.planExpiresAt)}</span>}
                          </span>
                        </td>
                        <td className="mono t2">{u.country ?? "—"}</td>
                        <td className="mono t2">{dateOnly(u.createdAt)}</td>
                        <td className="mono t2" title={u.lastSeenAt ?? undefined}>
                          {ago(u.lastSeenAt, now)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="adm-card__foot">
                <span className="mono t3">{int(d.total)} users</span>
                <Pager page={d.page} total={d.total} pageSize={d.pageSize} hasMore={d.page * d.pageSize < d.total} onPage={(p) => set("page", String(p))} disabled={res.refreshing} />
              </div>
            </div>
          )
        }
      </Async>
    </>
  );
}
