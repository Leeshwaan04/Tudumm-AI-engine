import { useState, type FormEvent } from "react";
import { BellPlus, BellRing, Trash2 } from "lucide-react";
import type { Instrument } from "../engine/types";
import { useTick } from "../engine/live";
import { fmtLevel } from "../engine/format";
import { alertsApi } from "../api/endpoints";
import { errorText } from "../api/client";
import { useApi } from "../api/useApi";
import { useConfig } from "../api/config";
import { openSignIn, patchMe, useSession } from "../api/session";
import { track } from "../api/events";
import type { Alert } from "../api/types";
import { Switch, toast } from "./ui";

export const ALERTS_KEY = "me:alerts";

/**
 * Price alert + "notify me about new signals" for one instrument (alerts are server-side, so
 * signed-out users are asked to sign in; hidden entirely when the API isn't reachable).
 */
export function AlertsPanel({ inst }: { inst: Instrument }) {
  const cfg = useConfig();
  const session = useSession();
  const signedIn = session.status === "signed_in";
  const q = useApi(signedIn ? ALERTS_KEY : null, () => alertsApi.list(), { staleMs: 20_000 });
  const t = useTick(inst.symbol);
  const [formOpen, setFormOpen] = useState(false);
  const [kind, setKind] = useState<"price_above" | "price_below">("price_above");
  const [threshold, setThreshold] = useState("");
  const [oneShot, setOneShot] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!cfg.apiReachable) return null;
  const canSignIn = cfg.caps.emailDelivery || cfg.caps.devCodes || cfg.caps.googleSignIn;
  if (!signedIn && !canSignIn) return null;

  const mine = (q.data?.items ?? []).filter((a) => a.symbol === inst.symbol);
  const priceAlerts = mine.filter((a) => a.kind === "price_above" || a.kind === "price_below");
  const sigAlert = mine.find((a) => a.kind === "new_signal");
  const dp = Math.max(0, inst.decimals);
  const round = (v: number) => Number(v.toFixed(dp));

  const needSignIn = (why: string) => {
    openSignIn(why);
  };

  const openForm = () => {
    if (!signedIn) return needSignIn(`Sign in to set price alerts on ${inst.symbol}. Alerts arrive in your Tudumm notifications.`);
    setThreshold(String(round(t.price)));
    setKind("price_above");
    setErr(null);
    setFormOpen((o) => !o);
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const v = Number(threshold.replace(/,/g, ""));
    if (!(v > 0)) {
      setErr("Enter a price above zero.");
      return;
    }
    if (kind === "price_above" && v <= t.price) {
      setErr(`That's at or below the current price (${fmtLevel(inst, t.price)}); it would fire straight away. Use "falls below" instead, or raise it.`);
      return;
    }
    if (kind === "price_below" && v >= t.price) {
      setErr(`That's at or above the current price (${fmtLevel(inst, t.price)}); it would fire straight away. Use "rises above" instead, or lower it.`);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await alertsApi.create({ symbol: inst.symbol, kind, threshold: v, oneShot });
      q.mutate((prev) => (prev ? { ...prev, items: [r.alert, ...prev.items] } : { items: [r.alert], limit: 50 }));
      bumpCount(1);
      track("alert_create", { symbol: inst.symbol, kind, oneShot });
      toast(`Alert set: ${inst.symbol} ${kind === "price_above" ? "rises above" : "falls below"} ${fmtLevel(inst, v)}`);
      setFormOpen(false);
    } catch (ex) {
      setErr(errorText(ex));
    } finally {
      setBusy(false);
    }
  };

  const bumpCount = (d: number) => {
    const me = session.me;
    if (me) patchMe({ counts: { ...me.counts, alerts: Math.max(0, me.counts.alerts + d) } });
  };

  const remove = async (a: Alert) => {
    const prev = q.data;
    q.mutate((p) => (p ? { ...p, items: p.items.filter((x) => x.id !== a.id) } : p!));
    try {
      await alertsApi.remove(a.id);
      bumpCount(-1);
    } catch (ex) {
      if (prev) q.mutate(prev);
      toast(errorText(ex));
    }
  };

  const toggleSignals = async (on: boolean) => {
    if (!signedIn) return needSignIn(`Sign in to be notified when Tudumm issues a new call on ${inst.symbol}.`);
    if (busy) return;
    setBusy(true);
    try {
      if (on && !sigAlert) {
        const r = await alertsApi.create({ symbol: inst.symbol, kind: "new_signal" });
        q.mutate((prev) => (prev ? { ...prev, items: [r.alert, ...prev.items] } : { items: [r.alert], limit: 50 }));
        bumpCount(1);
        track("alert_create", { symbol: inst.symbol, kind: "new_signal" });
        toast(`You'll be notified about new ${inst.symbol} signals`);
      } else if (!on && sigAlert) {
        await alertsApi.remove(sigAlert.id);
        q.mutate((p) => (p ? { ...p, items: p.items.filter((x) => x.id !== sigAlert.id) } : p!));
        bumpCount(-1);
        toast(`New-signal notifications off for ${inst.symbol}`);
      }
    } catch (ex) {
      toast(errorText(ex));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel alerts-panel" aria-label="Alerts">
      <header className="panel__head">
        <span className="eyebrow">Alerts</span>
        {signedIn && q.data && <span className="mono t3">{q.data.items.length} / {q.data.limit} used</span>}
      </header>
      <div className="panel__body alerts-panel__body">
        <Switch checked={!!sigAlert} onChange={(v) => void toggleSignals(v)}>
          Notify me about new signals
        </Switch>
        <button type="button" className={`btn btn--sm ${formOpen ? "btn--on" : ""}`} aria-expanded={formOpen} onClick={openForm}>
          <BellPlus size={14} aria-hidden="true" /> Set price alert
        </button>
        {formOpen && (
          <form className="alert-form" onSubmit={create} noValidate>
            <label className="field">
              <span>When {inst.symbol}</span>
              <select className="select" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="price_above">rises above</option>
                <option value="price_below">falls below</option>
              </select>
            </label>
            <label className="field">
              <span>Price ({inst.currency})</span>
              <input className="input mono" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} aria-invalid={!!err} />
            </label>
            <label className="alert-form__chk">
              <input type="checkbox" checked={oneShot} onChange={(e) => setOneShot(e.target.checked)} /> Once only
              <span className="t3"> (otherwise at most once a day)</span>
            </label>
            {err && (
              <p className="form-err" role="alert">
                {err}
              </p>
            )}
            <div className="alert-form__act">
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setFormOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="btn btn--primary btn--sm" disabled={busy}>
                {busy ? "Saving…" : "Create alert"}
              </button>
            </div>
            <p className="ev__fine">
              Checked each time the price refreshes ({inst.freshness === "realtime" ? "about every 15 minutes on the server" : "when the delayed or end-of-day price updates"}). Alerts arrive in your notifications
              {cfg.caps.emailDelivery ? " and by email." : "; email copies aren't switched on yet."}
            </p>
          </form>
        )}
        {signedIn && priceAlerts.length > 0 && (
          <ul className="alert-list">
            {priceAlerts.map((a) => (
              <li key={a.id} className={a.active ? "" : "is-off"}>
                <BellRing size={13} aria-hidden="true" />
                <span className="mono">
                  {a.kind === "price_above" ? "▲ above" : "▼ below"} {a.threshold !== null ? fmtLevel(inst, a.threshold) : "—"}
                </span>
                <span className="t3">{a.active ? (a.oneShot ? "once" : "daily") : "fired"}</span>
                <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label={`Delete alert at ${a.threshold}`} onClick={() => void remove(a)}>
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {!signedIn && <p className="ev__fine">Alerts live on your account, so they need a sign-in. Watchlist and tracking keep working without one.</p>}
      </div>
    </section>
  );
}
