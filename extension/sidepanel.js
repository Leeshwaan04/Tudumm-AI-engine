// Side panel: "This page" (follows the active tab), "Feed" (all signals with
// market filters), "Watchlist" (with the Tudumm account link that syncs it),
// and a detail view with sizer.
// Data: live universe + Binance ticks (lib/live.js); an explicit offline state
// with a retry when it can't load.
import { formatR, formatPct } from "./lib/engine.js";
import { createDataSession } from "./lib/live.js";
import { createAccountPanel } from "./lib/accountui.js";
import * as P from "./lib/platform.js";
import * as UI from "./lib/ui.js";

const { h } = UI;
const $bar = document.getElementById("bar");
const $tabs = document.getElementById("tabs");
const $view = document.getElementById("view");

const live = UI.createLive();
let data = null;
let engine = null;
let acctPanel = null;
let tickStatus = "off";
let settings = null;
let watch = [];
let tab = "page"; // page | feed | watch
let detail = null; // symbol shown in detail view (feed / watchlist)
let market = "ALL";
let pageDet = null;
let components = [];
let unsubscribe = null;
let booted = false;

// ------------------------------------------------------------------ chrome --

function renderBar() {
  $bar.replaceChildren(
    UI.wordmark(),
    UI.dataBadge(),
    h("span", { class: "bar-spacer" }),
    h("button", { type: "button", class: "icon-btn", title: "Options", "aria-label": "Open options", onclick: () => P.openOptions() }, UI.iconGear()),
  );
}

function renderTabs() {
  if (!engine) return $tabs.replaceChildren();
  const defs = [
    ["page", "This page", pageDet && pageDet.symbol ? h("i", { class: "live-dot", "aria-hidden": "true" }) : null],
    ["feed", "Feed", h("span", { class: "count" }, String(engine ? engine.instruments.length : 0))],
    ["watch", "Watchlist", h("span", { class: "count" }, String(watch.length))],
  ];
  $tabs.replaceChildren(
    ...defs.map(([id, label, extra]) =>
      h(
        "button",
        {
          type: "button",
          class: "sp-tab",
          role: "tab",
          id: `tab-${id}`,
          "aria-selected": tab === id ? "true" : "false",
          "aria-controls": "view",
          tabindex: tab === id ? "0" : "-1",
          onclick: () => setTab(id),
          onkeydown: (e) => {
            const order = ["page", "feed", "watch"];
            const i = order.indexOf(id);
            if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
              e.preventDefault();
              const next = order[(i + (e.key === "ArrowRight" ? 1 : 2)) % 3];
              setTab(next);
              document.getElementById(`tab-${next}`)?.focus();
            }
          },
        },
        label,
        extra,
      ),
    ),
  );
  $view.setAttribute("role", "tabpanel");
  $view.setAttribute("aria-labelledby", `tab-${tab}`);
}

function setTab(id) {
  tab = id;
  detail = null;
  render();
  $view.scrollTop = 0;
}

function mount(list) {
  components = list.filter(Boolean);
  if (unsubscribe) unsubscribe();
  unsubscribe = live.subscribe((now) => {
    for (const c of components) c.update(now);
  });
}

// ----------------------------------------------------------------- helpers --

const statusOf = (s, now) => engine.signalState(s, now).status;

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function starFor(symbol) {
  return () =>
    UI.starButton(watch.includes(symbol), async () => {
      const res = await P.toggleWatch(symbol);
      watch = await P.getWatchlist();
      renderTabs();
      if (res.error) P.toast(res.error, { tone: "warn", timeout: 5000 });
      else P.toast(`${symbol} ${res.on ? "added to" : "removed from"} your watchlist${res.synced ? " · synced" : ""}`);
      return res.on;
    });
}

function detailBlock(symbol, list, { reveal = true } = {}) {
  const inst = engine.get(symbol);
  const card = UI.createSignalCard(engine, symbol, { star: starFor(symbol) });
  list.push(card);
  if (reveal) requestAnimationFrame(() => card.reveal());
  const sit = inst.signal.status === "sit_out";
  const sizerSlot = h(
    "div",
    { class: "sizer-slot" },
    sit
      ? UI.emptyState({ icon: false, title: "No position to size", body: "Tudumm is sitting out on this instrument, so there is no entry, stop or target to size against." })
      : UI.createSizer(engine, symbol, settings, { onEditDefaults: () => P.openOptions() }),
  );
  return [
    card.el,
    UI.layerBreakdown(engine, symbol),
    sizerSlot,
    UI.setupFacts(engine, symbol),
    h("div", { class: "detail-actions" }, UI.button(`Open ${symbol} in the terminal`, { kind: "primary", icon: "↗", onClick: () => P.openTerminal(symbol) })),
  ];
}

