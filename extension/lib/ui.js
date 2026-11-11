// Shared DOM renderers: Logo, DirectionPill, StatusPill, TradeMap, ConfluenceMeter,
// SignalCard, compact rows, layer breakdown and the position sizer.
// Used by the popup, the side panel and the preview page so a signal looks
// identical on every surface.

import {
  LAYERS,
  SITES,
  AGREE_THRESHOLD,
  REGIME_TEXT,
  STYLE_TEXT,
  STATUS_TEXT,
  formatLevel,
  formatMoney,
  formatNumber,
  formatR,
  naReason,
  ENGINE_TAG,
  ENGINE_HELP,
} from "./engine.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const motionQuery = globalThis.matchMedia ? matchMedia("(prefers-reduced-motion: reduce)") : null;
export const reducedMotion = () => !!(motionQuery && motionQuery.matches);

// ------------------------------------------------------------- helpers --

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? "" : v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function svg(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  for (const c of children) el.appendChild(c);
  return el;
}

const pct = (n) => `${n.toFixed(2)}%`;

// ---------------------------------------------------------------- Logo --

/** The two-beat mark: a small dot (ta…) then a larger dot set higher and right (DUMM). */
export function logoMark({ size = 18, drum = false, title = null } = {}) {
  const el = svg(
    "svg",
    { viewBox: "0 0 32 32", width: size, height: size, class: `mark${drum ? " mark--drum" : ""}`, "aria-hidden": title ? "false" : "true", focusable: "false" },
    svg("circle", { class: "mark-ta", cx: "10.125", cy: "20.375", r: "2.75" }),
    svg("circle", { class: "mark-dumm", cx: "19.125", cy: "14.375", r: "5.5" }),
  );
  if (title) {
    el.setAttribute("role", "img");
    el.appendChild(svg("title", {})).textContent = title;
  }
  return el;
}

export function wordmark() {
  return h("span", { class: "wordmark", "aria-label": "tudumm" }, logoMark({ size: 20 }), h("span", { class: "wordmark-text", "aria-hidden": "true" }, "tudumm"));
}

// ------------------------------------------------------- Data state --
// The current data payload ({ mode: "live"|"offline", reason, reasonText, stale, … })
// so badges and notices on every surface say honestly what they show.

let dataState = { mode: "offline", reason: null, reasonText: null, stale: false, recorded: false, retryInMs: null };

export function setData(payload) {
  if (payload) dataState = { mode: payload.mode === "live" && payload.universe ? "live" : "offline", reason: payload.reason || null, reasonText: payload.reasonText || null, stale: !!payload.stale, recorded: !!payload.recorded, retryInMs: payload.retryInMs || null };
}
export const isLive = () => dataState.mode === "live";

/** "LIVE · BETA" / "LIVE · STALE" / "OFFLINE" for the top bar. */
export function dataBadge() {
  if (dataState.mode === "live") {
    const stale = dataState.stale;
    return h(
      "span",
      {
        class: `data-badge data-badge--live${stale ? " is-stale" : ""}`,
        title: stale
          ? `Live data, but the last refresh failed: ${dataState.reasonText || "the API didn't answer"} Prices show when they were last updated.`
          : dataState.recorded
            ? "Preview: a recorded live snapshot. Crypto and the PAXG gold proxy still stream from Binance; other prices stay at their recorded time, shown on each price."
            : "Live market data from free public sources. Each price shows its freshness: real-time, 15-min delayed, end of day or daily reference.",
      },
      h("i", { class: "data-dot", "aria-hidden": "true" }),
      stale ? "LIVE · STALE" : dataState.recorded ? "LIVE · RECORDED" : "LIVE · BETA",
    );
  }
  return h(
    "span",
    { class: "data-badge data-badge--offline", title: `No live data right now: ${dataState.reasonText || "the Tudumm API didn't answer."} Retrying automatically.` },
    h("i", { class: "data-dot", "aria-hidden": "true" }),
    "OFFLINE",
  );
}

/**
 * The full-view state while there is no live data: the API's reason and a retry.
 * Nothing is filled in: no bundled data set, no made-up prices.
 */
