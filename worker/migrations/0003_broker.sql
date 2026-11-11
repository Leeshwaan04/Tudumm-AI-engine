-- 0003_broker.sql — Zerodha Kite Connect order integration (owner's OWN account only).
-- Every order is confirmed by hand in the admin portal; nothing here trades automatically.
-- Orders are placed by the static-IP relay (relay/kite-relay.mjs), which PULLS confirmed intents.
--
-- Conventions follow 0001_core.sql: TEXT ids (crypto.randomUUID()), ISO-8601 UTC timestamps,
-- secrets stored hashed (state nonces, confirm tokens) or encrypted (the Kite access token).
-- Independent of 0002_market.sql. Never edit 0001/0002 (applied in production).

-- One row per successful Kite login. At most one is active (revoked_at IS NULL); older rows are
-- revoked and their ciphertext wiped. The access token is AES-256-GCM encrypted with a key derived
-- via HKDF-SHA-256 from KITE_API_SECRET; additional data binds it to (row id, kite_user_id).
CREATE TABLE broker_sessions (
  id            TEXT PRIMARY KEY,
  broker        TEXT NOT NULL DEFAULT 'kite' CHECK (broker IN ('kite')),
  kite_user_id  TEXT NOT NULL,
  token_ct      TEXT NOT NULL,                           -- base64url ciphertext ('' once wiped)
  token_iv      TEXT NOT NULL,                           -- base64url 96-bit IV ('' once wiped)
  created_by    TEXT NOT NULL,                           -- admin:<session prefix>
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,                           -- next 06:00 IST after login (Kite's daily expiry)
  last_used_at  TEXT,
  revoked_at    TEXT,
  revoke_reason TEXT                                     -- reconnect | disconnect | token_exception | decrypt_failed
);
CREATE INDEX idx_broker_sessions_active ON broker_sessions (revoked_at, created_at);

-- OAuth-style state for the Kite login redirect: single-use, 10 minutes, bound to the admin session
-- that started it. Only the hash of the nonce is stored.
CREATE TABLE broker_login_states (
  id               TEXT PRIMARY KEY,
  state_hash       TEXT NOT NULL UNIQUE,
  admin_session_id TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  consumed_at      TEXT
);
CREATE INDEX idx_broker_login_states_created ON broker_login_states (created_at);

-- Order intents: pending_confirm -> queued -> claimed -> placed | rejected | failed
--                pending_confirm | queued -> cancelled | expired
-- payload is the exact, whitelisted Kite order parameter set the relay sends (JSON object of strings).
CREATE TABLE order_intents (
  id                 TEXT PRIMARY KEY,
  created_by         TEXT NOT NULL,                      -- admin:<session prefix>
  admin_session_id   TEXT NOT NULL,                      -- confirm must come from the same admin session
  signal_id          TEXT,
  payload            TEXT NOT NULL,
  est_price          REAL,                               -- client's estimate (MARKET / SL-M only)
  est_value_inr      REAL NOT NULL,                      -- value the guardrail checked
  value_basis        TEXT NOT NULL CHECK (value_basis IN ('price', 'est_price_buffered')),
  status             TEXT NOT NULL CHECK (status IN ('pending_confirm', 'queued', 'claimed', 'placed', 'rejected', 'failed', 'cancelled', 'expired')),
  confirm_token_hash TEXT,                               -- cleared once the intent leaves pending_confirm
  tag                TEXT NOT NULL UNIQUE,               -- Kite order tag ("tdm" + 17 hex) for reconciliation
  kite_order_id      TEXT,
  kite_status        TEXT,                               -- latest Kite status seen (postbacks)
  error              TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  expires_at         TEXT NOT NULL,                      -- pending_confirm: created + 2 min; queued: confirmed + 2 min
  confirmed_at       TEXT,
  claimed_at         TEXT,
  completed_at       TEXT
);
CREATE INDEX idx_order_intents_status ON order_intents (status, created_at);
CREATE INDEX idx_order_intents_created ON order_intents (created_at);
CREATE INDEX idx_order_intents_confirmed ON order_intents (confirmed_at);
CREATE UNIQUE INDEX uq_order_intents_kite_order ON order_intents (kite_order_id) WHERE kite_order_id IS NOT NULL;

-- Kite postbacks (checksum-verified). payload is a whitelisted subset (no checksum).
CREATE TABLE order_updates (
  id            TEXT PRIMARY KEY,
  dedupe_key    TEXT NOT NULL UNIQUE,
  kite_order_id TEXT NOT NULL,
  intent_id     TEXT,
  status        TEXT,
  payload       TEXT NOT NULL,
  received_at   TEXT NOT NULL
);
CREATE INDEX idx_order_updates_order ON order_updates (kite_order_id, received_at);
CREATE INDEX idx_order_updates_received ON order_updates (received_at);

-- Relay liveness. ip is the relay host's public egress IP (the owner's own server, not user data):
-- the owner must register exactly this IP in the Kite developer console, so it is stored in clear.
CREATE TABLE relay_heartbeats (
  id            TEXT PRIMARY KEY,                        -- 'relay' (single relay)
  ip            TEXT NOT NULL,
  version       TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  prev_ip       TEXT,
  ip_changed_at TEXT
);

-- Guardrails (single row). Trading is OFF until the owner flips the kill switch.
CREATE TABLE broker_limits (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  trading_enabled     INTEGER NOT NULL DEFAULT 0 CHECK (trading_enabled IN (0, 1)),
  max_order_value_inr REAL NOT NULL DEFAULT 25000 CHECK (max_order_value_inr > 0),
  max_qty             INTEGER NOT NULL DEFAULT 100 CHECK (max_qty > 0),
  daily_order_cap     INTEGER NOT NULL DEFAULT 10 CHECK (daily_order_cap >= 0),
  allowed_exchanges   TEXT NOT NULL DEFAULT '["NSE","BSE"]',   -- JSON array
  allowed_products    TEXT NOT NULL DEFAULT '["CNC","MIS"]',   -- JSON array
  updated_at          TEXT NOT NULL,
  updated_by          TEXT NOT NULL
);
INSERT INTO broker_limits (id, updated_at, updated_by) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed');

-- Owner-visible feed for broker events (postbacks, relay results, session changes). The admin is
-- not a row in `users`, so core `notifications` can't be used.
CREATE TABLE broker_notifications (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('order', 'session', 'relay')),
  title      TEXT NOT NULL,
  body       TEXT,
  ref_id     TEXT,                                       -- order intent id or kite order id
  created_at TEXT NOT NULL,
  read_at    TEXT,
  dedupe_key TEXT UNIQUE
);
CREATE INDEX idx_broker_notifications_created ON broker_notifications (created_at);