// ------------------------------------------------------------------ views --

function viewPage(list) {
  const d = pageDet;
  const head = h(
    "div",
    { class: "section-head" },
    h("span", { class: "eyebrow" }, "On this tab"),
    d && d.site ? h("span", { class: "here-src" }, h("b", {}, d.site === "preview" ? "preview page" : hostOf(d.url) || d.siteLabel), d.via ? `via ${d.via === "preview" ? "?symbol=" : d.via}` : "") : null,
  );
  if (d && d.symbol && engine.get(d.symbol)) {
    const [card, ...rest] = detailBlock(d.symbol, list);
    return [h("section", { class: "here" }, head, card), ...rest, UI.disclaimer()];
  }
  if (d && d.ticker) {
    return [
      h(
        "section",
        { class: "here" },
        head,
        UI.emptyState({
          title: `${d.ticker} isn't covered yet`,
          body: `Tudumm covers ${engine.instruments.length} instruments across six markets. The feed shows every one of them.`,
          actions: [UI.button("Browse the feed", { kind: "primary", small: true, onClick: () => setTab("feed") })],
        }),
      ),
      UI.disclaimer(),
    ];
  }
  return [
    h(
      "section",
      { class: "here" },
      head,
      UI.emptyState({
        title: "No supported symbol on this tab",
        body: "Open a quote or chart on a supported site and this tab follows it automatically. Each button opens an example page:",
        actions: [UI.siteList((url) => P.openUrl(url)), h("div", { style: { marginTop: "6px" } }, UI.button("Browse the feed", { small: true, onClick: () => setTab("feed") }))],
      }),
    ),
    UI.disclaimer(),
  ];
}

function viewFeed(list, revealed = []) {
  const counts = { ALL: engine.instruments.length };
  for (const i of engine.instruments) counts[i.market] = (counts[i.market] || 0) + 1;
  const chips = [{ id: "ALL", label: "All" }, ...engine.markets].map((m) =>
    h(
      "button",
      { type: "button", class: "fchip", "aria-pressed": market === m.id ? "true" : "false", onclick: () => { market = m.id; render(); } },
      m.id === "ALL" ? "All" : m.label === "United States" ? "US" : m.label,
      h("span", { class: "n" }, String(counts[m.id] || 0)),
    ),
  );
  const now = Date.now();
  const inMarket = engine.instruments.filter((i) => market === "ALL" || i.market === market);
  const liveSigs = inMarket.filter((i) => ["active", "pending", "t1_hit"].includes(statusOf(i.symbol, now))).sort((a, b) => b.signal.confidence - a.signal.confidence);
  const sits = inMarket.filter((i) => i.signal.status === "sit_out");
  let idx = 0;
  const rowsFor = (arr) =>
    arr.map((i) => {
      const r = UI.createRow(engine, i.symbol, { onOpen: openDetail, index: idx++ });
      list.push(r);
      if (revealed.includes(i.symbol)) requestAnimationFrame(() => UI.playReveal(r.el));
      return r.el;
    });
  const animate = !revealed.length;
  return [
    h("div", { class: "filters", role: "group", "aria-label": "Filter by market" }, chips),
    liveMeta(),
    liveSigs.length
      ? h(
          "section",
          {},
          h("div", { class: "section-head" }, h("span", { class: "eyebrow" }, `Open signals · ${liveSigs.length}`), UI.engineTag({ small: true })),
          h("div", { class: `rows${animate ? " stagger" : ""}` }, rowsFor(liveSigs)),
        )
      : null,
    sits.length
      ? h(
          "section",
          {},
          h("div", { class: "group-head" }, h("div", { class: "section-head", style: { marginBottom: "0" } }, h("span", { class: "eyebrow" }, "Sitting out"), h("span", { class: "eyebrow-aux mono" }, `${sits.length}`)), h("p", {}, "Most of the time the best trade is no trade.")),
          h("div", { class: `rows${animate ? " stagger" : ""}` }, rowsFor(sits)),
        )
      : null,
    !liveSigs.length && !sits.length ? UI.emptyState({ icon: false, title: "Nothing in this market", body: "Pick another market above." }) : null,
    ledgerPanel(),
    UI.disclaimer(),
  ];
}

