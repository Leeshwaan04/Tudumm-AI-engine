// Broker integration: normalized shapes + the adapter contract (docs/BROKERS-SPEC.md).
// Phase 1 ships ONE adapter (Zerodha Kite, owner's own account). Phase 2 adds per-user
// connections and more adapters (Upstox, Angel One, Dhan, Fyers, Alpaca, Bybit, Binance, OANDA)
// behind the same interface, the same D1 tables and the same static-IP relay protocol.
import type { Env } from "../env";

export type MarketId = "IN" | "US" | "EU" | "CRYPTO" | "FX" | "CMDTY";

/** `broker_connections.user_id` / `order_intents.user_id` value for the owner's own account. */
export const OWNER = "owner";

/** A live, decrypted connection handed to adapter calls. Never serialised to a browser. */
export interface Session {
  connectionId: string;
  brokerId: string;
  accountId: string;
  /** Decrypted credential material (Kite: the access token; key-based brokers: JSON). */
  creds: string;
  expiresAt: string | null;
}

/** What an auth exchange / key validation yields before it is sealed and stored. */
export interface NewSession {
  accountId: string;
  creds: string;
  name?: string;
}

/* ---------------- normalized portfolio shapes (all numbers in the account currency) ---------------- */

export interface NormHolding {
  symbol: string;
  exchange: string;
  isin: string | null;
  product: string | null;
  quantity: number;
  t1Quantity: number;
  avgPrice: number;
  lastPrice: number;
  closePrice: number | null;
  pnl: number;
  dayChange: number | null;
  dayChangePct: number | null;
}

export interface NormPosition {
  symbol: string;
  exchange: string;
  product: string;
  quantity: number;
  overnightQuantity: number;
  avgPrice: number;
  lastPrice: number;
  pnl: number;
  m2m: number | null;
  unrealised: number | null;
  realised: number | null;
  buyQuantity: number;
  buyValue: number;
  sellQuantity: number;
  sellValue: number;
}

export interface NormOrder {
  orderId: string;
  exchangeOrderId: string | null;
  status: string;
  statusMessage: string | null;
  symbol: string;
  exchange: string;
  side: "BUY" | "SELL" | string;
  orderType: string;
  product: string;
  validity: string | null;
  variety: string | null;
  quantity: number;
  filledQuantity: number;
  pendingQuantity: number;
  cancelledQuantity: number;
  price: number | null;
  triggerPrice: number | null;
  avgPrice: number | null;
  placedAt: string | null;
  tag: string | null;
}

export interface NormFundsSegment {
  id: string; // "equity" | "commodity" | "spot" | ...
  enabled: boolean;
  net: number | null;
  available: Record<string, number>;
  utilised: Record<string, number>;
}

export interface NormFunds {
  currency: string;
  segments: NormFundsSegment[];
}

/** A broker-pushed order update (postback / webhook), already authenticated by the adapter. */
export interface NormOrderUpdate {
  orderId: string;
  status: string | null;
  statusMessage: string | null;
  clientRef: string | null; // our tag, for reconciliation
  symbol: string | null;
  exchange: string | null;
  side: string | null;
  quantity: number | null;
  /** Whitelisted, scalar-only copy of the payload for order_updates.payload. */
  stored: Record<string, string | number | boolean | null>;
  /** Fields that make two updates "the same" (dedupe). */
  dedupeParts: unknown[];
}

/* ---------------- order tickets ---------------- */

/** Broker-agnostic order ticket, stored in order_intents.ticket and shown in the UI. */
export interface OrderTicket {
  exchange: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  product: string;
  orderType: "MARKET" | "LIMIT" | "SL" | "SL-M";
  price: number | null; // LIMIT, SL
  triggerPrice: number | null; // SL, SL-M
  validity: "DAY" | "IOC";
  estPrice: number | null; // MARKET, SL-M: client's estimate, only for the value guardrail
  signalId: string | null;
}

/** What a broker accepts on a ticket (validation is driven by this). */
export interface TicketSpec {
  exchanges: readonly string[];
  products: readonly string[];
  orderTypes: readonly OrderTicket["orderType"][];
  validities: readonly OrderTicket["validity"][];
  symbolPattern: RegExp;
  currency: string;
}

/**
 * Relay protocol (broker-agnostic). The Worker's adapter builds the full HTTP request; the relay
 * (relay/kite-relay.mjs) only executes it from the static IP — after checking the URL's origin
 * against its allowlist — then extracts the order id / error with the `response` paths and
 * reports `{ intentId, ok, orderId?, error? }`. It never retries a placement.
 */
export interface RelayOrderRequest {
  method: "POST";
  url: string;
  headers: Record<string, string>; // includes credentials: never logged by the relay
  form?: Record<string, string>; // application/x-www-form-urlencoded
  json?: Record<string, unknown>; // application/json (phase 2 brokers)
  response: {
    successPath?: string; // dotted path that must equal successValue (e.g. "status")
    successValue?: string | number | boolean;
    orderIdPath: string; // e.g. "data.order_id"
    errorPaths: string[]; // joined with ": " for the error text, e.g. ["error_type", "message"]
  };
}

/* ---------------- the adapter contract ---------------- */

export interface BrokerAdapter {
  id: string;
  name: string;
  markets: MarketId[];
  authKind: "oauth" | "api_key" | "token_paste";
  ticket: TicketSpec;
  /** App/vendor credentials present (capability gate). */
  configured(env: Env): boolean;
  /** Fallback HKDF input for the credential vault when BROKER_VAULT_KEY isn't set (see vault.ts). */
  vaultFallbackSecret?(env: Env): string | undefined;
  authUrl?(env: Env, state: string): string;
  exchange?(env: Env, params: URLSearchParams): Promise<NewSession>;
  validateKey?(env: Env, creds: Record<string, string>): Promise<NewSession>;
  profile(env: Env, s: Session): Promise<{ accountId: string; name?: string }>;
  holdings(env: Env, s: Session): Promise<NormHolding[]>;
  positions(env: Env, s: Session): Promise<{ net: NormPosition[]; day: NormPosition[] }>;
  orders(env: Env, s: Session): Promise<NormOrder[]>;
  funds(env: Env, s: Session): Promise<NormFunds>;
  /** Build the placement request the relay executes from the static IP. clientRef = our tag. */
  buildOrder(env: Env, s: Session, ticket: OrderTicket, clientRef: string): RelayOrderRequest;
  revoke?(env: Env, s: Session): Promise<void>;
  /** When credentials obtained now stop working (Kite: 06:00 IST next day), or null. */
  sessionExpiry(nowMs: number): string | null;
  /** Authenticate + normalize a broker push (postback/webhook). null => reject (401). */
  verifyPush?(env: Env, body: Record<string, unknown>): Promise<NormOrderUpdate | null>;
}

/** Errors from a broker API call. sessionInvalid => the stored credentials are dead. */
export class BrokerError extends Error {
  status: number;
  code: string;
  sessionInvalid: boolean;
  constructor(status: number, code: string, message: string, sessionInvalid = false) {
    super(message);
    this.status = status;
    this.code = code;
    this.sessionInvalid = sessionInvalid;
  }
}
