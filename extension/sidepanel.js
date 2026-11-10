// Side panel: "This page" (follows the active tab), "Feed" (all signals with
// market filters + queued reveals), "Watchlist", and a detail view with sizer.
import { loadSeed, createEngine, formatR, formatPct } from "./lib/engine.js";
import * as P from "./lib/platform.js";
import * as UI from "./lib/ui.js";

const { h } = UI;
const $bar = document.getElementById("bar");
const $tabs = document.getElementById("tabs");
const $view = document.getElementById("view");

const live = UI.createLive();
let engine = null;
let settings = null;
let watch = [];
let tab = "page"; // page | feed | watch
let detail = null; // symbol shown in detail view (feed / watchlist)
let market = "ALL";
let pageDet = null;
let components = [];
let unsubscribe = null;
let lastKey = "";
let revealedNotice = null;

// ------------------------------------------------------------------ chrome --

function renderBar() {
  $bar.replaceChildren(
    UI.wordmark(),
    UI.demoBadge(),
    h("span", { class: "bar-spacer" }),
    h("button", { type: "button", class: "icon-btn", title: "Options", "aria-label": "Open options", onclick: () => P.openOptions() }, UI.iconGear()),
  );
}

function renderTabs() {
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
    checkReveals(now);
  });
}

// ----------------------------------------------------------------- helpers --

const statusOf = (s, now) => engine.signalState(s, now).status;

function queued(now = Date.now()) {
  return engine.instruments
    .filter((i) => statusOf(i.symbol, now) === "queued")
    .sort((a, b) => a.signal.revealAfterSec - b.signal.revealAfterSec)
    .map((i) => i.symbol);
}

function checkReveals(now) {
  const key = queued(now).join(",");
  if (key === lastKey) return;
  const before = lastKey ? lastKey.split(",") : [];
  lastKey = key;
  const gone = before.filter((s) => s && !key.split(",").includes(s));
  if (!gone.length) return;
  for (const s of gone) {
    const snap = engine.snapshot(s, now);
    revealedNotice = { symbol: s, until: now + 6000 };
    P.toast(`${s} revealed: ${snap.direction === "LONG" ? "▲" : "▼"} ${snap.direction} ${snap.confidencePct}% · ${snap.statusText}`, { tone: "ok" });
  }
  if (tab === "feed" && !detail) render({ keepScroll: true, revealed: gone });
}

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
      const on = await P.toggleWatch(symbol);
      watch = await P.getWatchlist();
      renderTabs();
      P.toast(on ? `${symbol} added to your watchlist` : `${symbol} removed from your watchlist`);
      return on;
    });
}

