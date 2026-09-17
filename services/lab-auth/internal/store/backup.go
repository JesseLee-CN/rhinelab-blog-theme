package store

import (
	"database/sql"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type BackupInfo struct {
	Path          string
	SchemaVersion int
	Users         int
	IntegrityOK   bool
	ForeignKeysOK bool
}

func quoteSQLiteString(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

// Backup writes a consistent snapshot with SQLite's VACUUM INTO. The running
// database keeps serving; no single-file copy of a live DB is used as backup.
func (s *Store) Backup(dest string) error {
	if strings.TrimSpace(dest) == "" {
		return fmt.Errorf("store: empty backup path")
	}
	if fi, err := os.Stat(dest); err == nil && fi.IsDir() {
		return fmt.Errorf("store: backup path is a directory: %s", dest)
	}
	if err := os.Remove(dest); err != nil && !os.IsNotExist(err) {
		return err
	}
	if _, err := s.db.Exec(`VACUUM INTO ` + quoteSQLiteString(dest)); err != nil {
		return err
	}
	return nil
}

// VerifyBackup opens a backup read-only, checks integrity, foreign keys and
// counts, without modifying it.
func VerifyBackup(path string) (BackupInfo, error) {
	info := BackupInfo{Path: path}
	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s?mode=ro&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)", filepath.ToSlash(path)))
	if err != nil {
		return info, err
	}
	defer db.Close()

	var integrity string
	if err := db.QueryRow(`PRAGMA integrity_check`).Scan(&integrity); err != nil {
		return info, err
	}
	info.IntegrityOK = strings.EqualFold(integrity, "ok")

	rows, err := db.Query(`PRAGMA foreign_key_check`)
	if err != nil {
		return info, err
	}
	info.ForeignKeysOK = !rows.Next()
	rows.Close()

	var version sql.NullInt64
	if err := db.QueryRow(`SELECT MAX(version) FROM schema_migrations`).Scan(&version); err != nil {
		return info, err
	}
	info.SchemaVersion = int(version.Int64)
	if err := db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&info.Users); err != nil {
		return info, err
	}
	return info, nil
}

// RestoreBackup verifies src, copies it to dest and revokes every session in
// the restored copy so a backup never reinstates live logins. The source is
// left untouched.
func RestoreBackup(src, dest string) (BackupInfo, error) {
	info, err := VerifyBackup(src)
	if err != nil {
		return info, err
	}
	if !info.IntegrityOK || !info.ForeignKeysOK {
		return info, fmt.Errorf("store: backup %s failed integrity checks", src)
	}
	if same, err := sameFile(src, dest); err != nil {
		return info, err
	} else if same {
		return info, fmt.Errorf("store: source and destination are the same file")
	}

	if err := copyFile(src, dest); err != nil {
		return info, err
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		if err := os.Remove(dest + suffix); err != nil && !os.IsNotExist(err) {
			return info, err
		}
	}

	restored, err := Open(dest)
	if err != nil {
		return info, err
	}
	defer restored.Close()
	if err := restored.Migrate(); err != nil {
		return info, err
	}
	if _, err := restored.RevokeAllSessions(); err != nil {
		return info, err
	}
	return info, nil
}

func sameFile(a, b string) (bool, error) {
	ai, err := os.Stat(a)
	if err != nil {
		return false, err
	}
	bi, err := os.Stat(b)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	return os.SameFile(ai, bi), nil
}

func copyFile(src, dest string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if dir := filepath.Dir(dest); dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
	}
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
