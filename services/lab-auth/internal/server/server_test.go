package server_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/example-org/example-blog/services/lab-auth/internal/config"
	"github.com/example-org/example-blog/services/lab-auth/internal/password"
	"github.com/example-org/example-blog/services/lab-auth/internal/server"
	"github.com/example-org/example-blog/services/lab-auth/internal/store"
)

const (
	origin    = "https://test.example"
	password1 = "A very long password 1"
)

func lowArgon() password.Params {
	return password.Params{Memory: 8 * 1024, Iterations: 1, Parallelism: 1, SaltLength: 16, KeyLength: 32}
}

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}
func (c *clock) Unix() int64 { return c.Now().Unix() }
func (c *clock) Advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

type env struct {
	t     *testing.T
	ts    *httptest.Server
	store *store.Store
	clock *clock
	cfg   config.Config
}

func testConfig(db string) config.Config {
	return config.Config{
		Env:                config.Development,
		DBPath:             db,
		AllowedOrigins:     []string{origin},
		Argon:              lowArgon(),
		CSRFSecret:         bytes.Repeat([]byte{7}, 32),
		CookieSecure:       true,
		SessionIdle:        30 * time.Minute,
		SessionAbsolute:    12 * time.Hour,
		PendingTTL:         60 * time.Second,
		FlowTTL:            10 * time.Minute,
		CSRFTTL:            10 * time.Minute,
		ShutdownGrace:      time.Second,
		MaxBodyBytes:       4 << 10,
		HashConcurrency:    2,
		HashQueue:          8,
		SourceRatePerMin:   100000,
		SourceBurst:        3,
		UsernameRate:       100000,
		UsernameWindow:     15 * time.Minute,
		MaxAttemptsPerFlow: 4,
	}
}

func setup(t *testing.T) *env {
	return setupWith(t, nil)
}

func setupWith(t *testing.T, mutate func(*config.Config)) *env {
	t.Helper()
	clk := &clock{t: time.Unix(1_700_000_000, 0)}
	db := filepath.Join(t.TempDir(), "auth.db")
	st, err := store.Open(db, store.WithArgon(lowArgon()), store.WithClock(clk.Unix))
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Migrate(); err != nil {
		t.Fatal(err)
	}
	cfg := testConfig(db)
	if mutate != nil {
		mutate(&cfg)
	}
	srv, err := server.New(cfg, st, server.Options{InsecureCookies: true, Now: clk.Now})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { ts.Close(); st.Close() })
	return &env{t: t, ts: ts, store: st, clock: clk, cfg: cfg}
}

func (e *env) createUser(username, pw string) store.User {
	e.t.Helper()
	user, err := e.store.CreateUser(username, pw)
	if err != nil {
		e.t.Fatal(err)
	}
	return user
}

// client keeps cookies manually so Secure/__Host- handling does not depend on
// the standard cookie jar over plain http.
type client struct {
	t       *testing.T
	base    string
	http    *http.Client
	cookies map[string]string
}

func (e *env) client() *client {
	return &client{t: e.t, base: e.ts.URL, http: e.ts.Client(), cookies: map[string]string{}}
}

type response struct {
	status  int
	body    []byte
	headers http.Header
}

func (c *client) do(method, path, body string, headers map[string]string) response {
	c.t.Helper()
	req, err := http.NewRequest(method, c.base+path, strings.NewReader(body))
	if err != nil {
		c.t.Fatal(err)
	}
	req.Header.Set("Origin", origin)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	if len(c.cookies) > 0 {
		parts := make([]string, 0, len(c.cookies))
		for name, value := range c.cookies {
			parts = append(parts, name+"="+value)
		}
		req.Header.Set("Cookie", strings.Join(parts, "; "))
	}
	res, err := c.http.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	for _, sc := range res.Cookies() {
		if sc.MaxAge < 0 || sc.Value == "" {
			delete(c.cookies, sc.Name)
			continue
		}
		c.cookies[sc.Name] = sc.Value
	}
	data, _ := io.ReadAll(res.Body)
	return response{status: res.StatusCode, body: data, headers: res.Header}
}

func (c *client) json(method, path string, payload any, headers map[string]string) response {
	c.t.Helper()
	body := ""
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			c.t.Fatal(err)
		}
		body = string(raw)
	}
	return c.do(method, path, body, headers)
}

