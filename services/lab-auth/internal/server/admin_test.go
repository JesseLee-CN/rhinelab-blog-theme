package server_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/example-org/example-blog/services/lab-auth/internal/config"
	"github.com/example-org/example-blog/services/lab-auth/internal/store"
)

// Admin API: the token gate, the CRUD surface and the audit trail it writes.
// The tests deliberately go through the real HTTP handler, because the point of
// the API is that an operator can manage accounts without shell access.

const adminToken = "test-admin-token-that-is-long-enough-01"

func adminEnv(t *testing.T) *env {
	t.Helper()
	return setupWith(t, func(cfg *config.Config) {
		cfg.AdminToken = adminToken
		cfg.AdminRate = 100000
	})
}

// admin carries the bearer token on every request.
type admin struct {
	*client
	token string
}

func (e *env) asAdmin(token string) admin {
	return admin{client: e.client(), token: token}
}

func (a admin) call(method, path, body string) response {
	headers := map[string]string{}
	if a.token != "" {
		headers["Authorization"] = "Bearer " + a.token
	}
	return a.do(method, path, body, headers)
}

func decodeAdmin[T any](t *testing.T, res response) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(res.body, &value); err != nil {
		t.Fatalf("decode %s: %v", res.body, err)
	}
	return value
}

type adminUserBody struct {
	User struct {
		ID                string `json:"id"`
		Username          string `json:"username"`
		Enabled           bool   `json:"enabled"`
		CredentialVersion int64  `json:"credentialVersion"`
	} `json:"user"`
}

type adminListBody struct {
	Users []struct {
		ID       string `json:"id"`
		Username string `json:"username"`
		Enabled  bool   `json:"enabled"`
	} `json:"users"`
	Total  int `json:"total"`
	Limit  int `json:"limit"`
	Offset int `json:"offset"`
}

type adminAuditBody struct {
	Entries []struct {
		Actor  string `json:"actor"`
		Action string `json:"action"`
		Target string `json:"target"`
		Detail string `json:"detail"`
	} `json:"entries"`
}

func TestAdminDisabledWithoutToken(t *testing.T) {
	e := setup(t) // no AdminToken configured
	a := e.asAdmin(adminToken)
	res := a.call(http.MethodGet, "/api/auth/admin/status", "")
	if res.status != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", res.status, res.body)
	}
	if code := errorCode(t, res); code != "admin_disabled" {
		t.Fatalf("code=%s", code)
	}
}

func TestAdminRequiresTheBearerToken(t *testing.T) {
	e := adminEnv(t)
	e.createUser("joyce", "a long enough password")
	for _, token := range []string{"", "wrong-token-that-is-long-enough-000", adminToken + "x"} {
		a := e.asAdmin(token)
		res := a.call(http.MethodGet, "/api/auth/admin/users", "")
		if res.status != http.StatusUnauthorized {
			t.Fatalf("token %q: status=%d body=%s", token, res.status, res.body)
		}
		if code := errorCode(t, res); code != "unauthorized" {
			t.Fatalf("token %q: code=%s", token, code)
		}
	}
	// An empty configured token must never be satisfied by an empty header.
	e2 := setup(t)
	if res := e2.asAdmin("").call(http.MethodGet, "/api/auth/admin/users", ""); res.status != http.StatusServiceUnavailable {
		t.Fatalf("empty token must stay disabled: status=%d", res.status)
	}
}

