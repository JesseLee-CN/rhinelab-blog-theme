-- G1 schema v1 for the boot identity service (SQLite, modernc.org/sqlite).
-- Times are Unix seconds (INTEGER). Opaque cookies are stored only as digests.
-- Incompatible schema versions must refuse to start (enforced in Go, not here).
-- The schema_migrations table is owned by the migrator (store.Migrate).

PRAGMA foreign_keys = ON;

CREATE TABLE users (
  user_id            TEXT PRIMARY KEY,
  username_key       TEXT NOT NULL UNIQUE,
  username           TEXT NOT NULL,
  password_hash      TEXT NOT NULL,
  enabled            INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  credential_version INTEGER NOT NULL DEFAULT 1 CHECK (credential_version >= 1),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE flows (
  flow_id         TEXT PRIMARY KEY,
  token_hash      TEXT NOT NULL UNIQUE,
  csrf_hash       TEXT NOT NULL,
  csrf_expires_at INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);

CREATE TABLE login_attempts (
  attempt_id         TEXT PRIMARY KEY,
  flow_id            TEXT NOT NULL REFERENCES flows(flow_id) ON DELETE CASCADE,
  state              TEXT NOT NULL CHECK (state IN
                       ('issued', 'verifying', 'pending', 'confirmed',
                        'cancelled', 'failed', 'expired')),
  user_id            TEXT REFERENCES users(user_id),
  credential_version INTEGER,
  session_id         TEXT,
  issued_at          INTEGER NOT NULL,
  pending_expires_at INTEGER,
  deadline_at        INTEGER NOT NULL
);

CREATE TABLE sessions (
  session_id          TEXT PRIMARY KEY,
  token_hash          TEXT NOT NULL UNIQUE,
  user_id             TEXT NOT NULL REFERENCES users(user_id),
  attempt_id          TEXT REFERENCES login_attempts(attempt_id),
  state               TEXT NOT NULL CHECK (state IN ('pending', 'active', 'revoked')),
  credential_version  INTEGER NOT NULL,
  csrf_hash           TEXT NOT NULL,
  idle_expires_at     INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  created_at          INTEGER NOT NULL,
  last_seen_at        INTEGER NOT NULL
);

CREATE TABLE rate_limits (
  bucket_key   TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

CREATE INDEX idx_sessions_user      ON sessions(user_id);
CREATE INDEX idx_sessions_state     ON sessions(state, idle_expires_at);
CREATE INDEX idx_attempts_flow      ON login_attempts(flow_id);
CREATE INDEX idx_attempts_state     ON login_attempts(state, deadline_at);
CREATE INDEX idx_flows_expiry       ON flows(expires_at);
CREATE INDEX idx_rate_limits_expiry ON rate_limits(expires_at);
