// Popup: "On this page" SignalCard, alias search, top live signals, detail view.
// Data: the live universe (with Binance ticks for crypto + the PAXG gold proxy)
// from lib/live.js; when it can't load, an explicit offline state with a retry.
import { createDataSession } from "./lib/live.js";
import * as P from "./lib/platform.js";
import * as UI from "./lib/ui.js";

const { h } = UI;
const $bar = document.getElementById("bar");
const $view = document.getElementById("view");
const $foot = document.getElementById("foot");

const live = UI.createLive();
let data = null;
let engine = null;
let page = null;
let detection = null;
let watch = [];
let components = [];
let unsubscribe = null;
let showAll = false;
let query = "";
let detailSymbol = null;
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

function currentSymbol() {
  return detailSymbol || (detection && detection.symbol) || null;
}

function renderFoot() {
  const sidePanelBtn = UI.button("Open side panel", {
    onClick: () => {
      // Called synchronously from the click so Chrome sees the user gesture.
      P.openSidePanel({ windowId: page && page.windowId, focusSymbol: currentSymbol() }).then((ok) => {
        if (ok) window.close();
        else if (P.IS_EXTENSION) P.toast("Chrome didn't open the panel. Right-click the Tudumm icon and choose “Open side panel”.", { tone: "warn", timeout: 5000 });
      });
    },
  });
  const termBtn = UI.button("Open terminal", { kind: "primary", icon: "↗", onClick: () => P.openTerminal(currentSymbol()) });
  termBtn.title = "Opens the Tudumm web terminal for this instrument";
  $foot.replaceChildren(sidePanelBtn, termBtn);
}

// --------------------------------------------------------------- detection --

function detectFor(p) {
  if (!p || !engine) return null;
  if (p.symbol && engine.get(p.symbol)) return { site: "preview", siteLabel: "Preview page", symbol: p.symbol, ticker: p.symbol, via: "preview" };
  if (p.symbol) return { site: "preview", siteLabel: "Preview page", symbol: null, ticker: p.symbol, via: "preview" };
  const d = p.url ? engine.detect(p.url, p.title) : null;
  if (d && d.site) return d;
  if (p.stored && p.stored.site) return p.stored;
  return d;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// ------------------------------------------------------------------- views --

function mount(list) {
  components = list.filter(Boolean);
  if (unsubscribe) unsubscribe();
  unsubscribe = live.subscribe((now) => {
    for (const c of components) c.update(now);
  });
}

function liveSymbols(now = Date.now()) {
  return engine.instruments
    .filter((i) => ["active", "pending", "t1_hit"].includes(engine.signalState(i.symbol, now).status))
    .sort((a, b) => b.signal.confidence - a.signal.confidence || a.symbol.localeCompare(b.symbol))
    .map((i) => i.symbol);
}

function openDetail(symbol) {
  detailSymbol = symbol;
  renderDetail();
  $view.scrollTop = 0;
  $view.focus({ preventScroll: true });
}

function backHome() {
  detailSymbol = null;
  renderHome();
}

function starFor(symbol) {
  return () =>
    UI.starButton(watch.includes(symbol), async () => {
      const res = await P.toggleWatch(symbol);
      watch = await P.getWatchlist();
      if (res.error) P.toast(res.error, { tone: "warn", timeout: 5000 });
      else P.toast(`${symbol} ${res.on ? "added to" : "removed from"} your watchlist${res.synced ? " · synced" : ""}`);
      return res.on;
    });
}

function hereSection(list, animate) {
  const d = detection;
  const head = h(
    "div",
    { class: "section-head" },
    h("span", { class: "eyebrow" }, "On this page"),
    d && d.site
      ? h("span", { class: "here-src" }, h("b", {}, d.site === "preview" ? "preview page" : hostOf(page.url) || d.siteLabel), d.via ? `via ${d.via === "preview" ? "?symbol=" : d.via}` : "")
      : null,
  );
  if (d && d.symbol) {
    const card = UI.createSignalCard(engine, d.symbol, { star: starFor(d.symbol) });
    list.push(card);
    if (animate) requestAnimationFrame(() => card.reveal());
    return h("section", { class: "here" }, head, card.el);
  }
  if (d && d.ticker) {
    return h(
      "section",
      { class: "here" },
      head,
      UI.emptyState({
        title: `${d.ticker} isn't covered yet`,
        body: `Tudumm covers ${engine.instruments.length} instruments across India, the US, Europe, crypto, FX and commodities. Search below to see what is.`,
        actions: [UI.button("Search covered instruments", { small: true, onClick: () => focusSearch() })],
      }),
    );
  }
  return h(
    "section",
    { class: "here" },
    head,
    UI.emptyState({
      title: "No supported symbol on this page",
      body: "Open a quote or chart on one of these sites and Tudumm will read it. Each opens an example page:",
      actions: [UI.siteList((url) => P.openUrl(url))],
    }),
  );
}

function focusSearch() {
  const input = $view.querySelector(".search input");
  if (input) {
    input.scrollIntoView({ block: "center" });
    input.focus();
  }
}

function searchSection() {
  const input = h("input", {
    type: "search",
    placeholder: `Search ${engine.instruments.length} instruments: symbol, name or alias`,
    "aria-label": "Search instruments by symbol, name or alias",
    value: query,
    autocomplete: "off",
    spellcheck: "false",
  });
  const clear = h("button", { type: "button", class: "search-clear", "aria-label": "Clear search", hidden: !query }, "×");
  input.addEventListener("input", () => {
    query = input.value.trim();
    clear.hidden = !query;
    renderResults();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && input.value) {
      e.preventDefault();
      input.value = "";
      query = "";
      clear.hidden = true;
      renderResults();
    }
    if (e.key === "Enter") {
      const first = engine.search(input.value)[0];
      if (first) openDetail(first.symbol);
    }
  });
  clear.addEventListener("click", () => {
    input.value = "";
    query = "";
    clear.hidden = true;
    renderResults();
    input.focus();
  });
  const tryBtn = (q) =>
    h("button", {
      type: "button",
      class: "try",
      title: `Search “${q}”`,
      onclick: () => {
        input.value = q;
        query = q;
        clear.hidden = false;
        renderResults();
        input.focus();
      },
    }, q);
  return h("section", { class: "search-wrap" }, h("div", { class: "search" }, UI.iconSearch(), input, clear), h("p", { class: "search-hint" }, "Try ", tryBtn("RELIANCE.NS"), " ", tryBtn("BTC-USD"), " ", tryBtn("^NSEI"), " or ", tryBtn("gold"), "."));
}