func TestAdminAccountLifecycleIsAudited(t *testing.T) {
	e := adminEnv(t)
	a := e.asAdmin(adminToken)

	// create
	res := a.call(http.MethodPost, "/api/auth/admin/users", `{"username":"Joyce_Moore","password":"a long enough password"}`)
	if res.status != http.StatusCreated {
		t.Fatalf("create: status=%d body=%s", res.status, res.body)
	}
	created := decodeAdmin[adminUserBody](t, res)
	if created.User.Username != "Joyce_Moore" || !created.User.Enabled || created.User.ID == "" {
		t.Fatalf("created = %+v", created.User)
	}

	// create with a taken username must not overwrite anything
	again := a.call(http.MethodPost, "/api/auth/admin/users", `{"username":"joyce_moore","password":"another long password"}`)
	if again.status != http.StatusConflict || errorCode(t, again) != "username_taken" {
		t.Fatalf("duplicate: status=%d code=%s", again.status, errorCode(t, again))
	}
	// rule violations are 400 with a specific code, never a generic failure
	short := a.call(http.MethodPost, "/api/auth/admin/users", `{"username":"ab","password":"a long enough password"}`)
	if short.status != http.StatusBadRequest || errorCode(t, short) != "invalid_username" {
		t.Fatalf("short username: status=%d code=%s", short.status, errorCode(t, short))
	}
	weak := a.call(http.MethodPost, "/api/auth/admin/users", `{"username":"someone","password":"short"}`)
	if weak.status != http.StatusBadRequest || errorCode(t, weak) != "invalid_password" {
		t.Fatalf("weak password: status=%d code=%s", weak.status, errorCode(t, weak))
	}

	// read back by key and by id
	byKey := a.call(http.MethodGet, "/api/auth/admin/users/joyce_moore", "")
	if byKey.status != http.StatusOK || decodeAdmin[adminUserBody](t, byKey).User.ID != created.User.ID {
		t.Fatalf("get by key: status=%d body=%s", byKey.status, byKey.body)
	}
	byID := a.call(http.MethodGet, "/api/auth/admin/users/"+created.User.ID, "")
	if byID.status != http.StatusOK {
		t.Fatalf("get by id: status=%d body=%s", byID.status, byID.body)
	}
	if missing := a.call(http.MethodGet, "/api/auth/admin/users/nobody", ""); missing.status != http.StatusNotFound {
		t.Fatalf("unknown account: status=%d", missing.status)
	}

	// list with a search filter
	list := decodeAdmin[adminListBody](t, a.call(http.MethodGet, "/api/auth/admin/users?search=joyce", ""))
	if list.Total != 1 || len(list.Users) != 1 || list.Users[0].ID != created.User.ID {
		t.Fatalf("list = %+v", list)
	}
	if bad := a.call(http.MethodGet, "/api/auth/admin/users?enabled=maybe", ""); bad.status != http.StatusBadRequest {
		t.Fatalf("bad filter: status=%d", bad.status)
	}

	// disable bumps the credential version; enable restores it
	disabled := decodeAdmin[adminUserBody](t, a.call(http.MethodPost, "/api/auth/admin/users/joyce_moore/disable", ""))
	if disabled.User.Enabled {
		t.Fatalf("disable did not stick: %+v", disabled.User)
	}
	if disabled.User.CredentialVersion <= created.User.CredentialVersion {
		t.Fatalf("disable must bump the credential version: %+v", disabled.User)
	}
	enabled := decodeAdmin[adminUserBody](t, a.call(http.MethodPost, "/api/auth/admin/users/joyce_moore/enable", ""))
	if !enabled.User.Enabled {
		t.Fatalf("enable did not stick: %+v", enabled.User)
	}

	// password reset revokes sessions
	reset := decodeAdmin[adminUserBody](t, a.call(http.MethodPost, "/api/auth/admin/users/joyce_moore/password", `{"password":"a brand new long password"}`))
	if reset.User.CredentialVersion <= enabled.User.CredentialVersion {
		t.Fatalf("reset must bump the credential version: %+v", reset.User)
	}
	revoked := decodeAdmin[struct {
		Revoked int64 `json:"revoked"`
	}](t, a.call(http.MethodPost, "/api/auth/admin/users/joyce_moore/sessions/revoke", ""))
	if revoked.Revoked != 0 {
		t.Fatalf("no sessions existed yet: %+v", revoked)
	}

	// the audit trail holds one row per mutation, newest first
	audit := decodeAdmin[adminAuditBody](t, a.call(http.MethodGet, "/api/auth/admin/audit?limit=20", ""))
	if len(audit.Entries) != 5 {
		t.Fatalf("audit rows = %d (%+v)", len(audit.Entries), audit.Entries)
	}
	if audit.Entries[0].Action != "session.revoke" || audit.Entries[0].Actor != "admin-api" {
		t.Fatalf("newest first expected: %+v", audit.Entries[0])
	}
	actions := map[string]int{}
	for _, entry := range audit.Entries {
		actions[entry.Action]++
		if entry.Target != "joyce_moore" {
			t.Fatalf("audit target = %q", entry.Target)
		}
	}
	for _, want := range []string{"user.create", "user.disable", "user.enable", "user.password", "session.revoke"} {
		if actions[want] != 1 {
			t.Fatalf("action %s recorded %d times (%+v)", want, actions[want], actions)
		}
	}
	if filtered := decodeAdmin[adminAuditBody](t, a.call(http.MethodGet, "/api/auth/admin/audit?action=user.disable", "")); len(filtered.Entries) != 1 {
		t.Fatalf("action filter = %+v", filtered)
	}

	// delete keeps the audit row that names the removed account
	if res := a.call(http.MethodDelete, "/api/auth/admin/users/joyce_moore?force=1", ""); res.status != http.StatusOK {
		t.Fatalf("delete: status=%d body=%s", res.status, res.body)
	}
	if res := a.call(http.MethodGet, "/api/auth/admin/users/joyce_moore", ""); res.status != http.StatusNotFound {
		t.Fatalf("deleted account still readable: status=%d", res.status)
	}
	after := decodeAdmin[adminAuditBody](t, a.call(http.MethodGet, "/api/auth/admin/audit?target=joyce_moore", ""))
	if len(after.Entries) != 6 || after.Entries[0].Action != "user.delete" {
		t.Fatalf("audit after delete = %+v", after.Entries)
	}
}

