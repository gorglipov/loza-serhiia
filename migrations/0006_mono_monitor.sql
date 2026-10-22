-- Additive after 0005. Preview only for this release. No changes to mono_events/orders/payment.
CREATE TABLE IF NOT EXISTS mono_monitor_settings(
  id INTEGER PRIMARY KEY CHECK(id=1),notifications_enabled INTEGER NOT NULL DEFAULT 0 CHECK(notifications_enabled IN(0,1)),
  version INTEGER NOT NULL DEFAULT 0,fixture_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT OR IGNORE INTO mono_monitor_settings(id) VALUES(1);
CREATE TABLE IF NOT EXISTS mono_monitor_transactions(
  id TEXT PRIMARY KEY,account_ref TEXT NOT NULL CHECK(length(account_ref)=64),transaction_id TEXT NOT NULL CHECK(length(transaction_id) BETWEEN 1 AND 128),
  amount_kop INTEGER NOT NULL CHECK(typeof(amount_kop)='integer'),currency_code INTEGER NOT NULL,
  transaction_time INTEGER,hold INTEGER NOT NULL CHECK(hold IN(0,1)),
  verification_state TEXT NOT NULL CHECK(verification_state IN('unverified','verified','held','mismatch','not_found','excluded')),
  data_source TEXT NOT NULL CHECK(data_source IN('fixture','bank')),hint_mismatch INTEGER NOT NULL DEFAULT 0 CHECK(hint_mismatch IN(0,1)),
  verified_at INTEGER,updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(account_ref,transaction_id),
  CHECK(verification_state<>'verified' OR (amount_kop>0 AND currency_code=980 AND hold=0 AND transaction_time IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_mono_monitor_time ON mono_monitor_transactions(transaction_time DESC);
CREATE TABLE IF NOT EXISTS mono_monitor_sync_lock(
  account_ref TEXT PRIMARY KEY,next_sync_at INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,lease_token TEXT
);
CREATE TABLE IF NOT EXISTS mono_monitor_runs(
  id TEXT PRIMARY KEY,actor TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('running','done','failed')),
  started_at INTEGER NOT NULL,finished_at INTEGER,summary_json TEXT CHECK(summary_json IS NULL OR json_valid(summary_json)),error_code TEXT
);
CREATE TABLE IF NOT EXISTS mono_monitor_actions(
  id TEXT PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN('settings','retry')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS mono_monitor_notifications(
  id TEXT PRIMARY KEY,transaction_ref TEXT NOT NULL UNIQUE REFERENCES mono_monitor_transactions(id),
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN('queued','sending','retry','sent','failed','uncertain')),
  attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,lease_token TEXT,lease_until INTEGER,
  message_id INTEGER,last_error TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,sent_at TEXT
);
CREATE TABLE IF NOT EXISTS mono_monitor_fixture_orders(
  id TEXT PRIMARY KEY,amount_kop INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL
);
-- Settings and retries are applied exactly once and audited without exposing bank data.
CREATE TRIGGER IF NOT EXISTS loza_mono_monitor_action AFTER INSERT ON mono_monitor_actions BEGIN
  SELECT CASE WHEN NEW.action='settings' AND NOT EXISTS(SELECT 1 FROM mono_monitor_settings
    WHERE id=1 AND version=json_extract(NEW.payload_json,'$.version')) THEN RAISE(ABORT,'LOZA_VERSION_CONFLICT') END;
  UPDATE mono_monitor_settings SET notifications_enabled=json_extract(NEW.payload_json,'$.enabled'),version=version+1
    WHERE id=1 AND NEW.action='settings';
  UPDATE mono_monitor_notifications SET state='queued',attempts=0,next_attempt=0,last_error=NULL
    WHERE id=json_extract(NEW.payload_json,'$.eventId') AND NEW.action='retry' AND state IN('retry','failed','uncertain');
END;
INSERT OR IGNORE INTO loza_store_migrations(version) VALUES('0006_mono_monitor');
