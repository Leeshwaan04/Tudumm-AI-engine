/* Tudumm content script (classic, self-contained).
 *
 * - Sends the page URL + title to the background, which owns the live market
 *   data and does the alias resolution (the content script never fetches
 *   extension files). When the background has no live data it answers
 *   `offline: true` and the chip says so (and retries) instead of showing numbers.
 * - Renders a floating chip inside a CLOSED Shadow DOM, styled in isolation with
 *   system font stacks (no fonts are loaded into host pages).
 * - Re-detects on SPA navigation by polling location.href (and title) every 1s.
 *
 * Security: page URL/title are untrusted. Nothing from the page or the
 * background is ever parsed as HTML: the DOM is built with createElement and
 * textContent only (no innerHTML / insertAdjacentHTML / eval).
 *
 * Outside an installed extension (preview.html) it does not auto-run; it exposes
 * window.TudummChip.create(env) so the preview can mount the exact same chip.
 */
(function () {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";
  var DEFAULTS = { webUrl: "https://tudumm.in", chipEnabled: true, sites: {} };

  var CSS = [
    ":host{all:initial}",
    "*{box-sizing:border-box}",
    ".root{--bg:#0A0B0D;--surface:#13161B;--surface-2:#191D24;--surface-3:#20252E;--line:#232833;--line-strong:#323946;--text:#EEEAE0;--text-2:#A9A69A;--text-3:#807E75;--brand:#F5B841;--brand-ink:#1A1305;--brand-dim:rgba(245,184,65,.14);--long:#3DD68C;--long-dim:rgba(61,214,140,.14);--short:#FF5C4D;--short-dim:rgba(255,92,77,.14);--neutral:#8E9AAF;--neutral-dim:rgba(142,154,175,.14);--info:#7FA7FF;",
    "--sans:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,Roboto,'Helvetica Neue',Arial,sans-serif;--mono:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace;--serif:ui-serif,'New York','Iowan Old Style',Georgia,'Times New Roman',serif;",
    "font-family:var(--sans);font-size:13px;line-height:1.4;color:var(--text);-webkit-font-smoothing:antialiased;display:flex;flex-direction:column;align-items:flex-end;gap:8px}",
    ".mono{font-family:var(--mono);font-variant-numeric:tabular-nums}",
    "button{font:inherit;color:inherit;cursor:pointer}",
    "button:focus-visible{outline:2px solid var(--brand);outline-offset:2px}",
    /* collapsed chip */
    ".chip{appearance:none;display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 12px 0 9px;border-radius:9px;border:1px solid var(--line-strong);background:var(--bg);color:var(--text);box-shadow:0 8px 24px rgba(0,0,0,.35),0 1px 0 rgba(255,255,255,.04) inset;white-space:nowrap}",
    ".chip:hover{border-color:#46506a;background:#0d0f12}",
    ".chip .sym{font-family:var(--mono);font-weight:700;font-size:12.5px;letter-spacing:.02em}",
    ".chip .sep{width:1px;height:16px;background:var(--line-strong)}",
    ".v{font-family:var(--mono);font-weight:700;font-size:12px;letter-spacing:.03em}",
    ".v.long{color:var(--long)}.v.short{color:var(--short)}.v.sit{color:var(--neutral);font-weight:600;letter-spacing:.08em;font-size:11px}.v.nc{color:var(--text-2);font-family:var(--sans);font-weight:500;letter-spacing:0}.v.off{color:var(--brand);font-family:var(--sans);font-weight:500;letter-spacing:0}",
    ".v .conf{color:var(--brand);margin-left:5px}",
    /* mark */
    ".mark circle{fill:var(--brand);transform-box:fill-box;transform-origin:center}",
    ".drum .ta{animation:ta 1.2s cubic-bezier(.2,.7,.2,1) infinite}.drum .du{animation:du 1.2s cubic-bezier(.2,.7,.2,1) infinite}",
    "@keyframes ta{0%,100%{transform:scale(1);opacity:.55}8%{transform:scale(1.35);opacity:1}30%{transform:scale(1);opacity:.7}}",
    "@keyframes du{0%,16%,100%{transform:scale(1);opacity:.6}26%{transform:scale(1.22);opacity:1}50%{transform:scale(1);opacity:.75}}",
    /* card */
    ".card{width:312px;max-width:calc(100vw - 24px);background:var(--surface);border:1px solid var(--line-strong);border-radius:10px;box-shadow:0 18px 48px rgba(0,0,0,.45);padding:12px 12px 10px;display:grid;gap:10px;position:relative;overflow:hidden}",
    ".hd{display:flex;align-items:center;gap:8px;min-width:0}",
    ".hd .sym{font-family:var(--mono);font-weight:700;font-size:13.5px}",
    ".hd .nm{color:var(--text-2);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}",
    ".ib{appearance:none;width:26px;height:26px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--text-2);display:grid;place-items:center;font-size:15px;line-height:1;padding:0}",
    ".ib:hover{background:var(--surface-2);border-color:var(--line);color:var(--text)}",
    ".vd{display:flex;align-items:center;gap:10px}",
    ".dir{display:inline-flex;align-items:center;height:24px;padding:0 8px;border-radius:6px;font-family:var(--mono);font-weight:700;font-size:12px;letter-spacing:.04em}",
    ".dir.long{color:var(--long);background:var(--long-dim);box-shadow:inset 0 0 0 1px rgba(61,214,140,.28)}.dir.short{color:var(--short);background:var(--short-dim);box-shadow:inset 0 0 0 1px rgba(255,92,77,.28)}",
    ".cf{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:24px;line-height:1;color:var(--brand);font-weight:500;letter-spacing:-.02em}",
    ".cf small{font-size:13px;opacity:.75}",
    ".cfl{font-size:10px;color:var(--text-3);display:block;margin-top:2px;letter-spacing:.02em}",
    ".st{margin-left:auto;display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 7px;border-radius:4px;border:1px solid var(--line-strong);font-family:var(--mono);font-size:9.5px;font-weight:600;letter-spacing:.08em;color:var(--text-2);white-space:nowrap}",
    ".st i{width:5px;height:5px;border-radius:50%;background:currentColor}",
    ".st.active{color:var(--info);border-color:rgba(127,167,255,.35)}.st.pending{color:var(--neutral)}.st.t1_hit{color:var(--long);border-color:rgba(61,214,140,.35);background:var(--long-dim)}.st.sit_out{color:var(--neutral);background:var(--neutral-dim)}",
    ".lv{display:flex;align-items:baseline;gap:8px;font-size:11.5px;color:var(--text-2);flex-wrap:wrap}",
    ".lv .p{font-family:var(--mono);font-variant-numeric:tabular-nums;color:var(--text);font-size:13px;font-weight:500;padding:0 3px;margin-left:-3px;border-radius:3px}",
    ".lv .r{margin-left:auto;font-family:var(--mono);font-weight:600;font-size:11.5px;padding:1px 5px;border-radius:4px}",
    ".up{color:var(--long)}.dn{color:var(--short)}.r.up{background:var(--long-dim)}.r.dn{background:var(--short-dim)}",
    /* trade map */
    ".tm{display:grid;gap:5px}",
    ".tm-row{position:relative;height:12px}",
    ".tm-l{position:absolute;top:0;transform:translateX(-50%);font-family:var(--mono);font-size:9px;letter-spacing:.06em;color:var(--text-3);white-space:nowrap;line-height:12px}",
    ".tm-row.top .tm-l{font-weight:600}.tm-l.sl{color:var(--short)}.tm-l.t{color:var(--long)}.tm-row.bot .tm-l{color:var(--text-2);letter-spacing:0;font-size:9.5px}",
    ".tm-track{position:relative;height:7px;border-radius:4px;background:var(--surface-3)}",
    ".tm-risk,.tm-rew,.tm-zone{position:absolute;top:0;bottom:0}",
    ".tm-risk{background:linear-gradient(90deg,rgba(255,92,77,.5),rgba(255,92,77,.16));border-radius:4px 0 0 4px}",
    ".tm-rew{background:linear-gradient(90deg,rgba(61,214,140,.14),rgba(61,214,140,.42));border-radius:0 4px 4px 0}",
    ".tm-zone{top:-3px;bottom:-3px;background:rgba(238,234,224,.16);box-shadow:inset 0 0 0 1px rgba(238,234,224,.42);border-radius:2px}",
    ".tm-tick{position:absolute;top:-4px;bottom:-4px;width:2px;margin-left:-1px;border-radius:1px}",
    ".tm-tick.sl{background:var(--short)}.tm-tick.t{background:var(--long)}",
    ".tm-needle{position:absolute;top:-5px;bottom:-5px;width:2px;margin-left:-1px;background:var(--text);box-shadow:0 0 0 1px var(--bg);transition:left .6s cubic-bezier(.2,.7,.2,1);z-index:2}",
    ".tm-needle::before{content:'';position:absolute;top:50%;left:50%;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:var(--text);box-shadow:0 0 0 2px var(--bg),0 0 10px rgba(238,234,224,.45)}",
    ".lvls{display:grid;grid-template-columns:1.6fr 1fr 1fr 1fr;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}",
    ".lvls div{padding:5px 0;min-width:0}.lvls div+div{padding-left:7px;border-left:1px solid var(--line)}",
    ".lvls b{display:block;font-family:var(--mono);font-size:8.5px;letter-spacing:.1em;color:var(--text-3);font-weight:500}",
    ".lvls span{display:block;font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:10.5px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    /* confluence */
    ".cm{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:7px}",
    ".cm-b{height:5px;border-radius:2px;background:var(--surface-3);position:relative;overflow:hidden}",
    ".cm-b i{position:absolute;left:0;top:0;bottom:0;background:var(--brand)}",
    ".cm-s.weak .cm-b i{background:rgba(245,184,65,.5)}.cm-s.dis .cm-b i{background:var(--short)}",
    ".cm-s.na .cm-b{background:repeating-linear-gradient(135deg,var(--surface-3) 0 3px,transparent 3px 6px);box-shadow:inset 0 0 0 1px var(--line)}",
    ".muted .cm-b i{background:var(--neutral)}",
    ".cm-t{display:grid;gap:1px;margin-top:4px;font-family:var(--mono);font-size:8.5px;letter-spacing:.06em;color:var(--text-3);text-transform:uppercase;white-space:nowrap;overflow:hidden}",
    ".cm-t span:last-child{color:var(--text);letter-spacing:0;font-size:10px}",
    ".why{margin:0;font-family:var(--serif);font-style:italic;font-size:14.5px;line-height:1.3;color:var(--text);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
    ".sit-t{margin:0;font-family:var(--serif);font-size:24px;line-height:1;font-weight:400}",
    ".note{margin:0;font-size:11.5px;color:var(--text-2);line-height:1.45}",
    ".acts{display:grid;grid-template-columns:1fr 1fr;gap:6px}",
    ".btn{appearance:none;height:32px;border-radius:6px;border:1px solid var(--line-strong);background:var(--surface-2);color:var(--text);font-size:12px;font-weight:500;padding:0 8px;white-space:nowrap}",
    ".btn:hover{background:var(--surface-3)}",
    ".btn.pri{background:var(--brand);border-color:var(--brand);color:var(--brand-ink);font-weight:600}.btn.pri:hover{background:#f8c55f}",
    ".hint{margin:0;font-size:11.5px;color:var(--brand);background:var(--brand-dim);border:1px solid rgba(245,184,65,.3);border-radius:6px;padding:7px 9px;line-height:1.4}",
    ".ft{display:flex;align-items:center;gap:6px;font-family:var(--mono);font-size:9px;letter-spacing:.1em;color:var(--text-3)}",
    ".ft b{color:var(--brand);font-weight:600;border:1px solid rgba(245,184,65,.32);background:var(--brand-dim);border-radius:3px;padding:1px 4px}",
    ".ft{flex-wrap:wrap;row-gap:4px}.ft b.lv2{color:var(--long);border-color:rgba(61,214,140,.32);background:var(--long-dim)}.ft b.lv2.stale{color:var(--brand);border-color:rgba(245,184,65,.32);background:var(--brand-dim)}",
    ".ft .eng{color:var(--text-2);border:1px dashed var(--line-strong);border-radius:3px;padding:0 4px;cursor:help}.ft .px{color:var(--info)}",
    ".gone{display:inline-flex;align-items:center;gap:10px;height:34px;padding:0 6px 0 12px;border-radius:8px;background:var(--bg);border:1px solid var(--line-strong);color:var(--text-2);font-size:12px;box-shadow:0 8px 24px rgba(0,0,0,.35)}",
    ".gone button{appearance:none;border:0;background:transparent;color:var(--brand);font-weight:600;font-size:12px;padding:6px}",
    ".flash-up{animation:fu .3s ease-out}.flash-down{animation:fd .3s ease-out}",
    "@keyframes fu{0%{background:rgba(61,214,140,.32)}100%{background:transparent}}@keyframes fd{0%{background:rgba(255,92,77,.32)}100%{background:transparent}}",
    ".beat{animation:beat .76s cubic-bezier(.2,.7,.2,1) both}",
    "@keyframes beat{0%{transform:scale(.985)}12%{transform:scale(1.008)}24%{transform:scale(1)}41%{transform:scale(1.03);box-shadow:0 0 0 1px rgba(245,184,65,.65),0 0 24px rgba(245,184,65,.25)}62%{transform:scale(1)}100%{transform:scale(1)}}",
    "@media (prefers-reduced-motion:reduce){*,*::before{animation:none!important;transition:none!important}}",
  ].join("");

  // --------------------------------------------------------------- DOM --
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function add(parent) {
    for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]);
    return parent;
  }
  function mark(size, drum) {
    var s = document.createElementNS(SVG_NS, "svg");
    s.setAttribute("viewBox", "0 0 32 32");
    s.setAttribute("width", String(size));
    s.setAttribute("height", String(size));
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("class", "mark" + (drum ? " drum" : ""));
    var a = document.createElementNS(SVG_NS, "circle");
    a.setAttribute("cx", "10.125"); a.setAttribute("cy", "20.375"); a.setAttribute("r", "2.75"); a.setAttribute("class", "ta");
    var b = document.createElementNS(SVG_NS, "circle");
    b.setAttribute("cx", "19.125"); b.setAttribute("cy", "14.375"); b.setAttribute("r", "5.5"); b.setAttribute("class", "du");
    s.appendChild(a); s.appendChild(b);
    return s;
  }
  function pos(n) {
    var v = Number(n);
    if (!isFinite(v)) v = 0;
    return Math.max(0, Math.min(100, v)).toFixed(2) + "%";
  }
  function reduced() {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; }
  }
  function str(v, max) {
    return typeof v === "string" ? v.slice(0, max || 400) : v == null ? "" : String(v).slice(0, max || 400);
  }

  // --------------------------------------------------------- Chip view --
  /**
   * env = {
   *   container: Element|null      // null → fixed to the viewport (real pages)
   *   send(msg) → Promise<resp>    // background protocol: detect / snapshot / openSidePanel / openTerminal
   *   getSettings() → Promise<{chipEnabled, sites}>
   *   setSiteEnabled(siteKey, on) → Promise
   *   onSettingsChanged(cb)
   * }
   */
  function createChip(env) {
    var loadedAt = Date.now();
    var host = document.createElement("tudumm-chip");
    host.setAttribute("style", env.container
      ? "all:initial;position:absolute;right:16px;bottom:16px;z-index:5;display:block;"
      : "all:initial;position:fixed;right:18px;bottom:18px;z-index:2147483646;display:block;");
    var shadow = host.attachShadow({ mode: "closed" });
    try {
      var sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch (e) {
      shadow.appendChild(el("style", null, CSS));
    }
    var root = el("div", "root");
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Tudumm signal");
    shadow.appendChild(root);
    (env.container || document.documentElement).appendChild(host);

    var state = {
      det: null, snap: null, expanded: false, hiddenNotice: false,
      settings: { chipEnabled: true, sites: {} }, hint: null, lastTick: null,
      offline: null, // { site, siteLabel, reasonText, retryInMs } while the background has no live data
    };
    var pollTimer = null;
    var retryTimer = null;
    var lastArgs = null;
    var dead = false;

    function siteOn() {
      var s = state.settings;
      if (!s.chipEnabled) return false;
      var site = state.det ? state.det.site : state.offline ? state.offline.site : null;
      if (site && s.sites && s.sites[site] === false) return false;
      return true;
    }

    /** No live data: a compact chip that says so (click retries now). Never numbers. */
    function offlineChip() {
      var b = el("button", "chip");
      b.type = "button";
      var why = state.offline.reasonText || "Tudumm can't be reached.";
      b.title = "Live data temporarily unavailable — retrying. " + why + " Click to retry now.";
      b.setAttribute("aria-label", "Tudumm: live data temporarily unavailable, retrying. " + why + " Retry now.");
      add(b, mark(18), el("span", "sym", "Tudumm"), el("span", "sep"), el("span", "v off", "Live data unavailable · retrying"));
      b.addEventListener("click", function () { if (lastArgs) detect(lastArgs.url, lastArgs.title); });
      return b;
    }

    function render(beat) {
      if (dead) return;
      root.textContent = "";
      if (state.hiddenNotice) {
        var g = el("div", "gone");
        add(g, el("span", null, "Tudumm hidden on " + str(state.det && state.det.siteLabel, 40)));
        var undo = el("button", null, "Undo");
        undo.type = "button";
        undo.addEventListener("click", function () {
          state.hiddenNotice = false;
          env.setSiteEnabled(state.det.site, true);
        });
        add(root, add(g, undo));
        return;
      }
      if (state.offline) {
        host.style.display = siteOn() ? "block" : "none";
        if (siteOn()) add(root, offlineChip());
        return;
      }
      if (!state.det || !(state.det.symbol || state.det.ticker) || !siteOn()) {
        host.style.display = "none";
        return;
      }
      host.style.display = "block";
      if (state.expanded) add(root, card());
      add(root, chipButton());
      if (beat && !reduced()) {
        var target = root.querySelector(".card") || root.querySelector(".chip");
        if (target) { target.classList.add("beat"); setTimeout(function () { target.classList.remove("beat"); }, 900); }
      }
    }

    function verdict() {
      var s = state.snap;
      if (!s) return el("span", "v nc", "Not covered yet");
      if (s.status === "sit_out") return el("span", "v sit", "SITTING OUT");
      var long = s.direction === "LONG";
      var v = el("span", "v " + (long ? "long" : "short"), (long ? "▲ " : "▼ ") + str(s.direction, 5));
      add(v, el("span", "conf", String(Number(s.confidencePct) || 0) + "%"));
      return v;
    }

    function chipButton() {
      var b = el("button", "chip");
      b.type = "button";
      b.setAttribute("aria-expanded", state.expanded ? "true" : "false");
      var sym = state.snap ? state.snap.symbol : state.det.ticker;
      b.setAttribute("aria-label", "Tudumm: " + str(sym, 24) + ". " + (state.expanded ? "Collapse" : "Show signal"));
      add(b, mark(18), el("span", "sym", str(sym, 24)), el("span", "sep"), verdict());
      b.addEventListener("click", function () {
        state.expanded = !state.expanded;
        state.hint = null;
        render(false);
        schedule();
      });
      return b;
    }

    function tradeMap(m) {
      var wrap = el("div", "tm");
      wrap.setAttribute("aria-hidden", "true");
      var stopPos = m.breakeven ? m.entry.pos : m.stop.pos;
      var top = el("div", "tm-row top");
      function lbl(row, p, t, c) { var l = el("span", "tm-l" + (c ? " " + c : ""), t); l.style.left = pos(p); row.appendChild(l); }
      lbl(top, stopPos, m.breakeven ? "SL·BE" : "SL", "sl");
      lbl(top, (m.entry.pos0 + m.entry.pos1) / 2, "ENTRY");
      lbl(top, m.t1.pos, "T1", "t");
      lbl(top, m.t2.pos, "T2", "t");
      var tr = el("div", "tm-track");
      var risk = el("div", "tm-risk"); risk.style.left = pos(stopPos); risk.style.width = pos(m.entry.pos - stopPos);
      var rew = el("div", "tm-rew"); rew.style.left = pos(m.entry.pos); rew.style.width = pos(m.t2.pos - m.entry.pos);
      var zone = el("div", "tm-zone"); zone.style.left = pos(m.entry.pos0); zone.style.width = pos(Math.max(m.entry.pos1 - m.entry.pos0, 1.2));
      var sl = el("i", "tm-tick sl"); sl.style.left = pos(stopPos);
      var t1 = el("i", "tm-tick t"); t1.style.left = pos(m.t1.pos);
      var t2 = el("i", "tm-tick t"); t2.style.left = pos(m.t2.pos);
      var nd = el("div", "tm-needle"); nd.style.left = pos(m.needle ? m.needle.pos : m.entry.pos);
      add(tr, risk, rew, zone, sl, t1, t2, nd);
      var bot = el("div", "tm-row bot");
      lbl(bot, m.stop.pos, "−1R");
      lbl(bot, m.entry.pos, "0");
      lbl(bot, m.t1.pos, str(m.t1.rText, 8));
      lbl(bot, m.t2.pos, str(m.t2.rText, 8));
      return add(wrap, top, tr, bot);
    }

    function confluence(c, muted) {
      var g = el("div", "cm" + (muted ? " muted" : ""));
      var rows = (c && c.rows) || [];
      g.setAttribute("role", "img");
      g.setAttribute("aria-label", "Confluence: " + (c ? c.agree + " of " + c.total + " layers agree" : ""));
      for (var i = 0; i < rows.length && i < 5; i++) {
        var r = rows[i];
        var sc = r.score;
        var cls = sc == null ? "na" : sc >= 25 ? "agree" : sc > 0 ? "weak" : sc < 0 ? "dis" : "flat";
        var seg = el("div", "cm-s " + cls);
        var bar = el("div", "cm-b");
        if (sc != null) { var f = el("i"); f.style.width = pos(Math.abs(sc)); bar.appendChild(f); }
        var t = el("div", "cm-t");
        add(t, el("span", null, str(r.short, 8)), el("span", null, sc == null ? "N/A" : (sc > 0 ? "+" : "") + sc));
        add(seg, bar, t);
        g.appendChild(seg);
      }
      return g;
    }

    function card() {
      var s = state.snap;
      var c = el("div", "card");
      var hd = el("div", "hd");
      add(hd, mark(18), el("span", "sym", str(s ? s.symbol : state.det.ticker, 24)), el("span", "nm", s ? str(s.name, 60) : "on " + str(state.det.siteLabel, 40)));
      var min = el("button", "ib", "–"); min.type = "button"; min.title = "Collapse"; min.setAttribute("aria-label", "Collapse");
      min.addEventListener("click", function () { state.expanded = false; render(false); schedule(); });
      var x = el("button", "ib", "×"); x.type = "button";
      x.title = "Hide Tudumm on " + str(state.det.siteLabel, 40) + " (re-enable in Options)";
      x.setAttribute("aria-label", x.title);
      x.addEventListener("click", function () {
        state.expanded = false;
        state.hiddenNotice = true;
        render(false);
        env.setSiteEnabled(state.det.site, false);
        setTimeout(function () { state.hiddenNotice = false; render(false); }, 6000);
      });
      add(hd, min, x);
      c.appendChild(hd);

      if (!s) {
        add(c,
          el("p", "note", "Tudumm doesn't cover " + str(state.det.ticker, 24) + " yet. Tudumm covers 22 instruments across India, the US, Europe, crypto, FX and commodities."),
          actions(null));
        return add(c, footer());
      }

      if (s.status === "sit_out") {
        var sh = el("div", "vd");
        var st2 = el("span", "st sit_out"); add(st2, el("i"), document.createTextNode("SITTING OUT"));
        add(sh, el("h3", "sit-t", "Sitting out"), st2);
        add(c, sh, el("p", "why", str(s.thesis, 300)), confluence(s.confluence, true), actions(s.symbol));
        return add(c, footer());
      }

      var long = s.direction === "LONG";
      var vd = el("div", "vd");
      var conf = el("div");
      var cf = el("span", "cf", String(Number(s.confidencePct) || 0));
      cf.appendChild(el("small", null, "%"));
      add(conf, cf, el("span", "cfl", "confidence"));
      var stp = el("span", "st " + str(s.status, 12)); add(stp, el("i"), document.createTextNode(str(s.statusText, 40)));
      add(vd, el("span", "dir " + (long ? "long" : "short"), (long ? "▲ " : "▼ ") + str(s.direction, 5)), conf, stp);
      var lv = el("div", "lv");
      var chg = Number(s.changePct) || 0;
      add(lv, el("span", "p", str(s.priceText, 30)), el("span", chg > 0 ? "up" : chg < 0 ? "dn" : "", (chg > 0 ? "▲ " : chg < 0 ? "▼ " : "") + str(s.changeText, 12)));
      if (s.rText) lv.appendChild(el("span", "r " + (Number(s.r) >= 0 ? "up" : "dn"), str(s.rText, 12)));
      var lvls = el("div", "lvls");
      var L = s.levels || {};
      [["ENTRY", L.entry], ["SL", L.stop], ["T1", L.t1], ["T2", L.t2]].forEach(function (p) {
        var d = el("div"); add(d, el("b", null, p[0]), el("span", null, str(p[1], 30))); lvls.appendChild(d);
      });
      add(c, vd, lv, s.map ? tradeMap(s.map) : null, lvls, confluence(s.confluence, false), el("p", "why", str(s.thesis, 300)), actions(s.symbol));
      return add(c, footer());
    }

    function actions(symbol) {
      var wrap = el("div");
      var a = el("div", "acts");
      var sp = el("button", "btn", "Open side panel"); sp.type = "button";
      sp.addEventListener("click", function () {
        env.send({ type: "openSidePanel", symbol: symbol || null }).then(function (res) {
          if (!res || !res.ok) { state.hint = "Click the Tudumm toolbar icon to open the panel."; render(false); }
        }, function () { state.hint = "Click the Tudumm toolbar icon to open the panel."; render(false); });
      });
      var op = el("button", "btn pri", "Open in Tudumm ↗"); op.type = "button";
      op.addEventListener("click", function () {
        env.send({ type: "openTerminal", symbol: symbol || null }).then(function (res) {
          if (res && res.ok === false && res.error === "invalid-web-url") { state.hint = "Set a valid https web app URL in Tudumm Options first."; render(false); }
        }, function () {});
      });
      add(a, sp, op);
      wrap.appendChild(a);
      if (state.hint) { wrap.style.display = "grid"; wrap.style.gap = "8px"; wrap.appendChild(el("p", "hint", str(state.hint, 120))); }
      return wrap;
    }

    function footer() {
      var f = el("div", "ft");
      var s = state.snap;
      if (s) {
        // Say where the price comes from and how fresh it is, and that engine v0 is uncalibrated.
        var fresh = el("b", "lv2" + (s.stale ? " stale" : ""), str(s.freshnessText || "LIVE", 40));
        if (s.freshnessHelp) fresh.title = str(s.freshnessHelp, 400);
        var when = el("span", "when", s.hasPrice ? str(s.asOfText || "", 24) + (s.stale ? " · stale" : "") : "no price yet");
        add(f, fresh, when);
        if (s.proxyText) f.appendChild(el("span", "px", str(s.proxyText, 40)));
        var eng = el("span", "eng", "ENGINE V0 · UNCALIBRATED");
        eng.title = "Live signals come from engine v0: fixed rules whose confidence isn't calibrated against outcomes yet. Read it as a ranking.";
        add(f, eng, el("span", null, "Beta · not investment advice"));
        return f;
      }
      add(f, el("span", null, "Beta · not investment advice"));
      return f;
    }

    function liveUpdate(snap) {
      if (dead) return;
      var prev = state.snap;
      state.snap = snap;
      if (!prev || !snap || prev.status !== snap.status || prev.symbol !== snap.symbol) {
        render(false);
        return;
      }
      if (!state.expanded) return;
      var w = root.querySelector(".ft .when");
      if (w && snap.live) w.textContent = snap.hasPrice ? str(snap.asOfText || "", 24) + (snap.stale ? " · stale" : "") : "no price yet";
      var p = root.querySelector(".lv .p");
      if (p && p.textContent !== snap.priceText) {
        p.textContent = str(snap.priceText, 30);
        if (!reduced()) {
          p.classList.remove("flash-up", "flash-down");
          void p.offsetWidth;
          p.classList.add(snap.tickDir > 0 ? "flash-up" : "flash-down");
        }
      }
      var r = root.querySelector(".lv .r");
      if (r && snap.rText) { r.textContent = str(snap.rText, 12); r.className = "r " + (Number(snap.r) >= 0 ? "up" : "dn"); }
      var n = root.querySelector(".tm-needle");
      if (n && snap.map && snap.map.needle) n.style.left = pos(snap.map.needle.pos);
    }

    function schedule() {
      clearInterval(pollTimer);
      pollTimer = null;
      if (!state.snap || dead) return;
      if (!state.expanded) return;
      pollTimer = setInterval(function () {
        if (document.visibilityState === "hidden" || !state.snap) return;
        env.send({ type: "snapshot", symbol: state.snap.symbol, loadedAt: loadedAt }).then(function (res) {
          if (res && res.ok && res.snapshot) { liveUpdate(res.snapshot); if (!state.expanded) schedule(); }
          else if (res && res.offline && lastArgs) detect(lastArgs.url, lastArgs.title);
        }, function () {});
      }, 1000);
    }

    function detect(url, title) {
      lastArgs = { url: url, title: title };
      return env.send({ type: "detect", url: str(url, 2048), title: str(title, 300), loadedAt: loadedAt }).then(function (res) {
        if (dead || !res || !res.ok) return;
        clearTimeout(retryTimer);
        retryTimer = null;
        if (res.offline) {
          // No live data in the background: say so on this supported site, and try again later.
          state.offline = { site: str(res.site, 24) || null, siteLabel: str(res.siteLabel, 40), reasonText: str(res.reasonText, 200), retryInMs: Number(res.retryInMs) || 15000 };
          state.det = null;
          state.snap = null;
          state.expanded = false;
          clearInterval(pollTimer);
          pollTimer = null;
          render(false);
          retryTimer = setTimeout(function () { if (lastArgs && !dead) detect(lastArgs.url, lastArgs.title); }, Math.max(5000, Math.min(state.offline.retryInMs, 60000)));
          return;
        }
        var wasOffline = !!state.offline;
        state.offline = null;
        var prevSym = state.det ? state.det.symbol + "|" + state.det.ticker : "";
        state.det = res.detection && res.detection.site ? res.detection : null;
        var nextSym = state.det ? state.det.symbol + "|" + state.det.ticker : "";
        if (!wasOffline && prevSym === nextSym && state.snap && res.snapshot) {
          liveUpdate(res.snapshot);
          return;
        }
        state.snap = res.snapshot || null;
        if (prevSym !== nextSym) { state.expanded = false; state.hint = null; }
        render(false);
        schedule();
      }, function () {});
    }

    env.getSettings().then(function (s) { state.settings = s || DEFAULTS; render(false); }, function () {});
    env.onSettingsChanged(function (s) {
      state.settings = s || DEFAULTS;
      if (siteOn()) state.hiddenNotice = false;
      render(false);
    });

    return {
      detect: detect,
      /** true when the current detection came from the URL (title changes can be ignored) */
      fromUrl: function () { return !!(state.det && state.det.via === "url" && (state.det.symbol || state.det.ticker)); },
      destroy: function () {
        dead = true;
        clearInterval(pollTimer);
        clearTimeout(retryTimer);
        if (host.parentNode) host.parentNode.removeChild(host);
      },
    };
  }

  // ---------------------------------------------------------- Bootstrap --
  var ext = typeof chrome !== "undefined" && chrome && chrome.runtime && chrome.runtime.id;
  if (!ext || location.protocol === "chrome-extension:") {
    // Preview mode: expose the renderer for preview.html; never auto-run.
    // (Also when opened as an extension page, e.g. chrome-extension://…/preview.html.)
    window.TudummChip = { create: createChip };
    return;
  }
  if (window.__tudummChipLoaded) return;
  window.__tudummChipLoaded = true;

  function alive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }
  function mergeSettings(s) {
    s = s && typeof s === "object" ? s : {};
    return { chipEnabled: s.chipEnabled !== false, sites: s.sites && typeof s.sites === "object" ? s.sites : {}, webUrl: typeof s.webUrl === "string" ? s.webUrl : DEFAULTS.webUrl };
  }

  var chip = createChip({
    container: null,
    send: function (msg) {
      if (!alive()) return Promise.reject(new Error("context invalidated"));
      return new Promise(function (resolve, reject) {
        try {
          chrome.runtime.sendMessage(msg, function (res) {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve(res);
          });
        } catch (e) { reject(e); }
      });
    },
    getSettings: function () {
      return chrome.storage.sync.get("settings").then(function (r) { return mergeSettings(r.settings); });
    },
    setSiteEnabled: function (key, on) {
      return chrome.storage.sync.get("settings").then(function (r) {
        var s = r.settings && typeof r.settings === "object" ? r.settings : {};
        var sites = Object.assign({}, s.sites || {});
        sites[key] = !!on;
        return chrome.storage.sync.set({ settings: Object.assign({}, s, { sites: sites }) });
      });
    },
    onSettingsChanged: function (cb) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area === "sync" && changes.settings) cb(mergeSettings(changes.settings.newValue));
      });
    },
  });

  var lastHref = "";
  var lastTitle = "";
  function poll() {
    if (!alive()) { chip.destroy(); clearInterval(timer); return; }
    var hrefChanged = location.href !== lastHref;
    var titleChanged = document.title !== lastTitle;
    // Titles on chart sites tick with the price; only re-detect on a title change
    // when the URL alone didn't identify the instrument.
    if (hrefChanged || (titleChanged && !chip.fromUrl())) {
      lastHref = location.href;
      lastTitle = document.title;
      chip.detect(lastHref, lastTitle);
    }
  }
  var timer = setInterval(poll, 1000);
  poll();
})();
