package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
)

var (
	ErrStateConflict   = errors.New("store: state conflict")
	ErrUnauthenticated = errors.New("store: unauthenticated")
	ErrExpired         = errors.New("store: expired")
)

// NewToken returns an opaque URL-safe token and its storage digest. Only the
// digest is ever persisted.
func NewToken() (token, hash string, err error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", "", err
	}
	token = base64.RawURLEncoding.EncodeToString(buf)
	return token, HashToken(token), nil
}

func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// NewID returns a random identifier with a readable prefix.
func NewID(prefix string, byteLen int) (string, error) { return randomID(prefix, byteLen) }

type Flow struct {
	ID            string
	CSRFHash      string
	CSRFExpiresAt int64
	CreatedAt     int64
	ExpiresAt     int64
}

type Attempt struct {
	ID                string
	FlowID            string
	State             string
	UserID            sql.NullString
	CredentialVersion sql.NullInt64
	SessionID         sql.NullString
	IssuedAt          int64
	PendingExpiresAt  sql.NullInt64
	DeadlineAt        int64
}

type Session struct {
	ID                string
	UserID            string
	AttemptID         sql.NullString
	State             string
	CredentialVersion int64
	CSRFHash          string
	IdleExpiresAt     int64
	AbsoluteExpiresAt int64
	CreatedAt         int64
	LastSeenAt        int64
}

const attemptColumns = `attempt_id, flow_id, state, user_id, credential_version, session_id, issued_at, pending_expires_at, deadline_at`

func scanAttempt(row interface{ Scan(...any) error }) (Attempt, error) {
	var a Attempt
	err := row.Scan(&a.ID, &a.FlowID, &a.State, &a.UserID, &a.CredentialVersion, &a.SessionID, &a.IssuedAt, &a.PendingExpiresAt, &a.DeadlineAt)
	return a, err
}

const sessionColumns = `session_id, user_id, attempt_id, state, credential_version, csrf_hash, idle_expires_at, absolute_expires_at, created_at, last_seen_at`

func scanSession(row interface{ Scan(...any) error }) (Session, error) {
	var s Session
	err := row.Scan(&s.ID, &s.UserID, &s.AttemptID, &s.State, &s.CredentialVersion, &s.CSRFHash, &s.IdleExpiresAt, &s.AbsoluteExpiresAt, &s.CreatedAt, &s.LastSeenAt)
	return s, err
}

func (s *Store) withTx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

// InsertFlow stores a pre-authentication flow. The caller owns id/token/csrf
// generation so it can derive the CSRF token deterministically.
func (s *Store) InsertFlow(flowID, tokenHash, csrfHash string, createdAt, csrfExpiresAt, expiresAt int64) error {
	_, err := s.db.Exec(
		`INSERT INTO flows(flow_id, token_hash, csrf_hash, csrf_expires_at, created_at, expires_at)
		 VALUES(?, ?, ?, ?, ?, ?)`,
		flowID, tokenHash, csrfHash, csrfExpiresAt, createdAt, expiresAt,
	)
	return err
}

func (s *Store) GetFlowByToken(token string, now int64) (Flow, error) {
	var f Flow
	err := s.db.QueryRow(
		`SELECT flow_id, csrf_hash, csrf_expires_at, created_at, expires_at FROM flows WHERE token_hash = ?`,
		HashToken(token),
	).Scan(&f.ID, &f.CSRFHash, &f.CSRFExpiresAt, &f.CreatedAt, &f.ExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Flow{}, ErrNotFound
	}
	if err != nil {
		return Flow{}, err
	}
	if f.ExpiresAt < now {
		return Flow{}, ErrExpired
	}
	return f, nil
}

// CreateAttempt opens an attempt under a flow, enforcing the per-flow cap.
func (s *Store) CreateAttempt(flowID string, issuedAt, deadlineAt int64, maxOpen int) (Attempt, error) {
	var open int
	if err := s.db.QueryRow(
		`SELECT COUNT(*) FROM login_attempts WHERE flow_id = ? AND state IN ('issued','verifying','pending') AND deadline_at >= ?`,
		flowID, issuedAt,
	).Scan(&open); err != nil {
		return Attempt{}, err
	}
	if open >= maxOpen {
		return Attempt{}, ErrStateConflict
	}
	attemptID, err := randomID("a_", 16)
	if err != nil {
		return Attempt{}, err
	}
	if _, err := s.db.Exec(
		`INSERT INTO login_attempts(attempt_id, flow_id, state, issued_at, deadline_at) VALUES(?, ?, 'issued', ?, ?)`,
		attemptID, flowID, issuedAt, deadlineAt,
	); err != nil {
		return Attempt{}, err
	}
	return Attempt{ID: attemptID, FlowID: flowID, State: "issued", IssuedAt: issuedAt, DeadlineAt: deadlineAt}, nil
}

