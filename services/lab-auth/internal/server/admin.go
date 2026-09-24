package server

// Account management API.
//
// Contract (see openapi.yaml and docs/IDENTITY.md §11):
//   - Everything lives under {base}/admin/ and requires
//     `Authorization: Bearer <LAB_AUTH_ADMIN_TOKEN>`.
//   - The API is cookie-less on purpose: it never reads the session cookie, so a
//     stolen browser session cannot manage accounts and no CSRF token applies.
//     Cookies sent by a browser are ignored, which also means an XSS on the site
//     cannot reach it without the token.
//   - With no token configured the endpoints answer 503 admin_disabled instead of
//     404: operators get a truthful reason and nothing is silently exposed.
//   - Every mutation appends one audit row (actor `admin-api`).
//   - Requests are rate limited per source address.

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/example-org/example-blog/services/lab-auth/internal/store"
)

const (
	adminActor = "admin-api"

	// Account actions, mirrored in the CLI and documented in docs/IDENTITY.md.
	actionUserCreate   = "user.create"
	actionUserEnable   = "user.enable"
	actionUserDisable  = "user.disable"
	actionUserPassword = "user.password"
	actionUserDelete   = "user.delete"
	actionSessionClear = "session.revoke"
)

// AdminDeps is the persistence the admin API needs. *store.Store satisfies it;
// tests inject fakes so handler behaviour can be judged without SQLite.
type AdminDeps struct {
	Accounts store.UserDirectory
	Audit    store.AuditLog
	Sessions store.SessionDirectory
	Status   func() (store.Status, error)
}

func (s *Server) adminDeps() *AdminDeps { return s.admin }

// --- wire models (kept flat and stable: the CLI and scripts consume them) ---

type adminUserModel struct {
	ID                string `json:"id"`
	Username          string `json:"username"`
	Enabled           bool   `json:"enabled"`
	CredentialVersion int64  `json:"credentialVersion"`
	CreatedAt         int64  `json:"createdAt"`
	UpdatedAt         int64  `json:"updatedAt"`
}

func toAdminUser(user store.User) adminUserModel {
	return adminUserModel{
		ID:                user.ID,
		Username:          user.Username,
		Enabled:           user.Enabled,
		CredentialVersion: user.CredentialVersion,
		CreatedAt:         user.CreatedAt,
		UpdatedAt:         user.UpdatedAt,
	}
}

func toAdminUsers(users []store.User) []adminUserModel {
	models := make([]adminUserModel, 0, len(users))
	for _, user := range users {
		models = append(models, toAdminUser(user))
	}
	return models
}

type adminAuditModel struct {
	ID     string `json:"id"`
	At     int64  `json:"at"`
	Actor  string `json:"actor"`
	Action string `json:"action"`
	Target string `json:"target"`
	Detail string `json:"detail"`
}

type adminSessionModel struct {
	ID                string `json:"id"`
	UserID            string `json:"userId"`
	Username          string `json:"username"`
	State             string `json:"state"`
	CreatedAt         int64  `json:"createdAt"`
	LastSeenAt        int64  `json:"lastSeenAt"`
	IdleExpiresAt     int64  `json:"idleExpiresAt"`
	AbsoluteExpiresAt int64  `json:"absoluteExpiresAt"`
}

// --- authentication ---

// authorizeAdmin enforces the bearer token. The comparison is constant time and
// the failure is deliberately uniform: no distinction between an absent, wrong
// or empty token is observable from the response.
func (s *Server) authorizeAdmin(w http.ResponseWriter, r *http.Request) bool {
	if s.cfg.AdminToken == "" {
		writeError(w, http.StatusServiceUnavailable, "admin_disabled", "管理接口未启用")
		return false
	}
	header := r.Header.Get("Authorization")
	token := ""
	if len(header) > 7 && strings.EqualFold(header[:7], "bearer ") {
		token = strings.TrimSpace(header[7:])
	}
	if subtle.ConstantTimeCompare([]byte(token), []byte(s.cfg.AdminToken)) != 1 {
		s.logger.Warn("admin unauthorized", "request_id", requestID(r), "path", r.URL.Path)
		writeError(w, http.StatusUnauthorized, "unauthorized", "需要管理令牌")
		return false
	}
	limit := s.cfg.AdminRate
	if limit < 1 {
		limit = 60
	}
	if !s.source.Allow("admin:"+sourceKey(r), limit, time.Minute) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "请求过于频繁")
		return false
	}
	return true
}