export function offlineState({ onRetry } = {}) {
  const secs = dataState.retryInMs ? Math.round(dataState.retryInMs / 1000) : null;
  const retry = onRetry
    ? h(
        "button",
        {
          type: "button",
          class: "btn btn--primary btn--sm",
          onclick: async (e) => {
            const b = e.currentTarget;
            b.disabled = true;
            b.textContent = "Retrying…";
            try {
              await onRetry();
            } finally {
              b.disabled = false;
              b.textContent = "Retry now";
            }
          },
        },
        "Retry now",
      )
    : null;
  return h(
    "div",
    { class: "notice notice--offline", role: "status", "aria-live": "polite" },
    h("b", {}, "Live data temporarily unavailable — retrying."),
    " ",
    dataState.reasonText || "Can't reach Tudumm.",
    h("span", { class: "notice-fine" }, ` Tudumm shows only real market data: prices and calls appear as soon as the API answers.${secs ? ` Next attempt in about ${secs} s.` : ""}`),
    retry ? h("div", { class: "notice-actions" }, retry) : null,
  );
}

/** Engine v0 honesty tag for live signals. */
export function engineTag({ small = false } = {}) {
  return h("span", { class: `engine-tag${small ? " engine-tag--sm" : ""}`, title: ENGINE_HELP, tabindex: "0", "aria-label": `${ENGINE_TAG}. ${ENGINE_HELP}` }, ENGINE_TAG);
}

/**
 * The freshness badge every live price carries: "REAL-TIME · BINANCE · as of 14:32".
 * Proxies are labelled ("PAXG PROXY FOR GOLD"). Null for a snapshot without live data.
 */
export function freshBadge(snap) {
  if (!snap || !snap.live) return null;
  const when = snap.hasPrice ? snap.asOfText : "no price yet";
  return h(
    "span",
    { class: "fresh-wrap" },
    h(
      "span",
      { class: `fresh mono${snap.stale ? " is-stale" : ""}${snap.freshness === "realtime" ? " is-rt" : ""}`, title: snap.freshnessHelp || "", "data-fresh": "" },
      snap.freshnessText || "SOURCE UNKNOWN",
      when ? h("span", { class: "fresh-when", "data-asof": "" }, `· ${when}`) : null,
      snap.stale && snap.hasPrice ? h("span", { class: "fresh-stale" }, "· STALE") : null,
    ),
    snap.proxyText ? h("span", { class: "fresh proxy mono", title: snap.freshnessHelp || "" }, snap.proxyText) : null,
  );
}

export function disclaimer() {
  return h(
    "p",
    { class: "disclaimer" },
    "Tudumm is in beta. Signals are probabilistic and not investment advice. Trading involves risk of loss. Live signals come from engine v0, which is rule-based and uncalibrated.",
  );
}

// --------------------------------------------------------------- Pills --

export function dirPill(direction, { small = false } = {}) {
  if (!direction) return null;
  const long = direction === "LONG";
  return h("span", { class: `dir dir--${long ? "long" : "short"}${small ? " dir--sm" : ""}` }, h("span", { "aria-hidden": "true" }, long ? "▲" : "▼"), ` ${direction}`);
}

export function statusPill(status) {
  return h("span", { class: `status status--${status}` }, h("i", { class: "status-dot", "aria-hidden": "true" }), STATUS_TEXT[status] || status);
}

export function chip(text, extra = "") {
  return h("span", { class: `chip ${extra}`.trim() }, text);
}

// ----------------------------------------------------------- Trade Map --

