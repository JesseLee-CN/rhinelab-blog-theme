package store

import (
	"errors"
	"testing"
)

// Account management surface: the operations the CLI and the admin API expose.
// These tests judge behaviour that the login path never exercises — paging,
// deletion with its dependent rows, the last-account guard and the audit trail.

func createAccount(t *testing.T, s *Store, username, password string) User {
	t.Helper()
	user, err := s.CreateUser(username, password)
	if err != nil {
		t.Fatalf("create %s: %v", username, err)
	}
	return user
}

func TestListAccountsFiltersAndPages(t *testing.T) {
	s := openTest(t)
	defer s.Close()
	for _, name := range []string{"alpha", "beta", "gamma"} {
		createAccount(t, s, name, "A long enough password 1")
	}
	if err := s.SetEnabled("beta", false); err != nil {
		t.Fatal(err)
	}

	page, err := s.ListAccounts(AccountQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 3 || len(page.Users) != 3 {
		t.Fatalf("unfiltered page = %+v", page)
	}
	// Deterministic ordering is what makes paging usable.
	if page.Users[0].Username != "alpha" || page.Users[2].Username != "gamma" {
		t.Fatalf("order = %v", []string{page.Users[0].Username, page.Users[1].Username, page.Users[2].Username})
	}

	disabled := false
	only, err := s.ListAccounts(AccountQuery{Enabled: &disabled})
	if err != nil {
		t.Fatal(err)
	}
	if only.Total != 1 || only.Users[0].Username != "beta" {
		t.Fatalf("disabled filter = %+v", only)
	}

	searched, err := s.ListAccounts(AccountQuery{Search: "AM"})
	if err != nil {
		t.Fatal(err)
	}
	if searched.Total != 1 || searched.Users[0].Username != "gamma" {
		t.Fatalf("case-insensitive search = %+v", searched)
	}

	// A LIKE wildcard in the search must be a literal, not a pattern.
	wild, err := s.ListAccounts(AccountQuery{Search: "%"})
	if err != nil {
		t.Fatal(err)
	}
	if wild.Total != 0 {
		t.Fatalf("wildcard leaked into LIKE: %+v", wild)
	}

	paged, err := s.ListAccounts(AccountQuery{Limit: 2, Offset: 2})
	if err != nil {
		t.Fatal(err)
	}
	if paged.Total != 3 || len(paged.Users) != 1 || paged.Offset != 2 {
		t.Fatalf("paged = %+v", paged)
	}
}

func TestGetAccountResolvesUsernameOrID(t *testing.T) {
	s := openTest(t)
	defer s.Close()
	created := createAccount(t, s, "Joyce_Moore", "A long enough password 1")

	byName, err := s.GetAccount("joyce_moore")
	if err != nil || byName.ID != created.ID {
		t.Fatalf("by key: %+v %v", byName, err)
	}
	byMixedCase, err := s.GetAccount("JOYCE_MOORE")
	if err != nil || byMixedCase.ID != created.ID {
		t.Fatalf("by mixed case: %+v %v", byMixedCase, err)
	}
	byID, err := s.GetAccount(created.ID)
	if err != nil || byID.Username != created.Username {
		t.Fatalf("by id: %+v %v", byID, err)
	}
	if _, err := s.GetAccount("nobody"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown reference = %v", err)
	}
	if _, err := s.GetAccount("  "); !errors.Is(err, ErrNotFound) {
		t.Fatalf("empty reference = %v", err)
	}
}

func TestSetAccountEnabledAndSessionRevocation(t *testing.T) {
	s := openTest(t)
	defer s.Close()
	createAccount(t, s, "joyce", "A long enough password 1")

	disabled, err := s.SetAccountEnabled("joyce", false)
	if err != nil || disabled.Enabled {
		t.Fatalf("disable: %+v %v", disabled, err)
	}
	if disabled.CredentialVersion != 2 {
		t.Fatalf("disable must bump the credential version: %+v", disabled)
	}
	enabled, err := s.SetAccountEnabled("joyce", true)
	if err != nil || !enabled.Enabled {
		t.Fatalf("enable: %+v %v", enabled, err)
	}
	if _, err := s.SetAccountEnabled("nobody", true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown account = %v", err)
	}
	if n, err := s.RevokeAccountSessions("joyce"); err != nil || n != 0 {
		t.Fatalf("revoke with no sessions = %d %v", n, err)
	}
	if _, err := s.RevokeAccountSessions("nobody"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("revoke unknown = %v", err)
	}
}

func TestDeleteAccountRemovesDependentRowsAndGuardsTheLastOne(t *testing.T) {
	s := openTest(t)
	defer s.Close()
	first := createAccount(t, s, "first", "A long enough password 1")
	second := createAccount(t, s, "second", "A long enough password 1")
	createAccount(t, s, "third", "A long enough password 1")

	// login_attempts and sessions reference users without ON DELETE CASCADE, so a
	// naive delete would fail on the foreign key: this asserts the transaction
	// removes them.
	if _, err := s.db.Exec(
		`INSERT INTO flows(flow_id, token_hash, csrf_hash, csrf_expires_at, created_at, expires_at)
		 VALUES('f_1', 'th', 'ch', 1, 1, 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(
		`INSERT INTO login_attempts(attempt_id, flow_id, state, user_id, issued_at, deadline_at)
		 VALUES('a_1', 'f_1', 'pending', ?, 1, 1)`, second.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(
		`INSERT INTO sessions(session_id, token_hash, user_id, attempt_id, state, credential_version,
		   csrf_hash, idle_expires_at, absolute_expires_at, created_at, last_seen_at)
		 VALUES('s_1', 'th2', ?, 'a_1', 'active', 1, 'ch2', 1, 1, 1, 1)`, second.ID); err != nil {
		t.Fatal(err)
	}

	// Deleting either of the two remaining enabled accounts leaves one behind, so
	// the guard only fires for the final account.
	if _, err := s.DeleteAccount("third", false); err != nil {
		t.Fatalf("delete third: %v", err)
	}
	deleted, err := s.DeleteAccount(second.Username, false)
	if err != nil {
		t.Fatalf("delete second: %v", err)
	}
	if deleted.ID != second.ID {
		t.Fatalf("deleted the wrong account: %+v", deleted)
	}
	if _, err := s.GetAccount(second.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("account still present: %v", err)
	}
	var leftovers int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM sessions WHERE user_id = ?`, second.ID).Scan(&leftovers); err != nil {
		t.Fatal(err)
	}
	if leftovers != 0 {
		t.Fatalf("sessions left behind: %d", leftovers)
	}
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM login_attempts WHERE user_id = ?`, second.ID).Scan(&leftovers); err != nil {
		t.Fatal(err)
	}
	if leftovers != 0 {
		t.Fatalf("attempts left behind: %d", leftovers)
	}

	if _, err := s.DeleteAccount(first.ID, false); !errors.Is(err, ErrLastAccount) {
		t.Fatalf("last enabled account must be protected, got %v", err)
	}
	if _, err := s.DeleteAccount(first.ID, true); err != nil {
		t.Fatalf("force delete: %v", err)
	}
	if n, err := s.CountUsers(); err != nil || n != 0 {
		t.Fatalf("users left: %d %v", n, err)
	}
}

func TestAuditTrailIsAppendOnlyAndQueryable(t *testing.T) {
	s := openTest(t)
	defer s.Close()
	createAccount(t, s, "joyce", "A long enough password 1")

	first, err := s.AppendAudit(AuditEntry{Actor: "cli:test", Action: "user.create", Target: "joyce"})
	if err != nil {
		t.Fatal(err)
	}
	if first.ID == "" || first.At == 0 {
		t.Fatalf("audit entry not filled in: %+v", first)
	}
	if _, err := s.AppendAudit(AuditEntry{Actor: "admin-api", Action: "user.disable", Target: "joyce", Detail: "revoked"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AppendAudit(AuditEntry{Action: "  "}); err == nil {
		t.Fatal("an empty action must be rejected")
	}
	// An empty actor is not an error: it becomes "system" rather than a blank column.
	system, err := s.AppendAudit(AuditEntry{Action: "system.check"})
	if err != nil || system.Actor != "system" {
		t.Fatalf("default actor = %+v %v", system, err)
	}

	all, err := s.ListAudit(AuditQuery{})
	if err != nil || len(all) != 3 {
		t.Fatalf("list all = %d %v", len(all), err)
	}
	byTarget, err := s.ListAudit(AuditQuery{Target: "joyce"})
	if err != nil || len(byTarget) != 2 {
		t.Fatalf("by target = %d %v", len(byTarget), err)
	}
	byAction, err := s.ListAudit(AuditQuery{Action: "user.disable"})
	if err != nil || len(byAction) != 1 || byAction[0].Actor != "admin-api" {
		t.Fatalf("by action = %+v %v", byAction, err)
	}
	// Newest first, so an operator sees the most recent change without ordering.
	if byTarget[0].Action != "user.disable" {
		t.Fatalf("audit order = %+v", byTarget)
	}
}

func TestStatusAndVerifyReportTheDatabase(t *testing.T) {
	s := openTest(t)
	defer s.Close()
	createAccount(t, s, "joyce", "A long enough password 1")
	if err := s.SetEnabled("joyce", false); err != nil {
		t.Fatal(err)
	}
	createAccount(t, s, "other", "A long enough password 1")
	if _, err := s.AppendAudit(AuditEntry{Actor: "cli:test", Action: "user.create", Target: "other"}); err != nil {
		t.Fatal(err)
	}

	status, err := s.Status()
	if err != nil {
		t.Fatal(err)
	}
	if status.SchemaVersion != latestSchemaVersion(t) || status.Users != 2 || status.Enabled != 1 || status.Disabled != 1 {
		t.Fatalf("status = %+v", status)
	}
	if status.AuditEntries != 1 || status.Path == "" || status.MigratedAt == 0 {
		t.Fatalf("status = %+v", status)
	}
	verified, err := s.Verify()
	if err != nil || verified.SchemaVersion != status.SchemaVersion {
		t.Fatalf("verify = %+v %v", verified, err)
	}
}

func TestListSessionsJoinsTheAccount(t *testing.T) {
	s := openTest(t)
	defer s.Close()
	user := createAccount(t, s, "joyce", "A long enough password 1")
	if _, err := s.db.Exec(
		`INSERT INTO sessions(session_id, token_hash, user_id, state, credential_version,
		   csrf_hash, idle_expires_at, absolute_expires_at, created_at, last_seen_at)
		 VALUES('s_1', 'th', ?, 'active', 1, 'ch', 10, 20, 1, 2)`, user.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(
		`INSERT INTO sessions(session_id, token_hash, user_id, state, credential_version,
		   csrf_hash, idle_expires_at, absolute_expires_at, created_at, last_seen_at)
		 VALUES('s_2', 'th2', ?, 'revoked', 1, 'ch2', 10, 20, 3, 4)`, user.ID); err != nil {
		t.Fatal(err)
	}

	all, err := s.ListSessions(SessionQuery{})
	if err != nil || len(all) != 2 {
		t.Fatalf("all sessions = %d %v", len(all), err)
	}
	if all[0].Username != "joyce" {
		t.Fatalf("join missing username: %+v", all[0])
	}
	active, err := s.ListSessions(SessionQuery{State: "active"})
	if err != nil || len(active) != 1 || active[0].ID != "s_1" {
		t.Fatalf("state filter = %+v %v", active, err)
	}
	byUser, err := s.ListSessions(SessionQuery{User: "JOYCE"})
	if err != nil || len(byUser) != 2 {
		t.Fatalf("user filter = %d %v", len(byUser), err)
	}
	if n, err := s.RevokeAllSessions(); err != nil || n != 1 {
		t.Fatalf("revoke all = %d %v", n, err)
	}
}