/** Feed header: how fresh the data is. */
function liveMeta() {
  const p = data.payload;
  const at = p && p.fetchedAt ? new Date(p.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
  const ticks =
    tickStatus === "live" ? "streaming live" : tickStatus === "retrying" ? "live stream reconnecting" : tickStatus === "paused" ? "live stream paused while hidden" : tickStatus === "connecting" ? "connecting to the live stream" : null;
  return h(
    "p",
    { class: "feed-meta mono", id: "feed-meta" },
    `Signals and prices refreshed ${at} · every 60 s`,
    ticks ? ` · crypto + PAXG ${ticks}` : "",
    p && p.stale ? " · last refresh failed, showing the previous data" : "",
  );
}

function ledgerPanel() {
  const st = engine.ledgerStats();
  const kpi = (k, v) => h("div", { class: "kpi" }, h("dt", {}, k), h("dd", {}, v));
  const judged = !st.tooFew;
  return h(
    "section",
    { class: "ledger", "aria-label": "Track record" },
    h("span", { class: "eyebrow" }, "Live ledger · v2"),
    h("h3", {}, "Every call on the record."),
    h(
      "dl",
      { class: "ledger-kpis", style: { margin: 0 } },
      kpi("Closed calls", String(st.count)),
      kpi("Win rate", judged ? formatPct(st.winRate, 1).replace("+", "") : "—"),
      kpi("Expectancy", judged ? formatR(st.expectancy) : "—"),
    ),
    st.tooFew ? h("p", { class: "ledger-head", style: { margin: 0 } }, `${st.count} closed call${st.count === 1 ? "" : "s"} — too few to judge. Win rate and expectancy show from 30.`) : null,
    h("p", { class: "ledger-head", style: { margin: 0 } }, `Hash-chained (SHA-256) · ${st.entries} entries · head ${st.head ? st.head.slice(0, 12) : "—"}…`),
    UI.button("Verify the chain in the terminal", { small: true, icon: "↗", onClick: () => P.openTerminal(null, "/app/proof") }),
  );
}

function accountBlock() {
  if (!acctPanel) {
    acctPanel = createAccountPanel({
      compact: true,
      onLinked: () => P.toast("Linked. Your watchlist now syncs with your Tudumm account.", { tone: "ok", timeout: 4000 }),
    });
  }
  return acctPanel.el;
}

function viewWatch(list) {
  const items = watch.filter((s) => engine.get(s));
  const linked = !!(acctPanel && acctPanel.state && acctPanel.state.linked);
  if (!items.length) {
    return [
      UI.emptyState({
        title: "Your watchlist is empty",
        body: linked ? "Tap the star on any signal to keep it here. It syncs with your Tudumm account." : "Tap the star on any signal to keep it here. Without a linked account it's stored in this browser only.",
        actions: [UI.button("Browse the feed", { kind: "primary", small: true, onClick: () => setTab("feed") })],
      }),
      accountBlock(),
      UI.disclaimer(),
    ];
  }
  const rows = items.map((s, i) => {
    const r = UI.createRow(engine, s, { onOpen: openDetail, index: i });
    list.push(r);
    return r.el;
  });
  return [
    h(
      "section",
      {},
      h("div", { class: "section-head" }, h("span", { class: "eyebrow" }, "Watchlist"), h("span", { class: "eyebrow-aux mono" }, `${items.length} starred`)),
      h("div", { class: "rows stagger" }, rows),
    ),
    watch.length > items.length ? h("p", { class: "feed-meta" }, `${watch.length - items.length} more starred in your account aren't covered by this data set.`) : null,
    accountBlock(),
    UI.disclaimer(),
  ];
}

function viewDetail(list) {
  const inst = engine.get(detail);
  return [
    h(
      "div",
      { class: "detail-bar" },
      h("button", { type: "button", class: "btn btn--ghost btn--sm", onclick: closeDetail, "aria-label": `Back to ${tab === "watch" ? "watchlist" : "feed"}` }, UI.iconBack(), tab === "watch" ? "Watchlist" : "Feed"),
      h("span", { class: "eyebrow" }, `${inst.exchange} · ${inst.market}`),
    ),
    ...detailBlock(detail, list),
    UI.disclaimer(),
  ];
}

function openDetail(symbol) {
  if (!engine || !engine.get(symbol)) return;
  if (tab === "page" && pageDet && pageDet.symbol === symbol) return render();
  if (tab === "page") tab = "feed";
  detail = symbol;
  render();
  $view.scrollTop = 0;
}

function closeDetail() {
  detail = null;
  render();
}

function render({ keepScroll = false, revealed = [] } = {}) {
  if (!engine) return renderOffline();
  const scroll = $view.scrollTop;
  renderTabs();
  const list = [];
  const kids = detail ? viewDetail(list) : tab === "page" ? viewPage(list) : tab === "feed" ? viewFeed(list, revealed) : viewWatch(list);
  $view.replaceChildren(...kids.filter(Boolean));
  if (keepScroll) $view.scrollTop = scroll;
  mount(list);
}

/** No live data: say so (with the API's reason) and retry. Nothing is filled in. */
function renderOffline() {
  mount([]);
  $tabs.replaceChildren();
  $view.replaceChildren(UI.offlineState({ onRetry: () => data.retry() }), UI.disclaimer());
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && detail) {
    e.preventDefault();
    closeDetail();
  }
});

