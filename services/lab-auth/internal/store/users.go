package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/example-org/example-blog/services/lab-auth/internal/identity"
	"github.com/example-org/example-blog/services/lab-auth/internal/password"
)

type User struct {
	ID                string
	UsernameKey       string
	Username          string
	Enabled           bool
	CredentialVersion int64
	CreatedAt         int64
	UpdatedAt         int64
}

const userColumns = `user_id, username_key, username, enabled, credential_version, created_at, updated_at`

func scanUser(row interface{ Scan(...any) error }) (User, error) {
	var u User
	var enabled int64
	if err := row.Scan(&u.ID, &u.UsernameKey, &u.Username, &enabled, &u.CredentialVersion, &u.CreatedAt, &u.UpdatedAt); err != nil {
		return User{}, err
	}
	u.Enabled = enabled == 1
	return u, nil
}

// rowExecer is satisfied by *sql.DB and *sql.Tx so the CLI and the HTTP
// registration path share one user insert.
type rowExecer interface {
	Exec(query string, args ...any) (sql.Result, error)
}

func insertUserRow(ex rowExecer, id, key, username, hash string, now int64) (User, error) {
	_, err := ex.Exec(
		`INSERT INTO users(user_id, username_key, username, password_hash, enabled, credential_version, created_at, updated_at)
		 VALUES(?, ?, ?, ?, 1, 1, ?, ?)`,
		id, key, username, hash, now, now,
	)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return User{}, ErrUsernameTaken
		}
		return User{}, err
	}
	return User{ID: id, UsernameKey: key, Username: username, Enabled: true, CredentialVersion: 1, CreatedAt: now, UpdatedAt: now}, nil
}

// CreateUser validates the username/password, hashes the password and inserts
// a new enabled user. It never stores the plain password.
func (s *Store) CreateUser(username, plain string) (User, error) {
	key, uerr := identity.ValidateUsername(username)
	if uerr != "" {
		return User{}, fmt.Errorf("%w: %s", ErrInvalidUsername, uerr)
	}
	if perr := identity.ValidatePassword(plain); perr != "" {
		return User{}, fmt.Errorf("%w: %s", ErrInvalidPassword, perr)
	}
	hash, err := password.Hash(plain, s.argon)
	if err != nil {
		return User{}, err
	}
	id, err := randomID("u_", 16)
	if err != nil {
		return User{}, err
	}
	return insertUserRow(s.db, id, key, username, hash, s.now())
}

// GetUserByKey returns the user and its PHC hash by uniqueness key.
func (s *Store) GetUserByKey(key string) (User, string, error) {
	var u User
	var enabled int64
	var hash string
	err := s.db.QueryRow(`SELECT `+userColumns+`, password_hash FROM users WHERE username_key = ?`, identity.Key(key)).
		Scan(&u.ID, &u.UsernameKey, &u.Username, &enabled, &u.CredentialVersion, &u.CreatedAt, &u.UpdatedAt, &hash)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, "", ErrNotFound
	}
	if err != nil {
		return User{}, "", err
	}
	u.Enabled = enabled == 1
	return u, hash, nil
}

func (s *Store) ListUsers() ([]User, error) {
	rows, err := s.db.Query(`SELECT ` + userColumns + ` FROM users ORDER BY username_key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var users []User
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

// SetEnabled toggles an account and, per contract, bumps the credential version
// and revokes that user's sessions.
func (s *Store) SetEnabled(key string, enabled bool) error {
	return s.mutateUser(key, func(userID string) error {
		flag := 0
		if enabled {
			flag = 1
		}
		res, err := s.db.Exec(
			`UPDATE users SET enabled = ?, credential_version = credential_version + 1, updated_at = ? WHERE user_id = ?`,
			flag, s.now(), userID,
		)
		if err != nil {
			return err
		}
		return expectOne(res)
	})
}

// ResetPassword sets a new password, bumps the credential version and revokes
// existing sessions so the old password and sessions stop working.
func (s *Store) ResetPassword(key, plain string) error {
	if perr := identity.ValidatePassword(plain); perr != "" {
		return fmt.Errorf("%w: %s", ErrInvalidPassword, perr)
	}
	hash, err := password.Hash(plain, s.argon)
	if err != nil {
		return err
	}
	return s.mutateUser(key, func(userID string) error {
		res, err := s.db.Exec(
			`UPDATE users SET password_hash = ?, credential_version = credential_version + 1, updated_at = ? WHERE user_id = ?`,
			hash, s.now(), userID,
		)
		if err != nil {
			return err
		}
		if err := expectOne(res); err != nil {
			return err
		}
		_, err = s.RevokeSessions(userID)
		return err
	})
}

func (s *Store) mutateUser(key string, fn func(userID string) error) error {
	user, _, err := s.GetUserByKey(key)
	if err != nil {
		return err
	}
	return fn(user.ID)
}

// RevokeSessions revokes every session of one user.
func (s *Store) RevokeSessions(userID string) (int64, error) {
	res, err := s.db.Exec(`UPDATE sessions SET state = 'revoked' WHERE user_id = ? AND state != 'revoked'`, userID)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// RevokeAllSessions revokes every session (used on restore so a backup never
// reinstates live logins).
func (s *Store) RevokeAllSessions() (int64, error) {
	res, err := s.db.Exec(`UPDATE sessions SET state = 'revoked' WHERE state != 'revoked'`)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func expectOne(res sql.Result) error {
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) CountUsers() (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}
