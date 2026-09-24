package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// Account management is a separate surface from the login path: it is used by
// the CLI and by the admin HTTP API, and it is the only place that may delete
// accounts or read the audit trail. The interfaces below are what those callers
// depend on, so a handler test can substitute a fake store instead of SQLite.

var (
	// ErrLastAccount refuses to delete the final enabled account: with public
	// registration disabled that would lock every operator out of the service.
	ErrLastAccount = errors.New("store: refusing to delete the last enabled account")
)

// AccountQuery filters ListAccounts. Zero values mean "no filter, default page".
type AccountQuery struct {
	Search  string // case-insensitive substring of the stored username
	Enabled *bool  // nil = both
	Limit   int
	Offset  int
}

const (
	accountDefaultLimit = 100
	accountMaxLimit     = 500
)

func (q AccountQuery) normalized() AccountQuery {
	if q.Limit <= 0 {
		q.Limit = accountDefaultLimit
	}
	if q.Limit > accountMaxLimit {
		q.Limit = accountMaxLimit
	}
	if q.Offset < 0 {
		q.Offset = 0
	}
	q.Search = strings.TrimSpace(q.Search)
	return q
}

// AccountPage is one page of ListAccounts plus the unpaginated total.
type AccountPage struct {
	Users  []User
	Total  int
	Limit  int
	Offset int
}

// AuditEntry records one account mutation. Rows are append-only.
type AuditEntry struct {
	ID     string
	At     int64
	Actor  string // "cli:<user>", "admin-api", "system"
	Action string // "user.create", "user.disable", "user.password", ...
	Target string // username key, or the raw reference when the account is gone
	Detail string
}

// AuditQuery filters ListAudit.
type AuditQuery struct {
	Target string
	Action string
	Limit  int
	Offset int
}

func (q AuditQuery) normalized() AuditQuery {
	if q.Limit <= 0 {
		q.Limit = accountDefaultLimit
	}
	if q.Limit > accountMaxLimit {
		q.Limit = accountMaxLimit
	}
	if q.Offset < 0 {
		q.Offset = 0
	}
	q.Target = strings.TrimSpace(q.Target)
	q.Action = strings.TrimSpace(q.Action)
	return q
}

// SessionInfo is a session row joined with its account, for `session list`.
type SessionInfo struct {
	ID                string
	UserID            string
	Username          string
	State             string
	CreatedAt         int64
	LastSeenAt        int64
	IdleExpiresAt     int64
	AbsoluteExpiresAt int64
}

// SessionQuery filters ListSessions.
type SessionQuery struct {
	User   string // username, username key or user id
	State  string // pending | active | revoked
	Limit  int
	Offset int
}

func (q SessionQuery) normalized() SessionQuery {
	if q.Limit <= 0 {
		q.Limit = accountDefaultLimit
	}
	if q.Limit > accountMaxLimit {
		q.Limit = accountMaxLimit
	}
	if q.Offset < 0 {
		q.Offset = 0
	}
	q.User = strings.TrimSpace(q.User)
	q.State = strings.TrimSpace(q.State)
	return q
}

// Status summarizes the database for `db status` and GET /admin/status.
type Status struct {
	Path            string
	SchemaVersion   int
	Users           int
	Enabled         int
	Disabled        int
	SessionsActive  int
	SessionsPending int
	AuditEntries    int
	MigratedAt      int64
}

// UserDirectory is the account CRUD surface. References accept either a
// username (any case, separators included) or a user id.
type UserDirectory interface {
	CreateUser(username, plain string) (User, error)
	GetAccount(ref string) (User, error)
	ListAccounts(q AccountQuery) (AccountPage, error)
	SetAccountEnabled(ref string, enabled bool) (User, error)
	ResetAccountPassword(ref, plain string) (User, error)
	DeleteAccount(ref string, force bool) (User, error)
	RevokeAccountSessions(ref string) (int64, error)
}

// AuditLog is the append-only account-management trail.
type AuditLog interface {
	AppendAudit(entry AuditEntry) (AuditEntry, error)
	ListAudit(q AuditQuery) ([]AuditEntry, error)
}

// SessionDirectory reads and revokes sessions across accounts.
type SessionDirectory interface {
	ListSessions(q SessionQuery) ([]SessionInfo, error)
	RevokeAllSessions() (int64, error)
}

// AccountStore is everything the CLI and the admin API need from persistence.
type AccountStore interface {
	UserDirectory
	AuditLog
	SessionDirectory
	Status() (Status, error)
}

// GetAccount resolves a username or user id to one account.
func (s *Store) GetAccount(ref string) (User, error) {
	trimmed := strings.TrimSpace(ref)
	if trimmed == "" {
		return User{}, ErrNotFound
	}
	user, _, err := s.GetUserByKey(trimmed)
	if err == nil {
		return user, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return User{}, err
	}
	return s.GetUserByID(trimmed)
}

