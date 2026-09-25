package main

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

// CLI surface for account management: the grouped grammar, -json output and the
// audit rows every mutation must leave behind. The tests run the real `run`
// entry point so flags, output and exit behaviour are judged together.

func prepareDB(t *testing.T) string {
	t.Helper()
	db := filepath.Join(t.TempDir(), "auth.db")
	if _, _, err := runCLI(t, []string{"db", "migrate", "-db", db}, ""); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return db
}

func createUserViaCLI(t *testing.T, db, username string) string {
	t.Helper()
	const password = "A long enough password 1"
	out, _, err := runCLI(t, []string{"user", "create", "-db", db, username}, password+"\n"+password+"\n")
	if err != nil {
		t.Fatalf("create %s: %v", username, err)
	}
	return out
}

func decodeCLI[T any](t *testing.T, out string) T {
	t.Helper()
	var value T
	if err := json.Unmarshal([]byte(out), &value); err != nil {
		t.Fatalf("decode %q: %v", out, err)
	}
	return value
}

func TestCLIStatusAndJSONOutput(t *testing.T) {
	db := prepareDB(t)
	createUserViaCLI(t, db, "Joyce_Moore")

	out, _, err := runCLI(t, []string{"db", "status", "-db", db, "-json"}, "")
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	status := decodeCLI[struct {
		Database struct {
			SchemaVersion int `json:"schemaVersion"`
			Users         int `json:"users"`
			Enabled       int `json:"enabled"`
		} `json:"database"`
	}](t, out)
	if status.Database.Users != 1 || status.Database.Enabled != 1 || status.Database.SchemaVersion == 0 {
		t.Fatalf("status = %+v", status)
	}

	list, _, err := runCLI(t, []string{"user", "list", "-db", db, "-json"}, "")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	page := decodeCLI[struct {
		Users []struct {
			ID       string `json:"id"`
			Username string `json:"username"`
			Enabled  bool   `json:"enabled"`
		} `json:"users"`
		Total int `json:"total"`
	}](t, list)
	if page.Total != 1 || len(page.Users) != 1 || page.Users[0].Username != "Joyce_Moore" || !page.Users[0].Enabled {
		t.Fatalf("list = %+v", page)
	}

	// Human output keeps the tab-separated columns existing runbooks parse.
	human, _, err := runCLI(t, []string{"user", "list", "-db", db}, "")
	if err != nil || !strings.Contains(human, "Joyce_Moore") || !strings.Contains(human, "enabled") {
		t.Fatalf("human list = %q (%v)", human, err)
	}
}

func TestCLIAccountMutationWritesAuditTrail(t *testing.T) {
	db := prepareDB(t)
	createUserViaCLI(t, db, "joyce")
	createUserViaCLI(t, db, "other")

	if _, _, err := runCLI(t, []string{"user", "disable", "-db", db, "JOYCE"}, ""); err != nil {
		t.Fatalf("disable: %v", err)
	}
	if out, _, err := runCLI(t, []string{"user", "show", "-db", db, "-json", "joyce"}, ""); err != nil {
		t.Fatalf("show: %v", err)
	} else if decodeCLI[struct {
		User struct {
			Enabled           bool  `json:"enabled"`
			CredentialVersion int64 `json:"credentialVersion"`
		} `json:"user"`
	}](t, out).User.Enabled {
		t.Fatalf("disable did not stick: %s", out)
	}
	if _, _, err := runCLI(t, []string{"user", "enable", "-db", db, "joyce"}, ""); err != nil {
		t.Fatalf("enable: %v", err)
	}
	if _, _, err := runCLI(t, []string{"session", "revoke", "-db", db, "joyce"}, ""); err != nil {
		t.Fatalf("session revoke: %v", err)
	}
	if _, _, err := runCLI(t, []string{"session", "list", "-db", db, "-json"}, ""); err != nil {
		t.Fatalf("session list: %v", err)
	}

	out, _, err := runCLI(t, []string{"audit", "list", "-db", db, "-json"}, "")
	if err != nil {
		t.Fatalf("audit list: %v", err)
	}
	entries := decodeCLI[struct {
		Entries []struct {
			Actor  string `json:"actor"`
			Action string `json:"action"`
			Target string `json:"target"`
		} `json:"entries"`
	}](t, out).Entries
	if len(entries) != 5 {
		t.Fatalf("audit rows = %d (%+v)", len(entries), entries)
	}
	seen := map[string]bool{}
	for _, entry := range entries {
		seen[entry.Action] = true
		if !strings.HasPrefix(entry.Actor, "cli:") {
			t.Fatalf("CLI audit actor = %q", entry.Actor)
		}
	}
	for _, want := range []string{"user.create", "user.disable", "user.enable", "session.revoke"} {
		if !seen[want] {
			t.Fatalf("action %s missing from %+v", want, entries)
		}
	}
}

func TestCLIProtectsTheLastEnabledAccount(t *testing.T) {
	db := prepareDB(t)
	createUserViaCLI(t, db, "only")

	if _, _, err := runCLI(t, []string{"user", "delete", "-db", db, "only"}, ""); err == nil {
		t.Fatal("deleting the last enabled account must fail without -force")
	}
	if _, _, err := runCLI(t, []string{"user", "delete", "-db", db, "-force", "only"}, ""); err != nil {
		t.Fatalf("force delete: %v", err)
	}
	out, _, err := runCLI(t, []string{"user", "list", "-db", db, "-json"}, "")
	if err != nil {
		t.Fatalf("list after delete: %v", err)
	}
	if decodeCLI[struct {
		Total int `json:"total"`
	}](t, out).Total != 0 {
		t.Fatalf("account survived: %s", out)
	}
	// The trail outlives the account it describes.
	audit, _, err := runCLI(t, []string{"audit", "list", "-db", db, "-json"}, "")
	if err != nil || !strings.Contains(audit, "user.delete") {
		t.Fatalf("audit after delete = %q (%v)", audit, err)
	}
}

func TestCLIUnknownSubcommandsAreRejected(t *testing.T) {
	db := prepareDB(t)
	for _, args := range [][]string{
		{"user", "frobnicate", "-db", db},
		{"session", "frobnicate", "-db", db},
		{"db", "frobnicate", "-db", db},
		{"audit", "-db", db},
	} {
		if _, _, err := runCLI(t, args, ""); err == nil {
			t.Fatalf("%v must be rejected", args)
		}
	}
}
