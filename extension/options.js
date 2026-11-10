// Options: web app URL, capital/currency/risk, chip master + per-site toggles.
// Saved to chrome.storage.sync (preview: in-memory, mirrored to localStorage).
import { DEFAULT_SETTINGS, mergeSettings, SITES, CAPITAL_CURRENCIES, safeWebUrl, terminalUrl, formatMoney } from "./lib/engine.js";
import * as P from "./lib/platform.js";
import * as UI from "./lib/ui.js";

const { h } = UI;
const $form = document.getElementById("form");
let saved = null;
let draft = null;
let externalChange = false;

const clone = (o) => JSON.parse(JSON.stringify(o));
const same = (a, b) => JSON.stringify(mergeSettings(a)) === JSON.stringify(mergeSettings(b));

function validate(d) {
  const errors = {};
  if (!safeWebUrl(d.webUrl)) errors.webUrl = "Enter a full http:// or https:// address, e.g. http://localhost:5180";
  if (!(Number(d.capital) > 0)) errors.capital = "Capital must be more than 0.";
  if (!(Number(d.riskPct) >= 0.05 && Number(d.riskPct) <= 10)) errors.riskPct = "Use between 0.05% and 10% per trade.";
  if (!CAPITAL_CURRENCIES.includes(d.currency)) errors.currency = "Pick a currency.";
  return errors;
}

// ------------------------------------------------------------------ render --

let refs = {};

function renderTop() {
  document.getElementById("top").replaceChildren(
    UI.wordmark(),
    UI.demoBadge(),
    h("span", { class: "bar-spacer" }),
    h("span", { class: "eyebrow" }, "v0.1.0"),
  );
  document.getElementById("where").textContent = P.IS_EXTENSION ? "Settings · synced with your Chrome profile" : "Settings · preview mode, saved in this browser only";
}

function section(title, copy, ...body) {
  return h("section", { class: "opt-sec" }, h("div", { class: "opt-sec-head" }, h("h2", {}, title), copy ? h("p", {}, copy) : null), h("div", { class: "opt-sec-body" }, body));
}

function field(label, input, help, errKey) {
  const err = h("p", { class: "oerr", id: `err-${errKey}`, hidden: true });
  refs[`err-${errKey}`] = err;
  input.setAttribute("aria-describedby", `err-${errKey}`);
  return h("label", { class: "ofield" }, h("span", {}, label), input, help ? h("p", { class: "ohelp" }, help) : null, err);
}

