package store

import (
	"errors"
	"path/filepath"
	"testing"

	"github.com/example-org/example-blog/services/lab-auth/internal/password"
)

func testArgon() password.Params {
	return password.Params{Memory: 8 * 1024, Iterations: 1, Parallelism: 1, SaltLength: 16, KeyLength: 32}
}

func openTest(t *testing.T) *Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "auth.db")
	s, err := Open(path, WithArgon(testArgon()), WithClock(func() int64 { return 1_700_000_000 }))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := s.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

// latestSchemaVersion keeps these assertions valid when a migration is added:
// the expected value comes from the embedded migrations, not from a literal.
func latestSchemaVersion(t *testing.T) int {
	t.Helper()
	version, err := LatestSchemaVersion()
	if err != nil {
		t.Fatal(err)
	}
	return version
}

func TestMigrateIsIdempotent(t *testing.T) {
	s := openTest(t)
	if err := s.Migrate(); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
	version, err := s.SchemaVersion()
	if err != nil || version != latestSchemaVersion(t) {
		t.Fatalf("schema version = %d, err %v", version, err)
	}
}

func TestSchemaChecksumMismatchFails(t *testing.T) {
	s := openTest(t)
	if _, err := s.db.Exec(`UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1`); err != nil {
		t.Fatal(err)
	}
	err := s.Migrate()
	if !errors.Is(err, ErrSchemaIncompatible) {
		t.Fatalf("expected ErrSchemaIncompatible, got %v", err)
	}
}

func TestCreateAndAuthenticate(t *testing.T) {
	s := openTest(t)
	user, err := s.CreateUser("JOYCE_01", "a very long password")
	if err != nil {
		t.Fatal(err)
	}
	if user.UsernameKey != "joyce_01" || !user.Enabled {
		t.Fatalf("unexpected user: %+v", user)
	}
	stored, phc, err := s.GetUserByKey("JOYCE_01")
	if err != nil {
		t.Fatal(err)
	}
	if stored.ID != user.ID {
		t.Fatalf("lookup by different case returned %s, want %s", stored.ID, user.ID)
	}
	if ok, _ := password.Verify("a very long password", phc); !ok {
		t.Fatal("correct password should verify")
	}
	if ok, _ := password.Verify("wrong password", phc); ok {
		t.Fatal("wrong password must not verify")
	}
	if got, _ := s.CountUsers(); got != 1 {
		t.Fatalf("count = %d", got)
	}
}

