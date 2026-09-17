// Package server implements the /lab/api/auth/ HTTP contract from G1.
package server

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/example-org/example-blog/services/lab-auth/internal/config"
	"github.com/example-org/example-blog/services/lab-auth/internal/password"
	"github.com/example-org/example-blog/services/lab-auth/internal/ratelimit"
	"github.com/example-org/example-blog/services/lab-auth/internal/store"
)

const (
	flowCookie    = "__Host-lab-flow"
	sessionCookie = "__Host-lab-session"
)

type Options struct {
	InsecureCookies bool
	Now             func() time.Time
	MaxBuckets      int
	Logger          *slog.Logger
}

type Server struct {
	cfg      config.Config
	st       *store.Store
	now      func() time.Time
	insecure bool
	logger   *slog.Logger
	mux      *http.ServeMux

	hashes         hashPool
	registerHashes hashPool
	source         *ratelimit.Limiter
	registerSource *ratelimit.Limiter
	username       *ratelimit.Limiter
}

type hashPool struct {
	slots    chan struct{}
	waiting  atomic.Int64
	maxQueue int64
}

func newHashPool(concurrency, queue int) hashPool {
	if concurrency < 1 {
		concurrency = 1
	}
	return hashPool{slots: make(chan struct{}, concurrency), maxQueue: int64(queue)}
}

func (p *hashPool) acquire(ctx context.Context) (func(), error) {
	if p.waiting.Add(1) > p.maxQueue {
		p.waiting.Add(-1)
		return nil, errHashBusy
	}
	defer p.waiting.Add(-1)
	select {
	case p.slots <- struct{}{}:
		return func() { <-p.slots }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

var errHashBusy = errors.New("server: hash queue full")

func New(cfg config.Config, st *store.Store, opts Options) (*Server, error) {
	if len(cfg.CSRFSecret) < 16 {
		return nil, errors.New("server: csrf secret missing")
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	maxBuckets := opts.MaxBuckets
	if maxBuckets < 1 {
		maxBuckets = 4096
	}
	// Zero values only occur when a caller builds Config directly (tests); the
	// loaded configuration already validates positive bounds.
	if cfg.RegisterSourceHourly < 1 {
		cfg.RegisterSourceHourly = 10
	}
	if cfg.RegisterGlobalDaily < 1 {
		cfg.RegisterGlobalDaily = 200
	}
	if cfg.RegisterMaxUsers < 1 {
		cfg.RegisterMaxUsers = 5000
	}
	s := &Server{
		cfg:            cfg,
		st:             st,
		now:            now,
		insecure:       opts.InsecureCookies,
		logger:         logger,
		mux:            http.NewServeMux(),
		hashes:         newHashPool(cfg.HashConcurrency, cfg.HashQueue),
		registerHashes: newHashPool(1, 2),
		source:         ratelimit.New(maxBuckets, now),
		registerSource: ratelimit.New(maxBuckets, now),
		username:       ratelimit.New(maxBuckets, now),
	}
	s.routes()
	return s, nil
}

func (s *Server) routes() {
	s.mux.HandleFunc("GET /lab/api/auth/csrf", s.handleCSRF)
	s.mux.HandleFunc("POST /lab/api/auth/register", s.handleRegister)
	s.mux.HandleFunc("POST /lab/api/auth/login", s.handleLogin)
	s.mux.HandleFunc("POST /lab/api/auth/confirm", s.handleConfirm)
	s.mux.HandleFunc("GET /lab/api/auth/session", s.handleSession)
	s.mux.HandleFunc("POST /lab/api/auth/cancel", s.handleCancel)
	s.mux.HandleFunc("POST /lab/api/auth/logout", s.handleLogout)
	s.mux.HandleFunc("GET /health/live", s.handleLive)
	s.mux.HandleFunc("GET /health/ready", s.handleReady)
}

func (s *Server) Handler() http.Handler {
	var h http.Handler = s.mux
	h = s.withRecover(h)
	h = s.withRequestID(h)
	h = s.withNoStore(h)
	h = s.withLogging(h)
	return h
}

// Cleanup expires attempts/flows and rate-limit buckets. Call periodically.
func (s *Server) Cleanup() {
	now := s.nowUnix()
	if err := s.st.Cleanup(now); err != nil {
		s.logger.Warn("cleanup failed", "error", err.Error())
	}
	s.source.Cleanup(time.Minute)
	s.registerSource.Cleanup(time.Hour)
	s.username.Cleanup(s.cfg.UsernameWindow)
}

// --- middleware ---

type ctxKey int

const requestIDKey ctxKey = 1

func (s *Server) withRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, 8)
		rand.Read(buf)
		id := hex.EncodeToString(buf)
		w.Header().Set("X-Request-Id", id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey, id)))
	})
}

