// Order-ticket validation and guardrails (pure: no I/O, unit-tested in worker/test/broker.test.ts).
// The Worker applies these at intent creation AND again at confirmation, with the limits current
// at that moment, so lowering a limit or flipping the kill switch also stops tickets in flight.
import { HttpError } from "../lib/http";
import * as v from "../lib/validate";

export const EXCHANGES = ["NSE", "BSE", "NFO", "BFO", "CDS", "BCD", "MCX"] as const;
export const PRODUCTS = ["CNC", "MIS", "NRML", "MTF"] as const;
export const ORDER_TYPES = ["MARKET", "LIMIT", "SL", "SL-M"] as const;
export const SIDES = ["BUY", "SELL"] as const;
export const VALIDITIES = ["DAY", "IOC"] as const;

export type Exchange = (typeof EXCHANGES)[number];
export type Product = (typeof PRODUCTS)[number];
export type OrderType = (typeof ORDER_TYPES)[number];

/** Kite tradingsymbols: INFY, M&M, BAJAJ-AUTO, NIFTY25NOVFUT, NIFTY2511324000CE ... */
export const TRADINGSYMBOL_RE = /^[A-Z0-9][A-Z0-9&_.-]{0,39}$/;
/** Buffer applied to the client's estimated price for MARKET / SL-M orders. */
export const MARKET_BUFFER = 0.02;
/** Hard ceilings for the owner-editable limits (sanity, not policy). */
export const HARD_MAX_ORDER_VALUE_INR = 10_000_000;
export const HARD_MAX_QTY = 100_000;
export const HARD_MAX_DAILY_CAP = 500;
const MAX_PRICE = 10_000_000;

export interface Limits {
  tradingEnabled: boolean;
  maxOrderValueInr: number;
  maxQty: number;
  dailyOrderCap: number;
  allowedExchanges: string[];
  allowedProducts: string[];
}

export interface OrderTicket {
  exchange: Exchange;
  tradingsymbol: string;
  transaction_type: (typeof SIDES)[number];
  quantity: number;
  product: Product;
  order_type: OrderType;
  price: number | null; // LIMIT, SL
  trigger_price: number | null; // SL, SL-M
  validity: (typeof VALIDITIES)[number];
  estPrice: number | null; // MARKET, SL-M (client's estimate, used only for the value guardrail)
  signalId: string | null;
}

function price(vv: unknown, field: string): number {
  const p = v.num(vv, field, { gt: 0, max: MAX_PRICE });
  // Up to 4 decimals (currency derivatives tick in 0.0025); the exchange enforces the real tick.
  // p * 10^4 carries a few ulps of float error, which exceeds a fixed 1e-6 once p > ~2^20 (it
  // wrongly rejected e.g. 8765432.1234), so the tolerance scales with magnitude. The canonical
  // 4-decimal value is returned so float noise (1501.0500000000002) never reaches Kite.
  const units = Math.round(p * 10_000);
  if (Math.abs(p * 10_000 - units) > Math.max(1e-6, p * 10_000 * 4 * Number.EPSILON)) throw v.invalid(field, "must have at most 4 decimals");
  return units / 10_000;
}

function absent(vv: unknown): boolean {
  return vv === undefined || vv === null || vv === "" || vv === 0;
}

