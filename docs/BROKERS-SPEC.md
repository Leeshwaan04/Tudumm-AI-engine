# Tudumm — "Connect your broker" (multi-broker, multi-market) spec

Goal: every Tudumm user can connect **their own** broker or exchange account for each market they trade. Connections serve two purposes:
- **(a) Portfolio sync:** holdings, positions, orders and funds, so signals are portfolio-aware.
- **(b) One-click order tickets from a signal**, always confirmed by the user. There is no auto-trading.

## Hard rules (regulatory + security)
- **India (all brokers):** since 1 Apr 2026, API **order placement must originate from a static IP** registered with the broker. Read APIs work from any IP. Orders therefore go through Tudumm's **static-IP order relay** (see `relay/`). For multi-user platforms, the broker registers Tudumm as a **vendor/partner app**, and the relay's IP is the vendor IP. Client-developed or manual orders below 10 orders/sec need no exchange algo registration. Tudumm-issued *signals* to other users need **SEBI Research Analyst** registration before order tickets are enabled for them.
- **Crypto exchanges:** users create API keys with **trade-only permission, withdrawals disabled, IP-restricted to the relay's static IP**. Keys are encrypted at rest (AES-GCM, per-record IV, key from HKDF over a dedicated secret `BROKER_VAULT_KEY`), are never returned to the browser, and are shown masked (last 4 characters).
- **US:** use OAuth apps (Alpaca Connect etc.). Some brokers (IBKR, Schwab, Tradier) need partner approval first.
- Feature flags per broker × capability: `broker:<id>:sync`, `broker:<id>:orders`. Order tickets for **other users** stay OFF until the compliance gate is explicitly enabled by the owner in admin (`user_trading` flag, default off). The owner's own account is exempt, behind the existing owner-only broker routes.
- Every connect, disconnect and order is audit-logged. Users can disconnect any time, which revokes the token at the broker where an API exists and deletes the credentials.

## Adapter interface (`worker/src/broker/adapters/<id>.ts`)
```ts
interface BrokerAdapter {
  id: string; name: string; markets: MarketId[]; authKind: "oauth" | "api_key" | "token_paste";
  configured(env): boolean;                       // partner/vendor credentials present
  authUrl?(env, state): string;                   // oauth
  exchange?(env, params): Promise<Session>;       // oauth callback / token exchange
  validateKey?(env, creds): Promise<Session>;     // api_key / token_paste
  profile(env, s): Promise<{accountId, name?}>;
  holdings(env, s), positions(env, s), orders(env, s), funds(env, s);  // normalized shapes
  buildOrder(intent): RelayOrderRequest;          // relay places it (static IP)
  revoke?(env, s): Promise<void>;
  sessionExpiry(s): string | null;                // e.g. Kite 06:00 IST next day
}
```
Normalized shapes live in `worker/src/broker/types.ts`. The owner-only Kite integration is the first adapter. Generalize its storage: `broker_connections` with columns user_id, broker_id, account_id, creds_enc, iv, status, expires_at, created_at, last_sync_at.

## Broker catalog (shown to users per market)
| Market | Broker / exchange | Connection | What the user does | Tudumm prerequisite |
|---|---|---|---|---|
| India equity, F&O, MCX | **Zerodha** (Kite Connect) | OAuth-style login (request_token) | Click Connect, then log in to Zerodha | Tudumm Kite Connect app (type *Connect*) plus the relay static IP |
| | **Upstox** | OAuth 2.0 (code flow) | Connect, then Upstox login | Upstox developer app (redirect URL) plus static IP |
| | **Angel One** (SmartAPI) | Publisher login redirect | Connect, then Angel login (with TOTP) | SmartAPI app plus static IP |
| | **Dhan** (DhanHQ) | Partner consent flow | Connect, then Dhan consent | Dhan partner credentials plus static IP |
| | **Fyers** (API v3) | OAuth 2.0 | Connect, then Fyers login | Fyers app plus static IP |
| | ICICI Direct (Breeze), Kotak Neo, 5paisa | API key + session | Planned | Partner onboarding |
| US stocks/ETFs/options | **Alpaca** (incl. paper trading) | OAuth 2.0 (Alpaca Connect) | Connect, then Alpaca login | Alpaca OAuth app (free) |
| | Interactive Brokers | Web API OAuth | Planned | IBKR third-party approval |
| | Charles Schwab, Tradier | OAuth | Planned | Partner approval |
| Crypto | **Bybit**, **Binance**, OKX, Kraken, Coinbase Advanced | User API key (trade-only, no withdrawals, IP whitelist) | Step-by-step key creation guide, then paste key/secret | Relay static IP published on the page |
| | CoinDCX, Delta Exchange India | User API key | Same pattern | Same |
| FX / CFDs | **OANDA** (v20) | Personal access token | Generate a token in the OANDA portal, then paste it | None (OAuth partner later) |
| Commodities | India MCX via the Indian brokers above; global via IBKR | — | — | — |

**Bold = phase 2 build targets.** The others appear in the catalog with an honest "Planned" or "Needs partner approval" state, plus a "Notify me" button that creates a support ticket or interest event. No dead buttons.

## User-facing UI (`/app/brokers`)
- Market tabs (India · US · Crypto · FX · Commodities) with broker cards: logo initials, supported markets, connection method, and a status chip (Connected / Available / Needs setup by Tudumm / Planned).
- **Connect flow per auth kind:**
  - OAuth: Connect → broker → callback → success screen.
  - API key: a guided checklist with exact menu paths for creating the key. It covers trade-only permission, no withdrawals, and pasting the IP whitelist value, which is shown with a copy button. The user then pastes the key/secret into a masked form, followed by validation (a read call) and a success screen.
  - Token paste: the same pattern.
- Connected card: the account id (masked), last sync time, holdings/positions summary, an expiry countdown (Kite and others expire daily, so show "Reconnect"), and Disconnect.
- Signal → "Prepare order" opens the order ticket for a connected broker in that market. It's prefilled from the signal (side, entry as a limit price, quantity from the position sizer, with stop/target noted). A review screen shows the guardrails, then the user confirms. It's only enabled when `user_trading` and the broker's `orders` flag are on; otherwise it says why.
- Admin: a **Brokers** page with the catalog configuration (enable or disable per broker × capability), configured status per broker (which secrets are present), connection counts, and the relay status.

## Owner tasks this creates (business onboarding)
1. Zerodha: Kite Connect app of type *Connect* (₹500/month) for multi-user. Register the relay static IP.
2. Upstox / Angel One / Dhan / Fyers: create developer or partner apps (redirect URL `https://tudumm.in/api/v1/brokers/<id>/callback`). Register the static IP.
3. Alpaca: create an OAuth app (free) with the same redirect pattern.
4. SEBI RA registration before enabling `user_trading` for other users in India.
