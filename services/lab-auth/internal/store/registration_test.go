package store

import (
	"errors"
	"path/filepath"
	"sync"
	"testing"

	"github.com/example-org/example-blog/services/lab-auth/internal/password"
)

const fixedNow = int64(1_700_000_000)

func openRegistrationStore(t *testing.T) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "auth.db")
	s, err := Open(path, WithArgon(testArgon()), WithClock(func() int64 { return fixedNow }))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := s.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s, path
}

func registerInput(t *testing.T, username, source string, sourceLimit, globalLimit, maxUsers int) RegistrationInput {
	t.Helper()
	hash, err := password.Hash("A very long password 1", testArgon())
	if err != nil {
		t.Fatal(err)
	}
	return RegistrationInput{
		Username:     username,
		PasswordHash: hash,
		SourceKey:    source,
		SourceLimit:  sourceLimit,
		GlobalLimit:  globalLimit,
		MaxUsers:     maxUsers,
		Now:          fixedNow,
	}
}

func TestRegisterUserCreatesAndPersists(t *testing.T) {
	s, path := openRegistrationStore(t)
	user, err := s.RegisterUser(registerInput(t, "NewUser01", "digest-a", 10, 200, 5000))
	if err != nil {
		t.Fatal(err)
	}
	if user.Username != "NewUser01" || !user.Enabled || user.CredentialVersion != 1 {
		t.Fatalf("user = %+v", user)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(path, WithArgon(testArgon()), WithClock(func() int64 { return fixedNow }))
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if err := reopened.Migrate(); err != nil {
		t.Fatal(err)
	}
	got, phc, err := reopened.GetUserByKey("newuser01")
	if err != nil || got.ID != user.ID {
		t.Fatalf("reopen lookup: %v %+v", err, got)
	}
	ok, err := password.Verify("A very long password 1", phc)
	if err != nil || !ok {
		t.Fatalf("stored password does not verify: %v %v", ok, err)
	}
	count, err := reopened.QuotaCount("register:global")
	if err != nil || count != 1 {
		t.Fatalf("persisted quota = %d, %v", count, err)
	}
}

func TestRegisterUserSourceQuota(t *testing.T) {
	s, _ := openRegistrationStore(t)
	if _, err := s.RegisterUser(registerInput(t, "QuotaUser01", "digest-b", 1, 200, 5000)); err != nil {
		t.Fatal(err)
	}
	_, err := s.RegisterUser(registerInput(t, "QuotaUser02", "digest-b", 1, 200, 5000))
	if !errors.Is(err, ErrRegistrationQuota) {
		t.Fatalf("second attempt error = %v", err)
	}
	var quota *RegistrationQuotaError
	if !errors.As(err, &quota) || quota.RetryAfter <= 0 || quota.RetryAfter > 3600 {
		t.Fatalf("quota detail = %+v", quota)
	}
	// A different source keeps its own bucket.
	if _, err := s.RegisterUser(registerInput(t, "QuotaUser03", "digest-c", 1, 200, 5000)); err != nil {
		t.Fatalf("other source rejected: %v", err)
	}
}

func TestRegisterUserGlobalQuota(t *testing.T) {
	s, _ := openRegistrationStore(t)
	if _, err := s.RegisterUser(registerInput(t, "GlobalUser01", "digest-d", 10, 1, 5000)); err != nil {
		t.Fatal(err)
	}
	_, err := s.RegisterUser(registerInput(t, "GlobalUser02", "digest-e", 10, 1, 5000))
	if !errors.Is(err, ErrRegistrationQuota) {
		t.Fatalf("global quota error = %v", err)
	}
}

func TestRegisterUserCapAndUnique(t *testing.T) {
	s, _ := openRegistrationStore(t)
	if _, err := s.CreateUser("Existing", "A very long password 1"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RegisterUser(registerInput(t, "OverCap", "digest-f", 10, 200, 1)); !errors.Is(err, ErrUserLimit) {
		t.Fatalf("user cap error = %v", err)
	}
	if _, err := s.RegisterUser(registerInput(t, "existing", "digest-f", 10, 200, 5000)); !errors.Is(err, ErrUsernameTaken) {
		t.Fatalf("unique error = %v", err)
	}
}

func TestRegisterUserInvalidUsername(t *testing.T) {
	s, _ := openRegistrationStore(t)
	for _, name := range []string{"ab", "a b", "guest", "GUEST"} {
		if _, err := s.RegisterUser(registerInput(t, name, "digest-g", 10, 200, 5000)); !errors.Is(err, ErrInvalidUsername) {
			t.Fatalf("%q error = %v", name, err)
		}
	}
}

func TestRegisterQuotaSurvivesReopen(t *testing.T) {
	s, path := openRegistrationStore(t)
	if _, err := s.RegisterUser(registerInput(t, "RestartUser01", "digest-h", 1, 200, 5000)); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(path, WithArgon(testArgon()), WithClock(func() int64 { return fixedNow }))
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if err := reopened.Migrate(); err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.RegisterUser(registerInput(t, "RestartUser02", "digest-h", 1, 200, 5000)); !errors.Is(err, ErrRegistrationQuota) {
		t.Fatalf("quota after restart = %v", err)
	}
}

func TestRegisterConcurrentSameUsername(t *testing.T) {
	s, _ := openRegistrationStore(t)
	results := make([]error, 2)
	var wg sync.WaitGroup
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			name := "RaceUser0"
			if i == 1 {
				name = "raceuser0"
			}
			_, results[i] = s.RegisterUser(registerInput(t, name, "digest-i", 10, 200, 5000))
		}(i)
	}
	wg.Wait()
	created, taken := 0, 0
	for _, err := range results {
		switch {
		case err == nil:
			created++
		case errors.Is(err, ErrUsernameTaken):
			taken++
		}
	}
	if created != 1 || taken != 1 {
		t.Fatalf("results = %v", results)
	}
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM users WHERE username_key = 'raceuser0'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("rows = %d", n)
	}
}

func TestRegisterUserSurvivesBackupRestore(t *testing.T) {
	s, _ := openRegistrationStore(t)
	user, err := s.RegisterUser(registerInput(t, "BackupUser01", "digest-j", 10, 200, 5000))
	if err != nil {
		t.Fatal(err)
	}
	backup := filepath.Join(t.TempDir(), "backup.db")
	if err := s.Backup(backup); err != nil {
		t.Fatal(err)
	}
	info, err := VerifyBackup(backup)
	if err != nil || !info.IntegrityOK || !info.ForeignKeysOK || info.Users != 1 {
		t.Fatalf("backup info = %+v, %v", info, err)
	}
	restoredPath := filepath.Join(t.TempDir(), "restored.db")
	if _, err := RestoreBackup(backup, restoredPath); err != nil {
		t.Fatal(err)
	}
	restored, err := Open(restoredPath, WithArgon(testArgon()), WithClock(func() int64 { return fixedNow }))
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	if err := restored.Migrate(); err != nil {
		t.Fatal(err)
	}
	got, phc, err := restored.GetUserByKey("backupuser01")
	if err != nil || got.ID != user.ID {
		t.Fatalf("restored lookup: %v %+v", err, got)
	}
	ok, err := password.Verify("A very long password 1", phc)
	if err != nil || !ok {
		t.Fatalf("registered password must survive restore: ok=%v err=%v", ok, err)
	}
}