func requestID(r *http.Request) string {
	if id, ok := r.Context().Value(requestIDKey).(string); ok {
		return id
	}
	return ""
}

func (s *Server) withNoStore(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func (s *Server) withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := s.now()
		sw := &statusWriter{ResponseWriter: w, status: 200}
		next.ServeHTTP(sw, r)
		s.logger.Info("request",
			"request_id", requestID(r),
			"method", r.Method,
			"path", r.URL.Path,
			"status", sw.status,
			"duration_ms", s.now().Sub(start).Milliseconds(),
		)
	})
}

func (s *Server) withRecover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				s.logger.Error("panic", "request_id", requestID(r), "path", r.URL.Path)
				writeError(w, http.StatusServiceUnavailable, "unavailable", "服务暂不可用")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// --- helpers ---

func (s *Server) nowUnix() int64 { return s.now().Unix() }

func seconds(d time.Duration) int64 { return int64(d / time.Second) }

func (s *Server) secure() bool { return s.cfg.CookieSecure && !s.insecure }

func (s *Server) setCookie(w http.ResponseWriter, name, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   s.secure(),
		SameSite: http.SameSiteLaxMode,
	})
}

func (s *Server) clearCookie(w http.ResponseWriter, name string) {
	http.SetCookie(w, &http.Cookie{
		Name: name, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: s.secure(), SameSite: http.SameSiteLaxMode,
	})
}

func cookieValue(r *http.Request, name string) string {
	c, err := r.Cookie(name)
	if err != nil {
		return ""
	}
	return c.Value
}

func (s *Server) deriveCSRF(scope, id string) string {
	mac := hmac.New(sha256.New, s.cfg.CSRFSecret)
	mac.Write([]byte(scope))
	mac.Write([]byte(":"))
	mac.Write([]byte(id))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func hashEquals(token, storedHash string) bool {
	got := store.HashToken(token)
	return subtle.ConstantTimeCompare([]byte(got), []byte(storedHash)) == 1
}

var (
	errForbidden = errors.New("forbidden")
	errBadBody   = errors.New("bad body")
	errTooLarge  = errors.New("too large")
)

func (s *Server) checkOrigin(r *http.Request) error {
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "same-site" && site != "none" {
		return errForbidden
	}
	if len(s.cfg.AllowedOrigins) == 0 {
		return nil
	}
	origin := r.Header.Get("Origin")
	for _, allowed := range s.cfg.AllowedOrigins {
		if origin != "" && origin == allowed {
			return nil
		}
	}
	return errForbidden
}

// sourceKey derives the rate-limit identity. X-Forwarded-For is only trusted
// when the immediate peer is the loopback reverse proxy.
func sourceKey(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if host == "127.0.0.1" || host == "::1" || host == "localhost" {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			if first := strings.TrimSpace(strings.Split(xff, ",")[0]); first != "" {
				return first
			}
		}
	}
	return host
}

func (s *Server) allowSource(r *http.Request, limit int) bool {
	return s.source.Allow("src:"+sourceKey(r), limit, time.Minute)
}

