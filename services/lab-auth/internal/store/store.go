// Package store owns the SQLite schema, migrations and user records.
package store

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"github.com/example-org/example-blog/services/lab-auth/internal/password"
	"github.com/example-org/example-blog/services/lab-auth/migrations"
)

var (
	ErrNotFound           = errors.New("store: not found")
	ErrUsernameTaken      = errors.New("store: username already taken")
	ErrInvalidUsername    = errors.New("store: invalid username")
	ErrInvalidPassword    = errors.New("store: invalid password")
	ErrSchemaIncompatible = errors.New("store: incompatible schema")
)

type Store struct {
	db    *sql.DB
	path  string
	now   func() int64
	argon password.Params
}

type Option func(*Store)

func WithClock(now func() int64) Option  { return func(s *Store) { s.now = now } }
func WithArgon(p password.Params) Option { return func(s *Store) { s.argon = p } }

// Open opens (creating if needed) the SQLite database and enables the pragmas
// required by CONTRACT.md. Callers must run Migrate before using the store.
func Open(path string, opts ...Option) (*Store, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("store: empty database path")
	}
	// `_txlock=immediate` makes every write transaction take the SQLite write
	// lock up front, avoiding the deferred-transaction upgrade deadlock that
	// surfaces as SQLITE_BUSY under concurrent logins.
	dsn := fmt.Sprintf("file:%s?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_txlock=immediate", filepath.ToSlash(path))
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	s := &Store{db: db, path: path, now: func() int64 { return time.Now().Unix() }, argon: password.DefaultParams()}
	for _, opt := range opts {
		opt(s)
	}
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) DB() *sql.DB  { return s.db }
func (s *Store) Path() string { return s.path }

func (s *Store) Clock() int64 { return s.now() }

func (s *Store) Close() error { return s.db.Close() }

type migration struct {
	version  int
	name     string
	checksum string
	sql      string
}

func loadMigrations() ([]migration, error) {
	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		return nil, err
	}
	var list []migration
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		body, err := migrations.FS.ReadFile(entry.Name())
		if err != nil {
			return nil, err
		}
		version, err := parseVersion(entry.Name())
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256(body)
		list = append(list, migration{version: version, name: entry.Name(), checksum: hex.EncodeToString(sum[:]), sql: string(body)})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].version < list[j].version })
	return list, nil
}

func parseVersion(name string) (int, error) {
	i := 0
	for i < len(name) && name[i] >= '0' && name[i] <= '9' {
		i++
	}
	if i == 0 {
		return 0, fmt.Errorf("store: migration %q has no numeric version", name)
	}
	version, err := strconv.Atoi(name[:i])
	if err != nil {
		return 0, fmt.Errorf("store: migration %q: %w", name, err)
	}
	return version, nil
}

// Migrate applies pending migrations idempotently and refuses a database whose
// applied migration checksum differs from the embedded file.
func (s *Store) Migrate() error {
	ctx := s.db
	if _, err := ctx.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY,
		checksum TEXT NOT NULL,
		applied_at INTEGER NOT NULL
	)`); err != nil {
		return err
	}
	list, err := loadMigrations()
	if err != nil {
		return err
	}
	for _, m := range list {
		var checksum string
		err := ctx.QueryRow(`SELECT checksum FROM schema_migrations WHERE version = ?`, m.version).Scan(&checksum)
		switch {
		case err == nil:
			if checksum != m.checksum {
				return fmt.Errorf("%w: version %d checksum mismatch", ErrSchemaIncompatible, m.version)
			}
			continue
		case errors.Is(err, sql.ErrNoRows):
		default:
			return err
		}
		tx, err := ctx.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(m.sql); err != nil {
			tx.Rollback()
			return fmt.Errorf("store: migration %s: %w", m.name, err)
		}
		if _, err := tx.Exec(`INSERT INTO schema_migrations(version, checksum, applied_at) VALUES(?, ?, ?)`, m.version, m.checksum, s.now()); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// SchemaVersion returns the highest applied migration version.
func (s *Store) SchemaVersion() (int, error) {
	var version sql.NullInt64
	if err := s.db.QueryRow(`SELECT MAX(version) FROM schema_migrations`).Scan(&version); err != nil {
		return 0, err
	}
	return int(version.Int64), nil
}

// LatestSchemaVersion is the version a fully migrated database must report. It is
// derived from the embedded migrations so adding one never leaves a stale literal
// behind in tests or in the admin status output.
func LatestSchemaVersion() (int, error) {
	list, err := loadMigrations()
	if err != nil {
		return 0, err
	}
	if len(list) == 0 {
		return 0, nil
	}
	return list[len(list)-1].version, nil
}

func randomID(prefix string, byteLen int) (string, error) {
	buf := make([]byte, byteLen)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(buf), nil
}
