CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT UNIQUE NOT NULL,
  ts TEXT NOT NULL,
  domain TEXT NOT NULL,
  query_type TEXT,
  status TEXT,
  client_name TEXT,
  client_ip TEXT,
  protocol TEXT,
  reasons TEXT,
  raw TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_logs_domain ON logs(domain);
CREATE INDEX IF NOT EXISTS idx_logs_status ON logs(status);
CREATE TABLE IF NOT EXISTS sync_state (
  id INTEGER PRIMARY KEY CHECK (id=1),
  last_cursor TEXT,
  last_sync TEXT,
  last_error TEXT
);
INSERT OR IGNORE INTO sync_state(id) VALUES (1);