func decodeJSON(w http.ResponseWriter, r *http.Request, maxBytes int64, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return errTooLarge
		}
		return errBadBody
	}
	if dec.More() {
		return errBadBody
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

type apiErrorBody struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
	RequestID string `json:"requestId"`
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	var body apiErrorBody
	body.Error.Code = code
	body.Error.Message = message
	body.RequestID = ""
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func (s *Server) requireFlow(r *http.Request) (store.Flow, error) {
	token := cookieValue(r, flowCookie)
	if token == "" {
		return store.Flow{}, errForbidden
	}
	return s.st.GetFlowByToken(token, s.nowUnix())
}

func (s *Server) verifyFlowCSRF(r *http.Request, flow store.Flow) error {
	token := r.Header.Get("X-CSRF-Token")
	if token == "" || !hashEquals(token, flow.CSRFHash) {
		return errForbidden
	}
	return nil
}

type userPayload struct {
	ID       string `json:"id"`
	Username string `json:"username"`
}

func (s *Server) authenticate(username, plain string) (store.User, bool, error) {
	release, err := s.hashes.acquire(context.Background())
	if err != nil {
		return store.User{}, false, err
	}
	defer release()
	user, phc, err := s.st.GetUserByKey(username)
	if err != nil || !user.Enabled {
		password.DummyVerify(plain, s.cfg.Argon)
		return store.User{}, false, nil
	}
	ok, verifyErr := password.Verify(plain, phc)
	if verifyErr != nil {
		return store.User{}, false, nil
	}
	return user, ok, nil
}

// --- handlers ---

type csrfResponse struct {
	FlowID    string `json:"flowId"`
	AttemptID string `json:"attemptId"`
	CSRFToken string `json:"csrfToken"`
	ExpiresAt int64  `json:"expiresAt"`
}

func (s *Server) handleCSRF(w http.ResponseWriter, r *http.Request) {
	if !s.allowSource(r, s.cfg.SourceRatePerMin*3) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "请求过于频繁")
		return
	}
	now := s.nowUnix()

	var flow store.Flow
	if existing, err := s.requireFlow(r); err == nil {
		flow = existing
	} else {
		flowID, err := store.NewID("f_", 16)
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, "unavailable", "服务暂不可用")
			return
		}
		flowToken, tokenHash, err := store.NewToken()
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, "unavailable", "服务暂不可用")
			return
		}
		csrf := s.deriveCSRF("flow", flowID)
		if err := s.st.InsertFlow(flowID, tokenHash, store.HashToken(csrf), now, now+seconds(s.cfg.CSRFTTL), now+seconds(s.cfg.FlowTTL)); err != nil {
			writeError(w, http.StatusServiceUnavailable, "unavailable", "服务暂不可用")
			return
		}
		s.setCookie(w, flowCookie, flowToken, int(seconds(s.cfg.FlowTTL)))
		flow = store.Flow{ID: flowID, CSRFHash: store.HashToken(csrf), CreatedAt: now, ExpiresAt: now + seconds(s.cfg.FlowTTL)}
	}

	attempt, err := s.st.CreateAttempt(flow.ID, now, now+seconds(s.cfg.FlowTTL), s.cfg.MaxAttemptsPerFlow)
	if errors.Is(err, store.ErrStateConflict) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "尝试次数过多")
		return
	}
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "服务暂不可用")
		return
	}
	writeJSON(w, http.StatusOK, csrfResponse{
		FlowID:    flow.ID,
		AttemptID: attempt.ID,
		CSRFToken: s.deriveCSRF("flow", flow.ID),
		ExpiresAt: flow.ExpiresAt,
	})
}

type loginRequest struct {
	AttemptID string `json:"attemptId"`
	Username  string `json:"username"`
	Password  string `json:"password"`
}

