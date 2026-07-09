CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  lat REAL,
  lng REAL,
  default_session_types TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  session_type TEXT NOT NULL CHECK (session_type IN ('direct', 'parent_training', 'supervision')),
  date TEXT NOT NULL,
  start_time TEXT,
  duration_min INTEGER NOT NULL DEFAULT 60,
  time_fixed INTEGER NOT NULL DEFAULT 0,
  location_override TEXT,
  status TEXT NOT NULL DEFAULT 'unscheduled' CHECK (status IN ('unscheduled', 'scheduled', 'completed', 'cancelled')),
  kanban_column TEXT NOT NULL DEFAULT 'unscheduled',
  kanban_order INTEGER NOT NULL DEFAULT 0,
  calendar_event_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date);
CREATE INDEX IF NOT EXISTS idx_sessions_client ON sessions(client_id);

CREATE TABLE IF NOT EXISTS drive_segments (
  id TEXT PRIMARY KEY,
  from_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  to_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  minutes REAL NOT NULL,
  miles REAL NOT NULL,
  computed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_drive_segments_date ON drive_segments(date);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Minimal OAuth 2.1 + PKCE + Dynamic Client Registration, required by
-- ChatGPT's MCP connector protocol even for a single-user server. See
-- src/main/oauth/server.ts.

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  redirect_uris TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  access_token TEXT PRIMARY KEY,
  refresh_token TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
