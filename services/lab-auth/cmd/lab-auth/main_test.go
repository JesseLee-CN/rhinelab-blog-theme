package main

import (
	"bytes"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func runCLI(t *testing.T, args []string, stdin string) (string, string, error) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	err := run(args, strings.NewReader(stdin), &stdout, &stderr)
	return stdout.String(), stderr.String(), err
}

func TestCLICreateListNeverLeaksPassword(t *testing.T) {
	db := filepath.Join(t.TempDir(), "auth.db")
	if _, _, err := runCLI(t, []string{"migrate", "-db", db}, ""); err != nil {
		t.Fatal(err)
	}
	password := "A top secret long password 1"
	out, _, err := runCLI(t, []string{"user", "create", "-db", db, "TestUser"}, password+"\n"+password+"\n")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	listOut, _, err := runCLI(t, []string{"user", "list", "-db", db}, "")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	for _, captured := range []string{out, listOut} {
		if strings.Contains(captured, password) {
			t.Fatalf("password leaked in CLI output: %q", captured)
		}
	}
	if !strings.Contains(listOut, "TestUser") {
		t.Fatalf("list should contain the user: %q", listOut)
	}
}

func TestCLIRejectsPasswordMismatchAndMissingArgs(t *testing.T) {
	db := filepath.Join(t.TempDir(), "auth.db")
	if _, _, err := runCLI(t, []string{"migrate", "-db", db}, ""); err != nil {
		t.Fatal(err)
	}
	if _, _, err := runCLI(t, []string{"user", "create", "-db", db, "Mismatch"}, "one long password\nother long password\n"); err == nil {
		t.Fatal("mismatched password confirmation must fail")
	}
	if _, _, err := runCLI(t, []string{"user", "create", "-db", db}, "a long password\na long password\n"); err == nil {
		t.Fatal("missing username must fail")
	}
	if _, _, err := runCLI(t, []string{"migrate"}, ""); err == nil {
		t.Fatal("missing database path must fail")
	}
	if _, _, err := runCLI(t, []string{"unknown"}, ""); !errors.Is(err, errUsage) {
		t.Fatalf("unknown command should be a usage error, got %v", err)
	}
}

func TestCLIHasNoPasswordFlag(t *testing.T) {
	db := filepath.Join(t.TempDir(), "auth.db")
	if _, _, err := runCLI(t, []string{"migrate", "-db", db}, ""); err != nil {
		t.Fatal(err)
	}
	// A --password flag must be undefined, before any positional argument.
	if _, _, err := runCLI(t, []string{"user", "create", "-db", db, "--password", "short"}, ""); err == nil {
		t.Fatal("unknown --password flag must be rejected")
	}
}