function build() {
  refs = {};
  const webUrl = h("input", { type: "url", class: "mono-in", name: "webUrl", value: draft.webUrl, spellcheck: "false", placeholder: DEFAULT_SETTINGS.webUrl });
  const testLink = h("button", { type: "button", class: "link-btn" }, "");
  refs.testLink = testLink;
  testLink.addEventListener("click", () => {
    const url = terminalUrl(draft.webUrl, "RELIANCE");
    if (url) P.openUrl(url);
  });
  webUrl.addEventListener("input", () => {
    draft.webUrl = webUrl.value.trim();
    update();
  });
  refs.webUrl = webUrl;

  const capital = h("input", { type: "number", class: "mono-in", name: "capital", min: "1", step: "any", inputmode: "decimal", value: String(draft.capital) });
  capital.addEventListener("input", () => {
    draft.capital = capital.value === "" ? "" : Number(capital.value);
    update();
  });
  const currency = h("select", { name: "currency" }, CAPITAL_CURRENCIES.map((c) => h("option", { value: c, selected: c === draft.currency }, c)));
  currency.addEventListener("change", () => {
    draft.currency = currency.value;
    update();
  });
  const risk = h("input", { type: "number", class: "mono-in", name: "riskPct", min: "0.05", max: "10", step: "0.05", inputmode: "decimal", value: String(draft.riskPct) });
  risk.addEventListener("input", () => {
    draft.riskPct = risk.value === "" ? "" : Number(risk.value);
    update();
  });
  refs.capital = capital;
  refs.riskPct = risk;
  refs.currency = currency;
  const readout = h("div", { class: "readout", "aria-live": "polite" });
  refs.readout = readout;

  const master = h("input", { type: "checkbox", role: "switch", checked: draft.chipEnabled, "aria-label": "Show chip on supported sites" });
  master.addEventListener("change", () => {
    draft.chipEnabled = master.checked;
    update();
  });
  const siteList = h(
    "ul",
    { class: "sites" },
    SITES.map((s) => {
      const t = h("input", { type: "checkbox", role: "switch", checked: draft.sites[s.key] !== false, "aria-label": `Show chip on ${s.label}` });
      t.addEventListener("change", () => {
        draft.sites[s.key] = t.checked;
        update();
      });
      return h(
        "li",
        { class: "site" },
        h("div", { class: "site-main" }, h("b", {}, s.label), h("span", {}, s.match)),
        h("span", { class: `site-mode${s.mode === "title" ? " is-title" : ""}`, title: s.mode === "title" ? "Detected from the page title" : "Detected from the URL" }, s.mode === "title" ? "TITLE" : "URL"),
        h("span", { class: "switch" }, t, h("i", { "aria-hidden": "true" })),
      );
    }),
  );
  refs.siteList = siteList;

  const watchInfo = h("p", {}, "");
  refs.watchInfo = watchInfo;
  const clearWatch = UI.button("Clear watchlist", {
    small: true,
    onClick: async () => {
      await P.storage.set("local", { watchlist: [] });
      P.toast("Watchlist cleared", { tone: "ok" });
      refreshWatch();
    },
  });
  refs.clearWatch = clearWatch;

  $form.replaceChildren(
    section(
      "Tudumm terminal",
      "“Open terminal” and “Open in Tudumm” open the instrument in the web app.",
      field("Web app URL", webUrl, h("span", {}, "Opens ", h("span", { class: "mono", id: "url-preview" }, ""), ". Test it: ", testLink), "webUrl"),
    ),
    section(
      "Position sizing",
      "Prefills the side panel's position sizer. You can still adjust it per trade there.",
      h("div", { class: "ogrid" }, field("Capital", capital, null, "capital"), field("Currency", currency, null, "currency"), field("Risk per trade (%)", risk, null, "riskPct")),
      readout,
    ),
    section(
      "Chip on supported sites",
      "A small chip appears bottom-right on supported chart and quote pages. The × on a chip hides it for that site; switch it back on here.",
      h("label", { class: "master" }, h("span", { class: "master-text" }, h("b", {}, "Show chip on supported sites"), h("span", {}, "Off hides the chip everywhere. The popup and side panel keep working.")), h("span", { class: "switch" }, master, h("i", { "aria-hidden": "true" }))),
      siteList,
    ),
    section("Data", "Everything stays in your browser. All prices and signals are simulated.", h("div", { class: "data-row" }, watchInfo, clearWatch)),
    UI.disclaimer(),
  );

  const status = h("span", { class: "save-status", role: "status", "aria-live": "polite" }, h("i", { class: "dot" }), h("span", { class: "save-text" }, ""));
  const restore = UI.button("Restore defaults", {
    kind: "ghost",
    onClick: () => {
      draft = clone(mergeSettings(DEFAULT_SETTINGS));
      build();
      update();
      P.toast("Defaults restored. Save to keep them.");
    },
  });
  const save = h("button", { type: "submit", class: "btn btn--primary" }, "Save");
  refs.status = status;
  refs.save = save;
  const bar = document.querySelector(".savebar") || document.body.appendChild(h("div", { class: "savebar" }));
  bar.replaceChildren(h("div", { class: "savebar-in" }, status, restore, save));
}

function setStatus(kind, text) {
  refs.status.className = `save-status${kind ? ` is-${kind}` : ""}`;
  refs.status.querySelector(".save-text").textContent = text;
}

