-- 0002_market.sql — market data + live signal engine (data+engine agent).
-- Independent of 0001_core.sql (no foreign keys into core tables), so it applies with or without it.
-- Timestamps are ISO-8601 TEXT (UTC); candle times are unix seconds (bar OPEN time, UTC).

-- Universe (mirrors worker/src/market/instruments.ts; `enabled` lets ops pause an instrument).
CREATE TABLE IF NOT EXISTS instruments (
  symbol       TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  exchange     TEXT NOT NULL,
  market       TEXT NOT NULL CHECK (market IN ('IN', 'US', 'EU', 'CRYPTO', 'FX', 'CMDTY')),
  asset_class  TEXT NOT NULL CHECK (asset_class IN ('index', 'equity', 'etf', 'crypto', 'fx', 'commodity')),
  currency     TEXT NOT NULL,
  decimals     INTEGER NOT NULL CHECK (decimals BETWEEN 0 AND 8),
  source       TEXT NOT NULL,
  freshness    TEXT NOT NULL CHECK (freshness IN ('realtime', 'delayed-15m', 'eod', 'daily-ref')),
  proxy_note   TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  data_symbol  TEXT NOT NULL,
  ohlc         INTEGER NOT NULL DEFAULT 1 CHECK (ohlc IN (0, 1))
);

-- Latest price per symbol (also holds auxiliary series such as ^VIX and INDIAVIX).
CREATE TABLE IF NOT EXISTS quotes (
  symbol      TEXT PRIMARY KEY,
  price       REAL NOT NULL,
  prev_close  REAL,
  change_pct  REAL,
  day_open    REAL,
  day_high    REAL,
  day_low     REAL,
  volume      REAL,
  bid         REAL,
  ask         REAL,
  bid_size    REAL,
  ask_size    REAL,
  as_of       TEXT NOT NULL,
  source      TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- OHLCV bars; writers prune to ~400 bars per symbol x tf.
CREATE TABLE IF NOT EXISTS candles (
  symbol  TEXT NOT NULL,
  tf      TEXT NOT NULL CHECK (tf IN ('15m', '1H', '4H', '1D', '1W')),
  t       INTEGER NOT NULL,
  o       REAL NOT NULL,
  h       REAL NOT NULL,
  l       REAL NOT NULL,
  c       REAL NOT NULL,
  v       REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (symbol, tf, t)
) WITHOUT ROWID;

-- Compact JSON snapshots: deriv:SYM (option chain / perp), depth:SYM, fund:SYM, ctx:CRYPTO|US|IN|USD, meta keys.
CREATE TABLE IF NOT EXISTS snapshots (
  key         TEXT PRIMARY KEY,
  json        TEXT NOT NULL,
  as_of       TEXT NOT NULL,
  source      TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Live signals issued by engine v0 (rule-based, uncalibrated). Sit-outs live in engine_state.
CREATE TABLE IF NOT EXISTS live_signals (
  id                 TEXT PRIMARY KEY,
  symbol             TEXT NOT NULL,
  market             TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('pending', 'active', 't1_hit', 'closed')),
  held               INTEGER NOT NULL DEFAULT 0 CHECK (held IN (0, 1)),
  hold_reason        TEXT,
  published          INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)), -- 1 once its ledger "issue" entry exists
  direction          TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  style              TEXT NOT NULL,
  timeframe          TEXT NOT NULL,
  tf_sec             INTEGER NOT NULL,
  strategy           TEXT NOT NULL,
  strategy_label     TEXT NOT NULL,
  regime             TEXT NOT NULL,
  confidence         REAL NOT NULL,
  entry_low          REAL NOT NULL,
  entry_high         REAL NOT NULL,
  stop               REAL NOT NULL,
  stop_current       REAL NOT NULL,
  target1            REAL NOT NULL,
  target2            REAL NOT NULL,
  rr1                REAL NOT NULL,
  rr2                REAL NOT NULL,
  decimals           INTEGER NOT NULL,
  layers             TEXT NOT NULL,  -- JSON {price,flow,derivatives,fundamentals,context}
  layer_notes        TEXT NOT NULL,  -- JSON {layer: reason} for null layers
  layer_detail       TEXT NOT NULL,  -- JSON {layer: explanation}
  thesis             TEXT NOT NULL,
  invalidation       TEXT,
  issued_at          TEXT NOT NULL,
  issued_bar_t       INTEGER NOT NULL,
  expiry_bars        INTEGER NOT NULL,
  pending_bars       INTEGER NOT NULL,
  bars_elapsed       INTEGER NOT NULL DEFAULT 0,
  checked_through_t  INTEGER,
  activated_at       TEXT,
  t1_at              TEXT,
  closed_at          TEXT,
  closed_bar_t       INTEGER,
  outcome            TEXT CHECK (outcome IS NULL OR outcome IN ('target', 'trailed', 'stopped', 'expired', 'invalidated')),
  exit_price         REAL,
  r                  REAL,
  close_reason       TEXT,
  engine             TEXT NOT NULL DEFAULT 'v0',
  calibrated         INTEGER NOT NULL DEFAULT 0 CHECK (calibrated IN (0, 1)),
  source             TEXT NOT NULL,
  freshness          TEXT NOT NULL,
  issued_by          TEXT NOT NULL DEFAULT 'cron',
  updated_at         TEXT NOT NULL
);
-- Never two open signals for one symbol (protects against a cron/runner race).
CREATE UNIQUE INDEX IF NOT EXISTS live_signals_one_open ON live_signals (symbol) WHERE status IN ('pending', 'active', 't1_hit');
CREATE INDEX IF NOT EXISTS live_signals_symbol_issued ON live_signals (symbol, issued_at);
CREATE INDEX IF NOT EXISTS live_signals_status_issued ON live_signals (status, issued_at);
CREATE INDEX IF NOT EXISTS live_signals_market_issued ON live_signals (market, issued_at);