// GetUserByID returns one account by its immutable id.
func (s *Store) GetUserByID(id string) (User, error) {
	row := s.db.QueryRow(`SELECT `+userColumns+` FROM users WHERE user_id = ?`, id)
	user, err := scanUser(row)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, err
	}
	return user, nil
}

// ListAccounts pages through accounts with an optional search and state filter.
func (s *Store) ListAccounts(q AccountQuery) (AccountPage, error) {
	q = q.normalized()
	where := []string{"1 = 1"}
	args := []any{}
	if q.Search != "" {
		where = append(where, "username LIKE ? ESCAPE '\\'")
		args = append(args, "%"+escapeLike(strings.ToLower(q.Search))+"%")
	}
	if q.Enabled != nil {
		flag := 0
		if *q.Enabled {
			flag = 1
		}
		where = append(where, "enabled = ?")
		args = append(args, flag)
	}
	clause := strings.Join(where, " AND ")

	var total int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM users WHERE `+clause, args...).Scan(&total); err != nil {
		return AccountPage{}, err
	}
	rows, err := s.db.Query(
		`SELECT `+userColumns+` FROM users WHERE `+clause+` ORDER BY username_key LIMIT ? OFFSET ?`,
		append(append([]any{}, args...), q.Limit, q.Offset)...,
	)
	if err != nil {
		return AccountPage{}, err
	}
	defer rows.Close()
	page := AccountPage{Total: total, Limit: q.Limit, Offset: q.Offset, Users: []User{}}
	for rows.Next() {
		user, err := scanUser(rows)
		if err != nil {
			return AccountPage{}, err
		}
		page.Users = append(page.Users, user)
	}
	return page, rows.Err()
}

// escapeLike makes a user-supplied search literal for LIKE.
func escapeLike(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return replacer.Replace(value)
}

// SetAccountEnabled toggles an account and returns its new state.
func (s *Store) SetAccountEnabled(ref string, enabled bool) (User, error) {
	user, err := s.GetAccount(ref)
	if err != nil {
		return User{}, err
	}
	if err := s.SetEnabled(user.UsernameKey, enabled); err != nil {
		return User{}, err
	}
	return s.GetUserByID(user.ID)
}

// ResetAccountPassword sets a new password and returns the account; existing
// sessions are revoked by the underlying call.
func (s *Store) ResetAccountPassword(ref, plain string) (User, error) {
	user, err := s.GetAccount(ref)
	if err != nil {
		return User{}, err
	}
	if err := s.ResetPassword(user.UsernameKey, plain); err != nil {
		return User{}, err
	}
	return s.GetUserByID(user.ID)
}

// RevokeAccountSessions revokes every session of one account.
func (s *Store) RevokeAccountSessions(ref string) (int64, error) {
	user, err := s.GetAccount(ref)
	if err != nil {
		return 0, err
	}
	return s.RevokeSessions(user.ID)
}

// DeleteAccount removes an account and its dependent rows. login_attempts and
// sessions reference users without ON DELETE CASCADE, so they are removed in the
// same transaction; the audit trail is written by the caller and therefore
// survives the account.
func (s *Store) DeleteAccount(ref string, force bool) (User, error) {
	user, err := s.GetAccount(ref)
	if err != nil {
		return User{}, err
	}
	if user.Enabled && !force {
		var enabled int
		if err := s.db.QueryRow(`SELECT COUNT(*) FROM users WHERE enabled = 1`).Scan(&enabled); err != nil {
			return User{}, err
		}
		if enabled <= 1 {
			return User{}, fmt.Errorf("%w: %s", ErrLastAccount, user.Username)
		}
	}
	tx, err := s.db.Begin()
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback()
	for _, stmt := range []string{
		`DELETE FROM sessions WHERE user_id = ?`,
		`DELETE FROM login_attempts WHERE user_id = ?`,
	} {
		if _, err := tx.Exec(stmt, user.ID); err != nil {
			return User{}, err
		}
	}
	res, err := tx.Exec(`DELETE FROM users WHERE user_id = ?`, user.ID)
	if err != nil {
		return User{}, err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return User{}, err
	}
	if affected == 0 {
		return User{}, ErrNotFound
	}
	if err := tx.Commit(); err != nil {
		return User{}, err
	}
	return user, nil
}

// AppendAudit writes one immutable audit row.
func (s *Store) AppendAudit(entry AuditEntry) (AuditEntry, error) {
	action := strings.TrimSpace(entry.Action)
	if action == "" {
		return AuditEntry{}, errors.New("store: audit action required")
	}
	actor := strings.TrimSpace(entry.Actor)
	if actor == "" {
		actor = "system"
	}
	if entry.ID == "" {
		id, err := randomID("a_", 12)
		if err != nil {
			return AuditEntry{}, err
		}
		entry.ID = id
	}
	if entry.At == 0 {
		entry.At = s.now()
	}
	entry.Actor = actor
	entry.Action = action
	entry.Target = strings.TrimSpace(entry.Target)
	if _, err := s.db.Exec(
		`INSERT INTO audit_log(audit_id, at, actor, action, target, detail) VALUES(?, ?, ?, ?, ?, ?)`,
		entry.ID, entry.At, entry.Actor, entry.Action, entry.Target, entry.Detail,
	); err != nil {
		return AuditEntry{}, err
	}
	return entry, nil
}

// ListAudit returns the newest audit rows first.
func (s *Store) ListAudit(q AuditQuery) ([]AuditEntry, error) {
	q = q.normalized()
	where := []string{"1 = 1"}
	args := []any{}
	if q.Target != "" {
		where = append(where, "target = ?")
		args = append(args, q.Target)
	}
	if q.Action != "" {
		where = append(where, "action = ?")
		args = append(args, q.Action)
	}
	rows, err := s.db.Query(
		`SELECT audit_id, at, actor, action, target, detail FROM audit_log WHERE `+strings.Join(where, " AND ")+
			// rowid breaks ties inside one second, so "newest first" is also the
			// insertion order when a script performs several actions at once.
			` ORDER BY at DESC, rowid DESC LIMIT ? OFFSET ?`,
		append(append([]any{}, args...), q.Limit, q.Offset)...,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	entries := []AuditEntry{}
	for rows.Next() {
		var entry AuditEntry
		if err := rows.Scan(&entry.ID, &entry.At, &entry.Actor, &entry.Action, &entry.Target, &entry.Detail); err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	return entries, rows.Err()
}

// ListSessions returns session rows joined with their account.
func (s *Store) ListSessions(q SessionQuery) ([]SessionInfo, error) {
	q = q.normalized()
	where := []string{"1 = 1"}
	args := []any{}
	if q.User != "" {
		where = append(where, "(s.user_id = ? OR u.username_key = ?)")
		args = append(args, q.User, strings.ToLower(q.User))
	}
	if q.State != "" {
		where = append(where, "s.state = ?")
		args = append(args, q.State)
	}
	rows, err := s.db.Query(
		`SELECT s.session_id, s.user_id, u.username, s.state, s.created_at, s.last_seen_at,
		        s.idle_expires_at, s.absolute_expires_at
		   FROM sessions s JOIN users u ON u.user_id = s.user_id
		  WHERE `+strings.Join(where, " AND ")+`
		  ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
		append(append([]any{}, args...), q.Limit, q.Offset)...,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	sessions := []SessionInfo{}
	for rows.Next() {
		var info SessionInfo
		if err := rows.Scan(&info.ID, &info.UserID, &info.Username, &info.State, &info.CreatedAt,
			&info.LastSeenAt, &info.IdleExpiresAt, &info.AbsoluteExpiresAt); err != nil {
			return nil, err
		}
		sessions = append(sessions, info)
	}
	return sessions, rows.Err()
}