func TestAdminProtectsTheLastEnabledAccount(t *testing.T) {
	e := adminEnv(t)
	a := e.asAdmin(adminToken)
	a.call(http.MethodPost, "/api/auth/admin/users", `{"username":"only","password":"a long enough password"}`)

	// A guarded refusal must name the reason; an explicit force is the operator's
	// confirmation, exactly like `lab-auth user delete -force`.
	res := a.call(http.MethodDelete, "/api/auth/admin/users/only", "")
	if res.status != http.StatusConflict || errorCode(t, res) != "last_account" {
		t.Fatalf("status=%d code=%s body=%s", res.status, errorCode(t, res), res.body)
	}
	if forced := a.call(http.MethodDelete, "/api/auth/admin/users/only?force=true", ""); forced.status != http.StatusOK {
		t.Fatalf("force delete: status=%d body=%s", forced.status, forced.body)
	}
}

func TestAdminStatusReportsTheDatabase(t *testing.T) {
	e := adminEnv(t)
	e.createUser("joyce", "a long enough password")
	body := decodeAdmin[struct {
		Service struct {
			Version      string `json:"version"`
			AdminEnabled bool   `json:"adminEnabled"`
		} `json:"service"`
		Database struct {
			SchemaVersion int `json:"schemaVersion"`
			Users         int `json:"users"`
			Enabled       int `json:"enabled"`
		} `json:"database"`
	}](t, e.asAdmin(adminToken).call(http.MethodGet, "/api/auth/admin/status", ""))
	if !body.Service.AdminEnabled {
		t.Fatalf("admin not reported as enabled: %+v", body.Service)
	}
	if body.Database.Users != 1 || body.Database.Enabled != 1 {
		t.Fatalf("database counts = %+v", body.Database)
	}
	latest, err := store.LatestSchemaVersion()
	if err != nil {
		t.Fatal(err)
	}
	if body.Database.SchemaVersion != latest {
		t.Fatalf("schema version = %d, want %d", body.Database.SchemaVersion, latest)
	}
}

func TestAdminSessionsAndLegacyPrefix(t *testing.T) {
	e := adminEnv(t)
	e.createUser("joyce", "a long enough password")
	a := e.asAdmin(adminToken)

	// The legacy prefix serves the same contract; older bundles and nginx
	// fragments keep working during a release.
	legacy := a.call(http.MethodGet, "/lab/api/auth/admin/users", "")
	if legacy.status != http.StatusOK {
		t.Fatalf("legacy prefix: status=%d body=%s", legacy.status, legacy.body)
	}
	if decodeAdmin[adminListBody](t, legacy).Total != 1 {
		t.Fatalf("legacy list = %s", legacy.body)
	}
	// The public session endpoint moved with it, so a client on either path sees
	// the same account.
	for _, path := range []string{"/api/auth/session", "/lab/api/auth/session"} {
		res := a.call(http.MethodGet, path, "")
		if res.status != http.StatusOK || !strings.Contains(string(res.body), `"authenticated":false`) {
			t.Fatalf("%s: status=%d body=%s", path, res.status, res.body)
		}
	}
	sessions := decodeAdmin[struct {
		Sessions []struct {
			Username string `json:"username"`
			State    string `json:"state"`
		} `json:"sessions"`
	}](t, a.call(http.MethodGet, "/api/auth/admin/sessions", ""))
	if len(sessions.Sessions) != 0 {
		t.Fatalf("no sessions expected: %+v", sessions.Sessions)
	}
}
