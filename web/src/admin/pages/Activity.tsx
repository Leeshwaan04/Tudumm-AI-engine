import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Pause, Play } from "lucide-react";
import { qs } from "../api";
import { ago, dateTime, jsonLine, shortId, timeOnly } from "../format";
import { useApi, useInterval, useNow } from "../hooks";
import { Async, Empty, ErrorNote, PageHead, Pager } from "../ui";
import type { EventsPage } from "../types";

/** Name allowlist from POST /api/v1/events (worker/src/api/events.ts). */
const EVENT_NAMES = [
  "page_view",
  "instrument_view",
  "signal_view",
  "track_toggle",
  "watchlist_toggle",
  "alert_create",
  "search",
  "onboarding_step",
  "onboarding_complete",
  "plan_view",
  "upgrade_click",
  "extension_preview",
  "extension_link",
  "verify_chain",
  "tamper_test",
  "signup_start",
  "login",
  "logout",
  "support_submit",
  "sizer_use",
  "filter_change",
];

const SINCE = [
  { key: "", label: "Any time" },
  { key: "15m", label: "15 min", ms: 15 * 60_000 },
  { key: "1h", label: "1 hour", ms: 3_600_000 },
  { key: "24h", label: "24 hours", ms: 86_400_000 },
  { key: "7d", label: "7 days", ms: 7 * 86_400_000 },
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function ActivityFeed() {
  const [sp, setSp] = useSearchParams();
  const name = sp.get("name") ?? "";
  const userIdRaw = sp.get("userId") ?? "";
  const sinceKey = sp.get("since") ?? "";
  const page = Math.max(1, Number(sp.get("page") ?? "1") || 1);
  const [paused, setPaused] = useState(false);
  const [userInput, setUserInput] = useState(userIdRaw);
  const now = useNow(10_000);

  const userId = UUID_RE.test(userIdRaw) ? userIdRaw : "";
  const userBad = userIdRaw !== "" && !userId;

  // `since` is anchored when the filter is chosen, so auto-refresh doesn't keep shifting it.
  const [anchor, setAnchor] = useState(() => Date.now());
  const sinceMs = SINCE.find((s) => s.key === sinceKey && "ms" in s);
  const sinceIso = sinceMs && "ms" in sinceMs ? new Date(anchor - sinceMs.ms).toISOString() : "";

  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    if (k !== "page") n.delete("page");
    setSp(n, { replace: true });
    if (k === "since") setAnchor(Date.now());
  };

  const res = useApi<EventsPage>(`/api/admin/events${qs({ name, userId, since: sinceIso, page, limit: 50 })}`);
  const live = !paused && page === 1;
  useInterval(() => res.reload(), live ? 10_000 : null);

  // Mark rows that arrived since the previous refresh.
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    const items = res.data?.items;
    if (!items) return;
    const prev = seen.current;
    const ids = new Set(items.map((i) => i.id));
    if (prev) setFresh(new Set(items.filter((i) => !prev.has(i.id)).map((i) => i.id)));
    seen.current = ids;
  }, [res.data]);
  useEffect(() => {
    seen.current = null;
    setFresh(new Set());
  }, [name, userId, sinceKey, page]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of res.data?.items ?? []) m.set(e.name, (m.get(e.name) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [res.data]);

  return (
    <>
      <PageHead
        eyebrow="Activity"
        title={
          <>
            The <em>live</em> tape
          </>
        }
        actions={
          <span className="adm-livectl">
            <span className={`adm-livedot${live ? " is-live" : ""}`} aria-hidden="true" />
            <span className="mono t2" aria-live="polite">
              {live ? `live · every 10s · ${res.fetchedAt ? timeOnly(res.fetchedAt) : "…"}` : page > 1 ? "paused on older page" : "paused"}
            </span>
            <button type="button" className="btn btn--sm" onClick={() => setPaused((p) => !p)} disabled={page > 1} aria-pressed={paused}>
              {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
              {paused ? "Resume" : "Pause"}
            </button>
          </span>
        }
      >
        <div className="adm-filters">
          <label className="adm-sel">
            <span className="eyebrow">Event</span>
            <select className="select" value={name} onChange={(e) => set("name", e.target.value)}>
              <option value="">All events</option>
              {EVENT_NAMES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <form
            className="adm-sel"
            onSubmit={(e) => {
              e.preventDefault();
              set("userId", userInput.trim());
            }}
          >
            <label className="eyebrow" htmlFor="adm-uid">
              User id
            </label>
            <span className="adm-inline">
              <input id="adm-uid" className="input mono adm-uid" placeholder="uuid" value={userInput} maxLength={36} onChange={(e) => setUserInput(e.target.value)} spellCheck={false} />
              <button type="submit" className="btn btn--sm">
                Apply
              </button>
            </span>
          </form>
          <label className="adm-sel">
            <span className="eyebrow">Since</span>
            <select className="select" value={sinceKey} onChange={(e) => set("since", e.target.value)}>
              {SINCE.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          {(name || userIdRaw || sinceKey) && (
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => {
                setUserInput("");
                setSp(new URLSearchParams(), { replace: true });
              }}
            >
              Clear filters
            </button>
          )}
        </div>
        {userBad && <ErrorNote error={new Error("User id must be a full UUID (copy it from the user's page).")} compact />}
        {counts.length > 0 && (
          <p className="adm-mix mono t3">
            On this page: {counts.map(([n, c]) => `${n} ${c}`).join(" · ")}
          </p>
        )}
      </PageHead>

      <Async q={res} label="Loading events">
        {(d) =>
          d.items.length === 0 ? (
            <Empty title="Quiet tape.">{name || userId || sinceKey ? "No events match these filters." : "No events recorded yet. They arrive as guests and users browse the web app and extension."}</Empty>
          ) : (
            <div className="adm-card">
              <div className="scroll-x">
                <table className="dtable adm-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Event</th>
                      <th>Who</th>
                      <th>Path</th>
                      <th>Props</th>
                      <th>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.items.map((e) => (
                      <tr key={e.id} className={fresh.has(e.id) ? "adm-row--fresh" : undefined}>
                        <td className="mono t2" title={dateTime(e.at)}>
                          {ago(e.at, now)}
                        </td>
                        <td>
                          <button type="button" className="adm-ev mono" onClick={() => set("name", e.name)} title="Filter to this event">
                            {e.name}
                          </button>
                        </td>
                        <td>
                          {e.userId ? (
                            <Link className="adm-link mono" to={`/admin/users/${e.userId}`}>
                              user {shortId(e.userId)}
                            </Link>
                          ) : (
                            <span className="mono t3">guest {shortId(e.anonId ?? "", 6)}</span>
                          )}
                        </td>
                        <td className="mono t2 adm-trunc">{e.path ?? "—"}</td>
                        <td className="mono t3 adm-trunc adm-trunc--w" title={jsonLine(e.props, 2000)}>
                          {jsonLine(e.props, 90) || "—"}
                        </td>
                        <td className="mono t3">{[e.source, e.device, e.country].filter(Boolean).join(" · ") || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="adm-card__foot">
                <span className="mono t3">{d.items.length} on this page</span>
                <Pager page={d.page} hasMore={d.hasMore} onPage={(p) => set("page", p === 1 ? "" : String(p))} disabled={res.refreshing} />
              </div>
            </div>
          )
        }
      </Async>
    </>
  );
}
