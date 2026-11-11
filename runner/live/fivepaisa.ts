// 5paisa Xstream market-data client (DATA ONLY: Tudumm never places orders through 5paisa; orders go
// through Zerodha Kite). Endpoints and payloads follow 5paisa's docs (xstream.5paisa.com/dev-docs) and
// its official Python SDK (github.com/5paisa/py5paisa: urlconst.py, py5paisa.py).
//
// Secrets (app key, encryption key, PIN, TOTP secret, access token) never appear in logs or errors.
import { totp, totpSecondsLeft } from "./totp.ts";

const BASE = "https://Openapi.5paisa.com/VendorsAPI/Service1.svc/";
const HISTORICAL = "https://openapi.5paisa.com/V2/historical/";
/** Constant request header the official SDK sends with every REST call. */
const API_UID = "ka7SFqAU6SC";
const TIMEOUT_MS = 15_000;

export interface FpConfig {
  appKey: string; // "User Key" on the Xstream API keys page (sent as head.Key)
  encryptionKey: string;
  userId: string;
  clientCode: string;
  pin: string;
  totpSecret: string; // base32 secret shown when TOTP was enabled for the 5paisa account
  /** Ocp-Apim-Subscription-Key for the historical endpoint (the official SDK ships a public one). */
  subscriptionKey: string | null;
}

export interface FpTick {
  Exch?: string;
  ExchType?: string;
  Token?: number;
  LastRate?: number;
  LastQty?: number;
  TotalQty?: number;
  High?: number;
  Low?: number;
  OpenRate?: number;
  PClose?: number;
  AvgRate?: number;
  BidQty?: number;
  BidRate?: number;
  OffQty?: number;
  OffRate?: number;
  ChgPcnt?: number;
  TickDt?: string;
}

export interface FpScrip {
  exch: "N" | "B" | "M";
  exchType: "C" | "D" | "U";
  code: number;
}

export class FpError extends Error {}

function redact(text: string, secrets: (string | null | undefined)[]): string {
  let t = text;
  for (const s of secrets) if (s && s.length >= 4) t = t.split(s).join("«redacted»");
  return t.slice(0, 300);
}

