package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/example-org/example-blog/services/lab-auth/internal/identity"
	"github.com/example-org/example-blog/services/lab-auth/internal/password"
	"github.com/example-org/example-blog/services/lab-auth/internal/store"
)

type registerRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// passwordRuleMessage is the single user-facing wording for the shared password
// rule (mirrored in src/features/auth/panel.ts and the blog account page).
const passwordRuleMessage = "密码需为 6–128 个字符，且至少包含一个大写字母、一个小写字母和一个数字"

type registerResponse struct {
	Registered bool        `json:"registered"`
	User       userPayload `json:"user"`
}

// handleRegister implements the additive register-v1 endpoint. Registration is
// not login: it never sets or changes a session cookie, never authenticates the
// caller, and every failure is reported without account details.
func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.RegistrationEnabled {
		writeError(w, http.StatusServiceUnavailable, "registration_disabled", "注册暂未开放")
		return
	}
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
	// In-memory source pre-limit in its own namespace, before any expensive work.
	digest := s.registerSourceDigest(r)
	if !s.registerSource.Allow("register:"+digest, s.cfg.RegisterSourceHourly, time.Hour) {
		w.Header().Set("Retry-After", "3600")
		writeError(w, http.StatusTooManyRequests, "rate_limited", "注册尝试过于频繁")
		return
	}
	var body registerRequest
	if err := decodeJSON(w, r, s.cfg.MaxBodyBytes, &body); err != nil {
		s.writeBodyError(w, err)
		return
	}
	if _, uerr := identity.ValidateUsername(body.Username); uerr != "" {
		if uerr == identity.UsernameReserved {
			writeError(w, http.StatusConflict, "registration_unavailable", "该用户名不可用")
			return
		}
		writeError(w, http.StatusBadRequest, "bad_request", "用户名不符合规则")
		return
	}
	if perr := identity.ValidatePassword(body.Password); perr != "" {
		writeError(w, http.StatusBadRequest, "bad_request", passwordRuleMessage)
		return
	}
	input := store.RegistrationInput{
		Username: body.Username, SourceKey: digest,
		SourceLimit: s.cfg.RegisterSourceHourly, GlobalLimit: s.cfg.RegisterGlobalDaily,
		MaxUsers: s.cfg.RegisterMaxUsers, Now: s.nowUnix(),
	}
	if err := s.st.ConsumeRegistrationQuota(r.Context(), input); err != nil {
		var quota *store.RegistrationQuotaError
		if errors.As(err, &quota) {
			w.Header().Set("Retry-After", strconv.FormatInt(max(1, quota.RetryAfter), 10))
			writeError(w, http.StatusTooManyRequests, "rate_limited", "注册尝试过于频繁")
		} else {
			writeError(w, http.StatusServiceUnavailable, "unavailable", "服务暂不可用")
		}
		return
	}
	// Bounded hashing: at most one registration hash at a time, queued at most
	// two, sharing the global pool with login so login keeps capacity.
	releaseReg, err := s.registerHashes.acquire(r.Context())
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "注册服务繁忙")
		return
	}
	defer releaseReg()
	release, err := s.hashes.acquire(r.Context())
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "注册服务繁忙")
		return
	}
	defer release()
	hash, err := password.Hash(body.Password, s.cfg.Argon)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "服务暂不可用")
		return
	}
	input.PasswordHash = hash
	user, err := s.st.InsertRegisteredUser(r.Context(), input)
	var quota *store.RegistrationQuotaError
	switch {
	case errors.As(err, &quota):
		retry := quota.RetryAfter
		if retry < 1 {
			retry = 1
		}
		w.Header().Set("Retry-After", strconv.FormatInt(retry, 10))
		writeError(w, http.StatusTooManyRequests, "rate_limited", "注册尝试过于频繁")
		return
	case errors.Is(err, store.ErrUserLimit):
		writeError(w, http.StatusServiceUnavailable, "unavailable", "注册容量已满")
		return
	case errors.Is(err, store.ErrUsernameTaken), errors.Is(err, store.ErrInvalidUsername):
		writeError(w, http.StatusConflict, "registration_unavailable", "该用户名不可用")
		return
	case err != nil:
		writeError(w, http.StatusServiceUnavailable, "unavailable", "服务暂不可用")
		return
	}
	writeJSON(w, http.StatusCreated, registerResponse{
		Registered: true,
		User:       userPayload{ID: user.ID, Username: user.Username},
	})
}

// registerSourceDigest derives a stable, non-reversible source key. IPv4 is
// keyed by address and IPv6 by /64, matching CONTRACT §11.
func (s *Server) registerSourceDigest(r *http.Request) string {
	host := aggregateSourceIP(s.sourceKey(r))
	mac := hmac.New(sha256.New, s.cfg.CSRFSecret)
	mac.Write([]byte("register-source:"))
	mac.Write([]byte(host))
	return hex.EncodeToString(mac.Sum(nil))[:32]
}

func aggregateSourceIP(value string) string {
	trimmed := strings.TrimSpace(value)
	ip := net.ParseIP(trimmed)
	if ip == nil {
		return strings.ToLower(trimmed)
	}
	if v4 := ip.To4(); v4 != nil {
		return v4.String()
	}
	return ip.Mask(net.CIDRMask(64, 128)).String() + "/64"
}
