-- 0002: account-management audit trail.
--
-- Every account mutation (CLI or admin API) appends exactly one row here, so a
-- database can be reconciled with what operators did to it. Rows are immutable:
-- the store only ever INSERTs. `target` holds the username key when the account
-- still exists and the raw reference otherwise, because deleting an account must
-- not delete the record of who deleted it.

CREATE TABLE audit_log (
  audit_id  TEXT PRIMARY KEY,
  at        INTEGER NOT NULL,
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL,
  target    TEXT NOT NULL,
  detail    TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_audit_at     ON audit_log(at DESC);
CREATE INDEX idx_audit_target ON audit_log(target, at DESC);
CREATE INDEX idx_audit_action ON audit_log(action, at DESC);