type csrfPayload struct {
	FlowID    string `json:"flowId"`
	AttemptID string `json:"attemptId"`
	CSRFToken string `json:"csrfToken"`
	ExpiresAt int64  `json:"expiresAt"`
}

type userPayload struct {
	ID       string `json:"id"`
	Username string `json:"username"`
}

type sessionPayload struct {
	Authenticated    bool         `json:"authenticated"`
	User             *userPayload `json:"user"`
	SessionExpiresAt int64        `json:"sessionExpiresAt"`
	CSRFToken        string       `json:"csrfToken"`
}

func (c *client) csrf() csrfPayload {
	c.t.Helper()
	res := c.json(http.MethodGet, "/lab/api/auth/csrf", nil, nil)
	if res.status != http.StatusOK {
		c.t.Fatalf("csrf status = %d body=%s", res.status, res.body)
	}
	var payload csrfPayload
	if err := json.Unmarshal(res.body, &payload); err != nil {
		c.t.Fatal(err)
	}
	return payload
}

func (c *client) login(csrf csrfPayload, username, pw string) response {
	return c.json(http.MethodPost, "/lab/api/auth/login",
		map[string]string{"attemptId": csrf.AttemptID, "username": username, "password": pw},
		map[string]string{"X-CSRF-Token": csrf.CSRFToken})
}

func (e *env) sessionOf(c *client) sessionPayload {
	e.t.Helper()
	res := c.json(http.MethodGet, "/lab/api/auth/session", nil, nil)
	var payload sessionPayload
	if err := json.Unmarshal(res.body, &payload); err != nil {
		e.t.Fatal(err)
	}
	return payload
}

func TestHappyPath(t *testing.T) {
	e := setup(t)
	e.createUser("JOYCE_MOORE", password1)
	c := e.client()
	csrf := c.csrf()

	if got := e.sessionOf(c); got.Authenticated {
		t.Fatal("fresh client must not be authenticated")
	}
	if res := c.login(csrf, "JOYCE_MOORE", "wrong password value"); res.status != http.StatusUnauthorized {
		t.Fatalf("wrong password status = %d body=%s", res.status, res.body)
	}
	if res := c.login(csrf, "JOYCE_MOORE", password1); res.status != http.StatusOK {
		t.Fatalf("login status = %d body=%s", res.status, res.body)
	}
	if got := e.sessionOf(c); got.Authenticated {
		t.Fatal("pending session must not report authenticated")
	}
	res := c.json(http.MethodPost, "/lab/api/auth/confirm", map[string]string{"attemptId": csrf.AttemptID},
		map[string]string{"X-CSRF-Token": csrf.CSRFToken})
	if res.status != http.StatusOK {
		t.Fatalf("confirm status = %d body=%s", res.status, res.body)
	}
	var confirmed struct {
		Authenticated bool         `json:"authenticated"`
		User          *userPayload `json:"user"`
		CSRFToken     string       `json:"csrfToken"`
	}
	if err := json.Unmarshal(res.body, &confirmed); err != nil {
		t.Fatal(err)
	}
	if !confirmed.Authenticated || confirmed.User == nil || confirmed.User.Username != "JOYCE_MOORE" {
		t.Fatalf("confirm payload = %s", res.body)
	}
	if len(confirmed.CSRFToken) == 0 {
		t.Fatal("confirm must return a session-bound csrf token")
	}

	active := e.sessionOf(c)
	if !active.Authenticated || active.User == nil || active.User.Username != "JOYCE_MOORE" {
		t.Fatalf("session = %+v", active)
	}

	// confirm must not Set-Cookie
	if len(res.headers.Values("Set-Cookie")) != 0 {
		t.Fatalf("confirm set cookies: %v", res.headers.Values("Set-Cookie"))
	}

	logout := c.json(http.MethodPost, "/lab/api/auth/logout", nil, map[string]string{"X-CSRF-Token": active.CSRFToken})
	if logout.status != http.StatusNoContent {
		t.Fatalf("logout status = %d body=%s", logout.status, logout.body)
	}
	if got := e.sessionOf(c); got.Authenticated {
		t.Fatal("session must be closed after logout")
	}
	// logout is idempotent
	if again := c.json(http.MethodPost, "/lab/api/auth/logout", nil, nil); again.status != http.StatusNoContent {
		t.Fatalf("second logout status = %d", again.status)
	}
}