function detailBlock(symbol, list, { reveal = true } = {}) {
  const inst = engine.get(symbol);
  const card = UI.createSignalCard(engine, symbol, { star: starFor(symbol) });
  list.push(card);
  if (reveal) requestAnimationFrame(() => card.reveal());
  const sit = inst.signal.status === "sit_out";
  const sizerSlot = h("div", { class: "sizer-slot" });
  const placeSizer = () => {
    sizerSlot.replaceChildren(
      sit
        ? UI.emptyState({ icon: false, title: "No position to size", body: "Tudumm is sitting out on this instrument, so there is no entry, stop or target to size against." })
        : engine.signalState(symbol).status === "queued"
          ? UI.emptyState({ icon: false, title: "Sizer unlocks on reveal", body: "Levels are published the moment this signal reveals." })
          : UI.createSizer(engine, symbol, settings, { onEditDefaults: () => P.openOptions() }),
    );
  };
  placeSizer();
  if (!sit && engine.signalState(symbol).status === "queued") {
    let done = false;
    list.push({
      update(now) {
        if (!done && engine.signalState(symbol, now).status !== "queued") {
          done = true;
          placeSizer();
        }
      },
    });
  }
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
    d && d.site ? h("span", { class: "here-src" }, h("b", {}, d.site === "preview" ? "simulated page" : hostOf(d.url) || d.siteLabel), d.via ? `via ${d.via === "preview" ? "?symbol=" : d.via}` : "") : null,
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
          body: `This prototype covers ${engine.instruments.length} instruments across six markets. The feed shows every one of them.`,
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

function drumroll(list) {
  const q = queued();
  const now = Date.now();
  if (!q.length) {
    if (revealedNotice && revealedNotice.until > now) {
      const s = engine.snapshot(revealedNotice.symbol);
      return h(
        "div",
        { class: "drumroll is-done", role: "status" },
        UI.logoMark({ size: 30 }),
        h("div", {}, h("span", { class: "eyebrow" }, "Revealed"), h("div", { class: "drumroll-time" }, `${s.confidencePct}%`)),
        h("div", { class: "drumroll-what" }, h("b", {}, `${s.symbol} ${s.direction === "LONG" ? "▲" : "▼"} ${s.direction}`), h("span", {}, s.statusText)),
      );
    }
    return null;
  }
  const sym = q[0];
  const time = h("div", { class: "drumroll-time" }, engine.snapshot(sym).countdown);
  list.push({
    update(n) {
      const s = engine.snapshot(sym, n);
      if (s.countdown) time.textContent = s.countdown;
    },
  });
  return h(
    "button",
    { type: "button", class: "drumroll", style: { textAlign: "left", appearance: "none", color: "inherit", width: "100%", font: "inherit" }, onclick: () => openDetail(sym), "aria-label": `Next reveal ${sym}. Open details.` },
    UI.logoMark({ size: 30, drum: true }),
    h("div", {}, h("span", { class: "eyebrow" }, "Next reveal in"), time),
    h("div", { class: "drumroll-what" }, h("b", {}, sym), h("span", {}, `${engine.get(sym).name}${q.length > 1 ? ` · +${q.length - 1} queued` : ""}`)),
  );
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
  const q = inMarket.filter((i) => statusOf(i.symbol, now) === "queued").sort((a, b) => a.signal.revealAfterSec - b.signal.revealAfterSec);
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
    drumroll(list),
    q.length || liveSigs.length
      ? h(
          "section",
          {},
          h("div", { class: "section-head" }, h("span", { class: "eyebrow" }, "Live signals"), h("span", { class: "eyebrow-aux mono" }, `${liveSigs.length} live${q.length ? ` · ${q.length} queued` : ""} · by confidence`)),
          h("div", { class: `rows${animate ? " stagger" : ""}` }, rowsFor(q), rowsFor(liveSigs)),
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
    !q.length && !liveSigs.length && !sits.length ? UI.emptyState({ icon: false, title: "Nothing in this market", body: "Pick another market above." }) : null,
    ledgerPanel(),
    UI.disclaimer(),
  ];
}

function ledgerPanel() {
  const st = engine.ledgerStats();
  const kpi = (k, v) => h("div", { class: "kpi" }, h("dt", {}, k), h("dd", {}, v));
  return h(
    "section",
    { class: "ledger", "aria-label": "Track record" },
    h("span", { class: "eyebrow" }, "Simulated demo ledger"),
    h("h3", {}, "Every call on the record."),
    h(
      "dl",
      { class: "ledger-kpis", style: { margin: 0 } },
      kpi("Closed calls", String(st.count)),
      kpi("Win rate", formatPct(st.winRate, 1).replace("+", "")),
      kpi("Expectancy", formatR(st.expectancy)),
    ),
    h("p", { class: "ledger-head", style: { margin: 0 } }, `Hash-chained (SHA-256) · head ${st.head ? st.head.slice(0, 12) : "—"}…`),
    UI.button("Verify the chain in the terminal", { small: true, icon: "↗", onClick: () => P.openTerminal(null, "/app/proof") }),
  );
}

function viewWatch(list) {
  const items = watch.filter((s) => engine.get(s));
  if (!items.length) {
    return [
      UI.emptyState({
        title: "Your watchlist is empty",
        body: "Tap the star on any signal to keep it here. It's stored in this browser only.",
        actions: [UI.button("Browse the feed", { kind: "primary", small: true, onClick: () => setTab("feed") })],
      }),
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
  if (!engine.get(symbol)) return;
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
  if (!engine) return;
  const scroll = $view.scrollTop;
  renderTabs();
  const list = [];
  const kids = detail ? viewDetail(list) : tab === "page" ? viewPage(list) : tab === "feed" ? viewFeed(list, revealed) : viewWatch(list);
  $view.replaceChildren(...kids.filter(Boolean));
  if (keepScroll) $view.scrollTop = scroll;
  lastKey = queued().join(",");
  mount(list);
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
  try {
    engine = createEngine(await loadSeed());
  } catch (err) {
    $view.replaceChildren(
      UI.emptyState({
        title: "Couldn't load the demo data",
        body: `The bundled seed file didn't load (${err && err.message ? err.message : "unknown error"}).`,
        actions: [UI.button("Retry", { kind: "primary", small: true, onClick: () => location.reload() })],
      }),
    );
    return;
  }
  [settings, watch] = await Promise.all([P.getSettings(), P.getWatchlist()]);
  const initialTab = P.PARAMS.get("tab");
  if (["page", "feed", "watch"].includes(initialTab)) tab = initialTab;

  let first = true;
  const detectFn = (p) => {
    if (p.symbol) return engine.get(p.symbol) ? { site: "preview", siteLabel: "Simulated page", symbol: p.symbol, ticker: p.symbol, via: "preview" } : { site: "preview", siteLabel: "Simulated page", symbol: null, ticker: p.symbol, via: "preview" };
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
  render();

  P.watchSidepanelFocus((symbol) => {
    if (!engine.get(symbol)) return;
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
