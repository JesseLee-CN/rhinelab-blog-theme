// Command lab-auth is the account CLI and (from G3) the auth service.
package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/term"

	"github.com/example-org/example-blog/services/lab-auth/internal/config"
	"github.com/example-org/example-blog/services/lab-auth/internal/store"
)

const version = "0.5.0"

var errUsage = errors.New("usage")

func main() {
	if err := run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr); err != nil {
		if errors.Is(err, errUsage) {
			os.Exit(2)
		}
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		usage(stderr)
		return errUsage
	}
	switch args[0] {
	case "help", "-h", "--help":
		usage(stdout)
		return nil
	case "version":
		fmt.Fprintln(stdout, version)
		return nil
	// Canonical grouped form.
	case "user":
		return cmdUser(args[1:], stdin, stdout, stderr)
	case "session":
		return cmdSession(args[1:], stdout, stderr)
	case "audit":
		return cmdAudit(args[1:], stdout)
	case "db":
		return cmdDB(args[1:], stdout)
	// Compatibility aliases: deployment scripts and older runbooks call the flat
	// form, and `migrate`/`backup`/`restore` are one-shot operations anyway.
	case "migrate":
		return cmdMigrate(args[1:], stdout)
	case "backup":
		return cmdBackup(args[1:], stdout)
	case "restore":
		return cmdRestore(args[1:], stdout)
	case "serve":
		return cmdServe(args[1:], stdout, stderr)
	default:
		usage(stderr)
		return errUsage
	}
}

func usage(w io.Writer) {
	fmt.Fprint(w, `lab-auth - Rhine Lab account service and account CLI

Usage:
  lab-auth help
  lab-auth version
  lab-auth serve [-insecure-cookies]

  lab-auth user create          -db <path> <username>
  lab-auth user list            -db <path> [-search <text>] [-enabled true|false]
  lab-auth user show            -db <path> <username|user-id>
  lab-auth user enable          -db <path> <username|user-id>
  lab-auth user disable         -db <path> <username|user-id>
  lab-auth user reset-password  -db <path> <username|user-id>
  lab-auth user revoke-sessions -db <path> <username|user-id>
  lab-auth user delete          -db <path> <username|user-id> [-force]

  lab-auth session list         -db <path> [-user <ref>] [-state pending|active|revoked]
  lab-auth session revoke       -db <path> <username|user-id>
  lab-auth audit list           -db <path> [-target <key>] [-action <action>]

  lab-auth db status            -db <path>
  lab-auth db verify            -db <path>
  lab-auth db migrate           -db <path>
  lab-auth db backup            -db <path> -out <file>
  lab-auth db restore           -src <file> -db <path>

  lab-auth migrate|backup|restore   aliases for the matching "db" verbs

Flags come before positional arguments (standard Go flag parsing), so write
"lab-auth user show -db auth.db -json joyce", not "... joyce -json".
Every command accepts -json for machine-readable output. -db falls back to
LAB_AUTH_DB. Passwords are read from the terminal (hidden, twice) or from piped
stdin; there is intentionally no --password flag. Mutating commands append one
audit row with actor cli:<os user>, the same trail the admin API writes.
`)
}

func newFlagSet(name string) *flag.FlagSet {
	return flag.NewFlagSet(name, flag.ContinueOnError)
}

func resolveDB(flagValue string) (string, error) {
	if path := strings.TrimSpace(flagValue); path != "" {
		return path, nil
	}
	if path := strings.TrimSpace(config.OS("LAB_AUTH_DB")); path != "" {
		return path, nil
	}
	return "", errors.New("database path required: pass -db or set LAB_AUTH_DB")
}

func openStore(path string) (*store.Store, error) {
	s, err := store.Open(path)
	if err != nil {
		return nil, err
	}
	if err := s.Migrate(); err != nil {
		s.Close()
		return nil, err
	}
	return s, nil
}

func cmdMigrate(args []string, stdout io.Writer) error {
	fs := newFlagSet("migrate")
	db := fs.String("db", "", "database path (or LAB_AUTH_DB)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	path, err := resolveDB(*db)
	if err != nil {
		return err
	}
	s, err := openStore(path)
	if err != nil {
		return err
	}
	defer s.Close()
	v, err := s.SchemaVersion()
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "migrated %s to schema v%d\n", path, v)
	return nil
}

func cmdBackup(args []string, stdout io.Writer) error {
	fs := newFlagSet("backup")
	db := fs.String("db", "", "database path (or LAB_AUTH_DB)")
	out := fs.String("out", "", "backup destination file")
	if err := fs.Parse(args); err != nil {
		return err
	}
	path, err := resolveDB(*db)
	if err != nil {
		return err
	}
	if strings.TrimSpace(*out) == "" {
		return errors.New("backup destination required: -out <file>")
	}
	s, err := store.Open(path)
	if err != nil {
		return err
	}
	defer s.Close()
	if err := s.Backup(*out); err != nil {
		return err
	}
	info, err := store.VerifyBackup(*out)
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "backup %s (schema v%d, %d users, integrity=%v)\n", *out, info.SchemaVersion, info.Users, info.IntegrityOK)
	return nil
}

func cmdRestore(args []string, stdout io.Writer) error {
	fs := newFlagSet("restore")
	src := fs.String("src", "", "backup file to restore")
	db := fs.String("db", "", "database path (or LAB_AUTH_DB)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*src) == "" {
		return errors.New("backup source required: -src <file>")
	}
	path, err := resolveDB(*db)
	if err != nil {
		return err
	}
	info, err := store.RestoreBackup(*src, path)
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "restored %s from %s (schema v%d, %d users); sessions revoked\n", path, *src, info.SchemaVersion, info.Users)
	return nil
}

func readPasswordTwice(stdin io.Reader, stdout io.Writer) (string, error) {
	reader := bufio.NewReader(stdin)
	read := func(prompt string) (string, error) {
		return readPassword(reader, stdin, stdout, prompt)
	}
	first, err := read("Password: ")
	if err != nil {
		return "", err
	}
	second, err := read("Confirm password: ")
	if err != nil {
		return "", err
	}
	if first != second {
		return "", errors.New("passwords do not match")
	}
	return first, nil
}

func readPassword(reader *bufio.Reader, stdin io.Reader, stdout io.Writer, prompt string) (string, error) {
	if f, ok := stdin.(*os.File); ok && term.IsTerminal(int(f.Fd())) {
		fmt.Fprint(stdout, prompt)
		raw, err := term.ReadPassword(int(f.Fd()))
		fmt.Fprintln(stdout)
		if err != nil {
			return "", err
		}
		return string(raw), nil
	}
	line, err := reader.ReadString('\n')
	if err != nil && err != io.EOF {
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}