function update() {
  const errors = validate(draft);
  for (const key of ["webUrl", "capital", "riskPct", "currency"]) {
    const err = refs[`err-${key}`];
    if (!err) continue;
    err.hidden = !errors[key];
    err.textContent = errors[key] || "";
    if (refs[key]) refs[key].setAttribute("aria-invalid", errors[key] ? "true" : "false");
  }
  const url = terminalUrl(draft.webUrl, "RELIANCE");
  const prev = document.getElementById("url-preview");
  if (prev) prev.textContent = url ? url.replace(/RELIANCE$/, "{SYMBOL}") : "(invalid URL)";
  refs.testLink.textContent = url ? "open RELIANCE ↗" : "fix the URL first";
  refs.testLink.disabled = !url;

  if (!errors.capital && !errors.riskPct) {
    const amt = Number(draft.capital) * (Number(draft.riskPct) / 100);
    refs.readout.replaceChildren(
      h("span", {}, "Risk per trade ", h("b", {}, formatMoney(amt, draft.currency))),
      h("span", {}, "Capital ", h("b", {}, formatMoney(Number(draft.capital), draft.currency))),
      h("span", {}, "10 losing trades in a row ≈ ", h("b", {}, `−${(100 * (1 - Math.pow(1 - Number(draft.riskPct) / 100, 10))).toFixed(1)}%`)),
    );
  } else refs.readout.replaceChildren(h("span", {}, "Fix the fields above to see your risk per trade."));

  refs.siteList.classList.toggle("is-off", !draft.chipEnabled);
  const dirty = !same(draft, saved);
  const invalid = Object.keys(errors).length > 0;
  refs.save.disabled = !dirty || invalid;
  if (invalid) setStatus("error", "Fix the highlighted field to save.");
  else if (externalChange && dirty) setStatus("dirty", "Changed elsewhere too (e.g. a chip ×). Saving will overwrite it.");
  else if (dirty) setStatus("dirty", "Unsaved changes");
  else if (!refs.status.classList.contains("is-saved")) setStatus("", P.IS_EXTENSION ? "All changes saved to Chrome sync" : "All changes saved (preview)");
}

async function refreshWatch() {
  const list = await P.getWatchlist();
  refs.watchInfo.textContent = list.length ? `Watchlist: ${list.length} instrument${list.length === 1 ? "" : "s"} (${list.join(", ")}).` : "Your watchlist is empty. Star signals in the side panel or popup.";
  refs.clearWatch.disabled = !list.length;
}

async function doSave(e) {
  if (e) e.preventDefault();
  const errors = validate(draft);
  if (Object.keys(errors).length) {
    update();
    const first = Object.keys(errors)[0];
    refs[first]?.focus();
    return;
  }
  const next = mergeSettings({ ...draft, webUrl: safeWebUrl(draft.webUrl), capital: Number(draft.capital), riskPct: Number(draft.riskPct) });
  try {
    await P.saveSettings(next);
    saved = clone(next);
    draft = clone(next);
    externalChange = false;
    refs.webUrl.value = draft.webUrl;
    update();
    const t = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setStatus("saved", `Saved · ${t}`);
    P.toast("Saved", { tone: "ok", timeout: 1800 });
  } catch (err) {
    setStatus("error", `Couldn't save: ${err && err.message ? err.message : "storage error"}`);
  }
}

async function init() {
  document.documentElement.dataset.booted = "1";
  renderTop();
  saved = clone(await P.getSettings());
  draft = clone(saved);
  build();
  update();
  refreshWatch();
  $form.addEventListener("submit", doSave);
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      doSave();
    }
  });
  P.storage.onChanged((changes, area) => {
    if (area === "local" && changes.watchlist) refreshWatch();
    if (area === "sync" && changes.settings) {
      const incoming = mergeSettings(changes.settings.newValue);
      if (same(incoming, saved)) return;
      if (same(draft, saved)) {
        saved = clone(incoming);
        draft = clone(incoming);
        build();
        update();
        refreshWatch();
        setStatus("saved", "Updated from another window");
      } else {
        saved = clone(incoming);
        externalChange = true;
        update();
      }
    }
  });
  addEventListener("beforeunload", (e) => {
    if (!same(draft, saved)) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}

init();