func TestUnknownUserLooksLikeWrongPassword(t *testing.T) {
	e := setup(t)
	e.createUser("KnownUser", password1)
	c := e.client()
	csrf := c.csrf()
	unknown := c.login(csrf, "NoSuchUser", password1)
	csrf2 := c.csrf()
	wrong := c.login(csrf2, "KnownUser", "definitely wrong password")
	if unknown.status != wrong.status {
		t.Fatalf("status differs: unknown=%d wrong=%d", unknown.status, wrong.status)
	}
	// Compare the error payload only: each reply carries its own request id, which
	// is not something an attacker can use to tell the two cases apart.
	if payloadOf(t, unknown) != payloadOf(t, wrong) {
		t.Fatalf("body differs:\n%s\n%s", unknown.body, wrong.body)
	}
	if unknown.status != http.StatusUnauthorized {
		t.Fatalf("status = %d", unknown.status)
	}
}

func payloadOf(t *testing.T, res response) string {
	t.Helper()
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(res.body, &body); err != nil {
		t.Fatal(err)
	}
	return body.Error.Code + "|" + body.Error.Message
}

func TestOriginAndCSRFRejected(t *testing.T) {
	e := setup(t)
	e.createUser("JOYCE_MOORE", password1)
	c := e.client()
	csrf := c.csrf()
	// Wrong origin
	res := c.do(http.MethodPost, "/lab/api/auth/login",
		`{"attemptId":"`+csrf.AttemptID+`","username":"JOYCE_MOORE","password":"`+password1+`"}`,
		map[string]string{"Origin": "https://evil.example", "X-CSRF-Token": csrf.CSRFToken})
	if res.status != http.StatusForbidden {
		t.Fatalf("bad origin status = %d", res.status)
	}
	// Missing CSRF
	res = c.json(http.MethodPost, "/lab/api/auth/login",
		map[string]string{"attemptId": csrf.AttemptID, "username": "JOYCE_MOORE", "password": password1}, nil)
	if res.status != http.StatusForbidden {
		t.Fatalf("missing csrf status = %d", res.status)
	}
	// Wrong CSRF
	res = c.json(http.MethodPost, "/lab/api/auth/login",
		map[string]string{"attemptId": csrf.AttemptID, "username": "JOYCE_MOORE", "password": password1},
		map[string]string{"X-CSRF-Token": "not-the-token"})
	if res.status != http.StatusForbidden {
		t.Fatalf("bad csrf status = %d", res.status)
	}
}

func TestBodyTooLarge(t *testing.T) {
	e := setup(t)
	e.createUser("JOYCE_MOORE", password1)
	c := e.client()
	csrf := c.csrf()
	big := strings.Repeat("a", 5000)
	res := c.json(http.MethodPost, "/lab/api/auth/login",
		map[string]string{"attemptId": csrf.AttemptID, "username": "JOYCE_MOORE", "password": big},
		map[string]string{"X-CSRF-Token": csrf.CSRFToken})
	if res.status != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d body=%s", res.status, res.body)
	}
}

func TestCancelBeforeLoginBlocksAttempt(t *testing.T) {
	e := setup(t)
	e.createUser("JOYCE_MOORE", password1)
	c := e.client()
	csrf := c.csrf()
	res := c.json(http.MethodPost, "/lab/api/auth/cancel", map[string]string{"attemptId": csrf.AttemptID},
		map[string]string{"X-CSRF-Token": csrf.CSRFToken})
	if res.status != http.StatusNoContent {
		t.Fatalf("cancel status = %d", res.status)
	}
	if res := c.login(csrf, "JOYCE_MOORE", password1); res.status != http.StatusConflict {
		t.Fatalf("login after cancel status = %d body=%s", res.status, res.body)
	}
	// Idempotent cancel
	if res := c.json(http.MethodPost, "/lab/api/auth/cancel", map[string]string{"attemptId": csrf.AttemptID},
		map[string]string{"X-CSRF-Token": csrf.CSRFToken}); res.status != http.StatusNoContent {
		t.Fatalf("second cancel status = %d", res.status)
	}
}