/** "/Date(1706956047000+0530)/" -> epoch ms (null when absent or the .NET zero date). */
export function parseNetDate(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = /\/Date\((-?\d+)/.exec(s);
  if (!m) return null;
  const ms = Number(m[1]);
  return ms > 946684800000 ? ms : null;
}

/** Websocket host from the access token's RedirectServer claim (same mapping as the official SDK). */
export function feedUrlFor(accessToken: string): string {
  let server = "";
  try {
    const payload = accessToken.split(".")[1] ?? "";
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as { RedirectServer?: string };
    server = String(json.RedirectServer ?? "");
  } catch {
    /* fall through to the default host */
  }
  if (server === "A") return "wss://aopenfeed.5paisa.com/feeds/api/chat?Value1=";
  if (server === "B") return "wss://bopenfeed.5paisa.com/feeds/api/chat?Value1=";
  return "wss://openfeed.5paisa.com/feeds/api/chat?Value1=";
}

export class FivePaisa {
  cfg: FpConfig;
  accessToken: string | null = null;
  clientCode: string;
  loggedInAt = 0;

  constructor(cfg: FpConfig) {
    this.cfg = cfg;
    this.clientCode = cfg.clientCode;
  }

  private secrets() {
    return [this.cfg.appKey, this.cfg.encryptionKey, this.cfg.pin, this.cfg.totpSecret, this.accessToken, this.cfg.subscriptionKey];
  }

  private async post(path: string, body: unknown, auth: boolean): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { "content-type": "application/json", "5Paisa-API-Uid": API_UID };
    if (auth) {
      if (!this.accessToken) throw new FpError("not logged in");
      headers.authorization = `Bearer ${this.accessToken}`;
    }
    const res = await fetch(BASE + path, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    if (!res.ok) throw new FpError(`${path}: HTTP ${res.status} ${redact(text, this.secrets())}`);
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      // 5paisa answers some bad requests with an HTML "Request Error" page
      throw new FpError(`${path}: non-JSON response (${redact(text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "), this.secrets())})`);
    }
  }

  /** TOTP login -> request token -> access token (valid until 23:59 IST the same day). */
  async login(): Promise<void> {
    // a code with < 5 s left can expire in flight; wait for the next window
    const left = totpSecondsLeft();
    if (left < 5) await new Promise((r) => setTimeout(r, (left + 1) * 1000));
    const r1 = await this.post("TOTPLogin", { head: { Key: this.cfg.appKey }, body: { Email_ID: this.cfg.clientCode, TOTP: totp(this.cfg.totpSecret), PIN: this.cfg.pin } }, false);
    const b1 = (r1.body ?? {}) as { Status?: number; RequestToken?: string; Message?: string };
    if (b1.Status !== 0 || !b1.RequestToken) throw new FpError(`TOTP login refused: ${redact(String(b1.Message ?? "no request token"), this.secrets())}`);
    const r2 = await this.post("GetAccessToken", { head: { Key: this.cfg.appKey }, body: { RequestToken: b1.RequestToken, EncryKey: this.cfg.encryptionKey, UserId: this.cfg.userId } }, false);
    const b2 = (r2.body ?? {}) as { Status?: number; AccessToken?: string; ClientCode?: string; Message?: string };
    if (!b2.AccessToken) throw new FpError(`access token refused: ${redact(String(b2.Message ?? "no access token"), this.secrets())}`);
    this.accessToken = b2.AccessToken;
    if (b2.ClientCode) this.clientCode = String(b2.ClientCode);
    this.loggedInAt = Date.now();
  }

  /** Scrip master CSV for one segment (nse_eq, nse_fo, bse_eq, mcx_fo, ncd_fo, bse_fo, all). */
  async scripMasterCsv(segment: string): Promise<string> {
    const res = await fetch(`${BASE}ScripMaster/segment/${encodeURIComponent(segment)}`, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new FpError(`scrip master ${segment}: HTTP ${res.status}`);
    return res.text();
  }

  /** OHLCV candles. interval: 1m 3m 5m 10m 15m 30m 60m 1d. Dates are YYYY-MM-DD (IST trading dates). */
  async historical(s: FpScrip, interval: string, from: string, to: string): Promise<[string, number, number, number, number, number][]> {
    if (!this.accessToken) throw new FpError("not logged in");
    const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${this.accessToken}` };
    if (this.cfg.subscriptionKey) headers["Ocp-Apim-Subscription-Key"] = this.cfg.subscriptionKey;
    const url = `${HISTORICAL}${s.exch}/${s.exchType.toLowerCase()}/${s.code}/${interval}?from=${from}&end=${to}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    if (!res.ok) throw new FpError(`historical ${s.code}/${interval}: HTTP ${res.status} ${redact(text, this.secrets())}`);
    let j: { status?: string; data?: { candles?: unknown[] } };
    try {
      j = JSON.parse(text) as typeof j;
    } catch {
      throw new FpError(`historical ${s.code}/${interval}: non-JSON response`);
    }
    const c = j?.data?.candles;
    if (!Array.isArray(c)) throw new FpError(`historical ${s.code}/${interval}: ${redact(text, this.secrets())}`);
    return c.filter((x): x is [string, number, number, number, number, number] => Array.isArray(x) && x.length >= 6 && typeof x[0] === "string");
  }

  /** REST snapshot of the latest ticks (fallback when the websocket is quiet for a scrip). */
  async marketFeed(list: FpScrip[]): Promise<FpTick[]> {
    const r = await this.post(
      "V1/MarketFeed",
      {
        head: { key: this.cfg.appKey, requestCode: "5PMF" },
        body: { ClientCode: this.clientCode, COUNT: this.clientCode, MarketFeedData: list.map((s) => ({ Exch: s.exch, ExchType: s.exchType, ScripCode: String(s.code) })), LastRequestTime: "/Date(0)/", RefreshRate: "H" },
      },
      true,
    );
    const data = ((r.body ?? {}) as { Data?: FpTick[] }).Data;
    return Array.isArray(data) ? data : [];
  }

  feedUrl(): string {
    if (!this.accessToken) throw new FpError("not logged in");
    return `${feedUrlFor(this.accessToken)}${this.accessToken}|${this.clientCode}`;
  }
}

/* ---------------- websocket feed (MarketFeedV3) with reconnect + watchdog ---------------- */

export interface FeedHandlers {
  onTicks(ticks: FpTick[]): void;
  onState(state: "open" | "closed" | "error", detail: string): void;
}

export class FpFeed {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoff = 2_000;
  private lastMsg = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private fp: FivePaisa;
  private scrips: FpScrip[];
  private h: FeedHandlers;
  constructor(fp: FivePaisa, scrips: FpScrip[], h: FeedHandlers) {
    this.fp = fp;
    this.scrips = scrips;
    this.h = h;
  }

  start(): void {
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => {
      // quiet for 45 s while connected: assume a half-open socket and reconnect
      if (this.ws && this.ws.readyState === WebSocket.OPEN && Date.now() - this.lastMsg > 45_000) {
        this.h.onState("error", "no messages for 45 s; reconnecting");
        this.ws.close();
      }
    }, 15_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.fp.feedUrl());
    } catch (e) {
      this.h.onState("error", e instanceof Error ? e.message : "connect failed");
      this.retry();
      return;
    }
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.backoff = 2_000;
      this.lastMsg = Date.now();
      ws.send(JSON.stringify({ Method: "MarketFeedV3", Operation: "Subscribe", ClientCode: this.fp.clientCode, MarketFeedData: this.scrips.map((s) => ({ Exch: s.exch, ExchType: s.exchType, ScripCode: s.code })) }));
      this.h.onState("open", `subscribed ${this.scrips.length} scrips`);
    });
    ws.addEventListener("message", (ev) => {
      this.lastMsg = Date.now();
      const raw = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString("utf8");
      try {
        const j = JSON.parse(raw) as unknown;
        const ticks = (Array.isArray(j) ? j : [j]).filter((t): t is FpTick => !!t && typeof t === "object" && typeof (t as FpTick).Token === "number");
        if (ticks.length) this.h.onTicks(ticks);
      } catch {
        /* non-JSON keepalive / status text */
      }
    });
    ws.addEventListener("error", () => this.h.onState("error", "websocket error"));
    ws.addEventListener("close", (ev) => {
      if (this.ws === ws) this.ws = null;
      this.h.onState("closed", `code ${ev.code}`);
      this.retry();
    });
  }

  private retry(): void {
    if (this.stopped) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 60_000);
    setTimeout(() => this.connect(), wait);
  }
}