func (s *Store) GetAttempt(attemptID string) (Attempt, error) {
	a, err := scanAttempt(s.db.QueryRow(`SELECT `+attemptColumns+` FROM login_attempts WHERE attempt_id = ?`, attemptID))
	if errors.Is(err, sql.ErrNoRows) {
		return Attempt{}, ErrNotFound
	}
	return a, err
}

// FailAttempt records a rejected credential attempt if it is still open.
func (s *Store) FailAttempt(attemptID string) error {
	_, err := s.db.Exec(`UPDATE login_attempts SET state='failed' WHERE attempt_id=? AND state IN ('issued','verifying')`, attemptID)
	return err
}

// GetSessionByToken returns a session by cookie token regardless of state.
func (s *Store) GetSessionByToken(token string) (Session, error) {
	session, err := scanSession(s.db.QueryRow(`SELECT `+sessionColumns+` FROM sessions WHERE token_hash = ?`, HashToken(token)))
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, ErrNotFound
	}
	return session, err
}

// MarkPending commits a verified login: it re-checks the attempt state inside a
// transaction, so a cancel that lands first wins, then creates the pending
// session. Returns ErrStateConflict if the attempt is no longer issuable.
func (s *Store) MarkPending(ctx context.Context, attemptID, sessionID, sessionTokenHash, sessionCSRFHash, userID string, credVersion int64, pendingExpiresAt, idleExpiresAt, absoluteExpiresAt int64, now int64) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		attempt, err := scanAttempt(tx.QueryRow(`SELECT `+attemptColumns+` FROM login_attempts WHERE attempt_id = ?`, attemptID))
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if attempt.State != "issued" && attempt.State != "verifying" {
			return ErrStateConflict
		}
		if attempt.DeadlineAt < now {
			tx.Exec(`UPDATE login_attempts SET state='expired' WHERE attempt_id=?`, attemptID)
			return ErrExpired
		}
		if _, err := tx.Exec(
			`INSERT INTO sessions(session_id, token_hash, user_id, attempt_id, state, credential_version, csrf_hash, idle_expires_at, absolute_expires_at, created_at, last_seen_at)
			 VALUES(?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
			sessionID, sessionTokenHash, userID, attemptID, credVersion, sessionCSRFHash, idleExpiresAt, absoluteExpiresAt, now, now,
		); err != nil {
			return err
		}
		if _, err := tx.Exec(
			`UPDATE login_attempts SET state='pending', user_id=?, credential_version=?, session_id=?, pending_expires_at=? WHERE attempt_id=?`,
			userID, credVersion, sessionID, pendingExpiresAt, attemptID,
		); err != nil {
			return err
		}
		return nil
	})
}

// ConfirmedResult is returned after a successful /confirm.
type ConfirmedResult struct {
	User             User
	SessionID        string
	SessionExpiresAt int64
}

// ConfirmAttempt activates the pending session. It re-checks expiry, account
// state and credential version so a disable/reset during verification aborts.
func (s *Store) ConfirmAttempt(ctx context.Context, attemptID string, now, idleExpiresAt, absoluteExpiresAt int64) (ConfirmedResult, error) {
	var result ConfirmedResult
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		attempt, err := scanAttempt(tx.QueryRow(`SELECT `+attemptColumns+` FROM login_attempts WHERE attempt_id = ?`, attemptID))
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if attempt.State != "pending" {
			return ErrStateConflict
		}
		if attempt.PendingExpiresAt.Valid && attempt.PendingExpiresAt.Int64 < now {
			tx.Exec(`UPDATE login_attempts SET state='expired' WHERE attempt_id=?`, attemptID)
			tx.Exec(`UPDATE sessions SET state='revoked' WHERE attempt_id=? AND state='pending'`, attemptID)
			return ErrExpired
		}
		if !attempt.SessionID.Valid || !attempt.UserID.Valid {
			return ErrStateConflict
		}
		session, err := scanSession(tx.QueryRow(`SELECT `+sessionColumns+` FROM sessions WHERE session_id = ?`, attempt.SessionID.String))
		if err != nil {
			return err
		}
		if session.State != "pending" {
			return ErrStateConflict
		}
		user, err := scanUser(tx.QueryRow(`SELECT `+userColumns+` FROM users WHERE user_id = ?`, attempt.UserID.String))
		if errors.Is(err, sql.ErrNoRows) {
			return ErrUnauthenticated
		}
		if err != nil {
			return err
		}
		if !user.Enabled || user.CredentialVersion != attempt.CredentialVersion.Int64 || session.CredentialVersion != attempt.CredentialVersion.Int64 {
			tx.Exec(`UPDATE login_attempts SET state='cancelled' WHERE attempt_id=?`, attemptID)
			tx.Exec(`UPDATE sessions SET state='revoked' WHERE session_id=?`, session.ID)
			return ErrUnauthenticated
		}
		if _, err := tx.Exec(
			`UPDATE sessions SET state='active', idle_expires_at=?, absolute_expires_at=?, last_seen_at=? WHERE session_id=?`,
			idleExpiresAt, absoluteExpiresAt, now, session.ID,
		); err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE login_attempts SET state='confirmed' WHERE attempt_id=?`, attemptID); err != nil {
			return err
		}
		result = ConfirmedResult{User: user, SessionID: session.ID, SessionExpiresAt: absoluteExpiresAt}
		return nil
	})
	if err != nil {
		return ConfirmedResult{}, err
	}
	return result, nil
}