func TestCancelAfterLoginRevokesSession(t *testing.T) {
	e := setup(t)
	e.createUser("JOYCE_MOORE", password1)
	c := e.client()
	csrf := c.csrf()
	if res := c.login(csrf, "JOYCE_MOORE", password1); res.status != http.StatusOK {
		t.Fatalf("login status = %d", res.status)
	}
	if res := c.json(http.MethodPost, "/lab/api/auth/cancel", map[string]string{"attemptId": csrf.AttemptID},
		map[string]string{"X-CSRF-Token": csrf.CSRFToken}); res.status != http.StatusNoContent {
		t.Fatalf("cancel status = %d", res.status)
	}
	if got := e.sessionOf(c); got.Authenticated {
		t.Fatal("cancelled session must not authenticate")
	}
	if res := c.json(http.MethodPost, "/lab/api/auth/confirm", map[string]string{"attemptId": csrf.AttemptID},
		map[string]string{"X-CSRF-Token": csrf.CSRFToken}); res.status == http.StatusOK {
		t.Fatal("confirm after cancel must not succeed")
	}
}

func TestConfirmThenCancelRevokesSession(t *testing.T) {
	e := setup(t)
	e.createUser("JOYCE_MOORE", password1)
	c := e.client()
	csrf := c.csrf()
	if res := c.login(csrf, "JOYCE_MOORE", password1); res.status != http.StatusOK {
		t.Fatal("login failed")
	}
	if res := c.json(http.MethodPost, "/lab/api/auth/confirm", map[string]string{"attemptId": csrf.AttemptID},
		map[string]string{"X-CSRF-Token": csrf.CSRFToken}); res.status != http.StatusOK {
		t.Fatal("confirm failed")
	}
	if got := e.sessionOf(c); !got.Authenticated {
		t.Fatal("session should be active")
	}
	if res := c.json(http.MethodPost, "/lab/api/auth/cancel", map[string]string{"attemptId": csrf.AttemptID},
		map[string]string{"X-CSRF-Token": csrf.CSRFToken}); res.status != http.StatusNoContent {
		t.Fatalf("cancel status = %d", res.status)
	}
	if got := e.sessionOf(c); got.Authenticated {
		t.Fatal("confirm-then-cancel must revoke the session")
	}
}

func TestDisableAndResetBlockConfirm(t *testing.T) {
	e := setup(t)
	e.createUser("JOYCE_MOORE", password1)

	// disable between login and confirm
	c := e.client()
	csrf := c.csrf()
	if res := c.login(csrf, "JOYCE_MOORE", password1); res.status != http.StatusOK {
		t.Fatal("login failed")
	}
	if err := e.store.SetEnabled("JOYCE_MOORE", false); err != nil {
		t.Fatal(err)
	}
	if res := c.json(http.MethodPost, "/lab/api/auth/confirm", map[string]string{"attemptId": csrf.AttemptID},
		map[string]string{"X-CSRF-Token": csrf.CSRFToken}); res.status == http.StatusOK {
		t.Fatal("confirm must fail for a disabled account")
	}

	// reset between login and confirm
	if err := e.store.SetEnabled("JOYCE_MOORE", true); err != nil {
		t.Fatal(err)
	}
	c2 := e.client()
	csrf2 := c2.csrf()
	if res := c2.login(csrf2, "JOYCE_MOORE", password1); res.status != http.StatusOK {
		t.Fatal("login failed")
	}
	if err := e.store.ResetPassword("JOYCE_MOORE", "A brand new long password 1"); err != nil {
		t.Fatal(err)
	}
	if res := c2.json(http.MethodPost, "/lab/api/auth/confirm", map[string]string{"attemptId": csrf2.AttemptID},
		map[string]string{"X-CSRF-Token": csrf2.CSRFToken}); res.status == http.StatusOK {
		t.Fatal("confirm must fail after a password reset")
	}
	// old password must no longer work
	csrf3 := c2.csrf()
	if res := c2.login(csrf3, "JOYCE_MOORE", password1); res.status != http.StatusUnauthorized {
		t.Fatalf("old password status = %d", res.status)
	}
}

func TestPendingExpiry(t *testing.T) {
	e := setup(t)
	e.createUser("JOYCE_MOORE", password1)
	c := e.client()
	csrf := c.csrf()
	if res := c.login(csrf, "JOYCE_MOORE", password1); res.status != http.StatusOK {
		t.Fatal("login failed")
	}
	e.clock.Advance(61 * time.Second)
	if res := c.json(http.MethodPost, "/lab/api/auth/confirm", map[string]string{"attemptId": csrf.AttemptID},
		map[string]string{"X-CSRF-Token": csrf.CSRFToken}); res.status == http.StatusOK {
		t.Fatal("confirm must fail after pending expiry")
	}
}