-- Lifecycle events; also an OUTBOX: rows with notified_at NULL are dispatched to api/hooks.onSignalEvent.
CREATE TABLE IF NOT EXISTS signal_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id     TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  market        TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('issued', 'activated', 't1_hit', 'closed', 'invalidated', 'held', 'released')),
  direction     TEXT,
  at            TEXT NOT NULL,
  detail        TEXT,
  notified_at   TEXT,
  notify_error  TEXT
);
CREATE INDEX IF NOT EXISTS signal_events_signal ON signal_events (signal_id, id);
CREATE INDEX IF NOT EXISTS signal_events_outbox ON signal_events (id) WHERE notified_at IS NULL;

-- Append-only hash chain v2 (see worker/README-market.md). seq starts at 1; genesis prev_hash = 64 zeros.
CREATE TABLE IF NOT EXISTS live_ledger (
  seq         INTEGER PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('issue', 'close')),
  signal_id   TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  market      TEXT NOT NULL,
  style       TEXT NOT NULL,
  strategy    TEXT NOT NULL,
  direction   TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  entry_low   REAL NOT NULL,
  entry_high  REAL NOT NULL,
  stop        REAL NOT NULL,
  target1     REAL NOT NULL,
  target2     REAL NOT NULL,
  exit        REAL,
  outcome     TEXT,
  r           REAL,
  at          TEXT NOT NULL,
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL UNIQUE,
  UNIQUE (signal_id, type)
);
CREATE TRIGGER IF NOT EXISTS live_ledger_chain BEFORE INSERT ON live_ledger
WHEN NEW.prev_hash <> COALESCE((SELECT hash FROM live_ledger WHERE seq = NEW.seq - 1), '0000000000000000000000000000000000000000000000000000000000000000')
  OR (NEW.seq > 1 AND NOT EXISTS (SELECT 1 FROM live_ledger WHERE seq = NEW.seq - 1))
BEGIN
  SELECT RAISE(ABORT, 'ledger_chain_mismatch');
END;
CREATE TRIGGER IF NOT EXISTS live_ledger_no_update BEFORE UPDATE ON live_ledger
BEGIN
  SELECT RAISE(ABORT, 'ledger_append_only');