async function init() {
  document.documentElement.dataset.booted = "1";
  renderBar();
  let ready = () => {};
  const firstData = new Promise((resolve) => (ready = resolve));
  data = createDataSession({
    onSignals: ({ added }) => {
      engine = data.engine;
      UI.setData(data.payload);
      if (detail && !engine.get(detail)) detail = null;
      render({ keepScroll: true, revealed: added });
      for (const s of added) {
        const snap = engine.snapshot(s);
        if (snap && snap.direction) P.toast(`New signal: ${s} ${snap.direction === "LONG" ? "▲" : "▼"} ${snap.direction}`, { tone: "ok" });
      }
    },
    onMode: (payload, { modeChanged }) => {
      engine = data.engine;
      UI.setData(payload);
      renderBar();
      if (!engine) return renderOffline();
      if (!booted) return ready();
      if (modeChanged || UI.isLive()) render({ keepScroll: true });
    },
    onTickStatus: (s) => {
      tickStatus = s;
      const el = document.getElementById("feed-meta");
      if (el && engine && engine.live) el.replaceWith(liveMeta());
    },
  });
  try {
    await data.start();
    engine = data.engine;
    UI.setData(data.payload);
    renderBar();
  } catch (err) {
    $view.replaceChildren(
      UI.emptyState({
        title: "Couldn't load market data",
        body: `Live market data didn't load (${err && err.message ? err.message : "unknown error"}).`,
        actions: [UI.button("Retry", { kind: "primary", small: true, onClick: () => location.reload() })],
      }),
    );
    return;
  }
  if (!engine) {
    // Offline: show it, and carry on once live data arrives (lib/live.js retries).
    renderOffline();
    await firstData;
    engine = data.engine;
  }
  [settings, watch] = await Promise.all([P.getSettings(), P.getWatchlist()]);
  const initialTab = P.PARAMS.get("tab");
  if (["page", "feed", "watch"].includes(initialTab)) tab = initialTab;

  let first = true;
  const detectFn = (p) => {
    if (!engine) return null;
    if (p.symbol) return engine.get(p.symbol) ? { site: "preview", siteLabel: "Preview page", symbol: p.symbol, ticker: p.symbol, via: "preview" } : { site: "preview", siteLabel: "Preview page", symbol: null, ticker: p.symbol, via: "preview" };
    const d = engine.detect(p.url, p.title);
    return d.site ? { ...d, url: p.url } : null;
  };
  await P.followActiveTab((det) => {
    const prev = pageDet ? `${pageDet.symbol}|${pageDet.ticker}` : "";
    pageDet = det;
    const next = det ? `${det.symbol}|${det.ticker}` : "";
    if (first) return;
    if (prev !== next && tab === "page" && !detail) render();
    else renderTabs();
  }, detectFn);
  first = false;
  booted = true;
  render();

  P.watchSidepanelFocus((symbol) => {
    if (!engine || !engine.get(symbol)) return;
    if (pageDet && pageDet.symbol === symbol) {
      tab = "page";
      detail = null;
      render();
    } else {
      tab = "feed";
      openDetail(symbol);
    }
  });

  P.storage.onChanged((changes, area) => {
    if (area === "local" && changes.watchlist) {
      watch = Array.isArray(changes.watchlist.newValue) ? changes.watchlist.newValue : [];
      if (tab === "watch" && !detail) render({ keepScroll: true });
      else renderTabs();
    }
    if (area === "sync" && changes.settings) {
      P.getSettings().then((s) => {
        settings = s;
        if (detail || tab === "page") render({ keepScroll: true });
      });
    }
  });
}

init();