func TestMaxAttemptsPerFlow(t *testing.T) {
	e := setup(t)
	c := e.client()
	for i := 0; i < 4; i++ {
		if res := c.json(http.MethodGet, "/lab/api/auth/csrf", nil, nil); res.status != http.StatusOK {
			t.Fatalf("csrf %d status = %d", i, res.status)
		}
	}
	if res := c.json(http.MethodGet, "/lab/api/auth/csrf", nil, nil); res.status != http.StatusTooManyRequests {
		t.Fatalf("fifth attempt status = %d", res.status)
	}
}

func TestSourceRateLimit(t *testing.T) {
	e := setup(t)
	cfg := e.cfg
	cfg.SourceRatePerMin = 1
	db := filepath.Join(t.TempDir(), "rl.db")
	st, err := store.Open(db, store.WithArgon(lowArgon()))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.Migrate(); err != nil {
		t.Fatal(err)
	}
	srv, err := server.New(cfg, st, server.Options{InsecureCookies: true, Now: e.clock.Now})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	cl := &client{t: t, base: ts.URL, http: ts.Client(), cookies: map[string]string{}}
	last := http.StatusOK
	for i := 0; i < 4; i++ {
		last = cl.json(http.MethodGet, "/lab/api/auth/csrf", nil, nil).status
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("expected rate limit, got %d", last)
	}
}

// directRequest drives the handler in-process so the test can choose the
// RemoteAddr that net/http reports for an unix-socket peer (empty). That is the
// production topology: nginx talks to the service over a unix socket.
func directRequest(t *testing.T, handler http.Handler, remoteAddr string, headers map[string]string) int {
	return directCall(t, handler, http.MethodGet, "/lab/api/auth/csrf", remoteAddr, headers)
}

func directCall(t *testing.T, handler http.Handler, method, path, remoteAddr string, headers map[string]string) int {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	req.RemoteAddr = remoteAddr
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec.Code
}

// TestSessionReadIsRateLimited: every page load asks for the session, and a live
// session also refreshes its idle deadline, so an anonymous caller must not be
// able to drive that write path without bound.
func TestSessionReadIsRateLimited(t *testing.T) {
	handler := handlerWithoutSockets(t, func(cfg *config.Config) { cfg.SourceRatePerMin = 1 })
	const path = "/lab/api/auth/session"
	for i := 0; i < 6; i++ {
		if code := directCall(t, handler, http.MethodGet, path, "", map[string]string{"X-Real-IP": "198.51.100.1"}); code != http.StatusOK {
			t.Fatalf("session read %d = %d, want 200", i+1, code)
		}
	}
	if code := directCall(t, handler, http.MethodGet, path, "", map[string]string{"X-Real-IP": "198.51.100.1"}); code != http.StatusTooManyRequests {
		t.Fatalf("seventh session read = %d, want 429", code)
	}
	if code := directCall(t, handler, http.MethodGet, path, "", map[string]string{"X-Real-IP": "198.51.100.2"}); code != http.StatusOK {
		t.Fatalf("another client shares the bucket: got %d, want 200", code)
	}
}