type loginResponse struct {
	Pending   bool        `json:"pending"`
	User      userPayload `json:"user"`
	AttemptID string      `json:"attemptId"`
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if err := s.checkOrigin(r); err != nil {
		writeError(w, http.StatusForbidden, "origin_rejected", "来源不被允许")
		return
	}
	flow, err := s.requireFlow(r)
	if err != nil {
		writeError(w, http.StatusForbidden, "origin_rejected", "来源不被允许")
		return
	}
	if err := s.verifyFlowCSRF(r, flow); err != nil {
		writeError(w, http.StatusForbidden, "csrf_rejected", "CSRF 校验失败")
		return
	}
	if !s.allowSource(r, s.cfg.SourceRatePerMin) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "请求过于频繁")
		return
	}
	var body loginRequest
	if err := decodeJSON(w, r, s.cfg.MaxBodyBytes, &body); err != nil {
		s.writeBodyError(w, err)
		return
	}
	usernameKey := strings.ToLower(body.Username)
	if !s.username.Allow("user:"+usernameKey, s.cfg.UsernameRate, s.cfg.UsernameWindow) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "请求过于频繁")
		return
	}
	attempt, err := s.st.GetAttempt(body.AttemptID)
	if err != nil || attempt.FlowID != flow.ID {
		writeError(w, http.StatusConflict, "state_conflict", "登录尝试无效")
		return
	}
	user, ok, authErr := s.authenticate(body.Username, body.Password)
	if errors.Is(authErr, errHashBusy) {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "服务繁忙")
		return
	}
	if !ok {
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "用户名或密码错误")
		return
	}
	now := s.nowUnix()
	sessionID, err := store.NewID("s_", 16)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "服务暂不可用")
		return
	}
	sessionToken, sessionTokenHash, err := store.NewToken()
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "服务暂不可用")
		return
	}
	sessionCSRF := s.deriveCSRF("session", sessionID)
	err = s.st.MarkPending(
		r.Context(), attempt.ID, sessionID, sessionTokenHash, store.HashToken(sessionCSRF), user.ID, user.CredentialVersion,
		now+seconds(s.cfg.PendingTTL), now+seconds(s.cfg.SessionIdle), now+seconds(s.cfg.SessionAbsolute), now,
	)
	switch {
	case errors.Is(err, store.ErrStateConflict):
		writeError(w, http.StatusConflict, "state_conflict", "登录尝试已失效")
		return
	case errors.Is(err, store.ErrExpired):
		writeError(w, http.StatusConflict, "state_conflict", "登录尝试已过期")
		return
	case err != nil:
		writeError(w, http.StatusServiceUnavailable, "unavailable", "服务暂不可用")
		return
	}
	s.username.Reset("user:" + usernameKey)
	s.setCookie(w, sessionCookie, sessionToken, int(seconds(s.cfg.SessionAbsolute)))
	writeJSON(w, http.StatusOK, loginResponse{
		Pending:   true,
		User:      userPayload{ID: user.ID, Username: user.Username},
		AttemptID: attempt.ID,
	})
}

type confirmRequest struct {
	AttemptID string `json:"attemptId"`
}

type confirmResponse struct {
	Authenticated    bool        `json:"authenticated"`
	User             userPayload `json:"user"`
	SessionExpiresAt int64       `json:"sessionExpiresAt"`
	CSRFToken        string      `json:"csrfToken"`
}

func (s *Server) handleConfirm(w http.ResponseWriter, r *http.Request) {
	if err := s.checkOrigin(r); err != nil {
		writeError(w, http.StatusForbidden, "origin_rejected", "来源不被允许")
		return
	}
	flow, err := s.requireFlow(r)
	if err != nil {
		writeError(w, http.StatusForbidden, "origin_rejected", "来源不被允许")
		return
	}
	if err := s.verifyFlowCSRF(r, flow); err != nil {
		writeError(w, http.StatusForbidden, "csrf_rejected", "CSRF 校验失败")
		return
	}
	var body confirmRequest
	if err := decodeJSON(w, r, s.cfg.MaxBodyBytes, &body); err != nil {
		s.writeBodyError(w, err)
		return
	}
	now := s.nowUnix()
	result, err := s.st.ConfirmAttempt(r.Context(), body.AttemptID, now, now+seconds(s.cfg.SessionIdle), now+seconds(s.cfg.SessionAbsolute))
	switch {
	case errors.Is(err, store.ErrUnauthenticated), errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "会话未确认")
		return
	case errors.Is(err, store.ErrStateConflict), errors.Is(err, store.ErrExpired):
		writeError(w, http.StatusConflict, "state_conflict", "登录尝试已失效")
		return
	case err != nil:
		writeError(w, http.StatusServiceUnavailable, "unavailable", "服务暂不可用")
		return
	}
	writeJSON(w, http.StatusOK, confirmResponse{
		Authenticated:    true,
		User:             userPayload{ID: result.User.ID, Username: result.User.Username},
		SessionExpiresAt: result.SessionExpiresAt,
		CSRFToken:        s.deriveCSRF("session", result.SessionID),
	})
}