END;
CREATE TRIGGER IF NOT EXISTS live_ledger_no_delete BEFORE DELETE ON live_ledger
BEGIN
  SELECT RAISE(ABORT, 'ledger_append_only');
END;

-- Kill switch per strategy x market.
CREATE TABLE IF NOT EXISTS strategies (
  strategy    TEXT NOT NULL,
  market      TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL,
  PRIMARY KEY (strategy, market)
);

CREATE TABLE IF NOT EXISTS source_health (
  source           TEXT PRIMARY KEY,
  ok               INTEGER NOT NULL DEFAULT 0 CHECK (ok IN (0, 1)),
  last_success_at  TEXT,
  last_error       TEXT,
  last_run_at      TEXT
);

-- Latest engine evaluation per instrument (the "view" shown when there is no open signal, incl. sit-outs).
CREATE TABLE IF NOT EXISTS engine_state (
  symbol        TEXT PRIMARY KEY,
  last_bar_t    INTEGER,
  evaluated_at  TEXT NOT NULL,
  view          TEXT NOT NULL,
  run_by        TEXT NOT NULL
);

INSERT OR IGNORE INTO instruments (symbol, name, exchange, market, asset_class, currency, decimals, source, freshness, proxy_note, enabled, data_symbol, ohlc) VALUES
  ('NIFTY', 'NIFTY 50', 'NSE', 'IN', 'index', 'INR', 2, 'nse-archives', 'eod', NULL, 1, 'Nifty 50', 1),
  ('BANKNIFTY', 'Nifty Bank', 'NSE', 'IN', 'index', 'INR', 2, 'nse-archives', 'eod', NULL, 1, 'Nifty Bank', 1),
  ('RELIANCE', 'Reliance Industries', 'NSE', 'IN', 'equity', 'INR', 2, 'nse-archives', 'eod', NULL, 1, 'RELIANCE', 1),
  ('HDFCBANK', 'HDFC Bank', 'NSE', 'IN', 'equity', 'INR', 2, 'nse-archives', 'eod', NULL, 1, 'HDFCBANK', 1),
  ('TCS', 'Tata Consultancy Services', 'NSE', 'IN', 'equity', 'INR', 2, 'nse-archives', 'eod', NULL, 1, 'TCS', 1),
  ('INFY', 'Infosys', 'NSE', 'IN', 'equity', 'INR', 2, 'nse-archives', 'eod', NULL, 1, 'INFY', 1),
  ('ICICIBANK', 'ICICI Bank', 'NSE', 'IN', 'equity', 'INR', 2, 'nse-archives', 'eod', NULL, 1, 'ICICIBANK', 1),
  ('SBIN', 'State Bank of India', 'NSE', 'IN', 'equity', 'INR', 2, 'nse-archives', 'eod', NULL, 1, 'SBIN', 1),
  ('SPY', 'SPDR S&P 500 ETF', 'NYSE Arca', 'US', 'etf', 'USD', 2, 'cboe', 'delayed-15m', NULL, 1, 'SPY', 1),
  ('NVDA', 'NVIDIA', 'NASDAQ', 'US', 'equity', 'USD', 2, 'cboe', 'delayed-15m', NULL, 1, 'NVDA', 1),
  ('AAPL', 'Apple', 'NASDAQ', 'US', 'equity', 'USD', 2, 'cboe', 'delayed-15m', NULL, 1, 'AAPL', 1),
  ('TSLA', 'Tesla', 'NASDAQ', 'US', 'equity', 'USD', 2, 'cboe', 'delayed-15m', NULL, 1, 'TSLA', 1),
  ('MSFT', 'Microsoft', 'NASDAQ', 'US', 'equity', 'USD', 2, 'cboe', 'delayed-15m', NULL, 1, 'MSFT', 1),
  ('ASML', 'ASML Holding', 'NASDAQ (US listing)', 'EU', 'equity', 'USD', 2, 'cboe', 'delayed-15m', 'Priced from ASML''s NASDAQ listing in USD (free Cboe delayed feed). The Euronext Amsterdam line in EUR isn''t on a free feed.', 1, 'ASML', 1),
  ('BTCUSDT', 'Bitcoin', 'Binance', 'CRYPTO', 'crypto', 'USDT', 1, 'binance', 'realtime', NULL, 1, 'BTCUSDT', 1),
  ('ETHUSDT', 'Ethereum', 'Binance', 'CRYPTO', 'crypto', 'USDT', 2, 'binance', 'realtime', NULL, 1, 'ETHUSDT', 1),
  ('SOLUSDT', 'Solana', 'Binance', 'CRYPTO', 'crypto', 'USDT', 2, 'binance', 'realtime', NULL, 1, 'SOLUSDT', 1),
  ('EURUSD', 'Euro / US Dollar', 'FX (OTC)', 'FX', 'fx', 'USD', 5, 'ecb-frankfurter', 'daily-ref', 'ECB euro foreign-exchange reference rate (one fix per business day, ~16:00 CET). Close only, no intraday high/low.', 1, 'EUR', 0),
  ('USDINR', 'US Dollar / Indian Rupee', 'FX (OTC)', 'FX', 'fx', 'INR', 4, 'ecb-frankfurter', 'daily-ref', 'ECB euro foreign-exchange reference rate (one fix per business day, ~16:00 CET). Close only, no intraday high/low.', 1, 'INR', 0),
  ('USDJPY', 'US Dollar / Japanese Yen', 'FX (OTC)', 'FX', 'fx', 'JPY', 3, 'ecb-frankfurter', 'daily-ref', 'ECB euro foreign-exchange reference rate (one fix per business day, ~16:00 CET). Close only, no intraday high/low.', 1, 'JPY', 0),
  ('XAUUSD', 'Gold Spot (PAXG proxy)', 'Binance (PAXG)', 'CMDTY', 'commodity', 'USD', 2, 'binance', 'realtime', 'PAXG proxy: Paxos Gold token on Binance (1 PAXG = 1 fine troy oz), quoted in USDT. It tracks spot gold closely but can deviate; it is not the XAUUSD OTC rate or COMEX GC.', 1, 'PAXGUSDT', 1),
  ('CL', 'WTI Crude Oil (USO proxy)', 'NYSE Arca (USO)', 'CMDTY', 'commodity', 'USD', 2, 'cboe', 'delayed-15m', 'USO proxy: prices are the United States Oil Fund ETF (holds near-month WTI futures), NOT the NYMEX CL contract. Levels are in USO dollars; roll costs make USO drift from spot WTI.', 1, 'USO', 1);