// Status summarizes the database for operators.
func (s *Store) Status() (Status, error) {
	version, err := s.SchemaVersion()
	if err != nil {
		return Status{}, err
	}
	status := Status{Path: s.path, SchemaVersion: version}
	counts := []struct {
		query string
		into  *int
	}{
		{`SELECT COUNT(*) FROM users`, &status.Users},
		{`SELECT COUNT(*) FROM users WHERE enabled = 1`, &status.Enabled},
		{`SELECT COUNT(*) FROM users WHERE enabled = 0`, &status.Disabled},
		{`SELECT COUNT(*) FROM sessions WHERE state = 'active'`, &status.SessionsActive},
		{`SELECT COUNT(*) FROM sessions WHERE state = 'pending'`, &status.SessionsPending},
		{`SELECT COUNT(*) FROM audit_log`, &status.AuditEntries},
	}
	for _, count := range counts {
		if err := s.db.QueryRow(count.query).Scan(count.into); err != nil {
			return Status{}, err
		}
	}
	var migratedAt sql.NullInt64
	if err := s.db.QueryRow(`SELECT MAX(applied_at) FROM schema_migrations`).Scan(&migratedAt); err != nil {
		return Status{}, err
	}
	status.MigratedAt = migratedAt.Int64
	return status, nil
}

// Verify runs SQLite's integrity check and confirms the schema is readable.
func (s *Store) Verify() (Status, error) {
	var result string
	if err := s.db.QueryRow(`PRAGMA integrity_check`).Scan(&result); err != nil {
		return Status{}, err
	}
	if result != "ok" {
		return Status{}, fmt.Errorf("store: integrity check failed: %s", result)
	}
	return s.Status()
}
