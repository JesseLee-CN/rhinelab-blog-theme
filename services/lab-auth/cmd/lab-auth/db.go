package main

import (
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/example-org/example-blog/services/lab-auth/internal/store"
)

// Database-level commands: schema, integrity, backup/restore, and the read-only
// views over sessions and the audit trail. `migrate`, `backup` and `restore`
// stay available as top-level aliases because deployment scripts call them that
// way; `db <verb>` is the canonical, grouped form.

func cmdDB(args []string, stdout io.Writer) error {
	if len(args) == 0 {
		return errors.New("db subcommand required: status|verify|migrate|backup|restore")
	}
	verb, rest := args[0], args[1:]
	switch verb {
	case "migrate":
		return cmdMigrate(rest, stdout)
	case "status":
		return cmdStatus(rest, stdout)
	case "verify":
		return cmdVerify(rest, stdout)
	case "backup":
		return cmdBackup(rest, stdout)
	case "restore":
		return cmdRestore(rest, stdout)
	default:
		return fmt.Errorf("unknown db subcommand %q", verb)
	}
}

func cmdStatus(args []string, stdout io.Writer) error {
	flags := newCommon("db status")
	if err := flags.set.Parse(args); err != nil {
		return err
	}
	st, err := flags.open()
	if err != nil {
		return err
	}
	defer st.Close()
	status, err := st.Status()
	if err != nil {
		return err
	}
	if flags.parsed() {
		return printJSON(stdout, map[string]any{"service": serviceJSON(), "database": databaseJSON(status)})
	}
	fmt.Fprintf(stdout, "database       %s\nschema         v%d (migrated %s)\n",
		status.Path, status.SchemaVersion, unixTime(status.MigratedAt))
	fmt.Fprintf(stdout, "accounts       %d (%d enabled, %d disabled)\n", status.Users, status.Enabled, status.Disabled)
	fmt.Fprintf(stdout, "sessions       %d active, %d pending\n", status.SessionsActive, status.SessionsPending)
	fmt.Fprintf(stdout, "audit entries  %d\n", status.AuditEntries)
	return nil
}

func cmdVerify(args []string, stdout io.Writer) error {
	flags := newCommon("db verify")
	if err := flags.set.Parse(args); err != nil {
		return err
	}
	st, err := flags.open()
	if err != nil {
		return err
	}
	defer st.Close()
	status, err := st.Verify()
	if err != nil {
		return err
	}
	if flags.parsed() {
		return printJSON(stdout, map[string]any{"database": databaseJSON(status), "integrity": "ok"})
	}
	fmt.Fprintf(stdout, "%s: integrity ok, schema v%d, %d account(s)\n", status.Path, status.SchemaVersion, status.Users)
	return nil
}

func cmdAudit(args []string, stdout io.Writer) error {
	if len(args) == 0 || args[0] != "list" {
		return errors.New("audit subcommand required: list")
	}
	flags := newCommon("audit list")
	target := flags.set.String("target", "", "filter by username key")
	action := flags.set.String("action", "", "filter by action (user.create, ...)")
	limit := flags.set.Int("limit", 50, "page size")
	offset := flags.set.Int("offset", 0, "page offset")
	if err := flags.set.Parse(args[1:]); err != nil {
		return err
	}
	st, err := flags.open()
	if err != nil {
		return err
	}
	defer st.Close()
	entries, err := st.ListAudit(store.AuditQuery{Target: *target, Action: *action, Limit: *limit, Offset: *offset})
	if err != nil {
		return err
	}
	if flags.parsed() {
		models := make([]map[string]any, 0, len(entries))
		for _, entry := range entries {
			models = append(models, map[string]any{
				"id": entry.ID, "at": entry.At, "actor": entry.Actor,
				"action": entry.Action, "target": entry.Target, "detail": entry.Detail,
			})
		}
		return printJSON(stdout, map[string]any{"entries": models, "limit": *limit, "offset": *offset})
	}
	for _, entry := range entries {
		fmt.Fprintf(stdout, "%s\t%s\t%s\t%s\t%s\n",
			time.Unix(entry.At, 0).Format(time.RFC3339), entry.Actor, entry.Action, entry.Target, entry.Detail)
	}
	fmt.Fprintf(stdout, "%d entr(y|ies)\n", len(entries))
	return nil
}

func cmdSession(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		return errors.New("session subcommand required: list|revoke")
	}
	verb, rest := args[0], args[1:]
	flags := newCommon("session " + verb)
	user := flags.set.String("user", "", "filter by username or user id")
	state := flags.set.String("state", "", "filter by state (pending|active|revoked)")
	limit := flags.set.Int("limit", 50, "page size")
	offset := flags.set.Int("offset", 0, "page offset")
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
	case "list":
		sessions, err := st.ListSessions(store.SessionQuery{User: *user, State: *state, Limit: *limit, Offset: *offset})
		if err != nil {
			return err
		}
		if flags.parsed() {
			models := make([]map[string]any, 0, len(sessions))
			for _, session := range sessions {
				models = append(models, sessionJSON(session))
			}
			return printJSON(stdout, map[string]any{"sessions": models, "limit": *limit, "offset": *offset})
		}
		for _, session := range sessions {
			fmt.Fprintf(stdout, "%s\t%s\t%s\tseen %s\tidle until %s\n",
				session.ID, session.Username, session.State,
				unixTime(session.LastSeenAt), unixTime(session.IdleExpiresAt))
		}
		fmt.Fprintf(stdout, "%d session(s)\n", len(sessions))
		return nil
	case "revoke":
		if ref == "" {
			return errors.New("session revoke requires a username or user id")
		}
		account, err := st.GetAccount(ref)
		if err != nil {
			return err
		}
		revoked, err := st.RevokeAccountSessions(ref)
		if err != nil {
			return err
		}
		audit(st, stderr, "session.revoke", account, "revoked="+strconv.FormatInt(revoked, 10))
		if flags.parsed() {
			return printJSON(stdout, map[string]any{"user": userJSON(account), "revoked": revoked})
		}
		fmt.Fprintf(stdout, "revoked %d session(s) for %s\n", revoked, account.Username)
		return nil
	default:
		return fmt.Errorf("unknown session subcommand %q", verb)
	}
}

func sessionJSON(session store.SessionInfo) map[string]any {
	return map[string]any{
		"id":                session.ID,
		"userId":            session.UserID,
		"username":          session.Username,
		"state":             session.State,
		"createdAt":         session.CreatedAt,
		"lastSeenAt":        session.LastSeenAt,
		"idleExpiresAt":     session.IdleExpiresAt,
		"absoluteExpiresAt": session.AbsoluteExpiresAt,
	}
}

func databaseJSON(status store.Status) map[string]any {
	return map[string]any{
		"path":          status.Path,
		"schemaVersion": status.SchemaVersion,
		"migratedAt":    status.MigratedAt,
		"users":         status.Users,
		"enabled":       status.Enabled,
		"disabled":      status.Disabled,
		"sessions":      map[string]any{"active": status.SessionsActive, "pending": status.SessionsPending},
		"auditEntries":  status.AuditEntries,
	}
}

func serviceJSON() map[string]any {
	return map[string]any{"name": "lab-auth", "version": version}
}

func unixTime(seconds int64) string {
	if seconds == 0 {
		return "-"
	}
	return time.Unix(seconds, 0).Format(time.RFC3339)
}