function topSection(list, revealed = []) {
  const syms = liveSymbols();
  const shown = showAll ? syms : syms.slice(0, 6);
  const rows = shown.map((s, i) => {
    const r = UI.createRow(engine, s, { onOpen: openDetail, index: i });
    list.push(r);
    if (revealed.includes(s)) requestAnimationFrame(() => UI.playReveal(r.el));
    return r.el;
  });
  const more =
    syms.length > 6
      ? UI.button(showAll ? "Show top 6" : `Show all ${syms.length} live signals`, {
          kind: "ghost",
          small: true,
          onClick: () => {
            showAll = !showAll;
            renderHome({ keepScroll: true });
          },
        })
      : null;
  if (more) more.classList.add("more");
  return h(
    "section",
    { class: "top", id: "results" },
    h("div", { class: "section-head" }, h("span", { class: "eyebrow" }, `Open signals · ${syms.length}`), UI.engineTag({ small: true })),
    syms.length
      ? h("div", { class: `rows${revealed.length ? "" : " stagger"}` }, rows)
      : UI.emptyState({ icon: false, title: "Sitting out everywhere", body: `No open setups right now. Engine v0 checks every instrument after each completed bar and only issues a call when the layers line up. Search above to see each instrument's reason.` }),
    more,
  );
}

function resultsSection(list) {
  const res = engine.search(query);
  const rows = res.map((inst, i) => {
    const r = UI.createRow(engine, inst.symbol, { onOpen: openDetail, index: i });
    list.push(r);
    return r.el;
  });
  return h(
    "section",
    { class: "top", id: "results", "aria-live": "polite" },
    h("div", { class: "section-head" }, h("span", { class: "eyebrow" }, `Results for “${query}”`), h("span", { class: "eyebrow-aux mono" }, `${res.length} found`)),
    res.length
      ? h("div", { class: "rows" }, rows)
      : UI.emptyState({ icon: false, title: "No match", body: `Nothing matches “${query}”. Tudumm covers ${engine.instruments.length} instruments: try a ticker, a name, or an alias such as RELIANCE.NS or EURUSD=X.` }),
  );
}

function renderResults() {
  const list = components.filter((c) => !c.el || !c.el.closest || !c.el.closest("#results"));
  const old = $view.querySelector("#results");
  const next = query ? resultsSection(list) : topSection(list);
  if (old) old.replaceWith(next);
  mount(list);
}

