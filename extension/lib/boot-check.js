/* Boot watchdog (classic script; no inline code, so it passes the extension CSP).
 *
 * Preview mode is usually served by `python3 -m http.server`, whose listen backlog
 * is 5: on macOS a burst of parallel module/font requests can be refused, which
 * fails the whole ES-module graph. When the page's module script errors (or never
 * boots), reload the page a couple of times; then explain and offer Reload. Never
 * leave an endless loading state.
 */
(function () {
  "use strict";
  var KEY = "tudumm-boot-retry:" + location.pathname;
  var MAX = 3;

  function tries() {
    try { return Number(sessionStorage.getItem(KEY) || 0); } catch (e) { return MAX; }
  }
  function setTries(n) {
    try { sessionStorage.setItem(KEY, String(n)); } catch (e) { /* storage blocked */ }
  }
  function booted() {
    return document.documentElement.dataset.booted === "1";
  }
  function giveUp() {
    if (booted()) return;
    var slot = document.querySelector(".loading");
    if (!slot) return;
    var p = document.createElement("p");
    p.className = "boot-fail";
    p.textContent = "Tudumm didn't finish loading: a file was blocked or the local server dropped a request.";
    var b = document.createElement("button");
    b.type = "button";
    b.className = "btn btn--primary btn--sm";
    b.textContent = "Reload";
    b.addEventListener("click", function () { setTries(0); location.reload(); });
    slot.textContent = "";
    slot.appendChild(p);
    slot.appendChild(b);
  }
  function retry() {
    if (booted()) return;
    var n = tries();
    if (n >= MAX) return giveUp();
    setTries(n + 1);
    setTimeout(function () { location.reload(); }, 150 + n * 250);
  }

  // A failed fetch anywhere in a module graph fires `error` on its <script type=module>.
  document.addEventListener("error", function (e) {
    var t = e.target;
    if (t && t.tagName === "SCRIPT" && t.type === "module") retry();
  }, true);

  // Successful boot resets the counter for next time.
  var obs = setInterval(function () {
    if (booted()) { clearInterval(obs); setTries(0); }
  }, 250);
  setTimeout(function () { if (!booted()) retry(); }, 6000);
})();