// handlerWithoutSockets builds a server directly instead of going through
// httptest.NewServer: the rate-limit key depends on the peer address, so these
// tests must control RemoteAddr themselves — and a listening socket is not
// available in every environment the suite runs in.
func handlerWithoutSockets(t *testing.T, mutate func(*config.Config)) http.Handler {
	t.Helper()
	db := filepath.Join(t.TempDir(), "rl.db")
	st, err := store.Open(db, store.WithArgon(lowArgon()))
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Migrate(); err != nil {
		st.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	cfg := testConfig(db)
	if mutate != nil {
		mutate(&cfg)
	}
	srv, err := server.New(cfg, st, server.Options{InsecureCookies: true})
	if err != nil {
		t.Fatal(err)
	}
	return srv.Handler()
}

// TestSourceLimitIsPerClientBehindLocalProxy covers the production topology: the
// immediate peer is nginx, so the client address has to come from the configured
// header. Before this, the peer check only recognised loopback, every request
// behind the unix socket collapsed into one bucket, and a single caller could
// exhaust the whole site's login budget.
func TestSourceLimitIsPerClientBehindLocalProxy(t *testing.T) {
	for _, peer := range []string{"", "127.0.0.1:41234"} {
		t.Run("peer="+peer, func(t *testing.T) {
			handler := handlerWithoutSockets(t, func(cfg *config.Config) { cfg.SourceRatePerMin = 1 })
			// /csrf allows SourceRatePerMin*3 requests per window and key.
			for i := 0; i < 3; i++ {
				if code := directRequest(t, handler, peer, map[string]string{"X-Real-IP": "198.51.100.1"}); code != http.StatusOK {
					t.Fatalf("request %d for client A = %d, want 200", i+1, code)
				}
			}
			if code := directRequest(t, handler, peer, map[string]string{"X-Real-IP": "198.51.100.1"}); code != http.StatusTooManyRequests {
				t.Fatalf("fourth request for client A = %d, want 429", code)
			}
			if code := directRequest(t, handler, peer, map[string]string{"X-Real-IP": "198.51.100.2"}); code != http.StatusOK {
				t.Fatalf("client B shares client A's bucket: got %d, want 200", code)
			}
		})
	}
}

// TestSourceLimitIgnoresForwardedHeaderFromRemotePeer ensures a direct client can
// never pick its own bucket: the header is only read from the local proxy, so a
// remote peer keeps using its peer address even while spoofing X-Real-IP.
func TestSourceLimitIgnoresForwardedHeaderFromRemotePeer(t *testing.T) {
	handler := handlerWithoutSockets(t, func(cfg *config.Config) { cfg.SourceRatePerMin = 1 })
	addresses := []string{"198.51.100.1", "198.51.100.2", "198.51.100.3"}
	for i, address := range addresses {
		if code := directRequest(t, handler, "203.0.113.9:5555", map[string]string{"X-Real-IP": address}); code != http.StatusOK {
			t.Fatalf("spoofed request %d = %d, want 200", i+1, code)
		}
	}
	if code := directRequest(t, handler, "203.0.113.9:5555", map[string]string{"X-Real-IP": "198.51.100.4"}); code != http.StatusTooManyRequests {
		t.Fatalf("spoofing the header minted a fresh bucket: got %d, want 429", code)
	}
}

// TestSourceLimitUsesTheRightmostForwardedEntry pins the X-Forwarded-For rule:
// our proxy appends the address it saw, so only the right-most entry may be
// trusted. A left-most (client-supplied) value must not create a new bucket.
func TestSourceLimitUsesTheRightmostForwardedEntry(t *testing.T) {
	handler := handlerWithoutSockets(t, func(cfg *config.Config) {
		cfg.SourceRatePerMin = 1
		cfg.ProxyHeader = config.ProxyHeaderForwardedFor
	})
	spoof := map[string]string{"X-Forwarded-For": "1.2.3.4, 198.51.100.9"}
	otherSpoof := map[string]string{"X-Forwarded-For": "5.6.7.8, 198.51.100.9"}
	for i := 0; i < 3; i++ {
		if code := directRequest(t, handler, "", spoof); code != http.StatusOK {
			t.Fatalf("request %d = %d, want 200", i+1, code)
		}
	}
	if code := directRequest(t, handler, "", otherSpoof); code != http.StatusTooManyRequests {
		t.Fatalf("left-most entry was trusted: got %d, want 429", code)
	}
	other := map[string]string{"X-Forwarded-For": "1.2.3.4, 198.51.100.10"}
	if code := directRequest(t, handler, "", other); code != http.StatusOK {
		t.Fatalf("new right-most entry did not get its own bucket: got %d, want 200", code)
	}
}

// TestSourceLimitFallsBackToThePeerBucket covers the cases that must all land in
// one bucket rather than handing a caller a fresh key per request: the feature is
// switched off, the header is absent, or its value is not a bare IP literal.
func TestSourceLimitFallsBackToThePeerBucket(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(*config.Config)
		headers []map[string]string
	}{
		{
			name:   "off",
			mutate: func(cfg *config.Config) { cfg.SourceRatePerMin = 1; cfg.ProxyHeader = config.ProxyHeaderOff },
			headers: []map[string]string{
				{"X-Real-IP": "198.51.100.1"},
				{"X-Real-IP": "198.51.100.2"},
				{"X-Real-IP": "198.51.100.3"},
				{"X-Real-IP": "198.51.100.4"},
			},
		},
		{
			name:   "header missing",
			mutate: func(cfg *config.Config) { cfg.SourceRatePerMin = 1 },
			headers: []map[string]string{
				{}, {}, {}, {},
			},
		},
		{
			name:   "malformed values",
			mutate: func(cfg *config.Config) { cfg.SourceRatePerMin = 1 },
			headers: []map[string]string{
				{"X-Real-IP": "not-an-ip"},
				{"X-Real-IP": "198.51.100.1:443"},
				{"X-Real-IP": "300.1.2.3"},
				{"X-Real-IP": "  "},
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			handler := handlerWithoutSockets(t, tc.mutate)
			for i, headers := range tc.headers {
				code := directRequest(t, handler, "", headers)
				want := http.StatusOK
				if i == len(tc.headers)-1 {
					want = http.StatusTooManyRequests
				}
				if code != want {
					t.Fatalf("request %d = %d, want %d", i+1, code, want)
				}
			}
		})
	}
}