function renderHome({ keepScroll = false, revealed = [], animate = false } = {}) {
  if (!engine) return renderOffline();
  const scroll = $view.scrollTop;
  const list = [];
  const kids = [hereSection(list, animate || (detection && revealed.includes(detection.symbol))), searchSection(), query ? resultsSection(list) : topSection(list, revealed), UI.disclaimer()];
  $view.replaceChildren(...kids.filter(Boolean));
  if (keepScroll) $view.scrollTop = scroll;
  mount(list);
  renderFoot();
}

/** No live data: say so (with the API's reason) and retry. Nothing is filled in. */
function renderOffline() {
  mount([]);
  $view.replaceChildren(UI.offlineState({ onRetry: () => data.retry() }), UI.disclaimer());
}

function renderDetail() {
  const sym = detailSymbol;
  const inst = engine.get(sym);
  const list = [];
  const card = UI.createSignalCard(engine, sym, { star: starFor(sym) });
  list.push(card);
  const sit = inst.signal.status === "sit_out";
  $view.replaceChildren(
    h(
      "div",
      { class: "detail-bar" },
      h("button", { type: "button", class: "btn btn--ghost btn--sm", onclick: backHome, "aria-label": "Back to overview" }, UI.iconBack(), "Back"),
      h("span", { class: "eyebrow" }, `${inst.exchange} · ${inst.market}`),
    ),
    card.el,
    UI.layerBreakdown(engine, sym),
    UI.setupFacts(engine, sym),
    h(
      "div",
      { class: "detail-actions" },
      sit
        ? null
        : UI.button("Size this trade in the side panel", {
            onClick: () => {
              P.openSidePanel({ windowId: page && page.windowId, focusSymbol: sym }).then((ok) => {
                if (ok) window.close();
                else if (P.IS_EXTENSION) P.toast("Chrome didn't open the panel. Right-click the Tudumm icon and choose “Open side panel”.", { tone: "warn", timeout: 5000 });
              });
            },
          }),
    ),
    UI.disclaimer(),
  );
  requestAnimationFrame(() => card.reveal());
  mount(list);
  renderFoot();
}

function renderError(err) {
  $view.replaceChildren(
    UI.emptyState({
      title: "Couldn't load market data",
      body: `Live market data didn't load (${err && err.message ? err.message : "unknown error"}). Reload the extension from chrome://extensions, or retry.`,
      actions: [UI.button("Retry", { kind: "primary", small: true, onClick: () => location.reload() })],
    }),
  );
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && detailSymbol) {
    e.preventDefault();
    backHome();
  }
  if (e.key === "/" && !detailSymbol && document.activeElement?.tagName !== "INPUT") {
    e.preventDefault();
    focusSearch();
  }
});

async function init() {
  document.documentElement.dataset.booted = "1";
  renderBar();
  renderFoot();
  let ready = () => {};
  const firstData = new Promise((resolve) => (ready = resolve));
  data = createDataSession({
    onSignals: ({ added }) => {
      engine = data.engine;
      UI.setData(data.payload);
      if (detailSymbol && !engine.get(detailSymbol)) detailSymbol = null;
      if (detailSymbol) renderDetail();
      else renderHome({ keepScroll: true, revealed: added });
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
      if (!modeChanged && !UI.isLive()) return;
      detection = detectFor(page);
      if (detailSymbol && engine.get(detailSymbol)) renderDetail();
      else {
        detailSymbol = null;
        renderHome({ keepScroll: true });
      }
    },
  });
  try {
    await data.start();
    engine = data.engine;
    UI.setData(data.payload);
    renderBar();
  } catch (err) {
    renderError(err);
    return;
  }
  if (!engine) {
    // Offline: show it, and carry on once live data arrives (lib/live.js retries).
    renderOffline();
    await firstData;
    engine = data.engine;
  }
  [page, watch] = await Promise.all([P.getActivePage(), P.getWatchlist()]);
  detection = detectFor(page);
  if (P.IS_EXTENSION && page && detection && detection.site && detection.site !== "preview") P.rememberTabDetection(page.tabId, { ...detection, url: page.url });
  const focus = P.PARAMS.get("detail");
  booted = true;
  if (focus && engine.get(focus.toUpperCase())) openDetail(focus.toUpperCase());
  else renderHome({ animate: true });

  P.onPreviewPage((data) => {
    page = { ...page, url: data.url || "", title: data.title || "", symbol: data.symbol || null };
    detection = detectFor(page);
    detailSymbol = null;
    renderHome({ animate: true });
  });
  P.storage.onChanged((changes, area) => {
    if (area === "local" && changes.watchlist) watch = Array.isArray(changes.watchlist.newValue) ? changes.watchlist.newValue : [];
  });
}

init();