// CancelAttempt cancels a pending attempt and revokes the session it issued, or
// revokes the active session when the attempt was already confirmed. It is
// idempotent and never touches other attempts.
func (s *Store) CancelAttempt(ctx context.Context, attemptID string, now int64) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		attempt, err := scanAttempt(tx.QueryRow(`SELECT `+attemptColumns+` FROM login_attempts WHERE attempt_id = ?`, attemptID))
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		switch attempt.State {
		case "issued", "verifying", "pending":
			if _, err := tx.Exec(`UPDATE login_attempts SET state='cancelled' WHERE attempt_id=?`, attemptID); err != nil {
				return err
			}
			if _, err := tx.Exec(`UPDATE sessions SET state='revoked' WHERE attempt_id=? AND state IN ('pending','active')`, attemptID); err != nil {
				return err
			}
		case "confirmed":
			if _, err := tx.Exec(`UPDATE sessions SET state='revoked' WHERE attempt_id=? AND state='active'`, attemptID); err != nil {
				return err
			}
		}
		return nil
	})
}

// SessionAuth returns the active session and its user, updating activity.
func (s *Store) SessionAuth(ctx context.Context, sessionToken string, now, idleExpiresAt int64) (Session, User, error) {
	var session Session
	var user User
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		var err error
		session, err = scanSession(tx.QueryRow(`SELECT `+sessionColumns+` FROM sessions WHERE token_hash = ?`, HashToken(sessionToken)))
		if errors.Is(err, sql.ErrNoRows) {
			return ErrUnauthenticated
		}
		if err != nil {
			return err
		}
		if session.State != "active" || session.IdleExpiresAt < now || session.AbsoluteExpiresAt < now {
			return ErrUnauthenticated
		}
		user, err = scanUser(tx.QueryRow(`SELECT `+userColumns+` FROM users WHERE user_id = ?`, session.UserID))
		if errors.Is(err, sql.ErrNoRows) {
			return ErrUnauthenticated
		}
		if err != nil {
			return err
		}
		if !user.Enabled || user.CredentialVersion != session.CredentialVersion {
			tx.Exec(`UPDATE sessions SET state='revoked' WHERE session_id=?`, session.ID)
			return ErrUnauthenticated
		}
		if _, err := tx.Exec(`UPDATE sessions SET last_seen_at=?, idle_expires_at=? WHERE session_id=?`, now, idleExpiresAt, session.ID); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return Session{}, User{}, err
	}
	return session, user, nil
}

// LogoutSession revokes a session by token. Missing sessions are reported as
// logged out so logout stays idempotent.
func (s *Store) LogoutSession(ctx context.Context, sessionToken string, now int64) error {
	if sessionToken == "" {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `UPDATE sessions SET state='revoked' WHERE token_hash=? AND state != 'revoked'`, HashToken(sessionToken))
	return err
}

// Cleanup expires stale state and prunes records past the 24h retention.
// Ordering respects foreign keys: sessions before attempts, attempts before
// flows. Rows still referenced by a live session are never removed.
func (s *Store) Cleanup(now int64) error {
	retention := int64(24 * 3600)
	steps := []struct {
		query string
		args  []any
	}{
		{`UPDATE login_attempts SET state='expired' WHERE state IN ('issued','verifying','pending') AND deadline_at < ?`, []any{now}},
		{`UPDATE sessions SET state='revoked' WHERE state IN ('pending','active') AND (idle_expires_at < ? OR absolute_expires_at < ?)`, []any{now, now}},
		{`DELETE FROM sessions WHERE state='revoked' AND absolute_expires_at < ?`, []any{now - retention}},
		{`DELETE FROM login_attempts WHERE state IN ('confirmed','cancelled','failed','expired') AND deadline_at < ? AND attempt_id NOT IN (SELECT attempt_id FROM sessions WHERE attempt_id IS NOT NULL)`, []any{now - retention}},
		{`DELETE FROM flows WHERE expires_at < ? AND flow_id NOT IN (SELECT flow_id FROM login_attempts)`, []any{now - retention}},
		{`DELETE FROM rate_limits WHERE expires_at < ?`, []any{now}},
	}
	for _, step := range steps {
		if _, err := s.db.Exec(step.query, step.args...); err != nil {
			return err
		}
	}
	return nil
}
