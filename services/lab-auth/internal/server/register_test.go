package server_test

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/example-org/example-blog/services/lab-auth/internal/config"
	"github.com/example-org/example-blog/services/lab-auth/internal/store"
)

func registerEnv(t *testing.T, mutate func(*config.Config)) *env {
	t.Helper()
	return setupWith(t, func(cfg *config.Config) {
		cfg.RegistrationEnabled = true
		if mutate != nil {
			mutate(cfg)
		}
	})
}

func (e *env) register(c *client, csrf csrfPayload, username, pw string) response {
	e.t.Helper()
	return c.json(http.MethodPost, "/lab/api/auth/register",
		map[string]string{"username": username, "password": pw},
		map[string]string{"X-CSRF-Token": csrf.CSRFToken})
}

func errorCode(t *testing.T, res response) string {
	t.Helper()
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(res.body, &body); err != nil {
		t.Fatalf("bad error body %s", res.body)
	}
	return body.Error.Code
}

func TestRegisterDisabledByDefault(t *testing.T) {
	e := setup(t)
	c := e.client()
	csrf := c.csrf()
	res := e.register(c, csrf, "NewUser01", password1)
	if res.status != http.StatusServiceUnavailable || errorCode(t, res) != "registration_disabled" {
		t.Fatalf("status=%d body=%s", res.status, res.body)
	}
}

func TestRegisterCreatesAccountWithoutSession(t *testing.T) {
	e := registerEnv(t, nil)
	c := e.client()
	csrf := c.csrf()
	res := e.register(c, csrf, "NewUser01", password1)
	if res.status != http.StatusCreated {
		t.Fatalf("status=%d body=%s", res.status, res.body)
	}
	if len(res.headers.Values("Set-Cookie")) != 0 {
		t.Fatalf("register must not set cookies: %v", res.headers.Values("Set-Cookie"))
	}
	var payload struct {
		Registered bool `json:"registered"`
		User       struct {
			ID       string `json:"id"`
			Username string `json:"username"`
		} `json:"user"`
	}
	if err := json.Unmarshal(res.body, &payload); err != nil {
		t.Fatal(err)
	}
	if !payload.Registered || payload.User.Username != "NewUser01" || payload.User.ID == "" {
		t.Fatalf("payload=%s", res.body)
	}
	if e.sessionOf(c).Authenticated {
		t.Fatal("register must not authenticate the caller")
	}
	// The new account can complete the normal login -> confirm flow.
	if res := c.login(csrf, "newuser01", password1); res.status != http.StatusOK {
		t.Fatalf("login status=%d body=%s", res.status, res.body)
	}
	confirm := c.json(http.MethodPost, "/lab/api/auth/confirm",
		map[string]string{"attemptId": csrf.AttemptID},
		map[string]string{"X-CSRF-Token": csrf.CSRFToken})
	if confirm.status != http.StatusOK {
		t.Fatalf("confirm status=%d body=%s", confirm.status, confirm.body)
	}
}

func TestRegisterDuplicateKeepsExistingPassword(t *testing.T) {
	e := registerEnv(t, nil)
	e.createUser("JOYCE_MOORE", password1)
	c := e.client()
	csrf := c.csrf()
	// Same account, different case: usernameKey lower-cases, so this is the
	// duplicate case the contract talks about. "joycemoore" would be a different
	// account (separators are significant), which is what the earlier version of
	// this test got wrong.
	res := e.register(c, csrf, "joyce_moore", "another long password")
	if res.status != http.StatusConflict || errorCode(t, res) != "registration_unavailable" {
		t.Fatalf("status=%d body=%s", res.status, res.body)
	}
	user, _, err := e.store.GetUserByKey("JOYCE_MOORE")
	if err != nil {
		t.Fatal(err)
	}
	if user.Username != "JOYCE_MOORE" {
		t.Fatalf("existing account changed: %+v", user)
	}
	if res := c.login(csrf, "JOYCE_MOORE", password1); res.status != http.StatusOK {
		t.Fatalf("existing password no longer works: status=%d", res.status)
	}
}