INSERT OR IGNORE INTO strategies (strategy, market, enabled, updated_at, updated_by) VALUES
  ('trend_continuation', 'IN', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed'),
  ('trend_continuation', 'US', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed'),
  ('trend_continuation', 'EU', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed'),
  ('trend_continuation', 'CRYPTO', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed'),
  ('trend_continuation', 'FX', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed'),
  ('trend_continuation', 'CMDTY', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed'),
  ('ema20_pullback', 'IN', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed'),
  ('ema20_pullback', 'US', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed'),
  ('ema20_pullback', 'EU', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed'),
  ('ema20_pullback', 'CRYPTO', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed'),
  ('ema20_pullback', 'FX', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed'),
  ('ema20_pullback', 'CMDTY', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seed');

INSERT OR IGNORE INTO source_health (source, ok, last_success_at, last_error, last_run_at) VALUES
  ('binance', 0, NULL, NULL, NULL),
  ('binance-futures', 0, NULL, NULL, NULL),
  ('bybit', 0, NULL, NULL, NULL),
  ('alternative-me', 0, NULL, NULL, NULL),
  ('cboe', 0, NULL, NULL, NULL),
  ('sec-edgar', 0, NULL, NULL, NULL),
  ('nse-archives', 0, NULL, NULL, NULL),
  ('ecb-frankfurter', 0, NULL, NULL, NULL);