func TestNoStoreHeader(t *testing.T) {
	e := setup(t)
	c := e.client()
	res := c.json(http.MethodGet, "/lab/api/auth/session", nil, nil)
	if got := res.headers.Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
}

// TestConcurrentLoginSingleWinner ensures a reused attempt cannot authenticate
// twice under the race detector.
func TestConcurrentLoginSingleWinner(t *testing.T) {
	e := setup(t)
	e.createUser("JOYCE_MOORE", password1)
	seed := e.client()
	csrf := seed.csrf()

	const workers = 8
	var wg sync.WaitGroup
	statuses := make([]int, workers)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			c := e.client()
			c.cookies = map[string]string{}
			for name, value := range seed.cookies {
				c.cookies[name] = value
			}
			statuses[i] = c.login(csrf, "JOYCE_MOORE", password1).status
		}(i)
	}
	wg.Wait()
	okCount := 0
	for _, status := range statuses {
		if status == http.StatusOK {
			okCount++
		}
	}
	if okCount != 1 {
		t.Fatalf("expected exactly one successful login, got %d (%v)", okCount, statuses)
	}
}

// TestConcurrentConfirmAndCancel checks both transaction orders leave a
// consistent outcome: either the session is active (confirm won) or revoked
// (cancel won), never both.
func TestConcurrentConfirmAndCancel(t *testing.T) {
	for i := 0; i < 10; i++ {
		e := setup(t)
		e.createUser("JOYCE_MOORE", password1)
		c := e.client()
		csrf := c.csrf()
		if res := c.login(csrf, "JOYCE_MOORE", password1); res.status != http.StatusOK {
			t.Fatal("login failed")
		}
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			c.json(http.MethodPost, "/lab/api/auth/confirm", map[string]string{"attemptId": csrf.AttemptID},
				map[string]string{"X-CSRF-Token": csrf.CSRFToken})
		}()
		go func() {
			defer wg.Done()
			c.json(http.MethodPost, "/lab/api/auth/cancel", map[string]string{"attemptId": csrf.AttemptID},
				map[string]string{"X-CSRF-Token": csrf.CSRFToken})
		}()
		wg.Wait()
		// The session must never be active after a cancel that observed pending
		// state; whatever the interleaving, the store must be self-consistent.
		attempt, err := e.store.GetAttempt(csrf.AttemptID)
		if err != nil {
			t.Fatal(err)
		}
		if attempt.State != "confirmed" && attempt.State != "cancelled" {
			t.Fatalf("unexpected attempt state %q", attempt.State)
		}
	}
}

func TestHealth(t *testing.T) {
	e := setup(t)
	c := e.client()
	if res := c.do(http.MethodGet, "/health/live", "", nil); res.status != http.StatusOK {
		t.Fatalf("live status = %d", res.status)
	}
	if res := c.do(http.MethodGet, "/health/ready", "", nil); res.status != http.StatusOK {
		t.Fatalf("ready status = %d", res.status)
	}
}