// --- handlers ---

func (s *Server) handleAdminStatus(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(w, r) {
		return
	}
	status, err := s.admin.Status()
	if err != nil {
		s.writeAdminError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"service": map[string]any{
			"version":      s.version,
			"env":          string(s.cfg.Env),
			"adminEnabled": true,
			"registration": s.cfg.RegistrationEnabled,
			"now":          s.nowUnix(),
		},
		"database": map[string]any{
			"path":          status.Path,
			"schemaVersion": status.SchemaVersion,
			"migratedAt":    status.MigratedAt,
			"users":         status.Users,
			"enabled":       status.Enabled,
			"disabled":      status.Disabled,
			"sessions": map[string]any{
				"active":  status.SessionsActive,
				"pending": status.SessionsPending,
			},
			"auditEntries": status.AuditEntries,
		},
	})
}

func (s *Server) handleAdminListUsers(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(w, r) {
		return
	}
	query := store.AccountQuery{
		Search: r.URL.Query().Get("search"),
		Limit:  queryInt(r, "limit", 100),
		Offset: queryInt(r, "offset", 0),
	}
	switch strings.ToLower(strings.TrimSpace(r.URL.Query().Get("enabled"))) {
	case "":
	case "1", "true", "yes":
		value := true
		query.Enabled = &value
	case "0", "false", "no":
		value := false
		query.Enabled = &value
	default:
		writeError(w, http.StatusBadRequest, "bad_request", "enabled 只接受 true/false")
		return
	}
	page, err := s.admin.Accounts.ListAccounts(query)
	if err != nil {
		s.writeAdminError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"users":  toAdminUsers(page.Users),
		"total":  page.Total,
		"limit":  page.Limit,
		"offset": page.Offset,
	})
}

