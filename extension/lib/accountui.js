// "Tudumm account" panel: link this browser to a Tudumm account (device code),
// show the link state, sync now, unlink. Used by Options (full) and the side
// panel's Watchlist tab (compact). It only ever sees public account state from
// the background: never the token or the device token.
//
// No dead controls: when linking isn't possible (preview, capability off,
// server unreachable), the panel explains why instead of showing a button.

import * as P from "./platform.js";
import { h, button, logoMark } from "./ui.js";

function hostOf(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return origin || "the Tudumm website";
  }
}

function agoText(ts, now = Date.now()) {
  if (!ts) return null;
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} h ago`;
  return new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function mmss(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * createAccountPanel({ compact, onLinked }) → { el, refresh(), destroy() }
 */
export function createAccountPanel({ compact = false, embedded = false, onLinked = null } = {}) {
  const el = h("section", { class: `acct${compact ? " acct--compact" : ""}`, "aria-label": "Tudumm account", "aria-live": "polite" });
  let st = null;
  let busy = false;
  let error = null;
  let confirmUnlink = false;
  let confirmTimer = null;
  let tick = null;
  let wasLinked = null;
  let dead = false;

  async function refresh({ caps = false } = {}) {
    try {
      st = await P.getAccount({ refresh: caps });
    } catch {
      st = { linked: false, link: null, capabilities: { reachable: false, extensionLinking: false, reason: "The extension's background didn't answer." } };
    }
    if (dead) return;
    if (wasLinked === false && st.linked && onLinked) onLinked(st);
    wasLinked = !!st.linked;
    render();
  }

  async function act(fn) {
    if (busy) return;
    busy = true;
    error = null;
    render();
    try {
      const res = await fn();
      if (res && res.ok === false && res.error) error = res.error;
      else if (res && res.error) error = res.error;
    } catch (err) {
      error = String((err && err.message) || err);
    } finally {
      busy = false;
      await refresh();
    }
  }

  const head = (state, cls) =>
    h(
      "div",
      { class: "acct-head" },
      compact || embedded ? null : logoMark({ size: 18 }),
      embedded ? h("span", { class: "acct-title" }, "Status") : h("h3", { class: "acct-title" }, "Tudumm account"),
      h("span", { class: `acct-state ${cls || ""}`.trim() }, state),
    );

  function renderLinked() {
    const who = (st.user && (st.user.email || st.user.displayName)) || "Your Tudumm account";
    const plan = st.plan && (st.plan.name || st.plan.id);
    const unlinkBtn = button(confirmUnlink ? "Confirm: unlink" : "Unlink", {
      kind: confirmUnlink ? "primary" : "ghost",
      small: true,
      title: "Revokes this browser's key on Tudumm and removes it here",
      onClick: () => {
        if (!confirmUnlink) {
          confirmUnlink = true;
          clearTimeout(confirmTimer);
          confirmTimer = setTimeout(() => {
            confirmUnlink = false;
            render();
          }, 5000);
          return render();
        }
        confirmUnlink = false;
        clearTimeout(confirmTimer);
        act(async () => {
          const res = await P.unlink();
          if (res && res.ok) P.toast(res.revoked ? "Unlinked. The extension's key was revoked." : "Unlinked in this browser.", { tone: res.error ? "warn" : "ok", timeout: res.error ? 7000 : 3200 });
          return res;
        });
      },
    });
    const syncBtn = st.originMismatch
      ? null
      : button(busy ? "Syncing…" : "Sync now", {
          small: true,
          onClick: () => act(() => P.getAccount({ refresh: true }).then(() => null)),
        });
    if (syncBtn && busy) syncBtn.disabled = true;
    const kids = [
      head("LINKED", "is-linked"),
      h("div", { class: "acct-head" }, h("span", { class: "acct-who", title: who }, who), plan ? h("span", { class: "chip mono" }, plan.toUpperCase()) : null),
      st.originMismatch
        ? h("p", { class: "notice notice--warn" }, `Linked on ${hostOf(st.linkedOrigin)}, but the web app URL now points to ${hostOf(st.origin)}. Syncing is paused: switch the URL back, or unlink and link again.`)
        : h("p", { class: "acct-sub" }, compact ? "Your watchlist syncs with this account." : "Your watchlist syncs with this account in both directions. Stars you add here appear in the web terminal, and the other way round."),
      h(
        "p",
        { class: "acct-meta" },
        st.syncedAt ? h("span", {}, `synced ${agoText(st.syncedAt)}`) : h("span", {}, "not synced yet"),
        !compact && st.linkedAt ? h("span", {}, `linked ${agoText(st.linkedAt)}`) : null,
        !compact && st.trackedCount ? h("span", {}, `${st.trackedCount} tracked in the terminal`) : null,
        h("span", {}, hostOf(st.linkedOrigin)),
      ),
      error ? h("p", { class: "acct-err", role: "alert" }, error) : null,
      h("div", { class: "acct-actions" }, syncBtn, unlinkBtn),
    ];
    el.replaceChildren(...kids.filter(Boolean));
  }

  function renderPending(link) {
    const left = h("span", { class: "mono" }, mmss(link.expiresAt - Date.now()));
    clearInterval(tick);
    tick = setInterval(() => {
      const ms = link.expiresAt - Date.now();
      left.textContent = mmss(ms);
      if (ms <= 0) {
        clearInterval(tick);
        refresh();
      }
    }, 1000);
    replace(
      head("LINKING", "is-pending"),
      h("p", { class: "acct-sub" }, `Approve this code on ${hostOf(new URL(link.verifyUrl).origin)} while signed in. Check that the code on the website matches.`),
      h("div", { class: "acct-code" }, h("span", { class: "acct-code-val", "aria-label": `Link code ${link.userCode.split("").join(" ")}` }, link.userCode)),
      h("p", { class: "acct-wait" }, logoMark({ size: 16, drum: true }), "Waiting for approval · code expires in ", left),
      error ? h("p", { class: "acct-err", role: "alert" }, error) : null,
      h(
        "div",
        { class: "acct-actions" },
        button("Open approval page", { kind: "primary", small: true, icon: "↗", onClick: () => P.openUrl(link.verifyUrl) }),
        button("Cancel", { kind: "ghost", small: true, onClick: () => act(() => P.linkCancel()) }),
      ),
    );
  }

  function renderUnlinked() {
    const caps = st.capabilities || {};
    const link = st.link;
    const lead = compact ? "Link your Tudumm account to sync this watchlist with the web terminal." : "Link this browser to your Tudumm account to sync your watchlist with the web terminal. You approve the link on the website; the extension never sees your password or email code.";
    const kids = [head("NOT LINKED")];
    if (st.notice) kids.push(h("p", { class: "notice notice--warn" }, st.notice));
    if (link && link.status === "expired") kids.push(h("p", { class: "notice" }, "That link code expired before it was approved. Start again to get a new one."));
    if (link && link.status === "error" && link.error) kids.push(h("p", { class: "acct-err", role: "alert" }, link.error));
    if (st.preview) {
      kids.push(h("p", { class: "acct-sub" }, `${lead} Linking runs in the installed extension; this preview keeps your watchlist in this browser.`));
      return replace(...kids);
    }
    if (caps.extensionLinking) {
      kids.push(h("p", { class: "acct-sub" }, lead));
      if (error) kids.push(h("p", { class: "acct-err", role: "alert" }, error));
      const b = button(busy ? "Starting…" : link ? "Start again" : "Link account", {
        kind: "primary",
        small: true,
        onClick: () =>
          act(async () => {
            const res = await P.linkStart();
            if (res && res.ok && !res.already) P.toast(`Approve code ${res.userCode} on the website`, { tone: "info", timeout: 5000 });
            return res;
          }),
      });
      b.disabled = busy;
      kids.push(h("div", { class: "acct-actions" }, b));
    } else {
      kids.push(h("p", { class: "acct-sub" }, caps.reason || "Account linking isn't available right now."), h("p", { class: "acct-sub" }, "Your watchlist stays in this browser until then."));
      const again = button(busy ? "Checking…" : "Check again", { small: true, kind: "ghost", onClick: () => act(() => refresh({ caps: true })) });
      again.disabled = busy;
      kids.push(h("div", { class: "acct-actions" }, again));
    }
    replace(...kids);
  }

  /** replaceChildren() would print "null" for skipped optional parts. */
  const replace = (...kids) => el.replaceChildren(...kids.filter(Boolean));

  function render() {
    if (dead) return;
    clearInterval(tick);
    if (!st) {
      el.replaceChildren(head("…"), h("p", { class: "acct-sub" }, "Checking your link…"));
      return;
    }
    if (st.linked) return renderLinked();
    if (st.link && st.link.status === "pending" && st.link.userCode && st.link.verifyUrl) return renderPending(st.link);
    return renderUnlinked();
  }

  render();
  refresh();
  P.onAccountChanged(() => refresh());

  return {
    el,
    refresh,
    get state() {
      return st;
    },
    destroy() {
      dead = true;
      clearInterval(tick);
      clearTimeout(confirmTimer);
    },
  };
}