export function tradeMap(map, { compact = false, levels = null } = {}) {
  if (!map) return null;
  const zoneW = Math.max(map.entry.pos1 - map.entry.pos0, 1.2);
  const stopPos = map.breakeven ? map.entry.pos : map.stop.pos;
  const aria = levels
    ? `Trade map. Stop ${levels.stop}${map.breakeven ? " moved to breakeven" : ""}, entry ${levels.entry}, target 1 ${levels.t1} (${map.t1.rText}), target 2 ${levels.t2} (${map.t2.rText}).`
    : "Trade map";
  const track = h(
    "div",
    { class: "tmap-track" },
    h("div", { class: "tmap-risk", style: { left: pct(stopPos), width: pct(Math.max(map.entry.pos - stopPos, 0)) } }),
    h("div", { class: "tmap-reward", style: { left: pct(map.entry.pos), width: pct(map.t2.pos - map.entry.pos) } }),
    h("div", { class: "tmap-zone", style: { left: pct(map.entry.pos0), width: pct(zoneW) } }),
    map.breakeven ? h("i", { class: "tmap-tick tmap-tick--ghost", style: { left: pct(map.stop.pos) } }) : null,
    h("i", { class: "tmap-tick tmap-tick--sl", style: { left: pct(stopPos) } }),
    h("i", { class: "tmap-tick tmap-tick--t", style: { left: pct(map.t1.pos) } }),
    h("i", { class: "tmap-tick tmap-tick--t", style: { left: pct(map.t2.pos) } }),
    h("div", { class: "tmap-needle", style: { left: pct(map.needle ? map.needle.pos : map.entry.pos) } }, h("i", { class: "tmap-needle-head" })),
  );
  if (compact) return h("div", { class: "tmap tmap--compact", "aria-hidden": "true" }, track);

  const lbl = (pos, text, cls = "") => h("span", { class: `tmap-lbl ${cls}`.trim(), style: { left: pct(pos) } }, text);
  return h(
    "div",
    { class: `tmap${map.pending ? " tmap--pending" : ""}`, role: "img", "aria-label": aria },
    h(
      "div",
      { class: "tmap-row tmap-row--top", "aria-hidden": "true" },
      lbl(stopPos, map.breakeven ? "SL·BE" : "SL", "is-sl"),
      lbl((map.entry.pos0 + map.entry.pos1) / 2, "ENTRY"),
      lbl(map.t1.pos, "T1", "is-t"),
      lbl(map.t2.pos, "T2", "is-t"),
    ),
    track,
    h(
      "div",
      { class: "tmap-row tmap-row--bottom mono", "aria-hidden": "true" },
      map.breakeven ? lbl(map.stop.pos, "−1R", "is-ghost") : lbl(map.stop.pos, "−1R"),
      lbl(map.entry.pos, "0"),
      lbl(map.t1.pos, map.t1.rText),
      lbl(map.t2.pos, map.t2.rText),
    ),
  );
}

export function setNeedle(root, map) {
  const n = root && root.querySelector(".tmap-needle");
  if (n && map && map.needle) n.style.left = pct(map.needle.pos);
}

// ---------------------------------------------------- Confluence Meter --

function segState(score) {
  if (score == null) return "na";
  if (score >= AGREE_THRESHOLD) return "agree";
  if (score > 0) return "weak";
  if (score < 0) return "disagree";
  return "flat";
}

export function confluenceMeter(conf, { muted = false, mini = false } = {}) {
  const segs = conf.rows.map((r) => {
    const st = segState(r.score);
    const w = r.score == null ? 100 : Math.min(100, Math.abs(r.score));
    const bar = h("div", { class: "cm-bar" }, st === "na" ? h("span", { class: "cm-na" }, "N/A") : h("i", { class: "cm-fill", style: { width: `${w}%` } }));
    if (mini) return h("div", { class: "cm-seg", dataset: { state: st } }, bar);
    return h(
      "div",
      { class: "cm-seg", dataset: { state: st }, title: `${r.label}: ${r.score == null ? "not applicable" : (r.score > 0 ? "+" : "") + r.score}` },
      bar,
      h("div", { class: "cm-meta" }, h("span", { class: "cm-lbl" }, r.short), h("span", { class: "cm-val mono" }, r.score == null ? "N/A" : `${r.score > 0 ? "+" : ""}${r.score}`)),
    );
  });
  const label = `Confluence: ${conf.agree} of ${conf.total} layers agree${conf.na ? `, ${conf.na} not applicable` : ""}`;
  if (mini) return h("div", { class: `cm cm--mini${muted ? " cm--muted" : ""}`, role: "img", "aria-label": label }, h("div", { class: "cm-grid" }, segs));
  return h(
    "section",
    { class: `cm${muted ? " cm--muted" : ""}`, "aria-label": label },
    h("div", { class: "cm-head" }, h("span", { class: "eyebrow" }, "Confluence"), h("span", { class: "cm-sum mono" }, `${conf.agree}/${conf.total} agree${conf.na ? ` · ${conf.na} N/A` : ""}`)),
    h("div", { class: "cm-grid" }, segs),
  );
}

// ------------------------------------------------------------ Motion --