func (s *Server) handleAdminGetUser(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(w, r) {
		return
	}
	user, err := s.admin.Accounts.GetAccount(r.PathValue("ref"))
	if err != nil {
		s.writeAdminError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": toAdminUser(user)})
}

func (s *Server) handleAdminCreateUser(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(w, r) {
		return
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decodeJSON(w, r, s.cfg.MaxBodyBytes, &body); err != nil {
		s.writeBodyError(w, err)
		return
	}
	user, err := s.admin.Accounts.CreateUser(body.Username, body.Password)
	if err != nil {
		s.writeAdminError(w, err)
		return
	}
	s.auditUserAction(actionUserCreate, user, "")
	writeJSON(w, http.StatusCreated, map[string]any{"user": toAdminUser(user)})
}

func (s *Server) handleAdminEnableUser(w http.ResponseWriter, r *http.Request)  { s.setEnabled(w, r, true) }
func (s *Server) handleAdminDisableUser(w http.ResponseWriter, r *http.Request) { s.setEnabled(w, r, false) }

func (s *Server) setEnabled(w http.ResponseWriter, r *http.Request, enabled bool) {
	if !s.authorizeAdmin(w, r) {
		return
	}
	user, err := s.admin.Accounts.SetAccountEnabled(r.PathValue("ref"), enabled)
	if err != nil {
		s.writeAdminError(w, err)
		return
	}
	action := actionUserDisable
	if enabled {
		action = actionUserEnable
	}
	s.auditUserAction(action, user, "")
	writeJSON(w, http.StatusOK, map[string]any{"user": toAdminUser(user)})
}

func (s *Server) handleAdminResetPassword(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(w, r) {
		return
	}
	var body struct {
		Password string `json:"password"`
	}
	if err := decodeJSON(w, r, s.cfg.MaxBodyBytes, &body); err != nil {
		s.writeBodyError(w, err)
		return
	}
	user, err := s.admin.Accounts.ResetAccountPassword(r.PathValue("ref"), body.Password)
	if err != nil {
		s.writeAdminError(w, err)
		return
	}
	// The password itself is never logged or echoed anywhere.
	s.auditUserAction(actionUserPassword, user, "credential version bumped")
	writeJSON(w, http.StatusOK, map[string]any{"user": toAdminUser(user)})
}

func (s *Server) handleAdminRevokeSessions(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(w, r) {
		return
	}
	ref := r.PathValue("ref")
	user, err := s.admin.Accounts.GetAccount(ref)
	if err != nil {
		s.writeAdminError(w, err)
		return
	}
	revoked, err := s.admin.Accounts.RevokeAccountSessions(ref)
	if err != nil {
		s.writeAdminError(w, err)
		return
	}
	s.auditUserAction(actionSessionClear, user, "revoked="+strconv.FormatInt(revoked, 10))
	writeJSON(w, http.StatusOK, map[string]any{"user": toAdminUser(user), "revoked": revoked})
}

func (s *Server) handleAdminDeleteUser(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(w, r) {
		return
	}
	force := queryBool(r, "force")
	ref := r.PathValue("ref")
	user, err := s.admin.Accounts.DeleteAccount(ref, force)
	if err != nil {
		s.writeAdminError(w, err)
		return
	}
	// The audit row is written after the delete and keeps the username, which is
	// exactly why the trail does not live in the users table.
	s.auditUserAction(actionUserDelete, user, "force="+strconv.FormatBool(force))
	writeJSON(w, http.StatusOK, map[string]any{"user": toAdminUser(user)})
}

func (s *Server) handleAdminListAudit(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(w, r) {
		return
	}
	entries, err := s.admin.Audit.ListAudit(store.AuditQuery{
		Target: r.URL.Query().Get("target"),
		Action: r.URL.Query().Get("action"),
		Limit:  queryInt(r, "limit", 100),
		Offset: queryInt(r, "offset", 0),
	})
	if err != nil {
		s.writeAdminError(w, err)
		return
	}
	models := make([]adminAuditModel, 0, len(entries))
	for _, entry := range entries {
		models = append(models, adminAuditModel{
			ID: entry.ID, At: entry.At, Actor: entry.Actor,
			Action: entry.Action, Target: entry.Target, Detail: entry.Detail,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": models})
}

func (s *Server) handleAdminListSessions(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(w, r) {
		return
	}
	sessions, err := s.admin.Sessions.ListSessions(store.SessionQuery{
		User:   r.URL.Query().Get("user"),
		State:  r.URL.Query().Get("state"),
		Limit:  queryInt(r, "limit", 100),
		Offset: queryInt(r, "offset", 0),
	})
	if err != nil {
		s.writeAdminError(w, err)
		return
	}
	models := make([]adminSessionModel, 0, len(sessions))
	for _, session := range sessions {
		models = append(models, adminSessionModel{
			ID: session.ID, UserID: session.UserID, Username: session.Username, State: session.State,
			CreatedAt: session.CreatedAt, LastSeenAt: session.LastSeenAt,
			IdleExpiresAt: session.IdleExpiresAt, AbsoluteExpiresAt: session.AbsoluteExpiresAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": models})
}

// --- helpers ---

// auditUserAction records one mutation. A failed audit write is logged, never
// returned: the mutation already happened and the caller must still see it.
func (s *Server) auditUserAction(action string, user store.User, detail string) {
	target := user.UsernameKey
	if target == "" {
		target = user.Username
	}
	if _, err := s.admin.Audit.AppendAudit(store.AuditEntry{
		Actor:  adminActor,
		Action: action,
		Target: target,
		Detail: detail,
	}); err != nil {
		s.logger.Error("audit append failed", "action", action, "target", target, "error", err.Error())
	}
}

func (s *Server) writeAdminError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "账号不存在")
	case errors.Is(err, store.ErrUsernameTaken):
		writeError(w, http.StatusConflict, "username_taken", "用户名已被占用")
	case errors.Is(err, store.ErrInvalidUsername):
		writeError(w, http.StatusBadRequest, "invalid_username", "用户名不符合规则")
	case errors.Is(err, store.ErrInvalidPassword):
		writeError(w, http.StatusBadRequest, "invalid_password", "密码不符合规则")
	case errors.Is(err, store.ErrLastAccount):
		writeError(w, http.StatusConflict, "last_account", "这是最后一个可用账号；确认请带 force=1")
	default:
		s.logger.Error("admin request failed", "error", err.Error())
		writeError(w, http.StatusInternalServerError, "internal", "服务内部错误")
	}
}

func queryInt(r *http.Request, key string, fallback int) int {
	raw := strings.TrimSpace(r.URL.Query().Get(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return value
}

func queryBool(r *http.Request, key string) bool {
	switch strings.ToLower(strings.TrimSpace(r.URL.Query().Get(key))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}