type sessionResponse struct {
	Authenticated    bool         `json:"authenticated"`
	User             *userPayload `json:"user,omitempty"`
	SessionExpiresAt int64        `json:"sessionExpiresAt,omitempty"`
	CSRFToken        string       `json:"csrfToken,omitempty"`
}

func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	token := cookieValue(r, sessionCookie)
	if token == "" {
		writeJSON(w, http.StatusOK, sessionResponse{Authenticated: false})
		return
	}
	now := s.nowUnix()
	session, user, err := s.st.SessionAuth(r.Context(), token, now, now+seconds(s.cfg.SessionIdle))
	if err != nil {
		writeJSON(w, http.StatusOK, sessionResponse{Authenticated: false})
		return
	}
	writeJSON(w, http.StatusOK, sessionResponse{
		Authenticated:    true,
		User:             &userPayload{ID: user.ID, Username: user.Username},
		SessionExpiresAt: session.AbsoluteExpiresAt,
		CSRFToken:        s.deriveCSRF("session", session.ID),
	})
}

type cancelRequest struct {
	AttemptID string `json:"attemptId"`
}

func (s *Server) handleCancel(w http.ResponseWriter, r *http.Request) {
	if err := s.checkOrigin(r); err != nil {
		writeError(w, http.StatusForbidden, "origin_rejected", "来源不被允许")
		return
	}
	flow, err := s.requireFlow(r)
	if err != nil {
		writeError(w, http.StatusForbidden, "origin_rejected", "来源不被允许")
		return
	}
	if err := s.verifyFlowCSRF(r, flow); err != nil {
		writeError(w, http.StatusForbidden, "csrf_rejected", "CSRF 校验失败")
		return
	}
	var body cancelRequest
	if err := decodeJSON(w, r, s.cfg.MaxBodyBytes, &body); err != nil {
		s.writeBodyError(w, err)
		return
	}
	if err := s.st.CancelAttempt(r.Context(), body.AttemptID, s.nowUnix()); err != nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "服务暂不可用")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if err := s.checkOrigin(r); err != nil {
		writeError(w, http.StatusForbidden, "origin_rejected", "来源不被允许")
		return
	}
	token := cookieValue(r, sessionCookie)
	if token != "" {
		if session, err := s.st.GetSessionByToken(token); err == nil {
			if !hashEquals(r.Header.Get("X-CSRF-Token"), session.CSRFHash) {
				writeError(w, http.StatusForbidden, "csrf_rejected", "CSRF 校验失败")
				return
			}
		}
	}
	if err := s.st.LogoutSession(r.Context(), token, s.nowUnix()); err != nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "服务暂不可用")
		return
	}
	s.clearCookie(w, sessionCookie)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) writeBodyError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errTooLarge):
		writeError(w, http.StatusRequestEntityTooLarge, "payload_too_large", "请求体过大")
	default:
		writeError(w, http.StatusBadRequest, "bad_request", "请求格式错误")
	}
}

func (s *Server) handleLive(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	fmt.Fprintln(w, "ok")
}

func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	version, err := s.st.SchemaVersion()
	if err != nil || version < 1 {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "数据库未就绪")
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	fmt.Fprintf(w, "ready schema=%d\n", version)
}