// TestConfirmAndCancelAreBoundToTheFlow: knowing (or guessing) an attempt id must
// not let another flow confirm or cancel it. The attempt belongs to the flow that
// opened it, and the owner can still finish its own login afterwards.
func TestConfirmAndCancelAreBoundToTheFlow(t *testing.T) {
	e := setup(t)
	e.createUser("JOYCE_MOORE", password1)
	owner := e.client()
	ownerCSRF := owner.csrf()
	if res := owner.login(ownerCSRF, "JOYCE_MOORE", password1); res.status != http.StatusOK {
		t.Fatalf("owner login = %d body=%s", res.status, res.body)
	}

	other := e.client()
	otherCSRF := other.csrf()
	res := other.json(http.MethodPost, "/lab/api/auth/confirm",
		map[string]string{"attemptId": ownerCSRF.AttemptID},
		map[string]string{"X-CSRF-Token": otherCSRF.CSRFToken})
	if res.status != http.StatusUnauthorized {
		t.Fatalf("confirm from another flow = %d body=%s", res.status, res.body)
	}
	if res := other.json(http.MethodPost, "/lab/api/auth/cancel",
		map[string]string{"attemptId": ownerCSRF.AttemptID},
		map[string]string{"X-CSRF-Token": otherCSRF.CSRFToken}); res.status != http.StatusNoContent {
		t.Fatalf("cancel from another flow = %d body=%s", res.status, res.body)
	}
	if res := owner.json(http.MethodPost, "/lab/api/auth/confirm",
		map[string]string{"attemptId": ownerCSRF.AttemptID},
		map[string]string{"X-CSRF-Token": ownerCSRF.CSRFToken}); res.status != http.StatusOK {
		t.Fatalf("owner confirm after a foreign cancel = %d body=%s", res.status, res.body)
	}
}

// TestErrorBodyCarriesTheRequestID keeps the documented error shape honest: the
// id in the body has to match the X-Request-Id header operators grep for.
func TestErrorBodyCarriesTheRequestID(t *testing.T) {
	e := setup(t)
	e.createUser("JOYCE_MOORE", password1)
	c := e.client()
	res := c.login(c.csrf(), "JOYCE_MOORE", "definitely not the password")
	if res.status != http.StatusUnauthorized {
		t.Fatalf("status = %d body=%s", res.status, res.body)
	}
	var body struct {
		RequestID string `json:"requestId"`
	}
	if err := json.Unmarshal(res.body, &body); err != nil {
		t.Fatal(err)
	}
	if header := res.headers.Get("X-Request-Id"); header == "" || body.RequestID != header {
		t.Fatalf("body requestId = %q, header = %q", body.RequestID, header)
	}
}

// TestLoginUpgradesAStalePasswordHash wires NeedsRehash into the login path: a
// stored hash that is weaker than the configured parameters is rewritten as soon
// as it verifies, so raising the Argon2 work factor actually takes effect.
func TestLoginUpgradesAStalePasswordHash(t *testing.T) {
	stronger := lowArgon()
	stronger.Iterations = 2
	e := setupWith(t, func(cfg *config.Config) { cfg.Argon = stronger })
	e.createUser("JOYCE_MOORE", password1)
	if _, phc, err := e.store.GetUserByKey("JOYCE_MOORE"); err != nil {
		t.Fatal(err)
	} else if !password.NeedsRehash(phc, stronger) {
		t.Fatalf("fixture hash already at the target parameters: %s", phc)
	}
	c := e.client()
	csrf := c.csrf()
	if res := c.login(csrf, "JOYCE_MOORE", password1); res.status != http.StatusOK {
		t.Fatalf("login = %d body=%s", res.status, res.body)
	}
	_, phc, err := e.store.GetUserByKey("JOYCE_MOORE")
	if err != nil {
		t.Fatal(err)
	}
	if password.NeedsRehash(phc, stronger) {
		t.Fatalf("hash was not upgraded: %s", phc)
	}
	// The upgrade must not bump the credential version, or the pending session
	// created by this very login would be rejected when it is confirmed.
	if res := c.json(http.MethodPost, "/lab/api/auth/confirm",
		map[string]string{"attemptId": csrf.AttemptID},
		map[string]string{"X-CSRF-Token": csrf.CSRFToken}); res.status != http.StatusOK {
		t.Fatalf("confirm after rehash = %d body=%s", res.status, res.body)
	}
	if got := e.sessionOf(c); !got.Authenticated {
		t.Fatalf("session not established after rehash: %+v", got)
	}
}