export function countUp(el, to, { duration = 760, delay = 220, suffix = "" } = {}) {
  const final = `${to}${suffix}`;
  // The final value is always in the DOM first: if animation frames are throttled
  // (background tab, hidden frame, headless), the number still reads correctly.
  el.textContent = final;
  if (reducedMotion() || document.visibilityState === "hidden") return;
  let started = null;
  let done = false;
  const finish = () => {
    done = true;
    el.textContent = final;
  };
  const step = (now) => {
    if (done) return;
    if (started == null) started = now + delay;
    const t = Math.min(1, Math.max(0, (now - started) / duration));
    const e = 1 - Math.pow(1 - t, 3);
    el.textContent = `${Math.round(to * e)}${suffix}`;
    if (t < 1) requestAnimationFrame(step);
    else finish();
  };
  requestAnimationFrame(step);
  setTimeout(finish, delay + duration + 250);
}

export function playReveal(el) {
  if (reducedMotion() || !el) return;
  el.classList.remove("is-revealing");
  void el.offsetWidth;
  el.classList.add("is-revealing");
  setTimeout(() => el.classList.remove("is-revealing"), 1500);
  const num = el.querySelector("[data-conf]");
  if (num) countUp(num, Number(num.dataset.conf));
}

export function flash(el, dir) {
  if (!el || !dir || reducedMotion()) return;
  el.classList.remove("flash-up", "flash-down");
  void el.offsetWidth;
  el.classList.add(dir > 0 ? "flash-up" : "flash-down");
}

// ----------------------------------------------------------- Live hub --