/** Parse + validate an order ticket from a JSON body (field names follow Kite's). */
export function parseTicket(body: Record<string, unknown>): OrderTicket {
  const exchange = v.oneOf(typeof body.exchange === "string" ? body.exchange.toUpperCase() : body.exchange, "exchange", EXCHANGES);
  if (typeof body.tradingsymbol !== "string") throw v.invalid("tradingsymbol", "must be a string");
  const tradingsymbol = body.tradingsymbol.trim().toUpperCase();
  if (!TRADINGSYMBOL_RE.test(tradingsymbol)) throw v.invalid("tradingsymbol", "must be 1-40 chars of A-Z 0-9 & _ . -");
  const transaction_type = v.oneOf(body.transaction_type, "transaction_type", SIDES);
  const quantity = v.num(body.quantity, "quantity", { integer: true, min: 1, max: HARD_MAX_QTY });
  const product = v.oneOf(body.product, "product", PRODUCTS);
  const order_type = v.oneOf(body.order_type, "order_type", ORDER_TYPES);
  const validity = body.validity === undefined || body.validity === null || body.validity === "" ? "DAY" : v.oneOf(body.validity, "validity", VALIDITIES);

  const needsPrice = order_type === "LIMIT" || order_type === "SL";
  const needsTrigger = order_type === "SL" || order_type === "SL-M";
  const needsEst = order_type === "MARKET" || order_type === "SL-M";

  let p: number | null = null;
  if (needsPrice) p = price(body.price, "price");
  else if (!absent(body.price)) throw v.invalid("price", `must be omitted for ${order_type} orders`);

  let trig: number | null = null;
  if (needsTrigger) trig = price(body.trigger_price, "trigger_price");
  else if (!absent(body.trigger_price)) throw v.invalid("trigger_price", `must be omitted for ${order_type} orders`);

  let est: number | null = null;
  if (needsEst) {
    if (absent(body.estPrice)) throw v.invalid("estPrice", `is required for ${order_type} orders (used for the value limit, +${MARKET_BUFFER * 100}% buffer)`);
    est = price(body.estPrice, "estPrice");
  }

  if (order_type === "SL" && p !== null && trig !== null) {
    // BUY stop: trigger <= limit price; SELL stop: trigger >= limit price (Kite rejects otherwise).
    if (transaction_type === "BUY" && trig > p) throw v.invalid("trigger_price", "must be at or below the limit price for a BUY stop-loss");
    if (transaction_type === "SELL" && trig < p) throw v.invalid("trigger_price", "must be at or above the limit price for a SELL stop-loss");
  }

  const signalId = body.signalId === undefined || body.signalId === null || body.signalId === "" ? null : v.signalId(body.signalId);
  return { exchange, tradingsymbol, transaction_type, quantity, product, order_type, price: p, trigger_price: trig, validity, estPrice: est, signalId };
}