func TestDuplicateAndReservedAndInvalid(t *testing.T) {
	s := openTest(t)
	if _, err := s.CreateUser("joyce", "a very long password"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateUser("JOYCE", "another long password"); !errors.Is(err, ErrUsernameTaken) {
		t.Fatalf("case-insensitive duplicate: got %v", err)
	}
	if _, err := s.CreateUser("guest", "a very long password"); !errors.Is(err, ErrInvalidUsername) {
		t.Fatalf("reserved name: got %v", err)
	}
	if _, err := s.CreateUser("validname", "short"); !errors.Is(err, ErrInvalidPassword) {
		t.Fatalf("short password: got %v", err)
	}
	if _, err := s.CreateUser("no", "a very long password"); !errors.Is(err, ErrInvalidUsername) {
		t.Fatalf("short username: got %v", err)
	}
}

func TestSetEnabledBumpsVersion(t *testing.T) {
	s := openTest(t)
	if _, err := s.CreateUser("toggle", "a very long password"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetEnabled("toggle", false); err != nil {
		t.Fatal(err)
	}
	user, _, err := s.GetUserByKey("toggle")
	if err != nil {
		t.Fatal(err)
	}
	if user.Enabled {
		t.Fatal("user should be disabled")
	}
	if user.CredentialVersion != 2 {
		t.Fatalf("credential version = %d, want 2", user.CredentialVersion)
	}
	if err := s.SetEnabled("nobody", true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing user: got %v", err)
	}
}

func TestResetPasswordRevokesSessions(t *testing.T) {
	s := openTest(t)
	user, err := s.CreateUser("resetme", "old password value")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(
		`INSERT INTO sessions(session_id, token_hash, user_id, state, credential_version, csrf_hash, idle_expires_at, absolute_expires_at, created_at, last_seen_at)
		 VALUES('s1','t1',?,'active',1,'c1',0,0,0,0)`, user.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.ResetPassword("resetme", "new password value"); err != nil {
		t.Fatal(err)
	}
	_, phc, err := s.GetUserByKey("resetme")
	if err != nil {
		t.Fatal(err)
	}
	if ok, _ := password.Verify("old password value", phc); ok {
		t.Fatal("old password must stop working after reset")
	}
	if ok, _ := password.Verify("new password value", phc); !ok {
		t.Fatal("new password must verify")
	}
	var state string
	if err := s.db.QueryRow(`SELECT state FROM sessions WHERE session_id='s1'`).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "revoked" {
		t.Fatalf("session state = %q, want revoked", state)
	}
}

func TestOpenFailsCleanlyOnMissingDirectory(t *testing.T) {
	if _, err := Open(filepath.Join(t.TempDir(), "missing", "auth.db")); err == nil {
		t.Fatal("opening a database in a missing directory must fail")
	}
}

func TestGetUserByKeyUnknown(t *testing.T) {
	s := openTest(t)
	if _, _, err := s.GetUserByKey("nobody"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown user should be ErrNotFound, got %v", err)
	}
}

func TestReopenPersistsUsersAndFlows(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "auth.db")
	now := int64(1_700_000_000)

	s, err := Open(path, WithArgon(testArgon()), WithClock(func() int64 { return now }))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateUser("Persisted", "a very long password"); err != nil {
		t.Fatal(err)
	}
	flowID, err := NewID("f_", 16)
	if err != nil {
		t.Fatal(err)
	}
	flowToken, flowHash, err := NewToken()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.InsertFlow(flowID, flowHash, "csrf-hash", now, now+600, now+600); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(path, WithArgon(testArgon()), WithClock(func() int64 { return now }))
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if _, _, err := reopened.GetUserByKey("Persisted"); err != nil {
		t.Fatalf("user lost after restart: %v", err)
	}
	if _, err := reopened.GetFlowByToken(flowToken, now); err != nil {
		t.Fatalf("flow lost after restart: %v", err)
	}
	if version, err := reopened.SchemaVersion(); err != nil || version != latestSchemaVersion(t) {
		t.Fatalf("schema version = %d, err %v", version, err)
	}
}

func TestCleanupExpiresFlowsAndAttempts(t *testing.T) {
	s := openTest(t)
	now := s.Clock()

	// Recently expired state is kept for audit but marked expired.
	flowID, _ := NewID("f_", 16)
	flowToken, flowHash, _ := NewToken()
	if err := s.InsertFlow(flowID, flowHash, "csrf", now-1200, now-600, now-600); err != nil {
		t.Fatal(err)
	}
	attempt, err := s.CreateAttempt(flowID, now-600, now-60, 4)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Cleanup(now); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetFlowByToken(flowToken, now); !errors.Is(err, ErrExpired) {
		t.Fatalf("recently expired flow should remain but report expired, got %v", err)
	}
	got, err := s.GetAttempt(attempt.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != "expired" {
		t.Fatalf("attempt state = %q, want expired", got.State)
	}

	// State beyond the 24h retention is pruned.
	oldID, _ := NewID("f_", 16)
	oldToken, oldHash, _ := NewToken()
	if err := s.InsertFlow(oldID, oldHash, "csrf", now-200000, now-100000, now-100000); err != nil {
		t.Fatal(err)
	}
	oldAttempt, err := s.CreateAttempt(oldID, now-100000, now-100000, 4)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Cleanup(now); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetAttempt(oldAttempt.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("old attempt should be pruned, got %v", err)
	}
	if _, err := s.GetFlowByToken(oldToken, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("old flow should be pruned, got %v", err)
	}
}

func TestBackupRestoreRevokesSessions(t *testing.T) {
	s := openTest(t)
	user, err := s.CreateUser("backupuser", "a very long password")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(
		`INSERT INTO sessions(session_id, token_hash, user_id, state, credential_version, csrf_hash, idle_expires_at, absolute_expires_at, created_at, last_seen_at)
		 VALUES('s1','t1',?,'active',1,'c1',0,0,0,0)`, user.ID); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	backup := filepath.Join(dir, "backup.db")
	if err := s.Backup(backup); err != nil {
		t.Fatal(err)
	}
	info, err := VerifyBackup(backup)
	if err != nil {
		t.Fatal(err)
	}
	if !info.IntegrityOK || info.Users != 1 || info.SchemaVersion != latestSchemaVersion(t) {
		t.Fatalf("unexpected backup info: %+v", info)
	}
	restored := filepath.Join(dir, "restored.db")
	if _, err := RestoreBackup(backup, restored); err != nil {
		t.Fatal(err)
	}
	s2, err := Open(restored, WithArgon(testArgon()))
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	count, err := s2.CountUsers()
	if err != nil || count != 1 {
		t.Fatalf("restored users = %d, err %v", count, err)
	}
	var state string
	if err := s2.db.QueryRow(`SELECT state FROM sessions WHERE session_id='s1'`).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "revoked" {
		t.Fatalf("restored session state = %q, want revoked", state)
	}
}
