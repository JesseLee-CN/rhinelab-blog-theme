package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"github.com/example-org/example-blog/services/lab-auth/internal/store"
)

// Account management from the command line.
//
// Grammar (`lab-auth user <verb> [flags] [ref]`) and output are deliberately the
// same shapes as the admin HTTP API, so a script can switch between the two and
// only change the transport. Every mutating verb appends one audit row with actor
// `cli:<os user>`; passwords are only ever read from the terminal or piped stdin.

// commonFlags are the flags every database-touching command accepts.
type commonFlags struct {
	set    *flag.FlagSet
	db     *string
	asJSON *bool
}

func newCommon(name string) *commonFlags {
	fs := newFlagSet(name)
	return &commonFlags{
		set:    fs,
		db:     fs.String("db", "", "database path (or LAB_AUTH_DB)"),
		asJSON: fs.Bool("json", false, "print machine-readable JSON"),
	}
}

func (c *commonFlags) open() (*store.Store, error) {
	path, err := resolveDB(*c.db)
	if err != nil {
		return nil, err
	}
	return openStore(path)
}

func (c *commonFlags) parsed() bool { return *c.asJSON }

// actor identifies who ran a mutating command, for the audit trail.
func actor() string {
	for _, key := range []string{"LAB_AUTH_ACTOR", "USERNAME", "USER"} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return "cli:" + value
		}
	}
	return "cli:unknown"
}

// audit appends one trail row. A failed write never hides a mutation that already
// happened: it is reported on stderr and the command still succeeds.
func audit(st *store.Store, stderr io.Writer, action string, user store.User, detail string) {
	target := user.UsernameKey
	if target == "" {
		target = user.Username
	}
	if _, err := st.AppendAudit(store.AuditEntry{Actor: actor(), Action: action, Target: target, Detail: detail}); err != nil {
		fmt.Fprintf(stderr, "warning: audit row not written: %v\n", err)
	}
}

func userJSON(user store.User) map[string]any {
	return map[string]any{
		"id":                user.ID,
		"username":          user.Username,
		"enabled":           user.Enabled,
		"credentialVersion": user.CredentialVersion,
		"createdAt":         user.CreatedAt,
		"updatedAt":         user.UpdatedAt,
	}
}

func printJSON(stdout io.Writer, value any) error {
	enc := json.NewEncoder(stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(value)
}

func cmdUser(args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		return errors.New("user subcommand required: create|list|show|enable|disable|reset-password|revoke-sessions|delete")
	}
	verb, rest := args[0], args[1:]
	flags := newCommon("user " + verb)
	search := flags.set.String("search", "", "list: substring filter on the username")
	enabledOnly := flags.set.String("enabled", "", "list: true|false to filter by state")
	limit := flags.set.Int("limit", 100, "list: page size")
	offset := flags.set.Int("offset", 0, "list: page offset")
	force := flags.set.Bool("force", false, "delete: allow removing the last enabled account")
	if err := flags.set.Parse(rest); err != nil {
		return err
	}
	ref := strings.TrimSpace(flags.set.Arg(0))
	st, err := flags.open()
	if err != nil {
		return err
	}
	defer st.Close()

	switch verb {
	case "create":
		if ref == "" {
			return errors.New("username required")
		}
		plain, err := readPasswordTwice(stdin, stdout)
		if err != nil {
			return err
		}
		user, err := st.CreateUser(ref, plain)
		if err != nil {
			return err
		}
		audit(st, stderr, "user.create", user, "")
		if flags.parsed() {
			return printJSON(stdout, map[string]any{"user": userJSON(user)})
		}
		fmt.Fprintf(stdout, "created %s (id %s)\n", user.Username, user.ID)
		return nil

	case "list":
		query := store.AccountQuery{Search: *search, Limit: *limit, Offset: *offset}
		switch strings.ToLower(strings.TrimSpace(*enabledOnly)) {
		case "":
		case "1", "true", "yes":
			value := true
			query.Enabled = &value
		case "0", "false", "no":
			value := false
			query.Enabled = &value
		default:
			return errors.New("enabled only accepts true or false")
		}
		page, err := st.ListAccounts(query)
		if err != nil {
			return err
		}
		if flags.parsed() {
			users := make([]map[string]any, 0, len(page.Users))
			for _, user := range page.Users {
				users = append(users, userJSON(user))
			}
			return printJSON(stdout, map[string]any{
				"users": users, "total": page.Total, "limit": page.Limit, "offset": page.Offset,
			})
		}
		for _, user := range page.Users {
			fmt.Fprintf(stdout, "%s\t%s\t%s\tv%d\n", user.ID, user.Username, stateWord(user.Enabled), user.CredentialVersion)
		}
		fmt.Fprintf(stdout, "%d user(s) shown of %d\n", len(page.Users), page.Total)
		return nil

	case "show":
		user, err := st.GetAccount(ref)
		if err != nil {
			return err
		}
		if flags.parsed() {
			return printJSON(stdout, map[string]any{"user": userJSON(user)})
		}
		fmt.Fprintf(stdout, "id       %s\nusername %s\nstate    %s\nversion  v%d\ncreated  %s\nupdated  %s\n",
			user.ID, user.Username, stateWord(user.Enabled), user.CredentialVersion,
			unixTime(user.CreatedAt), unixTime(user.UpdatedAt))
		return nil

	case "enable", "disable":
		user, err := st.SetAccountEnabled(ref, verb == "enable")
		if err != nil {
			return err
		}
		action := "user.disable"
		if verb == "enable" {
			action = "user.enable"
		}
		audit(st, stderr, action, user, "")
		if flags.parsed() {
			return printJSON(stdout, map[string]any{"user": userJSON(user)})
		}
		fmt.Fprintf(stdout, "%sd %s; sessions revoked\n", verb, user.Username)
		return nil

	case "reset-password":
		if ref == "" {
			return errors.New("username required")
		}
		plain, err := readPasswordTwice(stdin, stdout)
		if err != nil {
			return err
		}
		user, err := st.ResetAccountPassword(ref, plain)
		if err != nil {
			return err
		}
		audit(st, stderr, "user.password", user, "credential version bumped")
		if flags.parsed() {
			return printJSON(stdout, map[string]any{"user": userJSON(user)})
		}
		fmt.Fprintf(stdout, "password reset for %s; sessions revoked\n", user.Username)
		return nil

	case "revoke-sessions":
		user, err := st.GetAccount(ref)
		if err != nil {
			return err
		}
		revoked, err := st.RevokeAccountSessions(ref)
		if err != nil {
			return err
		}
		audit(st, stderr, "session.revoke", user, "revoked="+strconv.FormatInt(revoked, 10))
		if flags.parsed() {
			return printJSON(stdout, map[string]any{"user": userJSON(user), "revoked": revoked})
		}
		fmt.Fprintf(stdout, "revoked %d session(s) for %s\n", revoked, user.Username)
		return nil

	case "delete":
		user, err := st.DeleteAccount(ref, *force)
		if err != nil {
			return err
		}
		// The audit row survives the account: it stores the username, not the id.
		audit(st, stderr, "user.delete", user, "force="+strconv.FormatBool(*force))
		if flags.parsed() {
			return printJSON(stdout, map[string]any{"user": userJSON(user)})
		}
		fmt.Fprintf(stdout, "deleted %s (id %s); sessions and attempts removed\n", user.Username, user.ID)
		return nil

	default:
		return fmt.Errorf("unknown user subcommand %q", verb)
	}
}

func stateWord(enabled bool) string {
	if enabled {
		return "enabled"
	}
	return "disabled"
}