/** Value the limit is checked against: price x qty, or estPrice (x trigger) + 2% buffer x qty. */
export function ticketValue(t: Pick<OrderTicket, "order_type" | "quantity" | "price" | "trigger_price" | "estPrice">): { value: number; basis: "price" | "est_price_buffered" } {
  if (t.order_type === "LIMIT" || t.order_type === "SL") return { value: round2((t.price ?? 0) * t.quantity), basis: "price" };
  const ref = Math.max(t.estPrice ?? 0, t.order_type === "SL-M" ? (t.trigger_price ?? 0) : 0);
  return { value: round2(ref * (1 + MARKET_BUFFER) * t.quantity), basis: "est_price_buffered" };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function conflict(code: string, message: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(409, code, { message, ...extra });
}

/**
 * Throws 409 with a specific code for the first guardrail that fails. Order of checks:
 * kill switch, connection, allowed exchange/product, ticket sanity (fail closed), quantity, value, daily cap.
 */
export function enforceLimits(
  t: OrderTicket,
  limits: Limits,
  ctx: { connected: boolean; confirmedToday: number },
): { value: number; basis: "price" | "est_price_buffered" } {
  if (!limits.tradingEnabled) throw conflict("trading_disabled", "Trading is switched off (kill switch). Enable it in Limits first.");
  if (!ctx.connected) throw conflict("broker_not_connected", "Kite isn't connected, or today's session has expired. Connect Kite again.");
  if (!limits.allowedExchanges.includes(t.exchange)) throw conflict("exchange_not_allowed", `${t.exchange} isn't in the allowed exchanges.`, { allowed: limits.allowedExchanges });
  if (!limits.allowedProducts.includes(t.product)) throw conflict("product_not_allowed", `${t.product} isn't in the allowed products.`, { allowed: limits.allowedProducts });
  // Fail closed on a malformed ticket (the confirm path rebuilds it from the stored payload): a
  // NaN quantity or a missing price would otherwise compare false against every limit below and pass.
  if (!Number.isInteger(t.quantity) || t.quantity < 1) throw conflict("ticket_invalid", "The ticket has no valid quantity. Create it again.");
  const needsEst = t.order_type === "MARKET" || t.order_type === "SL-M";
  const ref = needsEst ? t.estPrice : t.price;
  if (typeof ref !== "number" || !Number.isFinite(ref) || ref <= 0) {
    throw conflict("ticket_invalid", `The ticket has no valid ${needsEst ? "estimated price" : "price"}, so its value can't be checked. Create it again.`);
  }
  if (t.order_type === "SL-M" && !(typeof t.trigger_price === "number" && Number.isFinite(t.trigger_price) && t.trigger_price > 0)) {
    throw conflict("ticket_invalid", "The SL-M ticket has no valid trigger price. Create it again.");
  }
  // Negated <= comparisons so a NaN limit (corrupt row) blocks instead of passing.
  if (!(t.quantity <= limits.maxQty)) throw conflict("qty_over_limit", `Quantity ${t.quantity} is above the limit of ${limits.maxQty}.`, { limit: limits.maxQty, actual: t.quantity });
  const val = ticketValue(t);
  if (!(val.value <= limits.maxOrderValueInr)) {
    throw conflict("value_over_limit", `Order value ₹${val.value.toFixed(2)} is above the limit of ₹${limits.maxOrderValueInr.toFixed(2)}.`, {
      limit: limits.maxOrderValueInr,
      actual: val.value,
      basis: val.basis,
    });
  }
  if (!(ctx.confirmedToday < limits.dailyOrderCap)) {
    throw conflict("daily_cap_reached", `The daily cap of ${limits.dailyOrderCap} confirmed orders is reached.`, { limit: limits.dailyOrderCap, actual: ctx.confirmedToday });
  }
  return val;
}

/**
 * MARKET / SL-M orders have no price of their own, so their value check needs a price the SERVER
 * verified (Tudumm's live 5paisa quote or Kite's LTP). The higher of that and the client's estimate is
 * used. With no live price the ticket is refused: use a LIMIT (or SL) order, which carries its price.
 */
export function withServerPrice(t: OrderTicket, live: number | null): OrderTicket {
  if (t.order_type !== "MARKET" && t.order_type !== "SL-M") return t;
  if (!(typeof live === "number" && Number.isFinite(live) && live > 0)) {
    throw conflict("live_price_unavailable", "A MARKET or SL-M order needs a live price the server can verify, and none is available for this symbol right now. Use a LIMIT order, or SL with a limit price.");
  }
  const est = typeof t.estPrice === "number" && Number.isFinite(t.estPrice) && t.estPrice > 0 ? t.estPrice : 0;
  return { ...t, estPrice: Math.max(est, live) };
}

/** The exact parameter set the relay POSTs to /orders/regular (all strings, whitelisted). */
export function kitePayload(t: OrderTicket, tag: string): Record<string, string> {
  const p: Record<string, string> = {
    exchange: t.exchange,
    tradingsymbol: t.tradingsymbol,
    transaction_type: t.transaction_type,
    order_type: t.order_type,
    quantity: String(t.quantity),
    product: t.product,
    validity: t.validity,
    tag,
  };
  if (t.price !== null) p.price = String(t.price);
  if (t.trigger_price !== null) p.trigger_price = String(t.trigger_price);
  // Market protection (automatic) for MARKET and SL-M, as Kite/exchanges expect for API market orders.
  if (t.order_type === "MARKET" || t.order_type === "SL-M") p.market_protection = "-1";
  return p;
}

/** Rebuild a ticket from a stored payload (for re-checking guardrails at confirm time). */
export function ticketFromPayload(p: Record<string, string>, estPrice: number | null, signalId: string | null): OrderTicket {
  return {
    exchange: p.exchange as Exchange,
    tradingsymbol: p.tradingsymbol ?? "",
    transaction_type: p.transaction_type === "SELL" ? "SELL" : "BUY",
    quantity: Number(p.quantity),
    product: p.product as Product,
    order_type: p.order_type as OrderType,
    price: p.price !== undefined ? Number(p.price) : null,
    trigger_price: p.trigger_price !== undefined ? Number(p.trigger_price) : null,
    validity: p.validity === "IOC" ? "IOC" : "DAY",
    estPrice,
    signalId,
  };
}

/** Kite order tag: "tdm" + 17 hex chars of the intent id (alphanumeric, 20 chars max). */
export function intentTag(intentId: string): string {
  return `tdm${intentId.replace(/-/g, "").slice(0, 17)}`;
}
export const TAG_RE = /^tdm[0-9a-f]{17}$/;

/** One line for the review step / audit, e.g. "BUY 10 NSE:INFY LIMIT @ 1500 · CNC · DAY". */
export function describeTicket(t: OrderTicket): string {
  const px =
    t.order_type === "LIMIT"
      ? ` @ ${t.price}`
      : t.order_type === "SL"
        ? ` @ ${t.price} (trigger ${t.trigger_price})`
        : t.order_type === "SL-M"
          ? ` (trigger ${t.trigger_price}, est ${t.estPrice})`
          : ` (est ${t.estPrice})`;
  return `${t.transaction_type} ${t.quantity} ${t.exchange}:${t.tradingsymbol} ${t.order_type}${px} · ${t.product} · ${t.validity}`;
}

/** Validate a PUT /limits body against the current limits (omitted fields keep their value). */
export function parseLimitsUpdate(body: Record<string, unknown>, cur: Limits): Omit<Limits, "tradingEnabled"> {
  const out = {
    maxOrderValueInr: cur.maxOrderValueInr,
    maxQty: cur.maxQty,
    dailyOrderCap: cur.dailyOrderCap,
    allowedExchanges: cur.allowedExchanges,
    allowedProducts: cur.allowedProducts,
  };
  if (body.maxOrderValueInr !== undefined) out.maxOrderValueInr = round2(v.num(body.maxOrderValueInr, "maxOrderValueInr", { min: 1, max: HARD_MAX_ORDER_VALUE_INR }));
  if (body.maxQty !== undefined) out.maxQty = v.num(body.maxQty, "maxQty", { integer: true, min: 1, max: HARD_MAX_QTY });
  if (body.dailyOrderCap !== undefined) out.dailyOrderCap = v.num(body.dailyOrderCap, "dailyOrderCap", { integer: true, min: 0, max: HARD_MAX_DAILY_CAP });
  if (body.allowedExchanges !== undefined) out.allowedExchanges = subset(body.allowedExchanges, "allowedExchanges", EXCHANGES);
  if (body.allowedProducts !== undefined) out.allowedProducts = subset(body.allowedProducts, "allowedProducts", PRODUCTS);
  if ("tradingEnabled" in body) throw v.invalid("tradingEnabled", "use POST /api/admin/broker/trading (kill switch)");
  return out;
}

function subset(vv: unknown, field: string, all: readonly string[]): string[] {
  const arr = v.stringArray(vv, field, all.length);
  const out: string[] = [];
  for (const x of arr) {
    const s = v.oneOf(typeof x === "string" ? x.toUpperCase() : x, field, all);
    if (!out.includes(s)) out.push(s);
  }
  if (!out.length) throw v.invalid(field, "must not be empty");
  return all.filter((a) => out.includes(a));
}
