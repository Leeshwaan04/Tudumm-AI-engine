-- Tudumm core schema (accounts, sessions, personalisation, notifications, activity, support,
-- admin, compliance, billing). Owned by the backend-core agent.
--
-- Conventions
--   * ids are TEXT (crypto.randomUUID()), timestamps are ISO-8601 UTC TEXT
--     ("2026-11-10T12:34:56.789Z") so string comparison == time comparison.
--   * money is an integer in the currency's minor unit (cents / paise).
--   * secrets (session tokens, OTPs, device tokens) are stored ONLY as SHA-256 / HMAC-SHA-256 hex.
--   * IP addresses are never stored, only ip_hash (HMAC with SESSION_PEPPER when set).
--   * users are never hard-deleted: account deletion anonymises the row (tombstone) and removes
--     the personal tables; audit_log is append-only (enforced by triggers below).

CREATE TABLE users (
  id               TEXT PRIMARY KEY,
  email            TEXT NOT NULL UNIQUE,                 -- lowercased; deleted+<id>@invalid after deletion
  email_verified   INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  display_name     TEXT,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  plan             TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'elite')),
  plan_source      TEXT NOT NULL DEFAULT 'default' CHECK (plan_source IN ('default', 'admin_grant', 'billing')),
  plan_expires_at  TEXT,
  created_at       TEXT NOT NULL,
  last_seen_at     TEXT,
  country          TEXT,
  marketing_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (marketing_opt_in IN (0, 1))
);
CREATE INDEX idx_users_created ON users (created_at);
CREATE INDEX idx_users_plan_status ON users (plan, status);
CREATE INDEX idx_users_status ON users (status, created_at);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id),
  token_hash   TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL CHECK (kind IN ('web', 'extension')),
  user_agent   TEXT,                                     -- truncated to 200 chars
  created_at   TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX idx_sessions_user ON sessions (user_id, revoked_at);
CREATE INDEX idx_sessions_last_used ON sessions (last_used_at);
CREATE INDEX idx_sessions_kind ON sessions (kind, revoked_at, expires_at);

-- email_hash (not the raw email) keeps the OTP table free of PII; rows are pruned after 24 h.
CREATE TABLE otp_codes (
  id          TEXT PRIMARY KEY,
  email_hash  TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  purpose     TEXT NOT NULL DEFAULT 'login' CHECK (purpose IN ('login')),
  delivery    TEXT NOT NULL CHECK (delivery IN ('email', 'dev')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT,
  ip_hash     TEXT
);
CREATE INDEX idx_otp_email ON otp_codes (email_hash, created_at);
CREATE INDEX idx_otp_created ON otp_codes (created_at);

-- UAT only: codes issued while AUTH_DEV_CODES=on and no email provider exists. The code is
-- already shown on the tester's screen, so it is not a secret; email is stored masked.
CREATE TABLE dev_outbox (
  id           TEXT PRIMARY KEY,
  otp_id       TEXT NOT NULL,
  email_masked TEXT NOT NULL,
  code         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX idx_dev_outbox_created ON dev_outbox (created_at);

CREATE TABLE profiles (
  user_id    TEXT PRIMARY KEY REFERENCES users (id),
  persona    TEXT NOT NULL CHECK (persona IN ('intraday', 'swing', 'options', 'investor')),
  markets    TEXT NOT NULL,                              -- JSON array of IN,US,EU,CRYPTO,FX,CMDTY
  capital    REAL NOT NULL CHECK (capital > 0),
  currency   TEXT NOT NULL CHECK (currency IN ('INR', 'USD', 'EUR', 'USDT', 'JPY')),
  risk_pct   REAL NOT NULL CHECK (risk_pct >= 0.1 AND risk_pct <= 5),
  onboarded  INTEGER NOT NULL DEFAULT 0 CHECK (onboarded IN (0, 1)),
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_profiles_onboarded ON profiles (onboarded);

CREATE TABLE consents (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id),
  kind         TEXT NOT NULL CHECK (kind IN ('terms', 'risk_disclosure', 'privacy', 'marketing')),
  version      TEXT NOT NULL,
  accepted_at  TEXT NOT NULL,
  withdrawn_at TEXT,
  ip_hash      TEXT
);
CREATE INDEX idx_consents_user ON consents (user_id, kind);
CREATE INDEX idx_consents_kind_version ON consents (kind, version);

CREATE TABLE watchlist (
  user_id  TEXT NOT NULL REFERENCES users (id),
  symbol   TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (user_id, symbol)
);
CREATE INDEX idx_watchlist_symbol ON watchlist (symbol);

-- signal_id is either a live signal id or 'sym:<SYMBOL>' (symbol-level tracking: follow whatever
-- signal is current for that symbol; this is what the v0.1 web app stores in localStorage).
CREATE TABLE tracked (
  user_id   TEXT NOT NULL REFERENCES users (id),
  signal_id TEXT NOT NULL,
  symbol    TEXT NOT NULL,
  added_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, signal_id)
);
CREATE INDEX idx_tracked_signal ON tracked (signal_id);
CREATE INDEX idx_tracked_symbol ON tracked (symbol);
CREATE INDEX idx_tracked_added ON tracked (added_at);

-- symbol '*' (new_signal / signal_update only) means "any symbol on my watchlist".
CREATE TABLE alerts (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users (id),
  symbol            TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('price_above', 'price_below', 'new_signal', 'signal_update')),
  threshold         REAL,
  one_shot          INTEGER NOT NULL DEFAULT 1 CHECK (one_shot IN (0, 1)),
  active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at        TEXT NOT NULL,
  last_triggered_at TEXT,
  CHECK (kind NOT IN ('price_above', 'price_below') OR (threshold IS NOT NULL AND threshold > 0))
);
CREATE INDEX idx_alerts_user ON alerts (user_id, created_at);
CREATE INDEX idx_alerts_symbol ON alerts (symbol, active, kind);
CREATE INDEX idx_alerts_kind ON alerts (kind, active);

CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id),
  kind       TEXT NOT NULL,                              -- price_alert | new_signal | signal_update | support_reply | system
  title      TEXT NOT NULL,
  body       TEXT,
  link       TEXT,
  created_at TEXT NOT NULL,
  read_at    TEXT,
  dedupe_key TEXT
);
CREATE INDEX idx_notifications_user ON notifications (user_id, created_at);
CREATE INDEX idx_notifications_unread ON notifications (user_id) WHERE read_at IS NULL;
CREATE UNIQUE INDEX uq_notifications_dedupe ON notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Activity events. No IP is ever stored: only country (from request.cf) and a coarse device class.
CREATE TABLE events (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  anon_id    TEXT,
  name       TEXT NOT NULL,
  props      TEXT,                                       -- JSON object, <= 2 KB
  path       TEXT,
  created_at TEXT NOT NULL,
  country    TEXT,
  device     TEXT CHECK (device IN ('mobile', 'desktop')),
  source     TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'extension'))
);
CREATE INDEX idx_events_created ON events (created_at);
CREATE INDEX idx_events_name ON events (name, created_at);
CREATE INDEX idx_events_user ON events (user_id, created_at);
CREATE INDEX idx_events_anon ON events (anon_id, created_at);

CREATE TABLE support_tickets (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  email      TEXT NOT NULL,
  category   TEXT NOT NULL CHECK (category IN ('bug', 'billing', 'signal', 'account', 'grievance', 'other')),
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'resolved', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_tickets_user ON support_tickets (user_id, updated_at);
CREATE INDEX idx_tickets_status ON support_tickets (status, updated_at);
CREATE INDEX idx_tickets_category ON support_tickets (category, status, created_at);

CREATE TABLE ticket_messages (
  id         TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL REFERENCES support_tickets (id),
  author     TEXT NOT NULL CHECK (author IN ('user', 'admin')),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ticket_messages_ticket ON ticket_messages (ticket_id, created_at);

CREATE TABLE admin_sessions (
  id         TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip_hash    TEXT,
  user_agent TEXT,
  revoked_at TEXT
);

CREATE TABLE admin_notes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id),
  body       TEXT NOT NULL,
  actor      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_admin_notes_user ON admin_notes (user_id, created_at);

CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  actor       TEXT NOT NULL,                             -- admin:<session-prefix> | user:<id> | system:<component> | anonymous
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  detail      TEXT,                                      -- JSON, never secrets
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log (created_at);
CREATE INDEX idx_audit_target ON audit_log (target_type, target_id);
CREATE INDEX idx_audit_action ON audit_log (action, created_at);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TABLE feature_flags (
  key        TEXT PRIMARY KEY,
  enabled    INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  value      TEXT,                                       -- optional JSON
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
INSERT INTO feature_flags (key, enabled, value, updated_at, updated_by) VALUES
  ('require_signal_approval', 0, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed'),
  ('live_data',               1, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed'),
  ('signups',                 1, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed'),
  ('extension_linking',       1, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed');

CREATE TABLE announcements (
  id         TEXT PRIMARY KEY,
  level      TEXT NOT NULL CHECK (level IN ('info', 'warning', 'critical')),
  message    TEXT NOT NULL,
  link       TEXT,
  starts_at  TEXT,
  ends_at    TEXT,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_announcements_active ON announcements (active, starts_at);

CREATE TABLE data_requests (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('export', 'delete')),
  status       TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'rejected')),
  created_at   TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_data_requests_status ON data_requests (status, created_at);
CREATE INDEX idx_data_requests_user ON data_requests (user_id, created_at);

CREATE TABLE ext_link_codes (
  id                TEXT PRIMARY KEY,
  user_code         TEXT NOT NULL UNIQUE,                -- 8 chars, unambiguous alphabet, shown as XXXX-XXXX
  device_token_hash TEXT NOT NULL UNIQUE,
  user_id           TEXT,
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  approved_at       TEXT,
  consumed_at       TEXT
);
CREATE INDEX idx_ext_link_created ON ext_link_codes (created_at);

CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL                          -- unix seconds, start of the fixed window
);
CREATE INDEX idx_rate_limits_window ON rate_limits (window_start);

CREATE TABLE payments (
  id           TEXT PRIMARY KEY,
  user_id      TEXT,
  provider     TEXT NOT NULL CHECK (provider IN ('razorpay', 'stripe')),
  provider_ref TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency     TEXT NOT NULL,
  plan         TEXT,
  status       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  raw          TEXT                                      -- JSON subset of the provider event (no card data is ever sent to us)
);
CREATE UNIQUE INDEX uq_payments_ref ON payments (provider, provider_ref);
CREATE INDEX idx_payments_user ON payments (user_id, created_at);