func TestRegisterRulesAndErrors(t *testing.T) {
	e := registerEnv(t, nil)
	c := e.client()
	csrf := c.csrf()
	if res := e.register(c, csrf, "guest", password1); res.status != http.StatusConflict || errorCode(t, res) != "registration_unavailable" {
		t.Fatalf("reserved: status=%d body=%s", res.status, res.body)
	}
	if res := e.register(c, csrf, "ab", password1); res.status != http.StatusBadRequest || errorCode(t, res) != "bad_request" {
		t.Fatalf("short username: status=%d body=%s", res.status, res.body)
	}
	if res := e.register(c, csrf, "NewUser02", "short"); res.status != http.StatusBadRequest || errorCode(t, res) != "bad_request" {
		t.Fatalf("short password: status=%d body=%s", res.status, res.body)
	}
	// Missing CSRF token is rejected before any body work.
	res := c.json(http.MethodPost, "/lab/api/auth/register",
		map[string]string{"username": "NewUser03", "password": password1}, nil)
	if res.status != http.StatusForbidden || errorCode(t, res) != "csrf_rejected" {
		t.Fatalf("csrf: status=%d body=%s", res.status, res.body)
	}
}

func TestRegisterRejectsOversizedBody(t *testing.T) {
	e := registerEnv(t, nil)
	c := e.client()
	csrf := c.csrf()
	res := e.register(c, csrf, strings.Repeat("a", 5000), password1)
	if res.status != http.StatusRequestEntityTooLarge || errorCode(t, res) != "payload_too_large" {
		t.Fatalf("status=%d body=%s", res.status, res.body)
	}
}

func TestRegisterSourceQuota(t *testing.T) {
	e := registerEnv(t, func(cfg *config.Config) { cfg.RegisterSourceHourly = 1 })
	c := e.client()
	csrf := c.csrf()
	if res := e.register(c, csrf, "QuotaUser01", password1); res.status != http.StatusCreated {
		t.Fatalf("first status=%d body=%s", res.status, res.body)
	}
	res := e.register(c, csrf, "QuotaUser02", password1)
	if res.status != http.StatusTooManyRequests || errorCode(t, res) != "rate_limited" {
		t.Fatalf("second status=%d body=%s", res.status, res.body)
	}
	if res.headers.Get("Retry-After") == "" {
		t.Fatal("quota response must include Retry-After")
	}
	// The persistent counter survives: no account was created for the rejected name.
	if _, _, err := e.store.GetUserByKey("quotauser02"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("rejected registration must not create a user: %v", err)
	}
}

func TestRegisterGlobalQuota(t *testing.T) {
	e := registerEnv(t, func(cfg *config.Config) { cfg.RegisterGlobalDaily = 1 })
	first := e.client()
	second := e.client()
	if res := e.register(first, first.csrf(), "GlobalUser01", password1); res.status != http.StatusCreated {
		t.Fatalf("first status=%d body=%s", res.status, res.body)
	}
	res := e.register(second, second.csrf(), "GlobalUser02", password1)
	if res.status != http.StatusTooManyRequests || errorCode(t, res) != "rate_limited" {
		t.Fatalf("second status=%d body=%s", res.status, res.body)
	}
}

func TestRegisterUserCap(t *testing.T) {
	e := registerEnv(t, func(cfg *config.Config) { cfg.RegisterMaxUsers = 1 })
	e.createUser("Existing", password1)
	c := e.client()
	res := e.register(c, c.csrf(), "OverCap", password1)
	if res.status != http.StatusServiceUnavailable || errorCode(t, res) != "unavailable" {
		t.Fatalf("status=%d body=%s", res.status, res.body)
	}
}

func TestRegisterConcurrentSameUsername(t *testing.T) {
	e := registerEnv(t, nil)
	statuses := make([]int, 2)
	var wg sync.WaitGroup
	for i := range statuses {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			c := e.client()
			csrf := c.csrf()
			statuses[i] = e.register(c, csrf, "RaceUser0", password1).status
		}(i)
	}
	wg.Wait()
	created, conflicts := 0, 0
	for _, status := range statuses {
		switch status {
		case http.StatusCreated:
			created++
		case http.StatusConflict:
			conflicts++
		}
	}
	if created != 1 || conflicts != 1 {
		t.Fatalf("statuses=%v", statuses)
	}
	users, err := e.store.ListUsers()
	if err != nil {
		t.Fatal(err)
	}
	matching := 0
	for _, u := range users {
		if u.UsernameKey == "raceuser0" {
			matching++
		}
	}
	if matching != 1 {
		t.Fatalf("expected exactly one account, got %d", matching)
	}
}
