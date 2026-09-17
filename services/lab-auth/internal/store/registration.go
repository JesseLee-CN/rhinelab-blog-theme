package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/example-org/example-blog/services/lab-auth/internal/identity"
)

var (
	// ErrRegistrationQuota is returned when a fixed registration window is full.
	ErrRegistrationQuota = errors.New("store: registration quota exceeded")
	// ErrUserLimit is returned when the persistent user cap is reached.
	ErrUserLimit = errors.New("store: user limit reached")
)

// RegistrationQuotaError reports which quota window rejected the attempt.
// RetryAfter is seconds until the window resets.
type RegistrationQuotaError struct {
	RetryAfter int64
}

func (e *RegistrationQuotaError) Error() string {
	return "store: registration quota exceeded"
}

func (e *RegistrationQuotaError) Unwrap() error { return ErrRegistrationQuota }

// RegistrationInput carries a pre-hashed account and its quota envelope. The
// hash is produced outside the database write transaction by the shared hash
// pool, so the write lock is never held during Argon2 work.
type RegistrationInput struct {
	Username     string
	PasswordHash string
	SourceKey    string // HMAC digest; never a raw address
	SourceLimit  int
	GlobalLimit  int
	MaxUsers     int
	Now          int64
}

// RegisterUser consumes attempt quotas independently of the insertion so a
// duplicate or failed insertion cannot refund an admitted attempt.
func (s *Store) RegisterUser(in RegistrationInput) (User, error) {
	if err := s.ConsumeRegistrationQuota(context.Background(), in); err != nil {
		return User{}, err
	}
	return s.InsertRegisteredUser(context.Background(), in)
}

// ConsumeRegistrationQuota commits admission before expensive hashing. Both
// buckets are updated atomically; rejected admission consumes neither bucket.
func (s *Store) ConsumeRegistrationQuota(ctx context.Context, in RegistrationInput) error {
	if in.SourceKey == "" || in.SourceLimit < 1 || in.GlobalLimit < 1 {
		return fmt.Errorf("store: invalid registration quota configuration")
	}
	return s.withTx(ctx, func(tx *sql.Tx) error {
		sourceStart := in.Now - in.Now%3600
		ok, err := consumeQuota(tx, "register:src:"+in.SourceKey, sourceStart, sourceStart+3600, int64(in.SourceLimit))
		if err != nil {
			return err
		}
		if !ok {
			return &RegistrationQuotaError{RetryAfter: sourceStart + 3600 - in.Now}
		}
		globalStart := in.Now - in.Now%86400
		ok, err = consumeQuota(tx, "register:global", globalStart, globalStart+86400, int64(in.GlobalLimit))
		if err != nil {
			return err
		}
		if !ok {
			return &RegistrationQuotaError{RetryAfter: globalStart + 86400 - in.Now}
		}
		return nil
	})
}

// InsertRegisteredUser is called after quota admission and hashing. The user
// cap and unique insertion remain in one write transaction.
func (s *Store) InsertRegisteredUser(ctx context.Context, in RegistrationInput) (User, error) {
	key, uerr := identity.ValidateUsername(in.Username)
	if uerr != "" {
		return User{}, fmt.Errorf("%w: %s", ErrInvalidUsername, uerr)
	}
	var user User
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		var users int
		if err := tx.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&users); err != nil {
			return err
		}
		if users >= in.MaxUsers {
			return ErrUserLimit
		}
		id, err := randomID("u_", 16)
		if err != nil {
			return err
		}
		created, err := insertUserRow(tx, id, key, in.Username, in.PasswordHash, in.Now)
		if err != nil {
			return err
		}
		user = created
		return nil
	})
	if err != nil {
		return User{}, err
	}
	return user, nil
}

// consumeQuota performs a fixed-window atomic increment. It returns false when
// the window is full; the first attempt in a new window resets the counter.
func consumeQuota(tx *sql.Tx, key string, windowStart, windowEnd, limit int64) (bool, error) {
	if _, err := tx.Exec(
		`UPDATE rate_limits SET count = 0, window_start = ?, expires_at = ?
		 WHERE bucket_key = ? AND window_start < ?`,
		windowStart, windowEnd, key, windowStart,
	); err != nil {
		return false, err
	}
	res, err := tx.Exec(
		`INSERT INTO rate_limits(bucket_key, window_start, count, expires_at)
		 VALUES(?, ?, 1, ?)
		 ON CONFLICT(bucket_key) DO UPDATE SET count = count + 1, expires_at = excluded.expires_at
		 WHERE rate_limits.window_start = ? AND rate_limits.count < ?`,
		key, windowStart, windowEnd, windowStart, limit,
	)
	if err != nil {
		return false, err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return affected > 0, nil
}

// QuotaCount reports the persisted count for one registration bucket key; used
// by tests and operations diagnostics, not by the HTTP API.
func (s *Store) QuotaCount(key string) (int64, error) {
	var count int64
	err := s.db.QueryRow(`SELECT count FROM rate_limits WHERE bucket_key = ?`, key).Scan(&count)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return count, err
}