/** One shared timer per page; subscribers get (now) about 5×/second. */
export function createLive() {
  const subs = new Set();
  let timer = null;
  const tick = () => {
    const now = Date.now();
    for (const fn of subs) {
      try {
        fn(now);
      } catch (err) {
        console.error(err);
      }
    }
  };
  return {
    subscribe(fn) {
      subs.add(fn);
      if (!timer) timer = setInterval(tick, 200);
      return () => {
        subs.delete(fn);
        if (!subs.size && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
  };
}

// ---------------------------------------------------------- SignalCard --

function changeEl(snap) {
  const up = snap.changePct > 0;
  const down = snap.changePct < 0;
  return h("span", { class: `sc-chg mono ${up ? "is-up" : down ? "is-down" : ""}` }, up ? "▲ " : down ? "▼ " : "", snap.changeText);
}

function levelsRow(levels) {
  const item = (k, v, cls = "") => h("div", { class: `lv ${cls}`.trim() }, h("dt", {}, k), h("dd", { class: "mono" }, v));
  return h("dl", { class: "levels" }, item("Entry", levels.entry, "lv--entry"), item("SL", levels.stop, "lv--sl"), item("T1", levels.t1, "lv--t"), item("T2", levels.t2, "lv--t"), item("R:R", levels.rr, "lv--rr"));
}

function cardHead(snap, { star } = {}) {
  return h(
    "header",
    { class: "sc-head" },
    h(
      "div",
      { class: "sc-title" },
      h("span", { class: "sc-sym mono" }, snap.symbol),
      h("span", { class: "sc-name" }, snap.name),
      star || null,
    ),
    h(
      "div",
      { class: "sc-meta" },
      chip(snap.exchange),
      snap.timeframe ? chip(snap.timeframe, "mono") : chip(REGIME_TEXT[snap.regime] || snap.regime),
      h("span", { class: "sc-ago mono", "data-ago": "" }, snap.issuedText),
      chip(`#${snap.id}`, "chip--id mono"),
    ),
  );
}

function buildCardBody(snap, opts) {
  const kids = [];
  if (snap.status === "sit_out") {
    kids.push(
      cardHead(snap, opts),
      h("div", { class: "sc-sit" }, h("h3", { class: "sc-sit-title" }, "Sitting out"), statusPill("sit_out")),
      h("div", { class: "sc-live" }, h("span", { class: "sc-price mono", "data-price": "" }, snap.priceText), changeEl(snap)),
      freshBadge(snap),
      h("p", { class: "sc-reason" }, snap.thesis),
      confluenceMeter(snap.confluence, { muted: true }),
      h("p", { class: "sc-note" }, `No levels published. ${REGIME_TEXT[snap.regime] || snap.regime || ""} regime. Tudumm only issues a setup when the layers line up.`),
    );
    return kids;
  }
  const live = snap.status === "active" || snap.status === "t1_hit";
  kids.push(
    cardHead(snap, opts),
    h(
      "div",
      { class: "sc-verdict" },
      dirPill(snap.direction),
      h(
        "div",
        { class: "sc-conf" },
        h("span", { class: "sc-conf-num mono" }, h("span", { "data-conf": snap.confidencePct }, String(snap.confidencePct)), h("small", {}, "%")),
        h("span", { class: "sc-conf-lbl" }, "confidence"),
      ),
      statusPill(snap.status),
    ),
    snap.live ? h("div", { class: "sc-engine" }, engineTag()) : null,
    h(
      "div",
      { class: "sc-live" },
      h("span", { class: "sc-price mono", "data-price": "" }, snap.priceText),
      changeEl(snap),
      live
        ? h("span", { class: `sc-ur mono ${snap.r >= 0 ? "is-up" : "is-down"}`, "data-r": "", title: "Unrealized move in R (multiples of initial risk)" }, snap.rText)
        : snap.status === "pending"
          ? h("span", { class: "sc-ur sc-ur--pending mono" }, "awaiting entry")
          : null,
    ),
    freshBadge(snap),
    tradeMap(snap.map, { levels: snap.levels }),
    levelsRow(snap.levels),
    confluenceMeter(snap.confluence),
    h("p", { class: "sc-why" }, snap.thesis),
    snap.invalidation ? h("p", { class: "sc-inv" }, h("span", { class: "sc-inv-lbl" }, "Invalidated if:"), ` ${snap.invalidation}`) : null,
  );
  return kids;
}

/**
 * A live SignalCard. Re-renders itself (with the Reveal) when the signal's status
 * changes, updates price / R / needle on real ticks, and refreshes "ago".
 */
export function createSignalCard(engine, symbol, opts = {}) {
  const el = h("article", { class: "sc", dataset: { symbol } });
  let snap = engine.snapshot(symbol);
  let lastTick = null;
  let lastStatus = null;
  let lastSec = -1;

  function render(withReveal) {
    snap = engine.snapshot(symbol);
    el.className = `sc sc--${snap.status === "sit_out" ? "sit" : snap.direction === "SHORT" ? "short" : "long"}`;
    el.dataset.status = snap.status;
    el.setAttribute("aria-label", `${snap.symbol} ${snap.direction ? `${snap.direction} ${snap.confidencePct}% confidence` : STATUS_TEXT[snap.status]}`);
    el.replaceChildren(...buildCardBody(snap, { star: opts.star ? opts.star() : null }).filter(Boolean), h("i", { class: "sc-sweep", "aria-hidden": "true" }));
    lastStatus = snap.status;
    lastTick = engine.quote(symbol).tick;
    if (withReveal) playReveal(el);
    if (opts.onRender) opts.onRender(snap, el);
  }

  function update(now) {
    const st = engine.signalState(symbol, now);
    if (st.status !== lastStatus) {
      render(true);
      return;
    }
    const sec = Math.floor(now / 1000);
    if (sec !== lastSec) {
      lastSec = sec;
      const s = engine.snapshot(symbol, now);
      const ago = el.querySelector("[data-ago]");
      if (ago) ago.textContent = s.issuedText;
      const asof = el.querySelector("[data-asof]");
      if (asof && s.live && s.hasPrice && s.asOfText) asof.textContent = `· ${s.asOfText}`;
    }
    const q = engine.quote(symbol, now);
    if (q.tick === lastTick) return;
    lastTick = q.tick;
    const s = engine.snapshot(symbol, now);
    const p = el.querySelector("[data-price]");
    if (p) {
      p.textContent = s.priceText;
      flash(p, q.dir);
    }
    const chg = el.querySelector(".sc-chg");
    if (chg) chg.replaceWith(changeEl(s));
    const fw = el.querySelector(".fresh-wrap");
    if (fw && s.live) {
      const next = freshBadge(s);
      if (next) fw.replaceWith(next);
    }
    const r = el.querySelector("[data-r]");
    if (r && s.rText) {
      r.textContent = s.rText;
      r.classList.toggle("is-up", s.r >= 0);
      r.classList.toggle("is-down", s.r < 0);
    }
    setNeedle(el, s.map);
  }

  render(false);
  return { el, update, render, get snapshot() { return snap; }, reveal: () => playReveal(el) };
}

// ------------------------------------------------------------ Row (compact) --

export function createRow(engine, symbol, { onOpen, index = 0 } = {}) {
  const el = h("button", { type: "button", class: "row", dataset: { symbol }, style: { "--i": index } });
  let lastStatus = null;
  let lastTick = null;

  function render(withReveal) {
    const s = engine.snapshot(symbol);
    lastStatus = s.status;
    lastTick = engine.quote(symbol).tick;
    const inst = engine.get(symbol);
    let verdict;
    let sub;
    let right;
    if (s.status === "sit_out") {
      verdict = h("span", { class: "row-verdict" }, statusPill("sit_out"));
      sub = REGIME_TEXT[s.regime] || s.regime;
      right = confluenceMeter(s.confluence, { muted: true, mini: true });
    } else {
      verdict = h("span", { class: "row-verdict" }, dirPill(s.direction, { small: true }), h("span", { class: "row-conf mono" }, `${s.confidencePct}%`));
      sub = s.status === "active" || s.status === "t1_hit" ? `${STATUS_TEXT[s.status].split(" ·")[0]} · ${s.rText}` : STATUS_TEXT[s.status];
      right = tradeMap(s.map, { compact: true });
    }
    el.className = `row row--${s.status}`;
    el.setAttribute(
      "aria-label",
      `${s.symbol}, ${s.name}. ${s.direction ? `${s.direction} ${s.confidencePct}% confidence, ${STATUS_TEXT[s.status]}` : STATUS_TEXT[s.status]}. Open details.`,
    );
    el.replaceChildren(
      h("span", { class: "row-main" }, h("span", { class: "row-line" }, h("span", { class: "row-sym mono" }, s.symbol), verdict), h("span", { class: "row-sub" }, h("span", { class: "row-name" }, inst.name), h("span", { class: "row-dot", "aria-hidden": "true" }, "·"), h("span", { class: "row-status mono", "data-sub": "" }, sub))),
      h(
        "span",
        { class: "row-side" },
        h("span", { class: "row-viz" }, right),
        h(
          "span",
          { class: "row-pline" },
          h("span", { class: "row-price mono", "data-price": "" }, s.priceText),
          s.live && s.freshnessShort ? h("span", { class: `row-fresh mono${s.stale ? " is-stale" : ""}`, title: `${s.freshnessText}${s.asOfText ? ` · ${s.asOfText}` : ""}${s.stale ? " · stale" : ""}` }, s.freshnessShort) : null,
        ),
      ),
    );
    if (withReveal) playReveal(el);
  }

  function update(now) {
    const st = engine.signalState(symbol, now);
    if (st.status !== lastStatus) return render(true);
    const q = engine.quote(symbol, now);
    if (q.tick === lastTick) return;
    lastTick = q.tick;
    const s = engine.snapshot(symbol, now);
    const p = el.querySelector("[data-price]");
    if (p) {
      p.textContent = s.priceText;
      flash(p, q.dir);
    }
    const fr = el.querySelector(".row-fresh");
    if (fr && s.live) {
      fr.title = `${s.freshnessText}${s.asOfText ? ` · ${s.asOfText}` : ""}${s.stale ? " · stale" : ""}`;
      fr.classList.toggle("is-stale", !!s.stale);
    }
    if (s.rText) {
      const sub = el.querySelector("[data-sub]");
      if (sub) sub.textContent = `${STATUS_TEXT[s.status].split(" ·")[0]} · ${s.rText}`;
    }
    setNeedle(el, s.map);
  }

  el.addEventListener("click", () => onOpen && onOpen(symbol));
  render(false);
  return { el, update };
}

// ------------------------------------------------------ Layer breakdown --

export function layerBreakdown(engine, symbol) {
  const inst = engine.get(symbol);
  const conf = engine.confluence(symbol);
  const isSit = inst.signal.status === "sit_out";
  const rows = conf.rows.map((r) => {
    const st = segState(r.score);
    const word = st === "agree" ? (isSit ? "leans with" : "agrees") : st === "weak" ? "weak" : st === "disagree" ? "disagrees" : st === "flat" ? "neutral" : "N/A";
    const bar =
      r.score == null
        ? h("div", { class: "lb-bar lb-bar--na" }, h("span", {}, "N/A"))
        : h(
            "div",
            { class: "lb-bar" },
            h("i", { class: "lb-zero" }),
            h("i", {
              class: `lb-fill ${r.score >= 0 ? "is-pos" : "is-neg"} ${st === "weak" ? "is-weak" : ""}`,
              style: r.score >= 0 ? { left: "50%", width: `${Math.abs(r.score) / 2}%` } : { right: "50%", width: `${Math.abs(r.score) / 2}%` },
            }),
          );
    return h(
      "li",
      { class: "lb-row", dataset: { state: st } },
      h("div", { class: "lb-top" }, h("span", { class: "lb-lbl" }, r.label), h("span", { class: "lb-val mono" }, r.score == null ? "—" : `${r.score > 0 ? "+" : ""}${r.score}`), h("span", { class: "lb-word" }, word)),
      bar,
      r.score == null ? h("p", { class: "lb-na" }, naReason(inst, r.id)) : null,
    );
  });
  return h(
    "section",
    { class: "lb", "aria-label": "Five layers" },
    h("div", { class: "section-head" }, h("span", { class: "eyebrow" }, "Five layers"), h("span", { class: "eyebrow-aux mono" }, `${conf.agree}/${conf.total} agree · −100 ← 0 → +100`)),
    h("ul", { class: "lb-list" }, rows),
  );
}

// -------------------------------------------------------- Setup facts --

export function setupFacts(engine, symbol) {
  const inst = engine.get(symbol);
  const s = inst.signal;
  const rows = [
    ["Strategy", s.strategy || "None (sitting out)"],
    ["Style", s.style ? STYLE_TEXT[s.style] : "—"],
    ["Timeframe", s.timeframe || "—"],
    ["Regime", REGIME_TEXT[s.regime] || s.regime],
    ["Market", `${inst.exchange} · ${inst.currency}`],
    ["Ledger id", `#${s.id}`],
  ];
  if (inst.live) rows.push(["Engine", "v0 · rule-based, uncalibrated"]);
  if (inst.live && inst.proxyNote) rows.push(["Proxy", inst.proxyNote]);
  return h(
    "section",
    { class: "facts" },
    h("div", { class: "section-head" }, h("span", { class: "eyebrow" }, "Setup")),
    h("dl", { class: "facts-grid" }, rows.map(([k, v]) => h("div", { class: "fact" }, h("dt", {}, k), h("dd", { class: /\d|#/.test(v) && !["Strategy", "Engine", "Proxy"].includes(k) ? "mono" : "" }, v)))),
  );
}

// ------------------------------------------------------ Position sizer --

export function createSizer(engine, symbol, settings, { onEditDefaults } = {}) {
  const inst = engine.get(symbol);
  const sig = inst.signal;
  const capIn = h("input", { type: "number", min: "1", step: "any", inputmode: "decimal", value: String(settings.capital), "aria-label": `Capital in ${settings.currency}` });
  const riskIn = h("input", { type: "number", min: "0.05", max: "10", step: "0.05", inputmode: "decimal", value: String(settings.riskPct), "aria-label": "Risk per trade, percent" });
  const out = h("dl", { class: "sizer-out" });
  const notes = h("p", { class: "sizer-note" });
  const ccy = settings.currency;

  function row(k, v, cls = "") {
    return h("div", { class: `so ${cls}`.trim() }, h("dt", {}, k), h("dd", { class: "mono" }, v));
  }

  function compute() {
    const capital = Number(capIn.value);
    const riskPct = Number(riskIn.value);
    capIn.toggleAttribute("aria-invalid", !(capital > 0));
    riskIn.toggleAttribute("aria-invalid", !(riskPct > 0 && riskPct <= 10));
    const r = engine.sizePosition(symbol, { capital, currency: ccy, riskPct });
    if (!r) {
      out.replaceChildren(row("Result", "Enter capital above 0 and risk between 0.05% and 10%.", "so--wide"));
      notes.textContent = "";
      return;
    }
    if (r.unavailable) {
      out.replaceChildren(row("Not available", r.unavailable, "so--wide"));
      notes.textContent = "";
      return;
    }
    if (r.tooSmall) {
      out.replaceChildren(
        row("Risk amount", formatMoney(r.riskCap, ccy)),
        row("Quantity", `0 ${r.unit}`),
        row("Why", `One ${r.unit.replace(/s$/, "")} risks ${formatMoney(Math.abs(r.entry - sig.stop), inst.currency, 2)}, more than your risk budget.`, "so--wide"),
      );
    } else {
      out.replaceChildren(
        row("Risk amount", formatMoney(r.riskCap, ccy)),
        row("Quantity", `${r.qtyText} ${r.unit}`),
        row("Notional", formatMoney(r.notional, inst.currency)),
        row("Max loss at SL", formatMoney(-r.maxLoss, inst.currency), "so--loss"),
        row(`Reward at T1 (${formatR(sig.rr1)})`, formatMoney(r.rewardT1, inst.currency), "so--gain"),
        row(`Reward at T2 (${formatR(sig.rr2)})`, formatMoney(r.rewardT2, inst.currency), "so--gain"),
      );
    }
    notes.replaceChildren(
      `Entry basis: middle of the entry zone, ${formatNumber(r.entry, inst.decimals, inst.currency)}. `,
      r.fxNote ? `${r.fxNote} ` : "",
      r.indexNote ? h("strong", {}, r.indexNote) : "",
    );
  }

  capIn.addEventListener("input", compute);
  riskIn.addEventListener("input", compute);
  compute();

  return h(
    "section",
    { class: "sizer", "aria-label": "Position sizer" },
    h("div", { class: "section-head" }, h("span", { class: "eyebrow" }, "Position sizer"), onEditDefaults ? h("button", { type: "button", class: "link-btn", onclick: onEditDefaults }, "Edit defaults") : null),
    h(
      "div",
      { class: "sizer-in" },
      h("label", { class: "field" }, h("span", { class: "field-lbl" }, "Capital"), h("span", { class: "affix" }, h("span", { class: "affix-txt mono" }, ccy), capIn)),
      h("label", { class: "field" }, h("span", { class: "field-lbl" }, "Risk per trade"), h("span", { class: "affix" }, riskIn, h("span", { class: "affix-txt mono" }, "%"))),
    ),
    out,
    notes,
  );
}

// ------------------------------------------------------------- Misc --

export function emptyState({ title, body, actions = [], icon = true }) {
  return h(
    "div",
    { class: "empty" },
    icon ? logoMark({ size: 28 }) : null,
    h("h3", { class: "empty-title" }, title),
    body ? h("p", { class: "empty-body" }, body) : null,
    actions.length ? h("div", { class: "empty-actions" }, actions) : null,
  );
}

export function button(label, { kind = "secondary", icon = null, onClick, title, small = false } = {}) {
  return h("button", { type: "button", class: `btn btn--${kind}${small ? " btn--sm" : ""}`, title, onclick: onClick }, label, icon ? h("span", { class: "btn-icon", "aria-hidden": "true" }, icon) : null);
}

export function iconGear() {
  const el = svg(
    "svg",
    { viewBox: "0 0 24 24", width: "16", height: "16", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" },
    svg("circle", { cx: "12", cy: "12", r: "3" }),
    svg("path", {
      d: "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
    }),
  );
  return el;
}

export function iconStar(filled) {
  return svg(
    "svg",
    { viewBox: "0 0 24 24", width: "16", height: "16", fill: filled ? "currentColor" : "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linejoin": "round", "aria-hidden": "true" },
    svg("path", { d: "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" }),
  );
}

export function iconBack() {
  return svg(
    "svg",
    { viewBox: "0 0 24 24", width: "16", height: "16", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" },
    svg("path", { d: "M15 18l-6-6 6-6" }),
  );
}

export function iconSearch() {
  return svg(
    "svg",
    { viewBox: "0 0 24 24", width: "15", height: "15", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "aria-hidden": "true" },
    svg("circle", { cx: "11", cy: "11", r: "6.5" }),
    svg("path", { d: "M16 16l4 4" }),
  );
}

export function starButton(isOn, onToggle) {
  const b = h("button", { type: "button", class: `star${isOn ? " is-on" : ""}`, "aria-pressed": isOn ? "true" : "false", "aria-label": isOn ? "Remove from watchlist" : "Add to watchlist", title: isOn ? "Remove from watchlist" : "Add to watchlist" }, iconStar(isOn));
  b.addEventListener("click", async (e) => {
    e.stopPropagation();
    const on = await onToggle();
    b.classList.toggle("is-on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.setAttribute("aria-label", on ? "Remove from watchlist" : "Add to watchlist");
    b.title = on ? "Remove from watchlist" : "Add to watchlist";
    b.replaceChildren(iconStar(on));
  });
  return b;
}

/** Supported sites as buttons; each opens that site's example page. */
export function siteList(onOpen) {
  return h(
    "ul",
    { class: "site-list" },
    SITES.map((s) =>
      h(
        "li",
        {},
        h("button", { type: "button", class: "site-link", title: `Open an example: ${s.example}`, onclick: () => onOpen(s.example) }, s.label, s.mode === "title" ? h("small", {}, "TITLE") : null),
      ),
    ),
  );
}
